const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
process.env.STRIPE_SECRET_KEY = 'sk_test_admin_financial_agreement';
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
const User = require('../models/User'), Case = require('../models/Case'), Payout = require('../models/Payout'), Operation = require('../models/PaymentOperation'), Income = require('../models/PlatformIncome');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json());
app.use('/api/payments', require('../routes/payments'));
app.use('/api/admin/workspace', require('../routes/adminWorkspace'));
app.use('/api/admin', require('../routes/admin'));
let attorney, para, admin, matter, funding;
const savedFloor = [process.env.ADMIN_FINANCIAL_REPORTING_START_AT, process.env.FINANCIAL_REPORTING_START_AT];
const cookie = user => `token=${jwt.sign({ id: String(user._id), role: user.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const get = (path, query = {}, user = admin) => request(app).get(path).query(query).set('Cookie', cookie(user));
const owner = () => ({ expectedOwnerId: String(admin._id) });
const heldViews = [
  ['/api/admin/metrics', body => body.totals.escrowHeld],
  ['/api/admin/summary', body => body.totalEscrowHold],
  ['/api/admin/analytics', body => body.escrowMetrics.totalEscrowHeld],
];
async function makeMatter(key, currency = 'usd', mode = 'test') {
  const value = await Case.create({ title: `Synthetic admin agreement ${key}`, details: 'Retained same-record financial acceptance.', attorney: attorney._id, attorneyId: attorney._id, paralegal: para._id, paralegalId: para._id, status: 'in progress', totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000, feeAttorneyPct: 22, feeAttorneyAmount: 8800, feeParalegalPct: 18, currency, stripeMode: mode, escrowStatus: 'funded', fundingIntegrityStatus: 'verified', escrowIntentId: `pi_admin_${key}`, paymentIntentId: `pi_admin_${key}`, paymentReleased: false, payoutStatus: 'not_started' });
  const operation = await Operation.create({ caseId: value._id, operationKey: `funding:${value._id}:pi_admin_${key}`, kind: 'funding', fingerprint: key, status: 'succeeded', amount: 48800, currency, stripeMode: mode, livemode: mode === 'live', stripePaymentIntentId: `pi_admin_${key}`, stripeObjectId: `pi_admin_${key}`, stripeChargeId: `ch_admin_${key}`, stripeBalanceTransactionId: `txn_admin_${key}`, grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, evidenceVerifiedAt: new Date() });
  return { value, operation };
}
async function attorneyHeld() {
  const response = await get('/api/payments/escrow/active', { expectedOwnerId: String(attorney._id) }, attorney);
  expect(response.status).toBe(200); return response.body.total;
}
beforeAll(connect); afterAll(closeDatabase);
afterEach(() => {
  jest.restoreAllMocks();
  ['ADMIN_FINANCIAL_REPORTING_START_AT', 'FINANCIAL_REPORTING_START_AT'].forEach((key, i) => { if (savedFloor[i] === undefined) delete process.env[key]; else process.env[key] = savedFloor[i]; });
});
beforeEach(async () => {
  delete process.env.ADMIN_FINANCIAL_REPORTING_START_AT; delete process.env.FINANCIAL_REPORTING_START_AT;
  const stripe = require('../utils/stripe');
  for (const resource of ['customers', 'paymentIntents', 'charges', 'transfers', 'refunds', 'paymentMethods']) for (const method of ['create', 'retrieve', 'list', 'update']) if (typeof stripe[resource]?.[method] === 'function') jest.spyOn(stripe[resource], method).mockImplementation(async () => { throw Error('Provider calls are outside retained admin financial reads'); });
  await clearDatabase();
  [attorney, para, admin] = await User.create(['attorney', 'paralegal', 'admin'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@admin-financial-agreement.test`, password: 'Synthetic123!', role, status: 'approved' })));
  const created = await makeMatter('first'); matter = created.value; funding = created.operation;
});

