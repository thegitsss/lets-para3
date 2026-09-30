"use strict";

const mongoose = require("mongoose"), Case = require("../models/Case"), Payout = require("../models/Payout"), Operation = require("../models/PaymentOperation");
const { fingerprint } = require("./matterDraftRevision"), { payoutRecordEvidence, payoutSourceFields } = require("./attorneyFinancialHistory");
const id = value => String(value?._id || value || ""), cap = 10000, money = value => Number.isSafeInteger(value) && value >= 0;
const fields = names => Object.fromEntries(names.map(name => [name, 1]));
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `PAYOUT_PROJECTION_${code}`, statusCode: code === "CHANGED" ? 409 : 503 }); };
async function limited(collection, query, projection) {
  const rows = await collection.find(query, { projection }).sort({ _id: 1 }).limit(cap + 1).toArray();
  if (rows.length > cap) fail("TOO_LARGE", "The payout records exceed the verification limit. Contact LPC support to review the complete record.");
  return rows;
}
async function inventory(selection, CaseModel, PayoutModel) {
  const selected = await limited(PayoutModel.collection, selection, fields(payoutSourceFields.payoutFields));
  if (!selected.length) return { selected, cases: [], payouts: [], operations: [], payoutReferences: [], transferReferences: [] };
  const caseIds = [...new Set(selected.map(row => id(row.caseId)))];
  if (caseIds.some(value => !/^[a-f0-9]{24}$/i.test(value))) fail("SOURCE_INVALID", "A payout's Matter reference needs review.");
  const caseRefs = caseIds.flatMap(value => [new mongoose.Types.ObjectId(value), value]);
  const [cases, payouts, operations] = await Promise.all([
    limited(CaseModel.collection, { _id: { $in: caseRefs } }, fields(payoutSourceFields.caseFields)),
    limited(PayoutModel.collection, { caseId: { $in: caseRefs } }, fields(payoutSourceFields.payoutFields)),
    limited(Operation.collection, { caseId: { $in: caseRefs } }, fields(payoutSourceFields.operationFields)),
  ]);
  if (cases.some(row => row.withdrawalHistory != null && !Array.isArray(row.withdrawalHistory))) fail("SOURCE_INVALID", "The earlier payout decisions need review.");
  if (cases.reduce((sum, row) => sum + (row.withdrawalHistory?.length || 0), 0) > cap) fail("TOO_LARGE", "The earlier payout decisions exceed the verification limit.");
  const transferIds = payouts.map(row => row.transferId).filter(value => /^tr_[A-Za-z0-9_]{1,200}$/.test(value || "")), keys = payouts.map(row => row.operationKey).filter(Boolean);
  const [payoutReferences, transferReferences] = await Promise.all([
    limited(PayoutModel.collection, { transferId: { $in: transferIds } }, { transferId: 1 }),
    limited(Operation.collection, { $or: [{ stripeTransferId: { $in: transferIds } }, { stripeObjectId: { $in: transferIds } }, { operationKey: { $in: keys } }] }, { caseId: 1, operationKey: 1, stripeTransferId: 1, stripeObjectId: 1 }),
  ]);
  return { selected, cases, payouts, operations, payoutReferences, transferReferences };
}

async function project(selection, { CaseModel = Case, PayoutModel = Payout, now = new Date() } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("INVALID", "The payout reporting date could not be verified.");
  const first = await inventory(selection, CaseModel, PayoutModel), rows = [], modes = new Map();
  for (const payout of first.selected) {
    const doc = first.cases.find(value => id(value._id) === id(payout.caseId));
    if (!doc || doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId)) { rows.push({ payoutId: id(payout._id), state: "needs_review", currency: null, amount: null, recordedAt: null }); continue; }
    const evidence = payoutRecordEvidence(doc, payout, { operations: first.operations.filter(value => id(value.caseId) === id(doc._id)), payouts: first.payouts.filter(value => id(value.caseId) === id(doc._id)), payoutReferences: first.payoutReferences, transferReferences: first.transferReferences });
    modes.set(id(payout._id), evidence.stripeMode);
    rows.push({ payoutId: id(payout._id), state: evidence.state, currency: evidence.currency, amount: evidence.amount, recordedAt: evidence.recordedAt });
  }
  const revision = fingerprint(first);
  if (revision !== fingerprint(await inventory(selection, CaseModel, PayoutModel))) fail("CHANGED", "Payout records changed during verification. Refresh the payment history before continuing.");
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), last30 = new Date(now.getTime() - 30 * 86400000), groups = new Map();
  for (const row of rows) {
    if (row.state !== "recorded" || !row.currency || !money(row.amount)) continue;
    if (!groups.has(row.currency)) groups.set(row.currency, { currency: row.currency, month: 0, last30: 0, total: 0 });
    const group = groups.get(row.currency); group.total += row.amount;
    if (row.recordedAt) { const paidAt = new Date(row.recordedAt); if (paidAt >= startOfMonth && paidAt <= now) group.month += row.amount; if (paidAt >= last30 && paidAt <= now) group.last30 += row.amount; }
    if (![group.total, group.month, group.last30].every(money)) fail("TOTAL_TOO_LARGE", "The recorded payout total exceeds its verification limit.");
  }
  const records = rows.map((row, index) => {
    const source = first.selected[index];
    return { ...row, _id: row.payoutId, caseId: id(source.caseId), paralegalId: id(source.paralegalId), operationKey: source.operationKey || null, transferId: source.transferId || null, stripeMode: modes.get(row.payoutId) || 'unknown', status: row.state === 'recorded' ? 'paid' : row.state, amountPaid: row.state === 'recorded' ? row.amount : null, createdAt: row.recordedAt };
  });
  return { rows, records, revision, currencies: [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency)) };
}

async function read(paralegalId, options = {}) {
  const { rows, currencies } = await readDetailed(paralegalId, options);
  return { rows, currencies };
}
// Private role adapter; the route verifies current account authority. Keep the
// established read() shape while exposing retained modes and source identity.
async function readDetailed(paralegalId, options = {}) {
  const personId = id(paralegalId);
  if (!/^[a-f0-9]{24}$/i.test(personId)) fail('INVALID', 'The payout account could not be verified.');
  return project({ paralegalId: { $in: [new mongoose.Types.ObjectId(personId), personId] } }, options);
}
// Internal administrator adapter. The caller must verify current admin access;
// it shares the exact payout predicates and complete source comparison above.
async function readAll(options = {}) { return project({}, options); }
module.exports = { read, readAll, readDetailed };
