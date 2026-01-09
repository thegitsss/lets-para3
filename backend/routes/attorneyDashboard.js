const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Case = require("../models/Case");

let Payment = null;
try {
  Payment = require("../models/Payment");
} catch (e) {
  // Optional: no Payment model yet, escrowTotal will be 0
}

/**
 * Helper: compute escrow total for this attorney (best-effort)
 */
async function getEscrowTotal(attorneyId) {
  if (!Payment) return 0;

  try {
    const payments = await Payment.find({
      attorneyId,
      status: "in_escrow", // adjust if your schema uses something else
    });

    return payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  } catch (err) {
    console.error("Error computing escrowTotal:", err);
    return 0;
  }
}

/**
 * GET /api/attorney/dashboard
 * Main overview for the attorney dashboard.
 */
router.get("/", auth, requireRole(["attorney"]), async (req, res) => {
  try {
    const attorneyId = req.user._id;

    // 1. Fetch basic collections in parallel
    const [openJobs, allJobs, activeCases] = await Promise.all([
      Job.find({ attorneyId, status: "open" })
        .sort({ createdAt: -1 })
        .limit(5),

      Job.find({ attorneyId }).select("_id status"),

      Case.find({
        attorneyId,
        archived: { $ne: true },
        status: { $nin: ["completed", "closed", "cancelled"] },
      })
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
        status: "submitted",
      })
        .populate("paralegalId", "firstName lastName email role")
        .populate("jobId", "title practiceArea budget")
        .sort({ createdAt: -1 })
        .limit(10);
    }

    // 3. Aggregate metrics
    const [activeCasesCount, openJobsCount, pendingApplicationsCount, escrowTotal] = await Promise.all([
      Case.countDocuments({
        attorneyId,
        archived: { $ne: true },
        status: { $in: ["active", "awaiting_documents", "reviewing", "in progress", "in_progress"] },
      }),
      Job.countDocuments({ attorneyId, status: "open" }),
      Application.countDocuments({
        jobId: { $in: jobIds },
        status: "submitted",
      }),
      getEscrowTotal(attorneyId),
    ]);

    const metrics = {
      activeCases: activeCasesCount,
      openJobs: openJobsCount,
      pendingApplications: pendingApplicationsCount,
      escrowTotal, // numeric; 0 if Payment model not wired yet
    };

    // 4. Shape the response for the frontend dashboard widgets
    const activeCasesSummary = activeCases.map((c) => ({
      caseId: c._id,
      jobTitle: c.jobId ? c.jobId.title : "Untitled Matter",
      practiceArea: c.jobId ? c.jobId.practiceArea : null,
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
    });
  } catch (err) {
    console.error("Attorney dashboard error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
