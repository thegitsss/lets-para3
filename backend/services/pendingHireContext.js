const { Types } = require("mongoose");
const User = require("../models/User");
const account = require("./attorneyAccountBoundary");
const applications = require("./matterApplications");
const { isBlockedBetween } = require("../utils/blocks");
const { fingerprint } = require("./matterDraftRevision");
const { normalizeCaseStatus } = require("../utils/caseState");
const id = value => String(value?._id || value || "");
const valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const fail = (status, suffix) => { throw Object.assign(new Error("The saved hiring return could not be verified."), { status, publicCode: `PAYMENT_SETUP_${suffix}` }); };
async function snapshot(req, expectedOwnerId) { const user = await account.read(req, expectedOwnerId, ["pendingHire"]); return { user, revision: fingerprint(user) }; }
async function selection(req, caseId, paralegalId, ownerId) {
  if (!valid(caseId) || !valid(paralegalId)) fail(400, "INVALID");
  const selected = await applications.selectedRecords({ ...req, params: { ...req.params, caseId, applicantId: paralegalId }, query: { expectedOwnerId: ownerId } });
  if (!["open", "paused"].includes(normalizeCaseStatus(selected.doc.status)) || selected.doc.hiringClaimToken || selected.doc.hiringClaimStatus) fail(409, "APPLICATION_UNAVAILABLE");
  const profile = await User.collection.findOne({ _id: new Types.ObjectId(paralegalId) }, { projection: { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1 } });
  if (!selected.mirror || !["pending", "submitted", "viewed", "shortlisted", "accepted"].includes(selected.record.status) || selected.applicationId && (!applications.mirrorStatusMatches(selected.record.status, selected.mirror.status) || ["pending", "needs_reconciliation"].includes(selected.record.syncStatus)) || selected.doc.archived || selected.doc.readOnly || selected.doc.paralegal || selected.doc.paralegalId || selected.doc.paymentReleased || !profile || profile.role !== "paralegal" || profile.status !== "approved" || profile.disabled || profile.deleted || await isBlockedBetween(ownerId, paralegalId)) fail(409, "APPLICATION_UNAVAILABLE");
  return { caseId, paralegalId, caseTitle: typeof selected.doc.title === "string" ? selected.doc.title : "Untitled Matter", paralegalName: [profile.firstName, profile.lastName].filter(value => typeof value === "string").join(" ") || "Paralegal applicant" };
}
async function shape(req, value) {
  const ownerId = id(value.user._id), stored = value.user.pendingHire;
  if (!stored) return { ownerId, revision: value.revision, pending: null };
  const caseId = id(stored.caseId), paralegalId = id(stored.paralegalId);
  const updatedAt = stored.updatedAt && Number.isFinite(new Date(stored.updatedAt).getTime()) ? new Date(stored.updatedAt).toISOString() : null;
  if (!valid(caseId) || !valid(paralegalId)) return { ownerId, revision: value.revision, pending: { state: "earlier", caseId: valid(caseId) ? caseId : null, paralegalId: null, updatedAt } };
  try { return { ownerId, revision: value.revision, pending: { state: "available", ...await selection(req, caseId, paralegalId, ownerId), updatedAt } }; }
  catch (error) {
    if ([400, 404, 409].includes(error.status)) return { ownerId, revision: value.revision, pending: { state: "unavailable", caseId, paralegalId, updatedAt } };
    throw error;
  }
}
async function read(req) {
  if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  const first = await snapshot(req, req.query.expectedOwnerId), value = await shape(req, first), latest = await snapshot(req, req.query.expectedOwnerId);
  if (first.revision !== latest.revision) fail(409, "CHANGED");
  if (fingerprint(value.pending) !== fingerprint((await shape(req, latest)).pending) || (await snapshot(req, req.query.expectedOwnerId)).revision !== first.revision) fail(409, "CHANGED");
  return value;
}
async function change(req, clear = false) {
  if (Object.keys(req.body || {}).some(key => !["caseId", "paralegalId", "reviewedRevision", "expectedOwnerId"].includes(key)) || typeof req.body?.reviewedRevision !== "string" || !/^[a-f0-9]{64}$/.test(req.body.reviewedRevision)) fail(400, "INVALID");
  const ownerId = req.body.expectedOwnerId, initial = await snapshot(req, ownerId);
  if (initial.revision !== req.body.reviewedRevision) fail(409, "CHANGED");
  let next = null;
  if (!clear) {
    const selected = await selection(req, req.body.caseId, req.body.paralegalId, ownerId);
    const previous = initial.user.pendingHire && typeof initial.user.pendingHire === "object" && !Array.isArray(initial.user.pendingHire) ? initial.user.pendingHire : {};
    next = { ...previous, caseId: new Types.ObjectId(selected.caseId), paralegalId: new Types.ObjectId(selected.paralegalId), paralegalName: selected.paralegalName, fundUrl: `/attorney-v2.html#/matters/${selected.caseId}/applications?applicantId=${selected.paralegalId}`, message: "Return to the selected application after card setup.", updatedAt: new Date() };
  }
  const latest = await snapshot(req, ownerId); if (latest.revision !== initial.revision) fail(409, "CHANGED");
  const filter = { _id: initial.user._id, ...Object.fromEntries(["role", "status", "disabled", "deleted", "authVersion", "pendingHire"].map(key => [key, initial.user[key] === undefined ? { $exists: false } : { $eq: initial.user[key] }])) };
  const result = await User.collection.updateOne(filter, { $set: { pendingHire: next, updatedAt: new Date() } });
  if (!result.matchedCount) fail(409, "CHANGED");
  await account.read(req, ownerId);
  return { saved: true, ownerId, caseId: clear ? null : req.body.caseId, paralegalId: clear ? null : req.body.paralegalId, cleared: clear };
}
module.exports = { read, change };
