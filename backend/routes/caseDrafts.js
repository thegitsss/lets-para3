// backend/routes/caseDrafts.js
const express = require("express");
const mongoose = require("mongoose");
const { fingerprint, revisionFor, requestIdValid, snapshotFilter } = require("../services/matterDraftRevision");
const router = express.Router();

const auth = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const CaseDraft = require("../models/CaseDraft");
const { presentMatterDraft: toResponse } = require('../services/matterDraftPresentation');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanString(value, { len = 300, multiline = false } = {}) {
  return String(value || "")
    .replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, len);
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((entry) => {
      const title = cleanString(typeof entry === "string" ? entry : entry?.title, { len: 200 });
      return title ? { title } : null;
    })
    .filter(Boolean);
}

function normalizeDraftPayload(body = {}) {
  return {
    title: cleanString(body.title, { len: 300 }),
    practiceArea: cleanString(body.practiceArea || body.field, { len: 200 }),
    state: cleanString(body.state, { len: 200 }),
    compAmount: cleanString(body.compAmount || body.compensationAmount || body.comp, { len: 100 }),
    experience: cleanString(body.experience, { len: 200 }),
    deadline: cleanString(body.deadline, { len: 50 }),
    description: cleanString(body.description || body.details, { len: 4000, multiline: true }),
    appliedSourceDescription: body.appliedSourceDescription == null ? null : cleanString(body.appliedSourceDescription, {len:4000,multiline:true}),
    pendingRequirement: cleanString(body.pendingRequirement, {len:200}),
    sourceDescription: cleanString(body.sourceDescription, {len:4000,multiline:true}),
    tasks: normalizeTasks(body.tasks),
    requirements: require("../services/matterRequirements").normalizeRequirements(body.requirements),
    status: "draft",
  };
}

function parseCompAmount(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const parsed = parseFloat(trimmed.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function assertMinComp(res, compAmount) {
  const parsed = parseCompAmount(compAmount);
  if (parsed == null) return true;
  if (!Number.isFinite(parsed)) {
    res.status(400).json({ error: "Compensation amount must be a number." });
    return false;
  }
  if (parsed <= 0) {
    res.status(400).json({ error: "Compensation amount must be greater than $0." });
    return false;
  }
  return true;
}

function requireRevision(req, res, doc) {
  if (typeof req.body?.revision !== "string" || !/^[a-f0-9]{64}$/.test(req.body.revision)) {
    res.status(428).json({ error: "Refresh the draft before making changes. This page needs its current revision.", code: "DRAFT_REVISION_REQUIRED" }); return false;
  }
  if (req.body.revision !== revisionFor(doc)) {
    res.status(409).json({ error: "This draft changed elsewhere. Review the saved version before continuing.", code: "DRAFT_CHANGED" }); return false;
  }
  return true;
}
const changed = (res) => res.status(409).json({ error: "This draft changed elsewhere. Review the saved version before continuing.", code: "DRAFT_CHANGED" });

router.use(auth, requireApproved, requireRole("attorney", "admin"));
router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
router.use((req, res, next) => {
  if (["POST", "PUT", "DELETE"].includes(req.method) && req.body?.expectedOwnerId !== undefined && req.body.expectedOwnerId !== String(req.user.id)) {
    return res.status(403).json({ code: "DRAFT_ACCOUNT_CHANGED", error: "The signed-in account changed. Reload the editor before continuing." });
  }
  next();
});

async function draftProfile(ownerId) {
  const profile = await require('../models/User').findById(ownerId).select('practiceAreas specialties state').lean();
  const { draftProfileDefaults } = await import('../../frontend/assets/scripts/attorney-v2/draft-profile.mjs');
  return draftProfileDefaults(profile || {});
}
router.get('/defaults', asyncHandler(async(req,res)=>{
  if(req.query.expectedOwnerId !== String(req.user.id))return res.sendStatus(403);
  res.json({ownerId:String(req.user.id),...await draftProfile(req.user.id)});
}));
const suggestionLimit = require('express-rate-limit').rateLimit({ windowMs: 60000, limit: 5, standardHeaders: true, legacyHeaders: false, keyGenerator: req => String(req.user.id), message: {error:'Please wait before generating more suggestions.'} });
router.post('/suggest', csrfProtection, suggestionLimit, asyncHandler(async (req, res) => {
  if (typeof req.body?.brief !== 'string' || req.body.brief.trim().length < 10 || req.body.brief.length > 4000 || Object.keys(req.body).some(key => !['brief','expectedOwnerId','practiceArea','state','current','update'].includes(key))) return res.status(400).json({error:'Describe the work in 10 to 4,000 characters.'});
  try {
    const context = await draftProfile(req.user.id);
    if(req.body.current !== undefined){
      const parsed=require('zod').z.object({title:require('zod').z.string().max(300),description:require('zod').z.string().max(4000),tasks:require('zod').z.array(require('zod').z.string().max(200)).max(25)}).strict().safeParse(req.body.current);
      if(!parsed.success)return res.status(400).json({error:'The draft cannot be refined in this format. Your edits are unchanged.'});
      context.current=parsed.data;
    }
    if(req.body.update !== undefined){
      const parsed=require('../services/matterDraftSuggestions').updateRequestSchema.safeParse(req.body.update);
      if(!parsed.success||req.body.current!==undefined)return res.status(400).json({error:'Invalid Matter update. Your edits are unchanged.'});
      context.update=parsed.data;
    }
    const { draftPractices, draftStates } = await import('../../frontend/assets/scripts/attorney-v2/draft-options.mjs');
    for(const [key,choices] of [['practiceArea',draftPractices],['state',draftStates]]) {
      if(req.body[key] !== undefined && (typeof req.body[key] !== 'string' || !choices.some(([v])=>v===req.body[key])))return res.status(400).json({error:'Invalid Matter selection.'});
    }
    if(req.body.practiceArea)context.practices=[req.body.practiceArea];
    if(req.body.state)context.state=req.body.state;
    const suggestions = await require('../services/matterDraftSuggestions').suggestMatterDraft(req.body.brief.trim(),context);
    return res.json({suggestions});
  } catch {
    return res.status(503).json({code:'DRAFT_SUGGESTIONS_UNAVAILABLE',error:'Draft suggestions are unavailable. You can continue filling out the form.'});
  }
}));

router.get("/resolve/:requestId", asyncHandler(async (req, res) => {
  if (!requestIdValid(req.params.requestId)) return res.status(400).json({ error: "Invalid draft request." });
  const draft = await CaseDraft.findOne({ owner: req.user.id, clientRequestId: req.params.requestId }).lean();
  if (!draft) return res.status(404).json({ error: "Draft not found" });
  res.json({ draft: toResponse(draft) });
}));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const owner = req.user.id;
    const drafts = await CaseDraft.find({ owner })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();
    res.json({ items: drafts.map(toResponse) });
  })
);

