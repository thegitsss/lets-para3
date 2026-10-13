const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), { randomUUID } = require('crypto');
jest.mock('../utils/email', () => jest.fn(async () => ({ messageId: 'synthetic-refund-slot' })));
const User = require('../models/User'), Case = require('../models/Case'), Record = require('../models/DirectorOutreachRecord'), Operation = require('../models/PaymentOperation'), Income = require('../models/PlatformIncome');
const { createAuthSession } = require('../services/authSessionService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const retain = require('./helpers/directorCommissionEvidence');
const app = express(); app.use(cookieParser(), express.json());
app.use('/api/director', require('../routes/directorPortal'));
app.use('/api/admin/directors', require('../routes/adminDirectors'));
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message, code: error.publicCode }));
let director, admin, attorney, paralegal, record, evidence, cookies;
async function cookie(user) {
  if (cookies.has(String(user._id))) return cookies.get(String(user._id));
  const { sessionId } = await createAuthSession(user, { headers: { 'user-agent': 'synthetic-refund-slot' } });
  const value = `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  cookies.set(String(user._id), value); return value;
}
const get = async (path, user = director) => request(app).get(path).set('Cookie', await cookie(user));
async function current() {
  const response = await get(`/api/admin/directors/records/${record._id}/audit`, admin);
  expect(response.status).toBe(200); return response.body;
}
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); cookies = new Map();
  [director, admin, attorney, paralegal] = await User.create(['director', 'admin', 'attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@director-refund-slot.test`, password: 'Synthetic123!', role, status: 'approved', emailVerified: true, approvedAt: new Date('2026-01-03T12:00:00Z') })));
  await User.collection.updateOne({ _id: attorney._id }, { $set: { createdAt: new Date('2026-01-02T12:00:00Z') } });
  record = await Record.create({ directorUserId: director._id, directorEmail: director.email, attorneyEmail: attorney.email, registeredUserId: attorney._id, firstOutreachSentAt: new Date('2026-01-01T12:00:00Z'), stage: 'outreach_sent' });
  evidence = await retain({ attorney, paralegal, completedAt: new Date(Date.now() - 3600000) });
});
async function refund(overrides = {}, retained = evidence) {
  const { funding, matter } = retained, now = new Date();
  return Operation.create({ caseId: matter._id, operationKey: `refund:${matter._id}:${randomUUID()}`, kind: 'refund', fingerprint: String(matter._id), status: 'succeeded', amount: funding.amount, refundAmount: funding.amount, stripeRefundId: `re_slot_${matter._id}`, stripePaymentIntentId: funding.stripePaymentIntentId, stripeChargeId: funding.stripeChargeId, currency: funding.currency, stripeMode: funding.stripeMode, refundStatus: 'succeeded', refundEvidenceStatus: 'verified', refundVerifiedAt: now, refundCreatedAt: now, ...overrides });
}
test('a verified full refund restores the lifetime slot without changing retained financial history', async () => {
  expect((await current()).record).toMatchObject({ commissionableMatterCount: 1, commissionEarnedCents: 4400 });
  const before = await Income.findById(evidence.income._id).lean(); await refund();
  const audit = await current();
  expect(audit.record).toMatchObject({ commissionableMatterCount: 0, commissionEarnedCents: 0, commissionState: 'none' });
  expect(audit.commissionAudit.find(row => row.caseId === String(evidence.matter._id))).toMatchObject({ directorCommissionCents: 0, attorneyPlatformFeeCents: 0, commissionReason: 'fully_refunded' });
  const overview = await get('/api/director/overview'); expect(overview.status).toBe(200);
  expect(overview.body.commissionLifetime).toMatchObject({ commissionCapMatterCount: 50, commissionableMatterCount: 0, remainingMatterCount: 50 });
  expect(await Income.findById(evidence.income._id).lean()).toEqual(before);
  expect(require('../utils/email')).not.toHaveBeenCalled();
});
test('the next eligible Matter uses the restored slot while the director total remains 50', async () => {
  const additions = [];
  for (let index = 0; index < 50; index++) additions.push(await retain({ attorney, paralegal, completedAt: new Date(Date.now() - 3000000 + index * 1000) }));
  const before = await current(); expect(before.record.commissionableMatterCount).toBe(50);
  expect(before.commissionAudit.find(row => row.caseId === String(additions[49].matter._id)).commissionState).toBe('cap_reached');
  await refund(); const after = await current();
  expect(after.record).toMatchObject({ commissionableMatterCount: 50, commissionEarnedCents: 220000 });
  expect(after.commissionAudit.find(row => row.caseId === String(additions[49].matter._id))).toMatchObject({ commissionState: 'recorded', directorCommissionCents: 4400 });
  const repeated = await current(); expect(repeated.record.commissionableMatterCount).toBe(50);
});
test.each([
  ['pending', { status: 'pending', refundStatus: 'pending' }],
  ['unverified', { refundEvidenceStatus: 'needs_review' }],
  ['wrong currency', { currency: 'eur' }],
  ['wrong mode', { stripeMode: 'live' }],
  ['wrong original payment', { stripePaymentIntentId: 'pi_other_matter' }],
  ['wrong charge', { stripeChargeId: 'ch_other_matter' }],
])('%s refund evidence cannot claim a released slot', async (_name, overrides) => {
  await refund(overrides); const audit = await current();
  expect(audit.record.commissionState).toBe('needs_review');
  expect(audit.record.commissionableMatterCount).toBeNull();
  expect(audit.commissionAudit[0].commissionReason).not.toBe('fully_refunded');
});
test('a partial refund retains the existing slot rule', async () => {
  await refund({ amount: 24400, refundAmount: 24400 }); const audit = await current();
  expect(audit.record.commissionableMatterCount).toBe(1);
  expect(audit.commissionAudit[0].commissionReason).not.toBe('fully_refunded');
});
test('a refunded status alone does not replace verified refund evidence', async () => {
  await Case.collection.updateOne({ _id: evidence.matter._id }, { $set: { status: 'closed', escrowStatus: 'refunded' } });
  const audit = await current(); expect(audit.commissionAudit[0].commissionReason).not.toBe('fully_refunded');
});
test('a refund keeps an earlier manual payment entry and exposes the amount for review', async () => {
  const before = await current(), body = { requestId: randomUUID(), revision: before.record.commissionPayments.revision, action: 'payment', amountCents: 4400, currency: 'USD', stripeMode: 'test', paidDate: '2026-09-01', reference: 'Synthetic external reference', reconcileLegacy: false, note: 'Synthetic previously recorded commission.' };
  const saved = await request(app).patch(`/api/admin/directors/records/${record._id}/commission-payout`).set('Cookie', await cookie(admin)).send(body); expect(saved.status).toBe(200);
  const ledger = (await Record.findById(record._id).lean()).commissionPaymentLedger;
  await refund(); const after = await current();
  expect(after.record.commissionableMatterCount).toBe(0);
  expect(after.record.commissionPayments).toMatchObject({ state: 'needs_review', paidCents: 4400, outstandingCents: null });
  expect((await Record.findById(record._id).lean()).commissionPaymentLedger).toEqual(ledger);
});
test('a full refund invalidates a previously reviewed manual-payment request', async () => {
  const before = await current(); await refund();
  const response = await request(app).patch(`/api/admin/directors/records/${record._id}/commission-payout`).set('Cookie', await cookie(admin)).send({ requestId: randomUUID(), revision: before.record.commissionPayments.revision, action: 'payment', amountCents: 4400, currency: 'USD', stripeMode: 'test', paidDate: '2026-09-01', reference: 'Synthetic external reference', reconcileLegacy: false, note: 'Synthetic stale request.' });
  expect(response.status).toBe(409); expect((await Record.findById(record._id).lean()).commissionPaymentLedger || []).toHaveLength(0);
});
test('separate verified refunds restore one slot only when their total includes the attorney fee', async () => {
  await refund({ amount: 40000, refundAmount: 40000 });
  expect((await current()).record.commissionableMatterCount).toBe(1);
  await refund({ amount: 8800, refundAmount: 8800, stripeRefundId: `re_slot_fee_${evidence.matter._id}` });
  const audit = await current(); expect(audit.record.commissionableMatterCount).toBe(0);
  expect(audit.commissionAudit[0].commissionReason).toBe('fully_refunded');
});
test('duplicate provider refund references stay under review', async () => {
  await refund(); await refund(); const audit = await current();
  expect(audit.record.commissionState).toBe('needs_review');
  expect(audit.commissionAudit[0].commissionReason).not.toBe('fully_refunded');
});
test('refund totals exceeding original funding cannot restore a slot', async () => {
  await refund(); await refund({ amount: 100, refundAmount: 100, stripeRefundId: `re_excess_${evidence.matter._id}` });
  const audit = await current(); expect(audit.record.commissionState).toBe('needs_review');
  expect(audit.commissionAudit[0].commissionReason).not.toBe('fully_refunded');
});
test('legacy missing Matter mode cannot combine a live refund with test funding', async () => {
  await Case.collection.updateOne({ _id: evidence.matter._id }, { $unset: { stripeMode: '' } });
  await refund({ stripeMode: 'live' }); const audit = await current();
  expect(audit.commissionAudit[0].commissionReason).not.toBe('fully_refunded');
});
