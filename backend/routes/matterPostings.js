const express = require("express");
const { createLogger } = require("../utils/logger");
const logger = createLogger("matter-postings");
const mongoose = require("mongoose");
const Case = require("../models/Case");
const { postingFingerprint } = require("../services/matterModeration");
const Job = require("../models/Job");
const { isRetainedDraft, retainedDraftAllowed, inspectRetainedDraft, retainedDraftCanDelete } = require("../services/retainedMatterDraft");
const { deletePostingRecords } = require("../services/matterDeletion");
const CaseDraft = require("../models/CaseDraft");
const MatterPublication = require("../models/MatterPublication");
const { lockActiveAccounts } = require("../utils/activeAccountWrite");
const { fingerprint, revisionFor, requestIdValid } = require("../services/matterDraftRevision");
const { parseMinimumYears } = require("../services/experienceRequirement");
const { resolveMatterDeadlineDate } = require("../utils/businessDate");
const { requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, publicCode: code }); };
const id = (value) => mongoose.isObjectIdOrHexString(value);
const revision = (doc) => fingerprint(doc);
const fields = ["title", "practiceArea", "state", "compAmount", "experience", "deadline", "description", "tasks", "requirements"];
const owned = (owner) => ({ $or: [{ attorney: new mongoose.Types.ObjectId(owner) }, { attorneyId: new mongoose.Types.ObjectId(owner) }] });

