const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const database = require("./helpers/db");
const { encryptString, decryptString, decryptMessagePayload, decryptCaseFilePayload } = require("../utils/dataEncryption");
const { COLLECTIONS, digest, projectChange, createPlan, validatePlan, applyPlan, sealPlan, openPlan } = require("../services/confidentialityRemediation");
const { argumentsFor, assertTarget, backupKey, readPrivatePlan, writePrivatePlan, run } = require("../scripts/remediate-confidentiality");
const targetDigest = "a".repeat(64);
const key = Buffer.from("b".repeat(64), "hex");
const oid = () => new mongoose.Types.ObjectId();
let db, client;
beforeAll(async () => { await database.connect(); db = mongoose.connection.db; client = mongoose.connection.getClient(); });
beforeEach(async () => { for (const name of COLLECTIONS) await db.collection(name).deleteMany({}); });
afterAll(async () => { await database.closeDatabase(); });

test("planning authenticates existing envelopes and protects nested aliases without mutating the input", () => {
  const cipher = encryptString("Already protected");
  const original = { _id: oid(), caseId: oid(), text: "Historical private text", transcript: cipher,
    content: { text: "Nested private text", files: [{ fileName: "Private exhibit.pdf", storageKey: "cases/private/key" }] } };
  const before = digest(original), change = projectChange("messages", original);
  expect(digest(original)).toBe(before);
  expect(change.counts).toEqual({ plaintext: 4, authenticated: 1 });
  const after = { ...original, ...Object.fromEntries(change.changes.map(entry => [entry.field, entry.after])) };
  expect(after.transcript).toBe(cipher);
  expect(after.text).not.toContain("Historical private text");
  expect(decryptMessagePayload(after)).toMatchObject({ text: original.text, content: original.content });
});
test("malformed marked ciphertext is held instead of re-encrypted or overwritten", async () => {
  const bad = { _id: oid(), text: "enc:v1:not-a-valid-envelope" };
  await db.collection("messages").insertOne(bad);
  const plan = await createPlan(db, { targetDigest });
  expect(plan.rows).toHaveLength(0); expect(plan.holds).toHaveLength(1);
  await expect(applyPlan(db, client, plan, { targetDigest })).rejects.toMatchObject({ code: "PLAN_NOT_ACCEPTED" });
  expect((await db.collection("messages").findOne({ _id: bad._id })).text).toBe(bad.text);
});
test("wrong-key authenticated ciphertext is held without exporting its contents", async () => {
  const iv = crypto.randomBytes(12), foreign = crypto.createCipheriv("aes-256-gcm", key, iv);
  const text = "enc:v1:" + Buffer.concat([iv, (() => { const encrypted = Buffer.concat([foreign.update("Private foreign text"), foreign.final()]); return Buffer.concat([foreign.getAuthTag(), encrypted]); })()]).toString("base64");
  await db.collection("messages").insertOne({ _id: oid(), text });
  const plan = await createPlan(db, { targetDigest });
  expect(plan.holds[0].code).toBe("CIPHERTEXT_AUTHENTICATION_FAILED");
  expect(JSON.stringify(plan.holds)).not.toContain("Private foreign text");
});
test("file history and lookup identities survive remediation and contradictory identity is held", () => {
  const original = { _id: oid(), caseId: oid(), originalName: "Private filing.pdf", storageKey: "cases/matter/filing.pdf",
    history: [{ storageKey: "cases/matter/prior.pdf", replacedAt: new Date("2026-09-01") }], version: 3, revisionOfFileId: oid() };
  const change = projectChange("casefiles", original);
  const after = { ...original, ...Object.fromEntries(change.changes.map(entry => [entry.field, entry.after])) };
  expect(decryptCaseFilePayload(after)).toMatchObject(original);
  expect(after.storageKeyFingerprint).toBe(crypto.createHash("sha256").update(original.storageKey).digest("hex"));
  expect(after.version).toBe(3); expect(after.revisionOfFileId).toEqual(original.revisionOfFileId);
  expect(() => projectChange("casefiles", { ...original, storageKeyFingerprint: "wrong-identity" })).toThrow("CONFLICTING_FILE_IDENTITY");
});
test("only message notification copies are removed and routing, recipients and read history remain intact", () => {
  const original = { _id: oid(), type: "message", message: "Old private snippet", userId: oid(), link: "/case-detail.html?caseId=retained",
    read: true, createdAt: new Date("2026-09-01"), payload: { caseId: oid(), messageId: oid(), messageSnippet: "Private text",
      extra: { preview: "Nested private text", preserved: true } } };
  const change = projectChange("notifications", original);
  const after = { ...original, ...Object.fromEntries(change.changes.filter(entry => entry.afterPresent).map(entry => [entry.field, entry.after])) };
  expect(after.message).toBe("You have a new Matter message.");
  expect(after.payload.messageSnippet).toBeUndefined(); expect(after.payload.extra).toEqual({ preserved: true });
  for (const field of ["_id", "userId", "link", "read", "createdAt"]) expect(after[field]).toEqual(original[field]);
  expect(projectChange("notifications", { ...original, type: "application_submitted" }).changes).toEqual([]);
});
test("an encrypted immutable plan round-trips BSON identities, dates and large integer references", () => {
  const original = { _id: oid(), text: "Secret backup text", createdAt: new Date(), retained: mongoose.mongo.BSON.Long.fromString("9007199254740993") };
  const row = { collection: "messages", id: original._id, ...projectChange("messages", original) };
  const plan = { version: 1, targetDigest, rows: [row], holds: [], createdAt: original.createdAt, retained: original.retained };
  const envelope = sealPlan(plan, key), restored = openPlan(envelope, key);
  expect(envelope).not.toContain("Secret backup text"); expect(envelope).not.toContain(String(original._id));
  expect(digest(restored)).toBe(digest(plan)); expect(restored.retained.toString()).toBe("9007199254740993");
  expect(() => openPlan(envelope, crypto.randomBytes(32))).toThrow();
  const tampered = JSON.parse(envelope); tampered.data = Buffer.from("tampered").toString("base64");
  expect(() => openPlan(JSON.stringify(tampered), key)).toThrow();
});
test("actual isolated transactions apply, resume without duplicates and restore only reviewed fields", async () => {
  const message = { _id: oid(), text: "Historical message", caseId: oid(), createdAt: new Date(), __v: 4 };
  const file = { _id: oid(), caseId: message.caseId, originalName: "Private.pdf", storageKey: "cases/private/file.pdf", version: 2 };
  const notice = { _id: oid(), userId: oid(), type: "message", message: "Old confidential copy", payload: { messageSnippet: "Historical message", caseId: message.caseId }, read: true };
  await db.collection("messages").insertOne(message); await db.collection("casefiles").insertOne(file); await db.collection("notifications").insertOne(notice);
  const plan = openPlan(sealPlan(await createPlan(db, { targetDigest }), key), key);
  expect(plan.rows).toHaveLength(3);
  expect(await applyPlan(db, client, plan, { targetDigest })).toEqual({ changed: 3, alreadyApplied: 0 });
  expect(decryptString((await db.collection("messages").findOne({ _id: message._id })).text)).toBe(message.text);
  expect(await applyPlan(db, client, plan, { targetDigest })).toEqual({ changed: 0, alreadyApplied: 3 });
  expect(await applyPlan(db, client, plan, { targetDigest, reverse: true })).toEqual({ changed: 3, alreadyApplied: 0 });
  expect(await db.collection("messages").findOne({ _id: message._id })).toEqual(message);
  expect(await db.collection("casefiles").findOne({ _id: file._id })).toEqual(file);
  expect(await db.collection("notifications").findOne({ _id: notice._id })).toEqual(notice);
});
test("intervening user edits block apply and rollback without overwriting saved work", async () => {
  const message = { _id: oid(), text: "Old text", caseId: oid() };
  await db.collection("messages").insertOne(message);
  const plan = await createPlan(db, { targetDigest });
  await db.collection("messages").updateOne({ _id: message._id }, { $set: { text: "Newer user edit" } });
  await expect(applyPlan(db, client, plan, { targetDigest })).rejects.toMatchObject({ code: "RECORD_CHANGED" });
  await db.collection("messages").updateOne({ _id: message._id }, { $set: { text: message.text } });
  await applyPlan(db, client, plan, { targetDigest });
  await db.collection("messages").updateOne({ _id: message._id }, { $set: { pinned: true } });
  await expect(applyPlan(db, client, plan, { targetDigest, reverse: true })).rejects.toMatchObject({ code: "RECORD_CHANGED" });
  expect((await db.collection("messages").findOne({ _id: message._id })).pinned).toBe(true);
});
test("a stopped multi-record plan resumes from committed records without overwriting the changed record", async () => {
  const first = { _id: oid(), text: "First reviewed text" }, second = { _id: oid(), text: "Second reviewed text" };
  await db.collection("messages").insertMany([first, second]);
  const plan = await createPlan(db, { targetDigest });
  await db.collection("messages").updateOne({ _id: second._id }, { $set: { text: "A newer edit" } });
  await expect(applyPlan(db, client, plan, { targetDigest })).rejects.toMatchObject({ code: "RECORD_CHANGED" });
  expect(decryptString((await db.collection("messages").findOne({ _id: first._id })).text)).toBe(first.text);
  expect((await db.collection("messages").findOne({ _id: second._id })).text).toBe("A newer edit");
  // This synthetic fixture deliberately restores the reviewed value. A real
  // intervening user edit requires a new reviewed plan, never this reset.
  await db.collection("messages").updateOne({ _id: second._id }, { $set: { text: second.text } });
  expect(await applyPlan(db, client, plan, { targetDigest })).toEqual({ changed: 1, alreadyApplied: 1 });
  expect(await applyPlan(db, client, plan, { targetDigest, reverse: true })).toEqual({ changed: 2, alreadyApplied: 0 });
});
test("the explicit local CLI plans, applies, resumes and rolls back using the reviewed encrypted file", async () => {
  const { uri } = require("./helpers/mongoHarnessState").readReadyState();
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lpc-remediation-cli-"));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "plan.json"), original = { _id: oid(), text: "Synthetic CLI text", retained: true };
  const env = { CONFIDENTIALITY_MONGO_URI: uri + database.testDatabaseName,
    CONFIRM_CONFIDENTIALITY_TARGET: "ISOLATED_NON_PRODUCTION", CONFIDENTIALITY_BACKUP_KEY: key.toString("hex"),
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY, CONFIRM_CONFIDENTIALITY_WRITES: "REVIEWED_ISOLATED_PLAN" };
  try {
    await db.collection("messages").insertOne(original);
    const plan = await run(["--mode=plan", `--plan=${file}`], env);
    expect(plan).toMatchObject({ mode: "plan", scanned: 1, changed: 1, held: 0, productionCapable: false });
    expect(JSON.stringify(plan)).not.toContain(original.text);
    const approved = `--approved-sha256=${plan.sha256}`;
    await expect(run(["--mode=apply", `--plan=${file}`, "--approved-sha256=" + "0".repeat(64)], env)).rejects.toMatchObject({ code: "PLAN_DIGEST_MISMATCH" });
    expect(await run(["--mode=apply", `--plan=${file}`, approved], env)).toMatchObject({ changed: 1, alreadyApplied: 0 });
    expect(await run(["--mode=apply", `--plan=${file}`, approved], env)).toMatchObject({ changed: 0, alreadyApplied: 1 });
    expect(await run(["--mode=rollback", `--plan=${file}`, approved], env)).toMatchObject({ changed: 1, alreadyApplied: 0 });
    expect(await db.collection("messages").findOne({ _id: original._id })).toEqual(original);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("wrong target, operator fields and duplicate identities cannot enter an accepted plan", () => {
  const original = { _id: oid(), text: "Historical text" };
  const row = { collection: "messages", id: original._id, ...projectChange("messages", original) };
  const plan = { version: 1, targetDigest, rows: [row], holds: [] };
  expect(() => validatePlan(plan, "c".repeat(64))).toThrow("PLAN_NOT_ACCEPTED");
  expect(() => validatePlan({ ...plan, rows: [row, row] }, targetDigest)).toThrow("INVALID_PLAN_RECORD");
  expect(() => validatePlan({ ...plan, rows: [{ ...row, id: { $ne: null } }] }, targetDigest)).toThrow("INVALID_PLAN_RECORD");
  expect(() => validatePlan({ ...plan, rows: [{ ...row, changes: [{ ...row.changes[0], field: "caseId" }] }] }, targetDigest)).toThrow("INVALID_PLAN_RECORD");
});
test("record limit stops planning rather than silently truncating the inventory", async () => {
  await db.collection("messages").insertMany([{ _id: oid(), text: "One" }, { _id: oid(), text: "Two" }]);
  await expect(createPlan(db, { targetDigest, limit: 1 })).rejects.toMatchObject({ code: "PLAN_RECORD_LIMIT" });
});
test("CLI refuses inherited, credential-bearing or remote targets and requires a separate backup key", () => {
  const env = { CONFIDENTIALITY_MONGO_URI: "mongodb://127.0.0.1:5888/isolated?replicaSet=rs0", CONFIRM_CONFIDENTIALITY_TARGET: "ISOLATED_NON_PRODUCTION" };
  expect(assertTarget(env)).toBe(env.CONFIDENTIALITY_MONGO_URI);
  for (const uri of ["mongodb+srv://example/real", "mongodb://localhost:5888/isolated", "mongodb://127.0.0.1:5888/", "mongodb://127.0.0.1:5888/isolated?proxyHost=remote"]) {
    expect(() => assertTarget({ ...env, CONFIDENTIALITY_MONGO_URI: uri })).toThrow("ISOLATED_TARGET_REQUIRED");
  }
  expect(() => assertTarget({ MONGO_URI: env.CONFIDENTIALITY_MONGO_URI })).toThrow("ISOLATED_TARGET_REQUIRED");
  expect(() => backupKey({ CONFIDENTIALITY_BACKUP_KEY: process.env.DATA_ENCRYPTION_KEY, DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY })).toThrow("INDEPENDENT_BACKUP_KEY_REQUIRED");
  expect(backupKey({ CONFIDENTIALITY_BACKUP_KEY: "b".repeat(64), DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY })).toEqual(key);
  expect(() => argumentsFor(["--mode=apply", "--plan=/private/tmp/plan.json"])).toThrow("APPROVED_PLAN_DIGEST_REQUIRED");
  expect(() => argumentsFor(["--mode=plan", "--plan=relative.json"])).toThrow();
});
test("plan files are exclusive, owner-only and cannot follow symbolic links", () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "lpc-remediation-")); fs.chmodSync(directory, 0o700);
  const file = path.join(directory, "plan.json");
  try {
    writePrivatePlan(file, "encrypted envelope"); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readPrivatePlan(file)).toBe("encrypted envelope");
    expect(() => writePrivatePlan(file, "replacement")).toThrow();
    const link = path.join(directory, "link.json"); fs.symlinkSync(file, link); expect(() => readPrivatePlan(link)).toThrow();
    fs.chmodSync(file, 0o644); expect(() => readPrivatePlan(file)).toThrow("PRIVATE_PLAN_FILE_REQUIRED");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
