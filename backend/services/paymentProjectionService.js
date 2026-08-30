"use strict";

const mongoose = require("mongoose");
const Case = require("../models/Case");
const Payout = require("../models/Payout");
const { expectedCaseFunding } = require("../utils/paymentIntegrity");
const { DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT } = require("./platformFeePolicy");

const SUCCESSFUL_PAYOUT_MATCH = Object.freeze({
  $or: [
    { status: "paid" },
    { status: { $exists: false } },
    { status: null },
    { status: "" },
  ],
});

function attorneyOwnership(attorneyId) {
  return { $or: [{ attorney: attorneyId }, { attorneyId }] };
}

function caseAmount(caseDoc = {}) {
  return Math.max(0, Math.round(Number(caseDoc.lockedTotalAmount ?? caseDoc.totalAmount ?? 0)));
}

async function getAttorneyPaymentSummary(attorneyId, { CaseModel = Case } = {}) {
  const owner = attorneyOwnership(attorneyId);
  const [activeCases, pendingCases, completedDocs] = await Promise.all([
    CaseModel.find({
      ...owner,
      escrowIntentId: { $nin: [null, ""] },
      escrowStatus: "funded",
      paymentReleased: { $ne: true },
    }).select("totalAmount lockedTotalAmount").lean(),
    CaseModel.find({
      ...owner,
      paymentReleased: { $ne: true },
      $and: [
        { $or: [{ paralegal: { $ne: null } }, { paralegalId: { $ne: null } }] },
        { $or: [{ escrowIntentId: { $exists: false } }, { escrowIntentId: null }, { escrowIntentId: "" }] },
      ],
    }).select("totalAmount lockedTotalAmount").lean(),
    CaseModel.find({
      ...owner,
      paymentReleased: true,
    }).select("totalAmount lockedTotalAmount feeAttorneyAmount feeAttorneyPct currency").lean(),
  ]);

  const activeFunds = activeCases.reduce((sum, caseDoc) => sum + caseAmount(caseDoc), 0);
  const pendingCharges = pendingCases.reduce((sum, caseDoc) => sum + caseAmount(caseDoc), 0);
  const completed = completedDocs.map((caseDoc) => ({
    matterAmount: caseAmount(caseDoc),
    attorneyFee: expectedCaseFunding(caseDoc).feeAmount,
  }));
  const completedMattersCount = completed.length;
  const completedMatterTotal = completed.reduce((sum, item) => sum + item.matterAmount, 0);
  const completedFeeTotal = completed.reduce((sum, item) => sum + item.attorneyFee, 0);
  return {
    totalSpent: completedMatterTotal + completedFeeTotal,
    activeEscrow: activeFunds,
    activeFunds,
    pendingCharges,
    averageJobCost: completedMattersCount ? Math.round(completedMatterTotal / completedMattersCount) : 0,
    completedJobsCount: completedMattersCount,
    pendingJobsCount: pendingCases.length,
  };
}

function payoutMatchFor(paralegalId) {
  return { paralegalId, ...SUCCESSFUL_PAYOUT_MATCH };
}

async function getParalegalEarnings(
  paralegalId,
  { CaseModel = Case, PayoutModel = Payout, now = new Date() } = {}
) {
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const last30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const paralegalMatch = mongoose.Types.ObjectId.isValid(paralegalId)
    ? new mongoose.Types.ObjectId(paralegalId)
    : paralegalId;
  const totals = await PayoutModel.aggregate([
    { $match: payoutMatchFor(paralegalMatch) },
    { $lookup: { from: "cases", localField: "caseId", foreignField: "_id", as: "caseDoc" } },
    { $unwind: "$caseDoc" },
    {
      $match: {
        $or: [
          { "caseDoc.paymentReleased": true },
          { "caseDoc.status": { $in: ["completed", "closed"] } },
          {
            $expr: {
              $and: [
                { $eq: ["$caseDoc.withdrawnParalegalId", "$paralegalId"] },
                { $ne: ["$caseDoc.payoutFinalizedAt", null] },
              ],
            },
          },
        ],
      },
    },
    {
      $facet: {
        month: [
          { $match: { createdAt: { $gte: startOfMonth, $lte: now } } },
          { $group: { _id: null, total: { $sum: "$amountPaid" } } },
        ],
        last30: [
          { $match: { createdAt: { $gte: last30, $lte: now } } },
          { $group: { _id: null, total: { $sum: "$amountPaid" } } },
        ],
        total: [{ $group: { _id: null, total: { $sum: "$amountPaid" } } }],
      },
    },
  ]);

  let monthTotal = totals[0]?.month?.[0]?.total || 0;
  let last30Total = totals[0]?.last30?.[0]?.total || 0;
  let allTimeTotal = totals[0]?.total?.[0]?.total || 0;
  const withdrawalCases = await CaseModel.find({
    withdrawnParalegalId: paralegalMatch,
    payoutFinalizedAt: { $ne: null },
    partialPayoutAmount: { $gt: 0 },
  }).select("partialPayoutAmount payoutFinalizedAt feeParalegalPct");

  if (withdrawalCases.length) {
    const payoutCaseIds = await PayoutModel.find({
      caseId: { $in: withdrawalCases.map((caseDoc) => caseDoc._id) },
      ...payoutMatchFor(paralegalMatch),
    }).select("caseId").lean();
    const paidCaseIds = new Set(payoutCaseIds.map((payout) => String(payout.caseId)));
    for (const caseDoc of withdrawalCases) {
      if (paidCaseIds.has(String(caseDoc._id))) continue;
      const gross = Number(caseDoc.partialPayoutAmount || 0);
      if (!Number.isFinite(gross) || gross <= 0) continue;
      const feePct = Number.isFinite(caseDoc.feeParalegalPct)
        ? caseDoc.feeParalegalPct
        : DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;
      const net = Math.max(0, gross - Math.max(0, Math.round((gross * feePct) / 100)));
      const paidAt = caseDoc.payoutFinalizedAt ? new Date(caseDoc.payoutFinalizedAt) : null;
      if (!paidAt || Number.isNaN(paidAt.getTime())) continue;
      allTimeTotal += net;
      if (paidAt >= startOfMonth && paidAt <= now) monthTotal += net;
      if (paidAt >= last30 && paidAt <= now) last30Total += net;
    }
  }
  return { month: monthTotal / 100, last30: last30Total / 100, total: allTimeTotal / 100 };
}

module.exports = {
  SUCCESSFUL_PAYOUT_MATCH,
  getAttorneyPaymentSummary,
  getParalegalEarnings,
};
