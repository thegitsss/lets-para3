const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:paralegalDashboard");
const express = require("express");
const router = express.Router();

const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const { requireApproved } = require("../utils/authz");
const Application = require("../models/Application");
const Case = require("../models/Case");
const { resolveMatterDeadlineDate } = require("../utils/businessDate");
const { DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT } = require("../services/platformFeePolicy");
const { getParalegalEarnings } = require("../services/paymentProjectionService");

function getExpectedPayouts(activeCases = []) {
  const totalCents = (Array.isArray(activeCases) ? activeCases : []).reduce((sum, caseDoc) => {
    const locked = Number(caseDoc?.lockedTotalAmount);
    const total = Number(caseDoc?.totalAmount);
    const gross = Number.isFinite(locked) && locked > 0
      ? locked
      : Number.isFinite(total) && total > 0
        ? total
        : 0;
    if (gross <= 0) return sum;
    const storedFee = Number(caseDoc?.feeParalegalAmount);
    const feePct = Number.isFinite(Number(caseDoc?.feeParalegalPct))
      ? Number(caseDoc.feeParalegalPct)
      : DEFAULT_PARALEGAL_PLATFORM_FEE_PERCENT;
    const fee = Number.isFinite(storedFee) && storedFee > 0
      ? storedFee
      : Math.max(0, Math.round((gross * feePct) / 100));
    return sum + Math.max(0, gross - fee);
  }, 0);
  return totalCents / 100;
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
      status: { $ne: "withdrawn" },
    })
      .populate("jobId")
      .sort({ createdAt: -1 });

    // 3. Metrics
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
      expectedPayouts: getExpectedPayouts(activeCases),
    };

    // 5. Shape response for frontend
    const activeCasesSummary = activeCases.map((c) => {
      const tasks = Array.isArray(c.tasks) ? c.tasks : [];
      const remainingTasks = tasks.filter((task) => !task?.completed).length;
      const files = Array.isArray(c.files) ? c.files : [];
      const latestFile = files.length ? files[files.length - 1] : null;
      const updates = Array.isArray(c.updates) ? c.updates : [];
      const latestUpdate = updates.length ? updates[updates.length - 1] : null;
      return {
        caseId: c._id,
        jobId: c.jobId?._id,
        jobTitle: c.jobId?.title,
        title: c.title,
        practiceArea: c.jobId?.practiceArea || c.practiceArea,
        attorneyName: c.attorneyId
          ? `${c.attorneyId.firstName} ${c.attorneyId.lastName}`
          : null,
        status: String(c.status || "").toLowerCase() === "in_progress" ? "in progress" : c.status,
        deadlineDate: resolveMatterDeadlineDate(c),
        deadline: resolveMatterDeadlineDate(c) || null,
        tasksTotal: tasks.length,
        tasksRemaining: remainingTasks,
        latestFileName: latestFile?.original || latestFile?.filename || "",
        latestUpdate: latestUpdate?.text || "",
        latestUpdateAt: latestUpdate?.date || null,
        createdAt: c.createdAt,
        archived: c.archived,
        paymentReleased: c.paymentReleased,
        escrowStatus: c.escrowStatus || null,
        escrowIntentId: c.escrowIntentId || null,
        paralegalId: c.paralegalId || c.paralegal || null,
      };
    });

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
      myApplications: myApplicationsSummary,
    });
  } catch (err) {
    runtimeLogger.error("Paralegal dashboard error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