test.each(heldViews)('verified current principal agrees with the attorney in %s', async (path, amount) => {
  expect(await attorneyHeld()).toBe(40000);
  const response = await get(path, owner()); expect(response.status).toBe(200); expect(amount(response.body)).toBe(40000);
});
test.each(heldViews)('an unfunded assignment is not money held in %s', async (path, amount) => {
  await Operation.deleteMany({ caseId: matter._id });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { escrowStatus: 'unfunded', fundingIntegrityStatus: 'pending' }, $unset: { escrowIntentId: '', paymentIntentId: '' } });
  expect(await attorneyHeld()).toBe(0);
  const response = await get(path, owner()); expect(response.status).toBe(200); expect(amount(response.body)).toBe(0);
});
test.each(heldViews)('unverified funding cannot become a confirmed held balance in %s', async (path, amount) => {
  await Operation.collection.updateOne({ _id: funding._id }, { $set: { status: 'needs_reconciliation' } });
  expect(await attorneyHeld()).toBeNull();
  const response = await get(path, owner()); expect(response.status).toBe(200); expect(amount(response.body)).toBeNull();
});
test.each(heldViews)('a retained earlier withdrawal reduces the current principal in %s', async (path, amount) => {
  const former = await User.create({ firstName: 'Synthetic', lastName: 'Former', email: 'former@admin-financial-agreement.test', password: 'Synthetic123!', role: 'paralegal', status: 'approved' });
  const at = new Date(), key = `partial_payout:${matter._id}:earlier`;
  await Payout.create({ caseId: matter._id, paralegalId: former._id, operationKey: key, amountPaid: 8200, transferId: 'tr_admin_earlier', status: 'paid', stripeMode: 'test', createdAt: at });
  await Operation.create({ caseId: matter._id, operationKey: key, kind: 'partial_payout', fingerprint: 'earlier', status: 'succeeded', amount: 8200, transferAmount: 8200, currency: 'usd', stripeMode: 'test', stripeTransferId: 'tr_admin_earlier', stripeObjectId: 'tr_admin_earlier' });
  await Case.collection.updateOne({ _id: matter._id }, { $set: { remainingAmount: 30000, withdrawalHistory: [{ withdrawnParalegalId: former._id, partialPayoutAmount: 10000, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', payoutTransferId: 'tr_admin_earlier', pausedAt: new Date(at.getTime() - 1000) }] } });
  expect(await attorneyHeld()).toBe(30000);
  const response = await get(path, owner()); expect(response.status).toBe(200); expect(amount(response.body)).toBe(30000);
});
test.each(heldViews)('EUR and USD cannot be combined into one dollar balance in %s', async (path, amount) => {
  await makeMatter('euro', 'eur');
  const response = await get(path, owner()); expect(response.status).toBe(200); expect(amount(response.body)).toBeNull();
});
test.each(heldViews)('test and live retained balances stay separate in %s', async (path, amount) => {
  await makeMatter('live', 'usd', 'live');
  const response = await get(path, owner()); expect(response.status).toBe(200); expect(amount(response.body)).toBeNull();
});
test.each(heldViews)('a reporting start does not erase older principal still held in %s', async (path, amount) => {
  process.env.ADMIN_FINANCIAL_REPORTING_START_AT = '2026-09-01T00:00:00Z';
  await Case.collection.updateOne({ _id: matter._id }, { $set: { createdAt: new Date('2026-08-01T00:00:00Z') } });
  expect(await attorneyHeld()).toBe(40000);
  const response = await get(path, owner()); expect(response.status).toBe(200); expect(amount(response.body)).toBe(40000);
});

test.each(['/api/admin/metrics', '/api/admin/summary', '/api/admin/analytics', '/api/admin/income', '/api/admin/funding-evidence', '/api/admin/workspace/finance/records', '/api/admin/workspace/finance/export', '/api/payments/receipts'])('the expected signed-in owner guards %s', async path => {
  const response = await get(path, { expectedOwnerId: String(para._id) }); expect(response.status).toBe(403);
});
test('a succeeded funding flag without verified amounts does not enter the funding totals', async () => {
  await Operation.collection.updateOne({ _id: funding._id }, { $set: { grossAmount: 48801 } });
  const response = await get('/api/admin/funding-evidence', owner()); expect(response.status).toBe(200);
  expect(response.body.totalsByMode?.test?.grossAmount).not.toBe(48801);
});
test('funding evidence does not add different currencies within the same provider mode', async () => {
  await makeMatter('euro', 'eur');
  const response = await get('/api/admin/funding-evidence', owner()); expect(response.status).toBe(200);
  expect(response.body.totalsByMode?.test?.grossAmount).not.toBe(97600);
});
const revenueViews = [['/api/admin/income', b => b.totalAmount], ['/api/admin/metrics', b => b.totals.totalRevenue], ['/api/admin/analytics', b => b.revenueMetrics.totalRevenue]];
test.each(revenueViews)('an unbacked income row cannot become collected revenue in %s', async (path, value) => {
  await Income.create({ caseId: matter._id, attorneyId: attorney._id, paralegalId: para._id, operationKey: `case_payout:${matter._id}`, feeAmount: 16000, stripeMode: 'test' });
  const response = await get(path, owner()); expect(response.status).toBe(200); expect(value(response.body)).not.toBe(16000);
});
test('verified completion income retains the exact attorney and paralegal fees', async () => {
  const at = new Date(), key = `case_payout:${matter._id}`;
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'completed', paymentReleased: true, payoutStatus: 'paid', payoutTransferId: 'tr_admin_completion', paidOutAt: at } });
  await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: key, amountPaid: 32800, transferId: 'tr_admin_completion', status: 'paid', stripeMode: 'test', createdAt: at });
  await Operation.create({ caseId: matter._id, operationKey: key, kind: 'case_payout', fingerprint: 'completion', status: 'succeeded', amount: 32800, transferAmount: 32800, currency: 'usd', stripeMode: 'test', stripeTransferId: 'tr_admin_completion', stripeObjectId: 'tr_admin_completion' });
  await Income.create({ caseId: matter._id, attorneyId: attorney._id, paralegalId: para._id, operationKey: key, feeAmount: 16000, stripeMode: 'test' });
  for (const [path, value] of revenueViews) {
    const response = await get(path, owner()); expect(response.status).toBe(200); expect(value(response.body)).toBe(16000);
  }
});
test.each(['/api/admin/workspace/finance/records', '/api/admin/workspace/finance/export'])('revocation during the income read prevents delivery from %s', async path => {
  await Income.create({ caseId: matter._id, attorneyId: attorney._id, paralegalId: para._id, operationKey: `case_payout:${matter._id}`, feeAmount: 16000, stripeMode: 'test' });
  const find = Income.collection.find.bind(Income.collection); let changed = false;
  jest.spyOn(Income.collection, 'find').mockImplementation((...args) => {
    const cursor = find(...args);
    for (const method of ['next', 'toArray']) {
      const original = cursor[method].bind(cursor);
      cursor[method] = async (...params) => {
        const value = await original(...params);
        if (!changed && (Array.isArray(value) ? value.length : value)) { changed = true; await User.collection.updateOne({ _id: admin._id }, { $inc: { authVersion: 1 } }); }
        return value;
      };
    }
    return cursor;
  });
  const response = await get(path, { ...owner(), kind: 'income' });
  expect(changed).toBe(true); expect(response.status).toBe(403);
  expect(response.text).not.toContain('Synthetic admin agreement');
});

