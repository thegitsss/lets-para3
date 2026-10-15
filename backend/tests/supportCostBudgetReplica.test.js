"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient } = require("mongoose").mongo;
const guard = require("../ai/supportCostBudget");
let client, db, collection, uri;
const stages = [];
const dbName = "lpc_assistant_budget_" + process.pid;
const env = { NODE_ENV: "staging", LPC_DEPLOYMENT_ENV: "staging", RENDER_SERVICE_ID: "srv-d10gdh24d50c73ap2p60", RENDER_GIT_COMMIT: "a".repeat(40) };
const key = "synthetic-replica-key";
function authority(extra = {}) {
  return { approved: true, syntheticOnly: true, productionAuthorized: false, scope: "lpc37-assistant-synthetic-provider-acceptance", serviceId: env.RENDER_SERVICE_ID, candidateCommit: env.RENDER_GIT_COMMIT, model: guard.MODEL, modelAccessConfirmed: true, modelAccessEvidenceSha256: "1".repeat(64), providerKeySha256: guard.sha(key), projectId: "proj_synthetic", standardGlobalTierConfirmed: true, pricingEvidenceSha256: "2".repeat(64), counterBilling: { confirmed: true, flatNanoUsdPerAttempt: 0, evidenceSha256: "3".repeat(64) }, ownerDecisionSha256: "4".repeat(64), packetId: "lpc-assistant-" + crypto.randomUUID(), capNanoUsd: 100000000, maxGenerationAttempts: 20, maxCountAttempts: 20, validFromUtc: new Date(Date.now() - 1000).toISOString(), validUntilUtc: new Date(Date.now() + 60000).toISOString(), databaseName: "lpc_staging_shared_20261012", journalCollection: guard.COLLECTION, executionMode: "hosted", allowedFeatures: ["lpc_support_manager"], syntheticSafetyIdentifiers: ["synthetic-subject"], allowedPromptSha256: [guard.sha("Synthetic replica prompt")], ...extra };
}
async function capture(label) {
  const records = await collection.find({}).sort({ _id: 1 }).toArray();
  const bytes = JSON.stringify(records);
  stages.push({ label, sha256: guard.sha(bytes), records: JSON.parse(bytes) });
}
beforeAll(async () => {
  uri = process.env.LPC_BUDGET_TEST_MONGO_URI || require("./helpers/mongoHarnessState").readReadyState().uri;
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\//, "only owned loopback Mongo is accepted");
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000, socketTimeoutMS: 15000 });
  await client.connect(); db = client.db(dbName); collection = db.collection(guard.COLLECTION);
}, 30000);
afterAll(async () => {
  if (collection) await capture("final-all-records");
  if (process.env.LPC_BUDGET_REPLICA_CAPTURE) fs.writeFileSync(path.resolve(process.env.LPC_BUDGET_REPLICA_CAPTURE), JSON.stringify({ schemaVersion: 1, proofClass: "one-real-local-collection; zero-provider; zero-native-browser", databaseName: dbName, stages }, null, 2));
  if (db) await db.dropDatabase();
  if (client) await client.close();
}, 30000);
test("actual concurrent reservations conserve the cap and distinct attempt identities", async () => {
  const a = authority(); await collection.insertOne(guard.initialDocument(a)); await capture("contention-before");
  const journal = guard.mongoJournal(() => collection, a);
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => journal.reserve("generation", 10000000, "5".repeat(64))));
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 10);
  assert.equal(outcomes.filter((r) => r.status === "rejected").length, 10);
  const saved = await collection.findOne({ _id: a.packetId });
  assert.equal(saved.remainingNanoUsd, 0); assert.equal(saved.generationAttempts, 10); assert.equal(saved.records.length, 10);
  assert.equal(new Set(saved.records.map((r) => r.attemptId)).size, 10); assert(saved.records.every((r) => r.state === "reserved"));
  await capture("contention-after");
});
test("a fresh connection retains unknown earlier holds and refunds a later known attempt once", async () => {
  const a = authority(); await collection.insertOne(guard.initialDocument(a)); const before = guard.mongoJournal(() => collection, a);
  const unknown = await before.reserve("generation", 24100000, "6".repeat(64)); await before.observe(unknown, { outcome: "synthetic_transport_unknown" });
  await capture("unknown-before-connection-restart"); await client.close();
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }); await client.connect(); db = client.db(dbName); collection = db.collection(guard.COLLECTION);
  const after = guard.mongoJournal(() => collection, a), known = await after.reserve("generation", 24100000, "6".repeat(64));
  await after.observe(known, { outcome: "synthetic_known_response" }, 3200000);
  await assert.rejects(after.observe(known, { outcome: "duplicate_settle" }, 0), /already settled/);
  const saved = await collection.findOne({ _id: a.packetId });
  assert.equal(saved.remainingNanoUsd, a.capNanoUsd - 24100000 - 3200000); assert.equal(saved.generationAttempts, 2);
  assert.equal(saved.records[0].state, "unknown_hold_retained"); assert.equal(saved.records[1].actualNanoUsd, 3200000);
  await capture("unknown-after-connection-restart-and-known-settlement");
});
test("lost acknowledgement after actual generation reservation commit sends no generation and keeps the durable hold", async () => {
  const a = authority(); await collection.insertOne(guard.initialDocument(a)); let calls = 0, generations = 0;
  const wrapped = { findOneAndUpdate: async (...args) => { const result = await collection.findOneAndUpdate(...args); if (args[1].$inc.generationAttempts) throw Error("synthetic_ack_lost_after_real_commit"); return result; }, updateOne: (...args) => collection.updateOne(...args) };
  const journal = guard.mongoJournal(() => wrapped, a);
  const fetch = guard.createGuardedFetch({ authority: a, env, journal, transport: async url => { calls += 1; if (url.endsWith("input_tokens")) return new Response(JSON.stringify({ object: "response.input_tokens", input_tokens: 1000 }), { status: 200 }); generations += 1; throw Error("must_not_transmit"); } });
  const body = JSON.stringify({ model: guard.MODEL, instructions: "Synthetic only", input: [{ role: "user", content: JSON.stringify({ latestUserMessage: "Synthetic replica prompt", userRole: "attorney" }) }], reasoning: { effort: "low" }, max_output_tokens: 1800, store: false, safety_identifier: "synthetic-subject", metadata: { feature: "lpc_support_manager", role: "attorney" } });
  await assert.rejects(fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: "Bearer " + key }, body }), /ack_lost/);
  assert.equal(calls, 1); assert.equal(generations, 0); const saved = await collection.findOne({ _id: a.packetId });
  assert.equal(saved.countAttempts, 1); assert.equal(saved.generationAttempts, 1); assert.equal(saved.records[0].state, "known"); assert.equal(saved.records[1].state, "reserved"); assert.equal(saved.remainingNanoUsd, a.capNanoUsd - 24100000);
  await capture("actual-generation-reservation-ack-lost-zero-generation-posts");
});
test("missing, changed-authority, attempt-exhausted and disabled journals all fail closed", async () => {
  const a = authority({ maxGenerationAttempts: 1 }); const journal = guard.mongoJournal(() => collection, a);
  await assert.rejects(journal.reserve("generation", 1, "7".repeat(64)), /durable reservation denied/);
  await collection.insertOne(guard.initialDocument(a));
  await assert.rejects(guard.mongoJournal(() => collection, { ...a, capNanoUsd: a.capNanoUsd - 1 }).reserve("generation", 1, "7".repeat(64)), /denied/);
  await journal.reserve("generation", 1, "7".repeat(64)); await assert.rejects(journal.reserve("generation", 1, "7".repeat(64)), /denied/);
  await journal.halt(); await assert.rejects(journal.reserve("count", 0, "7".repeat(64)), /denied/);
  const saved = await collection.findOne({ _id: a.packetId }); assert.equal(saved.remainingNanoUsd, a.capNanoUsd - 1); assert.equal(saved.generationAttempts, 1); assert.equal(saved.countAttempts, 0); assert.equal(saved.disabled, true);
  await capture("missing-changed-attempt-exhausted-disabled-conserved");
});
test("independent metadata client leases preserve the application fixture and close on concurrent success unknown send and denial", async () => {
  const mongoose = require("mongoose"), globalState = mongoose.connection.readyState;
  const app = await mongoose.createConnection(uri, { dbName: "lpc_assistant_appfixture_" + process.pid, serverSelectionTimeoutMS: 5000 }).asPromise();
  const marker = app.db.collection("ownedSyntheticMarker"), metadata = client.db("lpc_staging_shared_20261012"), saved = metadata.collection(guard.COLLECTION);
  const syntheticPrivateUri = "mongodb+srv://synthetic:loopback-fixture@metadata.example.invalid/lpc_staging_shared_20261012";
  const a = authority({ journalUriSha256: guard.sha(syntheticPrivateUri) }), e = { ...env, LPC_ASSISTANT_BUDGET_MONGO_URI: syntheticPrivateUri, STAGING_MONGO_HOST: "metadata.example.invalid" };
  const leases = [];
  async function captureMetadata(label) { const records = await saved.find({}).sort({ _id: 1 }).toArray(), bytes = JSON.stringify(records); stages.push({ label, databaseName: a.databaseName, sha256: guard.sha(bytes), records: JSON.parse(bytes) }); }
  try {
    await marker.insertOne({ _id: "owned", subject: "synthetic application fixture must remain private and unchanged", version: 1 });
    const before = JSON.stringify(await marker.find({}).toArray()); await saved.insertOne(guard.initialDocument(a)); await captureMetadata("independent-lease-before");
    const lease = guard.metadataJournalLease(a, e, { createClient: (approvedUri, options) => {
      assert.equal(approvedUri, syntheticPrivateUri); const native = new MongoClient(uri, options), observed = { topologyClosed: false };
      native.once("topologyClosed", () => { observed.topologyClosed = true; }); leases.push(observed); return native;
    } });
    let counts = 0, generations = 0, uncertain = false, unblock;
    const bothCounts = new Promise(resolve => { unblock = resolve; });
    const fetch = guard.createGuardedFetch({ authority: a, env: e, journalLease: lease, transport: async url => {
      if (url.endsWith("input_tokens")) { counts += 1; if (counts === 2) unblock(); await bothCounts; return new Response(JSON.stringify({ object: "response.input_tokens", input_tokens: 1000 }), { status: 200 }); }
      generations += 1; if (uncertain) throw Error("synthetic_accepted_send_unknown");
      return new Response(JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }), { status: 200 });
    } });
    const options = { method: "POST", headers: { authorization: "Bearer " + key }, body: JSON.stringify({ model: guard.MODEL, input: [{ role: "user", content: JSON.stringify({ latestUserMessage: "Synthetic replica prompt", userRole: "attorney" }) }], reasoning: { effort: "low" }, max_output_tokens: 1800, store: false, safety_identifier: "synthetic-subject", metadata: { feature: "lpc_support_manager", role: "attorney" } }) };
    await Promise.all([fetch("https://api.openai.com/v1/responses", options), fetch("https://api.openai.com/v1/responses", options)]);
    assert.equal(leases.length, 2); assert(leases.every(item => item.topologyClosed)); assert.equal(counts, 2); assert.equal(generations, 2);
    await captureMetadata("independent-two-concurrent-fetches-one-balance");
    uncertain = true; await assert.rejects(fetch("https://api.openai.com/v1/responses", options), /accepted_send_unknown/);
    assert.equal(leases.length, 3); assert(leases.every(item => item.topologyClosed)); assert.equal(counts, 2); assert.equal(generations, 3);
    const afterUnknown = await saved.findOne({ _id: a.packetId }); assert.equal(afterUnknown.remainingNanoUsd, a.capNanoUsd - 2 * 3200000 - 24100000); assert.equal(afterUnknown.records.length, 5); assert.equal(afterUnknown.records.at(-1).state, "unknown_hold_retained");
    await captureMetadata("independent-unknown-attempt-held-and-client-closed");
    await saved.updateOne({ _id: a.packetId }, { $set: { disabled: true } });
    await assert.rejects(fetch("https://api.openai.com/v1/responses", options), /durable reservation denied/); assert.equal(leases.length, 4); assert(leases.every(item => item.topologyClosed)); assert.equal(counts, 2); assert.equal(generations, 3);
    assert.equal(JSON.stringify(await marker.find({}).toArray()), before); assert.equal(app.readyState, 1); assert.equal(mongoose.connection.readyState, globalState);
    await captureMetadata("independent-disabled-no-send-all-clients-closed-app-unchanged");
  } finally { await metadata.dropDatabase(); await app.dropDatabase(); await app.close(); }
});
