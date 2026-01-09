// backend/routes/checklist.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const Task = require("../models/Task");
const { logAction } = require("../utils/audit");
const { assertCaseParticipant } = require("../middleware/ensureCaseParticipant");

// ----------------------------------------
// CSRF (enabled in production or when ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);

function parsePagination(req, { maxLimit = 100, defaultLimit = 25 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function escapeRegex(s = "") {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureTaskCaseAccess(req, res, caseId) {
  if (!caseId) return true;
  try {
    await assertCaseParticipant(req, caseId);
    return true;
  } catch (err) {
    const status = err.statusCode || err.status || 500;
    res.status(status).json({ error: err.message || "Access denied" });
    return false;
  }
}

// ----------------------------------------
// All routes require auth
// ----------------------------------------
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("admin", "attorney", "paralegal"));

/**
 * GET /api/checklist
 * Query:
 *  - status=open|done|all (default open)
 *  - q= (search in title/notes/labels)
 *  - caseId=
 *  - assignee=me|<userId>
 *  - label= (single label)
 *  - priority=low|normal|high|urgent
 *  - overdue=true
 *  - today=true
 *  - page, limit
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const {
      status = "open",
      q = "",
      caseId,
      assignee,
      label,
      priority,
      overdue,
      today,
    } = req.query;

    const owner = req.user.id;
    const { page, limit, skip } = parsePagination(req);
    const filter = { owner, deleted: { $ne: true } };

    if (status === "open") filter.done = false;
    else if (status === "done") filter.done = true;

    if (q) {
      const rx = new RegExp(escapeRegex(String(q)), "i");
      filter.$or = [{ title: rx }, { notes: rx }, { labels: rx }];
    }

    if (caseId) {
      const ok = await ensureTaskCaseAccess(req, res, caseId);
      if (!ok) return;
      filter.caseId = caseId;
    }

    if (assignee) {
      if (assignee === "me") filter.$or = [...(filter.$or || []), { assignee: owner }, { owner }];
      else if (isObjId(assignee)) filter.assignee = assignee;
    }

    if (label) filter.labels = String(label).trim();
    if (priority) filter.priority = priority;

    // Date helpers
    const now = new Date();
    if (overdue === "true") {
      filter.due = { $lt: now };
      filter.done = false;
    }
    if (today === "true") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      filter.due = { ...(filter.due || {}), $gte: start, $lt: end };
    }

    const sort = { pinned: -1, done: 1, due: 1, createdAt: -1 };

    const [items, total] = await Promise.all([
      Task.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      Task.countDocuments(filter),
    ]);

    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items: items.map((i) => ({ ...i, id: String(i._id) })),
    });
  })
);

/**
 * POST /api/checklist
 * Body: { title, notes?, due?, caseId?, assignee?, priority?, labels?, checklist?[], pinned? }
 */
router.post(
  "/",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { title, notes, due, caseId, assignee, priority, labels, checklist, pinned } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: "title required" });
    if (caseId) {
      const ok = await ensureTaskCaseAccess(req, res, caseId);
      if (!ok) return;
    }

    const doc = {
      title: String(title).slice(0, 200).trim(),
      notes: typeof notes === "string" ? String(notes) : "",
      due: due ? new Date(due) : undefined,
      caseId: isObjId(caseId) ? caseId : null,
      owner: req.user.id,
      assignee: isObjId(assignee) ? assignee : null,
      priority: priority || "normal",
      labels: Array.isArray(labels) ? labels : [],
      checklist: Array.isArray(checklist) ? checklist : [],
      pinned: !!pinned,
    };

    const t = await Task.create(doc);
    await logAction(req, "task.create", { targetType: "task", targetId: t._id, caseId: doc.caseId });
    res.status(201).json({ id: String(t._id) });
  })
);

/**
 * PATCH /api/checklist/:id
 * Body: { title?, notes?, due?(string|null), done?, assignee?, priority?, labels?, pinned?, deleted? }
 */
