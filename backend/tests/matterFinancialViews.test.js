const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
process.env.STRIPE_SECRET_KEY = 'sk_test_matter_financial_views';
jest.mock('../services/caseLifecycle', () => ({ buildReceiptPdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4\nSynthetic Matter receipt\n')), uploadPdfToS3: jest.fn(), getReceiptKey: jest.fn() }));
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User'), Case = require('../models/Case'), Payout = require('../models/Payout'), Operation = require('../models/PaymentOperation');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/cases', require('../routes/cases')); app.use('/api/payments', require('../routes/payments'));
let attorney, para, matter, payout, operation;
const get = (path, person = para, query = {}) => request(app).get(path).query(query).set('Cookie', `token=${jwt.sign({ id: String(person._id), role: person.role, status: person.status, av: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`);
const view = (person = para, query) => get(`/api/cases/${matter._id}`, person, query);
function clientCheck(value, person) {
  const url = require('url').pathToFileURL(require('path').resolve(__dirname, '../../frontend/assets/scripts/utils/matter-financials.mjs')).href;
  require('child_process').execFileSync(process.execPath, ['--input-type=module', '--eval', `import {readMatterFinancials} from ${JSON.stringify(url)}; import fs from 'node:fs'; const v=JSON.parse(fs.readFileSync(0,'utf8')); readMatterFinancials(v.value,v.context);`], { input: JSON.stringify({ value, context: { ownerId: String(person._id), role: person.role, caseId: String(matter._id) } }), stdio: ['pipe', 'pipe', 'pipe'] });
}
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  const stripe = require('../utils/stripe');
  for (const resource of ['customers', 'paymentIntents', 'charges', 'transfers', 'refunds']) for (const method of ['retrieve', 'create', 'list', 'update']) if (typeof stripe[resource]?.[method] === 'function') jest.spyOn(stripe[resource], method).mockImplementation(async () => { throw Error('Matter financial reads must not call the provider'); });
  [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@matter-financial-views.test`, password: 'Synthetic123!', role, status: 'approved' })));
  const at = new Date('2026-09-01T12:00:00Z');
  matter = await Case.create({ title: 'Retained Matter payout', details: 'Private Matter financial agreement.', attorney: attorney._id, attorneyId: attorney._id, paralegal: para._id, paralegalId: para._id, status: 'paused', pausedReason: 'paralegal_withdrew', withdrawnParalegalId: para._id, partialPayoutAmount: 10000, payoutFinalizedType: 'partial_attorney', payoutFinalizedAt: at, pausedAt: new Date(at.getTime() - 1000), paymentReleased: false, payoutStatus: 'paid', payoutTransferId: 'tr_matter_views', totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 30000, feeParalegalPct: 18, feeParalegalAmount: 7200, currency: 'usd', stripeMode: 'test' });
  payout = await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: `partial_payout:${matter._id}:decision`, amountPaid: 8100, transferId: 'tr_matter_views', status: 'paid', stripeMode: 'test', createdAt: at });
  operation = await Operation.create({ caseId: matter._id, operationKey: payout.operationKey, kind: 'partial_payout', fingerprint: 'matter_views', amount: 8100, transferAmount: 8100, currency: 'usd', status: 'succeeded', stripeTransferId: payout.transferId, stripeObjectId: payout.transferId, stripeMode: 'test' });
});
test('Matter net and exact receipt agree with retained payout despite the current fee', async () => {
  const response = await view(); expect({ status: response.status, error: response.body.error }).toMatchObject({ status: 200 });
  const value = response.body.matterExperience.financials;
  clientCheck(value, para);
  expect(value.amounts).toContainEqual(expect.objectContaining({ code: 'net', cents: 8100 }));
  expect(value).toMatchObject({ ownerId: String(para._id), caseId: String(matter._id), stripeMode: 'test', state: 'recorded', receiptHref: null });
  expect(value.receipts).toHaveLength(1); expect(value.receipts[0]).toMatchObject({ paymentAmount: 81, receiptAvailable: true });
  const download = await get(value.receipts[0].href); expect(download.status).toBe(200);
  expect(require('../services/caseLifecycle').buildReceiptPdfBuffer).toHaveBeenCalledWith(expect.objectContaining({ totalAmount: '$81.00' }));
});
test.each(['reversed', 'pending', 'needs_review'])('Matter does not promise a completed payout for %s evidence', async state => {
  if (state === 'needs_review') await Operation.collection.updateOne({ _id: operation._id }, { $set: { evidenceStatus: 'quarantined' } });
  else await Payout.collection.updateOne({ _id: payout._id }, { $set: { status: state } });
  const response = await view(); expect({ status: response.status, error: response.body.error }).toMatchObject({ status: 200 });
  const value = response.body.matterExperience.financials;
  clientCheck(value, para);
  expect(value.amounts.some(row => row.code === 'net')).toBe(false);
  expect(value.receiptHref).toBeNull(); expect(value.receipts[0]).toMatchObject({ payoutState: state, paymentAmount: null, receiptAvailable: false });
});
test('paralegal Matter accepts its own expected account and rejects another account', async () => {
  const positive = await view(para, { expectedOwnerId: String(para._id) }); expect({ status: positive.status, error: positive.body.error }).toMatchObject({ status: 200 });
  const negative = await view(para, { expectedOwnerId: String(attorney._id) }); expect(negative.status).toBe(403);
  expect(negative.body.matterExperience).toBeUndefined();
});
test('Matter financial reads detect a retained payout changed during the read', async () => {
  const find = Payout.collection.find.bind(Payout.collection); let reached = false;
  jest.spyOn(Payout.collection, 'find').mockImplementation((...args) => { const cursor = find(...args), read = cursor.toArray.bind(cursor); cursor.toArray = async () => { const result = await read(); if (!reached) { reached = true; await Payout.collection.updateOne({ _id: payout._id }, { $set: { status: 'reversed' } }); } return result; }; return cursor; });
  const response = await view(); expect(reached).toBe(true); expect(response.status).toBe(409); expect(response.body.matterExperience).toBeUndefined();
});
test('Matter financial reads detect an account revoked after payout inventory', async () => {
  const find = Payout.collection.find.bind(Payout.collection); let reached = false;
  jest.spyOn(Payout.collection, 'find').mockImplementation((...args) => { const cursor = find(...args), read = cursor.toArray.bind(cursor); cursor.toArray = async () => { const result = await read(); if (!reached) { reached = true; await User.collection.updateOne({ _id: para._id }, { $inc: { authVersion: 1 } }); } return result; }; return cursor; });
  const response = await view(); expect(reached).toBe(true); expect(response.status).toBe(403); expect(response.body.matterExperience).toBeUndefined();
});

test('completed Matters remain inaccessible to the paralegal', async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'completed' } });
  const response = await view(); expect(response.status).toBe(403);
  expect(response.body.error).toMatch(/Completed Matters are no longer accessible/);
  expect(response.body.matterExperience).toBeUndefined();
});

async function fundedReassignment() {
  const raw = await Case.collection.findOne({ _id: matter._id });
  const previous = Object.fromEntries(['withdrawnParalegalId', 'partialPayoutAmount', 'payoutFinalizedType', 'payoutFinalizedAt', 'payoutTransferId', 'pausedAt'].map(key => [key, raw[key]]));
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'in progress', pausedReason: null, pausedAt: null, withdrawnParalegalId: null, payoutFinalizedAt: null, payoutFinalizedType: null, partialPayoutAmount: null, payoutTransferId: '', payoutStatus: 'not_started', withdrawalHistory: [previous], escrowStatus: 'funded', fundingIntegrityStatus: 'verified', escrowIntentId: 'pi_matter_views', paymentIntentId: 'pi_matter_views', feeAttorneyPct: 22, feeAttorneyAmount: 8800 } });
  await Operation.create({ caseId: matter._id, operationKey: `funding:${matter._id}:pi_matter_views`, kind: 'funding', fingerprint: 'matter_funding', status: 'succeeded', amount: 48800, currency: 'usd', stripePaymentIntentId: 'pi_matter_views', stripeObjectId: 'pi_matter_views', stripeChargeId: 'ch_matter_views', stripeBalanceTransactionId: 'txn_matter_views', grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, stripeMode: 'test', livemode: false, evidenceVerifiedAt: new Date('2026-08-31T12:00:00Z') });
}
test('a new assignment uses remaining funded compensation and retains the same payee earlier receipt separately', async () => {
  await fundedReassignment(); const response = await view(); expect(response.status).toBe(200);
  const value = response.body.matterExperience.financials; clientCheck(value, para);
  expect(value).toMatchObject({ state: 'estimate', receiptsAreEarlier: true, stripeMode: 'test' });
  expect(value.amounts).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'compensation', cents: 30000 }), expect.objectContaining({ code: 'paralegal_fee', cents: 5400 }), expect.objectContaining({ code: 'net', cents: 24600 })]));
  expect(value.receipts).toHaveLength(1); expect(value.receipts[0]).toMatchObject({ paymentAmount: 81, payoutState: 'recorded' });
});
test('attorney Matter balance agrees with the same retained funding and hides the paralegal net fee breakdown', async () => {
  await fundedReassignment(); const response = await view(attorney, { expectedOwnerId: String(attorney._id) }); expect(response.status).toBe(200);
  const value = response.body.matterExperience.financials; clientCheck(value, attorney);
  expect(value).toMatchObject({ state: 'active', role: 'attorney', stripeMode: 'test' });
  expect(value.amounts).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'funding', cents: 48800 }), expect.objectContaining({ code: 'held', cents: 30000 })]));
  expect(value.amounts.some(row => ['net', 'paralegal_fee'].includes(row.code))).toBe(false);
  expect(value.receipts).toEqual([]);
});
test.each(['paralegal', 'attorney'])('unsupported currencies never become USD in the %s Matter projection', async role => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { currency: 'jpy' } });
  const person = role === 'attorney' ? attorney : para, response = await view(person); expect(response.status).toBe(200);
  const value = response.body.matterExperience.financials; clientCheck(value, person);
  expect(value.currency).toBeNull(); expect(value.amounts).toEqual([]);
});
test('an explicit zero withdrawal shows one zero and keeps its earlier positive receipt', async () => {
  const raw = await Case.collection.findOne({ _id: matter._id }), previous = Object.fromEntries(['withdrawnParalegalId', 'partialPayoutAmount', 'payoutFinalizedType', 'payoutFinalizedAt', 'payoutTransferId', 'pausedAt'].map(key => [key, raw[key]]));
  await Case.collection.updateOne({ _id: matter._id }, { $set: { withdrawalHistory: [previous], partialPayoutAmount: 0, payoutFinalizedAt: new Date('2026-09-04T12:00:00Z'), payoutFinalizedType: 'zero_auto', payoutTransferId: '', pausedAt: new Date('2026-09-04T11:00:00Z') } });
  const response = await view(); expect(response.status).toBe(200); const value = response.body.matterExperience.financials; clientCheck(value, para);
  expect(value).toMatchObject({ state: 'no_payout', receiptsAreEarlier: false });
  expect(value.amounts).toEqual([{ code: 'net', label: 'Net payout', cents: 0 }]);
  expect(value.receipts.map(row => row.paymentAmount)).toEqual([0, 81]);
});
test('unknown funding makes the estimate unavailable while the verified earlier receipt remains honest', async () => {
  await fundedReassignment(); await Operation.collection.updateOne({ kind: 'funding' }, { $set: { status: 'pending' } });
  const response = await view(); expect(response.status).toBe(200); const value = response.body.matterExperience.financials; clientCheck(value, para);
  expect(value).toMatchObject({ state: 'needs_review', amounts: [], receiptsAreEarlier: true });
  expect(value.receipts[0]).toMatchObject({ payoutState: 'recorded', paymentAmount: 81 });
});

test('an unrelated task update preserves the financial presentation revision while a changed payout does not', async () => {
  const first = await view(); expect(first.status).toBe(200);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { tasks: [{ title: 'Reviewed work', completed: true }], updatedAt: new Date(Date.now() + 2000) } });
  const unchanged = await view(); expect(unchanged.status).toBe(200);
  expect(unchanged.body.matterExperience.financials).toEqual(first.body.matterExperience.financials);
  await Payout.collection.updateOne({ _id: payout._id }, { $set: { status: 'reversed' } });
  const changed = await view(); expect(changed.status).toBe(200);
  expect(changed.body.matterExperience.financials.revision).not.toBe(first.body.matterExperience.financials.revision);
  expect(changed.body.matterExperience.financials.amounts).toEqual([]);
});

test.each([false, true])('a task update during financial verification is harmless only when payment data stays unchanged (financial change: %s)', async changeFinancials => {
  await fundedReassignment();
  const before = await view(); expect(before.status).toBe(200);
  let reached = false;
  const find = Payout.collection.find.bind(Payout.collection);
  jest.spyOn(Payout.collection, 'find').mockImplementation((...args) => {
    const cursor = find(...args), read = cursor.toArray.bind(cursor);
    cursor.toArray = async () => {
      const result = await read();
      if (!reached) {
        reached = true;
        await Case.collection.updateOne({ _id: matter._id }, { $set: { tasks: [{ title: 'Concurrent work update', completed: true }], updatedAt: new Date(Date.now() + 2000), ...(changeFinancials ? { feeParalegalPct: 20 } : {}) } });
      }
      return result;
    };
    return cursor;
  });
  const response = await view(); expect(reached).toBe(true);
  expect(response.status).toBe(changeFinancials ? 409 : 200);
  if (!changeFinancials) expect(response.body.matterExperience.financials).toEqual(before.body.matterExperience.financials);
});

test('an open Matter review explains the held payout without displaying unverified amounts', async () => {
  await Payout.deleteMany({}); await Operation.deleteMany({});
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'disputed', pausedReason: 'dispute', payoutStatus: 'not_started', payoutTransferId: '', payoutFinalizedAt: null, payoutFinalizedType: null, partialPayoutAmount: null, withdrawnParalegalId: null } });
  const response = await view(); expect(response.status).toBe(200);
  expect(response.body.matterExperience.financials).toMatchObject({ state: 'needs_review', status: 'Payment under LPC review', note: 'This Matter is under review. Final payout details are not available.', amounts: [], receipts: [] });
  clientCheck(response.body.matterExperience.financials, para);
});
