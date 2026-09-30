const { Types } = require('mongoose');
const Record = require('../../models/DirectorOutreachRecord'), User = require('../../models/User'), Case = require('../../models/Case');
const financial = require('../adminFinancialReport');
const { fingerprint } = require('../matterDraftRevision');
const { allocateCommissionCap, COMMISSION_CAP } = require('./commissionCap');
const payments = require('./commissionPayments');
const id = financial.id, money = financial.money, date = financial.date;
const fields = names => Object.fromEntries(names.split(' ').map(name => [name, 1]));
const refs = values => [...new Set(values.map(id))].filter(value => /^[a-f0-9]{24}$/i.test(value)).flatMap(value => [value, new Types.ObjectId(value)]);
function fail(suffix) { throw Object.assign(new Error('Commission records could not be verified. Refresh before continuing.'), { statusCode: suffix === 'TOO_LARGE' ? 413 : 409, publicCode: `DIRECTOR_COMMISSION_${suffix}` }); }
async function limited(Model, filter, projection) {
  const rows = await Model.collection.find(filter, { projection }).sort({ _id: 1 }).limit(10001).toArray();
  if (rows.length > 10000) fail('TOO_LARGE');
  return rows;
}
async function source(directorUserId) {
  const records = await limited(Record, directorUserId ? { directorUserId: { $in: refs([directorUserId]) } } : {}, fields('_id directorUserId attorneyEmail registeredUserId firstOutreachSentAt commissionLegacySnapshot commissionPayoutStatus commissionPaidAt commissionPaidByAdminId commissionPayoutNote commissionPaymentLedger commissionPaymentVersion'));
  const emails = [...new Set(records.map(row => String(row.attorneyEmail || '').toLowerCase()).filter(Boolean))];
  const people = await limited(User, { $or: [{ _id: { $in: refs(records.map(row => row.registeredUserId)) } }, { email: { $in: emails } }] }, fields('_id email role status createdAt approvedAt disabled deleted'));
  const attorneyIds = [...new Set([...records.map(row => id(row.registeredUserId)), ...people.filter(row => row.role === 'attorney').map(row => id(row._id))].filter(value => /^[a-f0-9]{24}$/i.test(value)))];
  const claims = await limited(Record, { $or: [{ registeredUserId: { $in: refs(attorneyIds) } }, { attorneyEmail: { $in: people.map(row => row.email).concat(emails) } }] }, fields('_id directorUserId attorneyEmail registeredUserId firstOutreachSentAt'));
  const matters = await limited(Case, { $or: [{ attorney: { $in: refs(attorneyIds) } }, { attorneyId: { $in: refs(attorneyIds) } }] }, { _id: 1 });
  const retained = await financial.commissionSource(matters.map(row => id(row._id)), attorneyIds);
  return { records, people, claims, retained: retained.source, report: retained.report };
}
const userFor = (record, people) => record.registeredUserId ? people.find(person => id(person._id) === id(record.registeredUserId)) : people.find(person => String(person.email || '').toLowerCase() === String(record.attorneyEmail || '').toLowerCase());
function referred(record, person) {
  const outreach = date(record.firstOutreachSentAt), signup = date(person?.createdAt);
  return Boolean(person && person.role === 'attorney' && outreach && signup && outreach <= signup);
}
function approved(person, completedAt) {
  const at = date(person?.approvedAt), signup = date(person?.createdAt);
  return Boolean(person?.role === 'attorney' && signup && completedAt && signup <= completedAt && completedAt <= new Date().toISOString() && (at ? completedAt && at <= completedAt : person.status === 'approved' && !person.disabled && !person.deleted));
}
function summarize(records) {
  const groups = new Map(); let count = 0, review = 0;
  for (const record of records) {
    if (record.commissionState === 'needs_review') review++;
    count += Number(record.commissionableMatterCount || 0);
    for (const group of record.commissionCurrencies || []) {
      const key = `${group.currency}:${group.stripeMode}`;
      if (!groups.has(key)) groups.set(key, { currency: group.currency, stripeMode: group.stripeMode, earnedCents: 0 });
      groups.get(key).earnedCents += group.earnedCents;
      if (!money(groups.get(key).earnedCents)) fail('TOO_LARGE');
    }
  }
  const currencies = [...groups.values()].sort((a, b) => `${a.currency}:${a.stripeMode}`.localeCompare(`${b.currency}:${b.stripeMode}`));
  return { commissionState: review ? 'needs_review' : count ? 'recorded' : 'none', commissionEarnedCents: review || currencies.length > 1 ? null : currencies[0]?.earnedCents ?? 0, commissionableMatterCount: review ? null : count, commissionReviewCount: review, commissionCurrencies: currencies, commissionCurrency: currencies.length === 1 ? currencies[0].currency : null, commissionStripeMode: currencies.length === 1 ? currencies[0].stripeMode : null };
}
function fullRefund(value, caseId) {
  const funding = value.report.allFunding.filter(row => row.caseId === caseId);
  if (funding.length !== 1 || funding[0].state !== 'recorded' || !money(funding[0].amount) || !funding[0].amount) return null;
  const refunds = value.report.historyRows.filter(row => row.caseId === caseId && row.type === 'refund');
  if (!refunds.length || refunds.some(row => !['recorded', 'failed', 'canceled'].includes(row.state))) return null;
  const recorded = refunds.filter(row => row.state === 'recorded');
  // The shared financial reader verifies refund identity, amount and outcome.
  // Also bind its unit to the single original funding record when old Matters
  // have no retained mode of their own. Never infer a refund from a Case flag.
  for (const row of recorded) {
    const operations = value.retained.operations.filter(op => id(op.caseId) === caseId && fingerprint([caseId, ['refund', op.stripeRefundId || op.stripeObjectId]]) === row.id);
    if (!money(row.amount) || row.currency !== funding[0].currency || operations.length !== 1 || operations[0].stripeMode !== funding[0].stripeMode) return null;
  }
  const refunded = recorded.reduce((sum, row) => sum + row.amount, 0);
  return money(refunded) && refunded === funding[0].amount ? funding[0] : null;
}
function project(value) {
  const entries = [], byRecord = new Map(), reviewDirectors = new Set();
  for (const record of value.records) {
    const person = userFor(record, value.people), attorneyId = id(person?._id || record.registeredUserId);
    const claims = value.claims.filter(claim => id(userFor(claim, value.people)?._id || claim.registeredUserId) === attorneyId && referred(claim, person));
    const attribution = referred(record, person) && new Set(claims.map(claim => id(claim.directorUserId))).size === 1;
    const matters = attorneyId ? value.retained.snapshot.cases.filter(doc => [id(doc.attorney), id(doc.attorneyId)].includes(attorneyId)) : [];
    const sourceIncome = attorneyId ? value.retained.income.filter(row => id(row.attorneyId) === attorneyId) : [];
    const caseIds = [...new Set([...matters.map(doc => id(doc._id)), ...sourceIncome.map(row => id(row.caseId))])];
    const rows = [];
    for (const caseId of caseIds) {
      const doc = matters.find(row => id(row._id) === caseId), income = value.report.allIncome.filter(row => row.caseId === caseId);
      const completedAt = date(doc?.completedAt || doc?.paidOutAt || doc?.payoutFinalizedAt);
      const completed = ['completed', 'closed'].includes(String(doc?.status || '').toLowerCase());
      const relevant = completed || income.length > 0 || doc?.paymentReleased === true || Boolean(doc?.payoutTransferId);
      if (!relevant) continue;
      const fees = income.filter(row => row.state === 'recorded' && money(row.attorneyFeeAmount) && row.attorneyFeeAmount > 0);
      const ownership = doc && !(doc.attorney && doc.attorneyId && id(doc.attorney) !== id(doc.attorneyId));
      const refunded = ownership ? fullRefund(value, caseId) : null;
      let state = 'none', reason = 'not_earned', fee = null;
      if (refunded) { fee = 0; reason = 'fully_refunded'; }
      else if (income.length && income.every(row => row.state === 'recorded') && !fees.length) { fee = 0; reason = 'paralegal_fee_only'; }
      else if (attribution && ownership && completed && completedAt && approved(person, completedAt) && income.length && income.every(row => row.state === 'recorded') && fees.length === 1 && fees[0].currency && ['test', 'live'].includes(fees[0].stripeMode)) { state = 'recorded'; reason = 'retained_attorney_fee'; fee = fees[0].attorneyFeeAmount; }
      else { state = 'needs_review'; reason = !attribution ? 'referral_to_verify' : !approved(person, completedAt) ? 'approval_to_verify' : 'fee_to_verify'; reviewDirectors.add(id(record.directorUserId)); }
      const row = { caseId, title: doc?.title || 'Matter unavailable', status: doc?.status || 'unavailable', completedAt, paid: state === 'recorded' || fee === 0, matterAmountCents: money(doc?.lockedTotalAmount ?? doc?.totalAmount) ? doc.lockedTotalAmount ?? doc.totalAmount : null, attorneyPlatformFeeCents: fee, directorCommissionCents: state === 'recorded' ? Math.round(fee * 0.5) : state === 'needs_review' ? null : 0, commissionState: state, commissionReason: reason, currency: refunded?.currency || fees[0]?.currency || income[0]?.currency || financial.currency(doc?.currency), stripeMode: refunded?.stripeMode || fees[0]?.stripeMode || income[0]?.stripeMode || 'unknown', incomeId: fees[0]?.id || income[0]?.id || '' };
      rows.push(row);
      if (state === 'recorded') entries.push({ directorUserId: record.directorUserId, recordId: record._id, caseId, completedAt, row });
    }
    if (!rows.length && (record.commissionLegacySnapshot?.earnedCents > 0 || record.commissionLegacySnapshot?.matterCount > 0)) {
      reviewDirectors.add(id(record.directorUserId));
      rows.push({ caseId: null, title: 'Historical commission', status: 'unavailable', completedAt: null, paid: false, matterAmountCents: null, attorneyPlatformFeeCents: null, directorCommissionCents: null, commissionState: 'needs_review', commissionReason: 'legacy_claim_to_verify', currency: null, stripeMode: 'unknown', incomeId: '' });
    }
    byRecord.set(id(record._id), { record, rows });
  }
  const allocation = allocateCommissionCap(entries), records = new Map();
  for (const [recordId, { record, rows }] of byRecord) {
    const selected = allocation.byRecord.get(recordId) || [], selectedIds = new Set(selected.map(entry => entry.caseId));
    const requiresReview = reviewDirectors.has(id(record.directorUserId));
    for (const row of rows) {
      if (row.commissionState !== 'recorded') continue;
      if (requiresReview) { row.commissionState = 'needs_review'; row.commissionReason = 'allocation_to_verify'; row.directorCommissionCents = null; }
      else if (!selectedIds.has(row.caseId)) { row.commissionState = 'cap_reached'; row.commissionReason = 'director_lifetime_cap'; row.directorCommissionCents = 0; }
    }
    const currencies = new Map();
    if (!requiresReview) for (const { row } of selected) {
      const key = `${row.currency}:${row.stripeMode}`;
      if (!currencies.has(key)) currencies.set(key, { currency: row.currency, stripeMode: row.stripeMode, earnedCents: 0 });
      currencies.get(key).earnedCents += row.directorCommissionCents;
    }
    const amount = summarize([{ commissionState: requiresReview ? 'needs_review' : selected.length ? 'recorded' : 'none', commissionableMatterCount: selected.length, commissionCurrencies: [...currencies.values()] }]);
    records.set(recordId, { ...amount, commissionStatus: (allocation.totals.get(id(record.directorUserId)) || 0) >= COMMISSION_CAP ? 'cap_reached' : selected.length ? 'accruing' : 'none', commissionAudit: rows, directorUserId: id(record.directorUserId) });
    const projected = records.get(recordId);
    projected.commissionPayments = payments.project(record, projected);
  }
  return { records, allocation, reviewDirectors };
}
async function read({ directorUserId = null } = {}) {
  if (directorUserId && !/^[a-f0-9]{24}$/i.test(id(directorUserId))) fail('INVALID');
  const first = await source(directorUserId), revision = fingerprint(first), value = project(first);
  return { ...value, revision, async verify() { if (revision !== fingerprint(await source(directorUserId))) fail('CHANGED'); } };
}
async function retainLegacyClaims({ directorUserId = null } = {}) {
  if (directorUserId && !/^[a-f0-9]{24}$/i.test(id(directorUserId))) fail('INVALID');
  // The single-document pipeline captures the values at the time of the write,
  // including a concurrent old paid flag; it never overwrites an earlier copy.
  await Record.collection.updateMany({ ...(directorUserId ? { directorUserId: { $in: refs([directorUserId]) } } : {}), commissionEvidenceVersion: { $ne: 1 }, commissionLegacySnapshot: null, $or: [{ commissionEarnedCents: { $gt: 0 } }, { commissionableMatterCount: { $gt: 0 } }, { commissionPayoutStatus: 'paid' }] }, [{ $set: { commissionLegacySnapshot: { earnedCents: '$commissionEarnedCents', matterCount: '$commissionableMatterCount', payoutStatus: '$commissionPayoutStatus', paidAt: '$commissionPaidAt', paidByAdminId: '$commissionPaidByAdminId', note: '$commissionPayoutNote', capturedAt: '$$NOW' } } }]);
}
// Deliver the projection from this verified read, never a cache another request
// may have replaced while this request was awaiting I/O.
function attach(record, financial) {
  const projected = financial.records.get(id(record._id));
  if (!projected || id(projected.directorUserId) !== id(record.directorUserId)) fail('CHANGED');
  const amounts = { ...projected };
  delete amounts.commissionAudit; delete amounts.directorUserId;
  return { ...(record.toObject ? record.toObject() : record), ...amounts };
}
module.exports = { read, summarize, retainLegacyClaims, attach };
