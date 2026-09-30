const { reportOperationalFailure } = require("../utils/operationalFailure");
const retirement = require("./matterStorageRetirement");
const matterFileWrites = require("./matterFileWrites");
const fileNotices = require("./matterFileNotifications");
const crypto = require("crypto"), mongoose = require("mongoose");
const Upload = require("../models/MatterFileUpload"), Case = require("../models/Case"), CaseFile = require("../models/CaseFile");
const files = require("./attorneyMatterFiles"), downloads = require("./matterDownloads");
const { validateMatterFileBuffer, malwareScanRequired, normalizeExtension } = require("../utils/fileSecurity");
const { buildCaseFileNameQuery, decryptCaseFilePayload, encryptCaseFileFields, encryptString } = require("../utils/dataEncryption");
const AuditLog = require("../models/AuditLog"), { publishCaseEvent } = require("../utils/caseEvents"), { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const { notifyUser } = require("../utils/notifyUser"), { isWorkspacePresenceActive } = require("../utils/workspacePresence");
const fail = (status, code) => { throw Object.assign(new Error("The file upload could not be verified."), { status, publicCode: `FILE_UPLOAD_${code}` }); };
const requestIdValid = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/.test(value);
const targetValid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const keyFor = (operation, token, extension) => `cases/${operation.caseId}/documents/${operation.fileId}-${token}${extension}`;
const targetFor = (req, doc, session) => req.params.fileId ? CaseFile.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.fileId), caseId: { $in: [doc._id, String(doc._id)] } }, { session }) : null;
async function indexReady() {
  const indexes = await Upload.collection.indexes();
  if (!indexes.some(index => index.unique && JSON.stringify(index.key) === JSON.stringify({ caseId: 1, ownerId: 1, requestId: 1 }))) fail(503, "UNAVAILABLE");
}
const queryFor = req => ({ caseId: new mongoose.Types.ObjectId(req.params.caseId), ownerId: new mongoose.Types.ObjectId(req.user.id), requestId: req.method === "GET" ? req.query.requestId : req.body.requestId });
async function outcome(operation, doc) {
  if (!operation) return { status: "missing", file: null, retryAllowed: true };
  if (operation.status === "recorded") {
    const file = downloads.policy(doc) === "available" ? await CaseFile.collection.findOne({ _id: operation.fileId, caseId: { $in: [doc._id, String(doc._id)] }, userId: { $in: [operation.ownerId, String(operation.ownerId)] } }) : null;
    const attempt = operation.attempts.find(value => value.token === operation.claimToken);
    const changed = file && (!attempt || decryptCaseFilePayload(file).storageKey !== keyFor(operation, operation.claimToken, attempt.extension));
    return { status: "recorded", file: file ? files.shape(file, doc) : null, retryAllowed: false, ...(changed ? { changedSinceUpload: true } : {}) };
  }
  return { status: operation.status, file: null, retryAllowed: operation.attempts.length < 5 && (operation.status !== "uploading" || operation.leaseUntil <= new Date()) };
}
async function review(req) {
  if (Object.keys(req.query).some(key => !["expectedOwnerId", "requestId"].includes(key)) || req.query.requestId !== undefined && !requestIdValid(req.query.requestId)) fail(400, "INVALID");
  if (req.params.fileId !== undefined && !targetValid(req.params.fileId)) fail(400, "INVALID");
  const doc = await files.matter(req); await indexReady();
  const operation = req.query.requestId ? await Upload.collection.findOne(queryFor(req), { readConcern: { level: "majority" } }) : null;
  if (operation && ((operation.kind || "upload") !== (req.params.fileId ? "replacement" : "upload") || req.params.fileId && String(operation.fileId).toLowerCase() !== req.params.fileId.toLowerCase())) fail(409, "CONTENT_CHANGED");
  const target = await targetFor(req, doc);
  const upload = req.query.requestId ? await outcome(operation, doc) : null;
  const current = await files.matter(req);
  if (files.matterRevision(current) !== files.matterRevision(doc)) fail(409, "MATTER_CHANGED");
  const latest = await targetFor(req, current);
  if (Boolean(target) !== Boolean(latest) || target && files.revision(target, doc) !== files.revision(latest, current)) fail(409, "TARGET_CHANGED");
  await files.actor(req);
  return { caseId: String(doc._id), ownerId: String(req.user.id), revision: files.matterRevision(doc), canUpload: files.active(doc) && (!req.params.fileId || Boolean(target) && (target.history === undefined || Array.isArray(target.history))), upload, ...(req.params.fileId ? { target: target ? files.shape(target, doc) : null } : {}) };
}
function input(req) {
  const body = req.body || {}, file = req.file, targetId = typeof req.params.fileId === "string" ? req.params.fileId.toLowerCase() : "";
  if (targetId && (!targetValid(targetId) || !/^[a-f0-9]{64}$/.test(body.reviewedFileRevision || ""))) fail(400, "INVALID");
  if (Object.keys(body).some(key => !["expectedOwnerId", "requestId", "reviewedRevision", ...(targetId ? ["reviewedFileRevision"] : [])].includes(key)) || !requestIdValid(body.requestId) || !/^[a-f0-9]{64}$/.test(body.reviewedRevision || "") || !file?.buffer?.length || file.buffer.length > 20 * 1024 * 1024 || file.size !== file.buffer.length) fail(400, "INVALID");
  const name = String(file.originalname || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 500);
  if (!name) fail(400, "INVALID");
  try { validateMatterFileBuffer({ buffer: file.buffer, mimeType: file.mimetype, filename: name }); }
  catch { fail(400, "TYPE"); }
  const mimeType = file.mimetype.toLowerCase(), extension = normalizeExtension(name.slice(name.lastIndexOf(".") + 1));
  const fingerprint = crypto.createHash("sha256").update(targetId ? JSON.stringify(["replacement", targetId]) : "").update(JSON.stringify([name, mimeType, file.buffer.length])).update(file.buffer).digest("hex");
  return { name, mimeType, extension: extension ? `.${extension.replace(/^\./, "")}` : "", fingerprint, targetId };
}
async function send(req, { putObject }) {
  const data = input(req), initial = await files.matter(req); await indexReady(); await retirement.ready();
  const query = queryFor(req); let operation = await Upload.collection.findOne(query);
  if (operation && operation.fingerprint !== data.fingerprint) fail(409, "CONTENT_CHANGED");
  if (operation?.status === "recorded") { const result = await outcome(operation, initial); await files.matter(req); return result; }
  await fileNotices.ready();
  if (!files.active(initial)) fail(403, "RESTRICTED");
  if (files.matterRevision(initial) !== req.body.reviewedRevision) fail(409, "MATTER_CHANGED");
  if (data.targetId) {
    const target = await targetFor(req, initial);
    if (!target || files.revision(target, initial) !== req.body.reviewedFileRevision || target.history !== undefined && !Array.isArray(target.history)) fail(409, "TARGET_CHANGED");
  }
  // A prior V1 upload with the same ID has no content fingerprint. It cannot
  // safely be adopted as proof of this V2 request.
  if (!operation && await CaseFile.collection.findOne({ caseId: initial._id, userId: query.ownerId, clientUploadId: query.requestId })) fail(409, "CONTENT_CHANGED");
  const token = crypto.randomBytes(16).toString("hex"), now = new Date(), leaseUntil = new Date(now.getTime() + 90000), attempt = { token, extension: data.extension, startedAt: now };
  if (!operation) {
    try { operation = (await Upload.create({ ...query, fingerprint: data.fingerprint, fileId: data.targetId ? new mongoose.Types.ObjectId(data.targetId) : new mongoose.Types.ObjectId(), kind: data.targetId ? "replacement" : "upload", status: "uploading", claimToken: token, leaseUntil, attempts: [attempt] })).toObject(); }
    catch (error) { if (error.code === 11000) fail(409, "IN_PROGRESS"); throw error; }
  } else {
    if (!(await outcome(operation, initial)).retryAllowed) fail(409, "IN_PROGRESS");
    const claimed = await Upload.collection.updateOne({ _id: operation._id, status: operation.status, claimToken: operation.claimToken, leaseUntil: operation.leaseUntil }, { $set: { status: "uploading", claimToken: token, leaseUntil, retirementComplete: false, updatedAt: now }, $push: { attempts: attempt } });
    if (claimed.matchedCount !== 1) fail(409, "IN_PROGRESS");
    operation = { ...operation, claimToken: token, status: "uploading", leaseUntil };
  }
  const key = keyFor(operation, token, data.extension);
  try { await putObject({ Key: key, Body: req.file.buffer, ContentType: data.mimeType, ContentLength: req.file.size }); }
  catch { await retirement.settleAttempt(operation, "unconfirmed").catch(reportOperationalFailure("services.attorneyMatterUploads.upload_retirement_outcome")); await Upload.collection.updateOne({ _id: operation._id, claimToken: token, status: "uploading" }, { $set: { status: "failed", updatedAt: new Date() } }).catch(reportOperationalFailure("services.attorneyMatterUploads.upload_failure_marker")); fail(503, "UNCONFIRMED"); }
  await retirement.settleAttempt(operation, "uploaded");
  const session = await mongoose.startSession(); let saved, doc, dispatchNotification;
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    doc = await files.matter(req, session);
    if (!files.active(doc) || files.matterRevision(doc) !== req.body.reviewedRevision) fail(409, "MATTER_CHANGED");
    const target = await targetFor(req, doc, session);
    if (data.targetId && (!target || files.revision(target, doc) !== req.body.reviewedFileRevision || target.history !== undefined && !Array.isArray(target.history))) fail(409, "TARGET_CHANGED");
    const guarded = await Case.collection.updateOne(files.exact(doc, files.matterFields), { $inc: { __v: 1 }, $set: { updatedAt: new Date() } }, { session });
    if (guarded.matchedCount !== 1) fail(409, "MATTER_CHANGED");
    await retirement.assertAttachable(doc._id, key, session);
    const retiredPreviewKey = target ? decryptCaseFilePayload(target).previewKey : "";
    if (retiredPreviewKey) await retirement.stage({ caseId: doc._id, key: retiredPreviewKey, reason: "preview_replaced", putOutcome: "unconfirmed" }, session);
    const recorded = await Upload.collection.updateOne({ _id: operation._id, status: "uploading", claimToken: token }, { $set: { status: "recorded", recordedAt: new Date(), updatedAt: new Date(), ...(retiredPreviewKey ? { retiredPreviewKey: encryptString(retiredPreviewKey) } : {}) } }, { session });
    if (recorded.matchedCount !== 1) fail(409, "IN_PROGRESS");
    const previous = await CaseFile.findOne(buildCaseFileNameQuery({ caseId: doc._id, originalName: data.name })).sort({ version: -1 }).session(session).lean();
    const version = Math.max(1, Number(previous?.version || 0) + 1), scan = malwareScanRequired();
    let stored;
    const fields = { caseId: doc._id, userId: query.ownerId, originalName: data.name, storageKey: key, mimeType: data.mimeType, size: req.file.size, uploadedByRole: "attorney", status: data.targetId ? "attorney_revision" : "pending_review", version, securityStatus: scan ? "pending" : "not_required", securityScanResult: scan ? "PENDING" : "NOT_REQUIRED" };
    if (target) {
      await matterFileWrites.preserveUploadReceipt(target, session);
      const replacing = new CaseFile(fields); await replacing.validate(); encryptCaseFileFields(replacing);
      const prepared = replacing.toObject(), change = Object.fromEntries(["userId", "originalName", "originalNameHash", "storageKey", "storageKeyHash", "storageKeyFingerprint", "mimeType", "size", "uploadedByRole", "status", "version", "securityStatus", "securityScanResult"].filter(key => prepared[key] !== undefined).map(key => [key, prepared[key]]));
      Object.assign(change, { previewKey: "", previewMimeType: "", previewSize: 0, replacedAt: new Date(), approvedAt: null, revisionRequestedAt: null, revisionNotes: "", securityScannedAt: null, securityCheckedAt: null });
      const prior = target.storageKey ? { storageKey: target.storageKey, replacedAt: change.replacedAt } : null;
      const updated = await CaseFile.collection.updateOne(files.exact(target, [...files.fileFields, "previewKey", "previewMimeType", "previewSize"]), { $set: change, $inc: { __v: 1 }, ...(prior ? { $push: { history: prior } } : {}) }, { session });
      if (updated.matchedCount !== 1) fail(409, "TARGET_CHANGED");
      stored = { ...target, ...change, __v: Number(target.__v || 0) + 1, history: [...(target.history || []), ...(prior ? [prior] : [])] };
    } else {
      const [entry] = await CaseFile.create([{ _id: operation.fileId, ...fields, clientUploadId: query.requestId }], { session }); stored = entry.toObject();
    }
    await AuditLog.logFromReq(req, data.targetId ? "case.file.replace" : "file_uploaded", {
      targetType: "case", targetId: doc._id, caseId: doc._id,
      meta: { fileId: String(operation.fileId) }, session,
    });
    const recipient = doc.paralegal || doc.paralegalId;
    if (!data.targetId && recipient && !(await isWorkspacePresenceActive(recipient, doc._id, "files"))) {
      dispatchNotification = await notifyUser(recipient, "case_file_uploaded", {
        caseId: String(doc._id), caseTitle: doc.title || "Untitled Matter",
        fileId: String(operation.fileId), fileName: data.name,
        link: `case-detail.html?caseId=${doc._id}&tab=files`,
      }, { actorUserId: req.user.id, session, deferDispatch: true, fileUpload: { id: operation._id, version } });
    }
    await files.actor(req); await session.commitTransaction(); saved = files.shape(stored, doc);
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyMatterUploads.transaction_abort"));
    // Never compensate by deleting a possibly committed file. This conditional
    // write also prevents a delayed transaction from recording an expired claim.
    await Upload.collection.updateOne({ _id: operation._id, status: "uploading", claimToken: token }, { $set: { status: "unconfirmed", updatedAt: new Date() } }).catch(reportOperationalFailure("services.attorneyMatterUploads.upload_recovery_marker"));
    if (error.publicCode) throw error;
    fail(503, "UNCONFIRMED");
  } finally { await session.endSession(); }
  publishCaseEvent(doc._id, "documents", { at: new Date().toISOString() }); publishCaseProjectionRefresh(doc, data.targetId ? "matter_documents_refresh" : "case_file_uploaded_refresh", { caseEvent: "" });
  await dispatchNotification?.();
  await files.matter(req); return { status: "recorded", file: saved, retryAllowed: false };
}
const sendError = (res, error) => res.status(error.status || 503).json({ code: error.publicCode || "FILE_UPLOAD_UNAVAILABLE", error: "The upload could not be confirmed. Check its saved status before trying again." });
module.exports = { review, send, sendError, keyFor };
