#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const APPLY = process.argv.includes("--apply");

function keyMatches(actual = {}, expected = {}) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function collectionExists(name) {
  return Boolean(await mongoose.connection.db.listCollections({ name }, { nameOnly: true }).hasNext());
}

async function dropIndexesMatching(collection, predicate) {
  const indexes = await collection.indexes();
  const targets = indexes.filter((index) => index.name !== "_id_" && predicate(index));
  for (const index of targets) await collection.dropIndex(index.name);
  return targets.map((index) => index.name);
}

async function assertUniqueField(collection, field) {
  const duplicates = await collection
    .aggregate([
      { $match: { [field]: { $type: "string", $ne: "" } } },
      { $group: { _id: `$${field}`, count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();
  if (duplicates.length) {
    throw new Error(
      `${collection.collectionName}.${field} contains duplicates: ${duplicates
        .map((entry) => `${entry._id} (${entry.count})`)
        .join(", ")}`
    );
  }
}

async function resolveOperationKey(paymentOperations, payout) {
  const external = String(payout.transferId || "");
  if (external) {
    const operation = await paymentOperations.findOne({
      caseId: payout.caseId,
      $or: [
        { stripeTransferId: external },
        { stripeObjectId: external },
      ],
    });
    if (operation?.operationKey) return operation.operationKey;
  }
  return `legacy_payout:${String(payout._id)}`;
}

async function backfillOperationKeys(
  payouts,
  platformIncomes,
  paymentOperations,
  { apply = APPLY } = {}
) {
  let payoutsUpdated = 0;
  let incomesUpdated = 0;
  const payoutCursor = payouts.find({
    $or: [{ operationKey: { $exists: false } }, { operationKey: null }, { operationKey: "" }],
  });
  for await (const payout of payoutCursor) {
    const operationKey = await resolveOperationKey(paymentOperations, payout);
    if (apply) {
      const result = await payouts.updateOne(
        {
          _id: payout._id,
          $or: [{ operationKey: { $exists: false } }, { operationKey: null }, { operationKey: "" }],
        },
        { $set: { operationKey } }
      );
      payoutsUpdated += Number(result.modifiedCount || 0);
    } else {
      payoutsUpdated += 1;
    }
  }

  const incomeCursor = platformIncomes.find({
    $or: [{ operationKey: { $exists: false } }, { operationKey: null }, { operationKey: "" }],
  });
  for await (const income of incomeCursor) {
    const relatedPayouts = await payouts
      .find({ caseId: income.caseId, paralegalId: income.paralegalId })
      .project({ operationKey: 1 })
      .limit(2)
      .toArray();
    const operationKey =
      relatedPayouts.length === 1 && relatedPayouts[0].operationKey
        ? relatedPayouts[0].operationKey
        : `legacy_income:${String(income._id)}`;
    if (apply) {
      const result = await platformIncomes.updateOne(
        {
          _id: income._id,
          $or: [{ operationKey: { $exists: false } }, { operationKey: null }, { operationKey: "" }],
        },
        { $set: { operationKey } }
      );
      incomesUpdated += Number(result.modifiedCount || 0);
    } else {
      incomesUpdated += 1;
    }
  }
  return { payoutsUpdated, incomesUpdated };
}

async function migrateIndexes(payouts, platformIncomes, { apply = APPLY } = {}) {
  const dropped = { payouts: [], platformIncomes: [] };
  if (!apply) return dropped;

  dropped.payouts = await dropIndexesMatching(
    payouts,
    (index) =>
      keyMatches(index.key, { caseId: 1, paralegalId: 1 }) ||
      keyMatches(index.key, { transferId: 1 }) ||
      keyMatches(index.key, { operationKey: 1 })
  );
  dropped.platformIncomes = await dropIndexesMatching(
    platformIncomes,
    (index) =>
      keyMatches(index.key, { caseId: 1 }) ||
      keyMatches(index.key, { operationKey: 1 })
  );

  await payouts.createIndexes([
    { key: { operationKey: 1 }, name: "operationKey_1", unique: true, sparse: true },
    { key: { transferId: 1 }, name: "transferId_1", unique: true },
    { key: { caseId: 1 }, name: "caseId_1" },
    { key: { paralegalId: 1 }, name: "paralegalId_1" },
    {
      key: { caseId: 1, paralegalId: 1, createdAt: -1 },
      name: "caseId_1_paralegalId_1_createdAt_-1",
    },
  ]);
  await platformIncomes.createIndexes([
    { key: { operationKey: 1 }, name: "operationKey_1", unique: true, sparse: true },
    { key: { caseId: 1 }, name: "caseId_1" },
    { key: { attorneyId: 1 }, name: "attorneyId_1" },
    { key: { paralegalId: 1 }, name: "paralegalId_1" },
    { key: { caseId: 1, createdAt: -1 }, name: "caseId_1_createdAt_-1" },
  ]);
  return dropped;
}

async function run({ apply = APPLY, mongoUri = process.env.MONGO_URI } = {}) {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
  }
  if (!(await collectionExists("payouts"))) {
    if (!apply) throw new Error("The payouts collection does not exist; apply mode is required to create it.");
    await mongoose.connection.db.createCollection("payouts");
  }
  if (!(await collectionExists("platformincomes"))) {
    if (!apply) throw new Error("The platformincomes collection does not exist; apply mode is required to create it.");
    await mongoose.connection.db.createCollection("platformincomes");
  }
  const payouts = mongoose.connection.db.collection("payouts");
  const platformIncomes = mongoose.connection.db.collection("platformincomes");
  const paymentOperations = mongoose.connection.db.collection("paymentoperations");

  await assertUniqueField(payouts, "transferId");
  const backfill = await backfillOperationKeys(payouts, platformIncomes, paymentOperations, { apply });
  if (apply) {
    await assertUniqueField(payouts, "operationKey");
    await assertUniqueField(platformIncomes, "operationKey");
  }
  const dropped = await migrateIndexes(payouts, platformIncomes, { apply });
  const result = { mode: apply ? "apply" : "dry-run", backfill, dropped };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { backfillOperationKeys, migrateIndexes, run };
