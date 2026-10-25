const fs = require('node:fs');
const mongoose = require('mongoose');
const { Types } = mongoose;
jest.mock('../utils/stripe', () => ({}));
const User = require('../models/User'), Case = require('../models/Case'), Record = require('../models/DirectorOutreachRecord');
const Operation = require('../models/PaymentOperation'), Payout = require('../models/Payout'), Income = require('../models/PlatformIncome');
const history = require('../services/attorneyFinancialHistory'), report = require('../services/adminFinancialReport'), evidence = require('../services/director/commissionEvidence');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
let director, attorney, para, matter, record;
beforeAll(connect); afterAll(closeDatabase); beforeEach(async () => {
  await clearDatabase();
  [director, attorney, para, matter, record] = Array.from({ length: 5 }, () => new Types.ObjectId());
  await User.collection.insertMany([
    { _id: director, email: 'snapshot-director@example.test', role: 'director', status: 'approved', firstName: 'Retained', createdAt: new Date('2026-01-01') },
    { _id: attorney, email: 'snapshot-attorney@example.test', role: 'attorney', status: 'approved', firstName: 'Earlier attorney', createdAt: new Date('2026-01-02'), approvedAt: new Date('2026-01-02') },
    { _id: para, email: 'snapshot-paralegal@example.test', role: 'paralegal', status: 'approved', firstName: 'Earlier paralegal' },
  ]);
  await Case.collection.insertOne({ _id: matter, attorney, attorneyId: attorney, paralegal: para, paralegalId: para, title: 'Earlier retained Matter', status: 'completed', currency: 'usd', stripeMode: 'test', completedAt: new Date('2026-01-04'), totalAmount: 10000, lockedTotalAmount: 10000 });
  await Record.collection.insertOne({ _id: record, directorUserId: director, directorEmail: 'snapshot-director@example.test', attorneyEmail: 'snapshot-attorney@example.test', registeredUserId: attorney, firstOutreachSentAt: new Date('2026-01-01'), commissionEarnedCents: 75, commissionableMatterCount: 1, commissionLegacySnapshot: null });
});
async function snapshot() {
  const value = {};
  for (const Model of [User, Case, Record, Operation, Payout, Income]) value[Model.modelName] = await Model.collection.find({}).sort({ _id: 1 }).toArray();
  return JSON.parse(JSON.stringify(value));
}
function retain(title, values) {
  if (process.env.LPC_MANUAL_IMPORT_SNAPSHOT_EVIDENCE) fs.appendFileSync(process.env.LPC_MANUAL_IMPORT_SNAPSHOT_EVIDENCE, JSON.stringify({ title, ...values, internalReaderOnly: true, providerCalls: 0 }) + '\n');
}
test('internal session readers see the same uncommitted Matter sources while default Attorney reads remain unchanged and abort conserves records', async () => {
  const before = await snapshot(), baseline = await history.loadFinancialInventory(String(attorney));
  expect(await history.loadFinancialInventoryForCases([String(matter)])).toEqual(baseline);
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await Case.collection.updateOne({ _id: matter }, { $set: { title: 'Current transaction Matter' } }, { session });
    await User.collection.updateOne({ _id: para }, { $set: { firstName: 'Current transaction paralegal' } }, { session });
    await Operation.collection.insertOne({ _id: new Types.ObjectId(), caseId: matter, kind: 'funding', status: 'pending', operationKey: 'synthetic-tx-funding', stripePaymentIntentId: 'pi_snapshot', amount: 10000, currency: 'usd' }, { session });
    await Payout.collection.insertOne({ _id: new Types.ObjectId(), caseId: matter, paralegalId: para, operationKey: 'synthetic-tx-payout', transferId: 'tr_snapshot', amountPaid: 100, status: 'pending' }, { session });
    await Income.collection.insertOne({ _id: new Types.ObjectId(), caseId: matter, attorneyId: attorney, operationKey: 'synthetic-tx-income', feeAmount: 50, stripeMode: 'test' }, { session });
    await evidence.retainLegacyClaims({ directorUserId: director, session });
    const transactionalHistory = await history.loadFinancialInventoryForCases([String(matter)], { session });
    const transactionalReport = await report.commissionSource([String(matter)], [String(attorney)], { session });
    const transactionalEvidence = await evidence.read({ directorUserId: director, session }); await transactionalEvidence.verify();
    expect(transactionalHistory.cases[0].title).toBe('Current transaction Matter');
    expect(transactionalHistory.people.find(row => String(row._id) === String(para)).firstName).toBe('Current transaction paralegal');
    expect(transactionalHistory.operations).toHaveLength(1); expect(transactionalHistory.payouts).toHaveLength(1);
    expect(transactionalReport.source.snapshot).toEqual(transactionalHistory); expect(transactionalReport.source.income).toHaveLength(1);
    expect(transactionalEvidence.records.get(String(record)).commissionAudit[0].title).toBe('Current transaction Matter');
    expect((await Record.collection.findOne({ _id: record }, { session })).commissionLegacySnapshot.earnedCents).toBe(75);
    expect(await history.loadFinancialInventory(String(attorney))).toEqual(baseline); expect(await snapshot()).toEqual(before);
    await session.abortTransaction(); const after = await snapshot(); expect(after).toEqual(before);
    retain(expect.getState().currentTestName, { before, after, baseline, transactionalHistory, transactionalReportSource: transactionalReport.source });
  } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
});
test('explicit absent session preserves default financial batch projections and performs no source writes', async () => {
  const before = await snapshot(), original = await report.commissionSource([String(matter)], [String(attorney)]);
  const explicit = await report.commissionSource([String(matter)], [String(attorney)], { session: null });
  expect(explicit).toEqual(original);
  const first = await evidence.read({ directorUserId: director }), second = await evidence.read({ directorUserId: director, session: null });
  expect(second.revision).toBe(first.revision); expect(second.records).toEqual(first.records); await first.verify(); await second.verify();
  const after = await snapshot(); expect(after).toEqual(before); retain(expect.getState().currentTestName, { before, after, originalSource: original.source, identicalAbsentSession: true });
});
