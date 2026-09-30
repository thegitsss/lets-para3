const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  buildDirectorRecordsCsv,
  getDirectorRecordAudit,
  listDirectorOversight,
  updateDirectorCommissionPayout,
} = require("../services/director/directorAdminService");
const { csrfProtection } = require("../utils/csrf");
const commissionAccount = require("../services/director/commissionAccountBoundary");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const verify = await commissionAccount.begin(req, res);
    const payload = await listDirectorOversight({ limit: req.query.limit });
    await verify();
    res.json({ ok: true, ownerId: String(req.user.id || req.user._id), ...payload });
  })
);

router.get(
  "/records.csv",
  asyncHandler(async (req, res) => {
    const verify = await commissionAccount.begin(req, res);
    const csv = await buildDirectorRecordsCsv();
    await verify();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"director-outreach-records.csv\"");
    res.send(csv);
  })
);

router.get(
  "/records/:id/audit",
  asyncHandler(async (req, res) => {
    const verify = await commissionAccount.begin(req, res);
    const audit = await getDirectorRecordAudit(req.params.id);
    if (!audit) return res.status(404).json({ error: "Director outreach record not found." });
    await verify();
    res.json({ ok: true, ownerId: String(req.user.id || req.user._id), ...audit });
  })
);

router.patch(
  "/records/:id/commission-payout",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const verify = await commissionAccount.begin(req, res);
    const result = await updateDirectorCommissionPayout({ recordId: req.params.id, body: req.body, req });
    if (!result) return res.status(404).json({ error: "Director outreach record not found." });
    await verify();
    res.json({ ok: true, ownerId: String(req.user.id || req.user._id), ...result });
  })
);

module.exports = router;
