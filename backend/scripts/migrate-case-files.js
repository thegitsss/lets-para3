#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const { stableLookupFingerprint } = require("../utils/dataEncryption");
const { malwareScanRequired } = require("../utils/fileSecurity");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const APPLY = process.argv.includes("--apply");
const UNIQUE_INDEX_NAME = "caseId_1_storageKeyFingerprint_1";

async function collectionExists(name) {
  return Boolean(await mongoose.connection.db.listCollections({ name }, { nameOnly: true }).hasNext());
}

async function planBackfill(collection, { scanRequired = malwareScanRequired() } = {}) {
  const updates = [];
  const identities = new Map();
  const duplicates = [];
  const cursor = collection.find({}).project({
    caseId: 1,
    storageKey: 1,
    storageKeyFingerprint: 1,
    securityStatus: 1,
    securityScanResult: 1,
    __v: 1,
  });
  for await (const file of cursor) {
    const fingerprint = stableLookupFingerprint(file.storageKey);
    if (!fingerprint) {
      throw new Error(`CaseFile ${file._id} has no decryptable storageKey; migration cannot bind it safely.`);
    }
    const identity = `${String(file.caseId || "")}:${fingerprint}`;
    if (!file.caseId) throw new Error(`CaseFile ${file._id} has no caseId.`);
    if (identities.has(identity)) {
      duplicates.push({
        caseId: String(file.caseId),
        fingerprint,
        fileIds: [identities.get(identity), String(file._id)],
      });
    } else {
      identities.set(identity, String(file._id));
    }
    const set = {};
    if (file.storageKeyFingerprint !== fingerprint) set.storageKeyFingerprint = fingerprint;
    if (!Number.isInteger(file.__v) || file.__v < 0) set.__v = 0;
    if (scanRequired && ["", "not_required"].includes(String(file.securityStatus || ""))) {
      set.securityStatus = "pending";
      set.securityScanResult = "PENDING";
    } else if (!scanRequired && !file.securityStatus) {
      set.securityStatus = "not_required";
      set.securityScanResult = "NOT_REQUIRED";
    }
    if (Object.keys(set).length) updates.push({ _id: file._id, set });
  }
  if (duplicates.length) {
    throw new Error(
      `Duplicate Matter document identities require review before migration: ${duplicates
        .slice(0, 20)
        .map((entry) => `${entry.caseId} [${entry.fileIds.join(", ")}]`)
        .join("; ")}`
    );
  }
  return updates;
}

async function ensureUniqueIndex(collection, { apply = APPLY } = {}) {
  const expectedKey = { caseId: 1, storageKeyFingerprint: 1 };
  const indexes = await collection.indexes();
  const matching = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(expectedKey));
  const valid = Boolean(
    matching?.unique === true &&
    matching?.partialFilterExpression?.storageKeyFingerprint?.$type === "string"
  );
  if (!apply || valid) return { changed: false, previousIndex: matching?.name || null };
  if (matching) await collection.dropIndex(matching.name);
  await collection.createIndex(expectedKey, {
    name: UNIQUE_INDEX_NAME,
    unique: true,
    partialFilterExpression: { storageKeyFingerprint: { $type: "string" } },
  });
  return { changed: true, previousIndex: matching?.name || null };
}

async function run({ apply = APPLY, mongoUri = process.env.MONGO_URI } = {}) {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
  }
  if (!(await collectionExists("casefiles"))) {
    if (!apply) {
      return { mode: "dry-run", filesScanned: 0, filesUpdated: 0, index: { changed: false } };
    }
    await mongoose.connection.db.createCollection("casefiles");
  }
  const collection = mongoose.connection.db.collection("casefiles");
  const updates = await planBackfill(collection);
  let filesUpdated = 0;
  if (apply && updates.length) {
    const result = await collection.bulkWrite(
      updates.map((entry) => ({
        updateOne: { filter: { _id: entry._id }, update: { $set: entry.set } },
      })),
      { ordered: true }
    );
    filesUpdated = Number(result.modifiedCount || 0);
  } else {
    filesUpdated = updates.length;
  }
  const index = await ensureUniqueIndex(collection, { apply });
  const result = {
    mode: apply ? "apply" : "dry-run",
    filesScanned: await collection.countDocuments({}),
    filesUpdated,
    index,
  };
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

module.exports = { ensureUniqueIndex, planBackfill, run };
