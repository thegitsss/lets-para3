"use strict";

const { Types } = require("mongoose"), Case = require("../models/Case"), User = require("../models/User");
const account = require("./financialAccountBoundary"), financial = require("./attorneyFinancialHistory"), history = require("./attorneyReceiptHistory");
const { fingerprint } = require("./matterDraftRevision"), { filename } = require("./attorneyReceipts");
const id = value => String(value?._id || value || ""), validId = value => /^[a-f0-9]{24}$/i.test(value), money = value => Number.isSafeInteger(value) && value >= 0;
const date = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const fail = (status, suffix, message = "The payout receipt needs review before it can be downloaded.") => { throw Object.assign(new Error(message), { status, publicCode: `PAYOUT_RECEIPT_${suffix}` }); };
const required = value => { if (!value) fail(409, "NOT_READY"); };
function currency(value) {
  const code = value == null ? "USD" : value;
  try { const normalized = typeof code === "string" ? code.toUpperCase() : ""; return Intl.supportedValuesOf("currency").includes(normalized) && new Intl.NumberFormat("en-US", { style: "currency", currency: normalized }).resolvedOptions().maximumFractionDigits === 2 ? normalized : null; } catch { return null; }
}
function access(doc, ownerId) {
  const entries = history.inventory(doc).filter(entry => entry.record && id(entry.record.withdrawnParalegalId) === ownerId);
  const assigned = id(doc.paralegal || doc.paralegalId) === ownerId;
  if (!assigned && !entries.length) fail(403, "RESTRICTED", "This payout receipt is not available to this account.");
  required(!(doc.paralegal && doc.paralegalId && id(doc.paralegal) !== id(doc.paralegalId)));
  required(validId(id(doc.attorney || doc.attorneyId)) && !(doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId)));
  return { assigned, entries };
}
async function inventory(req, ownerId) {
  const caseId = req.params.caseId;
  const initial = await Case.collection.findOne({ _id: new Types.ObjectId(caseId) }, { projection: Object.fromEntries(financial.payoutSourceFields.caseFields.map(key => [key, 1])) });
  if (!initial) fail(404, "NOT_FOUND", "This Matter is no longer available.");
  access(initial, ownerId);
  const snapshot = await financial.loadFinancialInventory(id(initial.attorney || initial.attorneyId), caseId);
  access(snapshot.cases[0], ownerId);
  const person = await User.collection.findOne({ _id: new Types.ObjectId(ownerId) }, { projection: { firstName: 1, lastName: 1 } });
  return { snapshot, person };
}
function project({ snapshot, person }, ownerId, selection) {
  const doc = snapshot.cases[0], { assigned, entries } = access(doc, ownerId), code = currency(doc.currency);
  required(code);
  const owned = snapshot.payouts.filter(row => id(row.paralegalId) === ownerId).map(row => ({ row, evidence: financial.payoutRecordEvidence(doc, row, snapshot) }));
  let entry;
  if (selection && selection !== "completion") {
    entry = entries.find(value => value.id === selection);
    if (!entry) fail(404, "SELECTION_UNAVAILABLE", "This receipt selection is no longer available.");
  } else if (!selection && !(assigned && doc.paymentReleased === true)) {
    // The compatibility download opens the latest decision for this payee.
    // Older decisions have stable, payee-bound receiptId selections.
    entry = entries[0];
  }
  let gross, net, at, reference, receiptId, stripeMode, feePercent = doc.feeParalegalPct;
  if (entry) {
    const record = entry.record;
    required(!entry.conflict && history.decisions.has(record.payoutFinalizedType) && date(record.payoutFinalizedAt) && money(record.partialPayoutAmount) && money(doc.lockedTotalAmount ?? doc.totalAmount) && record.partialPayoutAmount <= (doc.lockedTotalAmount ?? doc.totalAmount));
    gross = record.partialPayoutAmount; receiptId = entry.id;
    const matches = owned.filter(value => value.evidence.withdrawal?.id === entry.id);
    if (gross === 0) {
      required(!record.payoutTransferId && owned.every(value => value.evidence.withdrawal && value.evidence.withdrawal.id !== entry.id || value.row.amountPaid === 0 && value.row.status === "paid" && !value.row.reversedAt));
      net = 0; at = date(record.payoutFinalizedAt); reference = `${doc._id}-withdrawal-${new Date(at).getTime()}`;
    } else {
      required(matches.length === 1 && matches[0].evidence.state === "recorded");
      const payout = matches[0].row; stripeMode = matches[0].evidence.stripeMode; net = payout.amountPaid; at = date(payout.createdAt); reference = payout.transferId;
    }
  } else {
    required(assigned && doc.paymentReleased === true);
    const matches = owned.filter(value => !value.evidence.withdrawal && (doc.payoutTransferId ? value.row.transferId === doc.payoutTransferId : value.row.operationKey === `case_payout:${doc._id}`));
    required(matches.length === 1 && matches[0].evidence.state === "recorded");
    const payout = matches[0].row, settlement = doc.disputeSettlement?.transferId === payout.transferId ? doc.disputeSettlement : null;
    stripeMode = matches[0].evidence.stripeMode;
    gross = settlement ? settlement.grossAmount : doc.remainingAmount ?? doc.lockedTotalAmount ?? doc.totalAmount;
    if (settlement) feePercent = settlement.feeParalegalPct;
    net = payout.amountPaid; at = date(payout.createdAt); reference = payout.transferId; receiptId = "completion";
  }
  required(money(gross) && money(net) && net <= gross);
  const fee = gross - net, format = amount => new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount / 100);
  const percent = Number.isFinite(feePercent) && feePercent >= 0 && feePercent < 100 && Math.round(gross * feePercent / 100) === fee ? feePercent : null;
  const caseTitle = typeof doc.title === "string" && doc.title || "Untitled Matter";
  const payload = { testMode: stripeMode === "test", title: gross ? "Payout receipt" : "Withdrawal receipt", receiptId: reference, issuedAt: at ? new Date(at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "Date unavailable", dateLabel: gross ? "Payout date" : "Withdrawal decision date", partyLabel: "Payee", partyName: [person?.firstName, person?.lastName].filter(value => typeof value === "string" && value.trim()).join(" ") || "Name unavailable", caseTitle, lineItems: gross ? [{ label: "Gross amount", value: format(gross) }, { label: percent === null ? "Platform fee" : `Platform fee (${percent}%)`, value: format(fee) }] : [], totalLabel: "Net payout", totalAmount: format(net), paymentMethod: gross ? "Stripe transfer" : null, paymentStatus: gross ? stripeMode === "test" ? "Payout recorded" : "Payout recorded; bank arrival not confirmed" : "No payout" };
  const value = { ownerId, caseId: id(doc._id), selectionId: receiptId, currency: code, amountCents: net, grossCents: gross, stripeMode: stripeMode || null, recordedAt: at, payoutState: gross ? "recorded" : "no_payout", filename: filename(caseTitle, "withdrawal").replace(/-withdrawal-receipt\.pdf$/, "-payout-receipt.pdf"), payload };
  return { ...value, receiptRevision: fingerprint(value) };
}
async function read(req) {
  const query = req.query || {}, ownerId = id(req.user?.id || req.user?._id);
  if (!validId(req.params.caseId) || Object.keys(query).some(key => !["expectedOwnerId", "revision", "receiptId", "receiptRevision"].includes(key)) || query.revision !== undefined && !/^[a-f0-9]{64}$/.test(query.revision) || query.receiptRevision !== undefined && !/^[a-f0-9]{64}$/.test(query.receiptRevision) || query.receiptId !== undefined && query.receiptId !== "completion" && !/^[a-f0-9]{64}$/.test(query.receiptId)) fail(400, "INVALID", "Invalid receipt selection.");
  const owner = await account.read(req, "paralegal", query.expectedOwnerId), first = await inventory(req, ownerId);
  const value = project(first, ownerId, query.receiptId), current = await inventory(req, ownerId), fresh = await account.read(req, "paralegal", query.expectedOwnerId);
  if (fingerprint(first) !== fingerprint(current) || fingerprint(owner) !== fingerprint(fresh)) fail(409, "CHANGED", "Payout details changed. Open the receipt again.");
  if (query.receiptRevision !== undefined && query.receiptRevision !== value.receiptRevision) fail(409, "CHANGED", "Payout details changed. Refresh the history before downloading the receipt.");
  return { ...value, revision: fingerprint([first, owner, value]) };
}
// Pure projection for other guarded paralegal views; read() owns HTTP authority.
module.exports = { read, projectReceipt: project };
