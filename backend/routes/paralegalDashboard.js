const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:paralegalDashboard");
const express = require("express");
const router = express.Router();

const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const { requireApproved } = require("../utils/authz");
const accountApplications = require("../services/accountApplicationProjections");
const Case = require("../models/Case");
const { resolveMatterDeadlineDate } = require("../utils/businessDate");
const expectedCompensation = require("../services/paralegalExpectedCompensation");
const { getParalegalEarnings } = require("../services/paymentProjectionService");
const { normalizeCaseStatus } = require("../utils/caseState");
const financialAccount = require('../services/financialAccountBoundary');
const { fingerprint } = require('../services/matterDraftRevision');

const ACTIVE_MATTER_STATUSES = Object.freeze([
  "active",
  "awaiting_documents",
  "reviewing",
  "funded_in_progress",
  "in progress",
  "in_progress",
]);

/**
 * GET /api/paralegal/dashboard
 * Returns job suggestions, applications, and active cases.
 */
router.get("/", auth, requireApproved, requireRole(["paralegal"]), async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    await financialAccount.read(req, 'paralegal', req.query.expectedOwnerId);
    const paralegalId = req.user._id;
    const now = new Date();

    // 1. My active cases
    const activeFilter = {
      $or: [{ paralegal: paralegalId }, { paralegalId }],
      status: { $in: ACTIVE_MATTER_STATUSES },
      archived: { $ne: true },
      paymentReleased: { $ne: true },
    };
    const financialCases = await Case.find(activeFilter)
      .populate("attorney", "firstName lastName email role")
      .populate("attorneyId", "firstName lastName email role")
      .populate("jobId", "title practiceArea")
      .sort({ createdAt: -1 });
    // Revocation removes workspace details, not the participant's retained
    // financial interest. Keep the two projections separate.
    const activeCases = financialCases.filter(c => !c.paralegalAccessRevokedAt);

    // Preserve retained outcomes; pending counts use the same source as Home.
    const applicationProjection = await accountApplications.readOwn(req);
    const myApplications = applicationProjection.rows.filter(application => application.status !== 'withdrawn');

    // 3. Metrics
    const [
      activeCasesCount,
      pendingApplicationsCount,
      earningsTotals,
      expected,
    ] = await Promise.all([
      activeCases.length,
      applicationProjection.rows.filter(accountApplications.isPending).length,
      getParalegalEarnings(paralegalId, { now, includeReport: true }),
      expectedCompensation.read(paralegalId, financialCases),
    ]);

    const metrics = {
      activeCases: activeCasesCount,
      pendingApplications: pendingApplicationsCount,
      earnings: earningsTotals.month,
      earningsLast30Days: earningsTotals.last30,
      earningsTotal: earningsTotals.total,
      earningsReport: earningsTotals.report,
      expectedPayouts: expected.usd,
      expectedCompensation: expected,
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
        attorneyName: c.attorneyId || c.attorney
          ? `${(c.attorneyId || c.attorney).firstName} ${(c.attorneyId || c.attorney).lastName}`
          : null,
        status: normalizeCaseStatus(c.status),
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
      applicationId: a._id || a.id || null,
      caseId: a.caseId, applicationSource: a.applicationSource || null, pending: a.pending,
      jobId: a.jobId?._id,
      jobTitle: a.jobId?.title,
      practiceArea: a.jobId?.practiceArea,
      budget: a.jobId?.budget,
      status: a.status,
      createdAt: a.createdAt,
    }));

    const [currentEarnings, currentExpected] = await Promise.all([
      getParalegalEarnings(paralegalId, { now, includeReport: true }),
      expectedCompensation.read(paralegalId, financialCases),
    ]);
    const ids = rows => rows.map(row => String(row._id)).sort();
    if (earningsTotals.report.revision !== currentEarnings.report.revision || expected.revision !== currentExpected.revision) throw Object.assign(new Error('The financial records or assignments changed. Refresh before continuing.'), { statusCode: 409, code: 'PAYOUT_PROJECTION_CHANGED' });
    const currentApplications = await accountApplications.readOwn(req);
    if (applicationProjection.revision !== currentApplications.revision) throw Object.assign(new Error('Applications changed while loading. Refresh to review the current records.'), { status: 409, publicCode: 'APPLICATION_SOURCE_CHANGED' });
    await financialAccount.read(req, 'paralegal', req.query.expectedOwnerId);
    const currentCases = await Case.find(activeFilter).select('_id paralegalAccessRevokedAt').lean();
    if (fingerprint(ids(financialCases)) !== fingerprint(ids(currentCases)) || fingerprint(ids(activeCases)) !== fingerprint(ids(currentCases.filter(c => !c.paralegalAccessRevokedAt)))) throw Object.assign(new Error('The assignments changed. Refresh before continuing.'), { statusCode: 409, code: 'PAYOUT_PROJECTION_CHANGED' });
    return res.json({
      metrics,
      activeCases: activeCasesSummary,
      myApplications: myApplicationsSummary,
    });
  } catch (err) {
    if (String(err.publicCode || '').startsWith('APPLICATION_')) return res.status(err.status || 503).json({ error: err.message, code: err.publicCode });
    if (err.publicCode === 'FINANCIAL_ACCOUNT_CHANGED') return res.status(err.status).json({ error: err.message, code: err.publicCode });
    if (String(err.code || '').startsWith('PAYOUT_PROJECTION_')) return res.status(err.statusCode || 503).json({ error: err.message, code: err.code });
    runtimeLogger.error("Paralegal dashboard error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
