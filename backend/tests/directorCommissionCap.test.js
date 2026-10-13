const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
jest.mock('../utils/email', () => jest.fn(async () => ({ messageId: 'synthetic-director-cap' })));
const User = require('../models/User'), Case = require('../models/Case'), Record = require('../models/DirectorOutreachRecord');
const Income = require('../models/PlatformIncome');
const retain = require('./helpers/directorCommissionEvidence');
const { createAuthSession } = require('../services/authSessionService');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json());
app.use('/api/director', require('../routes/directorPortal'));
app.use('/api/admin/directors', require('../routes/adminDirectors'));
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
let director, admin, para, attorneys, records, cookies, matters;
async function cookie(user) {
  if (cookies.has(String(user._id))) return cookies.get(String(user._id));
  const { sessionId } = await createAuthSession(user, { headers: { 'user-agent': 'synthetic-director-cap' } });
  const value = `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  cookies.set(String(user._id), value); return value;
}
const get = async (path, user = director) => request(app).get(path).set('Cookie', await cookie(user));
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => {
  await clearDatabase(); cookies = new Map();
  [director, admin, para, ...attorneys] = await User.create(['director', 'admin', 'paralegal', 'attorney', 'attorney'].map((role, index) => ({ firstName: 'Synthetic', lastName: role, email: `cap-${index}@director-cap.test`, role, password: 'Synthetic123!', status: 'approved', emailVerified: true })));
  await User.collection.updateMany({ _id: { $in: attorneys.map(row => row._id) } }, { $set: { createdAt: new Date('2019-01-02T12:00:00Z'), approvedAt: new Date('2019-01-03T12:00:00Z') } });
  records = await Record.create(attorneys.map(attorney => ({ directorUserId: director._id, directorEmail: director.email, attorneyEmail: attorney.email, firstOutreachSentAt: new Date('2019-01-01T12:00:00Z'), stage: 'outreach_sent' })));
  matters = [];
  // Creation order deliberately disagrees with completion order. The cap must
  // span both referred attorneys and use completion order, including exact ties.
  for (let index = 59; index >= 0; index--) {
    const attorney = attorneys[index % 2], completedAt = new Date(Date.now() - (60 - index) * 60000);
    const { matter: doc } = await retain({ attorney, paralegal: para, amount: 100000, attorneyFee: 22000 + 2 * index, completedAt });
    matters[index] = doc;
  }
});

test('50 completed Matters total across referred attorneys, with the fee share unchanged', async () => {
  const response = await get('/api/director/records?rangeDays=30'); expect(response.status).toBe(200);
  const rows = response.body.records;
  expect(rows.reduce((sum, row) => sum + row.commissionableMatterCount, 0)).toBe(50);
  expect(rows.reduce((sum, row) => sum + row.commissionEarnedCents, 0)).toBe(551225);
  expect(rows.map(row => row.commissionableMatterCount).sort()).toEqual([25, 25]);
  expect(rows.every(row => row.commissionStatus === 'cap_reached')).toBe(true);
});

test('later Matters do not increase commission after the director reaches 50', async () => {
  await get('/api/director/overview');
  const before = await Record.find({ directorUserId: director._id }).sort({ _id: 1 }).lean();
  await retain({ attorney: attorneys[0], paralegal: para, amount: 100000, attorneyFee: 90000, completedAt: new Date() });
  await get('/api/director/overview');
  const after = await Record.find({ directorUserId: director._id }).sort({ _id: 1 }).lean();
  expect(after.map(row => [row.commissionableMatterCount, row.commissionEarnedCents])).toEqual(before.map(row => [row.commissionableMatterCount, row.commissionEarnedCents]));
  expect(after.reduce((sum, row) => sum + row.commissionableMatterCount, 0)).toBe(50);
});

test('attorneyId-only Matters participate in the same cap', async () => {
  await Case.collection.updateMany({ attorney: attorneys[0]._id }, { $unset: { attorney: '' } });
  const response = await get('/api/director/records?rangeDays=30'); expect(response.status).toBe(200);
  expect(response.body.records.reduce((sum, row) => sum + row.commissionEarnedCents, 0)).toBe(551225);
});

test('each director has an independent total allowance of 50', async () => {
  const second = await User.create({ firstName: 'Second', lastName: 'Director', email: 'second@director-cap.test', role: 'director', password: 'Synthetic123!', status: 'approved', emailVerified: true });
  await Record.collection.updateOne({ _id: records[1]._id }, { $set: { directorUserId: second._id, directorEmail: second.email } });
  const first = await get('/api/director/overview'); const other = await get('/api/director/overview', second);
  expect(first.body.counts.commissionableMatterCount).toBe(30);
  expect(other.body.counts.commissionableMatterCount).toBe(30);
});

test('admin reads refresh the same full allocation before applying display limits', async () => {
  const response = await get('/api/admin/directors/overview?limit=1', admin); expect(response.status).toBe(200);
  const totals = response.body.directors.find(row => row.userId === String(director._id)).totals;
  expect(totals.commissionableMatterCount).toBe(50);
  expect(totals.commissionEarnedCents).toBe(551225);
});

test('the Matter audit gives zero commission to later Matters beyond the shared cap', async () => {
  const response = await get(`/api/admin/directors/records/${records[1]._id}/audit`, admin); expect(response.status).toBe(200);
  const later = response.body.commissionAudit.find(row => row.caseId === String(matters[59]._id));
  const first = response.body.commissionAudit.find(row => row.caseId === String(matters[1]._id));
  expect(later.directorCommissionCents).toBe(0); expect(later.commissionState).toBe('cap_reached');
  expect(first.directorCommissionCents).toBe(11001);
  expect(response.body.record.commissionableMatterCount).toBe(25);
});

test('date filters do not reset lifetime cap progress', async () => {
  await Record.collection.updateOne({ _id: records[0]._id }, { $set: { firstOutreachSentAt: new Date('2018-01-01T00:00:00Z') } });
  const response = await get('/api/director/overview?rangeDays=1'); expect(response.status).toBe(200);
  expect(response.body.commissionLifetime).toMatchObject({ commissionCapMatterCount: 50, commissionableMatterCount: 50, remainingMatterCount: 0 });
});


test('suppression of outreach does not restore already used commission slots', async () => {
  await get('/api/director/overview');
  await Record.collection.updateOne({ _id: records[0]._id }, { $set: { stage: 'suppressed', suppressedAt: new Date() } });
  const response = await get('/api/director/overview'); expect(response.status).toBe(200);
  expect(response.body.commissionLifetime.commissionableMatterCount).toBe(50);
  const rows = await Record.find({ directorUserId: director._id }).lean();
  expect(rows.reduce((sum, row) => sum + row.commissionEarnedCents, 0)).toBe(551225);
  expect(rows.find(row => String(row._id) === String(records[0]._id)).stage).toBe('suppressed');
});

test('analytics counts each allocated Matter on its completion day and keeps lifetime progress', async () => {
  const old = new Date('2020-01-01T12:00:00Z');
  await Case.collection.updateMany({ _id: { $in: matters.slice(0, 48).map(row => row._id) } }, { $set: { completedAt: old } });
  const response = await get('/api/director/analytics?days=7'); expect(response.status).toBe(200);
  expect(response.body.totals.commissionableMatters).toBe(2);
  expect(response.body.commissionLifetime.commissionableMatterCount).toBe(50);
});

test('exact completion ties use a stable Matter identifier and keep repeated reads unchanged', async () => {
  await Case.collection.updateMany({}, { $set: { completedAt: new Date('2026-09-01T12:00:00Z') } });
  const expected = matters.slice().sort((a, b) => String(a._id).localeCompare(String(b._id))).slice(0, 50).reduce((sum, row) => sum + Math.round(row.feeAttorneyAmount * 0.5), 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await get('/api/director/records?rangeDays=30'); expect(response.status).toBe(200);
    expect(response.body.records.reduce((sum, row) => sum + row.commissionEarnedCents, 0)).toBe(expected);
  }
});

test('a direct manual-payment request refreshes the shared cap before recording an amount', async () => {
  await Record.collection.updateOne({ _id: records[0]._id }, { $set: { commissionEarnedCents: 900000, commissionableMatterCount: 60 } });
  const audit = await request(app).get(`/api/admin/directors/records/${records[0]._id}/audit`).set('Cookie', await cookie(admin)); expect(audit.status).toBe(200);
  const response = await request(app).patch(`/api/admin/directors/records/${records[0]._id}/commission-payout`).set('Cookie', await cookie(admin)).send({ requestId: require('crypto').randomUUID(), revision: audit.body.record.commissionPayments.revision, action: 'payment', amountCents: 275600, currency: 'USD', stripeMode: 'test', paidDate: '2026-09-01', reference: 'Synthetic cap payment', note: 'Private synthetic record.', reconcileLegacy: false });
  expect(response.status).toBe(200);
  expect(response.body.record.commissionEarnedCents).toBe(275600);
  expect(response.body.record.commissionableMatterCount).toBe(25);
});

test('a cached payable beyond the director cap cannot be marked paid', async () => {
  await Case.collection.updateMany({ _id: { $in: matters.slice(0, 50).map(row => row._id) } }, { $set: { attorney: attorneys[0]._id, attorneyId: attorneys[0]._id } });
  await Case.collection.updateMany({ _id: { $in: matters.slice(50).map(row => row._id) } }, { $set: { attorney: attorneys[1]._id, attorneyId: attorneys[1]._id } });
  await Income.collection.updateMany({ caseId: { $in: matters.slice(0, 50).map(row => row._id) } }, { $set: { attorneyId: attorneys[0]._id } });
  await Income.collection.updateMany({ caseId: { $in: matters.slice(50).map(row => row._id) } }, { $set: { attorneyId: attorneys[1]._id } });
  await Record.collection.updateOne({ _id: records[1]._id }, { $set: { commissionEarnedCents: 11000, commissionableMatterCount: 1 } });
  const audit = await request(app).get(`/api/admin/directors/records/${records[1]._id}/audit`).set('Cookie', await cookie(admin)); expect(audit.status).toBe(200);
  const response = await request(app).patch(`/api/admin/directors/records/${records[1]._id}/commission-payout`).set('Cookie', await cookie(admin)).send({ requestId: require('crypto').randomUUID(), revision: audit.body.record.commissionPayments.revision, action: 'payment', amountCents: 11000, currency: 'USD', stripeMode: 'test', paidDate: '2026-09-01', reference: 'Synthetic cap payment', note: 'Private synthetic record.', reconcileLegacy: false });
  expect(response.status).toBe(400);
  expect((await Record.findById(records[1]._id)).commissionPayoutStatus).toBe('unpaid');
});
