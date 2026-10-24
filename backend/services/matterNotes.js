const { Types } = require("mongoose");
const { fingerprint } = require("./matterDraftRevision");
const exact = (value) => value === undefined ? { $exists: false } : { $eq: value };
const ownerFields = ["attorney", "attorneyId"];
const moderationFields = [...require("./matterModeration").PUBLIC_FIELDS.split(" "), "readOnly", ...ownerFields, "flags", "archived", "status", "updatedAt", "moderationStatus", "moderationFlaggedAt", "moderationFlaggedBy", "moderationResolutionRequestedAt", "moderationResolutionRequestedBy", "moderationPostingBaseline", "moderationEditRequest", "moderationReviewReceipt"];
const snapshot = (doc, fields) => Object.fromEntries(fields.map((key) => [key, exact(doc[key])]));
function noteText(value) { return typeof value === "string" ? value : value?.text || ""; }
function revisionFor(doc) { return fingerprint([String(doc._id), doc.internalNotes ?? null]); }
function shapeNote(doc) {
  const value = doc.internalNotes;
  return { caseId: String(doc._id), caseTitle: doc.title || "Untitled Matter", note: noteText(value), revision: revisionFor(doc), updatedAt: value?.updatedAt || null };
}
function normalizeNote(value) {
  if (typeof value !== "string") return null;
  // Keep paragraphs, spacing and tabs. Reject oversize input instead of silently truncating it.
  const text = value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return text.length <= 10000 ? text : null;
}
function ownerFilter(doc) { return snapshot(doc, ownerFields); }
function moderationSnapshot(doc) { return snapshot(doc, moderationFields); }
async function appendModerationNote(Case, doc, expected, entry, actor, now, options = {}) {
  const changes = Object.fromEntries(["flags", ...moderationFields.filter((key) => key.startsWith("moderation"))].filter((key) => doc[key] !== undefined).map((key) => [key, key.endsWith("By") && doc[key] ? new Types.ObjectId(String(doc[key])) : doc[key]]));
  // Append to the latest note, without replacing a concurrent attorney save or unrelated metadata.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await Case.collection.findOne({ _id: doc._id, ...expected }, options);
    if (!current) return { ok: false, code: "NOTE_CONFLICT" };
    const existing = noteText(current.internalNotes);
    const text = existing ? `${existing}\n\n${entry}` : entry;
    if (text.length > 10000) return { ok: false, code: "NOTE_LIMIT" };
    const original = current.internalNotes;
    const result = await Case.collection.updateOne({ _id: doc._id, ...expected, internalNotes: exact(original) }, { $set: {
      ...changes, updatedAt: now,
      internalNotes: { ...(original && typeof original === "object" ? original : {}), text, updatedAt: now, updatedBy: actor },
    } }, options);
    if (result.matchedCount) return { ok: true };
  }
  return { ok: false, code: "NOTE_CONFLICT" };
}
module.exports = { exact, shapeNote, revisionFor, normalizeNote, ownerFilter, moderationSnapshot, appendModerationNote };
