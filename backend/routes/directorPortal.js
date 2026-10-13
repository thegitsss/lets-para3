const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const commissionAccount = require("../services/director/commissionAccountBoundary");
const {
  getDirectorAnalytics,
  getDirectorOverview,
  importDirectorInboxReplies,
  importDirectorSentMail,
  listDirectorRecords,
  sendDirectorOutreach,
  updateDirectorProfile,
  updateDirectorRecordState,
} = require("../services/director/directorPortalService");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(verifyToken, requireApproved, requireRole("director", "admin"));

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const verify = await commissionAccount.begin(req, res);
    const overview = await getDirectorOverview({ user: req.user, rangeDays: req.query.rangeDays });
    await verify();
    res.json({ ok: true, ownerId: String(req.user.id || req.user._id), ...overview });
  })
);

router.get(
  "/analytics",
  asyncHandler(async (req, res) => {
    const verify = await commissionAccount.begin(req, res);
    const analytics = await getDirectorAnalytics({ user: req.user, days: req.query.days });
    await verify();
    res.json({ ok: true, ownerId: String(req.user.id || req.user._id), ...analytics });
  })
);

router.get(
  "/records",
  asyncHandler(async (req, res) => {
    const verify = await commissionAccount.begin(req, res);
    const records = await listDirectorRecords({
      user: req.user,
      stage: req.query.stage,
      rangeDays: req.query.rangeDays,
      limit: req.query.limit,
    });
    await verify();
    res.json({ ok: true, ownerId: String(req.user.id || req.user._id), records });
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

router.patch(
  "/records/:recordId/state",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const record = await updateDirectorRecordState({
      user: req.user,
      recordId: req.params.recordId,
      state: req.body?.state,
    });
    res.json({ ok: true, record });
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
