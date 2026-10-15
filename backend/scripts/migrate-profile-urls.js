require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const User = require("../models/User");
const { normalizeHttpUrl } = require("../utils/httpUrl");
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require("../utils/mongooseOperationPolicy");

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = Math.max(1, Math.min(1000, Number(process.env.PROFILE_URL_MIGRATION_BATCH_SIZE || 250)));

function buildProfileUrlUpdate(user = {}) {
  const update = {};
  const outcomes = [];
  const linkedInRaw = String(user.linkedInURL || "").trim();
  if (linkedInRaw) {
    const linkedIn = normalizeHttpUrl(linkedInRaw, {
      fieldLabel: "LinkedIn URL",
      requiredHost: "linkedin.com",
    });
    if (!linkedIn.ok) {
      update.linkedInURL = null;
      outcomes.push("invalid_linkedin_cleared");
    } else if (linkedIn.value !== linkedInRaw) {
      update.linkedInURL = linkedIn.value;
      outcomes.push("linkedin_canonicalized");
    }
  }

  const firmWebsiteRaw = String(user.firmWebsite || "").trim();
  if (firmWebsiteRaw) {
    const firmWebsite = normalizeHttpUrl(firmWebsiteRaw, { fieldLabel: "Firm website" });
    if (!firmWebsite.ok) {
      update.firmWebsite = "";
      outcomes.push("invalid_firm_website_cleared");
    } else if (firmWebsite.value !== firmWebsiteRaw) {
      update.firmWebsite = firmWebsite.value;
      outcomes.push("firm_website_canonicalized");
    }
  }

  return { update, outcomes };
}

async function run({ apply = APPLY, mongoUri = process.env.MONGO_URI } = {}) {
  await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
  const query = {
    $or: [
      { linkedInURL: { $nin: [null, ""] } },
      { firmWebsite: { $nin: [null, ""] } },
    ],
  };
  let scanned = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let lastId = null;
  const outcomeCounts = {};

  while (true) {
    const pageQuery = lastId ? { $and: [query, { _id: { $gt: lastId } }] } : query;
    const users = await User.find(pageQuery)
      .select("_id linkedInURL firmWebsite")
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();
    if (!users.length) break;
    lastId = users[users.length - 1]._id;
    scanned += users.length;
    const operations = [];
    for (const user of users) {
      const result = buildProfileUrlUpdate(user);
      if (!Object.keys(result.update).length) continue;
      wouldUpdate += 1;
      result.outcomes.forEach((outcome) => {
        outcomeCounts[outcome] = Number(outcomeCounts[outcome] || 0) + 1;
      });
      operations.push({
        updateOne: {
          filter: { _id: user._id },
          update: { $set: result.update },
        },
      });
    }
    if (apply && operations.length) {
      const writeResult = await User.collection.bulkWrite(operations, { ordered: false });
      updated += Number(writeResult.modifiedCount || 0);
    }
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    scanned,
    wouldUpdate,
    updated,
    outcomes: outcomeCounts,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  run()
    .then((summary) => {
      if (!APPLY && summary.wouldUpdate > 0) process.exitCode = 2;
      if (APPLY && summary.updated !== summary.wouldUpdate) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { buildProfileUrlUpdate, run };
