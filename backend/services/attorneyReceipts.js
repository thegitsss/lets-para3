const { Types } = require("mongoose");
const Case = require("../models/Case");
const User = require("../models/User");
const financial = require("./attorneyFinancialHistory");
const { findActiveSession } = require("./authSessionService");
const { expectedCaseFunding } = require("../utils/paymentIntegrity");
const { fingerprint } = require("./matterDraftRevision");
const history = require("./attorneyReceiptHistory");

const validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const money = value => Number.isSafeInteger(value) && value >= 0;
const processorId = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[a-zA-Z0-9_]{1,200}$`).test(value);
const ref = value => String(value?._id || value?.id || value || "");
const refs = value => [new Types.ObjectId(value), value];
const fields = ["attorney", "attorneyId", "title", "attorneyNameSnapshot", "currency", "totalAmount", "lockedTotalAmount", "feeAttorneyPct", "feeAttorneyAmount", "paymentIntentId", "escrowIntentId", "escrowStatus", "fundingIntegrityStatus", "paymentReleased", "stripeMode", "withdrawnParalegalId", "payoutFinalizedAt", "payoutFinalizedType", "partialPayoutAmount", "payoutTransferId", "pausedAt", "withdrawalHistory"];
const projection = Object.fromEntries(fields.map(field => [field, 1]));
const options = { timeout: 10000, maxNetworkRetries: 0 };
const fail = (status, publicCode, message) => { throw Object.assign(new Error(message), { status, publicCode }); };
const reviewNeeded = () => { throw Object.assign(new Error("Receipt evidence needs review"), { receiptReview: true }); };
const requireEvidence = condition => { if (!condition) reviewNeeded(); };
const active = req => { if (req.receiptSignal?.aborted) fail(499, "RECEIPT_CANCELED", "Receipt download canceled."); };
const date = value => {
  if (!value) return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
};
function currencyFor(doc) {
  const currency = doc.currency === undefined || doc.currency === null ? "USD" : String(doc.currency).toUpperCase();
  requireEvidence(/^[A-Z]{3}$/.test(currency));
  // These Matter amounts use cents. Do not silently reinterpret zero/three-decimal currencies.
  try { requireEvidence(Intl.supportedValuesOf("currency").includes(currency) && new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits === 2); }
  catch { reviewNeeded(); }
  return currency;
}
function filename(title, type) {
  const name = String(title || "Matter").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-").replace(/^\.+/, "").trim().slice(0, 100) || "Matter";
  return `${name}-${type === "withdrawal" ? "withdrawal" : "payment"}-receipt.pdf`;
}
async function owner(req, requireExpectedOwner) {
  active(req);
  const actorId = String(req.user?.id || ""), caseId = req.params.caseId;
  if (req.user?.role !== "attorney") fail(403, "RECEIPT_RESTRICTED", "Only the Matter attorney can access this receipt.");
  if ((requireExpectedOwner || req.query.expectedOwnerId !== undefined) && req.query.expectedOwnerId !== actorId) fail(403, "RECEIPT_ACCOUNT_CHANGED", "The signed-in account changed. Sign in again before opening receipts.");
  if (!validId(caseId) || !validId(actorId)) fail(400, "RECEIPT_INVALID", "Invalid Matter.");
  const user = await User.collection.findOne({ _id: new Types.ObjectId(actorId) }, { projection: { firstName: 1, lastName: 1, stripeCustomerId: 1, role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!user || user.disabled || user.deleted || user.role !== "attorney" || String(user.status).toLowerCase() !== "approved" || Number(user.authVersion || 0) !== Number(req.auth?.payload?.av || 0)) fail(403, "RECEIPT_ACCOUNT_CHANGED", "This account can no longer access receipts.");
  if (req.authSessionId && !await findActiveSession(req.authSessionId, actorId)) fail(403, "RECEIPT_ACCOUNT_CHANGED", "Your session ended. Sign in again before opening receipts.");
  const doc = await Case.collection.findOne({ _id: new Types.ObjectId(caseId), $or: [{ attorney: { $in: refs(actorId) } }, { attorneyId: { $in: refs(actorId) } }] }, { projection });
  if (!doc) fail(404, "RECEIPT_NOT_FOUND", "This Matter is no longer available.");
  if (doc.attorney && doc.attorneyId && ref(doc.attorney) !== ref(doc.attorneyId)) fail(403, "RECEIPT_RESTRICTED", "This Matter's ownership needs review.");
  return { doc, user, revision: fingerprint([fields.map(field => doc[field]), user]) };
}
async function refundsFor(stripe, intent, charge, req) {
  const records = [], seen = new Set(); let cursor;
  for (let page = 0; page < 10; page++) {
    active(req);
    const response = await stripe.refunds.list({ payment_intent: intent.id, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, options);
    requireEvidence(Array.isArray(response?.data) && response.data.length <= 100 && typeof response.has_more === "boolean");
    for (const item of response.data) {
      requireEvidence(processorId(item?.id, "re") && !seen.has(item.id) && ref(item.payment_intent) === intent.id && ref(item.charge) === charge.id && item.currency === intent.currency && money(item.amount) && item.amount > 0 && ["succeeded", "pending", "requires_action", "failed", "canceled"].includes(item.status));
      seen.add(item.id); records.push({ id: item.id, amount: item.amount, status: item.status });
    }
    if (!response.has_more) return records.sort((a, b) => a.id.localeCompare(b.id));
    requireEvidence(response.data.length > 0); cursor = response.data.at(-1).id;
  }
  reviewNeeded();
}
async function recoveredDisputesFor(stripe, intent, charge, doc, req) {
  if (charge.disputed === false) return [];
  requireEvidence(charge.disputed === true);
  const records = [], seen = new Set(), balanceIds = new Set(); let cursor;
  for (let page = 0; page < 10; page++) {
    active(req);
    const response = await stripe.disputes.list({ charge: charge.id, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, options);
    requireEvidence(Array.isArray(response?.data) && response.data.length <= 100 && typeof response.has_more === "boolean");
    for (const dispute of response.data) {
      requireEvidence((processorId(dispute?.id, "dp") || processorId(dispute?.id, "du")) && !seen.has(dispute.id) && dispute.object === "dispute" && ref(dispute.charge) === charge.id && (!dispute.payment_intent || ref(dispute.payment_intent) === intent.id) && dispute.currency === intent.currency && dispute.livemode === intent.livemode && money(dispute.amount) && dispute.amount > 0 && dispute.amount <= intent.amount_received && ["won", "warning_closed", "prevented"].includes(dispute.status));
      if (dispute.metadata?.caseId) requireEvidence(dispute.metadata.caseId === String(doc._id));
      if (dispute.metadata?.attorneyId) requireEvidence(dispute.metadata.attorneyId === ref(doc.attorney || doc.attorneyId));
      requireEvidence(Array.isArray(dispute.balance_transactions) && dispute.balance_transactions.length <= 4000);
      seen.add(dispute.id);
      let debited = 0, credited = 0;
      const balances = [];
      for (const transaction of dispute.balance_transactions) {
        requireEvidence(balanceIds.size < 4000 && processorId(transaction?.id, "txn") && !balanceIds.has(transaction.id) && transaction.object === "balance_transaction" && ref(transaction.source) === dispute.id && transaction.currency === intent.currency && Number.isSafeInteger(transaction.amount) && Number.isSafeInteger(transaction.fee) && Number.isSafeInteger(transaction.net) && transaction.amount - transaction.fee === transaction.net);
        balanceIds.add(transaction.id);
        const category = String(transaction.reporting_category || transaction.type || "").toLowerCase();
        requireEvidence(category.includes("fee") || ["dispute", "dispute_reversal", "adjustment"].includes(category));
        if (!category.includes("fee")) {
          if (transaction.amount < 0) debited -= transaction.amount;
          else credited += transaction.amount;
        }
        balances.push({ id: transaction.id, amount: transaction.amount, fee: transaction.fee, net: transaction.net, category });
      }
      // The charge flag records dispute history. A won status alone does not
      // establish that withdrawn principal has returned; verify the balance
      // records as well. Processor fees do not change the customer's receipt.
      requireEvidence(money(debited) && money(credited) && credited === debited && (dispute.status !== "won" || debited === dispute.amount));
      records.push({ id: dispute.id, status: dispute.status, amount: dispute.amount, balances: balances.sort((a, b) => a.id.localeCompare(b.id)) });
    }
    if (!response.has_more) { requireEvidence(records.length > 0); return records.sort((a, b) => a.id.localeCompare(b.id)); }
    requireEvidence(response.data.length > 0); cursor = response.data.at(-1).id;
  }
  reviewNeeded();
}
async function payment(doc, user, stripe, req) {
  const ids = [...new Set([doc.paymentIntentId, doc.escrowIntentId].filter(Boolean))];
  if (!ids.length) return { reason: doc.escrowStatus === "funded" || doc.paymentReleased || doc.fundingIntegrityStatus === "verified" ? "needs_review" : "not_funded" };
  requireEvidence(ids.length === 1 && processorId(ids[0], "pi") && doc.fundingIntegrityStatus !== "failed");
  const currency = currencyFor(doc), expected = expectedCaseFunding(doc);
  requireEvidence(money(expected.baseAmount) && expected.baseAmount > 0 && money(expected.feeAmount) && money(expected.totalAmount));
  for (const field of ["totalAmount", "lockedTotalAmount", "feeAttorneyAmount"]) if (doc[field] != null) requireEvidence(money(doc[field]));
  if (doc.feeAttorneyPct != null) requireEvidence(typeof doc.feeAttorneyPct === "number" && Number.isFinite(doc.feeAttorneyPct) && doc.feeAttorneyPct >= 0 && doc.feeAttorneyPct <= 100);
  const duplicate = await Case.collection.findOne({ _id: { $ne: doc._id }, $or: [{ paymentIntentId: ids[0] }, { escrowIntentId: ids[0] }] }, { projection: { _id: 1 } });
  requireEvidence(!duplicate);
  const intent = await stripe.paymentIntents.retrieve(ids[0], { expand: ["latest_charge", "payment_method"] }, options);
  active(req);
  requireEvidence(intent?.id === ids[0] && intent.currency === currency.toLowerCase() && typeof intent.livemode === "boolean");
  if (intent.metadata?.caseId) requireEvidence(intent.metadata.caseId === String(doc._id));
  if (intent.metadata?.attorneyId) requireEvidence(intent.metadata.attorneyId === String(user._id));
  if (intent.transfer_group) requireEvidence(intent.transfer_group === `case_${doc._id}`);
  if (intent.customer && user.stripeCustomerId) requireEvidence(ref(intent.customer) === user.stripeCustomerId);
  if (["live", "test"].includes(doc.stripeMode)) requireEvidence(intent.livemode === (doc.stripeMode === "live"));
  if (intent.status === "canceled") return { reason: "payment_canceled" };
  if (intent.status === "requires_payment_method") return { reason: intent.last_payment_error ? "payment_failed" : "not_funded" };
  if (["processing", "requires_action", "requires_confirmation", "requires_capture"].includes(intent.status)) return { reason: "payment_pending" };
  requireEvidence(intent.status === "succeeded" && money(intent.amount_received) && intent.amount_received === expected.totalAmount);
  const charge = intent.latest_charge;
  requireEvidence(processorId(charge?.id, "ch") && ref(charge.payment_intent) === intent.id && charge.currency === intent.currency && charge.paid === true && charge.captured === true && charge.amount_captured === intent.amount_received && money(charge.amount_refunded) && charge.amount_refunded <= intent.amount_received);
  const disputes = await recoveredDisputesFor(stripe, intent, charge, doc, req);
  const refunds = await refundsFor(stripe, intent, charge, req);
  const sum = statuses => refunds.filter(item => statuses.includes(item.status)).reduce((total, item) => total + item.amount, 0);
  const refunded = sum(["succeeded"]), pending = sum(["pending", "requires_action"]);
  requireEvidence(money(refunded) && money(pending) && refunded + pending <= intent.amount_received && charge.amount_refunded >= refunded && charge.amount_refunded <= refunded + pending);
  const status = pending ? "refund_pending" : refunded === intent.amount_received ? "refunded" : refunded > 0 ? "partially_refunded" : refunds.some(item => item.status === "failed") ? "refund_failed" : "received";
  const card = charge.payment_method_details?.card;
  const method = card && /^[0-9]{4}$/.test(card.last4 || "") && typeof card.brand === "string" ? `${card.brand.replace(/_/g, " ")} ending ${card.last4}` : "Unavailable";
  const lines = [{ label: "Matter amount", amount: expected.baseAmount }, { label: `Platform fee (${expected.feePercent}%)`, amount: expected.feeAmount }];
  if (refunded || pending) {
    lines.push({ label: "Original payment", amount: intent.amount_received }, { label: "Refunds processed", amount: refunded });
    if (pending) lines.push({ label: "Refunds pending", amount: pending });
  }
  return { receipt: { type: "payment", id: intent.id, currency, stripeMode: intent.livemode ? "live" : "test", issuedAt: Number.isSafeInteger(charge.created) && charge.created > 0 ? date(charge.created * 1000) : null, dateLabel: "Payment date", status, method, lines, total: { label: refunded || pending ? "Payment less processed refunds" : "Total paid", amount: intent.amount_received - refunded } }, evidence: fingerprint([charge.id, intent.amount_received, charge.amount_refunded, refunds, disputes]) };
}
async function payoutsFor(doc, record) {
  requireEvidence(validId(ref(record.withdrawnParalegalId)));
  const snapshot = await financial.loadFinancialInventory(ref(doc.attorney || doc.attorneyId), ref(doc._id));
  const rows = snapshot.payouts.filter(row => ref(row.paralegalId) === ref(record.withdrawnParalegalId));
  requireEvidence(rows.length <= 4000); return { rows, snapshot };
}
function withdrawal(doc, entry, entries, { rows, snapshot }) {
  const record = entry.record, currency = currencyFor(doc), gross = record.partialPayoutAmount;
  requireEvidence(!entry.conflict && history.decisions.has(record.payoutFinalizedType) && money(gross) && date(record.payoutFinalizedAt));
  requireEvidence(money(doc.lockedTotalAmount ?? doc.totalAmount) && gross <= (doc.lockedTotalAmount ?? doc.totalAmount));
  if (gross === 0) {
    // A later zero decision does not borrow an earlier assignment's payout.
    // Unbound positive rows still require review before claiming no payout.
    requireEvidence(!record.payoutTransferId && rows.every(payout => {
      const evidence = financial.payoutRecordEvidence(snapshot.cases[0], payout, snapshot);
      return evidence.withdrawal && evidence.withdrawal.id !== entry.id || payout.amountPaid === 0 && payout.status === "paid" && !payout.reversedAt;
    }));
    return { receipt: { type: "withdrawal", id: `${doc._id}-withdrawal-${new Date(record.payoutFinalizedAt).getTime()}`, currency, issuedAt: date(record.payoutFinalizedAt), dateLabel: "Withdrawal decision date", status: "no_payout", method: null, lines: [], total: { label: "Total released", amount: 0 } } };
  }
  let candidates;
  if (record.payoutTransferId) {
    requireEvidence(processorId(record.payoutTransferId, "tr"));
    requireEvidence(entries.filter(item => item.record?.payoutTransferId === record.payoutTransferId).length === 1);
    candidates = rows.filter(row => row.transferId === record.payoutTransferId);
  } else {
    // An unbound historical row must not borrow the latest payout for a repeated assignment.
    requireEvidence(entries.filter(item => item.record && ref(item.record.withdrawnParalegalId) === ref(record.withdrawnParalegalId)).length === 1);
    candidates = rows;
  }
  requireEvidence(candidates.length <= 1);
  const payout = candidates[0];
  if (payout && ["live", "test"].includes(doc.stripeMode) && ["live", "test"].includes(payout.stripeMode)) requireEvidence(doc.stripeMode === payout.stripeMode);
  if (payout && date(record.pausedAt)) requireEvidence(date(payout.createdAt) ? new Date(payout.createdAt) >= new Date(record.pausedAt) : Boolean(record.payoutTransferId));
  if (!payout || payout.status !== "paid" || payout.reversedAt) return { reason: "payout_unconfirmed" };
  requireEvidence(processorId(payout.transferId, "tr") && money(payout.amountPaid) && payout.amountPaid <= gross && payout.amountPaid > 0);
  const evidence = financial.payoutRecordEvidence(snapshot.cases[0], payout, snapshot);
  requireEvidence(evidence.state === "recorded" && evidence.withdrawal?.id === entry.id);
  return { receipt: { type: "withdrawal", id: payout.transferId, currency, stripeMode: evidence.stripeMode, issuedAt: date(payout.createdAt), dateLabel: "Payout date", status: "payout_recorded", method: "Stripe transfer", lines: [{ label: "Amount released from Matter", amount: gross }], total: { label: "Total released from Matter", amount: gross } } };
}
const isWithdrawal = doc => Boolean(doc.withdrawnParalegalId && doc.payoutFinalizedAt && !doc.paymentReleased && ["zero_auto", "partial_attorney", "admin", "expired_zero"].includes(doc.payoutFinalizedType));

async function read(req, { stripe, requireExpectedOwner = true } = {}) {
  if (Object.keys(req.query || {}).some(key => !["expectedOwnerId", "revision", "receiptId"].includes(key)) || req.query.receiptId !== undefined && !history.validSelection(req.query.receiptId)) fail(400, "RECEIPT_INVALID", "Invalid receipt selection.");
  const original = await owner(req, requireExpectedOwner), { doc, user } = original;
  let result, selected, ledger;
  const entries = req.query.receiptId === "payment" || !req.query.receiptId && !isWithdrawal(doc) ? [{ id: "payment", type: "payment" }] : history.inventory(doc);
  selected = req.query.receiptId ? entries.find(entry => entry.id === req.query.receiptId) : isWithdrawal(doc) ? entries.find(entry => entry.record && ref(entry.record.withdrawnParalegalId) === ref(doc.withdrawnParalegalId) && date(entry.record.payoutFinalizedAt) === date(doc.payoutFinalizedAt)) : entries[0];
  if (!selected) fail(404, "RECEIPT_SELECTION_UNAVAILABLE", "This receipt selection is no longer available. Refresh the receipt history.");
  try {
    if (selected.type === "withdrawal") { ledger = await payoutsFor(doc, selected.record); result = { ...withdrawal(doc, selected, entries, ledger), evidence: fingerprint(ledger) }; }
    else result = await payment(doc, user, stripe, req);
  }
  catch (error) { if (!error.receiptReview) throw error; result = { reason: "needs_review" }; }
  const current = await owner(req, requireExpectedOwner);
  if (current.revision !== original.revision) fail(409, "RECEIPT_CHANGED", "The receipt details changed. Open the receipt again before downloading.");
  if (selected.type === "withdrawal" && ledger && fingerprint(ledger) !== fingerprint(await payoutsFor(doc, selected.record))) fail(409, "RECEIPT_CHANGED", "The payout details changed. Open the receipt again before downloading.");
  const receipt = result.receipt ? { ...result.receipt, partyName: [user.firstName, user.lastName].filter(value => typeof value === "string" && value.trim()).join(" ") || doc.attorneyNameSnapshot || "Name unavailable", filename: filename(doc.title, result.receipt.type) } : null;
  const value = { caseId: String(doc._id), ownerId: String(user._id), selectionId: selected.id, caseTitle: typeof doc.title === "string" && doc.title ? doc.title : "Untitled Matter", reason: receipt ? "available" : result.reason, receipt };
  return { ...value, revision: receipt ? fingerprint([original.revision, result.evidence, value]) : null };
}
async function readHistory(req) {
  const query = req.query || {};
  if (Object.keys(query).some(key => !["expectedOwnerId", "cursor", "revision", "receiptId"].includes(key)) || query.receiptId !== undefined && !history.validSelection(query.receiptId) || query.revision !== undefined && !/^[a-f0-9]{64}$/.test(query.revision) || query.cursor !== undefined && (!/^(0|[1-9]\d{0,3})$/.test(query.cursor) || !query.revision)) fail(400, "RECEIPT_INVALID", "Invalid receipt history page.");
  const first = await owner(req, true), entries = history.inventory(first.doc), offset = Number(query.cursor || 0);
  const peopleIds = [...new Set(entries.filter(entry => entry.record).map(entry => ref(entry.record.withdrawnParalegalId)).filter(validId))];
  const people = async () => User.collection.find({ _id: { $in: peopleIds.map(value => new Types.ObjectId(value)) } }, { projection: { firstName: 1, lastName: 1 } }).sort({ _id: 1 }).toArray();
  const names = await people(), currentNames = await people(), current = await owner(req, true);
  if (first.revision !== current.revision || fingerprint(names) !== fingerprint(currentNames)) fail(409, "RECEIPT_CHANGED", "Receipt history changed. Refresh the list before continuing.");
  const revision = fingerprint([first.revision, names]);
  if (offset >= entries.length || query.revision && query.revision !== revision) fail(409, "RECEIPT_CHANGED", "Receipt history changed. Refresh the list before continuing.");
  const nameMap = new Map(names.map(person => [ref(person._id), [person.firstName, person.lastName].filter(value => typeof value === "string").join(" ").trim()]));
  const selected = query.receiptId ? entries.find(entry => entry.id === query.receiptId) : null, page = entries.slice(offset, offset + 25);
  let currency = null; try { currency = currencyFor(first.doc); } catch (error) { if (!error.receiptReview) throw error; }
  return { caseId: ref(first.doc._id), ownerId: ref(first.user._id), currency, revision, total: entries.length, entries: page.map(entry => history.present(entry, nameMap)), nextCursor: offset + page.length < entries.length ? String(offset + page.length) : null, selected: selected ? history.present(selected, nameMap) : null, selection: !query.receiptId ? "none" : selected ? "found" : "unavailable" };
}
const statuses = { received: "Payment confirmed", refunded: "Refund processed", partially_refunded: "Partial refund processed", refund_pending: "Refund pending", refund_failed: "Payment confirmed; refund attempt failed", payout_recorded: "Payout recorded; bank arrival not confirmed", no_payout: "No payout" };
function payload(value) {
  const { receipt } = value, format = amount => new Intl.NumberFormat("en-US", { style: "currency", currency: receipt.currency }).format(amount / 100);
  return { testMode: receipt.stripeMode === "test", title: receipt.type === "withdrawal" ? "Withdrawal receipt" : "Payment receipt", receiptId: receipt.id, issuedAt: receipt.issuedAt ? new Date(receipt.issuedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Date unavailable", dateLabel: receipt.dateLabel, partyLabel: receipt.type === "withdrawal" ? "Attorney" : "Billed to", partyName: receipt.partyName, caseTitle: value.caseTitle, lineItems: receipt.lines.map(line => ({ label: line.label, value: format(line.amount) })), totalLabel: receipt.total.label, totalAmount: format(receipt.total.amount), paymentMethod: receipt.method, paymentStatus: receipt.stripeMode === "test" && receipt.status === "payout_recorded" ? "Payout recorded" : statuses[receipt.status] };
}
module.exports = { read, readHistory, payload, statuses, filename };
