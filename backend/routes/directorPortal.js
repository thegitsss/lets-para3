const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const commissionAccount = require("../services/director/commissionAccountBoundary");
const manualImportAuthority = require("../services/director/manualImportAuthority");
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

async function withCurrentDirectorWrite(req, work) {
  try {
    return await manualImportAuthority.write(req, work);
  } catch (error) {
    if (Number(error?.statusCode || error?.status) === 403 &&
        ["FINANCIAL_ACCOUNT_CHANGED", "ACCOUNT_CHANGED"].includes(error?.publicCode || error?.code)) {
      throw Object.assign(new Error("Your Director account changed. Sign in again before continuing."), {
        status: 403, statusCode: 403, code: "DIRECTOR_ACCOUNT_CHANGED", publicCode: "DIRECTOR_ACCOUNT_CHANGED",
      });
    }
    throw error;
  }
}

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
    const profile = await withCurrentDirectorWrite(req, (session, actor) =>
      updateDirectorProfile(actor, req.body || {}, { session }));
    res.json({ ok: true, profile });
  })
);

router.patch(
  "/records/:recordId/state",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const record = await withCurrentDirectorWrite(req, (session) => updateDirectorRecordState({
      user: req.user,
      recordId: req.params.recordId,
      state: req.body?.state,
      session,
    }));
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
        manualRequest: req,
      });
      res.json({ ok: true, record: result.record });
    } catch (err) {
      if (Number(err?.statusCode || err?.status) === 403 &&
          ["FINANCIAL_ACCOUNT_CHANGED", "ACCOUNT_CHANGED"].includes(err?.publicCode || err?.code)) {
        return res.status(403).json({ error: "Your Director account changed. Sign in again before continuing.", code: "DIRECTOR_ACCOUNT_CHANGED" });
      }
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
    const verify = await commissionAccount.begin(req, res);
    const result = await importDirectorSentMail({
      user: req.user,
      manualRequest: req,
    });
    try { await verify(); }
    catch (error) { throw manualImportAuthority.savedReview(error); }
    res.json({ ok: true, ownerId: String(req.user.id || req.user._id), ...result });
  })
);

router.post(
  "/import-replies",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (String(req.user.role || "").toLowerCase() !== "director") {
      return res.status(403).json({ error: "Only director accounts can import their mailbox." });
    }
    const verify = await commissionAccount.begin(req, res);
    const result = await importDirectorInboxReplies({ user: req.user, manualRequest: req });
    try { await verify(); }
    catch (error) { throw manualImportAuthority.savedReview(error); }
    res.json({ ok: true, ownerId: String(req.user.id || req.user._id), ...result });
  })
);

module.exports = router;
