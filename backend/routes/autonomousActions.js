const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const AutonomousAction = require("../models/AutonomousAction");
const {
  getRecentActions,
  undoAction,
} = require("../services/ai/autonomousActionService");

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
  "/",
  asyncHandler(async (req, res) => {
    const actions = await getRecentActions(req.query.limit);
    res.json({ ok: true, actions });
  })
);

router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const [actionTypeCounts, statusCounts] = await Promise.all([
      AutonomousAction.aggregate([
        { $group: { _id: "$actionType", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      AutonomousAction.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({
      ok: true,
      stats: {
        actionType: actionTypeCounts.reduce((accumulator, entry) => {
          accumulator[entry._id] = entry.count;
          return accumulator;
        }, {}),
        status: statusCounts.reduce((accumulator, entry) => {
          accumulator[entry._id] = entry.count;
          return accumulator;
        }, {}),
      },
    });
  })
);

router.post(
  "/:id/undo",
  csrfProtection,
  asyncHandler(async (req, res) => {
    try {
      const restored = await undoAction(req.params.id);
      res.json({ ok: true, restored });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        error: error?.message || "Unable to undo autonomous action.",
      });
    }
  })
);

module.exports = router;
