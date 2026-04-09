const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const intakeService = require("../services/incidents/intakeService");
const { getReporterAccessToken } = require("../utils/incidentAccess");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post(
  "/",
  verifyToken,
  requireApproved,
  requireRole("attorney", "paralegal"),
  asyncHandler(async (req, res) => {
    const result = await intakeService.createIncidentFromHelpReport({
      user: req.user,
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, ...result });
  })
);

router.get(
  "/:publicId/timeline",
  verifyToken.optional,
  asyncHandler(async (req, res) => {
    const result = await intakeService.getReporterIncidentTimeline({
      publicId: req.params.publicId,
      user: req.user || null,
      accessToken: getReporterAccessToken(req),
      limit: req.query.limit,
    });
    if (!result) return res.status(404).json({ error: "Incident not found" });
    return res.json({ ok: true, ...result });
  })
);

router.get(
  "/:publicId",
  verifyToken.optional,
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
