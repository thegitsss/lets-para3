const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose");
const { randomUUID } = require("crypto");
const Case = require("../models/Case"), Job = require("../models/Job"), Application = require("../models/Application"), User = require("../models/User"), Block = require("../models/Block"), Decision = require("../models/ApplicationDecision");
const applications = require("./matterApplications");
const { fingerprint, requestIdValid } = require("./matterDraftRevision");
const { normalizeCaseStatus } = require("../utils/caseState");
const logger = require("../utils/logger").createLogger("application-decisions");
const AuditLog = require("../models/AuditLog");
const { notifyUser } = require("../utils/notifyUser");
const { id, refs, one } = require('./applicationIdentity');
const active = value => ["pending", "submitted", "viewed", "shortlisted"].includes(value);
const status = value => value === "pending" ? "submitted" : ["submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn"].includes(value) ? value : "unknown";
const fail = (httpStatus, suffix) => { throw Object.assign(new Error("The application decision could not be recorded."), { status: httpStatus, publicCode: `APPLICATION_REVIEW_DECISION_${suffix}` }); };
const actions = ["star", "unstar", "shortlist", "return", "reject"];
const requestFor = (req, legacy = false) => ({ ...req, params: { ...req.params, caseId: id(req.params.caseId), applicantId: id(req.params.applicantId || req.params.paralegalId) }, query: { expectedOwnerId: req.method === "GET" ? req.query.expectedOwnerId : legacy ? id(req.user.id) : req.body?.expectedOwnerId } });

