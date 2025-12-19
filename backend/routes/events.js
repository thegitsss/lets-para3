// backend/routes/events.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const Event = require("../models/Event");
const { logAction } = require("../utils/audit");
const { assertCaseParticipant } = require("../middleware/ensureCaseParticipant");

// ----------------------------------------
// Optional CSRF (enable via ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
if (process.env.ENABLE_CSRF === "true") {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);

function parsePagination(req, { maxLimit = 200, defaultLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function clampDate(s, fallbackMs) {
  return s ? new Date(s) : new Date(Date.now() + fallbackMs);
}

async function ensureEventCaseAccess(req, res, caseId) {
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
// All routes require auth + approval
// ----------------------------------------
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("admin", "attorney", "paralegal"));

/**
 * GET /api/events
 * Query:
 *  - from, to (ISO). Defaults: from = -7d, to = +45d
 *  - type=deadline|meeting|call|court|misc
 *  - caseId=
 *  - q= (search title/where/notes)
 *  - page, limit
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const owner = req.user.id;
    const from = clampDate(req.query.from, -7 * 24 * 3600e3);
    const to = clampDate(req.query.to, 45 * 24 * 3600e3);
    const { type, caseId, q = "" } = req.query;
    const { page, limit, skip } = parsePagination(req);

    const filter = {
      owner,
      start: { $gte: from, $lte: to },
    };

    if (type) filter.type = type;
    if (caseId) {
      const ok = await ensureEventCaseAccess(req, res, caseId);
      if (!ok) return;
      filter.caseId = caseId;
    }
    if (q && q.trim()) {
      const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ title: rx }, { where: rx }, { notes: rx }];
    }

    const [items, total] = await Promise.all([
      Event.find(filter).sort({ start: 1 }).skip(skip).limit(limit).lean(),
      Event.countDocuments(filter),
    ]);

    items.forEach((i) => (i.id = String(i._id)));

    res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items,
    });
  })
);

/**
 * POST /api/events
 * Body: { title, start, end?, type?, where?, notes?, caseId?, isAllDay?, timezone?, rrule?, visibility?, attendees?, reminders?, color? }
 */
router.post(
  "/",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const {
      title,
      start,
      end,
      type,
      where,
      notes,
      caseId,
      isAllDay,
      timezone,
      rrule,
      visibility,
      attendees,
      reminders,
      color,
    } = req.body || {};

    if (!title || !start) return res.status(400).json({ error: "title and start required" });

    if (caseId) {
      const ok = await ensureEventCaseAccess(req, res, caseId);
      if (!ok) return;
    }

    const ev = await Event.create({
      title: String(title).slice(0, 500).trim(),
      start: new Date(start),
      end: end ? new Date(end) : undefined,
      type: type || "misc",
      where: typeof where === "string" ? where : "",
      notes: typeof notes === "string" ? notes : "",
      caseId: caseId && isObjId(caseId) ? caseId : null,
      owner: req.user.id,
      isAllDay: !!isAllDay,
      timezone: typeof timezone === "string" ? timezone : undefined,
      rrule: typeof rrule === "string" ? rrule : undefined,
      visibility: typeof visibility === "string" ? visibility : undefined,
      attendees: Array.isArray(attendees) ? attendees : undefined,
      reminders: Array.isArray(reminders) ? reminders : undefined,
      color: typeof color === "string" ? color : undefined,
    });

    await logAction(req, "calendar.event.create", {
      targetType: "event",
      targetId: ev._id,
      meta: { type: ev.type, caseId: ev.caseId || null },
    });

    res.status(201).json({ id: String(ev._id) });
  })
);

/**
 * PATCH /api/events/:id
 * Body: any editable fields from POST
 */
router.patch(
  "/:id",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });

    const ev = await Event.findOne({ _id: id, owner: req.user.id });
    if (!ev) return res.status(404).json({ error: "Not found" });

    const assign = (k, v) => {
      if (v === undefined) return;
      ev[k] = v;
    };

    const {
      title,
      start,
      end,
      type,
      where,
      notes,
      caseId,
      isAllDay,
      timezone,
      rrule,
      visibility,
      color,
    } = req.body || {};

    if (typeof title === "string") assign("title", String(title).slice(0, 500).trim());
    if (start) assign("start", new Date(start));
    if (end === null) assign("end", undefined);
    else if (end) assign("end", new Date(end));
    if (typeof type === "string") assign("type", type);
    if (typeof where === "string") assign("where", where);
    if (typeof notes === "string") assign("notes", notes);
    if (typeof isAllDay === "boolean") assign("isAllDay", isAllDay);
    if (typeof timezone === "string") assign("timezone", timezone);
    if (typeof rrule === "string") assign("rrule", rrule);
    if (typeof visibility === "string") assign("visibility", visibility);
    if (typeof color === "string") assign("color", color);

    if (caseId !== undefined) {
      if (caseId === null || caseId === "") {
        ev.caseId = null;
      } else {
        const ok = await ensureEventCaseAccess(req, res, caseId);
        if (!ok) return;
        ev.caseId = caseId;
      }
    }

    await ev.save();
    await logAction(req, "calendar.event.update", { targetType: "event", targetId: ev._id });
    res.json({ ok: true });
  })
);

/**
 * POST /api/events/:id/attendees
 * Body: { user?, name?, email?, role?, required?, response? }
 */
router.post(
  "/:id/attendees",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });

    const ev = await Event.findOne({ _id: id, owner: req.user.id });
    if (!ev) return res.status(404).json({ error: "Not found" });

    const att = req.body || {};
    ev.addAttendee(att);
    await ev.save();

    await logAction(req, "calendar.event.attendee.add", { targetType: "event", targetId: ev._id });
    res.status(201).json({ ok: true });
  })
);

/**
 * POST /api/events/:id/reminders
 * Body: { minutesBefore?, method? }
 */
router.post(
  "/:id/reminders",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });

    const ev = await Event.findOne({ _id: id, owner: req.user.id });
    if (!ev) return res.status(404).json({ error: "Not found" });

    const { minutesBefore = 30, method = "email" } = req.body || {};
    ev.addReminder(minutesBefore, method);
    await ev.save();

    await logAction(req, "calendar.event.reminder.add", { targetType: "event", targetId: ev._id });
    res.status(201).json({ ok: true });
  })
);

/**
 * DELETE /api/events/:id
 */
router.delete(
  "/:id",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid id" });

    const ev = await Event.findOne({ _id: id, owner: req.user.id });
    if (!ev) return res.status(404).json({ error: "Not found" });

    await ev.deleteOne();
    await logAction(req, "calendar.event.delete", { targetType: "event", targetId: ev._id });
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
