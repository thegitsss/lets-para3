const express = require('express'), cookieParser = require('cookie-parser'), request = require('supertest'), { Types } = require('mongoose');
jest.mock('../utils/stripe', () => ({ paymentIntents: { retrieve: jest.fn() }, charges: { retrieve: jest.fn() }, refunds: { list: jest.fn() } }));
const User = require('../models/User'), Case = require('../models/Case'), Operation = require('../models/PaymentOperation');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/payments', require('../routes/payments'));
let owner, other;
beforeAll(connect, 90000); afterAll(closeDatabase); beforeEach(async () => { await clearDatabase(); [owner, other] = await User.create(['owner','other'].map(name => ({ firstName: 'Synthetic', lastName: name, email: `${name}@legacy-history.test`, password: 'Synthetic123!', role: 'attorney', status: 'approved' }))); });
const cookie = () => `token=${require('jsonwebtoken').sign({ id: String(owner._id), role: 'attorney', av: owner.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const get = (path, query = {}) => request(app).get(`/api/payments/${path}`).set('Cookie', cookie()).query({ expectedOwnerId: String(owner._id), ...query });
async function matter(patch = {}, recorded = true) {
  const _id = new Types.ObjectId(), doc = { _id, attorney: owner._id, attorneyId: owner._id, title: 'River Street', status: 'in progress', paymentReleased: false, totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, currency: 'usd', stripeMode: 'test', paymentIntentId: `pi_${_id}`, escrowIntentId: `pi_${_id}`, escrowStatus: 'funded', fundingIntegrityStatus: 'verified', withdrawalHistory: [], createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-08'), ...patch };
  await Case.collection.insertOne(doc);
  if (recorded) await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: _id, kind: 'funding', operationKey: `funding:${_id}:${doc.paymentIntentId}`, status: 'succeeded', amount: 48800, currency: doc.currency, stripeObjectId: doc.paymentIntentId, stripePaymentIntentId: doc.paymentIntentId, stripeChargeId: `ch_${_id}`, stripeBalanceTransactionId: `txn_${_id}`, grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, stripeMode: 'test', livemode: false, evidenceVerifiedAt: new Date('2026-01-03'), createdAt: new Date('2026-01-02') });
  return doc;
}
test('original history retains the same original funding event before Matter completion', async () => {
  await matter(); const expected = await get('attorney-financial-history'); expect(expected.status).toBe(200); expect(expected.body.entries[0]).toMatchObject({ type: 'funding', state: 'recorded', amount: 48800, currency: 'USD' });
  const actual = await get('history'); expect(actual.status).toBe(200); expect(actual.body).toEqual(expected.body);
});
test('completion flags cannot become a paid amount or manufactured payment date in original history', async () => {
  await matter({ status: 'completed', paymentReleased: true, payoutStatus: 'paid' }, false);
  const actual = await get('history'); expect(actual.status).toBe(200); expect(actual.body.entries).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'funding', state: 'needs_review', recordedAt: null })])); expect(actual.body.totalSpent).toBeUndefined();
});
test('the original export preserves reviewed filters, currencies and exact shared CSV bytes', async () => {
  await matter(); await matter({ currency: 'eur', title: '=Private formula title' });
  const query = { view: 'funding', q: 'formula' }, reviewed = await get('attorney-financial-history', query); expect(reviewed.status).toBe(200); expect(reviewed.body.total).toBe(1);
  const expected = await get('attorney-financial-history/csv', { ...query, revision: reviewed.body.revision }); expect(expected.status).toBe(200); expect(expected.text).toContain('EUR'); expect(expected.text).toContain("'=Private formula title");
  const actual = await get('export/csv', { ...query, revision: reviewed.body.revision }); expect(actual.status).toBe(200); expect(actual.text).toBe(expected.text);
});
test('original history and export refuse a replaced expected owner', async () => {
  await matter(); expect((await get('history', { expectedOwnerId: String(other._id) })).status).toBe(403); expect((await get('export/csv', { expectedOwnerId: String(other._id), revision: 'a'.repeat(64) })).status).toBe(403);
});
test('original CSV refuses an unreviewed or changed inventory instead of exporting a different history', async () => {
  const doc = await matter(), reviewed = await get('attorney-financial-history'); expect(reviewed.status).toBe(200);
  expect((await get('export/csv')).status).toBe(400);
  await Case.collection.updateOne({ _id: doc._id }, { $set: { title: 'Changed after review' } });
  expect((await get('export/csv', { revision: reviewed.body.revision })).status).toBe(409);
});