router.get(
  "/:draftId",
  asyncHandler(async (req, res) => {
    const { draftId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ error: "Invalid draft id" });
    }
    const draft = await CaseDraft.findOne({ _id: draftId, owner: req.user.id }).lean();
    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }
    res.json({ draft: toResponse(draft) });
  })
);

router.post(
  "/",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const payload = normalizeDraftPayload(req.body || {});
    if (!assertMinComp(res, payload.compAmount)) return;
    const clientRequestId = req.body?.clientRequestId;
    if (clientRequestId !== undefined && !requestIdValid(clientRequestId)) return res.status(400).json({ error: "Invalid draft request." });
    const creationIdentity = {...payload};
    // Empty optional source text must not change replay identities issued before the canvas.
    if (creationIdentity.appliedSourceDescription == null) delete creationIdentity.appliedSourceDescription;
    if (!creationIdentity.pendingRequirement) delete creationIdentity.pendingRequirement;
    if (!creationIdentity.sourceDescription) delete creationIdentity.sourceDescription;
    const creationFingerprint = fingerprint(creationIdentity);
    const replay = async () => {
      const draft = await CaseDraft.findOne({ owner: req.user.id, clientRequestId }).lean();
      if (!draft || draft.creationFingerprint !== creationFingerprint) return changed(res);
      return res.json({ draft: toResponse(draft), replayed: true });
    };
    if (clientRequestId && await CaseDraft.exists({ owner: req.user.id, clientRequestId })) return replay();
    try {
      const draft = await CaseDraft.create({ owner: req.user.id, ...payload, ...(clientRequestId ? { clientRequestId, creationFingerprint } : {}) });
      res.status(201).json({ draft: toResponse(draft) });
    } catch (error) { if (clientRequestId && error.code === 11000) return replay(); throw error; }
  })
);

router.put(
  "/:draftId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { draftId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ error: "Invalid draft id" });
    }
    const payload = normalizeDraftPayload(req.body || {});
    if (!assertMinComp(res, payload.compAmount)) return;
    const current = await CaseDraft.findOne({ _id: draftId, owner: req.user.id }).lean();
    if (!current) {
      return res.status(404).json({ error: "Draft not found" });
    }
    if (current.publishedCaseId) return res.status(409).json({ code: "DRAFT_PUBLISHED", error: "This draft has already been published. Open the posted Matter to edit it." });
    if (!requireRevision(req, res, current)) return;
    if (!Object.hasOwn(req.body || {}, "appliedSourceDescription")) delete payload.appliedSourceDescription;
    if (!Object.hasOwn(req.body || {}, "pendingRequirement")) delete payload.pendingRequirement;
    if (!Object.hasOwn(req.body || {}, "sourceDescription")) delete payload.sourceDescription;
    // Untouched task arrays can contain legacy metadata outside this editor's
    // title-only contract. Leave them byte-for-byte intact.
    if (JSON.stringify(normalizeTasks(current.tasks)) === JSON.stringify(payload.tasks)) delete payload.tasks;
    const draft = await CaseDraft.collection.findOneAndUpdate(snapshotFilter(current), { $set: { ...payload, updatedAt: new Date() }, $inc: { __v: 1 } }, { returnDocument: "after" });
    if (!draft) return changed(res);
    res.json({ draft: toResponse(draft) });
  })
);

router.delete(
  "/:draftId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { draftId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ error: "Invalid draft id" });
    }
    const current = await CaseDraft.findOne({ _id: draftId, owner: req.user.id }).lean();
    if (!current) {
      return res.status(404).json({ error: "Draft not found" });
    }
    if (!requireRevision(req, res, current)) return;
    const result = await CaseDraft.collection.deleteOne(snapshotFilter(current));
    if (!result.deletedCount) return changed(res);
    res.json({ success: true });
  })
);

module.exports = router;
