const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
jest.mock('../utils/email', () => jest.fn(async () => ({ messageId: 'synthetic-director-evidence' })));
const User = require('../models/User'), Case = require('../models/Case'), Record = require('../models/DirectorOutreachRecord'), Income = require('../models/PlatformIncome'), Operation = require('../models/PaymentOperation'), Payout = require('../models/Payout');
const { createAuthSession } = require('../services/authSessionService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const retain = require('./helpers/directorCommissionEvidence');
const app = express(); app.use(cookieParser(), express.json());
app.use('/api/director', require('../routes/directorPortal'));
app.use('/api/admin/directors', require('../routes/adminDirectors'));
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message }));
let director, admin, attorney, paralegal, record, evidence, cookies;
async function cookie(user) {
  if (cookies.has(String(user._id))) return cookies.get(String(user._id));
  const { sessionId } = await createAuthSession(user, { headers: { 'user-agent': 'synthetic-director-evidence' } });
  const value = `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  cookies.set(String(user._id), value); return value;
}
const get = async (path, user = director) => request(app).get(path).set('Cookie', await cookie(user));
async function current() {
  const response = await get('/api/director/records?rangeDays=30'); expect(response.status).toBe(200);
  return response.body.records.find(row => row.id === String(record._id));
}
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); cookies = new Map();
  [director, admin, attorney, paralegal] = await User.create(['director', 'admin', 'attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@director-evidence.test`, password: 'Synthetic123!', role, status: 'approved', emailVerified: true, approvedAt: new Date('2026-01-03T12:00:00Z') })));
  await User.collection.updateOne({ _id: attorney._id }, { $set: { createdAt: new Date('2026-01-02T12:00:00Z') } });
  record = await Record.create({ directorUserId: director._id, directorEmail: director.email, attorneyEmail: attorney.email, registeredUserId: attorney._id, firstOutreachSentAt: new Date('2026-01-01T12:00:00Z'), stage: 'outreach_sent' });
  evidence = await retain({ attorney, paralegal });
});

