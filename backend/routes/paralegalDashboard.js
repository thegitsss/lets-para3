const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const { requireApproved } = require("../utils/authz");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Case = require("../models/Case");
const Payout = require("../models/Payout");

/**
 * Optional helper: compute paralegal earnings based on completed payouts
 */
async function getParalegalEarnings(paralegalId) {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const last30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const paralegalMatch = mongoose.Types.ObjectId.isValid(paralegalId)
      ? new mongoose.Types.ObjectId(paralegalId)
      : paralegalId;
    const totals = await Payout.aggregate([
      { $match: { paralegalId: paralegalMatch } },
      {
        $lookup: {
          from: "cases",
          localField: "caseId",
          foreignField: "_id",
          as: "caseDoc",
        },
      },
      { $unwind: "$caseDoc" },
      {
        $match: {
          $or: [
            { "caseDoc.paymentReleased": true },
            { "caseDoc.status": { $in: ["completed", "closed"] } },
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
          total: [
            { $group: { _id: null, total: { $sum: "$amountPaid" } } },
          ],
        },
      },
    ]);
    const monthTotal = totals[0]?.month?.[0]?.total || 0;
    const last30Total = totals[0]?.last30?.[0]?.total || 0;
    const allTimeTotal = totals[0]?.total?.[0]?.total || 0;
    let withdrawalMonthTotal = 0;
    let withdrawalLast30Total = 0;
    let withdrawalAllTimeTotal = 0;
    const withdrawalCases = await Case.find({
      withdrawnParalegalId: paralegalMatch,
      payoutFinalizedAt: { $ne: null },
      partialPayoutAmount: { $gt: 0 },
    }).select("partialPayoutAmount payoutFinalizedAt feeParalegalPct");

    if (withdrawalCases.length) {
      const withdrawalCaseIds = withdrawalCases.map((doc) => doc._id);
      const payoutCaseIds = await Payout.find({ caseId: { $in: withdrawalCaseIds } })
        .select("caseId")
        .lean();
      const payoutCaseIdSet = new Set(payoutCaseIds.map((p) => String(p.caseId)));
      const defaultParalegalFeePct = Number(process.env.PLATFORM_FEE_PARALEGAL_PERCENT || 18);

      withdrawalCases.forEach((doc) => {
        if (payoutCaseIdSet.has(String(doc._id))) return;
        const gross = Number(doc.partialPayoutAmount || 0);
        if (!Number.isFinite(gross) || gross <= 0) return;
        const feePct =
          typeof doc.feeParalegalPct === "number" && Number.isFinite(doc.feeParalegalPct)
            ? doc.feeParalegalPct
            : defaultParalegalFeePct;
        const fee = Math.max(0, Math.round((gross * feePct) / 100));
        const net = Math.max(0, gross - fee);
        const paidAt = doc.payoutFinalizedAt ? new Date(doc.payoutFinalizedAt) : null;
        if (!paidAt || Number.isNaN(paidAt.getTime())) return;
        withdrawalAllTimeTotal += net;
        if (paidAt >= startOfMonth && paidAt <= now) {
          withdrawalMonthTotal += net;
        }
        if (paidAt >= last30 && paidAt <= now) {
          withdrawalLast30Total += net;
        }
      });
    }

    return {
      month: (monthTotal + withdrawalMonthTotal) / 100,
      last30: (last30Total + withdrawalLast30Total) / 100,
      total: (allTimeTotal + withdrawalAllTimeTotal) / 100,
    };
  } catch (err) {
    console.error("Error computing paralegal earnings:", err);
    return { month: 0, last30: 0 };
  }
}

/**
 * GET /api/paralegal/dashboard
 * Returns job suggestions, applications, and active cases.
 */
router.get("/", auth, requireApproved, requireRole(["paralegal"]), async (req, res) => {
  try {

    const paralegalId = req.user._id;

    // 1. My active cases
    const activeCases = await Case.find({
      paralegalId,
      status: { $in: ["active", "awaiting_documents", "reviewing", "in progress", "in_progress"] },
    })
      .populate("attorneyId", "firstName lastName email role")
      .populate("jobId", "title practiceArea")
      .sort({ createdAt: -1 });

    // 2. Jobs I have applied to
    const myApplications = await Application.find({
      paralegalId,
    })
      .populate("jobId")
      .sort({ createdAt: -1 });

    // 3. Jobs still open & available
    // Exclude jobs the paralegal has already applied to
    const appliedJobIds = myApplications.map((app) => app.jobId?._id);

    const availableJobs = await Job.find({
      status: "open",
      _id: { $nin: appliedJobIds },
    })
      .populate("attorneyId", "firstName lastName email role")
      .sort({ createdAt: -1 })
      .limit(10);

    // 4. Metrics
    const [
      activeCasesCount,
      pendingApplicationsCount,
      earningsTotals,
    ] = await Promise.all([
      activeCases.length,
      Application.countDocuments({
        paralegalId,
        status: "submitted",
      }),
      getParalegalEarnings(paralegalId),
    ]);

    const metrics = {
      activeCases: activeCasesCount,
      pendingApplications: pendingApplicationsCount,
      earnings: earningsTotals.month,
      earningsLast30Days: earningsTotals.last30,
      earningsTotal: earningsTotals.total,
    };

    // 5. Shape response for frontend
    const activeCasesSummary = activeCases.map((c) => ({
      caseId: c._id,
      jobId: c.jobId?._id,
      jobTitle: c.jobId?.title,
      title: c.title,
      practiceArea: c.jobId?.practiceArea,
      attorneyName: c.attorneyId
        ? `${c.attorneyId.firstName} ${c.attorneyId.lastName}`
        : null,
      status: String(c.status || "").toLowerCase() === "in_progress" ? "in progress" : c.status,
      deadline: c.deadline || null,
      createdAt: c.createdAt,
      archived: c.archived,
      paymentReleased: c.paymentReleased,
      escrowStatus: c.escrowStatus || null,
      escrowIntentId: c.escrowIntentId || null,
      paralegalId: c.paralegalId || c.paralegal || null,
    }));

    const availableJobsSummary = availableJobs.map((j) => ({
      jobId: j._id,
      title: j.title,
      practiceArea: j.practiceArea,
      budget: j.budget,
      attorneyName: j.attorneyId
        ? `${j.attorneyId.firstName} ${j.attorneyId.lastName}`
        : null,
      createdAt: j.createdAt,
    }));

    const myApplicationsSummary = myApplications.map((a) => ({
      applicationId: a._id,
      jobId: a.jobId?._id,
      jobTitle: a.jobId?.title,
      practiceArea: a.jobId?.practiceArea,
      budget: a.jobId?.budget,
      status: a.status,
      createdAt: a.createdAt,
    }));

    return res.json({
      metrics,
      activeCases: activeCasesSummary,
      availableJobs: availableJobsSummary,
      myApplications: myApplicationsSummary,
    });
  } catch (err) {
    console.error("Paralegal dashboard error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
