const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:checklist");
// backend/routes/checklist.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const ChecklistTask = require("../models/ChecklistTask");
const { logAction } = require("../utils/audit");
const { assertCaseParticipant } = require("../middleware/ensureCaseParticipant");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const LIST_QUERY_FIELDS = new Set(["status", "caseId", "overdue", "today", "page", "limit"]);
const CREATE_BODY_FIELDS = new Set(["title", "notes", "due", "caseId"]);

function parsePagination(req, { maxLimit = 100, defaultLimit = 25 } = {}) {
  const rawPage = req.query.page;
  const rawLimit = req.query.limit;
  if (typeof rawPage !== "undefined" && !/^[1-9]\d*$/.test(String(rawPage))) {
    return { error: "Page must be a positive integer." };
  }
  if (typeof rawLimit !== "undefined" && !/^[1-9]\d*$/.test(String(rawLimit))) {
    return { error: "Limit must be a positive integer." };
  }
  const page = rawPage ? Number(rawPage) : 1;
  const limit = rawLimit ? Number(rawLimit) : defaultLimit;
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(limit) || limit > maxLimit) {
    return { error: `Limit must be between 1 and ${maxLimit}.` };
  }
  const skip = (page - 1) * limit;
  return { page, limit, skip };
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

function parseOptionalDate(value) {
  if (value === null || value === "" || typeof value === "undefined") return { value: null };
  const match = typeof value === "string"
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/)
    : null;
  if (!match) {
    return { error: "Due date must be an ISO 8601 date and include a timezone." };
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText || 0);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  const offsetHour = Number(offsetHourText || 0);
  const offsetMinute = Number(offsetMinuteText || 0);
  if (
    day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
    || (zone !== "Z" && (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)))
  ) {
    return { error: "Invalid due date." };
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? { error: "Invalid due date." } : { value: date };
}

function unknownFields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

// ----------------------------------------
// All routes require auth
// ----------------------------------------
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("attorney"));

/**
 * GET /api/checklist
 * Query:
 *  - status=open|done|all (default open)
 *  - caseId=
 *  - overdue=true
 *  - today=true
 *  - page, limit
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const unexpected = unknownFields(req.query, LIST_QUERY_FIELDS);
    if (unexpected.length) return res.status(400).json({ error: "Unsupported task query parameter." });
    const { status = "open", caseId, overdue, today } = req.query;
    if (typeof status !== "string" || !["open", "done", "all"].includes(status)) {
      return res.status(400).json({ error: "Invalid task status." });
    }
    if (typeof overdue !== "undefined" && overdue !== "true") {
      return res.status(400).json({ error: "overdue must be true when provided." });
    }
    if (typeof today !== "undefined" && today !== "true") {
      return res.status(400).json({ error: "today must be true when provided." });
    }

    const owner = req.user.id;
    const pagination = parsePagination(req);
    if (pagination.error) return res.status(400).json({ error: pagination.error });
    const { page, limit, skip } = pagination;
    const filter = { owner };

    if (status === "open") filter.done = false;
    else if (status === "done") filter.done = true;

    if (caseId) {
      if (typeof caseId !== "string" || !isObjId(caseId)) {
        return res.status(400).json({ error: "Invalid Matter ID." });
      }
      const ok = await ensureTaskCaseAccess(req, res, caseId);
      if (!ok) return;
      filter.caseId = caseId;
    }

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

    const sort = { done: 1, due: 1, createdAt: -1 };

    const [items, total] = await Promise.all([
      ChecklistTask.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      ChecklistTask.countDocuments(filter),
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
 * Body: { title, notes?, due?, caseId? }
 */
router.post(
  "/",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const unexpected = unknownFields(req.body, CREATE_BODY_FIELDS);
    if (unexpected.length) return res.status(400).json({ error: "Unsupported task field." });
    const { title, notes, due, caseId } = req.body || {};
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Task title is required." });
    }
    if (title.trim().length > 200) {
      return res.status(400).json({ error: "Task title must be 200 characters or fewer." });
    }
    if (caseId) {
      if (typeof caseId !== "string" || !isObjId(caseId)) {
        return res.status(400).json({ error: "Invalid Matter ID." });
      }
      const ok = await ensureTaskCaseAccess(req, res, caseId);
      if (!ok) return;
    }
    if (typeof notes !== "undefined" && typeof notes !== "string") {
      return res.status(400).json({ error: "Task notes must be text." });
    }
    if (typeof notes === "string" && notes.length > 4000) {
      return res.status(400).json({ error: "Notes must be 4,000 characters or fewer." });
    }

    const parsedDue = parseOptionalDate(due);
    if (parsedDue.error) return res.status(400).json({ error: parsedDue.error });
    const doc = {
      title: title.trim(),
      notes: typeof notes === "string" ? notes.trim() : "",
      due: parsedDue.value,
      caseId: isObjId(caseId) ? caseId : null,
      owner: req.user.id,
    };

    const t = await ChecklistTask.create(doc);
    await logAction(req, "task.create", { targetType: "task", targetId: t._id, caseId: doc.caseId });
    res.status(201).json({ id: String(t._id) });
  })
);

/**
 * DELETE /api/checklist/:id
 * Permanently remove an attorney's private planning task.
 */
router.delete(
  "/:id",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });
    if (Object.keys(req.query || {}).length) {
      return res.status(400).json({ error: "Unsupported task query parameter." });
    }

    const existing = await ChecklistTask.findOne({ _id: id, owner: req.user.id });
    if (!existing) return res.status(404).json({ error: "Not found" });
    await ChecklistTask.deleteOne({ _id: existing._id });
    await logAction(req, "task.delete", { targetType: "task", targetId: existing._id });

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

    const t = await ChecklistTask.findOne({ _id: id, owner: req.user.id });
    if (!t) return res.status(404).json({ error: "Not found" });
    if (t.done) t.markUndone();
    else t.markDone(req.user.id);

    await t.save();
    await logAction(req, "task.toggle", { targetType: "task", targetId: t._id, meta: { done: t.done } });
    res.json({ ok: true, done: t.done, completedAt: t.completedAt || null });
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  if (respondToCsrfError(err, res)) return;
  const status = Number(err?.statusCode || err?.status);
  const safeStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
  if (safeStatus >= 500) runtimeLogger.error(err);
  res.status(safeStatus).json({ error: safeStatus < 500 ? err.message : "Server error" });
});

module.exports = router;
