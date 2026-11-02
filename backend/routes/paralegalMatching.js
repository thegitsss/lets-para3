const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const matching = require("../services/connectedWorkspace/matching");
router.use(verifyToken, requireApproved, requireRole("attorney"));
router.use((req, res, next) => {
  const expected = req.headers["x-lpc-owner-id"];
  if (expected && expected !== String(req.user.id)) return res.status(403).json({ code: "MATCH_ACCOUNT_CHANGED", error: "Your signed-in account changed. Open this search again." });
  next();
});
router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
router.post("/search", csrfProtection, rateLimit({ windowMs: 60000, limit: 8, standardHeaders: "draft-8", legacyHeaders: false }), async (req, res, next) => {
  try { res.json(await matching.search(req)); }
  catch (error) {
    if (error.publicCode) return res.status(error.status || 503).json({ error: error.message, code: error.publicCode });
    next(error);
  }
});
module.exports = router;
