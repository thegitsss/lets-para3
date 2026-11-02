"use strict";

const crypto = require("crypto"), jwt = require("jsonwebtoken"), mongoose = require("mongoose");
const { GetObjectCommand, HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const Session = require("../../models/DocumentEditorSession"), CaseFile = require("../../models/CaseFile"), Upload = require("../../models/MatterFileUpload"), AuditLog = require("../../models/AuditLog");
const writes = require("../matterFileWrites"), retirement = require("../matterStorageRetirement");
const { createS3Client } = require("../../utils/s3Client");
const { confidentialStorageEncryption } = require("../../utils/storageEncryption");
const { encryptString, decryptString, decryptCaseFilePayload } = require("../../utils/dataEncryption");
const { matterUploadKey } = require("../../utils/uploadQuarantine");
const { assertObjectMalwareSafe, validateMatterFileBuffer, malwareScanRequired } = require("../../utils/fileSecurity");
const { isRecordVisibleToCurrentAssignment } = require("../../utils/matterAssignmentVisibility");
const { publishCaseEvent } = require("../../utils/caseEvents");

const MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_BYTES = 20 * 1024 * 1024, SESSION_MS = 8 * 60 * 60 * 1000;
const id = value => String(value?._id || value || ""), valid = value => /^[a-f0-9]{24}$/i.test(id(value));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
// Security scans and review decisions have their own concurrency guards, but
// do not replace the bytes the co-editing session is based on.
const fileFingerprint = raw => digest(JSON.stringify([id(raw._id), id(raw.caseId), raw.storageKey, raw.version || 1]));
const fail = (status, suffix, message) => { throw Object.assign(new Error(message || "Document collaboration is unavailable. Refresh Files before continuing."), { status, publicCode: `DOCUMENT_EDITOR_${suffix}` }); };

function origin(value, env) {
  try {
    const url = new URL(String(value || ""));
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.protocol !== "https:" && !(env.NODE_ENV !== "production" && loopback && url.protocol === "http:")) return "";
    return url.origin;
  } catch { return ""; }
}
function configuration(env = process.env) {
  const server = origin(env.ONLYOFFICE_DOCUMENT_SERVER_URL, env), app = origin(env.APP_BASE_URL, env);
  const secret = String(env.ONLYOFFICE_JWT_SECRET || "");
  const configured = Boolean(server && app && secret.length >= 32 && env.S3_BUCKET && env.JWT_SECRET);
  return { configured, origin: server, scriptUrl: server ? `${server}/web-apps/apps/api/documents/api.js` : "", appOrigin: app, secret };
}
function publicStatus(env = process.env) {
  return configuration(env).configured ? { configured: true, formats: ["docx"] } : { configured: false, formats: ["docx"], reason: "Document collaboration has not been connected yet. You can continue sharing and reviewing files through Files." };
}
function readyConfiguration() { const config = configuration(); if (!config.configured) fail(503, "NOT_CONFIGURED", publicStatus().reason); return config; }
function sourceSecret() { return crypto.createHmac("sha256", process.env.JWT_SECRET).update("lpc-document-editor-source-v1").digest("hex"); }
async function sessionById(sessionId) {
  if (!valid(sessionId)) fail(404, "NOT_FOUND");
  const session = await Session.findById(sessionId).select("+participants +encryptedSourceKey +sourceETag +sourceObjectVersion +leaseToken +lastCallbackDigest").lean();
  if (!session || session.expiresAt <= new Date()) fail(410, "EXPIRED", "This editing session expired. Return to Files and open the document again.");
  return session;
}
async function fileFor(req, { security = true } = {}) {
  const matter = await writes.read(req);
  if (!valid(req.params.fileId)) fail(400, "INVALID");
  const raw = await CaseFile.collection.findOne({ _id: new mongoose.Types.ObjectId(req.params.fileId), caseId: { $in: [matter._id, id(matter._id)] } });
  if (!raw || !isRecordVisibleToCurrentAssignment(raw, matter, { role: req.user.role, userId: req.user.id })) fail(404, "NOT_FOUND");
  const file = decryptCaseFilePayload(raw);
  if (file.mimeType !== MIME || !/\.docx$/i.test(file.originalName)) fail(415, "FORMAT", "Open a DOCX document to edit together. Other file types remain available in Files.");
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_BYTES) fail(413, "SIZE", "Document collaboration accepts DOCX files up to 20 MB.");
  if (security) {
    await assertObjectMalwareSafe({ s3: createS3Client(), bucket: process.env.S3_BUCKET, key: file.storageKey });
    if (["blocked", "error"].includes(file.securityStatus)) fail(423, "SECURITY", "This document is unavailable until its security check passes.");
  }
  return { matter, raw, file };
}
function participantFor(req) {
  return { userId: new mongoose.Types.ObjectId(req.user.id), role: req.user.role, authVersion: Number(req.auth?.payload?.av || 0), encryptedAuthSessionId: req.authSessionId ? encryptString(req.authSessionId, { plaintext: true }) : "" };
}
function callbackRequest(session, userId) {
  const actor = session.participants.find(value => id(value.userId) === id(userId));
  if (!actor) fail(403, "ACTOR");
  return { user: { id: id(actor.userId), role: actor.role }, auth: { payload: { av: actor.authVersion } }, authSessionId: actor.encryptedAuthSessionId ? decryptString(actor.encryptedAuthSessionId) : undefined, params: { caseId: id(session.caseId), fileId: id(session.fileId) }, headers: {}, method: "POST", originalUrl: "/api/document-collaboration/callback" };
}
async function open(req) {
  if (req.body?.expectedOwnerId !== undefined && req.body.expectedOwnerId !== id(req.user?.id)) fail(403, "ACCOUNT_CHANGED", "The signed-in account changed. Refresh Files before opening the editor.");
  const settings = readyConfiguration(), initial = await fileFor(req), activeKey = `${req.params.caseId}:${req.params.fileId}`;
  await Session.init();
  await Session.updateMany({ activeKey, $or: [{ expiresAt: { $lte: new Date() } }, { state: { $in: ["closed", "needs_review"] } }] }, { $unset: { activeKey: "" } });
  let session = await Session.findOne({ activeKey }).select("+participants +encryptedSourceKey").lean();
  if (session && session.currentFileFingerprint !== fileFingerprint(initial.raw)) fail(409, "CHANGED", "The document changed outside the editor. Close the earlier editing session before opening the current version.");
  if (!session) {
    const head = await createS3Client().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: initial.file.storageKey }), { abortSignal: AbortSignal.timeout(30000) });
    if (!head.ETag || head.ContentLength !== initial.file.size) fail(409, "SOURCE_CHANGED", "The stored document changed. Refresh Files before opening the editor.");
    try {
      session = (await Session.create({ caseId: initial.matter._id, fileId: initial.raw._id, activeKey, documentKey: crypto.randomBytes(24).toString("hex"), encryptedSourceKey: encryptString(initial.file.storageKey), sourceETag: head.ETag, sourceObjectVersion: head.VersionId && head.VersionId !== "null" ? head.VersionId : "", sourceVersion: initial.file.version || 1, sourceFingerprint: fileFingerprint(initial.raw), currentFileFingerprint: fileFingerprint(initial.raw), savedVersion: initial.file.version || 1, participants: [participantFor(req)], expiresAt: new Date(Date.now() + SESSION_MS) })).toObject();
    } catch (error) {
      if (error.code !== 11000) throw error;
      session = await Session.findOne({ activeKey }).select("+participants +encryptedSourceKey").lean();
      if (!session || session.currentFileFingerprint !== fileFingerprint(initial.raw)) fail(409, "CHANGED");
    }
  }
  // Join and credential refresh happen atomically; competing joins cannot drop
  // another participant. The same document key enables actual co-editing.
  const participant = participantFor(req);
  await Session.collection.updateOne({ _id: session._id }, [{ $set: { participants: { $concatArrays: [{ $filter: { input: "$participants", as: "participant", cond: { $ne: ["$$participant.userId", participant.userId] } } }, { $literal: [participant] }] }, updatedAt: new Date() } }]);
  const final = await fileFor(req);
  if (fileFingerprint(final.raw) !== session.currentFileFingerprint) fail(409, "CHANGED");
  const sourceToken = jwt.sign({ purpose: "document-source", sid: id(session._id), uid: id(req.user.id), av: participant.authVersion, authSessionFingerprint: digest(String(req.authSessionId || "")) }, sourceSecret(), { algorithm: "HS256", expiresIn: "2h", issuer: "lpc-document-editor", audience: "onlyoffice-source" });
  const config = {
    documentType: "word", width: "100%", height: "100%",
    document: { fileType: "docx", key: session.documentKey, title: final.file.originalName, url: `${settings.appOrigin}/api/document-collaboration/source/${session._id}?token=${encodeURIComponent(sourceToken)}`, permissions: { edit: true, review: true, comment: true, download: true, print: true } },
    editorConfig: { mode: "edit", lang: "en", callbackUrl: `${settings.appOrigin}/api/document-collaboration/callback/${session._id}`, user: { id: id(req.user.id), name: req.user.role === "attorney" ? "Matter attorney" : "Matter paralegal" }, coEditing: { mode: "fast", change: false }, customization: { autosave: true, forcesave: true, chat: false, review: { trackChanges: true, reviewDisplay: "markup" } } },
  };
  config.token = jwt.sign(config, settings.secret, { algorithm: "HS256", expiresIn: "2h" });
  return { sessionId: id(session._id), scriptUrl: settings.scriptUrl, editorOrigin: settings.origin, config, expiresAt: session.expiresAt.toISOString(), savedVersion: session.savedVersion };
}
async function boundedBuffer(body, maximum = MAX_BYTES) {
  if (!body) fail(502, "EMPTY");
  if (Buffer.isBuffer(body)) { if (!body.length || body.length > maximum) fail(413, "SIZE"); return body; }
  const chunks = []; let length = 0;
  for await (const part of body) { const chunk = Buffer.from(part); length += chunk.length; if (length > maximum) { body.destroy?.(); fail(413, "SIZE"); } chunks.push(chunk); }
  if (!length) fail(502, "EMPTY");
  return Buffer.concat(chunks, length);
}
async function source(sessionId, token) {
  readyConfiguration(); let claims;
  try { claims = jwt.verify(token, sourceSecret(), { algorithms: ["HS256"], issuer: "lpc-document-editor", audience: "onlyoffice-source" }); } catch { fail(403, "TOKEN"); }
  if (claims.purpose !== "document-source" || claims.sid !== sessionId) fail(403, "TOKEN");
  const session = await sessionById(sessionId);
  if (!["open", "saving"].includes(session.state)) fail(410, "CLOSED");
  const sourceActor = session.participants.find(value => id(value.userId) === id(claims.uid));
  if (!sourceActor || sourceActor.authVersion !== claims.av || digest(sourceActor.encryptedAuthSessionId ? decryptString(sourceActor.encryptedAuthSessionId) : "") !== claims.authSessionFingerprint) fail(403, "TOKEN");
  const req = callbackRequest(session, claims.uid), initial = await fileFor(req, { security: false });
  const key = decryptString(session.encryptedSourceKey);
  if (key !== initial.file.storageKey && !(initial.file.history || []).some(entry => entry.storageKey === key)) fail(409, "CHANGED");
  const s3 = createS3Client(), bucket = process.env.S3_BUCKET, signal = AbortSignal.timeout(30000);
  await assertObjectMalwareSafe({ s3, bucket, key, signal });
  const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
  if (!head.ETag || !Number.isSafeInteger(head.ContentLength) || head.ContentLength <= 0 || head.ContentLength > MAX_BYTES) fail(413, "SIZE");
  if (head.ETag !== session.sourceETag || session.sourceObjectVersion && head.VersionId !== session.sourceObjectVersion) fail(409, "SOURCE_CHANGED");
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: head.ETag, ...(session.sourceObjectVersion ? { VersionId: session.sourceObjectVersion } : {}) }), { abortSignal: signal });
  const buffer = await boundedBuffer(response.Body);
  validateMatterFileBuffer({ buffer, mimeType: MIME, filename: "Document.docx" });
  await assertObjectMalwareSafe({ s3, bucket, key, signal });
  await fileFor(req, { security: false });
  return { buffer, mimeType: MIME };
}
function verifiedCallback(req, settings = readyConfiguration()) {
  const authorization = String(req.headers?.authorization || "");
  const token = req.body?.token || (authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
  if (typeof token !== "string" || token.length > 32768) fail(403, "TOKEN");
  let verified;
  try { verified = jwt.verify(token, settings.secret, { algorithms: ["HS256"] }); } catch { fail(403, "TOKEN"); }
  if (verified.operation && verified.operation !== "callback") fail(403, "TOKEN");
  const payload = verified.payload || verified;
  if (!payload || typeof payload.key !== "string" || ![1, 2, 3, 4, 6, 7].includes(payload.status)) fail(403, "TOKEN");
  // Only signed parameters are used. Unsigned body parameters cannot substitute
  // a different download URL, status, actor, or document.
  return payload;
}
function downloadUrl(value, settings) {
  let url; try { url = new URL(value); } catch { fail(400, "URL"); }
  if (url.origin !== settings.origin || url.username || url.password || url.hash) fail(403, "URL");
  return url.href;
}
async function callback(req) {
  const settings = readyConfiguration(), payload = verifiedCallback(req, settings), session = await sessionById(req.params.sessionId);
  if (payload.key !== session.documentKey) fail(403, "DOCUMENT");
  if ([3, 7].includes(payload.status)) { await Session.updateOne({ _id: session._id, state: { $ne: "closed" } }, { $set: { lastErrorCode: "PROVIDER_SAVE_FAILED" } }); return { error: 1 }; }
  if (payload.status === 1) return { error: 0 };
  if (payload.status === 4) { await Session.updateOne({ _id: session._id, state: "open" }, { $set: { state: "closed" }, $unset: { activeKey: "" } }); return { error: 0 }; }
  const url = downloadUrl(payload.url, settings), callbackDigest = digest(JSON.stringify([payload.key, payload.status, payload.url, payload.users]));
  if (session.lastCallbackDigest === callbackDigest && session.lastSavedAt) return { error: 0 };
  if (session.state === "closed") fail(409, "CLOSED");
  const actorId = Array.isArray(payload.users) ? payload.users.at(-1) : null;
  if (!actorId) fail(403, "ACTOR");
  const actorReq = callbackRequest(session, actorId), initial = await fileFor(actorReq);
  const requestId = `editor:${session._id}:${callbackDigest}`;
  const priorReceipt = await Upload.collection.findOne({ caseId: session.caseId, ownerId: new mongoose.Types.ObjectId(actorId), requestId });
  if (priorReceipt?.status === "recorded") return { error: 0 };
  if (fileFingerprint(initial.raw) !== session.currentFileFingerprint) fail(409, "CHANGED");
  const leaseToken = crypto.randomBytes(16).toString("hex"), now = new Date();
  const lock = await Session.updateOne({ _id: session._id, currentFileFingerprint: session.currentFileFingerprint, $or: [{ state: "open" }, { state: "saving", leaseUntil: { $lte: now } }] }, { $set: { state: "saving", leaseToken, leaseUntil: new Date(Date.now() + 180000), lastErrorCode: "" } });
  if (lock.modifiedCount !== 1) fail(409, "BUSY", "The editor is already saving this document. Check the saved version before trying again.");
  let operation;
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(30000) });
    if (response.status !== 200) fail(502, "DOWNLOAD", "The editor could not provide the changed document. Keep the editor open and retry saving.");
    const length = response.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) fail(413, "SIZE");
    const buffer = await boundedBuffer(response.body);
    validateMatterFileBuffer({ buffer, mimeType: MIME, filename: "Document.docx" });
    // Each attempt owns a new quarantined object, and existing reconciliation
    // retains uncertain uploads. Never overwrite or delete the original.
    const token = crypto.randomBytes(16).toString("hex");
    await writes.ready();
    const previous = await Upload.collection.findOne({ caseId: session.caseId, ownerId: new mongoose.Types.ObjectId(actorId), requestId });
    if (previous?.status === "recorded") {
      const committed = await sessionById(id(session._id));
      if (committed.lastCallbackDigest === callbackDigest) return { error: 0 };
      fail(409, "RECOVERY");
    }
    if (previous) fail(409, "RECOVERY", "An earlier save needs review. The original document remains available in Files.");
    operation = (await Upload.create({ caseId: session.caseId, ownerId: actorId, requestId, fingerprint: digest(buffer), fileId: session.fileId, kind: "replacement", status: "uploading", claimToken: token, leaseUntil: new Date(Date.now() + 180000), attempts: [{ token, extension: ".docx", keyVersion: 2, startedAt: now }] })).toObject();
    const key = matterUploadKey(operation, token, ".docx"), s3 = createS3Client();
    await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: buffer, ContentType: MIME, ...confidentialStorageEncryption() }), { abortSignal: AbortSignal.timeout(30000) });
    await retirement.settleAttempt(operation, "uploaded");
    await writes.run(actorReq, initial.matter, async transaction => {
      const currentSession = await Session.collection.findOne({ _id: session._id, state: "saving", leaseToken }, { session: transaction });
      const raw = await CaseFile.collection.findOne({ _id: session.fileId, caseId: { $in: [session.caseId, id(session.caseId)] } }, { session: transaction });
      if (!currentSession || !raw || fileFingerprint(raw) !== session.currentFileFingerprint) fail(409, "CHANGED");
      await retirement.assertAttachable(session.caseId, key, transaction);
      await writes.preserveUploadReceipt(raw, transaction);
      const file = CaseFile.hydrate(raw), plain = decryptCaseFilePayload(raw);
      file.history.push({ storageKey: raw.storageKey, replacedAt: new Date() });
      if (plain.previewKey) await retirement.stage({ caseId: session.caseId, key: plain.previewKey, reason: "preview_replaced", putOutcome: "unconfirmed" }, transaction);
      file.storageKey = key; file.previewKey = ""; file.previewMimeType = ""; file.previewSize = 0;
      file.size = buffer.length; file.version = Number(raw.version || 1) + 1; file.replacedAt = new Date();
      file.userId = actorId; file.uploadedByRole = actorReq.user.role; file.status = "pending_review";
      file.approvedAt = null; file.revisionRequestedAt = null; file.revisionNotes = "";
      file.securityStatus = malwareScanRequired() ? "pending" : "not_required";
      file.securityScanResult = malwareScanRequired() ? "PENDING" : "NOT_REQUIRED";
      file.securityScannedAt = null; file.securityCheckedAt = null;
      await file.save({ session: transaction });
      await writes.recordUpload(operation, transaction);
      await AuditLog.logFromReq(actorReq, "document.collaboration.saved", { targetType: "document", targetId: file._id, caseId: session.caseId, meta: { fileId: id(file._id), version: file.version, editorSessionId: id(session._id) }, session: transaction });
      const saved = await Session.collection.updateOne({ _id: session._id, leaseToken, state: "saving" }, { $set: { currentFileFingerprint: fileFingerprint(file.toObject()), savedVersion: file.version, lastSavedAt: new Date(), lastCallbackDigest: callbackDigest, state: payload.status === 2 ? "closed" : "open", lastErrorCode: "", leaseToken: "", leaseUntil: null, updatedAt: new Date() }, ...(payload.status === 2 ? { $unset: { activeKey: "" } } : {}) }, { session: transaction });
      if (saved.matchedCount !== 1) fail(409, "CHANGED");
    });
    publishCaseEvent(session.caseId, "documents", { at: new Date().toISOString(), type: "document_collaboration_saved" });
    return { error: 0 };
  } catch (error) {
    // A lost commit response may already have saved the file. Consult the same
    // transactional receipt before returning a failure or attempting new work.
    const receipt = await Session.collection.findOne({ _id: session._id, lastCallbackDigest: callbackDigest });
    if (receipt?.lastSavedAt) return { error: 0 };
    if (operation) await writes.unconfirmedUpload(operation);
    await Session.updateOne({ _id: session._id, leaseToken, state: "saving" }, { $set: { state: operation ? "needs_review" : "open", lastErrorCode: error.publicCode || "SAVE_UNCONFIRMED", leaseToken: "", leaseUntil: null }, ...(operation ? { $unset: { activeKey: "" } } : {}) });
    throw error;
  }
}
async function status(req) {
  const session = await sessionById(req.params.sessionId);
  req.params.caseId = id(session.caseId); req.params.fileId = id(session.fileId);
  await fileFor(req, { security: false });
  const messages = { open: session.lastSavedAt ? "Your latest saved version is recorded in Files." : "Changes are recorded in Files after the editor confirms a save.", saving: "Saving the document. Keep the editor open until the saved version is confirmed.", closed: "This editing session is closed. The saved document is available in Files.", needs_review: "The save could not be confirmed. Keep or download a copy from the editor and check Files before making further changes." };
  return { sessionId: id(session._id), caseId: id(session.caseId), fileId: id(session.fileId), state: session.state, savedVersion: session.savedVersion, lastSavedAt: session.lastSavedAt?.toISOString() || null, expiresAt: session.expiresAt.toISOString(), message: session.lastErrorCode && session.state === "open" ? "The last save did not complete. Keep the editor open and try saving again." : messages[session.state] };
}

module.exports = { configuration, publicStatus, open, source, callback, status, verifiedCallback, downloadUrl, boundedBuffer, fileFingerprint, MAX_BYTES };
