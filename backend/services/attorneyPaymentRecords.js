const { Types } = require("mongoose"), Case = require("../models/Case"), User = require("../models/User");
const account = require("./attorneyAccountBoundary"), { fingerprint } = require("./matterDraftRevision");
const valid = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value), id = value => String(value || ""), refs = value => [new Types.ObjectId(value), id(value)];
const fields = ["attorney", "attorneyId", "paralegal", "paralegalId", "paralegalNameSnapshot", "title", "status", "archived", "currency", "totalAmount", "lockedTotalAmount", "escrowIntentId", "paymentIntentId", "escrowStatus", "fundingIntegrityStatus", "fundingVerifiedAt", "paymentReleased", "paidOutAt", "payoutStatus", "withdrawnParalegalId", "withdrawalHistory", "payoutFinalizedAt", "payoutFinalizedType", "partialPayoutAmount", "remainingAmount", "disputeSettlement", "createdAt", "updatedAt"];
const projection = Object.fromEntries(fields.map(field => [field, 1]));
const fail = (status, suffix) => { throw Object.assign(new Error("Payment records could not be verified. Refresh Payments before continuing."), { status, publicCode: `WORKSPACE_PAYMENT_${suffix}` }); };
const money = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
function currency(value) {
  const code = value == null ? "USD" : typeof value === "string" ? value.toUpperCase() : "";
  try { return Intl.supportedValuesOf("currency").includes(code) && new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits === 2 ? code : null; } catch { return null; }
}
function validateOwner(doc, ownerId) {
  if (![doc.attorney, doc.attorneyId].some(value => id(value) === ownerId) || doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId)) fail(409, "OWNERSHIP_CHANGED");
  if (doc.paralegal && doc.paralegalId && id(doc.paralegal) !== id(doc.paralegalId)) fail(409, "ASSIGNMENT_CHANGED");
}
function shape(doc, names, ownerId) {
  validateOwner(doc, ownerId);
  const ids = [...new Set([doc.escrowIntentId, doc.paymentIntentId].filter(Boolean))], validIntent = ids.length === 1 && /^pi_[A-Za-z0-9_]{1,200}$/.test(ids[0]);
  const funding = doc.fundingIntegrityStatus === "failed" || ids.length > 1 || ids.length && !validIntent ? "needs_review" : doc.escrowStatus === "funded" ? validIntent ? "recorded" : "needs_review" : ids.length ? "unconfirmed" : "not_recorded";
  const release = ({ failed: "failed", reversed: "reversed", needs_reconciliation: "needs_review", pending: "pending" })[doc.payoutStatus] || (doc.paymentReleased === true ? "recorded" : "not_recorded");
  const personId = id(doc.paralegal || doc.paralegalId), name = names.get(personId) || (typeof doc.paralegalNameSnapshot === "string" ? doc.paralegalNameSnapshot : "");
  return { id: id(doc._id), title: typeof doc.title === "string" && doc.title ? doc.title : "Untitled Matter", matterStatus: typeof doc.status === "string" ? doc.status : "unknown", archived: doc.archived === true, paralegalName: name || "No paralegal name recorded", currency: currency(doc.currency), matterAmount: money(doc.lockedTotalAmount ?? doc.totalAmount), createdAt: date(doc.createdAt), updatedAt: date(doc.updatedAt), funding, fundingVerifiedAt: date(doc.fundingVerifiedAt), release, releasedAt: date(doc.paidOutAt), earlierWithdrawals: Array.isArray(doc.withdrawalHistory) ? doc.withdrawalHistory.length : 0, withdrawal: doc.withdrawnParalegalId && doc.payoutFinalizedAt ? { at: date(doc.payoutFinalizedAt), amount: money(doc.partialPayoutAmount), decision: ["zero_auto", "partial_attorney", "full", "admin", "expired_zero"].includes(doc.payoutFinalizedType) ? doc.payoutFinalizedType : "unknown" } : null };
}
async function read(req) {
  const query = req.query || {}, view = query.view || "all", q = query.q || "";
  if (Object.keys(query).some(key => !["expectedOwnerId", "view", "q", "cursor", "caseId"].includes(key)) || !["all", "unreleased", "released", "withdrawal"].includes(view) || typeof q !== "string" || q.length > 100 || /[\u0000-\u001f]/.test(q) || query.cursor !== undefined && !valid(query.cursor) || query.caseId !== undefined && !valid(query.caseId)) fail(400, "INVALID");
  const user = await account.read(req, query.expectedOwnerId), ownerId = id(user._id), owner = { $or: [{ attorney: { $in: refs(ownerId) } }, { attorneyId: { $in: refs(ownerId) } }] };
  const withdrawalFilter = { $or: [{ withdrawnParalegalId: { $exists: true, $ne: null } }, { "withdrawalHistory.0": { $exists: true } }] };
  const footprint = { $or: [{ escrowIntentId: { $type: "string", $ne: "" } }, { paymentIntentId: { $type: "string", $ne: "" } }, { escrowStatus: "funded" }, { paymentReleased: true }, { paralegal: { $exists: true, $ne: null } }, { paralegalId: { $exists: true, $ne: null } }, withdrawalFilter] };
  const filter = { $and: [owner, footprint, ...(view === "unreleased" ? [{ paymentReleased: { $ne: true } }] : view === "released" ? [{ paymentReleased: true }] : view === "withdrawal" ? [withdrawalFilter] : []), ...(q.trim() ? [{ title: { $regex: q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }] : [])] };
  const rowFilter = query.cursor ? { ...filter, _id: { $lt: new Types.ObjectId(query.cursor) } } : filter;
  const snapshot = async () => {
    const [rows, total, selected] = await Promise.all([Case.collection.find(rowFilter, { projection }).sort({ _id: -1 }).limit(51).toArray(), Case.collection.countDocuments(filter), query.caseId ? Case.collection.findOne({ ...owner, _id: new Types.ObjectId(query.caseId) }, { projection }) : null]);
    return { rows, total, selected };
  };
  const start = await snapshot(), visible = [...start.rows.slice(0, 50), ...(start.selected ? [start.selected] : [])];
  visible.forEach(doc => validateOwner(doc, ownerId));
  const peopleIds = [...new Set(visible.map(doc => id(doc.paralegal || doc.paralegalId)).filter(valid))];
  const people = await User.collection.find({ _id: { $in: peopleIds.map(value => new Types.ObjectId(value)) } }, { projection: { firstName: 1, lastName: 1 } }).toArray();
  const names = new Map(people.map(person => [id(person._id), [person.firstName, person.lastName].filter(value => typeof value === "string").join(" ").trim()]));
  const end = await snapshot(), current = await account.read(req, query.expectedOwnerId);
  if (fingerprint(start) !== fingerprint(end) || fingerprint(user) !== fingerprint(current)) fail(409, "CHANGED");
  return { ownerId, view, q, total: start.total, items: start.rows.slice(0, 50).map(doc => shape(doc, names, ownerId)), nextCursor: start.rows.length > 50 ? id(start.rows[49]._id) : null, selected: start.selected ? shape(start.selected, names, ownerId) : null, selection: !query.caseId ? "none" : start.selected ? "found" : "unavailable" };
}
module.exports = { read };
