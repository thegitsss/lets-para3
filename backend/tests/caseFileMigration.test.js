const mongoose = require("mongoose");

const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { encryptString, stableLookupFingerprint } = require("../utils/dataEncryption");
const { run } = require("../scripts/migrate-case-files");

beforeAll(async () => {
  await connect();
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await clearDatabase();
  const collection = mongoose.connection.db.collection("casefiles");
  await collection.deleteMany({});
  await collection.dropIndexes().catch(() => {});
});

test("case-file migration backfills encrypted object identities and concurrency versions before indexing", async () => {
  const collection = mongoose.connection.db.collection("casefiles");
  const caseId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const storageKey = `cases/${caseId}/documents/legacy.pdf`;
  const inserted = await collection.insertOne({
    caseId,
    userId,
    originalName: encryptString("legacy.pdf"),
    storageKey: encryptString(storageKey),
    mimeType: "application/pdf",
    status: "pending_review",
    createdAt: new Date(),
  });

  const migrationOutput = jest.spyOn(console, "log").mockImplementation(() => {});
  let result;
  try {
    result = await run({ apply: true, mongoUri: "already-connected" });
  } finally {
    migrationOutput.mockRestore();
  }

  expect(result).toEqual(expect.objectContaining({
    mode: "apply",
    filesScanned: 1,
    filesUpdated: 1,
  }));
  const stored = await collection.findOne({ _id: inserted.insertedId });
  expect(stored.storageKeyFingerprint).toBe(stableLookupFingerprint(storageKey));
  expect(stored.__v).toBe(0);
  expect(stored.securityStatus).toBe("not_required");
  expect(stored.securityScanResult).toBe("NOT_REQUIRED");
  const index = (await collection.indexes()).find(
    (entry) => entry.name === "caseId_1_storageKeyFingerprint_1"
  );
  expect(index).toEqual(expect.objectContaining({
    unique: true,
    partialFilterExpression: { storageKeyFingerprint: { $type: "string" } },
  }));
  await expect(collection.insertOne({
    caseId,
    userId,
    originalName: encryptString("duplicate.pdf"),
    storageKey: encryptString(storageKey),
    storageKeyFingerprint: stableLookupFingerprint(storageKey),
    __v: 0,
  })).rejects.toMatchObject({ code: 11000 });
});

test("case-file migration refuses duplicate legacy object identities", async () => {
  const collection = mongoose.connection.db.collection("casefiles");
  const caseId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const storageKey = `cases/${caseId}/documents/duplicate.pdf`;
  await collection.insertMany([
    { caseId, userId, originalName: "first.pdf", storageKey },
    { caseId, userId, originalName: "second.pdf", storageKey },
  ]);

  await expect(run({ apply: true, mongoUri: "already-connected" }))
    .rejects.toThrow(/duplicate Matter document identities/i);
  expect((await collection.find({}).toArray()).every((entry) => !entry.storageKeyFingerprint)).toBe(true);
});

test("case-file migration re-quarantines legacy records when scanning is required", async () => {
  const collection = mongoose.connection.db.collection("casefiles");
  const caseId = new mongoose.Types.ObjectId();
  const storageKey = `cases/${caseId}/documents/unscanned.pdf`;
  const inserted = await collection.insertOne({
    caseId,
    userId: new mongoose.Types.ObjectId(),
    originalName: "unscanned.pdf",
    storageKey,
    securityStatus: "not_required",
    securityScanResult: "NOT_REQUIRED",
  });

  const { planBackfill } = require("../scripts/migrate-case-files");
  const updates = await planBackfill(collection, { scanRequired: true });
  const planned = updates.find((entry) => String(entry._id) === String(inserted.insertedId));
  expect(planned.set).toEqual(expect.objectContaining({
    securityStatus: "pending",
    securityScanResult: "PENDING",
  }));
});
