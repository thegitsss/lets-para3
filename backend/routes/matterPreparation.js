const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const service = require("../services/connectedWorkspace/preparation");
router.use(verifyToken, requireApproved, requireRole("attorney", "paralegal"));
router.use((req, res, next) => {
  const expected = req.headers["x-lpc-owner-id"];
  if (expected && expected !== String(req.user.id)) return res.status(403).json({ code: "PREPARATION_ACCOUNT_CHANGED", error: "Your signed-in account changed. Open this workspace again." });
  next();
});
router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
const handle = action => async (req, res, next) => {
  try { res.json(await action(req)); }
  catch (error) {
    if (error.publicCode) return res.status(error.status || 503).json({ error: error.message, code: error.publicCode });
    if (["AI_DISABLED", "AI_BAD_RESPONSE"].includes(error.code)) return res.status(503).json({ error: "Document preparation is not available. Your original documents and Matter remain available.", code: "PREPARATION_AI_UNAVAILABLE" });
    next(error);
  }
};
router.get("/matters/:caseId", handle(service.list));
router.post("/matters/:caseId/generate", csrfProtection, rateLimit({ windowMs: 60000, limit: 4, standardHeaders: "draft-8", legacyHeaders: false }), handle(service.generate));
router.post("/matters/:caseId/accept", csrfProtection, handle(service.accept));
module.exports = router;