test('retained completed income earns half of the attorney fee and excludes the paralegal fee', async () => {
  expect(await current()).toMatchObject({ commissionEarnedCents: 4400, commissionableMatterCount: 1, commissionState: 'recorded', commissionCurrency: 'USD', commissionStripeMode: 'test' });
});
test('a completion marker and fee estimate are not collected platform income', async () => {
  await Income.deleteMany({}); await Operation.deleteMany({}); await Payout.deleteMany({});
  expect((await current()).commissionEarnedCents).toBeNull();
});
test('an unbacked income row cannot create payable commission', async () => {
  await Operation.deleteMany({}); await Payout.deleteMany({});
  expect(await current()).toMatchObject({ commissionEarnedCents: null, commissionState: 'needs_review' });
});
test.each(['failed', 'reversed', 'pending'])('a %s payout cannot create confirmed commission', async status => {
  await Payout.collection.updateOne({ _id: evidence.payout._id }, { $set: { status } });
  expect((await current()).commissionEarnedCents).toBeNull();
});
test('a mismatched combined income fee cannot create confirmed commission', async () => {
  await Income.collection.updateOne({ _id: evidence.income._id }, { $set: { feeAmount: 16001 } });
  expect((await current()).commissionEarnedCents).toBeNull();
});
test('unverified original funding prevents a commission claim', async () => {
  await Operation.collection.updateOne({ _id: evidence.funding._id }, { $set: { status: 'needs_reconciliation' } });
  expect((await current()).commissionEarnedCents).toBeNull();
});
test('historical attorney fee terms retain their actual amount', async () => {
  await clearDatabase(); cookies = new Map();
  [director, attorney, paralegal] = await User.create(['director', 'attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@director-evidence.test`, password: 'Synthetic123!', role, status: 'approved', emailVerified: true, approvedAt: new Date('2026-01-03T12:00:00Z') })));
  await User.collection.updateOne({ _id: attorney._id }, { $set: { createdAt: new Date('2026-01-02T12:00:00Z') } });
  record = await Record.create({ directorUserId: director._id, directorEmail: director.email, attorneyEmail: attorney.email, registeredUserId: attorney._id, firstOutreachSentAt: new Date('2026-01-01T12:00:00Z') });
  await retain({ attorney, paralegal, attorneyFee: 6000 });
  expect((await current()).commissionEarnedCents).toBe(3000);
});
test('pending approval does not produce earned commission', async () => {
  await User.collection.updateOne({ _id: attorney._id }, { $set: { status: 'pending', approvedAt: null } });
  expect((await current()).commissionEarnedCents).not.toBe(4400);
});
test('a known referred account remains linked after its email changes', async () => {
  await User.collection.updateOne({ _id: attorney._id }, { $set: { email: 'changed@director-evidence.test' } });
  expect((await current()).commissionEarnedCents).toBe(4400);
});
test('missing currency and mode cannot be silently reported as USD', async () => {
  await Case.collection.updateOne({ _id: evidence.matter._id }, { $unset: { currency: '', stripeMode: '' } });
  await Operation.collection.updateMany({}, { $unset: { currency: '', stripeMode: '', livemode: '' } });
  await Income.collection.updateMany({}, { $unset: { stripeMode: '' } }); await Payout.collection.updateMany({}, { $unset: { stripeMode: '' } });
  expect((await current()).commissionEarnedCents).toBeNull();
});
test('different currencies do not merge into a dollar total', async () => {
  await retain({ attorney, paralegal, currency: 'eur' });
  const value = await current(); expect(value.commissionEarnedCents).toBeNull();
  expect(value.commissionCurrencies).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'USD', stripeMode: 'test', earnedCents: 4400 }), expect.objectContaining({ currency: 'EUR', stripeMode: 'test', earnedCents: 4400 })]));
});
test('admin audit uses the same collected-fee evidence', async () => {
  await Income.collection.updateOne({ _id: evidence.income._id }, { $set: { feeAmount: 1 } });
  const response = await get(`/api/admin/directors/records/${record._id}/audit`, admin); expect(response.status).toBe(200);
  expect(response.body.commissionAudit[0].directorCommissionCents).toBeNull();
});

test.each([
  ['/api/director/overview', 'director'],
  ['/api/director/records', 'director'],
  ['/api/director/analytics', 'director'],
  ['/api/admin/directors/overview', 'admin'],
  ['/api/admin/directors/records.csv', 'admin'],
])('the expected signed-in owner guards %s', async (path, role) => {
  const response = await get(path + '?expectedOwnerId=' + attorney._id, role === 'admin' ? admin : director);
  expect(response.status).toBe(403);
  expect(response.text).not.toContain('Synthetic retained director commission');
});

test.each([['/api/director/overview', 'director'], ['/api/admin/directors/overview', 'admin'], ['/api/admin/directors/records.csv', 'admin']])('revocation during fee verification prevents delivery from %s', async (path, role) => {
  const actor = role === 'admin' ? admin : director, original = Income.collection.find.bind(Income.collection);
  let revoked = false;
  jest.spyOn(Income.collection, 'find').mockImplementation((...args) => {
    const cursor = original(...args), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async (...params) => {
      const rows = await toArray(...params);
      if (!revoked && rows.length) { revoked = true; await User.collection.updateOne({ _id: actor._id }, { $inc: { authVersion: 1 } }); }
      return rows;
    };
    return cursor;
  });
  const response = await get(path, actor);
  expect(revoked).toBe(true); expect(response.status).toBe(403);
  expect(response.text).not.toContain('Synthetic retained director commission');
});

