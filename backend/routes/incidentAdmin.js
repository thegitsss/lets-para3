const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const controlRoomService = require("../services/incidents/controlRoomService");
const { decideIncidentApproval } = require("../services/incidents/releaseService");
const {
  AUTONOMY_ACTION_TYPES,
  recordDecisionOutcome,
} = require("../services/ai/autonomyPreferenceService");
const {
  getFounderApproverEmails,
  shouldAllowFounderAdminFallback,
} = require("../services/incidents/approvalRecipients");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    },
  });
}

function requireFounderApprover(req, res, next) {
  const user = req.user || {};
  const email = String(user.email || "").trim().toLowerCase();
  const allowlist = getFounderApproverEmails();
  const allowAdminFallback = shouldAllowFounderAdminFallback();

  if ((allowlist.length && allowlist.includes(email)) || (!allowlist.length && allowAdminFallback)) {
    return next();
  }

  return res.status(403).json({ error: "Founder approval access is not enabled for this account." });
}

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await controlRoomService.getIncidentList(req.query);
    return res.json({ ok: true, ...result });
  })
);

router.get(
  "/clusters",
  asyncHandler(async (req, res) => {
    const result = await controlRoomService.getIncidentClusters(req.query);
    return res.json({ ok: true, ...result });
  })
);

router.get(
  "/:id/timeline",
  asyncHandler(async (req, res) => {
    const result = await controlRoomService.getIncidentTimeline(req.params.id, req.query);
    if (!result) return res.status(404).json({ error: "Incident not found" });
    return res.json({ ok: true, ...result });
  })
);

router.get(
  "/:id/verification",
  asyncHandler(async (req, res) => {
    const result = await controlRoomService.getIncidentVerificationRecord(req.params.id, req.query);
    if (!result) return res.status(404).json({ error: "Incident not found" });
    return res.json({ ok: true, ...result });
  })
);

router.get(
  "/:id/release",
  asyncHandler(async (req, res) => {
    const result = await controlRoomService.getIncidentReleaseRecord(req.params.id, req.query);
    if (!result) return res.status(404).json({ error: "Incident not found" });
    return res.json({ ok: true, ...result });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await controlRoomService.getIncidentDetail(req.params.id);
    if (!result) return res.status(404).json({ error: "Incident not found" });
    return res.json({ ok: true, ...result });
  })
);

router.post(
  "/:id/approvals/:approvalId/decision",
  csrfProtection,
  requireFounderApprover,
  asyncHandler(async (req, res) => {
    const decision = String(req.body?.decision || "").trim().toLowerCase();
    const note = String(req.body?.note || "").trim();
    const scope = req.body?.scope && typeof req.body.scope === "object" ? req.body.scope : null;

    const result = await decideIncidentApproval({
      incidentIdentifier: req.params.id,
      approvalId: req.params.approvalId,
      decision,
      note,
      scope,
      actor: {
        userId: req.user?._id || req.user?.id || null,
        email: req.user?.email || "",
        role: "admin",
        decisionRole: "founder_approver",
      },
    });
    await recordDecisionOutcome("CTO", AUTONOMY_ACTION_TYPES.cto, decision === "approve" ? "approve" : "reject");

    const detail = await controlRoomService.getIncidentDetail(result.incident.publicId);
    return res.json({
      ok: true,
      approval: detail?.latestApproval || null,
      release: detail?.latestRelease || null,
      incident: detail?.incident || null,
    });
  })
);

module.exports = router;
