const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const Case = require("../models/Case");
const {
  DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT,
  DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT,
} = require("../services/platformFeePolicy");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const DEFAULT_ATTORNEY_FEE_PCT = DEFAULT_ATTORNEY_PLATFORM_FEE_PERCENT;
const DEFAULT_PARALEGAL_FEE_PCT = DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;

function cents(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num);
}

function computeFee(baseAmount, pct) {
  return Math.max(0, Math.round(cents(baseAmount) * ((Number(pct) || 0) / 100)));
}

async function run({ apply = process.argv.includes("--apply"), mongoUri = process.env.MONGO_URI } = {}) {
  await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);

  const limit = Math.max(1, Math.min(1000, Number(process.env.ATTORNEY_FEE_BACKFILL_LIMIT || 500)));
  const query = {
    $or: [
      {
        $and: [
          { $or: [{ lockedTotalAmount: { $gt: 0 } }, { totalAmount: { $gt: 0 } }] },
          {
            $or: [
              { feeAttorneyAmount: { $exists: false } },
              { feeAttorneyAmount: null },
              { feeAttorneyAmount: { $lte: 0 } },
              { feeParalegalAmount: { $exists: false } },
              { feeParalegalAmount: null },
              { feeParalegalAmount: { $lte: 0 } },
            ],
          },
        ],
      },
      {
        $and: [
          { "disputeSettlement.grossAmount": { $gt: 0 } },
          {
            $or: [
              { "disputeSettlement.feeAttorneyAmount": { $exists: false } },
              { "disputeSettlement.feeAttorneyAmount": null },
              { "disputeSettlement.feeAttorneyAmount": { $lte: 0 } },
              { "disputeSettlement.feeParalegalAmount": { $exists: false } },
              { "disputeSettlement.feeParalegalAmount": null },
              { "disputeSettlement.feeParalegalAmount": { $lte: 0 } },
            ],
          },
        ],
      },
    ],
  };

  const cases = await Case.find(query)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select(
      "_id totalAmount lockedTotalAmount feeAttorneyPct feeAttorneyAmount feeParalegalPct feeParalegalAmount disputeSettlement"
    )
    .lean();

  let scanned = 0;
  let updated = 0;
  let settlementUpdated = 0;

  for (const doc of cases) {
    scanned += 1;
    let touched = false;
    const update = {};

    const baseAmount = cents(doc.lockedTotalAmount ?? doc.totalAmount);
    const attorneyPct = Number.isFinite(doc.feeAttorneyPct)
      ? doc.feeAttorneyPct
      : DEFAULT_ATTORNEY_FEE_PCT;
    const paralegalPct = Number.isFinite(doc.feeParalegalPct)
      ? doc.feeParalegalPct
      : DEFAULT_PARALEGAL_FEE_PCT;

    if (baseAmount > 0) {
      const nextAttorneyFee = computeFee(baseAmount, attorneyPct);
      const nextParalegalFee = computeFee(baseAmount, paralegalPct);
      if (cents(doc.feeAttorneyAmount) !== nextAttorneyFee) {
        update.feeAttorneyAmount = nextAttorneyFee;
        touched = true;
      }
      if (!Number.isFinite(doc.feeAttorneyPct) || doc.feeAttorneyPct !== attorneyPct) {
        update.feeAttorneyPct = attorneyPct;
        touched = true;
      }
      if (!Number.isFinite(doc.feeParalegalPct) || doc.feeParalegalPct !== paralegalPct) {
        update.feeParalegalPct = paralegalPct;
        touched = true;
      }
      if (cents(doc.feeParalegalAmount) !== nextParalegalFee) {
        update.feeParalegalAmount = nextParalegalFee;
        touched = true;
      }
    }

    const settlement = doc.disputeSettlement;
    const settlementBase = cents(settlement?.grossAmount);
    if (settlement && settlementBase > 0) {
      const settlementAttorneyPct = Number.isFinite(settlement.feeAttorneyPct)
        ? settlement.feeAttorneyPct
        : attorneyPct;
      const settlementParalegalPct = Number.isFinite(settlement.feeParalegalPct)
        ? settlement.feeParalegalPct
        : paralegalPct;
      const nextSettlementAttorneyFee = computeFee(settlementBase, settlementAttorneyPct);
      const nextSettlementParalegalFee = computeFee(settlementBase, settlementParalegalPct);
      if (cents(settlement.feeAttorneyAmount) !== nextSettlementAttorneyFee) {
        update["disputeSettlement.feeAttorneyAmount"] = nextSettlementAttorneyFee;
        touched = true;
        settlementUpdated += 1;
      }
      if (cents(settlement.feeParalegalAmount) !== nextSettlementParalegalFee) {
        update["disputeSettlement.feeParalegalAmount"] = nextSettlementParalegalFee;
        touched = true;
      }
      if (!Number.isFinite(settlement.feeAttorneyPct) || settlement.feeAttorneyPct !== settlementAttorneyPct) {
        update["disputeSettlement.feeAttorneyPct"] = settlementAttorneyPct;
        touched = true;
      }
      if (!Number.isFinite(settlement.feeParalegalPct) || settlement.feeParalegalPct !== settlementParalegalPct) {
        update["disputeSettlement.feeParalegalPct"] = settlementParalegalPct;
        touched = true;
      }
      const nextPayoutAmount = Math.max(0, settlementBase - nextSettlementParalegalFee);
      if (!Number.isFinite(settlement.payoutAmount) || cents(settlement.payoutAmount) !== nextPayoutAmount) {
        update["disputeSettlement.payoutAmount"] = nextPayoutAmount;
        touched = true;
      }
    }

    if (!touched) continue;
    if (apply) await Case.updateOne({ _id: doc._id }, { $set: update });
    updated += 1;
  }

  const remaining = apply ? await Case.countDocuments(query) : Math.max(0, await Case.countDocuments(query));
  const result = {
    mode: apply ? "apply" : "dry-run",
    scanned,
    eligible: updated,
    updated: apply ? updated : 0,
    settlementEligible: settlementUpdated,
    remaining,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  run()
    .then((result) => {
      if (result.mode === "apply" && result.remaining > 0) process.exitCode = 2;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.connection.close().catch(() => {});
    });
}

module.exports = { computeFee, run };
