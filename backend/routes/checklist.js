const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:checklist");
// backend/routes/checklist.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const ChecklistTask = require("../models/ChecklistTask");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const AuditLog = require("../models/AuditLog");
const { logAction } = require("../utils/audit");
const { assertCaseParticipant } = require("../middleware/ensureCaseParticipant");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const attorneyAccount = require("../services/attorneyAccountBoundary");
const { withActiveAccountWrite, accountChanged } = require("../utils/activeAccountWrite");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const LIST_QUERY_FIELDS = new Set(["status", "caseId", "overdue", "today", "page", "limit"]);
const CREATE_BODY_FIELDS = new Set(["title", "notes", "due", "caseId"]);
const COMPLETION_BODY_FIELDS = new Set(["done", "revision", "expectedOwnerId"]);

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

function taskRevision(task) {
  const date = task.updatedAt ? new Date(task.updatedAt) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function completionResponse(task) {
  return { ok: true, done: Boolean(task.done), completedAt: task.completedAt || null, revision: taskRevision(task) };
}

function withPrivateTaskWrite(req, work) {
  const owner = new mongoose.Types.ObjectId(req.user.id);
  return withActiveAccountWrite([req.user.id], async (session) => {
    if (!await User.collection.findOne({ _id: owner, role: "attorney" }, { session, projection: { _id: 1 } })) throw accountChanged();
    if (req.authSessionId) {
      const active = await AuthSession.collection.updateOne({ sessionId: req.authSessionId, userId: owner, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session });
      if (active.matchedCount !== 1) throw accountChanged();
    }
    return work(session);
  }, { ownerId: req.user.id, authVersion: Number(req.auth?.payload?.av || 0) });
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

    const t = await withPrivateTaskWrite(req, async (session) => {
      const [created] = await ChecklistTask.create([doc], { session });
      await AuditLog.logFromReq(req, "task.create", { targetType: "task", targetId: created._id, caseId: doc.caseId, session });
      return created;
    });
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
    await withPrivateTaskWrite(req, async (session) => {
      const result = await ChecklistTask.collection.deleteOne({ _id: existing._id, owner: existing.owner }, { session });
      if (result.deletedCount !== 1) throw Object.assign(new Error("Not found"), { status: 404 });
      await AuditLog.logFromReq(req, "task.delete", { targetType: "task", targetId: existing._id, session });
    });

    res.json({ ok: true });
  })
);

/**
 * POST /api/checklist/:id/toggle
 * Explicit displayed completion intent, or a compatible older no-body toggle.
 */
router.post(
  "/:id/toggle",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });
    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body) || unknownFields(body, COMPLETION_BODY_FIELDS).length || Object.keys(req.query || {}).length) {
      return res.status(400).json({ error: "Unsupported task completion field." });
    }
    const explicit = Object.keys(body).length > 0;
    if (explicit) {
      if (typeof body.done !== "boolean" || !Object.hasOwn(body, "revision") || body.revision !== null && (typeof body.revision !== "string" || !Number.isFinite(Date.parse(body.revision)) || new Date(body.revision).toISOString() !== body.revision)) {
        return res.status(400).json({ error: "Review the current task before changing its completion." });
      }
      if (typeof body.expectedOwnerId !== "string" || !isObjId(body.expectedOwnerId)) return res.status(400).json({ error: "Invalid task owner." });
      if (body.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ error: "The task account changed. Reload the list." });
    }
    const t = await ChecklistTask.findOne({ _id: id, owner: req.user.id }).lean();
    if (!t) return res.status(404).json({ error: "Not found" });
    const done = explicit ? body.done : !t.done;
    // Repeated intent must retain the original completion actor, date and revision.
    if (explicit && Boolean(t.done) === done) {
      await attorneyAccount.read(req, String(req.user.id));
      return res.json(completionResponse(t));
    }
    if (explicit && body.revision !== taskRevision(t)) {
      return res.status(409).json({ error: "This task changed. Check its current status before deciding again." });
    }
    const priorTime = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
    const updatedAt = new Date(Math.max(Date.now(), priorTime + 1));
    if (!Number.isFinite(updatedAt.getTime())) return res.status(409).json({ error: "Reload the current task before deciding again." });
    const changes = { done, completedAt: done ? updatedAt : null, completedBy: done ? new mongoose.Types.ObjectId(req.user.id) : null, updatedAt };
    const filter = {
      _id: t._id, owner: t.owner,
      done: Object.hasOwn(t, "done") ? t.done : { $exists: false },
      updatedAt: Object.hasOwn(t, "updatedAt") ? t.updatedAt : { $exists: false },
    };
    // The existing account lock and managed-session lock arbitrate concurrent
    // revocation with the owner/revision CAS in the same transaction.
    const outcome = await withActiveAccountWrite([req.user.id], async (session) => {
      if (!await User.collection.findOne({ _id: t.owner, role: "attorney" }, { session, projection: { _id: 1 } })) throw accountChanged();
      if (req.authSessionId) {
        const active = await AuthSession.collection.updateOne({ sessionId: req.authSessionId, userId: t.owner, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session });
        if (active.matchedCount !== 1) throw accountChanged();
      }
      const result = await ChecklistTask.collection.updateOne(filter, { $set: changes }, { session });
      if (result.matchedCount === 1) return { changed: true, task: { ...t, ...changes } };
      const current = await ChecklistTask.collection.findOne({ _id: t._id, owner: t.owner }, { session });
      if (!current) throw Object.assign(new Error("Not found"), { status: 404 });
      if (explicit && Boolean(current.done) === done) return { changed: false, task: current };
      throw Object.assign(new Error("This task changed. Check its current status before deciding again."), { status: 409 });
    }, { ownerId: req.user.id, authVersion: Number(req.auth?.payload?.av || 0) });
    if (outcome.changed) await logAction(req, "task.toggle", { targetType: "task", targetId: t._id, meta: { done } });
    res.json(completionResponse(outcome.task));
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
