require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const Case = require("../models/Case");
const { dateOnlyToUtcDate, normalizeDateOnly } = require("../utils/businessDate");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = Math.max(1, Math.min(1000, Number(process.env.MATTER_DEADLINE_BATCH_SIZE || 250)));

async function run({ apply = APPLY, mongoUri = process.env.MONGO_URI } = {}) {
  await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);

  const query = {
    deadline: { $ne: null },
    $or: [{ deadlineDate: "" }, { deadlineDate: null }, { deadlineDate: { $exists: false } }],
  };
  const total = await Case.countDocuments(query);
  let scanned = 0;
  let eligible = 0;
  let updated = 0;
  let lastId = null;
  const invalid = [];
  let invalidCount = 0;

  while (true) {
    const pageQuery = lastId ? { $and: [query, { _id: { $gt: lastId } }] } : query;
    const docs = await Case.find(pageQuery)
      .select("_id deadline deadlineDate title")
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();
    if (!docs.length) break;
    lastId = docs[docs.length - 1]._id;
    scanned += docs.length;

    const operations = [];
    docs.forEach((doc) => {
      const deadlineDate = normalizeDateOnly(doc.deadline);
      if (!deadlineDate) {
        invalidCount += 1;
        if (invalid.length < 100) {
          invalid.push({ id: String(doc._id), title: String(doc.title || ""), deadline: doc.deadline });
        }
        return;
      }
      eligible += 1;
      operations.push({
        updateOne: {
          filter: { _id: doc._id, $or: [{ deadlineDate: "" }, { deadlineDate: null }, { deadlineDate: { $exists: false } }] },
          update: { $set: { deadlineDate, deadline: dateOnlyToUtcDate(deadlineDate) } },
        },
      });
    });
    if (apply && operations.length) {
      const result = await Case.bulkWrite(operations, { ordered: false });
      updated += Number(result.modifiedCount || 0);
    }
  }

  const result = {
    mode: apply ? "apply" : "dry-run",
    total,
    scanned,
    eligible,
    updated,
    invalidCount,
    invalidSample: invalid,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run()
    .then((result) => {
      if (result.invalidCount > 0) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { run };
