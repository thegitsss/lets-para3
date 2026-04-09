const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { requireCcoAutonomyHarnessEnabled } = require("../utils/ccoAutonomyHarnessAccess");
const {
  inspectScenario,
  seedScenario,
  triggerScenario,
} = require("../services/ai/ccoAutonomyHarnessService");

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

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireCcoAutonomyHarnessEnabled);
router.use(verifyToken, requireApproved, requireRole("admin"));

router.post(
  "/seed",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const seeded = await seedScenario({
      scenario: req.body?.scenario,
      adminUser: req.user || {},
    });
    const inspection = await inspectScenario({ conversationId: seeded.conversationId });
    res.status(201).json({ ok: true, seeded, inspection });
  })
);

router.post(
  "/trigger",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await triggerScenario({
      conversationId: req.body?.conversationId,
      scenario: req.body?.scenario,
      message: req.body?.message,
    });
    res.status(201).json({ ok: true, ...result });
  })
);

router.get(
  "/inspect",
  asyncHandler(async (req, res) => {
    const inspection = await inspectScenario({
      conversationId: req.query?.conversationId,
      ticketId: req.query?.ticketId,
    });
    res.json({ ok: true, inspection });
  })
);

module.exports = router;
