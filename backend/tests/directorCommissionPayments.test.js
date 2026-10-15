const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), { randomUUID } = require('crypto');
jest.mock('../utils/email', () => jest.fn(async () => ({ messageId: 'synthetic-director-payment' })));
const User = require('../models/User'), Record = require('../models/DirectorOutreachRecord'), Income = require('../models/PlatformIncome'), AuthSession = require('../models/AuthSession'), AuditLog = require('../models/AuditLog');
const { createAuthSession } = require('../services/authSessionService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const retain = require('./helpers/directorCommissionEvidence');
const app = express(); app.use(cookieParser(), express.json());
app.use('/api/director', require('../routes/directorPortal'));
app.use('/api/admin/directors', require('../routes/adminDirectors'));
app.use('/api/admin/workspace', require('../routes/adminWorkspace'));
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message, code: error.publicCode }));
let director, admin, attorney, paralegal, record, retained, cookies;
async function cookie(user) {
  if (cookies.has(String(user._id))) return cookies.get(String(user._id));
  const { sessionId } = await createAuthSession(user, { headers: { 'user-agent': 'synthetic-payment' } });
  const value = `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  cookies.set(String(user._id), value); return value;
}
const get = async (path, user = admin) => request(app).get(path).set('Cookie', await cookie(user));
const write = async (body, user = admin, query = '') => request(app).patch(`/api/admin/directors/records/${record._id}/commission-payout${query}`).set('Cookie', await cookie(user)).send(body);
async function current() { const response = await get(`/api/admin/directors/records/${record._id}/audit`); expect(response.status).toBe(200); return response.body.record; }
async function command(overrides = {}) { const value = await current(); return { requestId: randomUUID(), revision: value.commissionPayments.revision, action: 'payment', amountCents: 1000, currency: 'USD', stripeMode: 'test', paidDate: '2026-09-01', reference: 'Synthetic bank reference', reconcileLegacy: false, note: 'Private synthetic payment record.', ...overrides }; }
async function assertUnchanged() { expect((await Record.findById(record._id).lean()).commissionPaymentLedger || []).toHaveLength(0); expect(await AuditLog.countDocuments({ targetId: String(record._id) })).toBe(0); }
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); cookies = new Map();
  [director, admin, attorney, paralegal] = await User.create(['director', 'admin', 'attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@director-payment.test`, password: 'Synthetic123!', role, status: 'approved', emailVerified: true, approvedAt: new Date('2026-01-03T12:00:00Z') })));
  await User.collection.updateOne({ _id: attorney._id }, { $set: { createdAt: new Date('2026-01-02T12:00:00Z') } });
  record = await Record.create({ directorUserId: director._id, directorEmail: director.email, attorneyEmail: attorney.email, registeredUserId: attorney._id, firstOutreachSentAt: new Date('2026-01-01T12:00:00Z'), stage: 'outreach_sent' });
  retained = await retain({ attorney, paralegal });
});
test('overview and scoped audit expose the same reviewed payment revision', async () => {
  const overview = await get('/api/admin/directors/overview'); expect(overview.status).toBe(200);
  expect(overview.body.commissionPayables[0].commissionPayments.revision).toBe((await current()).commissionPayments.revision);
});
test('a partial manual payment retains its exact date, amount, actor and fee basis without a bank call', async () => {
  const body = await command(), response = await write(body); expect(response.status).toBe(200);
  expect(response.body.record.commissionPayments).toMatchObject({ state: 'partial', paidCents: 1000, outstandingCents: 3400 });
  const stored = await Record.findById(record._id).lean(); expect(stored.commissionPayoutStatus).toBe('unpaid');
  expect(stored.commissionPaymentLedger).toHaveLength(1);
  expect(stored.commissionPaymentLedger[0]).toMatchObject({ id: body.requestId, amountCents: 1000, paidDate: '2026-09-01', recordedBy: String(admin._id), reviewedRevision: body.revision, feeBasis: { recordId: String(record._id), matterCount: 1 } });
  expect(await AuditLog.countDocuments({ action: 'director.commission.payment', targetId: String(record._id) })).toBe(1);
  const directorView = await get('/api/director/records', director); expect(directorView.status).toBe(200);
  expect(directorView.body.records[0].commissionPayments).toMatchObject({ paidCents: 1000, outstandingCents: 3400 });
  expect(directorView.text).not.toContain('Private synthetic payment record.'); expect(directorView.text).not.toContain('recordedBy');
});
test('later earned fees remain outstanding after an earlier full payment', async () => {
  expect((await write(await command({ amountCents: 4400 }))).status).toBe(200);
  await retain({ attorney, paralegal });
  expect((await current()).commissionPayments).toMatchObject({ state: 'partial', paidCents: 4400, outstandingCents: 4400 });
  const overview = await get('/api/admin/directors/overview'); expect(overview.body.commissionOutstanding.commissionEarnedCents).toBe(4400);
});
test('an exact retry returns the original entry without duplicating history or audit', async () => {
  const body = await command(); expect((await write(body)).status).toBe(200);
  const retry = await write(body); expect(retry.status).toBe(200); expect(retry.body.replayed).toBe(true);
  expect((await Record.findById(record._id).lean()).commissionPaymentLedger).toHaveLength(1);
  expect(await AuditLog.countDocuments({ targetId: String(record._id) })).toBe(1);
});
test('reusing a request identity with different details is rejected', async () => {
  const body = await command(); expect((await write(body)).status).toBe(200);
  expect((await write({ ...body, amountCents: 2000 })).status).toBe(409);
});
test('a newly earned Matter invalidates the reviewed balance', async () => {
  const body = await command(); await retain({ attorney, paralegal });
  expect((await write(body)).status).toBe(409); await assertUnchanged();
});
test('a paid entry invalidates another reviewed request', async () => {
  const body = await command(); expect((await write(body)).status).toBe(200);
  expect((await write({ ...body, requestId: randomUUID() })).status).toBe(409);
});
test('concurrent requests cannot consume the same balance twice', async () => {
  const first = await command({ amountCents: 4400 }), second = { ...first, requestId: randomUUID() };
  const responses = await Promise.all([write(first), write(second)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  expect((await current()).commissionPayments).toMatchObject({ state: 'paid', paidCents: 4400, outstandingCents: 0 });
  expect(await AuditLog.countDocuments({ targetId: String(record._id) })).toBe(1);
});
test.each([
  ['legacy Boolean request', { paid: true }], ['zero amount', { amountCents: 0 }], ['negative amount', { amountCents: -1 }], ['string amount', { amountCents: '1000' }], ['fractional cents', { amountCents: 1.5 }], ['excess balance', { amountCents: 4401 }], ['missing currency', { currency: null }], ['different currency', { currency: 'EUR' }], ['unknown mode', { stripeMode: 'unknown' }], ['different mode', { stripeMode: 'live' }], ['invalid date', { paidDate: '2026-02-30' }], ['future date', { paidDate: '2099-01-01' }], ['empty reference', { reference: '' }], ['empty note', { note: '' }], ['coerced reconciliation', { reconcileLegacy: 'false' }], ['unknown field', { surprise: true }], ['missing revision', { revision: null }], ['invalid UUID', { requestId: 'again' }],
])('%s cannot append payment history', async (_label, overrides) => {
  expect((await write(await command(overrides))).status).toBe(400); await assertUnchanged();
});
test('reversal preserves the original record and appends a linked correction', async () => {
  const body = await command(); expect((await write(body)).status).toBe(200);
  const paid = await current(), reverse = { requestId: randomUUID(), revision: paid.commissionPayments.revision, action: 'reverse', reverses: body.requestId, note: 'Synthetic record was entered twice elsewhere.' };
  const result = await write(reverse); expect(result.status).toBe(200);
  expect(result.body.record.commissionPayments).toMatchObject({ state: 'unpaid', paidCents: 0, outstandingCents: 4400 });
  expect(result.body.record.commissionPayments.history).toEqual([expect.objectContaining({ id: body.requestId, reversed: true, amountCents: 1000 }), expect.objectContaining({ action: 'reverse', reverses: body.requestId })]);
  expect((await write({ ...reverse, requestId: randomUUID(), revision: result.body.record.commissionPayments.revision })).status).toBe(409);
  expect((await write(reverse)).body.replayed).toBe(true);
});
async function legacy() {
  await Record.collection.updateOne({ _id: record._id }, { $set: { commissionPayoutStatus: 'paid', commissionPaidAt: new Date('2026-08-01T12:00:00Z'), commissionEarnedCents: 99999, commissionPayoutNote: 'Old bank claim' } });
  return current();
}
test('a legacy paid flag stays unknown until explicitly reconciled', async () => {
  const old = await legacy(); expect(old.commissionPayments).toMatchObject({ state: 'needs_review', legacyState: 'needs_review', paidCents: null, outstandingCents: null });
  expect((await write(await command())).status).toBe(400); await assertUnchanged();
  const result = await write(await command({ reconcileLegacy: true, amountCents: 3000 })); expect(result.status).toBe(200);
  expect(result.body.record.commissionPayments).toMatchObject({ legacyState: 'reconciled', state: 'partial', paidCents: 3000, outstandingCents: 1400 });
  const stored = await Record.findById(record._id).lean(); expect(stored.commissionLegacySnapshot).toEqual(old.commissionLegacySnapshot ? { ...old.commissionLegacySnapshot, paidAt: new Date(old.commissionLegacySnapshot.paidAt), capturedAt: new Date(old.commissionLegacySnapshot.capturedAt) } : null);
  expect(stored.commissionPayoutStatus).toBe('paid'); expect(stored.commissionPayoutNote).toBe('Old bank claim');
});
test('an explicit no-payment reconciliation preserves the original paid claim', async () => {
  const old = await legacy();
  const response = await write({ requestId: randomUUID(), revision: old.commissionPayments.revision, action: 'legacy_none', note: 'Bank records establish no payment was sent.' });
  expect(response.status).toBe(200); expect(response.body.record.commissionPayments).toMatchObject({ state: 'unpaid', legacyState: 'reconciled', paidCents: 0, outstandingCents: 4400 });
  expect((await Record.findById(record._id).lean()).commissionPayoutStatus).toBe('paid');
});
test('reversing a legacy reconciliation reopens the historical claim for review', async () => {
  await legacy(); const body = await command({ reconcileLegacy: true }); expect((await write(body)).status).toBe(200);
  const latest = await current(); const result = await write({ requestId: randomUUID(), revision: latest.commissionPayments.revision, action: 'reverse', reverses: body.requestId, note: 'Historical reference was incorrect.' });
  expect(result.status).toBe(200); expect(result.body.record.commissionPayments).toMatchObject({ state: 'needs_review', legacyState: 'needs_review', outstandingCents: null });
});
test('historical overpayment is retained for review instead of becoming negative or erased', async () => {
  await legacy(); const result = await write(await command({ reconcileLegacy: true, amountCents: 6000 })); expect(result.status).toBe(200);
  expect(result.body.record.commissionPayments).toMatchObject({ state: 'needs_review', paidCents: 6000, outstandingCents: null });
});
test('uncertain retained fees do not erase an already recorded payment', async () => {
  expect((await write(await command())).status).toBe(200);
  await Income.collection.updateOne({ _id: retained.income._id }, { $set: { feeAmount: 1 } });
  const value = await current(); expect(value.commissionPayments).toMatchObject({ state: 'needs_review', paidCents: 1000, outstandingCents: null });
});
test('separate currency balances cannot offset each other', async () => {
  await retain({ attorney, paralegal, currency: 'eur' }); expect((await write(await command())).status).toBe(200);
  expect((await current()).commissionPayments.groups).toEqual([
    expect.objectContaining({ currency: 'EUR', paidCents: 0, outstandingCents: 4400 }), expect.objectContaining({ currency: 'USD', paidCents: 1000, outstandingCents: 3400 }),
  ]);
});
test('a wrong expected owner cannot write', async () => { const result = await write(await command(), admin, `?expectedOwnerId=${director._id}`); expect(result.status).toBe(403); await assertUnchanged(); });
test('a director cannot use the admin writer', async () => { expect((await write(await command(), director)).status).toBe(403); await assertUnchanged(); });
test('an audit-log failure rolls the payment append back', async () => {
  const body = await command(); jest.spyOn(AuditLog, 'create').mockRejectedValue(new Error('Synthetic audit failure'));
  expect((await write(body)).status).toBe(500); await assertUnchanged();
});
test.each(['role', 'authVersion', 'session'])('changing the admin %s during fee loading rejects the write', async field => {
  const body = await command(), original = Income.collection.find.bind(Income.collection); let changed = false;
  jest.spyOn(Income.collection, 'find').mockImplementation((...args) => {
    const cursor = original(...args), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async (...params) => { const rows = await toArray(...params); if (!changed) { changed = true; if (field === 'session') await AuthSession.updateMany({ userId: admin._id }, { $set: { revokedAt: new Date() } }); else await User.collection.updateOne({ _id: admin._id }, field === 'role' ? { $set: { role: 'attorney' } } : { $inc: { authVersion: 1 } }); } return rows; }; return cursor;
  });
  expect((await write(body)).status).toBe(403); await assertUnchanged();
});
test('retained fee changes during the reviewed write are rejected', async () => {
  const body = await command(), original = Income.collection.find.bind(Income.collection); let changed = false;
  jest.spyOn(Income.collection, 'find').mockImplementation((...args) => {
    const cursor = original(...args), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async (...params) => { const rows = await toArray(...params); if (!changed) { changed = true; await Income.collection.updateOne({ _id: retained.income._id }, { $set: { feeAmount: 1 } }); } return rows; }; return cursor;
  });
  expect((await write(body)).status).toBe(409); await assertUnchanged();
});
test('malformed retained history remains reviewable and cannot be rewritten', async () => {
  await Record.collection.updateOne({ _id: record._id }, { $set: { commissionPaymentVersion: 1, commissionPaymentLedger: [{ action: 'payment', amountCents: 1000 }] } });
  expect((await current()).commissionPayments).toMatchObject({ corrupt: true, state: 'needs_review', outstandingCents: null });
  expect((await write(await command())).status).toBe(409);
  expect((await Record.findById(record._id).lean()).commissionPaymentLedger).toEqual([{ action: 'payment', amountCents: 1000 }]);
});

const financePath = '/api/admin/workspace/finance/records?kind=commissions';
test('admin Finance projects the same partial payment and outstanding balance', async () => {
  expect((await write(await command())).status).toBe(200);
  const response = await get(financePath); expect(response.status).toBe(200);
  expect(response.body.items).toEqual([expect.objectContaining({ recordId: String(record._id), state: 'recorded', status: 'partial', amount: 3400, earnedAmount: 4400, recordedPaidAmount: 1000, currency: 'USD', stripeMode: 'test', basis: 'outstanding_commission' })]);
});
test('admin Finance keeps historical paid flags in its review inventory', async () => {
  await legacy(); const response = await get(financePath); expect(response.status).toBe(200);
  expect(response.body.items).toEqual([expect.objectContaining({ state: 'needs_review', amount: null, recordedPaidAmount: null, details: 'Historical payment to verify' })]);
});
test('admin Finance does not drop unverified fees after their cached amount becomes null', async () => {
  await Income.collection.updateOne({ _id: retained.income._id }, { $set: { feeAmount: 1 } }); await current();
  const response = await get(financePath); expect(response.status).toBe(200); expect(response.body.items).toHaveLength(1);
  expect(response.body.items[0].amount).toBeNull(); expect(response.body.items[0].state).toBe('needs_review');
});
test('admin Finance retains paid records and exposes later accrual as outstanding', async () => {
  expect((await write(await command({ amountCents: 4400 }))).status).toBe(200);
  const paid = await get(financePath); expect(paid.status).toBe(200); expect(paid.body.items[0]).toMatchObject({ status: 'paid', amount: 0, recordedPaidAmount: 4400 });
  await retain({ attorney, paralegal }); const accrued = await get(financePath); expect(accrued.status).toBe(200); expect(accrued.body.items[0]).toMatchObject({ status: 'partial', amount: 4400, recordedPaidAmount: 4400 });
});
test('both CSVs retain separate unit balances and director export includes immutable history', async () => {
  await retain({ attorney, paralegal, currency: 'eur' }); const body = await command(); expect((await write(body)).status).toBe(200);
  const finance = await get(financePath); expect(finance.status).toBe(200); expect(finance.body.items).toHaveLength(2);
  expect(finance.body.items.map(row => [row.currency, row.amount]).sort()).toEqual([['EUR', 4400], ['USD', 3400]]);
  const csv = await get('/api/admin/workspace/finance/export?kind=commissions&revision=' + finance.body.revision); expect(csv.status).toBe(200);
  expect(csv.text).toContain('"earnedAmount","recordedPaidAmount","recordId"'); expect(csv.text).toContain('"USD","3400"');
  const records = await get('/api/admin/directors/records.csv'); expect(records.status).toBe(200);
  expect(records.text).toContain(body.requestId); expect(records.text).toContain('Synthetic bank reference'); expect(records.text).toContain('10.00,34.00');
});
test('a changed payment invalidates a prior Finance export revision', async () => {
  const first = await get(financePath); expect(first.status).toBe(200); expect((await write(await command())).status).toBe(200);
  const csv = await get('/api/admin/workspace/finance/export?kind=commissions&revision=' + first.body.revision); expect(csv.status).toBe(409); expect(csv.text).not.toContain('Synthetic bank reference');
});
test('admin Finance rejects payment history changes during inventory verification', async () => {
  const find = Record.collection.find.bind(Record.collection); let changed = false;
  jest.spyOn(Record.collection, 'find').mockImplementation((...args) => {
    const cursor = find(...args), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async (...params) => { const rows = await toArray(...params); if (!changed && args[1]?.projection?.commissionEarnedCents === 1) { changed = true; await Record.collection.updateOne({ _id: record._id }, { $inc: { commissionPaymentVersion: 1 } }); } return rows; }; return cursor;
  });
  const response = await get(financePath); expect(changed).toBe(true); expect(response.status).toBe(409);
});
