const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Stripe = require("stripe");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const {
  currentStripeMode,
  pickStripeMode,
  stripeModeFromSecret,
} = require("../utils/stripeMode");

const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || "2024-06-20";

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

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI);

  const limit = Math.max(1, Number(process.env.STRIPE_MODE_BACKFILL_LIMIT || 500));
  const cases = await Case.find({
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
  })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select("_id paymentIntentId escrowIntentId payoutTransferId stripeMode")
    .lean();

  let updated = 0;
  let unknown = 0;

  for (const caseDoc of cases) {
    const detectedMode = pickStripeMode(caseDoc.stripeMode, await detectModeFromStripe(caseDoc));
    if (detectedMode === "unknown") {
      unknown += 1;
      continue;
    }
    await Promise.all([
      Case.updateOne({ _id: caseDoc._id }, { $set: { stripeMode: detectedMode } }),
      Payout.updateOne({ caseId: caseDoc._id }, { $set: { stripeMode: detectedMode } }),
      PlatformIncome.updateOne({ caseId: caseDoc._id }, { $set: { stripeMode: detectedMode } }),
    ]);
    updated += 1;
  }

  console.log(JSON.stringify({ scanned: cases.length, updated, unknown }, null, 2));
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