router.patch(
  "/:id",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });

    const t = await Task.findOne({ _id: id, owner: req.user.id });
    if (!t) return res.status(404).json({ error: "Not found" });
    if (t.caseId) {
      const ok = await ensureTaskCaseAccess(req, res, String(t.caseId));
      if (!ok) return;
    }

    const { title, notes, due, done, assignee, priority, labels, pinned, deleted } = req.body || {};

    if (typeof title === "string") t.title = String(title).slice(0, 200).trim();
    if (typeof notes === "string") t.notes = notes;
    if (due === null) t.due = undefined;
    else if (typeof due === "string") t.due = new Date(due);

    if (typeof done === "boolean") {
      done ? t.markDone(req.user.id) : t.markUndone();
    }

    if (assignee === null) t.assignee = null;
    else if (isObjId(assignee)) t.assignee = assignee;

    if (priority) t.priority = priority;
    if (Array.isArray(labels)) t.labels = labels;
    if (typeof pinned === "boolean") t.pinned = pinned;

    if (typeof deleted === "boolean") {
      t.deleted = deleted;
      t.deletedAt = deleted ? new Date() : null;
      t.deletedBy = deleted ? req.user.id : null;
    }

    await t.save();
    await logAction(req, "task.update", { targetType: "task", targetId: t._id, meta: { done: t.done, pinned: t.pinned } });

    res.json({ ok: true });
  })
);

/**
 * DELETE /api/checklist/:id
 * Soft delete by default. Add ?hard=1 to permanently delete.
 */
router.delete(
  "/:id",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const hard = req.query.hard === "1";
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });

    const existing = await Task.findOne({ _id: id, owner: req.user.id });
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (existing.caseId) {
      const ok = await ensureTaskCaseAccess(req, res, String(existing.caseId));
      if (!ok) return;
    }

    if (hard) {
      await Task.deleteOne({ _id: existing._id });
      await logAction(req, "task.delete.hard", { targetType: "task", targetId: existing._id });
    } else {
      existing.deleted = true;
      existing.deletedAt = new Date();
      existing.deletedBy = req.user.id;
      await existing.save();
      await logAction(req, "task.delete.soft", { targetType: "task", targetId: existing._id });
    }

    res.json({ ok: true });
  })
);

/**
 * POST /api/checklist/:id/toggle
 * Quick toggle done/undone
 */
router.post(
  "/:id/toggle",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });

    const t = await Task.findOne({ _id: id, owner: req.user.id });
    if (!t) return res.status(404).json({ error: "Not found" });

    if (t.done) t.markUndone();
    else t.markDone(req.user.id);

    await t.save();
    await logAction(req, "task.toggle", { targetType: "task", targetId: t._id, meta: { done: t.done } });
    res.json({ ok: true, done: t.done, completedAt: t.completedAt || null });
  })
);

/**
 * POST /api/checklist/:id/checklist
 * Add a checklist item: { label }
 */
router.post(
  "/:id/checklist",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { label } = req.body || {};
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });
    if (!label || !String(label).trim()) return res.status(400).json({ error: "label required" });

    const t = await Task.findOne({ _id: id, owner: req.user.id });
    if (!t) return res.status(404).json({ error: "Not found" });

    t.addChecklistItem(String(label));
    await t.save();

    const last = t.checklist[t.checklist.length - 1];
    await logAction(req, "task.checklist.add", { targetType: "task", targetId: t._id, meta: { itemId: last?._id } });

    res.status(201).json({ ok: true, itemId: String(last?._id) });
  })
);

/**
 * POST /api/checklist/:id/checklist/:itemId/toggle
 */
router.post(
  "/:id/checklist/:itemId/toggle",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id, itemId } = req.params;
    if (!isObjId(id) || !isObjId(itemId)) return res.status(400).json({ error: "Invalid id" });

    const t = await Task.findOne({ _id: id, owner: req.user.id });
    if (!t) return res.status(404).json({ error: "Not found" });

    t.toggleChecklistItem(itemId, req.user.id);
    await t.save();

    await logAction(req, "task.checklist.toggle", { targetType: "task", targetId: t._id, meta: { itemId } });
    res.json({ ok: true });
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

module.exports = router;
