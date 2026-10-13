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


test("preservation mode leaves old-path records byte-for-byte unchanged without granting access", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { digest } = require("../utils/uploadQuarantine");
  const { planBackfill } = require("../scripts/migrate-case-files");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-migration-preservation-"));
  const file = path.join(dir, "manifest.json");
  const bytes = JSON.stringify({ version: 1, bucketSha256: digest("synthetic-bucket"), objects: [] });
  fs.writeFileSync(file, bytes);
  const env = { S3_BUCKET: "synthetic-bucket", S3_LEGACY_UPLOAD_MANIFEST: file, S3_LEGACY_UPLOAD_MANIFEST_SHA256: digest(bytes) };
  try {
    const collection = mongoose.connection.db.collection("casefiles");
    const caseId = new mongoose.Types.ObjectId();
    await collection.insertMany(["not_required", "blocked", "error"].map((securityStatus, i) => ({
      caseId, storageKey: encryptString(`cases/${caseId}/documents/old-${i}.pdf`), securityStatus,
    })));
    const before = await collection.find({}).toArray();
    expect(await planBackfill(collection, { scanRequired: true, env })).toEqual([]);
    expect(await collection.find({}).toArray()).toEqual(before);
    await expect(planBackfill(collection, { env: { ...env, S3_BUCKET: "wrong" } })).rejects.toThrow(/match S3_BUCKET/);
    await collection.insertOne({ caseId, storageKey: `cases/${caseId}/documents/scan-required-new.pdf`, securityStatus: "not_required" });
    const updates = await planBackfill(collection, { scanRequired: true, env });
    expect(updates).toHaveLength(1);
    expect(updates[0].set.securityStatus).toBe("pending");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
