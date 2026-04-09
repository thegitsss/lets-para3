const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  getEngineeringOverview,
  listEngineeringItems,
  getEngineeringItem,
  runEngineeringDiagnosis,
  buildEngineeringExecution,
  resolveEngineeringIncident,
} = require("../services/engineering/workspaceService");

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

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const overview = await getEngineeringOverview();
    return res.json({ ok: true, overview });
  })
);

router.get(
  "/items",
  asyncHandler(async (req, res) => {
    const items = await listEngineeringItems({ limit: req.query.limit });
    return res.json({ ok: true, items });
  })
);

router.get(
  "/items/:id",
  asyncHandler(async (req, res) => {
    const item = await getEngineeringItem(req.params.id);
    if (!item) return res.status(404).json({ error: "Engineering item not found." });
    return res.json({ ok: true, item });
  })
);

router.post(
  "/items/:id/diagnose",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await runEngineeringDiagnosis({
      incidentIdentifier: req.params.id,
      force: req.body?.force === true,
    });
    return res.json({ ok: true, ...result });
  })
);

router.post(
  "/items/:id/execution",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await buildEngineeringExecution({
      incidentIdentifier: req.params.id,
      force: req.body?.force === true,
    });
    return res.json({ ok: true, ...result });
  })
);

router.post(
  "/items/:id/resolve",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await resolveEngineeringIncident({
      incidentIdentifier: req.params.id,
      actor: {
        userId: req.user?.id || null,
        role: req.user?.role || "admin",
      },
    });
    return res.json({ ok: true, ...result });
  })
);

module.exports = router;
