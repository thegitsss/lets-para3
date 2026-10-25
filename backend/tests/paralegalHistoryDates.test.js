'use strict';
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
process.env.STRIPE_SECRET_KEY = 'sk_test_history_dates_synthetic';
jest.mock('../utils/email', () => jest.fn(async () => { throw Error('History must not send mail'); }));
const User = require('../models/User');
const Case = require('../models/Case');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express();
app.use(require('cookie-parser')(), express.json());
app.use('/api/cases', require('../routes/cases'));
let attorney, para;
const updatedAt = new Date('2026-09-20T12:00:00.000Z');
const completedAt = new Date('2026-09-02T12:00:00.000Z');
const history = () => request(app).get('/api/cases/my-completed').query({ expectedOwnerId: String(para._id), reviewContexts: '1' }).set('Cookie', `token=${jwt.sign({ id: String(para._id), role: 'paralegal', av: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`);
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => {
  await clearDatabase();
  [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@history-dates.invalid`, password: 'Synthetic123!', role, status: 'approved' })));
});
async function seed(patch) {
  const doc = await Case.create({ title: 'Synthetic retained date', details: 'History date contract', attorney: attorney._id, attorneyId: attorney._id, paralegal: para._id, paralegalId: para._id, status: 'closed', currency: 'usd' });
  await Case.collection.updateOne({ _id: doc._id }, { $set: { completedAt: null, updatedAt, ...patch } });
  return doc;
}
async function observe(doc) {
  const before = await Case.collection.findOne({ _id: doc._id });
  const response = await history();
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body.items).toHaveLength(1);
  expect(await Case.collection.findOne({ _id: doc._id })).toEqual(before);
  expect(require('../utils/email')).not.toHaveBeenCalled();
  return response.body.items[0];
}
test.each(['closed', 'completed'])('%s history retains its actual update without inventing completion', async status => {
  const item = await observe(await seed({ status }));
  expect(item).toMatchObject({ workState: status, completedAt: null, updatedAt: updatedAt.toISOString(), paymentAmount: null, payoutState: 'unconfirmed' });
});
test.each(['closed', 'completed'])('%s history preserves distinct completion and later update timestamps', async status => {
  const item = await observe(await seed({ status, completedAt }));
  expect(item).toMatchObject({ completedAt: completedAt.toISOString(), updatedAt: updatedAt.toISOString() });
});
test.each([null, 'invalid'])('missing or invalid update %p remains unavailable without completion backfill', async update => {
  const item = await observe(await seed({ updatedAt: update }));
  expect(item).toMatchObject({ completedAt: null, updatedAt: null });
});
test('an invalid completion timestamp does not conceal the recorded update', async () => {
  const item = await observe(await seed({ completedAt: 'invalid' }));
  expect(item).toMatchObject({ completedAt: null, updatedAt: updatedAt.toISOString() });
});
test('a termination review stays distinct from a completed Matter', async () => {
  const requested = new Date('2026-09-10T12:00:00.000Z');
  const item = await observe(await seed({ status: 'disputed', pausedReason: 'dispute', paralegalAccessRevokedAt: requested, terminationRequestedAt: requested, terminationStatus: 'disputed', terminationDisputeId: 'synthetic-date-review', disputes: [{ disputeId: 'synthetic-date-review', status: 'open' }] }));
  expect(item).toMatchObject({ workState: 'needs_review', reviewState: 'open', reviewKind: 'termination', completedAt: null, updatedAt: null });
});

test('a former assignment never receives the current Matter update timestamp', async () => {
  const pausedAt = new Date('2026-09-01T12:00:00Z');
  const item = await observe(await seed({ status: 'paused', pausedReason: 'paralegal_withdrew', paralegal: null, paralegalId: null, withdrawnParalegalId: para._id, pausedAt, payoutFinalizedAt: new Date('2026-09-02T12:00:00Z'), payoutFinalizedType: 'zero_auto', partialPayoutAmount: 0, updatedAt: new Date('2026-10-25T12:00:00Z') }));
  expect(item).toMatchObject({ workState: 'withdrawn', completedAt: pausedAt.toISOString(), updatedAt: null });
});
