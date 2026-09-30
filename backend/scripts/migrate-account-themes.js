require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const User = require("../models/User");
const {
  SUPPORTED_ACCOUNT_THEMES,
  normalizeAccountTheme,
  parseAccountTheme,
} = require("../utils/accountPreferences");
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require("../utils/mongooseOperationPolicy");

const APPLY = process.argv.includes("--apply");
const APPLY_CONFIRMATION = "TRANSITION ACCOUNT THEMES TO CURRENT DASHBOARD";
const BATCH_SIZE = Math.max(1, Math.min(1000, Number(process.env.ACCOUNT_THEME_MIGRATION_BATCH_SIZE || 250)));

function readExpectedCount(argv = process.argv) {
  const argument = argv.find((value) => value.startsWith("--expected-count="));
  if (!argument) return null;
  const count = Number(argument.slice("--expected-count=".length));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function buildAccountThemeUpdate(storedTheme) {
  if (parseAccountTheme(storedTheme)) return null;
  return { "preferences.theme": normalizeAccountTheme(storedTheme) };
}

function transitionFilter() {
  return {
    $and: [
      { "preferences.theme": { $type: "string" } },
      { "preferences.theme": { $nin: SUPPORTED_ACCOUNT_THEMES } },
    ],
  };
}

async function run({
  apply = APPLY,
  mongoUri = process.env.MONGO_URI,
  confirmation = process.env.ACCOUNT_THEME_MIGRATION_CONFIRM,
  expectedCount = readExpectedCount(),
} = {}) {
  if (apply && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`Apply mode requires ACCOUNT_THEME_MIGRATION_CONFIRM="${APPLY_CONFIRMATION}".`);
  }
  if (apply && expectedCount === null) {
    throw new Error("Apply mode requires --expected-count=<dry-run wouldUpdate count>.");
  }

  await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
  const filter = transitionFilter();
  let scanned = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let lastId = null;
  const targetCounts = { light: 0, dark: 0 };
  const plannedOperations = [];

  while (true) {
    const pageFilter = lastId ? { $and: [filter, { _id: { $gt: lastId } }] } : filter;
    const users = await User.collection
      .find(pageFilter, { projection: { _id: 1, "preferences.theme": 1 } })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .toArray();
    if (!users.length) break;
    lastId = users[users.length - 1]._id;
    scanned += users.length;

    for (const user of users) {
      const storedTheme = user.preferences?.theme;
      const update = buildAccountThemeUpdate(storedTheme);
      if (!update) continue;
      wouldUpdate += 1;
      targetCounts[update["preferences.theme"]] += 1;
      plannedOperations.push({
        updateOne: {
          filter: { _id: user._id, "preferences.theme": storedTheme },
          update: { $set: update },
        },
      });
    }

  }

  if (apply && wouldUpdate !== expectedCount) {
    throw new Error(`Expected ${expectedCount} account theme updates, but found ${wouldUpdate}. No count mismatch is accepted.`);
  }
  if (apply) {
    for (let offset = 0; offset < plannedOperations.length; offset += BATCH_SIZE) {
      const result = await User.collection.bulkWrite(
        plannedOperations.slice(offset, offset + BATCH_SIZE),
        { ordered: false }
      );
      updated += Number(result.modifiedCount || 0);
    }
  }
  if (apply && updated !== wouldUpdate) {
    throw new Error(`Updated ${updated} of ${wouldUpdate} expected account theme records; concurrent changes require review.`);
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    scanned,
    wouldUpdate,
    updated,
    targetCounts,
    fieldsChanged: ["preferences.theme"],
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  run()
    .then((summary) => {
      if (!APPLY && summary.wouldUpdate > 0) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = {
  APPLY_CONFIRMATION,
  buildAccountThemeUpdate,
  readExpectedCount,
  run,
  transitionFilter,
};
