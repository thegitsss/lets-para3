const express = require('express'), request = require('supertest'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken'), { Types } = require('mongoose');
process.env.STRIPE_SECRET_KEY = 'sk_test_receipt_agreement';
process.env.S3_BUCKET = '';
jest.mock('../utils/email', () => jest.fn(async () => ({ ok: true })));
jest.mock('../services/caseLifecycle', () => ({ buildReceiptPdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4\nSynthetic retained receipt\n')), uploadPdfToS3: jest.fn(), getReceiptKey: jest.fn(() => 'synthetic/receipt.pdf') }));
const User = require('../models/User'), Case = require('../models/Case'), Payout = require('../models/Payout'), Operation = require('../models/PaymentOperation');
const lifecycle = require('../services/caseLifecycle'), { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const app = express(); app.use(cookieParser(), express.json()); app.use('/api/payments', require('../routes/payments'));
let attorney, para, matter, payout, operation;
const cookie = person => `token=${jwt.sign({ id: String(person._id), role: person.role, av: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
const get = (person, path, query = {}) => request(app).get(path).query(query).set('Cookie', cookie(person));
const download = (person = para, query = {}) => get(person, `/api/payments/receipt/${person.role}/${matter._id}`, query);
function capture(name, value = lifecycle.buildReceiptPdfBuffer.mock.calls.at(-1)?.[0]) {
  const destination = process.env.LPC_RECEIPT_QA_PAYLOADS;
  if (!destination) return;
  const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(destination, { recursive: true }); fs.writeFileSync(path.join(destination, `${name}.json`), JSON.stringify(value, null, 2));
}
beforeAll(connect); afterAll(closeDatabase); afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); lifecycle.buildReceiptPdfBuffer.mockReset().mockImplementation(async () => Buffer.from('%PDF-1.4\nSynthetic retained receipt\n'));
  if (process.env.LPC_RECEIPT_QA_DIAGNOSTICS) {
    const financial = require('../services/attorneyFinancialHistory'), read = financial.loadFinancialInventory, snapshots = [];
    jest.spyOn(financial, 'loadFinancialInventory').mockImplementation(async (...args) => {
      const value = await read(...args); snapshots.push(JSON.parse(JSON.stringify(value)));
      const fs = require('node:fs'), path = require('node:path'), name = require('node:crypto').createHash('sha256').update(expect.getState().currentTestName).digest('hex');
      fs.mkdirSync(process.env.LPC_RECEIPT_QA_DIAGNOSTICS, { recursive: true }); fs.writeFileSync(path.join(process.env.LPC_RECEIPT_QA_DIAGNOSTICS, `${name}.json`), JSON.stringify({ test: expect.getState().currentTestName, snapshots }));
      return value;
    });
  }

  const stripe = require('../utils/stripe');
  for (const resource of ['customers', 'paymentIntents', 'charges', 'transfers', 'refunds']) for (const method of ['retrieve', 'create', 'list', 'update']) if (typeof stripe[resource]?.[method] === 'function') jest.spyOn(stripe[resource], method).mockImplementation(async () => { throw Error('Retained receipts must not use the provider'); });
  [attorney, para] = await User.create(['attorney', 'paralegal'].map(role => ({ firstName: 'Synthetic', lastName: role, email: `${role}@receipt-agreement.test`, password: 'Synthetic123!', role, status: 'approved' })));
  const at = new Date('2026-09-01T12:00:00Z');
  matter = await Case.create({ title: 'River Street withdrawal', details: 'Private retained receipt agreement.', attorney: attorney._id, attorneyId: attorney._id, status: 'paused', pausedReason: 'paralegal_withdrew', withdrawnParalegalId: para._id, partialPayoutAmount: 10000, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', pausedAt: new Date(at.getTime() - 1000), payoutTransferId: 'tr_receipt_agreement', totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 30000, feeParalegalPct: 19, currency: 'usd', stripeMode: 'test' });
  payout = await Payout.create({ caseId: matter._id, paralegalId: para._id, operationKey: `partial_payout:${matter._id}:prior`, amountPaid: 8100, transferId: 'tr_receipt_agreement', status: 'paid', stripeMode: 'test', createdAt: at });
  operation = await Operation.create({ caseId: matter._id, operationKey: payout.operationKey, kind: 'partial_payout', fingerprint: 'receipt_agreement', amount: 8100, transferAmount: 8100, currency: 'usd', status: 'succeeded', stripeTransferId: payout.transferId, stripeObjectId: payout.transferId, stripeMode: 'test' });
});
test('both receipts use the same retained net payout and withdrawal gross', async () => {
  const a = await download(attorney), p = await download(); expect([a.status, p.status]).toEqual([200, 200]);
  expect(lifecycle.buildReceiptPdfBuffer.mock.calls[0][0]).toMatchObject({ totalAmount: '$100.00', dateLabel: 'Payout date', lineItems: [{ label: 'Amount released from Matter', value: '$100.00' }] }); expect(lifecycle.buildReceiptPdfBuffer.mock.calls[1][0]).toMatchObject({ totalAmount: '$81.00', dateLabel: 'Payout date' });
  capture('attorney-withdrawal', lifecycle.buildReceiptPdfBuffer.mock.calls[0][0]); capture('paralegal-withdrawal');
  const review = await get(attorney, `/api/payments/receipt/attorney/${matter._id}/review`, { expectedOwnerId: String(attorney._id) }); expect(review.status).toBe(200);
  const moduleUrl = require('node:url').pathToFileURL(require('node:path').resolve(__dirname, '../../frontend/assets/scripts/attorney-v2/receipt-model.mjs')).href;
  require('node:child_process').execFileSync(process.execPath, ['--input-type=module', '--eval', `import {readReceipt} from ${JSON.stringify(moduleUrl)};import fs from 'node:fs';const value=JSON.parse(fs.readFileSync(0,'utf8'));readReceipt(value,value.caseId,value.ownerId);`], { input: JSON.stringify(review.body), stdio: ['pipe', 'pipe', 'pipe'] });

  expect(lifecycle.uploadPdfToS3).not.toHaveBeenCalled();
});
test.each(['reversed', 'unresolved_operation', 'quarantined_operation', 'foreign_transfer', 'duplicate_transfer_operation', 'conflicting_modes', 'no_provider_mode'])("neither receipt claims a recorded payout when history requires review: %s", async scenario => {
  if (scenario === 'reversed') await Payout.collection.updateOne({ _id: payout._id }, { $set: { reversedAt: new Date() } });
  if (scenario === 'unresolved_operation') await Operation.collection.updateOne({ _id: operation._id }, { $set: { status: 'needs_reconciliation' } });
  if (scenario === 'quarantined_operation') await Operation.collection.updateOne({ _id: operation._id }, { $set: { evidenceStatus: 'quarantined' } });
  if (scenario === 'foreign_transfer') await Operation.create({ caseId: new Types.ObjectId(), operationKey: 'foreign_receipt_transfer', kind: 'partial_payout', fingerprint: 'foreign', stripeTransferId: payout.transferId, amount: 8100, status: 'succeeded', stripeMode: 'test' });
  if (scenario === 'duplicate_transfer_operation') await Operation.create({ caseId: matter._id, operationKey: 'duplicate_receipt_transfer', kind: 'partial_payout', fingerprint: 'duplicate', stripeTransferId: payout.transferId, amount: 8100, status: 'succeeded', stripeMode: 'test' });
  if (scenario === 'conflicting_modes') { await Case.collection.updateOne({ _id: matter._id }, { $set: { stripeMode: 'unknown' } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { stripeMode: 'live' } }); }
  if (scenario === 'no_provider_mode') { await Payout.collection.updateOne({ _id: payout._id }, { $set: { stripeMode: 'unknown' } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { stripeMode: 'unknown' } }); }
  const history = await get(attorney, '/api/payments/attorney-financial-history', { expectedOwnerId: String(attorney._id) }); expect(history.status).toBe(200); expect(history.body.entries.filter(row => row.type === 'payout').every(row => row.state !== 'recorded')).toBe(true);
  const a = await download(attorney), p = await download(); expect({ attorney: a.status, paralegal: p.status }).toEqual({ attorney: 409, paralegal: 409 }); expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test('the paralegal receipt preserves EUR amounts instead of printing dollar amounts', async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { currency: 'eur' } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { currency: 'eur' } });
  expect((await download()).status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls[0][0]).toMatchObject({ totalAmount: '€81.00' });
  capture('paralegal-eur');
});
test('the paralegal receipt rejects a different expected owner', async () => { const value = await download(para, { expectedOwnerId: String(attorney._id) }); expect(value.status).toBe(403); expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled(); });
test.each(['account', 'reversal', 'mode', 'foreign_transfer'])('a %s change during PDF rendering prevents delivery', async scenario => {
  let reached = false;
  lifecycle.buildReceiptPdfBuffer.mockImplementationOnce(async () => {
    reached = true;
    if (scenario === 'account') await User.collection.updateOne({ _id: para._id }, { $inc: { authVersion: 1 } });
    if (scenario === 'reversal') await Payout.collection.updateOne({ _id: payout._id }, { $set: { status: 'reversed', reversedAt: new Date() } });
    if (scenario === 'mode') await Operation.collection.updateOne({ _id: operation._id }, { $set: { stripeMode: 'live' } });
    if (scenario === 'foreign_transfer') await Operation.create({ caseId: new Types.ObjectId(), operationKey: 'render_race', kind: 'partial_payout', fingerprint: 'race', stripeTransferId: payout.transferId, amount: 8100, status: 'succeeded', stripeMode: 'test' });
    return Buffer.from('%PDF-1.4\nSynthetic retained receipt\n');
  });
  const value = await download(); expect({ reached, status: value.status, response: value.body }).toMatchObject({ reached: true }); expect([403, 409]).toContain(value.status); expect(value.headers['content-type']).not.toContain('application/pdf');
});
test('a later zero withdrawal for the same payee stays separate from an earlier paid assignment', async () => {
  const raw = await Case.collection.findOne({ _id: matter._id }), fields = ['withdrawnParalegalId', 'payoutFinalizedAt', 'payoutFinalizedType', 'partialPayoutAmount', 'payoutTransferId', 'pausedAt'];
  const earlier = Object.fromEntries(fields.map(field => [field, raw[field]]));
  await Case.collection.updateOne({ _id: matter._id }, { $set: { withdrawalHistory: [earlier], partialPayoutAmount: 0, payoutFinalizedAt: new Date('2026-09-04T12:00:00Z'), payoutFinalizedType: 'zero_auto', payoutTransferId: '', pausedAt: new Date('2026-09-04T11:00:00Z') } });
  const entries = require('../services/attorneyReceiptHistory').inventory(await Case.collection.findOne({ _id: matter._id })).filter(entry => entry.record);
  for (const person of [attorney, para]) {
    const latest = await download(person, { receiptId: entries[0].id }); expect({ status: latest.status, response: latest.body, role: person.role }).toMatchObject({ status: 200 }); expect(lifecycle.buildReceiptPdfBuffer.mock.calls.at(-1)[0]).toMatchObject({ totalAmount: '$0.00', paymentStatus: 'No payout' });
    capture(`${person.role}-zero`);
    const old = await download(person, { receiptId: entries[1].id }); expect(old.status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls.at(-1)[0].totalAmount).toBe(person.role === 'attorney' ? '$100.00' : '$81.00');
  }
});
test('the current completion receipt uses the recorded remaining principal and net payout', async () => {
  const key = `case_payout:${matter._id}`;
  await Case.collection.updateOne({ _id: matter._id }, { $set: { paralegal: para._id, paralegalId: para._id, status: 'completed', paymentReleased: true, totalAmount: 30000, lockedTotalAmount: 30000, withdrawnParalegalId: null, payoutFinalizedAt: null, payoutFinalizedType: null, partialPayoutAmount: null, payoutStatus: 'paid' } });
  await Payout.collection.updateOne({ _id: payout._id }, { $set: { operationKey: key, amountPaid: 24300 } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { operationKey: key, kind: 'case_payout', amount: 24300, transferAmount: 24300 } });
  expect((await download()).status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls.at(-1)[0]).toMatchObject({ totalAmount: '$243.00', lineItems: [{ label: 'Gross amount', value: '$300.00' }, { label: 'Platform fee (19%)', value: '$57.00' }], testMode: true, paymentStatus: 'Payout recorded' });
  capture('paralegal-completion');
});
test('missing retained payout dates remain unavailable in both receipts', async () => {
  await Payout.collection.updateOne({ _id: payout._id }, { $unset: { createdAt: '' } });
  for (const person of [attorney, para]) { expect((await download(person)).status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls.at(-1)[0].issuedAt).toBe('Date unavailable'); }
  capture('paralegal-undated');
});
test('a zero amount without a recognized withdrawal decision cannot issue a zero receipt', async () => {
  await Payout.deleteMany({}); await Operation.deleteMany({}); await Case.collection.updateOne({ _id: matter._id }, { $set: { partialPayoutAmount: 0, payoutTransferId: '', payoutFinalizedType: 'unverified' } });
  expect((await download()).status).toBe(409); expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test('a receipt selection remains bound to the actual payee', async () => {
  const value = await download(para, { receiptId: 'a'.repeat(64) }); expect(value.status).toBe(404); expect(lifecycle.buildReceiptPdfBuffer).not.toHaveBeenCalled();
});
test('long retained names and Matter text are passed as receipt values without inventing shorter source labels', async () => {
  const title = 'River Street lease exhibits and supporting correspondence '.repeat(14), firstName = 'Alexandria'.repeat(14);
  await Case.collection.updateOne({ _id: matter._id }, { $set: { title } }); await User.collection.updateOne({ _id: para._id }, { $set: { firstName } });
  expect((await download()).status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls.at(-1)[0]).toMatchObject({ caseTitle: title, partyName: `${firstName} paralegal` }); capture('paralegal-long');
});

test('live payout receipts keep bank arrival distinct from the recorded transfer', async () => {
  await Case.collection.updateOne({ _id: matter._id }, { $set: { stripeMode: 'live' } }); await Payout.collection.updateOne({ _id: payout._id }, { $set: { stripeMode: 'live' } }); await Operation.collection.updateOne({ _id: operation._id }, { $set: { stripeMode: 'live' } });
  for (const person of [attorney, para]) { expect((await download(person)).status).toBe(200); expect(lifecycle.buildReceiptPdfBuffer.mock.calls.at(-1)[0]).toMatchObject({ testMode: false, paymentStatus: 'Payout recorded; bank arrival not confirmed' }); }
});
