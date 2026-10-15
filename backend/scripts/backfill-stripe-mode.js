const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const Stripe = require("stripe");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const { SUPPORTED_STRIPE_API_VERSION } = require("../utils/productionOrigin");
const {
  currentStripeMode,
  pickStripeMode,
  stripeModeFromSecret,
} = require("../utils/stripeMode");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || SUPPORTED_STRIPE_API_VERSION;

function buildClient(secret) {
  if (!secret) return null;
  return new Stripe(secret, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 1,
    timeout: Number(process.env.STRIPE_TIMEOUT_MS || 20000),
  });
}

const keyCandidates = [
  { mode: stripeModeFromSecret(process.env.STRIPE_LIVE_SECRET_KEY), client: buildClient(process.env.STRIPE_LIVE_SECRET_KEY) },
  { mode: stripeModeFromSecret(process.env.STRIPE_TEST_SECRET_KEY), client: buildClient(process.env.STRIPE_TEST_SECRET_KEY) },
  { mode: currentStripeMode(), client: buildClient(process.env.STRIPE_SECRET_KEY) },
].filter((entry) => entry.client && entry.mode !== "unknown");

async function detectModeFromStripe(caseDoc) {
  const paymentIntentId = caseDoc.paymentIntentId || caseDoc.escrowIntentId;
  const payoutTransferId = caseDoc.payoutTransferId;

  for (const { mode, client } of keyCandidates) {
    try {
      if (paymentIntentId) {
        await client.paymentIntents.retrieve(paymentIntentId);
        return mode;
      }
      if (payoutTransferId) {
        await client.transfers.retrieve(payoutTransferId);
        return mode;
      }
    } catch (err) {
      const code = err?.code || err?.raw?.code || "";
      if (code === "resource_missing") continue;
      console.warn(`[backfill-stripe-mode] ${caseDoc._id} lookup failed in ${mode}:`, err?.message || err);
    }
  }

  return "unknown";
}

async function run({ apply = process.argv.includes("--apply") } = {}) {
  const mongoUri = requireMongoUri(process.env.MONGO_URI);
  await mongoose.connect(mongoUri, MONGO_OPERATION_OPTIONS);

  const limit = Math.max(1, Math.min(1000, Number(process.env.STRIPE_MODE_BACKFILL_LIMIT || 500)));
  const eligibleMatch = {
    $and: [
      { $or: [{ stripeMode: { $exists: false } }, { stripeMode: "unknown" }] },
      {
        $or: [
          { paymentIntentId: { $nin: [null, ""] } },
          { escrowIntentId: { $nin: [null, ""] } },
          { payoutTransferId: { $nin: [null, ""] } },
        ],
      },
    ],
  };
  const totalEligible = await Case.countDocuments(eligibleMatch);
  const cases = await Case.find(eligibleMatch)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select("_id paymentIntentId escrowIntentId payoutTransferId stripeMode")
    .lean();

  let updated = 0;
  let wouldUpdate = 0;
  let unknown = 0;

  for (const caseDoc of cases) {
    const detectedMode = pickStripeMode(caseDoc.stripeMode, await detectModeFromStripe(caseDoc));
    if (detectedMode === "unknown") {
      unknown += 1;
      continue;
    }
    if (!apply) {
      wouldUpdate += 1;
      continue;
    }

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Case.updateOne({ _id: caseDoc._id }, { $set: { stripeMode: detectedMode } }, { session });
        await Payout.updateOne({ caseId: caseDoc._id }, { $set: { stripeMode: detectedMode } }, { session });
        await PlatformIncome.updateOne(
          { caseId: caseDoc._id },
          { $set: { stripeMode: detectedMode } },
          { session }
        );
      });
      updated += 1;
    } finally {
      await session.endSession();
    }
  }

  const remaining = apply
    ? await Case.countDocuments(eligibleMatch)
    : totalEligible;
  const summary = {
    mode: apply ? "apply" : "dry-run",
    scanned: cases.length,
    wouldUpdate,
    updated,
    unknown,
    remaining,
  };
  console.log(JSON.stringify(summary, null, 2));
  await mongoose.connection.close();
  return summary;
}

if (require.main === module) {
  run()
    .then((summary) => {
      if (summary.unknown > 0 || (summary.mode === "apply" && summary.remaining > 0)) {
        process.exitCode = 2;
      }
    })
    .catch(async (err) => {
      console.error(err?.message || err);
      try {
        await mongoose.connection.close();
      } catch (closeError) {
        console.error("[backfill-stripe-mode] MongoDB close failed:", closeError?.message || closeError);
      }
      process.exitCode = 1;
    });
}

module.exports = { run };
