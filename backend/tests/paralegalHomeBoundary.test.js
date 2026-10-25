const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const { authCookieFor } = require('./helpers/phase2LifecycleFixture');
const User = require('../models/User'), Case = require('../models/Case');
const expectedCompensation = require('../services/paralegalExpectedCompensation');
const ensureCaseParticipant = require('../middleware/ensureCaseParticipant');
const app = express(); app.use(cookieParser()); app.use('/api/paralegal/dashboard', require('../routes/paralegalDashboard'));
app.get('/workspace/:caseId', require('../utils/verifyToken'), ensureCaseParticipant(), (_req, res) => res.json({ accessible: true }));
let attorney, paralegal, matter;
const dashboard = () => request(app).get('/api/paralegal/dashboard').query({ expectedOwnerId: String(paralegal._id) }).set('Cookie', authCookieFor(paralegal));
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => {
  await clearDatabase();
  [attorney, paralegal] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@home-boundary.test`, password: 'Synthetic123!', role, status: 'approved' })));
  matter = await Case.create({ title: 'PRIVATE_REVOKED_TITLE', details: 'Synthetic active assignment', attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: 'in progress', totalAmount: 40000, lockedTotalAmount: 40000, currency: 'usd', files: [{ filename: 'PRIVATE_REVOKED_FILE.pdf' }], updates: [{ text: 'PRIVATE_REVOKED_UPDATE' }] });
});
afterEach(() => jest.restoreAllMocks());

test('revoking workspace access removes Home work metadata without erasing the financial projection', async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { remainingAmount: 40000, feeParalegalPct: 18, feeAttorneyPct: 22, feeAttorneyAmount: 8800, escrowStatus: 'funded', fundingIntegrityStatus: 'verified', escrowIntentId: 'pi_home_boundary', paymentIntentId: 'pi_home_boundary', hiredAt: new Date() } });
  await require('../models/PaymentOperation').create({ caseId: matter._id, operationKey: `funding:${matter._id}:pi_home_boundary`, kind: 'funding', fingerprint: 'home_boundary', status: 'succeeded', amount: 48800, currency: 'usd', stripePaymentIntentId: 'pi_home_boundary', stripeObjectId: 'pi_home_boundary', stripeChargeId: 'ch_home_boundary', stripeBalanceTransactionId: 'txn_home_boundary', grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, stripeMode: 'test', livemode: false, evidenceVerifiedAt: new Date() });
  const before = await dashboard(); expect(before.status).toBe(200); expect(before.body.activeCases).toHaveLength(1);
  expect(before.body.metrics.expectedPayouts).toBe(328);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } });
  const stored = await Case.collection.findOne({ _id: matter._id });
  const workspace = await request(app).get(`/workspace/${matter._id}`).set('Cookie', authCookieFor(paralegal)); expect(workspace.status).toBe(403);
  const after = await dashboard(); expect(after.status).toBe(200);
  expect(after.body.activeCases).toEqual([]); expect(after.body.metrics.activeCases).toBe(0);
  expect(JSON.stringify(after.body)).not.toContain('PRIVATE_REVOKED_');
  expect(after.body.metrics.expectedCompensation.items).toEqual(before.body.metrics.expectedCompensation.items);
  expect(after.body.metrics.expectedPayouts).toBe(328);
  for (const field of ['ownerId', 'count', 'currencies', 'requiresReview', 'states']) expect(after.body.metrics.earningsReport[field]).toEqual(before.body.metrics.earningsReport[field]);
  expect(await Case.collection.findOne({ _id: matter._id })).toEqual(stored);
});

test('access revoked after the financial recheck cannot return the earlier Home work snapshot', async () => {
  const read = expectedCompensation.read; let calls = 0;
  jest.spyOn(expectedCompensation, 'read').mockImplementation(async (...args) => {
    const value = await read(...args);
    if (++calls === 2) await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } });
    return value;
  });
  const response = await dashboard(); expect(calls).toBe(2); expect(response.status).toBe(409);
  expect(response.body.activeCases).toBeUndefined(); expect(JSON.stringify(response.body)).not.toContain('PRIVATE_REVOKED_');
});

test('Home keeps the complete accessible assignment count while excluding revoked records', async () => {
  const raw = await Case.collection.findOne({ _id: matter._id });
  await Case.collection.insertMany(Array.from({ length: 102 }, (_, n) => ({ ...raw, _id: new (require('mongoose').Types.ObjectId)(), title: `Accessible Matter ${n}` })));
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegalAccessRevokedAt: new Date() } });
  const response = await dashboard(); expect(response.status).toBe(200); expect(response.body.activeCases).toHaveLength(102);
  expect(response.body.metrics.activeCases).toBe(102); expect(response.body.metrics.expectedCompensation.items).toHaveLength(103);
  expect(new Set(response.body.activeCases.map(row => row.caseId)).size).toBe(102);
});
