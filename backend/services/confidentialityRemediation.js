"use strict";

const crypto = require("node:crypto");
const { BSON } = require("mongoose").mongo;
const { isEncryptionEnabled, isEncrypted, encryptString, decryptString,
  encryptCaseFileFields } = require("../utils/dataEncryption");

const COLLECTIONS = Object.freeze(["messages", "casefiles", "notifications"]);
const MESSAGE_FIELDS = Object.freeze(["text", "transcript", "fileName", "fileKey", "content"]);
const FILE_FIELDS = Object.freeze(["originalName", "storageKey", "previewKey", "revisionNotes", "history",
  "originalNameHash", "storageKeyHash", "storageKeyFingerprint"]);
const CONTENT_FIELDS = Object.freeze(["text", "transcript", "fileName", "fileKey", "originalName", "storageKey", "name", "key"]);
const NOTICE_COPIES = new Set(["messageSnippet", "preview", "message", "text", "content", "transcript",
  "body", "snippet", "messageBody", "lastMessageSnippet", "fileName", "fileKey"]);
const serialize = value => BSON.serialize({ value });
const clone = value => value === undefined ? undefined : BSON.deserialize(serialize(value), { promoteLongs: false }).value;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash("sha256").update(JSON.stringify(canonical(
  JSON.parse(BSON.EJSON.stringify({ value }, { relaxed: false }))
))).digest("hex");
function blocked(code) { return Object.assign(new Error(`Confidentiality remediation stopped: ${code}.`), { code }); }

function protect(value, counts) {
  if (typeof value !== "string" || !value) return value;
  if (isEncrypted(value)) {
    decryptString(value); // A marker alone never establishes valid ciphertext.
    counts.authenticated++;
    return value;
  }
  counts.plaintext++;
  return encryptString(value, { plaintext: true });
}
function protectContent(value, counts) {
  if (typeof value === "string") return protect(value, counts);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (Array.isArray(value)) return value.map(item => protectContent(item, counts));
    return value;
  }
  const next = clone(value);
  for (const field of CONTENT_FIELDS) if (Object.hasOwn(next, field)) next[field] = protect(next[field], counts);
  if (Array.isArray(next.files)) next.files = next.files.map(item => protectContent(item, counts));
  return next;
}
function removeNoticeCopies(value) {
  if (Array.isArray(value)) return value.map(removeNoticeCopies);
  if (!value || typeof value !== "object" || value instanceof Date || value._bsontype) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !NOTICE_COPIES.has(key))
    .map(([key, item]) => [key, removeNoticeCopies(item)]));
}
function projectChange(collection, original) {
  if (!COLLECTIONS.includes(collection) || !original?._id) throw blocked("INVALID_RECORD_SCOPE");
  if (!isEncryptionEnabled()) throw blocked("DATA_KEY_REQUIRED");
  const next = clone(original), counts = { plaintext: 0, authenticated: 0 };
  let fields;
  if (collection === "messages") {
    fields = MESSAGE_FIELDS;
    for (const field of fields) if (Object.hasOwn(next, field)) {
      next[field] = field === "content" ? protectContent(next[field], counts) : protect(next[field], counts);
    }
  } else if (collection === "casefiles") {
    fields = FILE_FIELDS;
    // Authenticate every existing envelope before calling the normal writer,
    // which also accepts marker-looking new plaintext. Legacy reads cannot.
    for (const field of ["originalName", "storageKey", "previewKey", "revisionNotes"]) {
      if (Object.hasOwn(next, field)) next[field] = protect(next[field], counts);
    }
    if (Array.isArray(next.history)) for (const item of next.history) {
      if (item && Object.hasOwn(item, "storageKey")) item.storageKey = protect(item.storageKey, counts);
    }
    encryptCaseFileFields(next);
    for (const field of ["originalNameHash", "storageKeyHash", "storageKeyFingerprint"]) {
      if (original[field] && original[field] !== next[field]) throw blocked("CONFLICTING_FILE_IDENTITY");
    }
  } else {
    if (original.type !== "message") return { changes: [], counts };
    fields = ["message", "payload", ...NOTICE_COPIES].filter((field, index, values) => values.indexOf(field) === index);
    next.message = "You have a new Matter message.";
    if (Object.hasOwn(next, "payload")) next.payload = removeNoticeCopies(next.payload);
    for (const field of NOTICE_COPIES) if (field !== "message" && field !== "payload") delete next[field];
  }
  const changes = fields.filter(field => Object.hasOwn(original, field) !== Object.hasOwn(next, field)
    || digest(original[field]) !== digest(next[field])).map(field => ({
    field, beforePresent: Object.hasOwn(original, field), afterPresent: Object.hasOwn(next, field),
    ...(Object.hasOwn(original, field) ? { before: clone(original[field]) } : {}),
    ...(Object.hasOwn(next, field) ? { after: clone(next[field]) } : {}),
  }));
  return { changes, counts, sourceDigest: digest(original), proposedDigest: digest(next) };
}

