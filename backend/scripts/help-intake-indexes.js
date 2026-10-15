const path = require("path");
const mongoose = require("mongoose");
const Incident = require("../models/Incident");
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require("../utils/mongooseOperationPolicy");

const [key, options] = Incident.schema.indexes().find(([, value]) => value.name === "help_reporter_request_unique");

async function checkHelpIntakeIndex() {
  const indexes = await Incident.collection.indexes();
  return indexes.some(index => index.unique === true
    && JSON.stringify(index.key) === JSON.stringify(key)
    && JSON.stringify(index.partialFilterExpression) === JSON.stringify(options.partialFilterExpression));
}

async function ensureHelpIntakeIndex() {
  // Add only this partial unique index. Existing incidents without a request
  // key are excluded; do not rewrite data or drop unrelated indexes.
  await Incident.collection.createIndex(key, options);
  if (!await checkHelpIntakeIndex()) throw new Error("Help intake index could not be verified");
}

async function main() {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
  try {
    if (process.argv.slice(2).some(value => !["--check", "--apply"].includes(value))) throw new Error("Unknown option");
    await mongoose.connect(requireMongoUri(process.env.MONGO_URI), { ...MONGO_OPERATION_OPTIONS, autoCreate: false, autoIndex: false });
    if (process.argv.includes("--apply")) await ensureHelpIntakeIndex();
    if (!await checkHelpIntakeIndex()) throw new Error("Required Help intake index is missing");
    console.log("[help-intake] Required uniqueness index is ready.");
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) main().catch(() => {
  console.error("[help-intake] Index check/preparation failed. Check database connectivity and conflicting records before enabling keyed intake.");
  process.exitCode = 1;
});

module.exports = { checkHelpIntakeIndex, ensureHelpIntakeIndex };
