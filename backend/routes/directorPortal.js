const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  getDirectorAnalytics,
  getDirectorOverview,
  importDirectorInboxReplies,
  importDirectorSentMail,
  listDirectorRecords,
  sendDirectorOutreach,
  updateDirectorProfile,
} = require("../services/director/directorPortalService");

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

router.use(verifyToken, requireApproved, requireRole("director", "admin"));

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const overview = await getDirectorOverview({ user: req.user, rangeDays: req.query.rangeDays });
    res.json({ ok: true, ...overview });
  })
);

router.get(
  "/analytics",
  asyncHandler(async (req, res) => {
    const analytics = await getDirectorAnalytics({ user: req.user, days: req.query.days });
    res.json({ ok: true, ...analytics });
  })
);

router.get(
  "/records",
  asyncHandler(async (req, res) => {
    const records = await listDirectorRecords({
      user: req.user,
      stage: req.query.stage,
      rangeDays: req.query.rangeDays,
      limit: req.query.limit,
    });
    res.json({ ok: true, records });
  })
);

router.patch(
  "/profile",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (String(req.user.role || "").toLowerCase() !== "director") {
      return res.status(403).json({ error: "Only director accounts can update their director profile." });
    }
    const profile = await updateDirectorProfile(req.user, req.body || {});
    res.json({ ok: true, profile });
  })
);

router.post(
  "/outreach",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (String(req.user.role || "").toLowerCase() !== "director") {
      return res.status(403).json({ error: "Only director accounts can send outreach." });
    }
    try {
      const result = await sendDirectorOutreach({
        user: req.user,
        attorneyName: req.body?.attorneyName,
        attorneyEmail: req.body?.attorneyEmail,
        state: req.body?.state,
      });
      res.json({ ok: true, record: result.record });
    } catch (err) {
      res.status(Number(err?.statusCode) || 500).json({ error: err?.message || "Unable to send outreach." });
    }
  })
);

router.post(
  "/import-today",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (String(req.user.role || "").toLowerCase() !== "director") {
      return res.status(403).json({ error: "Only director accounts can import their mailbox." });
    }
    const result = await importDirectorSentMail({
      user: req.user,
    });
    res.json({ ok: true, ...result });
  })
);

router.post(
  "/import-replies",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (String(req.user.role || "").toLowerCase() !== "director") {
      return res.status(403).json({ error: "Only director accounts can import their mailbox." });
    }
    const result = await importDirectorInboxReplies({ user: req.user });
    res.json({ ok: true, ...result });
  })
);

module.exports = router;
