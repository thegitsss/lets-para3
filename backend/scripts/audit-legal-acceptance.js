require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const User = require("../models/User");
const {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
} = require("../utils/legalDocuments");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const requireComplete = process.argv.includes("--require-complete");

async function main() {
  await mongoose.connect(requireMongoUri(process.env.MONGO_URI), MONGO_OPERATION_OPTIONS);

  const eligible = {
    status: "approved",
    disabled: { $ne: true },
    deleted: { $ne: true },
  };
  const missing = {
    ...eligible,
    $or: [
      { termsAccepted: { $ne: true } },
      { termsVersion: { $ne: CURRENT_TERMS_VERSION } },
      { termsAcceptedAt: null },
      { privacyVersion: { $ne: CURRENT_PRIVACY_VERSION } },
      { privacyAcknowledgedAt: null },
    ],
  };

  const [eligibleCount, missingCount, missingByRole] = await Promise.all([
    User.countDocuments(eligible),
    User.countDocuments(missing),
    User.aggregate([
      { $match: missing },
      { $group: { _id: "$role", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const report = {
    generatedAt: new Date().toISOString(),
    versions: { terms: CURRENT_TERMS_VERSION, privacy: CURRENT_PRIVACY_VERSION },
    approvedActiveUsers: eligibleCount,
    currentAcceptances: eligibleCount - missingCount,
    missingAcceptances: missingCount,
    missingByRole: Object.fromEntries(missingByRole.map((row) => [row._id || "unknown", row.count])),
  };
  console.log(JSON.stringify(report, null, 2));

  if (requireComplete && missingCount > 0) {
    throw new Error(`${missingCount} approved active user(s) have not accepted the current legal documents.`);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`[legal-acceptance] ${error?.message || error}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.connection.close().catch(() => {});
    });
}

module.exports = { main };
