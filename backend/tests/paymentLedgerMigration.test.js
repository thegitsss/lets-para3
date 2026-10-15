const mongoose = require("mongoose");

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { run } = require("../scripts/migrate-payment-ledgers");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  await Promise.all([
    mongoose.connection.db.collection("payouts").deleteMany({}),
    mongoose.connection.db.collection("platformincomes").deleteMany({}),
    mongoose.connection.db.collection("paymentoperations").deleteMany({}),
  ]);
});

test("payment ledger migration preserves historical rows and replaces obsolete unique indexes", async () => {
  const db = mongoose.connection.db;
  const payouts = db.collection("payouts");
  const incomes = db.collection("platformincomes");
  const operations = db.collection("paymentoperations");
  const caseId = new mongoose.Types.ObjectId();
  const attorneyId = new mongoose.Types.ObjectId();
  const paralegalId = new mongoose.Types.ObjectId();

  await payouts.dropIndexes().catch(() => {});
  await incomes.dropIndexes().catch(() => {});
  await payouts.createIndex({ caseId: 1, paralegalId: 1 }, { unique: true });
  await incomes.createIndex({ caseId: 1 }, { unique: true });
  await payouts.insertOne({
    caseId,
    paralegalId,
    amountPaid: 82000,
    transferId: "tr_migrate",
    createdAt: new Date(),
  });
  await incomes.insertOne({
    caseId,
    attorneyId,
    paralegalId,
    feeAmount: 40000,
    createdAt: new Date(),
  });
  await operations.insertOne({
    operationKey: `case_payout:${caseId}`,
    caseId,
    stripeTransferId: "tr_migrate",
  });

  const migrationOutput = jest.spyOn(console, "log").mockImplementation(() => {});
  let result;
  try {
    result = await run({ apply: true, mongoUri: "already-connected" });
  } finally {
    migrationOutput.mockRestore();
  }

  expect(result.backfill).toEqual({ payoutsUpdated: 1, incomesUpdated: 1 });
  const payout = await mongoose.connection.db.collection("payouts").findOne({ transferId: "tr_migrate" });
  const income = await mongoose.connection.db.collection("platformincomes").findOne({ caseId });
  expect(payout.operationKey).toBe(`case_payout:${caseId}`);
  expect(income.operationKey).toBe(`case_payout:${caseId}`);

  const payoutIndexes = await mongoose.connection.db.collection("payouts").indexes();
  const incomeIndexes = await mongoose.connection.db.collection("platformincomes").indexes();
  expect(payoutIndexes).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "operationKey_1", unique: true }),
    expect.objectContaining({ name: "transferId_1", unique: true }),
    expect.objectContaining({ name: "caseId_1_paralegalId_1_createdAt_-1" }),
  ]));
  expect(incomeIndexes).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "operationKey_1", unique: true }),
    expect.objectContaining({ name: "caseId_1_createdAt_-1" }),
  ]));

  await mongoose.connection.db.collection("payouts").insertOne({
    operationKey: `partial_payout:${caseId}:${new mongoose.Types.ObjectId()}`,
    caseId,
    paralegalId: new mongoose.Types.ObjectId(),
    amountPaid: 1000,
    transferId: "tr_second",
    createdAt: new Date(),
  });
  await mongoose.connection.db.collection("platformincomes").insertOne({
    operationKey: `partial_payout:${caseId}:second`,
    caseId,
    attorneyId,
    paralegalId: new mongoose.Types.ObjectId(),
    feeAmount: 200,
    createdAt: new Date(),
  });
});
