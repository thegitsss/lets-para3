const { Types } = require("mongoose");
const Case = require("../models/Case"), User = require("../models/User"), Block = require("../models/Block");
const { fingerprint } = require("./matterDraftRevision");
const { normalizeCaseStatus } = require("../utils/caseState");
const { findActiveSession } = require("./authSessionService");
const { evaluateInvitationEligibility } = require("./attorneyWorkflowPolicy");
const { invitationRecords } = require("./matterInvitations");
const id = value => String(value?._id || value || "");
const valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const refs = value => [new Types.ObjectId(id(value)), id(value)];
const fields = "attorney attorneyId title status archived readOnly paralegal paralegalId hiredAt hiringClaimToken hiringClaimStatus paymentReleased pausedReason payoutFinalizedAt remainingAmount totalAmount lockedTotalAmount amountLockedAt currency requirements invites pendingParalegalId pendingParalegalInvitedAt __v".split(" ");
const projection = Object.fromEntries(fields.map(field => [field, 1]));
const fail = (status, suffix) => { throw Object.assign(new Error("The invitation could not be verified."), { status, publicCode: `INVITATION_${suffix}` }); };
const ownerFilter = ownerId => ({ $or: [{ attorney: { $in: refs(ownerId) } }, { attorneyId: { $in: refs(ownerId) } }] });
async function account(req) {
  const ownerId = id(req.user?.id);
  if (req.user?.role !== "attorney") fail(403, "RESTRICTED");
  if (!valid(ownerId) || req.query.expectedOwnerId !== ownerId) fail(403, "ACCOUNT_CHANGED");
  const user = await User.collection.findOne({ _id: new Types.ObjectId(ownerId) }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!user || user.role !== "attorney" || user.status !== "approved" || user.disabled || user.deleted || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, ownerId)) fail(403, "ACCOUNT_CHANGED");
  return user;
}
function coherentOwner(doc) { if (doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId)) fail(409, "SOURCE_INVALID"); }
async function snapshot(req, bypassEmails = new Set()) {
  if (!valid(req.params.caseId) || !valid(req.params.paralegalId)) fail(400, "INVALID");
  const user = await account(req), ownerId = id(user._id), paralegalId = req.params.paralegalId;
  const facts = await Case.collection.findOne({ _id: new Types.ObjectId(req.params.caseId), ...ownerFilter(ownerId) }, { projection });
  if (!facts) fail(404, "NOT_FOUND"); coherentOwner(facts);
  const profile = await User.collection.findOne({ _id: new Types.ObjectId(paralegalId) }, { projection: { firstName: 1, lastName: 1, role: 1, status: 1, disabled: 1, deleted: 1, email: 1, stripeAccountId: 1, stripeOnboarded: 1, stripePayoutsEnabled: 1, availability: 1 } });
  const block = await Block.collection.findOne({ active: { $ne: false }, $or: [{ blockerId: { $in: refs(ownerId) }, blockedId: { $in: refs(paralegalId) } }, { blockerId: { $in: refs(paralegalId) }, blockedId: { $in: refs(ownerId) } }] }, { projection: { _id: 1 } });
  const available = !!profile && profile.role === "paralegal" && profile.status === "approved" && !profile.disabled && !profile.deleted;
  const records = invitationRecords(facts), target = records.records.filter(item => item.paralegalId === paralegalId), existing = target[0] || null;
  const bypass = bypassEmails.has(String(profile?.email || "").trim().toLowerCase());
  const policy = evaluateInvitationEligibility({ caseDoc: facts, ownerAuthorized: true, targetSelected: true, paralegalApproved: available, payoutSetupReady: bypass || !!(profile?.stripeAccountId && profile.stripeOnboarded && profile.stripePayoutsEnabled), partiesBlocked: !!block, existingInviteStatus: existing?.status || "" });
  const amount = facts.lockedTotalAmount ?? facts.totalAmount, currency = typeof facts.currency === "string" ? facts.currency.toLowerCase() : "usd";
  const relisted = normalizeCaseStatus(facts.status) === "paused" && facts.pausedReason === "paralegal_withdrew" && !!facts.payoutFinalizedAt;
  let reason = block ? "blocked" : !available ? "profile_unavailable" : policy.blockers.includes("paralegal_payout_setup_required") ? "payout_setup" : !records.complete || records.records.length !== new Set(records.records.map(item => item.paralegalId)).size || target.some(item => item.status === "unknown") ? "records_unavailable" : existing?.status === "pending" ? "pending" : existing?.status === "accepted" ? "accepted" : !policy.ready || facts.readOnly || facts.paymentReleased || facts.hiringClaimToken || facts.hiringClaimStatus ? "matter_unavailable" : !Number.isSafeInteger(amount) || amount < 0 || !/^[a-z]{3}$/.test(currency) || facts.__v != null && (!Number.isSafeInteger(facts.__v) || facts.__v < 0) ? "amount_unavailable" : "ready";
  const excluded=await require("../models/MatterRequirementDecision").exists({matterKey:id(facts._id),paralegalId});
  if(excluded)reason="requirements_not_met";
  const revision = fingerprint([user, facts, profile, block, Boolean(excluded)]);
  const dto = { requirements: Array.isArray(facts.requirements)?facts.requirements:[], ownerId, caseId: id(facts._id), paralegalId, caseTitle: typeof facts.title === "string" ? facts.title : "Untitled Matter", name: available && !block ? [profile.firstName, profile.lastName].filter(value => typeof value === "string").join(" ") || "Paralegal" : "Paralegal", revision, reason, canInvite: reason === "ready", amountCents: Number.isSafeInteger(amount) && amount >= 0 ? amount : null, currency: /^[a-z]{3}$/.test(currency) ? currency : null, amountLocked: facts.lockedTotalAmount != null, invitation: existing ? { status: existing.status, invitedAt: existing.invitedAt, respondedAt: existing.respondedAt } : null };
  if ((facts.invites || []).some(invite => id(invite.paralegalId) === paralegalId && ["pending", "needs_reconciliation"].includes(invite.syncStatus))) { dto.canInvite = false; dto.reason = "records_unavailable"; }
  dto.relisted = relisted; dto.remainingCents = relisted && Number.isSafeInteger(facts.remainingAmount) && facts.remainingAmount >= 0 ? facts.remainingAmount : null;
  if (dto.canInvite && relisted && (!Number.isSafeInteger(dto.remainingCents) || dto.remainingCents <= 0)) { dto.canInvite = false; dto.reason = "amount_unavailable"; }
  return { dto, facts, filter: { _id: facts._id, ...Object.fromEntries(fields.map(field => [field, facts[field] === undefined ? { $exists: false } : { $eq: facts[field] }])) } };
}
async function reviewedSnapshot(req, bypassEmails) {
  if (Object.keys(req.query).some(key => key !== "expectedOwnerId")) fail(400, "INVALID");
  const first = await snapshot(req, bypassEmails), latest = await snapshot(req, bypassEmails);
  if (first.dto.revision !== latest.dto.revision) fail(409, "CHANGED");
  return latest;
}
async function read(req, bypassEmails) { return (await reviewedSnapshot(req, bypassEmails)).dto; }
async function reviewed(req, paralegalId, bypassEmails) {
  if (typeof req.body?.reviewedRevision !== "string" || !/^[a-f0-9]{64}$/.test(req.body.reviewedRevision)) fail(400, "INVALID");
  const value = await reviewedSnapshot({ ...req, params: { ...req.params, paralegalId: id(paralegalId) }, query: { expectedOwnerId: req.body.expectedOwnerId } }, bypassEmails);
  if (value.dto.revision !== req.body.reviewedRevision) fail(409, "CHANGED");
  if (!value.dto.canInvite) fail(409, "INELIGIBLE");
  return value;
}
async function commit(review, paralegalId, invitedAt, { session = null } = {}) {
  if (review.dto.paralegalId !== id(paralegalId) || !review.dto.canInvite) fail(409, "CHANGED");
  const { facts } = review, invites = (facts.invites || []).map(item => ({ ...item }));
  // Preserve a pending invitation held only in the earlier single-invite fields.
  // Keep its recorded date, including null; sending another invite cannot erase it.
  if (facts.pendingParalegalId && !invites.some(item => id(item.paralegalId) === id(facts.pendingParalegalId))) invites.push({ paralegalId: facts.pendingParalegalId, status: "pending", invitedAt: facts.pendingParalegalInvitedAt || null, respondedAt: null });
  const index = invites.findIndex(item => id(item.paralegalId) === id(paralegalId));
  const invite = { ...(index >= 0 ? invites[index] : {}), paralegalId: index >= 0 ? invites[index].paralegalId : new Types.ObjectId(id(paralegalId)), status: "pending", invitedAt, respondedAt: null, syncStatus: "synced", syncedAt: invitedAt, syncError: "" };
  if (index >= 0) invites[index] = invite; else invites.push(invite);
  const set = { invites, pendingParalegalId: new Types.ObjectId(id(paralegalId)), pendingParalegalInvitedAt: invitedAt, updatedAt: new Date(), ...(facts.lockedTotalAmount == null ? { lockedTotalAmount: facts.totalAmount, amountLockedAt: invitedAt } : {}) };
  const result = await Case.collection.updateOne(review.filter, { $set: set, $inc: { __v: 1 } }, ...(session ? [{ session }] : []));
  return result.modifiedCount ? { sent: true, lockedNow: facts.lockedTotalAmount == null, confirmation: { paralegalId: id(paralegalId), reviewedRevision: review.dto.revision, invitedAt: invitedAt.toISOString(), amountCents: review.dto.amountCents } } : { sent: false, reason: "conflict" };
}
async function options(req) {
  if (!valid(req.params.paralegalId) || Object.keys(req.query).some(key => !["expectedOwnerId", "cursor", "q"].includes(key)) || req.query.cursor && !valid(req.query.cursor)) fail(400, "INVALID");
  if (req.query.q !== undefined && (typeof req.query.q !== "string" || req.query.q.length > 200)) fail(400, "INVALID");
  const user = await account(req), cursor = req.query.cursor || "", search = (req.query.q || "").trim();
  const literal = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const status = { $toLower: { $trim: { input: { $convert: { input: "$status", to: "string", onError: "", onNull: "" } } } } };
  const candidate = { $or: [
    { $expr: { $in: [status, ["open", "assigned", "awaiting_funding"]] } },
    { $expr: { $eq: [status, "paused"] }, pausedReason: "paralegal_withdrew", payoutFinalizedAt: { $ne: null }, remainingAmount: { $gt: 0 } },
  ] };
  const filter = { $and: [ownerFilter(id(user._id)), candidate], archived: { $ne: true }, readOnly: { $ne: true }, paymentReleased: { $ne: true }, paralegal: { $in: [null, ""] }, paralegalId: { $in: [null, ""] }, hiringClaimToken: { $in: [null, ""] }, hiringClaimStatus: { $in: [null, ""] }, ...(search ? { title: { $regex: literal, $options: "i" } } : {}), ...(cursor ? { _id: { $lt: new Types.ObjectId(cursor) } } : {}) };
  const docs = await Case.collection.find(filter, { projection: { attorney: 1, attorneyId: 1, title: 1, status: 1 } }).sort({ _id: -1 }).limit(26).toArray(); docs.forEach(coherentOwner);
  if (fingerprint(user) !== fingerprint(await account(req))) fail(403, "ACCOUNT_CHANGED");
  const repeated = await Case.collection.find(filter, { projection: { attorney: 1, attorneyId: 1, title: 1, status: 1 } }).sort({ _id: -1 }).limit(26).toArray();
  if (fingerprint(docs) !== fingerprint(repeated)) fail(409, "CHANGED");
  if (fingerprint(user) !== fingerprint(await account(req))) fail(403, "ACCOUNT_CHANGED");
  return { ownerId: id(user._id), paralegalId: req.params.paralegalId, search, cursor, next: docs.length > 25 ? id(docs[24]._id) : null, matters: docs.slice(0, 25).map(doc => ({ caseId: id(doc._id), title: typeof doc.title === "string" ? doc.title : "Untitled Matter" })) };
}
module.exports = { read, reviewed, commit, options };