test('a fee change during verification rejects a mixed snapshot', async () => {
  const original = Income.collection.find.bind(Income.collection); let changed = false;
  jest.spyOn(Income.collection, 'find').mockImplementation((...args) => {
    const cursor = original(...args), toArray = cursor.toArray.bind(cursor);
    cursor.toArray = async (...params) => {
      const rows = await toArray(...params);
      if (!changed && rows.length) { changed = true; await Income.collection.updateOne({ _id: evidence.income._id }, { $set: { feeAmount: 1 } }); }
      return rows;
    };
    return cursor;
  });
  const response = await get('/api/director/overview');
  expect(changed).toBe(true); expect(response.status).toBe(409);
});

test('closing the referred account preserves verified historical commission', async () => {
  await User.collection.updateOne({ _id: attorney._id }, { $set: { disabled: true, deleted: true, status: 'deleted' } });
  expect((await current()).commissionEarnedCents).toBe(4400);
});

test('conflicting attorney aliases cannot create verified commission', async () => {
  await Case.collection.updateOne({ _id: evidence.matter._id }, { $set: { attorneyId: paralegal._id } });
  const response = await get('/api/director/records');
  expect(response.status).toBe(409);
  expect(response.text).not.toContain('Synthetic retained director commission');
});

test('the earlier estimate and paid flag are preserved before cache correction', async () => {
  const paidAt = new Date('2026-09-01T12:00:00Z');
  await Record.collection.updateOne({ _id: record._id }, { $set: { commissionEarnedCents: 900000, commissionableMatterCount: 60, commissionPayoutStatus: 'paid', commissionPaidAt: paidAt, commissionPaidByAdminId: admin._id, commissionPayoutNote: 'Historical manual record.' } });
  await current();
  const first = await Record.findById(record._id).lean();
  expect(first.commissionEarnedCents).toBe(4400);
  expect(first.commissionLegacySnapshot).toMatchObject({ earnedCents: 900000, matterCount: 60, payoutStatus: 'paid', paidAt, paidByAdminId: admin._id, note: 'Historical manual record.' });
  await current();
  expect((await Record.findById(record._id).lean()).commissionLegacySnapshot).toEqual(first.commissionLegacySnapshot);
});

test('a historical estimate with no retained Matter remains a review item', async () => {
  await Record.collection.updateOne({ _id: record._id }, { $set: { firstMatterPostedAt: new Date(), commissionEarnedCents: 11000, commissionableMatterCount: 1 } });
  await Case.deleteMany({}); await Income.deleteMany({}); await Operation.deleteMany({}); await Payout.deleteMany({});
  expect(await current()).toMatchObject({ commissionEarnedCents: null, commissionState: 'needs_review' });
});


test.each(['/api/director/records?rangeDays=30', '/api/director/overview', '/api/admin/directors/overview'])('a raced derived cache cannot replace the verified amounts in %s', async path => {
  const original = Record.prototype.save;
  jest.spyOn(Record.prototype, 'save').mockImplementation(async function (...args) {
    const result = await original.apply(this, args);
    await Record.collection.updateOne({ _id: this._id }, { $set: { commissionEarnedCents: 999999, commissionCurrencies: [{ currency: 'USD', stripeMode: 'test', earnedCents: 999999 }] } });
    return result;
  });
  const response = await get(path, path.includes('/admin/') ? admin : director);
  expect(response.status).toBe(200);
  const value = response.body.counts || response.body.records.find(row => row.id === String(record._id));
  expect(value.commissionEarnedCents).toBe(4400);
  expect(response.text).not.toContain('999999');
});

test('a removed director remains visible in the admin financial inventory and export', async () => {
  await User.deleteOne({ _id: director._id });
  const response = await get('/api/admin/directors/overview', admin);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ totalRecords: 1, commissionEarnedCents: 4400 });
  expect(response.body.directors).toEqual(expect.arrayContaining([expect.objectContaining({ userId: String(director._id), status: 'unavailable' })]));
  const csv = await get('/api/admin/directors/records.csv', admin); expect(csv.status).toBe(200);
  expect(csv.text).toContain(director.email); expect(csv.text).toContain('44.00,USD,test,recorded');
});

