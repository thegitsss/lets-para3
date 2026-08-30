const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:attorneyDashboard");
const express = require("express");
const router = express.Router();

const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const { requireApproved } = require("../utils/authz");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Case = require("../models/Case");
const { getAttorneyPaymentSummary } = require("../services/paymentProjectionService");
const {
  dateOnlyFromZonedInstant,
  endOfWeekDateOnly,
  startOfWeekDateOnly,
} = require("../utils/businessDate");

const ACTIVE_CASE_STATUSES = Object.freeze([
  "in progress",
  "in_progress",
  "active",
  "awaiting_documents",
  "reviewing",
  "funded_in_progress",
]);
const PENDING_APPLICATION_STATUSES = Object.freeze(["submitted", "viewed", "shortlisted"]);

/**
 * GET /api/attorney/dashboard
 * Main overview for the attorney dashboard.
 */
router.get("/", auth, requireApproved, requireRole(["attorney"]), async (req, res) => {
  try {
    const attorneyId = req.user._id;
    const caseOwnership = [{ attorney: attorneyId }, { attorneyId }];
    const currentBusinessDate = dateOnlyFromZonedInstant(new Date());
    const weekStart = startOfWeekDateOnly(currentBusinessDate);
    const weekEnd = endOfWeekDateOnly(currentBusinessDate);
    const activeCaseFilter = {
      $or: caseOwnership,
      archived: { $ne: true },
      paymentReleased: { $ne: true },
      status: { $in: ACTIVE_CASE_STATUSES },
    };

    // 1. Fetch basic collections in parallel
    const [openJobs, allJobs, activeCases] = await Promise.all([
      Job.find({ attorneyId, status: "open" })
        .sort({ createdAt: -1 })
        .limit(5),

      Job.find({ attorneyId }).select("_id status"),

      Case.find(activeCaseFilter)
        .populate("paralegalId", "firstName lastName email role")
        .populate("jobId", "title practiceArea")
        .sort({ createdAt: -1 })
        .limit(5),
    ]);

    // 2. Build list of jobIds for applications query
    const jobIds = allJobs.map((j) => j._id);

    let pendingApplications = [];
    if (jobIds.length) {
      pendingApplications = await Application.find({
        jobId: { $in: jobIds },
        status: { $in: PENDING_APPLICATION_STATUSES },
      })
        .populate("paralegalId", "firstName lastName email role")
        .populate("jobId", "title practiceArea budget")
        .sort({ createdAt: -1 })
        .limit(10);
    }

    // 3. Aggregate metrics
    const [
      activeCasesCount,
      completedCasesCount,
      openJobsCount,
      pendingApplicationsCount,
      weekDeadlinesCount,
      weekDeadlines,
      escrowTotal,
    ] = await Promise.all([
      Case.countDocuments(activeCaseFilter),
      Case.countDocuments({
        $or: caseOwnership,
        status: "completed",
      }),
      Job.countDocuments({ attorneyId, status: "open" }),
      Application.countDocuments({
        jobId: { $in: jobIds },
        status: { $in: PENDING_APPLICATION_STATUSES },
      }),
      weekStart && weekEnd
        ? Case.countDocuments({
            ...activeCaseFilter,
            deadlineDate: { $gte: weekStart, $lte: weekEnd },
          })
        : 0,
      weekStart && weekEnd
        ? Case.find({
            ...activeCaseFilter,
            deadlineDate: { $gte: weekStart, $lte: weekEnd },
          })
            .select("title deadlineDate")
            .sort({ deadlineDate: 1, createdAt: 1 })
            .limit(3)
            .lean()
        : [],
      getAttorneyPaymentSummary(attorneyId).then((summary) => summary.activeFunds),
    ]);

    const metrics = {
      activeCases: activeCasesCount,
      completedCases: completedCasesCount,
      openJobs: openJobsCount,
      pendingApplications: pendingApplicationsCount,
      weekDeadlines: weekDeadlinesCount,
      escrowTotal,
    };

    // 4. Shape the response for the frontend dashboard widgets
    const activeCasesSummary = activeCases.map((c) => ({
      caseId: c._id,
      jobTitle: c.title || c.jobId?.title || "Untitled Matter",
      practiceArea: c.practiceArea || c.jobId?.practiceArea || null,
      paralegalName: c.paralegalId
        ? `${c.paralegalId.firstName} ${c.paralegalId.lastName}`
        : "Unassigned",
      status: c.status,
      createdAt: c.createdAt,
      amountCents: typeof c.lockedTotalAmount === "number" ? c.lockedTotalAmount : typeof c.totalAmount === "number" ? c.totalAmount : 0,
      currency: c.currency || "usd",
    }));

    const openJobsSummary = openJobs.map((j) => ({
      jobId: j._id,
      title: j.title,
      practiceArea: j.practiceArea,
      budget: j.budget,
      status: j.status,
      createdAt: j.createdAt,
    }));

    const pendingAppsSummary = pendingApplications.map((a) => ({
      applicationId: a._id,
      jobId: a.jobId ? a.jobId._id : null,
      jobTitle: a.jobId ? a.jobId.title : null,
      practiceArea: a.jobId ? a.jobId.practiceArea : null,
      paralegalId: a.paralegalId ? a.paralegalId._id : null,
      paralegalName: a.paralegalId
        ? `${a.paralegalId.firstName} ${a.paralegalId.lastName}`
        : null,
      status: a.status,
      createdAt: a.createdAt,
    }));

    return res.json({
      metrics,
      activeCases: activeCasesSummary,
      openJobs: openJobsSummary,
      pendingApplications: pendingAppsSummary,
      week: {
        start: weekStart,
        end: weekEnd,
        deadlines: weekDeadlines.map((item) => ({
          caseId: String(item._id),
          title: item.title || "Untitled Matter",
          dueDate: item.deadlineDate,
          href: `case-detail.html?id=${encodeURIComponent(String(item._id))}`,
        })),
      },
    });
  } catch (err) {
    runtimeLogger.error("Attorney dashboard error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
