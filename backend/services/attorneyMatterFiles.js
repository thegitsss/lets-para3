const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile");
const account = require("./attorneyAccountBoundary"), downloads = require("./matterDownloads");
const { decryptCaseFilePayload, encryptString } = require("../utils/dataEncryption");
const { fingerprint } = require("./matterDraftRevision"), { normalizeCaseStatus } = require("../utils/caseState");
const { publishCaseEvent } = require("../utils/caseEvents"), { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents"), { logAction } = require("../utils/audit");
const id = value => String(value || ""), valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value), refs = value => [new mongoose.Types.ObjectId(value), id(value)];
const fail = (status, suffix) => { throw Object.assign(new Error("The document could not be verified."), { status, publicCode: `DOCUMENT_${suffix}` }); };
const matterFields = ["attorney", "attorneyId", "status", "paralegal", "paralegalId", "escrowIntentId", "escrowStatus", "archived", "readOnly", "purgedAt", "paymentReleased", "paralegalAccessRevokedAt", "completionClaimStatus", "completionClaimToken", "hiringClaimStatus", "hiringClaimToken"];
const fileFields = ["caseId", "userId", "originalName", "storageKey", "mimeType", "size", "version", "status", "revisionNotes", "revisionRequestedAt", "approvedAt", "replacedAt", "revisionOfFileId", "revisionOfVersion", "revisionRequestAt", "uploadedByRole", "securityStatus", "history", "__v"];
const selected = (raw, fields) => fields.map(key => raw[key]);
const matterRevision = raw => fingerprint(selected(raw, matterFields));
const revision = (raw, matter) => fingerprint([selected(raw, fileFields), matterRevision(matter)]);
const exact = (raw, fields) => ({ _id: raw._id, ...Object.fromEntries(fields.map(key => [key, raw[key] === undefined ? { $exists: false } : raw[key]])) });
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
function active(raw) { return normalizeCaseStatus(raw.status) === "in progress" && Boolean(raw.paralegal || raw.paralegalId) && Boolean(raw.escrowIntentId) && raw.escrowStatus === "funded" && !raw.archived && !raw.readOnly && !raw.purgedAt && !raw.paymentReleased && !raw.paralegalAccessRevokedAt && !raw.completionClaimStatus && !raw.completionClaimToken && !raw.hiringClaimStatus && !raw.hiringClaimToken; }
async function actor(req) {
  try { return await account.read(req, req.method === "GET" ? req.query.expectedOwnerId : req.body?.expectedOwnerId); }
  catch (error) { if (error.publicCode) fail(403, "ACCOUNT_CHANGED"); throw error; }
}
async function matter(req, session) {
  const user = await actor(req); if (!valid(req.params.caseId)) fail(400, "INVALID");
  const raw = await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.caseId) }, { session });
  if (!raw) fail(404, "NOT_FOUND");
  if (![raw.attorney, raw.attorneyId].some(value => id(value) === id(user._id)) || raw.attorney && raw.attorneyId && id(raw.attorney) !== id(raw.attorneyId)) fail(403, "RESTRICTED");
  if (raw.paralegal && raw.paralegalId && id(raw.paralegal) !== id(raw.paralegalId)) fail(409, "MATTER_CHANGED");
  return raw;
}
function shape(raw, doc) {
  const plain = decryptCaseFilePayload(raw), status = ["pending_review", "approved", "attorney_revision"].includes(plain.status) ? plain.status : "unknown";
  return { ...downloads.shape(raw), mimeType: typeof plain.mimeType === "string" ? plain.mimeType : "", reviewRevision: revision(raw, doc), status, uploadedByRole: ["attorney", "paralegal", "admin"].includes(plain.uploadedByRole) ? plain.uploadedByRole : "unknown", notes: typeof plain.revisionNotes === "string" ? plain.revisionNotes : "", requestedAt: iso(plain.revisionRequestedAt), approvedAt: iso(plain.approvedAt), replacedAt: iso(plain.replacedAt), revisionOf: valid(id(plain.revisionOfFileId)) ? { id: id(plain.revisionOfFileId), version: Number.isSafeInteger(plain.revisionOfVersion) ? plain.revisionOfVersion : null, requestedAt: iso(plain.revisionRequestAt) } : null, canReview: active(doc) && plain.uploadedByRole === "paralegal" && ["clean", "not_required"].includes(plain.securityStatus) && status !== "unknown" };
}
async function list(req) {
  const { cursor, fileId } = req.query;
  if (Object.keys(req.query).some(key => !["expectedOwnerId", "cursor", "fileId"].includes(key)) || cursor !== undefined && !valid(cursor) || fileId !== undefined && !valid(fileId)) fail(400, "INVALID");
  const doc = await matter(req), access = downloads.policy(doc), query = { caseId: { $in: refs(doc._id) } };
  const files = access === "available" ? await CaseFile.collection.find({ ...query, ...(cursor ? { _id: { $lt: new mongoose.Types.ObjectId(cursor) } } : {}) }).sort({ _id: -1 }).limit(51).toArray() : [];
  const target = fileId && access === "available" ? await CaseFile.collection.findOne({ ...query, _id: new mongoose.Types.ObjectId(fileId) }) : null;
  const current = await matter(req);
  if (matterRevision(doc) !== matterRevision(current)) fail(409, "MATTER_CHANGED");
  const page = files.slice(0, 50);
  return { caseId: id(doc._id), ownerId: id(req.user.id), caseTitle: doc.title || "Untitled Matter", access, canUpload: active(doc), legacyAttachments: Array.isArray(doc.files) && doc.files.length > 0, files: page.map(raw => shape(raw, doc)), nextCursor: files.length > 50 ? id(page.at(-1)._id) : null, selectedFile: target ? shape(target, doc) : null, selection: !fileId ? "none" : target ? "found" : "unavailable" };
}
async function record(req) {
  const doc = await matter(req); if (!valid(req.params.fileId)) fail(400, "INVALID");
  const file = await CaseFile.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.fileId), caseId: { $in: refs(doc._id) } });
  if (!file) fail(404, "FILE_NOT_FOUND"); return { doc, file };
}
async function update(req, { verifySecurity } = {}) {
  const body = req.body || {};
  if (Object.keys(body).some(key => !["expectedOwnerId", "reviewedRevision", "status", "notes"].includes(key)) || !/^[a-f0-9]{64}$/.test(body.reviewedRevision || "") || !["pending_review", "approved", "attorney_revision"].includes(body.status) || typeof body.notes !== "string" || body.notes.length > 2000) fail(400, "INVALID");
  const initial = await record(req);
  if (revision(initial.file, initial.doc) !== body.reviewedRevision) fail(409, "CHANGED");
  if (!shape(initial.file, initial.doc).canReview) fail(403, "REVIEW_RESTRICTED");
  // Storage scanning precedes the transaction; its result is included in the
  // fresh raw file snapshot. No storage or notification operation is replayed.
  if (verifySecurity && !await verifySecurity(initial.file)) fail(423, "SECURITY_UNAVAILABLE");
  const session = await mongoose.startSession(); let saved, doc;
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    doc = await matter(req, session);
    const file = await CaseFile.collection.findOne({ _id: initial.file._id, caseId: { $in: refs(doc._id) } }, { session });
    if (!file || revision(file, doc) !== body.reviewedRevision) fail(409, "CHANGED");
    if (!shape(file, doc).canReview) fail(403, "REVIEW_RESTRICTED");
    const now = new Date(), notes = body.status === "attorney_revision" ? body.notes.replace(/[\u0000-\u001f\u007f]/g, char => char === "\n" || char === "\t" ? char : "").trim() : "";
    const change = { status: body.status, approvedAt: body.status === "approved" ? now : null, revisionNotes: notes ? encryptString(notes) : "", revisionRequestedAt: body.status === "attorney_revision" ? now : null };
    // Writing the Case in the same transaction serializes this decision with
    // completion, withdrawal, replacement assignment and other Case writes.
    const guarded = await Case.collection.updateOne(exact(doc, matterFields), { $inc: { __v: 1 }, $set: { updatedAt: now } }, { session });
    if (guarded.matchedCount !== 1) fail(409, "MATTER_CHANGED");
    const result = await CaseFile.collection.updateOne(exact(file, fileFields), { $set: change, $inc: { __v: 1 } }, { session });
    if (result.matchedCount !== 1) fail(409, "CHANGED");
    await actor(req);
    await session.commitTransaction(); saved = shape({ ...file, ...change, __v: Number(file.__v || 0) + 1 }, doc);
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyMatterFiles.transaction_abort"));
    if (error.publicCode) throw error;
    if (error.code === 112 || error.hasErrorLabel?.("TransientTransactionError")) fail(409, "CHANGED");
    fail(503, "UNCONFIRMED");
  } finally { await session.endSession(); }
  await logAction(req, "case.file.status.update", { targetType: "case", targetId: doc._id, caseId: doc._id, meta: { fileId: req.params.fileId, status: body.status } });
  publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() }); publishCaseProjectionRefresh(doc, "matter_documents_refresh", { caseEvent: "" });
  await matter(req); return { file: saved };
}
const sendError = (res, error) => res.status(error.status || 503).json({ code: error.publicCode || "DOCUMENT_UNAVAILABLE", error: "The document changed or could not be verified. Refresh Files before continuing." });
module.exports = { list, update, shape, revision, active, sendError, actor, matter, matterRevision, matterFields, fileFields, exact };