test('CSV keeps each currency separate and neutralizes spreadsheet formulas', async () => {
  await retain({ attorney, paralegal, currency: 'eur' });
  await Record.collection.updateOne({ _id: record._id }, { $set: { attorneyName: '=SUM(1+1)' } });
  const response = await get('/api/admin/directors/records.csv', admin); expect(response.status).toBe(200);
  expect(response.text).toContain("'=SUM(1+1)");
  expect(response.text).toContain('44.00,USD,test,recorded'); expect(response.text).toContain('44.00,EUR,test,recorded');
});

test('test and live financial records remain separate amounts', async () => {
  await retain({ attorney, paralegal, stripeMode: 'live' });
  const value = await current(); expect(value.commissionEarnedCents).toBeNull();
  expect(value.commissionCurrencies).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'USD', stripeMode: 'test', earnedCents: 4400 }), expect.objectContaining({ currency: 'USD', stripeMode: 'live', earnedCents: 4400 })]));
});

test('income with a missing Matter stays visible for review', async () => {
  await Case.deleteOne({ _id: evidence.matter._id });
  await Record.collection.updateOne({ _id: record._id }, { $set: { firstMatterPostedAt: new Date() } });
  expect(await current()).toMatchObject({ commissionState: 'needs_review', commissionEarnedCents: null });
  const response = await get(`/api/admin/directors/records/${record._id}/audit`, admin);
  expect(response.status).toBe(200); expect(response.body.commissionAudit[0]).toMatchObject({ title: 'Matter unavailable', directorCommissionCents: null });
});

test('competing director referrals cannot both claim the same attorney fee', async () => {
  await Record.create({ directorUserId: admin._id, directorEmail: admin.email, attorneyEmail: attorney.email, registeredUserId: attorney._id, firstOutreachSentAt: new Date('2026-01-01T13:00:00Z') });
  expect(await current()).toMatchObject({ commissionState: 'needs_review', commissionEarnedCents: null });
});

test('outreach after registration does not establish an eligible referral', async () => {
  await Record.collection.updateOne({ _id: record._id }, { $set: { firstOutreachSentAt: new Date('2026-01-04T12:00:00Z') } });
  expect(await current()).toMatchObject({ commissionState: 'needs_review', commissionEarnedCents: null });
});

test.each([null, new Date('2025-01-01T12:00:00Z'), new Date('2099-01-01T12:00:00Z')])('a missing, pre-registration or future completion date cannot establish commission: %s', async completedAt => {
  await Case.collection.updateOne({ _id: evidence.matter._id }, { $set: { completedAt, paidOutAt: completedAt, payoutFinalizedAt: null } });
  expect(await current()).toMatchObject({ commissionState: 'needs_review', commissionEarnedCents: null });
});


test('simultaneous initial dashboard reads share one director profile', async () => {
  const Profile = require('../models/DirectorProfile');
  await cookie(director); // One managed session; race dashboard reads, not session creation.
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => get(i % 2 ? '/api/director/analytics' : '/api/director/overview')));
  for (const response of responses) expect(response.status).toBe(200);
  expect(await Profile.countDocuments({ userId: director._id })).toBe(1);
});


