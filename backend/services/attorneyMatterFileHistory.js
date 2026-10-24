const mongoose = require("mongoose"), CaseFile = require("../models/CaseFile");
const files = require("./attorneyMatterFiles"), downloads = require("./matterDownloads");
const { decryptCaseFilePayload } = require("../utils/dataEncryption"), { fingerprint } = require("./matterDraftRevision");
const id = value => String(value || ""), valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const fail = (status, suffix) => { throw Object.assign(new Error("The document history could not be verified."), { status, publicCode: `DOCUMENT_HISTORY_${suffix}` }); };
const refs = value => [new mongoose.Types.ObjectId(value), id(value)];
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const historyRevision = (file, doc) => fingerprint([files.revision(file, doc), file.history]);
async function record(req) {
  const doc = await files.matter(req);
  if (downloads.policy(doc) !== "available") fail(403, "RESTRICTED");
  if (!valid(req.params.fileId)) fail(400, "INVALID");
  const file = await CaseFile.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.fileId), caseId: { $in: refs(doc._id) } });
  if (!file) fail(404, "NOT_FOUND");
  if (file.history !== undefined && !Array.isArray(file.history)) fail(409, "INVALID_RECORD");
  return { doc, file, plain: decryptCaseFilePayload(file) };
}
async function list(req) {
  const query = req.query || {};
  if (Object.keys(query).some(key => !["expectedOwnerId", "reviewedRevision", "cursor", "responseCursor"].includes(key)) || !/^[a-f0-9]{64}$/.test(query.reviewedRevision || "") || query.cursor !== undefined && !/^(0|[1-9]\d{0,5})$/.test(query.cursor) || query.responseCursor !== undefined && !valid(query.responseCursor)) fail(400, "INVALID");
  const initial = await record(req), { file, doc, plain } = initial;
  if (files.revision(file, doc) !== query.reviewedRevision) fail(409, "CHANGED");
  const history = plain.history || [], offset = Number(query.cursor || 0);
  if (offset > history.length) fail(409, "CHANGED");
  const revision = historyRevision(file, doc), entries = history.map((entry, index) => ({ index, retainedAt: date(entry?.replacedAt), revision: fingerprint([revision, index]), hasStoredDocument: typeof entry?.storageKey === "string" && Boolean(entry.storageKey) })).reverse().slice(offset, offset + 25);
  const responseQuery = { caseId: { $in: refs(doc._id) }, revisionOfFileId: { $in: refs(file._id) }, ...(query.responseCursor ? { _id: { $lt: new mongoose.Types.ObjectId(query.responseCursor) } } : {}) };
  const responses = await CaseFile.collection.find(responseQuery).sort({ _id: -1 }).limit(26).toArray();
  const current = await record(req);
  if (historyRevision(current.file, current.doc) !== revision) fail(409, "CHANGED");
  const currentResponses = await CaseFile.collection.find(responseQuery).sort({ _id: -1 }).limit(26).toArray();
  if (fingerprint(currentResponses) !== fingerprint(responses)) fail(409, "CHANGED");
  const finalMatter = await files.matter(req);
  if (files.matterRevision(finalMatter) !== files.matterRevision(doc)) fail(409, "CHANGED");
  const rows = responses.slice(0, 25);
  return { caseId: id(doc._id), ownerId: id(req.user.id), fileId: id(file._id), revision, entries, nextCursor: offset + entries.length < history.length ? String(offset + entries.length) : null, responses: rows.map(raw => files.shape(raw, doc)), nextResponseCursor: responses.length > 25 ? id(rows.at(-1)._id) : null };
}
async function readDownload(req) {
  const query = req.query || {};
  if (Object.keys(query).some(key => !["expectedOwnerId", "revision"].includes(key)) || !/^[a-f0-9]{64}$/.test(query.revision || "") || !/^(0|[1-9]\d{0,5})$/.test(req.params.index || "")) fail(400, "INVALID");
  const { doc, file, plain } = await record(req), index = Number(req.params.index), entry = plain.history?.[index];
  if (!entry || typeof entry.storageKey !== "string" || !entry.storageKey) fail(404, "NOT_FOUND");
  if (fingerprint([historyRevision(file, doc), index]) !== query.revision) fail(409, "CHANGED");
  // Earlier records retain their key and replacement date, but often no original
  // name, MIME, size or version. Do not invent those details from today's file.
  // A null scan record checks this object's tags without changing the current
  // document's security result.
  return { record: null, file: { originalName: "Earlier document", storageKey: entry.storageKey, mimeType: "", size: null }, doc };
}
module.exports = { list, readDownload };
