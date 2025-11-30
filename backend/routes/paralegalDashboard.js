const express = require("express");
const router = express.Router();

const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const Job = require("../models/Job");
const Application = require("../models/Application");
const Case = require("../models/Case");

let Payment = null;
try {
  Payment = require("../models/Payment");
} catch (e) {
  // Payment not required yet; ignore
}

/**
 * Optional helper: compute paralegal earnings
 */
async function getParalegalEarnings(paralegalId) {
  if (!Payment) return 0;

  try {
    const payments = await Payment.find({
      paralegalId,
      status: "released",
    });

    return payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  } catch (err) {
    console.error("Error computing paralegal earnings:", err);
    return 0;
  }
}

/**
 * GET /api/paralegal/dashboard
 * Returns job suggestions, applications, and active cases.
 */
router.get("/", auth, requireRole(["paralegal"]), async (req, res) => {
  try {

    const paralegalId = req.user._id;

    // 1. Pending invitations for me
    const invitations = await Case.find({
      pendingParalegalId: paralegalId,
      status: { $in: ["open", "assigned"] },
    })
      .populate("attorneyId", "firstName lastName email role")
      .populate("jobId", "title practiceArea")
      .sort({ createdAt: -1 });

    // 2. My active cases
    const activeCases = await Case.find({
      paralegalId,
      status: { $in: ["active", "awaiting_documents", "reviewing", "in_progress"] },
    })
      .populate("attorneyId", "firstName lastName email role")
      .populate("jobId", "title practiceArea")
      .sort({ createdAt: -1 });

    // 3. Jobs I have applied to
    const myApplications = await Application.find({
      paralegalId,
    })
      .populate("jobId")
      .sort({ createdAt: -1 });

    // 4. Jobs still open & available
    // Exclude jobs the paralegal has already applied to
    const appliedJobIds = myApplications.map((app) => app.jobId?._id);

    const availableJobs = await Job.find({
      status: "open",
      _id: { $nin: appliedJobIds },
    })
      .populate("attorneyId", "firstName lastName email role")
      .sort({ createdAt: -1 })
      .limit(10);

    // 5. Metrics
    const [
      activeCasesCount,
      pendingApplicationsCount,
      totalEarnings,
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
      invitations: invitations.length,
      pendingApplications: pendingApplicationsCount,
      earnings: totalEarnings, // always 0 unless Payment model exists
    };

    // 6. Shape response for frontend
    const invitationsSummary = invitations.map((c) => ({
      caseId: c._id,
      jobId: c.jobId?._id,
      jobTitle: c.jobId?.title || c.title,
      practiceArea: c.jobId?.practiceArea || c.practiceArea,
      attorneyName: c.attorneyId
        ? `${c.attorneyId.firstName || ""} ${c.attorneyId.lastName || ""}`.trim()
        : null,
      invitedAt: c.pendingParalegalInvitedAt || c.createdAt,
    }));

    const activeCasesSummary = activeCases.map((c) => ({
      caseId: c._id,
      jobId: c.jobId?._id,
      jobTitle: c.jobId?.title,
      practiceArea: c.jobId?.practiceArea,
      attorneyName: c.attorneyId
        ? `${c.attorneyId.firstName} ${c.attorneyId.lastName}`
        : null,
      status: c.status,
      createdAt: c.createdAt,
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
      invitations: invitationsSummary,
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
