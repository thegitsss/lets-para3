const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  buildDirectorRecordsCsv,
  getDirectorRecordAudit,
  listDirectorOversight,
} = require("../services/director/directorAdminService");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const payload = await listDirectorOversight({ limit: req.query.limit });
    res.json({ ok: true, ...payload });
  })
);

router.get(
  "/records.csv",
  asyncHandler(async (_req, res) => {
    const csv = await buildDirectorRecordsCsv();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"director-outreach-records.csv\"");
    res.send(csv);
  })
);

router.get(
  "/records/:id/audit",
  asyncHandler(async (req, res) => {
    const audit = await getDirectorRecordAudit(req.params.id);
    if (!audit) return res.status(404).json({ error: "Director outreach record not found." });
    res.json({ ok: true, ...audit });
  })
);

module.exports = router;
