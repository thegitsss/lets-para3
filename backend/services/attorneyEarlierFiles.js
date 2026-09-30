const crypto = require("crypto"), { Types } = require("mongoose");
const CaseFile = require("../models/CaseFile"), Removal = require("../models/MatterFileRemoval");
const files = require("./attorneyMatterFiles"), downloads = require("./matterDownloads");
const { decryptCaseFilePayload, decryptString, isEncrypted } = require("../utils/dataEncryption"), { fingerprint } = require("./matterDraftRevision");
const id = value => String(value || ""), validId = value => /^[a-f0-9]{24}$/i.test(id(value)), hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const refs = value => [new Types.ObjectId(id(value)), id(value)], limit = 4000;
const token = value => crypto.createHmac("sha256", process.env.JWT_SECRET).update(fingerprint(value)).digest("hex");
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const fail = (status, suffix) => { throw Object.assign(new Error("Earlier Matter files could not be verified. Refresh Files before continuing."), { status, publicCode: `DOCUMENT_EARLIER_${suffix}` }); };
function plain(value) { const result = decryptString(value); if (result == null) return ""; if (typeof result !== "string" || isEncrypted(result)) fail(409, "SOURCE_INVALID"); return result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""); }
function isAllowedKey(caseId, key) {
  const prefix = `cases/${id(caseId).toLowerCase()}/`;
  return validId(caseId) && typeof key === "string" && key === key.trim() && key.startsWith(prefix) && !/[\\%?#\u0000-\u001f\u007f]/.test(key) && !key.split("/").some(part => !part || part === "." || part === "..") && !key.slice(prefix.length).startsWith("previews/") && !/^(?:archive(?:-[^/]*)?\.zip|receipt-(?:attorney|payout|paralegal|withdrawal)(?:-[^/]*)?\.pdf)$/i.test(key.slice(prefix.length));
}
async function inventory(req) {
  const doc = await files.matter(req), caseId = id(doc._id), access = downloads.policy(doc);
  if (access !== "available") return { doc, access, entries: [], revision: token([caseId, access, files.matterRevision(doc)]) };
  if (doc.files != null && !Array.isArray(doc.files)) fail(409, "SOURCE_INVALID");
  if ((doc.files || []).length > limit) fail(413, "TOO_LARGE");
  const [current, removals] = await Promise.all([
    CaseFile.collection.find({ caseId: { $in: refs(caseId) } }, { projection: { originalName: 1, storageKey: 1, size: 1, version: 1, createdAt: 1, history: 1 } }).sort({ _id: 1 }).limit(limit + 1).toArray(),
    Removal.collection.find({ caseId: { $in: refs(caseId) } }, { projection: { snapshot: 1, removedMirrors: 1, removedAt: 1 } }).sort({ _id: 1 }).limit(limit + 1).toArray(),
  ]);
  if (current.length > limit || removals.length > limit) fail(413, "TOO_LARGE");
  const existing = new Set(), keys = new Set(), entries = []; let inspected = 0;
  for (const raw of current) {
    const file = decryptCaseFilePayload(raw); if (file.storageKey && plain(file.storageKey).startsWith(`cases/${caseId}/documents/`)) existing.add(plain(file.storageKey));
    if (file.history !== undefined && !Array.isArray(file.history)) fail(409, "SOURCE_INVALID");
    for (const earlier of file.history || []) if (earlier?.storageKey && plain(earlier.storageKey).startsWith(`cases/${caseId}/documents/`)) existing.add(plain(earlier.storageKey));
  }
  function add(source, rawKey, name, kind, recordedAt, size, version) {
    if (++inspected > limit) fail(413, "TOO_LARGE");
    const key = plain(rawKey), label = plain(name);
    if (!key && !label) return;
    if (key && (existing.has(key) || keys.has(key))) return;
    if (key) keys.add(key);
    // Stored platform receipts and archives have their own financial/retention controls.
    if (key === doc.archiveZipKey || new RegExp(`^cases/${caseId}/(?:archive(?:-[^/]*)?\\.zip|receipt-(?:attorney|payout|paralegal|withdrawal)(?:-[^/]*)?\\.pdf)$`, "i").test(key)) return;
    const available = isAllowedKey(caseId, key);
    entries.push({ id: fingerprint([caseId, key || [source, label]]), name: label || "Name not recorded", kind, recordedAt: date(recordedAt), size: Number.isSafeInteger(size) && size >= 0 ? size : null, version: Number.isSafeInteger(version) && version > 0 ? version : null, available, key });
    if (entries.length > limit) fail(413, "TOO_LARGE");
  }
  function earlier(source, record, name, kind, legacy) {
    if (record.history === undefined || record.history === null) return;
    if (!Array.isArray(record.history)) fail(409, "SOURCE_INVALID");
    record.history.forEach((entry, index) => { if (!entry || typeof entry !== "object") fail(409, "SOURCE_INVALID"); add([...source, index], legacy ? entry.key || entry.storageKey : entry.storageKey, name, kind, entry.replacedAt, null, null); });
  }
  for (const raw of current) {
    const file = decryptCaseFilePayload(raw);
    if (file.storageKey && !plain(file.storageKey).startsWith(`cases/${caseId}/documents/`)) add(["earlier_case_file", id(raw._id)], file.storageKey, file.originalName, "earlier_attachment", file.createdAt, file.size, file.version);
    earlier(["earlier_case_file_history", id(raw._id)], file, file.originalName, "earlier_version", false);
  }
  (doc.files || []).forEach((entry, index) => {
    if (!entry || typeof entry !== "object") fail(409, "SOURCE_INVALID");
    const name = entry.original || entry.filename || entry.name;
    add(["legacy", index], entry.key, name, "earlier_attachment", entry.uploadedAt || entry.createdAt, entry.size, entry.version);
    earlier(["legacy_history", index], entry, name, "earlier_version", true);
  });
  for (const removal of removals) {
    if (!removal.snapshot || typeof removal.snapshot !== "object" || Array.isArray(removal.snapshot) || !Array.isArray(removal.removedMirrors)) fail(409, "SOURCE_INVALID");
    const snapshot = decryptCaseFilePayload(removal.snapshot);
    earlier(["removed_history", id(removal._id)], snapshot, snapshot.originalName, "removed_document_history", false);
    removal.removedMirrors.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") fail(409, "SOURCE_INVALID");
      earlier(["removed_mirror_history", id(removal._id), index], entry, entry.originalName || entry.original || entry.filename || entry.name, "removed_document_history", true);
    });
  }
  // Bind pages and downloads to the persisted sources, including entries not
  // rendered because their current document is already listed in Files.
  const revision = token([caseId, files.matterRevision(doc), doc.files, doc.archiveZipKey, current, removals]);
  entries.sort((a, b) => (b.recordedAt || "").localeCompare(a.recordedAt || "") || a.id.localeCompare(b.id));
  return { doc, access, revision, entries };
}
const dto = (entry, revision) => ({ id: entry.id, name: entry.name, kind: entry.kind, recordedAt: entry.recordedAt, size: entry.size, version: entry.version, available: entry.available, revision: token([revision, entry.id]) });
async function read(req) {
  const query = req.query || {};
  if (Object.keys(query).some(key => !["expectedOwnerId", "cursor", "revision", "referenceId"].includes(key)) || query.cursor !== undefined && (!/^(0|[1-9]\d{0,5})$/.test(query.cursor) || !hash(query.revision)) || query.revision !== undefined && !hash(query.revision) || query.referenceId !== undefined && !hash(query.referenceId)) fail(400, "INVALID");
  const first = await inventory(req), offset = Number(query.cursor || 0);
  if (offset > first.entries.length || query.revision && query.revision !== first.revision) fail(409, "CHANGED");
  const current = await inventory(req); if (first.revision !== current.revision) fail(409, "CHANGED");
  const page = first.entries.slice(offset, offset + 50), selected = query.referenceId ? first.entries.find(entry => entry.id === query.referenceId) : null;
  return { caseId: id(first.doc._id), ownerId: id(req.user.id), access: first.access, revision: first.revision, total: first.entries.length, entries: page.map(entry => dto(entry, first.revision)), nextCursor: offset + page.length < first.entries.length ? String(offset + page.length) : null, selected: selected ? dto(selected, first.revision) : null, selection: !query.referenceId ? "none" : selected ? "found" : "unavailable" };
}
async function readDownload(req) {
  if (Object.keys(req.query || {}).some(key => !["expectedOwnerId", "revision"].includes(key)) || !hash(req.params.referenceId) || !hash(req.query.revision)) fail(400, "INVALID");
  const current = await inventory(req); if (current.access !== "available") fail(403, "RESTRICTED");
  const entry = current.entries.find(value => value.id === req.params.referenceId); if (!entry) fail(404, "NOT_FOUND");
  if (token([current.revision, entry.id]) !== req.query.revision) fail(409, "CHANGED");
  if (!entry.available) fail(409, "REFERENCE_UNAVAILABLE");
  return { doc: current.doc, record: null, file: { originalName: entry.kind === "earlier_attachment" ? entry.name : "Earlier document", storageKey: entry.key, mimeType: "", size: entry.size } };
}
module.exports = { read, readDownload, isAllowedKey };
