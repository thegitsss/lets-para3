const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const intakeService = require("../services/incidents/intakeService");
const { getReporterAccessToken } = require("../utils/incidentAccess");
const { csrfProtection } = require("../utils/csrf");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function expectReporterAccount(req, res, next) {
  res.set("Cache-Control", "private, no-store");
  const expected = req.query.expectedOwnerId;
  if (expected === undefined) return next();
  if (typeof expected !== "string" || !/^[a-f\d]{24}$/i.test(expected)) {
    return res.status(400).json({ code: "INVALID_EXPECTED_OWNER", error: "Invalid expected account" });
  }
  if (expected.toLowerCase() !== String(req.user?.id || "").toLowerCase()) {
    return res.status(403).json({ code: "ACCOUNT_CHANGED", error: "Your account changed. Refresh before continuing." });
  }
  return next();
}

router.post(
  "/",
  verifyToken,
  requireApproved,
  requireRole("attorney", "paralegal"),
  csrfProtection,
  asyncHandler(async (req, res) => {
    try {
      const result = await intakeService.createIncidentFromHelpReport({
        user: req.user,
        input: req.body || {},
      });
      return res.status(result.idempotent ? 200 : 201).json({ ok: true, ...result });
    } catch (error) {
      // The shared production fallback intentionally emits only generic 500s.
      // Preserve this route's explicit retry/validation contract here.
      if (!String(error.publicCode || "").startsWith("HELP_") && !(error.statusCode === 400 && error.fields)) throw error;
      if (error.statusCode === 503 || error.publicCode === "HELP_REQUEST_PROCESSING") res.set("Retry-After", "2");
      return res.status(error.statusCode).json({
        error: error.message,
        ...(error.publicCode ? { code: error.publicCode } : {}),
        ...(error.fields ? { fields: error.fields } : {}),
      });
    }
  })
);

router.get(
  "/:publicId/timeline",
  verifyToken.optional,
  expectReporterAccount,
  asyncHandler(async (req, res) => {
    let result;
    try {
      result = await intakeService.getReporterIncidentTimeline({
        publicId: req.params.publicId,
        user: req.user || null,
        accessToken: getReporterAccessToken(req),
        limit: req.query.limit,
        paged: req.query.paged,
        cursor: req.query.cursor,
      });
    } catch (error) {
      if (error.publicCode !== "INVALID_INCIDENT_TIMELINE_QUERY") throw error;
      return res.status(400).json({ code: error.publicCode, error: error.message });
    }
    if (!result) return res.status(404).json({ error: "Incident not found" });
    return res.json({ ok: true, ...result });
  })
);

router.get(
  "/:publicId",
  verifyToken.optional,
  expectReporterAccount,
  asyncHandler(async (req, res) => {
    const incident = await intakeService.getReporterIncidentStatus({
      publicId: req.params.publicId,
      user: req.user || null,
      accessToken: getReporterAccessToken(req),
    });
    if (!incident) return res.status(404).json({ error: "Incident not found" });
    return res.json({ ok: true, incident });
  })
);

module.exports = router;