// Mounted after the existing authentication and approval boundary. Every write
// uses a replica-set transaction; there is deliberately no partial-write fallback.
module.exports = function createMatterPostingsRouter({ practiceAreas, normalizePracticeArea, normalizeStatus, parseDeadline, hasPendingInvites, buildBriefSummary, beforeCommit = async () => undefined, afterCommit = async () => {} }) {
  const router = express.Router();
  router.use(requireRole("attorney"));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "GET" && req.body?.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ code: "DRAFT_ACCOUNT_CHANGED", error: "The signed-in account changed. Reload the editor before continuing." });
    next();
  });
  const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      if (error.publicCode) return res.status(error.status).json({ code: error.publicCode, error: error.message });
      // A commit acknowledgement can be lost. The receipt is the recovery source;
      // never assert that nothing was created when a database response is unknown.
      logger.error("operation failed", error.code || error.name);
      res.status(503).json({ code: "POSTING_UNCONFIRMED", error: "The result could not be confirmed. Check the saved result before trying again. Your edits can be retained in this page." });
    }
  };
  async function requireReceiptIndexes() {
    await MatterPublication.init();
    const indexes = await MatterPublication.collection.listIndexes().toArray();
    for (const field of ["requestId", "draftId"]) {
      if (!indexes.some((index) => index.unique === true && JSON.stringify(index.key) === JSON.stringify({ owner: 1, [field]: 1 }))) fail(503, "POSTING_INDEX_REQUIRED", "Publishing is temporarily unavailable. Your draft has been retained.");
    }
  }
  async function transaction(work) {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => work(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 }); }
    finally { await session.endSession(); }
  }
  async function dispatchCommitted(dispatch) {
    try { await dispatch?.(); } catch (error) { logger.warn('saved posting notice dispatch failed', error?.name); }
  }
  async function effect(req, type, doc, recipients) {
    try { await afterCommit(req, type, doc, recipients); }
    catch (error) { logger.error("post-commit notification failed", type, error.name); }
  }
  function permissions(doc) {
    const engaged = Boolean(doc.paralegal || doc.paralegalId || doc.hiredAt || doc.hiringClaimStatus || doc.hiringClaimToken || doc.completionClaimToken || doc.completionClaimStatus || doc.withdrawalClaimToken || doc.withdrawalClaimStatus);
    const open = normalizeStatus(doc.status) === "open", draft = isRetainedDraft(doc);
    if (draft) { const allowed = retainedDraftAllowed(doc); return { canEdit: allowed, canDelete: allowed && !doc.files?.length, amountLocked: !allowed, tasksLocked: !allowed, reason: allowed ? "" : "This retained draft needs a record review before it can be changed.", deleteReason: doc.files?.length ? "Drafts with retained files cannot be deleted here." : "" }; }
    const financial = Boolean(doc.escrowStatus === "funded" || doc.paymentReleased || doc.escrowIntentId || doc.paymentIntentId || doc.payoutTransferId || doc.payoutFinalizedAt || doc.hiringClaimPaymentIntentId || doc.fundingRequestKey || doc.escrowSessionId);
    const retained = Boolean(doc.disputes?.length || doc.withdrawalHistory?.length || doc.withdrawnParalegalId);
    const canEdit = open && !engaged && !doc.readOnly && !doc.archived && !doc.purgedAt;
    return { canEdit, canDelete: open && !engaged && !financial && !retained && !doc.readOnly,
      amountLocked: financial || retained || doc.lockedTotalAmount != null || Boolean(doc.applicants?.length) || hasPendingInvites(doc) || Boolean(doc.pendingParalegalId),
      tasksLocked: Boolean(doc.tasksLocked || engaged),
      reason: !open ? "Only open postings can be edited here." : engaged ? "Hiring has started. This posting can no longer be edited or deleted here." : doc.readOnly ? "This Matter is read-only." : "",
      deleteReason: financial || retained ? "Matters with engagement, payment or dispute history must be retained." : "" };
  }
  function dto(doc) {
    return { id: String(doc._id), isDraft: isRetainedDraft(doc), revision: revision(doc), permissions: permissions(doc), currency: doc.currency || "usd", values: {
      title: doc.title || "", practiceArea: doc.practiceArea || "", state: doc.state || doc.locationState || "",
      compAmount: isRetainedDraft(doc) && !doc.totalAmount ? "" : (Number(doc.totalAmount || 0) / 100).toFixed(2), experience: doc.experiencePreference || "",
      deadline: resolveMatterDeadlineDate(doc) || "", description: doc.details || "",
      tasks: (doc.tasks || []).map((task) => ({ title: task.title || "" })), requirements: doc.requirements || [],
    } };
  }
  async function presentPosting(doc) {
    const posting = dto(doc);
    if (isRetainedDraft(doc)) posting.permissions.canDelete = posting.permissions.canDelete && await retainedDraftCanDelete(doc);
    return posting;
  }
  async function load(owner, caseId, session) {
    if (!id(caseId)) fail(400, "POSTING_ID_INVALID", "Invalid Matter link.");
    const doc = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseId), ...owned(owner) }, { session });
    if (!doc) fail(404, "POSTING_NOT_FOUND", "This posting is no longer available.");
    return doc;
  }
  function checkRevision(value, doc) {
    if (!/^[a-f0-9]{64}$/.test(value || "")) fail(428, "POSTING_REVISION_REQUIRED", "Load the saved posting before making changes.");
    if (value !== revision(doc)) fail(409, "POSTING_CHANGED", "This Matter changed elsewhere. Review the saved version before continuing.");
  }
  function text(value, max, multiline = false) {
    if (typeof value !== "string" || value.length > max) fail(400, "POSTING_FIELDS_INVALID", `A text field is missing or exceeds its ${max}-character limit.`);
    return value.replace(/<[^>]*>/g, "").replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, "").trim();
  }
  function changes(input, existing, { partialDraft = false } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key))) fail(400, "POSTING_FIELDS_INVALID", "Only posting fields may be changed here.");
    const out = {};
    if ("requirements" in input) out.requirements = require("../services/matterRequirements").normalizeRequirements(input.requirements);
    if ("title" in input) { out.title = text(input.title, 300); if (!partialDraft && !out.title) fail(400, "POSTING_FIELDS_INVALID", "A Matter title is required."); }
    if ("description" in input) { out.details = text(input.description, 100000, true); if (!partialDraft && !out.details) fail(400, "POSTING_FIELDS_INVALID", "A description is required."); }
    if ("practiceArea" in input) { out.practiceArea = partialDraft ? text(input.practiceArea, 200) : normalizePracticeArea(text(input.practiceArea, 200)); if (!partialDraft && !out.practiceArea) fail(400, "POSTING_PRACTICE_REQUIRED", "Choose a supported publishing practice area."); }
    if ("state" in input) out.state = out.locationState = text(input.state, 200);
    if ("experience" in input) { out.experiencePreference = text(input.experience, 200); out.minimumYearsExperience = parseMinimumYears(out.experiencePreference); }
    if ("deadline" in input) {
      const raw = text(input.deadline, 50), parsed = parseDeadline(raw);
      if (raw && !parsed) fail(400, "POSTING_FIELDS_INVALID", "Enter a valid deadline.");
      out.deadlineDate = parsed?.dateOnly || ""; out.deadline = parsed?.legacyDate || null;
    }
    if ("compAmount" in input) {
      const value = partialDraft && input.compAmount === "" ? "0" : String(input.compAmount);
      if (!/^\d+(?:\.\d{1,2})?$/.test(value)) fail(400, "POSTING_FIELDS_INVALID", "Use a dollar amount with no more than two decimal places.");
      const [whole, fraction = ""] = value.split(".");
      out.totalAmount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
      if (!Number.isSafeInteger(out.totalAmount) || out.totalAmount < (partialDraft ? 0 : 40000)) fail(400, "POSTING_FIELDS_INVALID", "Minimum compensation is $400.");
    }
    if ("tasks" in input) {
      if (!Array.isArray(input.tasks) || (!partialDraft && !input.tasks.length) || (!partialDraft && input.tasks.length > 25)) fail(400, "POSTING_TASKS_INVALID", "Publishing requires between 1 and 25 tasks. Your draft has been retained.");
      const remaining = [...(existing?.tasks || [])];
      out.tasks = input.tasks.map((task) => {
        const title = text(task?.title, 200); if (!title) fail(400, "POSTING_FIELDS_INVALID", "Each task needs a title.");
        const index = remaining.findIndex((entry) => entry.title === title);
        return index < 0 ? { title, completed: false, createdAt: new Date() } : remaining.splice(index, 1)[0];
      });
    }
    return out;
  }
  const mirror = (doc) => ({ title: doc.title, practiceArea: doc.practiceArea, description: doc.details, requirements: doc.requirements || [], budget: doc.totalAmount / 100, state: doc.state || "", locationState: doc.locationState || "", experiencePreference: doc.experiencePreference || "", minimumYearsExperience: doc.minimumYearsExperience || 0 });
  async function receiptResult(receipt) {
    const exists = await Case.exists({ _id: receipt.caseId, ...owned(receipt.owner) });
    return { requestId: receipt.requestId, draftId: String(receipt.draftId), caseId: String(receipt.caseId), status: exists ? "posted" : "removed" };
  }
  router.get("/options", wrap(async (_req, res) => res.json({ practiceAreas, minAmountCents: 40000, maxTasks: 25 })));
  router.get("/publications/:requestId", wrap(async (req, res) => {
    if (!requestIdValid(req.params.requestId)) fail(400, "POSTING_REQUEST_INVALID", "Invalid publication request.");
    const receipt = await MatterPublication.findOne({ owner: req.user.id, requestId: req.params.requestId }).lean();
    if (!receipt) fail(404, "PUBLICATION_NOT_FOUND", "No publication was found for this request.");
    res.json({ publication: await receiptResult(receipt) });
  }));
  router.get("/drafts/:draftId", wrap(async (req, res) => {
    if (!id(req.params.draftId)) fail(400, "POSTING_ID_INVALID", "Invalid draft link.");
    const source = req.query.source || "draft";
    if (!["draft", "case"].includes(source)) fail(400, "POSTING_REQUEST_INVALID", "Invalid draft source.");
    const receipt = await MatterPublication.findOne({ owner: req.user.id, draftId: req.params.draftId }).lean();
    if (receipt && (receipt.source || "draft") !== source) fail(409, "PUBLICATION_SOURCE_CHANGED", "This draft link needs review.");
    if (!receipt) fail(404, "PUBLICATION_NOT_FOUND", "This draft has not been published.");
    res.json({ publication: await receiptResult(receipt) });
  }));
  router.post("/publications", csrfProtection, wrap(async (req, res) => {
    const { requestId, draftId, revision: draftRevision, practiceArea, source = "draft" } = req.body;
    if (!["draft", "case"].includes(source)) fail(400, "POSTING_REQUEST_INVALID", "Invalid draft source.");
    if (!requestIdValid(requestId) || !id(draftId)) fail(400, "POSTING_REQUEST_INVALID", "Invalid publication request.");
    await requireReceiptIndexes();
    const key = fingerprint([draftId, draftRevision, practiceArea, ...(source === "case" ? [source] : [])]);
    const prior = async (session) => {
      const sameRequest = await MatterPublication.findOne({ owner: req.user.id, requestId }).session(session || null).lean();
      if (sameRequest && sameRequest.fingerprint !== key) fail(409, "PUBLICATION_REQUEST_REUSED", "This request was used for a different review. Check the published Matter.");
      const receipt = sameRequest || await MatterPublication.findOne({ owner: req.user.id, draftId }).session(session || null).lean();
      if (receipt && (receipt.source || "draft") !== source) fail(409, "PUBLICATION_SOURCE_CHANGED", "This draft link needs review.");
      return receipt;
    };
    let result;
    try {
      result = await transaction(async (session) => {
        await lockActiveAccounts([req.user.id], session, { ownerId: req.user.id, authVersion: req.auth?.payload?.av });
        const receipt = await prior(session); if (receipt) return { receipt, replayed: true };
        if (source === "case") {
          const current = await load(req.user.id, draftId, session);
          checkRevision(draftRevision, current);
          const linked = await inspectRetainedDraft(current, session);
          const values = changes({ ...dto(current).values, practiceArea }, current);
          // Validate the full description without rewriting untouched retained text.
          values.details = current.details;
          const caseId = current._id, jobId = linked?._id || new mongoose.Types.ObjectId();
          const doc = await Case.collection.findOneAndUpdate({ _id: caseId }, {
            $set: { ...values, status: "open", jobId, attorney: new mongoose.Types.ObjectId(req.user.id), attorneyId: new mongoose.Types.ObjectId(req.user.id), currency: "usd", updatedAt: new Date(), briefSummary: buildBriefSummary({ state: values.state, experience: values.experiencePreference }) },
            $inc: { __v: 1 }, $push: { updates: { date: new Date(), text: "Case posted", by: new mongoose.Types.ObjectId(req.user.id) } },
          }, { session, returnDocument: "after" });
          if (linked) await Job.collection.updateOne({ _id: jobId }, { $set: { ...mirror(doc), caseId, status: "open", updatedAt: new Date() } }, { session });
          else await Job.create([{ _id: jobId, caseId, attorneyId: req.user.id, status: "open", ...mirror(doc) }], { session });
          const [created] = await MatterPublication.create([{ owner: req.user.id, requestId, draftId, source, caseId, jobId, fingerprint: key }], { session });
          return { receipt: created.toObject(), doc, replayed: false, dispatch: await beforeCommit(req, "create", doc, session) };
        }
        const draft = await CaseDraft.findOne({ _id: draftId, owner: req.user.id }).session(session).lean();
        if (!draft) fail(404, "DRAFT_NOT_FOUND", "The source draft is no longer available.");
        if (draft.publishedCaseId || draftRevision !== revisionFor(draft)) fail(409, "DRAFT_CHANGED", "The draft changed elsewhere. Reload and review it before publishing.");
        const input = Object.fromEntries(fields.map((field) => [field, draft[field]]));
        input.practiceArea = practiceArea;
        const values = changes(input);
        const caseId = new mongoose.Types.ObjectId(), jobId = new mongoose.Types.ObjectId();
        const [doc] = await Case.create([{ _id: caseId, jobId, attorney: req.user.id, attorneyId: req.user.id, status: "open", currency: "usd", ...values,
          briefSummary: buildBriefSummary({ state: values.state, experience: values.experiencePreference }), updates: [{ date: new Date(), text: "Case posted", by: req.user.id }] }], { session });
        await Job.create([{ _id: jobId, caseId, attorneyId: req.user.id, status: "open", ...mirror(doc) }], { session });
        const [created] = await MatterPublication.create([{ owner: req.user.id, requestId, draftId, caseId, jobId, fingerprint: key }], { session });
        await CaseDraft.collection.updateOne({ _id: draft._id }, { $set: { publishedCaseId: caseId, updatedAt: new Date() }, $inc: { __v: 1 } }, { session });
        return { receipt: created.toObject(), doc: doc.toObject(), replayed: false, dispatch: await beforeCommit(req, "create", doc, session) };
      });
    } catch (error) {
      // Unique indexes arbitrate simultaneous requests for the same draft.
      if (error.code !== 11000) throw error;
      const receipt = await prior(); if (!receipt) throw error;
      result = { receipt, replayed: true };
    }
    await dispatchCommitted(result.dispatch);
    if (!result.replayed) await effect(req, "create", result.doc);
    res.status(result.replayed ? 200 : 201).json({ publication: await receiptResult(result.receipt), replayed: result.replayed });
  }));
  router.post("/publications/:requestId/cleanup", csrfProtection, wrap(async (req, res) => {
    const receipt = await MatterPublication.findOne({ owner: req.user.id, requestId: req.params.requestId }).lean();
    if (!receipt) fail(404, "PUBLICATION_NOT_FOUND", "Publication not found.");
    if (receipt.source !== "case") await CaseDraft.deleteOne({ _id: receipt.draftId, owner: req.user.id, publishedCaseId: receipt.caseId });
    res.json({ ok: true });
  }));
  router.get("/:caseId", wrap(async (req, res) => {
    const doc = await load(req.user.id, req.params.caseId);
    if (req.query.source === "case") await inspectRetainedDraft(doc);
    res.json({ posting: await presentPosting(doc) });
  }));
  router.patch("/:caseId", csrfProtection, wrap(async (req, res) => {
    const result = await transaction(async (session) => {
      await lockActiveAccounts([req.user.id], session, { ownerId: req.user.id, authVersion: req.auth?.payload?.av });
      const current = await load(req.user.id, req.params.caseId, session);
      checkRevision(req.body.revision, current);
      const allowed = permissions(current);
      if (!allowed.canEdit) fail(409, "POSTING_INELIGIBLE", allowed.reason);
      const draft = isRetainedDraft(current);
      if (draft) await inspectRetainedDraft(current, session);
      const update = changes(req.body.changes, current, { partialDraft: draft });
      if ("totalAmount" in update && allowed.amountLocked) fail(409, "POSTING_AMOUNT_LOCKED", "Compensation is locked after an application or invitation.");
      if ("tasks" in update && allowed.tasksLocked) fail(409, "POSTING_TASKS_LOCKED", "Task scope is locked after hire.");
      if (!Object.keys(update).length) return { doc: current };
      // Older flags have no captured posting baseline. Establish it only when
      // this supported editor makes an actual public-content change.
      if (current.moderationStatus === "flagged" && !current.moderationPostingBaseline && postingFingerprint(current) !== postingFingerprint({ ...current, ...update })) update.moderationPostingBaseline = postingFingerprint(current);
      const next = await Case.collection.findOneAndUpdate({ _id: current._id }, { $set: { ...update, updatedAt: new Date() }, $inc: { __v: 1 } }, { session, returnDocument: "after" });
      if (draft) return { doc: next };
      const job = await Job.findOneAndUpdate({ _id: current.jobId, attorneyId: req.user.id, $or: [{ caseId: current._id }, { caseId: null }] }, { $set: { ...mirror(next), caseId: current._id } }, { session, returnDocument: "after", runValidators: true });
      if (!job) fail(409, "POSTING_SYNC_REQUIRED", "The posting link needs reconciliation before edits can be saved.");
      return { doc: next, dispatch: await beforeCommit(req, "update", next, session) };
    });
    const doc = result.doc;
    await dispatchCommitted(result.dispatch);
    if (!isRetainedDraft(doc)) await effect(req, "update", doc);
    res.json({ posting: await presentPosting(doc) });
  }));
  router.delete("/:caseId", csrfProtection, wrap(async (req, res) => {
    const result = await transaction(async (session) => {
      await lockActiveAccounts([req.user.id], session, { ownerId: req.user.id, authVersion: req.auth?.payload?.av });
      const doc = await load(req.user.id, req.params.caseId, session); checkRevision(req.body.revision, doc);
      const allowed = permissions(doc);
      if (!allowed.canDelete) fail(409, "POSTING_INELIGIBLE", allowed.reason || allowed.deleteReason);
      const result = await deletePostingRecords(doc, session, { allowDraft: isRetainedDraft(doc) });
      return { ...result, dispatch: isRetainedDraft(doc) ? undefined : await beforeCommit(req, "delete", result.doc, session) };
    });
    await dispatchCommitted(result.dispatch);
    if (!isRetainedDraft(result.doc)) await effect(req, "delete", result.doc, result.recipients); res.json({ ok: true });
  }));
  return router;
};
