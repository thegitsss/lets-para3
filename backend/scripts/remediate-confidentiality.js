#!/usr/bin/env node
"use strict";

// Deliberately does not load .env or inherit MONGO_URI. The operator selects
// the isolated restore target and separately supplies the backup key.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient } = require("mongoose").mongo;
const { createPlan, applyPlan, sealPlan, openPlan } = require("../services/confidentialityRemediation");
process.umask(0o077);
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };

function argumentsFor(argv) {
  const options = {};
  for (const argument of argv) {
    const match = /^--(mode|plan|approved-sha256|limit)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(options, match[1])) fail("INVALID_ARGUMENTS");
    options[match[1]] = match[2];
  }
  if (!["plan", "apply", "rollback"].includes(options.mode) || !path.isAbsolute(options.plan || "")) fail("EXPLICIT_MODE_AND_ABSOLUTE_PLAN_REQUIRED");
  if (options.mode !== "plan" && !/^[a-f0-9]{64}$/.test(options["approved-sha256"] || "")) fail("APPROVED_PLAN_DIGEST_REQUIRED");
  if (options.limit && (!/^\d+$/.test(options.limit) || Number(options.limit) < 1 || Number(options.limit) > 10000)) fail("INVALID_PLAN_LIMIT");
  return options;
}
function assertTarget(env) {
  const uri = String(env.CONFIDENTIALITY_MONGO_URI || "");
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9_-]+(?:\?|$)/.test(uri)
    || env.CONFIRM_CONFIDENTIALITY_TARGET !== "ISOLATED_NON_PRODUCTION") fail("ISOLATED_TARGET_REQUIRED");
  // Remote/production support is intentionally absent until restore and owner
  // approval evidence is available. A confirmation string cannot bypass it.
  const parsed = new URL(uri);
  if (parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password
    || [...parsed.searchParams.keys()].some(key => !["replicaSet", "directConnection"].includes(key))) fail("ISOLATED_TARGET_REQUIRED");
  return uri;
}
function backupKey(env) {
  const raw = String(env.CONFIDENTIALITY_BACKUP_KEY || "");
  if (!/^[a-f0-9]{64}$/i.test(raw)) fail("INDEPENDENT_BACKUP_KEY_REQUIRED");
  const key = Buffer.from(raw, "hex"), dataRaw = String(env.DATA_ENCRYPTION_KEY || "").trim();
  const dataKey = /^[a-f0-9]{64}$/i.test(dataRaw) ? Buffer.from(dataRaw, "hex") : Buffer.from(dataRaw, "base64");
  if (dataKey.length !== 32 || crypto.timingSafeEqual(key, dataKey)) fail("INDEPENDENT_BACKUP_KEY_REQUIRED");
  return key;
}
function assertPrivateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077) fail("PRIVATE_PLAN_DIRECTORY_REQUIRED");
  let current = directory;
  while (current !== path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) fail("SYMLINK_PLAN_PATH_REJECTED");
    current = path.dirname(current);
  }
}
function readPrivatePlan(file) {
  assertPrivateDirectory(path.dirname(file));
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 256 * 1024 * 1024) fail("PRIVATE_PLAN_FILE_REQUIRED");
    return fs.readFileSync(descriptor, "utf8");
  } finally { fs.closeSync(descriptor); }
}
function writePrivatePlan(file, envelope) {
  assertPrivateDirectory(path.dirname(file));
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, envelope); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}
async function run(argv = process.argv.slice(2), env = process.env) {
  const options = argumentsFor(argv), uri = assertTarget(env), key = backupKey(env);
  const targetDigest = sha256(uri);
  let plan;
  if (options.mode !== "plan") {
    const envelope = readPrivatePlan(options.plan);
    if (sha256(envelope) !== options["approved-sha256"]) fail("PLAN_DIGEST_MISMATCH");
    plan = openPlan(envelope, key);
    if (env.CONFIRM_CONFIDENTIALITY_WRITES !== "REVIEWED_ISOLATED_PLAN") fail("ISOLATED_WRITE_REVIEW_REQUIRED");
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 10000, socketTimeoutMS: 15000,
    maxPoolSize: 2, promoteLongs: false });
  try {
    await client.connect();
    if (options.mode === "plan") {
      plan = await createPlan(client.db(), { targetDigest, limit: Number(options.limit || 10000) });
      const envelope = sealPlan(plan, key);
      writePrivatePlan(options.plan, envelope);
      return { mode: "plan", ...plan.counts, held: plan.holds.length, sha256: sha256(envelope), productionCapable: false };
    }
    const result = await applyPlan(client.db(), client, plan, { targetDigest, reverse: options.mode === "rollback" });
    return { mode: options.mode, ...result, productionCapable: false };
  } finally { await client.close(); }
}
if (require.main === module) run().then(result => console.log(JSON.stringify(result))).catch(error => {
  // Driver errors can contain connection details. Never emit those or records.
  const code = /^[A-Z_]{3,80}$/.test(error.code || "") ? error.code : "EXECUTION_FAILED";
  console.error(`[confidentiality-remediation] ${code}`); process.exitCode = 1;
});
module.exports = { argumentsFor, assertTarget, backupKey, readPrivatePlan, writePrivatePlan, run };