async function retainCompletion() {
  const at = new Date(), key = `case_payout:${matter._id}`;
  await Case.collection.updateOne({ _id: matter._id }, { $set: { status: 'completed', paymentReleased: true, payoutStatus: 'paid', payoutTransferId: 'tr_admin_completion', paidOutAt: at } });
  const payout = await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: key, amountPaid: 32800, transferId: 'tr_admin_completion', status: 'paid', stripeMode: 'test', createdAt: at });
  const operation = await Operation.create({ caseId: matter._id, operationKey: key, kind: 'case_payout', fingerprint: 'completion', status: 'succeeded', amount: 32800, transferAmount: 32800, currency: 'usd', stripeMode: 'test', stripeTransferId: 'tr_admin_completion', stripeObjectId: 'tr_admin_completion' });
  const income = await Income.create({ caseId: matter._id, attorneyId: attorney._id, paralegalId: para._id, operationKey: key, feeAmount: 16000, stripeMode: 'test' });
  return { payout, operation, income };
}
test('a verified EUR report supplies euro chart units without changing USD compatibility totals', async () => {
  await retainCompletion();
  await Case.collection.updateOne({ _id: matter._id }, { $set: { currency: 'eur' } });
  await Operation.collection.updateMany({ caseId: matter._id }, { $set: { currency: 'eur' } });
  const response = await get('/api/admin/analytics', owner()); expect(response.status).toBe(200);
  expect(response.body.revenueMetrics).toMatchObject({ totalRevenue: null, chartAvailable: true, chartUnit: { currency: 'EUR', stripeMode: 'test' }, monthlyRevenue: [{ month: new Date().toISOString().slice(0, 7), revenue: 16000 }] });
  expect(response.body.escrowTrends).toMatchObject({ chartAvailable: true, unit: { currency: 'EUR', stripeMode: 'test' }, held: [48800], released: [32800] });
});
test('individually valid USD funding and EUR payouts cannot share a flow chart', async () => {
  await retainCompletion();
  await Case.collection.updateOne({ _id: matter._id }, { $set: { currency: 'eur' } });
  await Operation.collection.updateMany({ caseId: matter._id }, { $set: { currency: 'eur' } });
  await Operation.collection.updateOne({ _id: funding._id }, { $set: { createdAt: new Date('2020-01-01'), evidenceVerifiedAt: new Date('2020-01-01') } });
  await makeMatter('current_usd');
  const response = await get('/api/admin/analytics', owner()); expect(response.status).toBe(200);
  expect(response.body.escrowTrends).toMatchObject({ fundingAvailable: true, payoutAvailable: true, chartAvailable: false, unit: null });
});
test.each([
  ['wrong fee', async ({ income }) => Income.collection.updateOne({ _id: income._id }, { $set: { feeAmount: 16001 } })],
  ['wrong attorney', async ({ income }) => Income.collection.updateOne({ _id: income._id }, { $set: { attorneyId: para._id } })],
  ['wrong payee', async ({ income }) => Income.collection.updateOne({ _id: income._id }, { $set: { paralegalId: attorney._id } })],
  ['different provider mode', async ({ income }) => Income.collection.updateOne({ _id: income._id }, { $set: { stripeMode: 'live' } })],
  ['reversed payout', async ({ payout }) => Payout.collection.updateOne({ _id: payout._id }, { $set: { status: 'reversed' } })],
  ['unresolved operation', async ({ operation }) => Operation.collection.updateOne({ _id: operation._id }, { $set: { status: 'needs_reconciliation' } })],
  ['unverified original funding', async () => Operation.collection.updateOne({ _id: funding._id }, { $set: { grossAmount: 48801 } })],
  ['unbound legacy income', async ({ income }) => Income.collection.updateOne({ _id: income._id }, { $unset: { operationKey: '' } })],
])('income with %s remains an investigation record without a collected amount', async (_name, change) => {
  await change(await retainCompletion());
  const [income, records, analytics] = await Promise.all([get('/api/admin/income', owner()), get('/api/admin/workspace/finance/records', { ...owner(), kind: 'income' }), get('/api/admin/analytics', owner())]);
  for (const response of [income, records, analytics]) expect(response.status).toBe(200);
  expect(income.body.totalAmount).toBeNull(); expect(income.body.count).toBe(0);
  expect(records.body.items).toEqual([expect.objectContaining({ state: 'needs_review', amount: null, requestedAmount: expect.any(Number) })]);
  expect(analytics.body.revenueMetrics.totalRevenue).toBeNull();
});
test('verified amounts and modes agree across report, records, Matter and receipt index', async () => {
  await retainCompletion();
  const [analytics, payouts, income, index, context] = await Promise.all([
    get('/api/admin/analytics', owner()), get('/api/admin/workspace/finance/records', { ...owner(), kind: 'payouts' }),
    get('/api/admin/workspace/finance/records', { ...owner(), kind: 'income' }), get('/api/payments/receipts', owner()), get(`/api/admin/workspace/matters/${matter._id}`, owner()),
  ]);
  for (const response of [analytics, payouts, income, index, context]) expect(response.status).toBe(200);
  expect(analytics.body.escrowMetrics.totalEscrowHeld).toBe(0); expect(analytics.body.payoutMetrics.totalRecorded).toBe(32800);
  expect(payouts.body.items[0]).toMatchObject({ amount: 32800, state: 'recorded', currency: 'USD', stripeMode: 'test' });
  expect(income.body.items[0]).toMatchObject({ amount: 16000, state: 'recorded', basis: 'retained_platform_fee' });
  expect(context.body.financial.balance).toMatchObject({ status: 'settled', amountHeld: 0 });
  expect(context.body.payouts[0]).toMatchObject({ amount: 32800, state: 'recorded' });
  expect(index.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'Funding', amountCents: 48800, stripeMode: 'test' }), expect.objectContaining({ type: 'Payout', amountCents: 32800, party: 'Synthetic paralegal', stripeMode: 'test' })]));
});
test('an unfunded operational request remains searchable and exportable without confirming payment', async () => {
  await Operation.collection.updateOne({ _id: funding._id }, { $set: { grossAmount: 48801 } });
  const records = await get('/api/admin/workspace/finance/records', { ...owner(), q: 'pi_admin_first' });
  expect(records.status).toBe(200); expect(records.body.items[0]).toMatchObject({ amount: null, requestedAmount: 48800, state: 'needs_review', basis: 'funding_to_verify' });
  const csv = await get('/api/admin/workspace/finance/export', { ...owner(), q: 'pi_admin_first', revision: records.body.revision });
  expect(csv.status).toBe(200); expect(csv.text).toContain('"requestedAmount"'); expect(csv.text).toContain('"needs_review"'); expect(csv.text).toContain('"funding_to_verify"');
});
test('separate USD and EUR provider groups retain their exact amounts', async () => {
  await makeMatter('euro', 'eur'); await makeMatter('live', 'usd', 'live');
  const [metrics, funding] = await Promise.all([get('/api/admin/metrics', owner()), get('/api/admin/funding-evidence', owner())]);
  expect(metrics.status).toBe(200); expect(funding.status).toBe(200);
  expect(metrics.body.financial.held.currencies).toEqual(expect.arrayContaining([
    expect.objectContaining({ currency: 'USD', stripeMode: 'test', totalRecorded: 40000 }),
    expect.objectContaining({ currency: 'USD', stripeMode: 'live', totalRecorded: 40000 }),
    expect.objectContaining({ currency: 'EUR', stripeMode: 'test', totalRecorded: 40000 }),
  ]));
  expect(funding.body.currencies).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'EUR', stripeMode: 'test', grossAmount: 48800 })]));
  expect(funding.body.totalsByMode.test.grossAmount).toBeNull();
});
test('earlier repeated assignments keep exact net payouts and gross releases without current-fee recomputation', async () => {
  const history = [], amounts = [[10000, 8200], [5000, 4100]];
  for (let i = 0; i < amounts.length; i++) {
    const [gross, net] = amounts[i], at = new Date(Date.now() - (2 - i) * 60000), key = `partial_payout:${matter._id}:${i}`, transferId = `tr_admin_retained_${i}`;
    await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: key, amountPaid: net, transferId, status: 'paid', stripeMode: 'test', createdAt: at });
    await Operation.create({ caseId: matter._id, operationKey: key, kind: 'partial_payout', fingerprint: key, amount: net, transferAmount: net, status: 'succeeded', currency: 'usd', stripeMode: 'test', stripeTransferId: transferId, stripeObjectId: transferId });
    await Income.create({ caseId: matter._id, attorneyId: attorney._id, paralegalId: para._id, operationKey: key, feeAmount: gross - net, stripeMode: 'test' });
    history.push({ withdrawnParalegalId: para._id, partialPayoutAmount: gross, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', payoutTransferId: transferId, pausedAt: new Date(at.getTime() - 1000) });
  }
  await Case.collection.updateOne({ _id: matter._id }, { $set: { remainingAmount: 25000, feeParalegalPct: 12, withdrawalHistory: history } });
  const [index, income, metrics] = await Promise.all([get('/api/payments/receipts', owner()), get('/api/admin/income', owner()), get('/api/admin/metrics', owner())]);
  for (const response of [index, income, metrics]) expect(response.status).toBe(200);
  expect(metrics.body.totals.escrowHeld).toBe(25000); expect(income.body.totalAmount).toBe(2700);
  expect(index.body.items.filter(row => row.type === 'Payout').map(row => row.amountCents).sort((a, b) => a - b)).toEqual([4100, 8200]);
  expect(index.body.items.filter(row => row.type === 'Withdrawal release').map(row => row.amountCents).sort((a, b) => a - b)).toEqual([5000, 10000]);
  expect(new Set(index.body.items.map(row => row.id)).size).toBe(index.body.items.length);
});
test('funding and income records beyond the old 200-row cap remain reachable on a stable revision', async () => {
  await Operation.insertMany(Array.from({ length: 205 }, (_, i) => ({ caseId: matter._id, kind: 'funding', operationKey: `funding-extra-${i}`, fingerprint: 'synthetic', amount: 100, currency: 'usd', stripeMode: 'test', status: 'failed' })));
  await Income.insertMany(Array.from({ length: 205 }, (_, i) => ({ caseId: matter._id, attorneyId: attorney._id, paralegalId: para._id, operationKey: `income-extra-${i}`, feeAmount: 100, stripeMode: 'test' })));
  for (const [path, total] of [['/api/admin/funding-evidence', 206], ['/api/admin/income', 205]]) {
    const first = await get(path, { ...owner(), page: 1, limit: 200 }); expect(first.status).toBe(200); expect(first.body.total).toBe(total); expect(first.body.items).toHaveLength(200);
    const last = await get(path, { ...owner(), page: 2, limit: 200, revision: first.body.revision }); expect(last.status).toBe(200); expect(last.body.items).toHaveLength(total - 200);
    expect(new Set([...first.body.items, ...last.body.items].map(row => row.id)).size).toBe(total);
  }
});
test.each(['/api/admin/workspace/finance/records', '/api/admin/workspace/finance/export', '/api/payments/receipts'])('a changed reviewed source rejects the old revision in %s', async path => {
  const initial = await get(path === '/api/admin/workspace/finance/export' ? '/api/admin/workspace/finance/records' : path, owner()); expect(initial.status).toBe(200);
  await Operation.collection.updateOne({ _id: funding._id }, { $set: { grossAmount: 48801 } });
  const changed = await get(path, { ...owner(), revision: initial.body.revision }); expect(changed.status).toBe(409); expect(changed.text).not.toContain('Synthetic admin agreement');
});
test.each(['/api/admin/metrics', '/api/admin/analytics', '/api/admin/funding-evidence', '/api/payments/receipts'])('funding changed during a retained read cannot escape through %s', async path => {
  const find = Income.collection.find.bind(Income.collection); let changed = false;
  jest.spyOn(Income.collection, 'find').mockImplementation((...args) => {
    const cursor = find(...args), original = cursor.toArray.bind(cursor);
    cursor.toArray = async () => { const result = await original(); if (!changed) { changed = true; await Operation.collection.updateOne({ _id: funding._id }, { $set: { grossAmount: 48801 } }); } return result; };
    return cursor;
  });
  const response = await get(path, owner()); expect(changed).toBe(true); expect(response.status).toBe(409); expect(response.text).not.toContain('Synthetic admin agreement');
});
test('the admin Matter financial panel checks the expected owner', async () => {
  const response = await get(`/api/admin/workspace/matters/${matter._id}`, { expectedOwnerId: String(para._id) }); expect(response.status).toBe(403);
});
async function chargebackEvidence({ adjustment = true } = {}) {
  const operation = await Operation.create({ caseId: matter._id, kind: 'chargeback', operationKey: `chargeback:${matter._id}`, fingerprint: 'synthetic chargeback', amount: 48800, currency: 'usd', stripeMode: 'test', livemode: false, status: 'succeeded', evidenceStatus: 'verified', administrativeStatus: 'pending_review', processorStatus: 'needs_response', payoutPosition: 'pre_payout', stripeDisputeId: 'dp_admin_dispute', stripeChargeId: 'ch_admin_first', stripeEventId: 'evt_admin_dispute' });
  const Adjustment = require('../models/FinancialAdjustment');
  if (adjustment) await Adjustment.create([
    { idempotencyKey: 'chargeback-adjustment:dp_admin_dispute:txn_admin_dispute:principal', paymentOperationId: operation._id, caseId: matter._id, amount: 48800, direction: 'debit', adjustmentType: 'chargeback_principal', currency: 'usd', stripeMode: 'test', stripeDisputeId: 'dp_admin_dispute', stripeChargeId: 'ch_admin_first', stripeBalanceTransactionId: 'txn_admin_dispute', stripeEventId: 'evt_admin_dispute' },
    { idempotencyKey: 'chargeback-adjustment:dp_admin_dispute:txn_admin_dispute:fee', paymentOperationId: operation._id, caseId: matter._id, amount: 1400, direction: 'debit', adjustmentType: 'processor_dispute_fee', currency: 'usd', stripeMode: 'test', stripeDisputeId: 'dp_admin_dispute', stripeChargeId: 'ch_admin_first', stripeBalanceTransactionId: 'txn_admin_dispute', stripeEventId: 'evt_admin_dispute' },
  ]);
  return operation;
}
test('chargeback reporting preserves separate principal and fee components from one retained transaction', async () => {
  await chargebackEvidence();
  const response = await get('/api/admin/chargebacks', owner()); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ chargebackAmount: 48800, processorFees: 1400, netExposure: 50200, evidenceCount: 2, evidenceStatus: 'verified', currency: 'USD', stripeMode: 'test' });
});
test.each(['currency', 'stripeMode', 'stripeChargeId'])('chargeback %s conflicts cannot enter an exposure total', async field => {
  await chargebackEvidence();
  await require('../models/FinancialAdjustment').collection.updateOne({ adjustmentType: 'processor_dispute_fee' }, { $set: { [field]: ({ currency: 'eur', stripeMode: 'live', stripeChargeId: 'ch_foreign' })[field] } });
  const response = await get('/api/admin/chargebacks', owner()); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ processorFees: null, netExposure: null, evidenceStatus: 'needs_review' });
});
test('missing chargeback adjustment evidence does not mean zero exposure', async () => {
  await chargebackEvidence({ adjustment: false });
  const response = await get('/api/admin/chargebacks', owner()); expect(response.status).toBe(200);
  expect(response.body.items[0]).toMatchObject({ netExposure: null, evidenceCount: 0, evidenceStatus: 'needs_review' });
});
test.each([false, true])('a missing original charge requires one consistent retained adjustment charge: conflict=%s', async conflict => {
  const operation = await chargebackEvidence();
  await Operation.collection.updateOne({ _id: operation._id }, { $unset: { stripeChargeId: '' } });
  await require('../models/FinancialAdjustment').collection.updateOne({ adjustmentType: 'processor_dispute_fee' }, { $set: { idempotencyKey: 'legacy-retained-fee-key', ...(conflict ? { stripeChargeId: 'ch_other' } : {}) } });
  const response = await get('/api/admin/chargebacks', owner()); expect(response.status).toBe(200);
  expect(response.body.items[0].netExposure).toBe(conflict ? null : 50200);
});
test('chargeback reads reject a different expected account', async () => {
  const response = await get('/api/admin/chargebacks', { expectedOwnerId: String(para._id) }); expect(response.status).toBe(403);
});
test('revocation while chargeback adjustments arrive prevents a private response', async () => {
  await chargebackEvidence();
  const Adjustment = require('../models/FinancialAdjustment'), find = Adjustment.collection.find.bind(Adjustment.collection); let changed = false;
  jest.spyOn(Adjustment.collection, 'find').mockImplementation((...args) => {
    const cursor = find(...args), original = cursor.toArray.bind(cursor);
    cursor.toArray = async () => { const rows = await original(); if (!changed && rows.length) { changed = true; await User.collection.updateOne({ _id: admin._id }, { $inc: { authVersion: 1 } }); } return rows; };
    return cursor;
  });
  const response = await get('/api/admin/chargebacks', owner()); expect(changed).toBe(true); expect(response.status).toBe(403); expect(response.text).not.toContain('Synthetic admin agreement');
});
test('commission caches remain estimates and cannot masquerade as confirmed payouts', async () => {
  await require('../models/DirectorOutreachRecord').create({ directorUserId: admin._id, directorEmail: 'director@admin-financial-agreement.test', attorneyEmail: attorney.email, attorneyName: 'Synthetic attorney', commissionEarnedCents: 4400, commissionPayoutStatus: 'unpaid' });
  const response = await get('/api/admin/workspace/finance/records', { ...owner(), kind: 'commissions' }); expect(response.status).toBe(200);
  expect(response.body.items).toEqual([expect.objectContaining({ state: 'needs_review', basis: 'outstanding_commission', amount: null, requestedAmount: null, currency: null, stripeMode: 'unknown' })]);
});
test.each(['pi_admin_first', 'a'])('admin search binds financial matches and empty queries to the signed-in owner: %s', async q => {
  const result = await get('/api/admin/workspace/search', { ...owner(), q }); expect(result.status).toBe(200);
  expect(result.body.ownerId).toBe(String(admin._id)); expect(result.body.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(result.body.payments).toHaveLength(q.length > 1 ? 1 : 0);
  const denied = await get('/api/admin/workspace/search', { expectedOwnerId: String(para._id), q }); expect(denied.status).toBe(403);
});
