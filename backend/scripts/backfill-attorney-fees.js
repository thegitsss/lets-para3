const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Case = require("../models/Case");

const DEFAULT_ATTORNEY_FEE_PCT = Number(
  process.env.PLATFORM_FEE_ATTORNEY_PERCENT || process.env.PLATFORM_FEE_PERCENT || 22
);
const DEFAULT_PARALEGAL_FEE_PCT = Number(process.env.PLATFORM_FEE_PARALEGAL_PERCENT || 18);

function cents(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num);
}

function computeFee(baseAmount, pct) {
  return Math.max(0, Math.round(cents(baseAmount) * ((Number(pct) || 0) / 100)));
}

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 30000 });

  const limit = Math.max(1, Number(process.env.ATTORNEY_FEE_BACKFILL_LIMIT || 5000));
  const query = {
    $and: [
      {
        $or: [
          { lockedTotalAmount: { $gt: 0 } },
          { totalAmount: { $gt: 0 } },
          { "disputeSettlement.grossAmount": { $gt: 0 } },
        ],
      },
      {
        $or: [
          { feeAttorneyAmount: { $exists: false } },
          { feeAttorneyAmount: null },
          { feeAttorneyAmount: { $lte: 0 } },
          { "disputeSettlement.feeAttorneyAmount": { $exists: false } },
          { "disputeSettlement.feeAttorneyAmount": null },
          { "disputeSettlement.feeAttorneyAmount": { $lte: 0 } },
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
    await Case.updateOne({ _id: doc._id }, { $set: update });
    updated += 1;
  }

  console.log(JSON.stringify({ scanned, updated, settlementUpdated }, null, 2));
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
