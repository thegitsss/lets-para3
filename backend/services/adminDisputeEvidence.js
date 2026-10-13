"use strict";
const mongoose = require("mongoose");
const { createHash } = require("crypto");
const Case = require("../models/Case"), CaseFile = require("../models/CaseFile"), Message = require("../models/Message"), User = require("../models/User"), AuditLog = require("../models/AuditLog");
const { decryptCaseFilePayload, decryptMessagePayload, decryptString } = require("../utils/dataEncryption");
const { HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createS3Client } = require("../utils/s3Client");
const { assertObjectMalwareSafe } = require("../utils/fileSecurity");
const { findActiveSession } = require("./authSessionService");
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, publicCode: code }); };
const ref = value => String(value?._id || value || "");
const valid = value => /^[a-f0-9]{24}$/i.test(String(value || ""));
async function current(req) {
  const actor = ref(req.user?.id), caseId = req.params.caseId, disputeId = req.params.disputeId;
  if (req.user?.role !== "admin") fail(403, "EVIDENCE_RESTRICTED", "Only an approved administrator may review dispute evidence.");
  if (![actor,caseId,disputeId].every(valid)) fail(400, "EVIDENCE_INVALID", "Invalid dispute.");
  const [user, matter] = await Promise.all([User.findById(actor).select("role status disabled deleted suspended authVersion").lean(), Case.findById(caseId).lean()]);
  if (!user || user.role !== "admin" || user.status !== "approved" || user.disabled || user.deleted || user.suspended || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0)
    || req.authSessionId && !await findActiveSession(req.authSessionId, actor)) fail(403, "EVIDENCE_RESTRICTED", "This administrator session can no longer review evidence.");
  const reviews = (matter?.disputes || []).filter(d => ref(d.disputeId || d._id) === disputeId && String(d.status || "open") === "open");
  if (!matter || matter.status !== "disputed" || matter.pausedReason !== "dispute" || reviews.length !== 1 || matter.purgedAt || matter.purgeScheduledFor && new Date(matter.purgeScheduledFor) <= new Date()) fail(409, "EVIDENCE_REVIEW_CHANGED", "Evidence review is available only for this Matter's open dispute.");
  const hiredAt = matter.hiredAt && new Date(matter.hiredAt);
  if (!hiredAt || !Number.isFinite(hiredAt.getTime()) || hiredAt > new Date()) fail(409, "EVIDENCE_ASSIGNMENT_UNVERIFIED", "The assignment date needs verification before confidential dispute evidence can be reviewed.");
  return matter;
}
function boundary(matter) { return { createdAt: { $gte: new Date(matter.hiredAt) } }; }
function safeKey(key, caseId) {
  if (typeof key !== "string" || !key.startsWith(`cases/${caseId}/documents/`) || key.split("/").some(s => !s || s === "." || s === "..") || /[\\\x00-\x1f\x7f]/.test(key)) fail(409, "EVIDENCE_SOURCE_INVALID", "The evidence document reference needs review.");
  return key;
}
async function read(req) {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const action = req.body?.action;
  if (reason.length < 20 || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) fail(400, "EVIDENCE_JUSTIFICATION_REQUIRED", "Explain why this evidence is needed for the open dispute (20–500 characters).");
  if (!["files","messages","preview"].includes(action)) fail(400, "EVIDENCE_INVALID", "Choose an evidence review action.");
  const matter = await current(req), caseId = ref(matter._id);
  const before = JSON.stringify([matter.status,matter.pausedReason,matter.disputes,matter.hiredAt,matter.purgedAt,matter.purgeScheduledFor]);
  const recheck = async () => { const value = await current(req); if (before !== JSON.stringify([value.status,value.pausedReason,value.disputes,value.hiredAt,value.purgedAt,value.purgeScheduledFor])) fail(409,"EVIDENCE_REVIEW_CHANGED","The dispute changed. Review it again before opening evidence."); };
  const fileId = req.body.fileId;
  if (action === "preview" && !valid(fileId)) fail(400,"EVIDENCE_INVALID","Choose a document from this dispute.");
  const cursor = req.body.before;
  if (cursor != null && !valid(cursor)) fail(400,"EVIDENCE_INVALID","Invalid evidence page.");
  // Each read is deliberately justified and logged before any content is projected or link issued.
  await AuditLog.logFromReq(req,"dispute.evidence.read", { targetType:"case",targetId:caseId,caseId:matter._id,meta:{disputeId:req.params.disputeId,purpose:"open_dispute_review",scope:action,reason,...(fileId ? {fileId}:{}),...(cursor ? {before:cursor}:{})} });
  if (action === "messages") {
    const rows = await Message.find({caseId:matter._id,deleted:{$ne:true},...boundary(matter),...(cursor ? {_id:{$lt:new mongoose.Types.ObjectId(cursor)}}:{})}).select("senderRole type text content transcript fileName createdAt").sort({_id:-1}).limit(51).lean();
    await recheck();
    const visible=rows.slice(0,50).map(row=>{const value=decryptMessagePayload(row);return {id:ref(value._id),senderRole:value.senderRole,type:value.type,text:value.text||value.content?.text||"",transcript:value.transcript||"",fileName:value.fileName||"",createdAt:value.createdAt};});
    return {messages:visible,nextBefore:rows.length>50 ? ref(rows[49]._id):null};
  }
  // Native reads preserve both retained ObjectId and legacy string references;
  // Mongoose query casting would collapse the string into an ObjectId.
  const query={caseId:{$in:[matter._id,caseId]},...boundary(matter),...(action==="preview" ? {_id:new mongoose.Types.ObjectId(fileId)} : cursor ? {_id:{$lt:new mongoose.Types.ObjectId(cursor)}} : {})};
  const projection={originalName:1,storageKey:1,mimeType:1,createdAt:1,replacedAt:1};
  const rows=await CaseFile.collection.find(query,{projection}).sort({_id:-1}).limit(action==="preview"?1:51).toArray();
  await recheck();
  if (action==="files") return {files:rows.slice(0,50).map(row=>({id:ref(row._id),name:decryptString(row.originalName),mimeType:row.mimeType,createdAt:row.createdAt,replaced:Boolean(row.replacedAt)})),nextBefore:rows.length>50?ref(rows[49]._id):null};
  if (!rows.length) fail(404,"EVIDENCE_NOT_FOUND","That document is not part of this Matter's reviewed assignment.");
  const file=decryptCaseFilePayload(rows[0]),key=safeKey(file.storageKey,caseId),bucket=String(process.env.S3_BUCKET||"").trim();
  if(!bucket)fail(503,"EVIDENCE_STORAGE_UNAVAILABLE","Evidence storage is unavailable.");
  const s3=createS3Client(),head=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}));
  const versionId=head.VersionId&&head.VersionId!=="null"?head.VersionId:undefined;
  const recheckFile = async () => {
    const latest = await CaseFile.collection.findOne(query,{projection});
    if (!latest || JSON.stringify(latest) !== JSON.stringify(rows[0])) fail(409,"EVIDENCE_SOURCE_CHANGED","The document changed. Review its evidence record again.");
  };
  await assertObjectMalwareSafe({s3,bucket,key,versionId}); await recheck(); await recheckFile();
  await AuditLog.logFromReq(req,"dispute.evidence.preview",{targetType:"case",targetId:caseId,caseId:matter._id,meta:{disputeId:req.params.disputeId,purpose:"open_dispute_review",fileId,objectFingerprint:createHash("sha256").update(key).digest("hex"),expiresIn:60}});
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket,Key:key,...(versionId?{VersionId:versionId}:{}),ResponseContentDisposition:"attachment",ResponseContentType:"application/octet-stream"}),{expiresIn:60});
  await recheck(); await recheckFile(); return {url,expiresIn:60};
}
module.exports={read,current};