test('a retained withdrawal fee alone earns no director commission or lifetime slot', async () => {
  await Income.deleteMany({}); await Payout.deleteMany({}); await Operation.deleteMany({ kind: 'case_payout' });
  const at = new Date(Date.now() - 30000), key = `partial_payout:${evidence.matter._id}:director_withdrawal`, transferId = 'tr_director_withdrawal';
  await Payout.create({ caseId: evidence.matter._id, paralegalId: paralegal._id, operationKey: key, amountPaid: 8200, transferId, status: 'paid', stripeMode: 'test', createdAt: at });
  await Operation.create({ caseId: evidence.matter._id, operationKey: key, kind: 'partial_payout', fingerprint: key, amount: 8200, transferAmount: 8200, status: 'succeeded', currency: 'usd', stripeMode: 'test', stripeTransferId: transferId, stripeObjectId: transferId });
  await Income.create({ caseId: evidence.matter._id, attorneyId: attorney._id, paralegalId: paralegal._id, operationKey: key, feeAmount: 1800, stripeMode: 'test' });
  await Case.collection.updateOne({ _id: evidence.matter._id }, { $set: { status: 'in progress', paymentReleased: false, completedAt: null, paidOutAt: null, payoutTransferId: null, payoutStatus: 'not_started', remainingAmount: 30000, withdrawalHistory: [{ withdrawnParalegalId: paralegal._id, partialPayoutAmount: 10000, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', payoutTransferId: transferId, pausedAt: new Date(at.getTime() - 1000) }] } });
  expect(await current()).toMatchObject({ commissionState: 'none', commissionEarnedCents: 0, commissionableMatterCount: 0 });
  const audit = await get(`/api/admin/directors/records/${record._id}/audit`, admin);
  expect(audit.status).toBe(200); expect(audit.body.commissionAudit[0]).toMatchObject({ attorneyPlatformFeeCents: 0, directorCommissionCents: 0, commissionReason: 'paralegal_fee_only' });
});

test('a later withdrawal replacement earns the attorney fee once, excluding both paralegal fees', async () => {
  const former = await User.create({ firstName: 'Former', lastName: 'Paralegal', email: 'former@director-evidence.test', role: 'paralegal', password: 'Synthetic123!', status: 'approved', emailVerified: true });
  const at = new Date(Date.now() - 120000), key = `partial_payout:${evidence.matter._id}:former`, transferId = 'tr_director_former';
  await Payout.create({ caseId: evidence.matter._id, paralegalId: former._id, operationKey: key, amountPaid: 8200, transferId, status: 'paid', stripeMode: 'test', createdAt: at });
  await Operation.create({ caseId: evidence.matter._id, operationKey: key, kind: 'partial_payout', fingerprint: key, amount: 8200, transferAmount: 8200, status: 'succeeded', currency: 'usd', stripeMode: 'test', stripeTransferId: transferId, stripeObjectId: transferId });
  await Income.create({ caseId: evidence.matter._id, attorneyId: attorney._id, paralegalId: former._id, operationKey: key, feeAmount: 1800, stripeMode: 'test' });
  await Case.collection.updateOne({ _id: evidence.matter._id }, { $set: { remainingAmount: 30000, withdrawalHistory: [{ withdrawnParalegalId: former._id, partialPayoutAmount: 10000, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', payoutTransferId: transferId, pausedAt: new Date(at.getTime() - 1000) }] } });
  await Payout.collection.updateOne({ _id: evidence.payout._id }, { $set: { amountPaid: 24600 } });
  await Operation.collection.updateOne({ _id: evidence.operation._id }, { $set: { amount: 24600, transferAmount: 24600 } });
  await Income.collection.updateOne({ _id: evidence.income._id }, { $set: { feeAmount: 14200 } });
  expect(await current()).toMatchObject({ commissionState: 'recorded', commissionEarnedCents: 4400, commissionableMatterCount: 1 });
});


test('an old commission claim with only active Matters remains reviewable', async () => {
  await Record.collection.updateOne({ _id: record._id }, { $set: { commissionEarnedCents: 4400 } });
  await Income.deleteMany({}); await Payout.deleteMany({}); await Operation.deleteMany({});
  await Case.collection.updateOne({ _id: evidence.matter._id }, { $set: { status: 'in progress', paymentReleased: false, payoutStatus: 'not_started' }, $unset: { completedAt: '', paidOutAt: '', payoutTransferId: '' } });
  expect(await current()).toMatchObject({ commissionState: 'needs_review', commissionEarnedCents: null });
});