async function createPlan(db, { targetDigest, limit = 10000 } = {}) {
  if (!/^[a-f0-9]{64}$/.test(targetDigest || "") || !Number.isSafeInteger(limit) || limit < 1) throw blocked("INVALID_PLAN_SCOPE");
  if (!isEncryptionEnabled()) throw blocked("DATA_KEY_REQUIRED");
  const plan = { version: 1, id: crypto.randomUUID(), targetDigest, createdAt: new Date(), rows: [], holds: [],
    counts: { scanned: 0, changed: 0, plaintext: 0, authenticated: 0 } };
  for (const collection of COLLECTIONS) {
    const cursor = db.collection(collection).find(collection === "notifications" ? { type: "message" } : {})
      .sort({ _id: 1 }).batchSize(100).maxTimeMS(10000);
    try {
      for await (const document of cursor) {
        if (++plan.counts.scanned > limit) throw blocked("PLAN_RECORD_LIMIT");
        try {
          const result = projectChange(collection, document);
          plan.counts.plaintext += result.counts.plaintext;
          plan.counts.authenticated += result.counts.authenticated;
          if (result.changes.length) {
            plan.rows.push({ collection, id: document._id, ...result });
            plan.counts.changed++;
          }
        } catch (error) {
          // Record identities and reasons only inside the encrypted plan.
          plan.holds.push({ collection, id: document._id, code: error.code || "CIPHERTEXT_AUTHENTICATION_FAILED" });
        }
      }
    } finally { await cursor.close(); }
  }
  return plan;
}

function validatePlan(plan, targetDigest) {
  if (plan?.version !== 1 || !/^[a-f0-9]{64}$/.test(targetDigest || "") || plan.targetDigest !== targetDigest
    || !Array.isArray(plan.rows) || !Array.isArray(plan.holds) || plan.holds.length) throw blocked("PLAN_NOT_ACCEPTED");
  const identities = new Set();
  for (const row of plan.rows) {
    const allowed = row.collection === "messages" ? MESSAGE_FIELDS : row.collection === "casefiles" ? FILE_FIELDS
      : row.collection === "notifications" ? ["message", "payload", ...NOTICE_COPIES] : [];
    const identity = `${row.collection}:${String(row.id)}`;
    if (!/^[a-f0-9]{24}$/i.test(String(row.id || "")) || identities.has(identity) || !/^[a-f0-9]{64}$/.test(row.sourceDigest || "")
      || !/^[a-f0-9]{64}$/.test(row.proposedDigest || "") || !Array.isArray(row.changes) || !row.changes.length
      || row.changes.some(change => !allowed.includes(change.field) || typeof change.beforePresent !== "boolean"
        || typeof change.afterPresent !== "boolean"
        || change.beforePresent !== Object.hasOwn(change, "before") || change.afterPresent !== Object.hasOwn(change, "after"))
      || new Set(row.changes.map(change => change.field)).size !== row.changes.length) throw blocked("INVALID_PLAN_RECORD");
    identities.add(identity);
  }
}

function mutation(row, reverse) {
  const filter = { _id: row.id }, set = {}, unset = {};
  for (const change of row.changes) {
    const present = reverse ? change.beforePresent : change.afterPresent;
    if (present) set[change.field] = reverse ? change.before : change.after;
    else unset[change.field] = "";
    const expectedPresent = reverse ? change.afterPresent : change.beforePresent;
    filter[change.field] = expectedPresent ? { $eq: reverse ? change.after : change.before, $exists: true } : { $exists: false };
  }
  return { filter, update: { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) } };
}

async function applyPlan(db, client, plan, { targetDigest, reverse = false } = {}) {
  validatePlan(plan, targetDigest);
  const result = { changed: 0, alreadyApplied: 0 };
  const session = client.startSession();
  try {
    for (const row of plan.rows) {
      let changed = false;
      await session.withTransaction(async () => {
        changed = false;
        const collection = db.collection(row.collection);
        const current = await collection.findOne({ _id: row.id }, { session, maxTimeMS: 10000 });
        const currentDigest = current ? digest(current) : "";
        const expected = reverse ? row.proposedDigest : row.sourceDigest;
        const completed = reverse ? row.sourceDigest : row.proposedDigest;
        if (currentDigest === completed) return;
        if (currentDigest !== expected) throw blocked("RECORD_CHANGED");
        const { filter, update } = mutation(row, reverse);
        const saved = await collection.updateOne(filter, update, { session, maxTimeMS: 10000 });
        if (saved.matchedCount !== 1 || saved.modifiedCount !== 1) throw blocked("RECORD_CHANGED");
        changed = true;
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
      if (changed) result.changed++;
      else result.alreadyApplied++;
    }
  } finally { await session.endSession(); }
  return result;
}

function sealPlan(plan, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw blocked("BACKUP_KEY_REQUIRED");
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("lpc-confidentiality-plan:v1"));
  const encrypted = Buffer.concat([cipher.update(serialize(plan)), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") }) + "\n";
}
function openPlan(envelope, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw blocked("BACKUP_KEY_REQUIRED");
  const sealed = JSON.parse(envelope);
  if (sealed?.version !== 1) throw blocked("INVALID_PLAN_ENVELOPE");
  const iv = Buffer.from(sealed.iv || "", "base64"), tag = Buffer.from(sealed.tag || "", "base64");
  if (iv.length !== 12 || tag.length !== 16) throw blocked("INVALID_PLAN_ENVELOPE");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from("lpc-confidentiality-plan:v1")); decipher.setAuthTag(tag);
  return BSON.deserialize(Buffer.concat([decipher.update(Buffer.from(sealed.data || "", "base64")), decipher.final()]), { promoteLongs: false }).value;
}

module.exports = { COLLECTIONS, digest, projectChange, createPlan, validatePlan, applyPlan, sealPlan, openPlan };
