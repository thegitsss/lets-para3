// backend/routes/caseDrafts.js
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const CaseDraft = require("../models/CaseDraft");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function cleanString(value, { len = 300 } = {}) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
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
    description: cleanString(body.description || body.details, { len: 4000 }),
    tasks: normalizeTasks(body.tasks),
    status: "draft",
  };
}

function toResponse(draft) {
  if (!draft) return null;
  return {
    id: draft._id,
    title: draft.title || "Untitled Case",
    practiceArea: draft.practiceArea || "",
    state: draft.state || "",
    compAmount: draft.compAmount || "",
    experience: draft.experience || "",
    deadline: draft.deadline || "",
    description: draft.description || "",
    tasks: Array.isArray(draft.tasks) ? draft.tasks : [],
    status: draft.status || "draft",
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

router.use(auth, requireApproved, requireRole("attorney", "admin"));

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
  asyncHandler(async (req, res) => {
    const payload = normalizeDraftPayload(req.body || {});
    const draft = await CaseDraft.create({ owner: req.user.id, ...payload });
    res.status(201).json({ draft: toResponse(draft) });
  })
);

router.put(
  "/:draftId",
  asyncHandler(async (req, res) => {
    const { draftId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ error: "Invalid draft id" });
    }
    const payload = normalizeDraftPayload(req.body || {});
    const draft = await CaseDraft.findOneAndUpdate(
      { _id: draftId, owner: req.user.id },
      { $set: { ...payload, updatedAt: new Date() } },
      { new: true }
    );
    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }
    res.json({ draft: toResponse(draft) });
  })
);

router.delete(
  "/:draftId",
  asyncHandler(async (req, res) => {
    const { draftId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(draftId)) {
      return res.status(400).json({ error: "Invalid draft id" });
    }
    const draft = await CaseDraft.findOneAndDelete({ _id: draftId, owner: req.user.id });
    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }
    res.json({ success: true });
  })
);

module.exports = router;
