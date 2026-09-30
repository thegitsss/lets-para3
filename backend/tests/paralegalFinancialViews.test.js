const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
process.env.STRIPE_SECRET_KEY = 'sk_test_paralegal_financial_views';
jest.mock('../services/caseLifecycle', () => ({ buildReceiptPdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4\nSynthetic history receipt\n')), uploadPdfToS3: jest.fn(), getReceiptKey: jest.fn() }));
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User'), Case = require('../models/Case'), Payout = require('../models/Payout'), Operation = require('../models/PaymentOperation');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/payments', require('../routes/payments')); app.use('/api/cases', require('../routes/cases')); app.use('/api/paralegal/dashboard', require('../routes/paralegalDashboard'));
let attorney, para, matter, payout, operation;
const get = (path, query = {}) => request(app).get(path).query(query).set('Cookie', `token=${jwt.sign({ id: String(para._id), role: 'paralegal', av: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`);
const history = query => get('/api/cases/my-completed', query), dashboard = () => get('/api/paralegal/dashboard');
function clientCheck(moduleName, functionName, payload, ownerId) {
  const url = require('url').pathToFileURL(require('path').resolve(__dirname, `../../frontend/assets/scripts/utils/${moduleName}.mjs`)).href;
  require('child_process').execFileSync(process.execPath, ['--input-type=module', '--eval', `import {${functionName}} from ${JSON.stringify(url)}; import fs from 'node:fs'; const value=JSON.parse(fs.readFileSync(0,'utf8')); ${functionName}(value.payload,value.ownerId);`], { input: JSON.stringify({ payload, ownerId }), stdio: ['pipe', 'pipe', 'pipe'] });
}

beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  const stripe = require('../utils/stripe');
  for (const resource of ['customers', 'paymentIntents', 'charges', 'transfers', 'refunds']) for (const method of ['retrieve', 'create', 'list', 'update']) if (typeof stripe[resource]?.[method] === 'function') jest.spyOn(stripe[resource], method).mockImplementation(async () => { throw Error('Financial view checks must not call the provider'); });
  [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@paralegal-financial-views.test`, password: 'Synthetic123!', role, status: 'approved' })));
  const at = new Date('2026-09-01T12:00:00Z');
  matter = await Case.create({ title: 'River Street payout history', details: 'Private financial view agreement.', attorney: attorney._id, attorneyId: attorney._id, status: 'paused', pausedReason: 'paralegal_withdrew', withdrawnParalegalId: para._id, partialPayoutAmount: 10000, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', pausedAt: new Date(at.getTime() - 1000), payoutTransferId: 'tr_paralegal_views', totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 30000, feeParalegalPct: 18, currency: 'usd', stripeMode: 'test' });
  payout = await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: `partial_payout:${matter._id}:earlier`, amountPaid: 8100, transferId: 'tr_paralegal_views', status: 'paid', stripeMode: 'test', createdAt: at });
  operation = await Operation.create({ caseId: matter._id, operationKey: payout.operationKey, kind: 'partial_payout', fingerprint: 'paralegal_views', amount: 8100, transferAmount: 8100, currency: 'usd', status: 'succeeded', stripeTransferId: payout.transferId, stripeObjectId: payout.transferId, stripeMode: 'test' });
});
test('history shows the recorded net instead of recalculating it using the current fee', async () => {
  const response = await history(); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ paymentAmount: 81, payoutState: 'recorded', stripeMode: 'test', receiptAvailable: true });
  clientCheck('paralegal-history', 'readHistoryPage', response.body, String(para._id));
});
test.each(['reversed', 'pending', 'needs_review'])('history keeps a %s payout distinct from a recorded payment', async state => {
  if (state === 'needs_review') await Operation.collection.updateOne({ _id: operation._id }, { $set: { evidenceStatus: 'quarantined' } });
  else await Payout.collection.updateOne({ _id: payout._id }, { $set: { status: state } });
  const response = await history(); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ paymentAmount: null, payoutState: state, receiptAvailable: false });
});
test.each([['completed', false, 'completed'], ['closed', false, 'closed'], ['in progress', true, 'needs_review']])('a %s Matter without a payout retains its work state without inventing a zero payment', async (status, paymentReleased, workState) => {
  await Payout.deleteMany({}); await Operation.deleteMany({});
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegal: para._id, paralegalId: para._id, status, paymentReleased, withdrawnParalegalId: null, payoutFinalizedAt: null, payoutFinalizedType: null, partialPayoutAmount: null, payoutTransferId: '' } });
  const response = await history(); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ workState, paymentAmount: null, payoutState: 'unconfirmed', receiptAvailable: false });
  clientCheck('paralegal-history', 'readHistoryPage', response.body, String(para._id));
});
test('each earlier assignment keeps its exact receipt selection when the same payee later receives zero', async () => {
  const raw = await Case.collection.findOne({ _id: matter._id }), names = ['withdrawnParalegalId', 'payoutFinalizedAt', 'payoutFinalizedType', 'partialPayoutAmount', 'payoutTransferId', 'pausedAt'];
  const earlier = Object.fromEntries(names.map(name => [name, raw[name]]));
  await Case.collection.updateOne({ _id: matter._id }, { $set: { withdrawalHistory: [earlier], partialPayoutAmount: 0, payoutFinalizedAt: new Date('2026-09-04T12:00:00Z'), payoutFinalizedType: 'zero_auto', payoutTransferId: '', pausedAt: new Date('2026-09-04T11:00:00Z') } });
  const entries = require('../services/attorneyReceiptHistory').inventory(await Case.collection.findOne({ _id: matter._id })).filter(entry => entry.record);
  const response = await history(); expect(response.status).toBe(200); const item = response.body.items[0];
  expect(item).toMatchObject({ paymentAmount: 0, payoutState: 'no_payout', receiptId: entries[0].id });
  expect(item.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ receiptId: entries[0].id, payoutState: 'no_payout', paymentAmount: 0 }), expect.objectContaining({ receiptId: entries[1].id, payoutState: 'recorded', paymentAmount: 81 })]));
  for (const receipt of item.receipts) { const link = new URL(receipt.href, 'http://localhost'); expect(link.pathname).toBe(`/api/payments/receipt/paralegal/${matter._id}`); expect(link.searchParams.get('receiptId')).toBe(receipt.receiptId); expect(link.searchParams.get('expectedOwnerId')).toBe(String(para._id)); }
});
test('history checks the expected signed-in account', async () => {
  const response = await history({ expectedOwnerId: String(attorney._id) }); expect(response.status).toBe(403); expect(response.body.items).toBeUndefined();
});
test('an account revoked after its payout read cannot receive the old history', async () => {
  const find = Payout.collection.find.bind(Payout.collection); let reached = false;
  jest.spyOn(Payout.collection, 'find').mockImplementation((...args) => { const cursor = find(...args), read = cursor.toArray.bind(cursor); cursor.toArray = async () => { const result = await read(); if (!reached) { reached = true; await User.collection.updateOne({ _id: para._id }, { $inc: { authVersion: 1 } }); } return result; }; return cursor; });
  const response = await history(); expect(reached).toBe(true); expect(response.status).toBe(403); expect(response.body.items).toBeUndefined();
});
test('earnings retain currency and provider mode instead of presenting every amount as dollars', async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { currency: 'eur' } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { currency: 'eur' } });
  const response = await dashboard(); expect(response.status).toBe(200);
  expect(response.body.metrics.earningsReport).toMatchObject({ currencies: [expect.objectContaining({ currency: 'EUR', stripeMode: 'test', total: 8100 })], requiresReview: 0 });
});
test('missing payout dates do not silently produce exact zero period totals', async () => {
  await Payout.collection.updateOne({ _id: payout._id }, { $unset: { createdAt: '' } });
  const response = await dashboard(); expect(response.status).toBe(200);
  expect(response.body.metrics.earningsReport).toMatchObject({ undated: 1, currencies: [expect.objectContaining({ currency: 'USD', stripeMode: 'test', total: 8100, month: null, last30: null })] });
});
test('earnings expose records requiring review instead of making them indistinguishable from no payouts', async () => {
  await Operation.collection.updateOne({ _id: operation._id }, { $set: { status: 'needs_reconciliation' } });
  const response = await dashboard(); expect(response.status).toBe(200);
  expect(response.body.metrics.earningsReport).toMatchObject({ requiresReview: 1, states: { needs_review: 1 } });
});

test('a displayed history receipt downloads with its exact content revision', async () => {
  const response = await history(); expect(response.status).toBe(200);
  const receipt = response.body.items[0].receipts[0];
  expect(receipt.receiptRevision).toMatch(/^[a-f0-9]{64}$/);
  const download = await get(receipt.href); expect(download.status).toBe(200); expect(download.headers['content-type']).toContain('application/pdf');
  expect(require('../services/caseLifecycle').buildReceiptPdfBuffer).toHaveBeenCalledWith(expect.objectContaining({ totalAmount: '$81.00' }));
});
test.each(['amount', 'name', 'currency', 'mode'])('a changed %s cannot download the previously reviewed history receipt', async change => {
  const response = await history(); expect(response.status).toBe(200); const receipt = response.body.items[0].receipts[0];
  if (change === 'amount') { await Payout.collection.updateOne({ _id: payout._id }, { $set: { amountPaid: 8000 } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { amount: 8000, transferAmount: 8000 } }); }
  if (change === 'name') await User.collection.updateOne({ _id: para._id }, { $set: { firstName: 'Updated' } });
  if (change === 'currency') { await Case.collection.updateOne({ _id: matter._id }, { $set: { currency: 'eur' } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { currency: 'eur' } }); }
  if (change === 'mode') { await Case.collection.updateOne({ _id: matter._id }, { $set: { stripeMode: 'live' } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { stripeMode: 'live' } }); await Payout.collection.updateOne({ _id: payout._id }, { $set: { stripeMode: 'live' } }); }
  const download = await get(receipt.href); expect({ status: download.status, body: download.body }).toMatchObject({ status: 409 });
  expect(require('../services/caseLifecycle').buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
async function addHistory(count) {
  const { Types } = require('mongoose');
  const docs = Array.from({ length: count }, (_, i) => ({ _id: new Types.ObjectId(), title: `Retained Matter ${i}`, attorney: String(attorney._id), attorneyId: String(attorney._id), paralegal: String(para._id), paralegalId: String(para._id), status: 'completed', completedAt: new Date('2026-08-01T00:00:00Z'), currency: 'usd' }));
  await Case.collection.insertMany(docs); return docs;
}
test('history covers more than one hundred records including retained string owners without repeats', async () => {
  await addHistory(103);
  const first = await history(); expect(first.status).toBe(200); expect(first.body.items).toHaveLength(100); expect(first.body.page).toMatchObject({ total: 104, hasMore: true, offset: 0 });
  const next = await history({ cursor: first.body.page.nextCursor }); expect(next.status).toBe(200); expect(next.body.page).toMatchObject({ total: 104, hasMore: false, offset: 100, nextCursor: null });
  expect(new Set([...first.body.items, ...next.body.items].map(item => item.caseId)).size).toBe(104);
  expect(next.body.revision).toBe(first.body.revision);
});
test.each(['new record', 'payout changed'])('history rejects the next page after a %s', async change => {
  await addHistory(2); const first = await history({ limit: '1' }); expect(first.status).toBe(200);
  if (change === 'new record') await addHistory(1); else await Payout.collection.updateOne({ _id: payout._id }, { $set: { status: 'reversed' } });
  const next = await history({ limit: '1', cursor: first.body.page.nextCursor }); expect(next.status).toBe(409); expect(next.body.items).toBeUndefined();
});
test('earnings DTO stays scoped to its expected owner', async () => {
  const response = await dashboard(); expect(response.status).toBe(200); expect(response.body.metrics.earningsReport.ownerId).toBe(String(para._id));
  clientCheck('paralegal-financials', 'readEarningsReport', response.body.metrics.earningsReport, String(para._id));
  clientCheck('paralegal-financials', 'readExpectedCompensation', response.body.metrics.expectedCompensation, String(para._id));
});
test('history retains the existing block policy while an open dispute is recorded', async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { disputes: [{ status: 'open', disputeId: 'synthetic-open-dispute' }] } });
  const response = await history(); expect(response.status).toBe(200);
  const expected = require('../utils/blocks').getCaseBlockEligibility(await Case.collection.findOne({ _id: matter._id }), { id: String(para._id), role: 'paralegal' });
  expect(expected.eligible).toBe(false);
  expect(response.body.items[0]).toMatchObject({ isDisputed: true, canDispute: false, blockStatus: { canBlock: false, reason: expected.reason } });
});

test('retained review status exposes the current withdrawal review without inventing a payout', async () => {
  await Payout.deleteMany({}); await Operation.deleteMany({});
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'disputed', pausedReason: 'dispute', payoutFinalizedAt: null, payoutFinalizedType: null, partialPayoutAmount: null, payoutTransferId: '', payoutStatus: null, disputes: [{ disputeId: 'synthetic-history-review', status: 'open', createdAt: new Date() }] } });
  const response = await history(); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ reviewState: 'open', paymentAmount: null, receiptAvailable: false });
  clientCheck('paralegal-history', 'readHistoryPage', response.body, String(para._id));
});

async function retainPriorPayoutWithOpenReview({ anotherPayee = false } = {}) {
  const raw = await Case.collection.findOne({ _id: matter._id });
  const earlier = Object.fromEntries(['withdrawnParalegalId','payoutFinalizedAt','payoutFinalizedType','partialPayoutAmount','payoutTransferId','pausedAt'].map(key => [key,raw[key]]));
  await Case.collection.updateOne({ _id: matter._id }, { $set: { withdrawalHistory: [earlier], withdrawnParalegalId: anotherPayee ? new (require('mongoose').Types.ObjectId)() : para._id, status: 'disputed', pausedReason: 'dispute', pausedAt: new Date(), payoutFinalizedAt: null, payoutFinalizedType: null, partialPayoutAmount: null, payoutTransferId: '', payoutStatus: null, disputes: [{ disputeId: 'synthetic-current-review', status: 'open', createdAt: new Date() }] } });
}
test('the same payee sees the current open review while their earlier payout remains recorded', async () => {
  await retainPriorPayoutWithOpenReview(); const response = await history(); expect(response.status).toBe(200);
  const item = response.body.items[0]; expect(item.reviewState).toBe('open'); expect(item.receipts.some(row => row.payoutState === 'recorded' && row.paymentAmount === 81)).toBe(true);
});
test('an earlier payee is not shown another assignment’s review as their own pending decision', async () => {
  await retainPriorPayoutWithOpenReview({ anotherPayee: true }); const response = await history(); expect(response.status).toBe(200);
  expect(response.body.items[0].reviewState).toBeNull(); expect(response.body.items[0].receipts.some(row => row.payoutState === 'recorded')).toBe(true);
});
test.each([{ status: 'paused' }, { pausedReason: 'paralegal_withdrew' }, { purgedAt: new Date() }, { 'disputes.0.status': 'resolved' }, { disputes: [{ status: 'open', disputeId: 'first' }, { status: 'open', disputeId: 'second' }] }, { payoutFinalizedAt: new Date() }])('contradictory or finalized review evidence %j does not claim an open withdrawal review', async patch => {
  await retainPriorPayoutWithOpenReview(); await Case.collection.updateOne({ _id: matter._id }, { $set: patch });
  const response = await history(); expect(response.status).toBe(200); expect(response.body.items[0].reviewState).toBeNull();
});