async function snapshot(req, session) {
  const data = await applications.selectedRecords(req, session), { doc, record, mirror } = data;
  const profile = await one(User, req.params.applicantId, { role: 1, status: 1, disabled: 1, deleted: 1, firstName: 1, lastName: 1 }, session);
  const blockQuery = { active: { $ne: false }, $or: [{ blockerId: { $in: refs(doc.attorneyId || doc.attorney) }, blockedId: { $in: refs(req.params.applicantId) } }, { blockerId: { $in: refs(req.params.applicantId) }, blockedId: { $in: refs(doc.attorneyId || doc.attorney) } }] };
  const blocked = await Block.collection.findOne(blockQuery, { projection: { _id: 1 }, session });
  const starred = Array.isArray(record.starredBy) && record.starredBy.some(value => id(value) === id(req.user.id));
  const profileAvailable = profile && profile.role === 'paralegal' && profile.status === 'approved' && !profile.disabled && !profile.deleted;
  let reason = "ready";
  if (doc.archived || doc.readOnly || normalizeCaseStatus(doc.status) !== "open" || doc.relistPending || doc.paymentReleased || doc.escrowStatus === "funded") reason = "matter_closed";
  else if (doc.paralegal || doc.paralegalId || doc.hiredAt || doc.hiringClaimToken || doc.hiringClaimStatus || doc.hiringClaimParalegalId) reason = "hiring_started";
  else if (!active(record.status)) reason = "application_closed";
  else if (!profileAvailable) reason = "profile_unavailable";
  else if (blocked) reason = "blocked";
  else if (record.starredBy != null && !Array.isArray(record.starredBy) || mirror?.starredBy != null && !Array.isArray(mirror.starredBy)) reason = "records_differ";
  else if (data.applicationId && (!mirror || !applications.mirrorStatusMatches(record.status, mirror.status) || ["pending", "needs_reconciliation"].includes(record.syncStatus))) reason = "records_differ";
  else if (Array.isArray(doc.disputes) && doc.disputes.some(item => item.status === "open")) reason = "matter_closed";
  const revision = fingerprint([data.revision, profile, blocked]);
  const value = { caseId: id(doc._id), ownerId: id(req.user.id), applicantId: req.params.applicantId, applicationId: data.applicationId, caseTitle: doc.title || "Untitled Matter", name: profileAvailable && !blocked ? [profile.firstName, profile.lastName].filter(Boolean).join(" ") || "Paralegal applicant" : "Paralegal applicant", revision, status: status(record.status) || "unknown", starred, reason, actions: reason === "ready" ? [starred ? "unstar" : "star", ...(data.applicationId ? [record.status === "shortlisted" ? "return" : "shortlist"] : []), "reject"] : [] };
  return { ...data, profile, blocked, blockQuery, value };
}
async function requireDecisionIndexes() {
  await Decision.init();
  const indexes = await Decision.collection.listIndexes().toArray();
  if (!indexes.some(index => index.unique && JSON.stringify(index.key) === JSON.stringify({ ownerId: 1, requestId: 1 }))) fail(503, "UNAVAILABLE");
}
async function review(req) {
  if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  const bound = requestFor(req);
  await applications.owner(bound);
  await requireDecisionIndexes();
  const first = await snapshot(bound), latest = await snapshot(bound);
  if (first.value.revision !== latest.value.revision) fail(409, "CHANGED");
  return latest.value;
}
const receipt = record => record ? { requestId: record.requestId, caseId: id(record.caseId), ownerId: id(record.ownerId), applicantId: id(record.applicantId), applicationId: record.applicationId ? id(record.applicationId) : null, action: record.action, revision: record.revision, status: record.status, starred: record.starred, recordedAt: new Date(record.recordedAt).toISOString() } : null;
async function findReceipt(req) {
  if (!requestIdValid(req.params.requestId) || !/^[a-f0-9]{24}$/i.test(req.params.applicantId) || Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  const bound = requestFor(req); await applications.owner(bound);
  const record = await Decision.collection.findOne({ ownerId: new mongoose.Types.ObjectId(req.user.id), caseId: new mongoose.Types.ObjectId(req.params.caseId), applicantId: new mongoose.Types.ObjectId(req.params.applicantId), requestId: req.params.requestId });
  await applications.owner(bound); return { receipt: receipt(record) };
}
async function persist(req, { legacyAction } = {}) {
  const bound = requestFor(req, !!legacyAction), input = req.body || {};
  if (!legacyAction && (Object.keys(input).some(key => !["expectedOwnerId", "revision", "requestId", "action"].includes(key)) || !requestIdValid(input.requestId) || typeof input.revision !== "string" || !/^[a-f0-9]{64}$/.test(input.revision) || !actions.includes(input.action))) fail(400, "INVALID");
  await applications.owner(bound);
  await requireDecisionIndexes();
  const requestId = legacyAction ? randomUUID() : input.requestId;
  const session = await mongoose.startSession(); let result, dispatch, stage = "begin";
  try {
    // One attempt: a conflict requires a fresh attorney review. No fallback to
    // separate writes on standalone MongoDB, and no replay of side effects.
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    const existing = await Decision.collection.findOne({ ownerId: new mongoose.Types.ObjectId(req.user.id), requestId }, { session });
    if (existing) {
      if (id(existing.caseId) !== bound.params.caseId || id(existing.applicantId) !== bound.params.applicantId || existing.action !== input.action || existing.revision !== input.revision) fail(409, "REQUEST_REUSED");
      await session.abortTransaction(); return { receipt: receipt(existing), repeated: true };
    }
    stage = "review";
    const data = await snapshot(bound, session), value = data.value;
    const action = legacyAction === "star" ? (typeof input.starred === "boolean" ? input.starred ? "star" : "unstar" : value.starred ? "unstar" : "star") : legacyAction || input.action;
    stage = "review_revision";
    if (!legacyAction && input.revision !== value.revision) fail(409, "CHANGED");
    if (value.reason !== "ready") fail(409, "INELIGIBLE");
    if (!value.actions.includes(action)) {
      if (!legacyAction || !["star", "unstar"].includes(action)) fail(409, "CHANGED");
    }
    const now = new Date(), nextStatus = ({ shortlist: "shortlisted", return: "submitted", reject: "rejected" })[action] || value.status;
    const starred = action === "star" ? true : action === "unstar" ? false : value.starred;
    const starOperation = action === "star" ? "$addToSet" : action === "unstar" ? "$pull" : null;
    if (data.applicationId) {
      stage = "application_write";
      const update = { $set: { status: nextStatus, updatedAt: now, syncStatus: "synced", syncedAt: now, syncError: "" } };
      if (starOperation && !(action === "star" && value.starred)) update[starOperation] = { starredBy: starOperation === "$pull" ? { $in: refs(req.user.id) } : new mongoose.Types.ObjectId(req.user.id) };
      if (nextStatus !== value.status) update.$push = { statusHistory: { $each: [{ from: value.status, to: nextStatus, reason: "attorney_decision", actorId: new mongoose.Types.ObjectId(req.user.id), at: now }], $slice: -50 } };
      const changed = await Application.collection.updateOne({ _id: data.record._id, status: data.record.status }, update, { session });
      if (changed.matchedCount !== 1) fail(409, "CHANGED");
    }
    // Update only decision fields on the existing mirror; preserve unknown,
    // snapshot and unrelated applicant data rather than rebuilding its array.
    stage = "matter_write";
    const caseUpdate = { $set: { "applicants.$.status": active(nextStatus) ? "pending" : nextStatus, updatedAt: now }, $inc: { __v: 1 } };
    if (starOperation && !(action === "star" && data.mirror?.starredBy?.some(value => id(value) === id(req.user.id)))) caseUpdate[starOperation] = { "applicants.$.starredBy": starOperation === "$pull" ? { $in: refs(req.user.id) } : new mongoose.Types.ObjectId(req.user.id) };
    const changed = await Case.collection.updateOne({ _id: data.doc._id, "applicants.paralegalId": { $in: refs(bound.params.applicantId) } }, caseUpdate, { session });
    if (changed.matchedCount !== 1) fail(409, "CHANGED");
    if (data.job && data.applicationId) {
      stage = "application_count";
      const count = await Application.collection.countDocuments({ jobId: { $in: refs(data.job._id) }, status: { $nin: ["accepted", "rejected", "withdrawn"] } }, { session });
      await Job.collection.updateOne({ _id: data.job._id }, { $set: { applicantsCount: count, updatedAt: now } }, { session });
    }
    const saved = { ownerId: new mongoose.Types.ObjectId(req.user.id), caseId: data.doc._id, applicantId: new mongoose.Types.ObjectId(bound.params.applicantId), applicationId: data.applicationId ? data.record._id : null, requestId, revision: value.revision, action, status: nextStatus, starred, recordedAt: now };
    stage = "acknowledgement";
    await Decision.collection.insertOne(saved, { session });
    if (action === "reject") {
      stage = "rejection_audit";
      await AuditLog.logFromReq(req, "case.applicant.rejected", {
        targetType: "case", targetId: data.doc._id, caseId: data.doc._id,
        meta: { paralegalId: bound.params.applicantId, requestId }, session,
      });
      stage = "rejection_notice";
      // Nonselection retains its existing in-app-only policy. The decision
      // and applicant notice must either both commit or both remain absent.
      dispatch = await notifyUser(bound.params.applicantId, "application_denied", {
        caseId: data.doc._id, caseTitle: data.doc.title || "Untitled Matter",
        link: "dashboard-paralegal.html", outcome: "not_selected",
      }, { actorUserId: req.user.id, session, deferDispatch: true });
      if (typeof dispatch !== "function") fail(503, "UNCONFIRMED");
    }
    // This read is outside the transaction's snapshot so logout and account
    // revocation during the database work are not hidden by an older user read.
    stage = "account_check";
    await applications.owner(bound);
    const currentProfile = await one(User, data.profile._id, { role: 1, status: 1, disabled: 1, deleted: 1, firstName: 1, lastName: 1 });
    if (fingerprint(currentProfile) !== fingerprint(data.profile)) fail(409, "CHANGED");
    if (await Block.collection.findOne(data.blockQuery)) fail(409, "INELIGIBLE");
    stage = "commit";
    await session.commitTransaction(); result = { receipt: receipt(saved), doc: data.doc, repeated: false };
  } catch (error) {
    logger.warn("decision could not commit", { stage, code: error.publicCode || error.code || error.name, ...(error.codeName ? { databaseCode: error.codeName } : {}) });
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.applicationDecisions.transaction_abort"));
    if (error.publicCode) throw error;
    if (error.code === 112 || error.code === 11000 || error.hasErrorLabel?.("TransientTransactionError")) fail(409, "CHANGED");
    fail(503, "UNCONFIRMED");
  } finally { await session.endSession(); }
  if (dispatch) await dispatch().catch(reportOperationalFailure("services.applicationDecisions.notice_dispatch"));
  return result;
}
module.exports = { review, persist, findReceipt };
