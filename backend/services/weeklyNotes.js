const crypto = require("crypto");
const WeeklyNote = require("../models/WeeklyNote");
const { normalizeDateOnly, startOfWeekDateOnly } = require("../utils/businessDate");
const { cleanMessage } = require("../utils/sanitize");

class WeeklyNotesError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function calendarWeek(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || normalizeDateOnly(value) !== value || startOfWeekDateOnly(value) !== value) {
    throw new WeeklyNotesError(400, "invalid_week", "weekStart must be a valid Monday in YYYY-MM-DD format.");
  }
  return value;
}
// Compatibility lookup only: reproduce the old server's date calculation.
// Existing storage keys and note positions are never shifted or bulk rewritten.
function legacyStorageWeek(key) {
  const date = new Date(calendarWeek(key));
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  date.setHours(0, 0, 0, 0);
  return date;
}
function normalizeNotes(notes) {
  return Array.from({ length: 7 }, (_, index) => cleanMessage(String(notes?.[index] || ""), 2000));
}
function validateNotes(notes) {
  if (!Array.isArray(notes) || notes.length !== 7 || notes.some((note) => typeof note !== "string" || note.length > 2000)) {
    throw new WeeklyNotesError(400, "invalid_notes", "Provide seven text notes, each no longer than 2,000 characters.");
  }
  return normalizeNotes(notes);
}
function revisionFor(doc, userId, key) {
  if (!doc) return `empty:${userId}:${key}`;
  // Include the original snapshot as well as the counter so out-of-band legacy
  // changes cannot masquerade as the same revision. No note text is returned here.
  const digest = crypto.createHash("sha256").update(JSON.stringify([doc.notes, doc.updatedAt, doc.calendarWeek || null])).digest("hex");
  return `${doc._id}:${doc.revision || 0}:${digest}`;
}
async function resolveWeek(userId, key) {
  const logical = await WeeklyNote.find({ userId, calendarWeek: key }).limit(2).lean();
  if (logical.length > 1) throw new WeeklyNotesError(409, "week_mapping_conflict", "This week needs a record check before notes can be saved.");
  if (logical.length) return logical[0];
  const legacy = await WeeklyNote.findOne({ userId, weekStart: legacyStorageWeek(key) }).lean();
  if (legacy?.calendarWeek && legacy.calendarWeek !== key) throw new WeeklyNotesError(409, "week_mapping_conflict", "This week needs a record check before notes can be saved.");
  return legacy;
}
function responseFor(doc, userId, key) {
  return { weekStart: key, notes: normalizeNotes(doc?.notes), updatedAt: doc?.updatedAt || null, revision: revisionFor(doc, userId, key) };
}
async function readWeeklyNotes(userId, value) {
  const key = calendarWeek(value);
  return responseFor(await resolveWeek(userId, key), userId, key);
}
async function saveWeeklyNotes(userId, body) {
  const key = calendarWeek(body?.weekStart);
  const notes = validateNotes(body?.notes);
  if (typeof body.revision !== "string" || !body.revision || body.revision.length > 200) {
    throw new WeeklyNotesError(428, "weekly_notes_precondition_required", "Refresh your notes before saving. This page needs the current notes revision.");
  }
  const doc = await resolveWeek(userId, key);
  const conflict = () => new WeeklyNotesError(409, "weekly_notes_changed", "These notes changed since you loaded them. Review the saved version before saving again.");
  if (revisionFor(doc, userId, key) !== body.revision) throw conflict();
  let saved;
  try {
    if (doc) {
      const version = doc.revision ?? 0;
      if (!Number.isSafeInteger(version) || version < 0 || version === Number.MAX_SAFE_INTEGER) throw conflict();
      const filter = { _id: doc._id, userId, notes: doc.notes, updatedAt: doc.updatedAt, $or: version === 0 ? [{ revision: 0 }, { revision: { $exists: false } }] : [{ revision: version }] };
      saved = await WeeklyNote.findOneAndUpdate(filter, { $set: { notes, calendarWeek: key }, $inc: { revision: 1 } }, { returnDocument: "after" }).lean();
      if (!saved) throw conflict();
    } else {
      saved = await WeeklyNote.create({ userId, weekStart: legacyStorageWeek(key), calendarWeek: key, revision: 1, notes });
    }
  } catch (error) { if (error.code === 11000) throw conflict(); throw error; }
  return responseFor(saved, userId, key);
}
module.exports = { WeeklyNotesError, calendarWeek, legacyStorageWeek, readWeeklyNotes, saveWeeklyNotes };
