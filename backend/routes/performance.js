const router = require("express").Router();
const rateLimit = require("express-rate-limit");

const WebVitalSample = require("../models/WebVitalSample");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const {
  isGoodP75,
  isTrustedVitalsRequest,
  normalizeWebVitalSample,
} = require("../utils/webVitals");

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post(
  "/vitals",
  rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }),
  asyncHandler(async (req, res) => {
    if (!isTrustedVitalsRequest(req)) {
      return res.status(403).json({ error: "Untrusted performance sample origin." });
    }
    const sample = normalizeWebVitalSample(req.body);
    if (!sample) return res.status(400).json({ error: "Invalid performance sample." });
    await WebVitalSample.create(sample);
    return res.status(202).json({ accepted: true });
  })
);

router.get(
  "/vitals/summary",
  verifyToken,
  requireApproved,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const requestedDays = Number.parseInt(String(req.query.days || "28"), 10);
    const days = Math.min(90, Math.max(1, Number.isFinite(requestedDays) ? requestedDays : 28));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await WebVitalSample.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { metric: "$metric", page: "$page", deviceClass: "$deviceClass" },
          count: { $sum: 1 },
          p75: { $percentile: { input: "$value", p: [0.75], method: "approximate" } },
        },
      },
      { $sort: { "_id.page": 1, "_id.deviceClass": 1, "_id.metric": 1 } },
    ]);
    const metrics = rows.map((row) => {
      const p75 = Number(row.p75?.[0] || 0);
      return {
        metric: row._id.metric,
        page: row._id.page,
        deviceClass: row._id.deviceClass,
        count: row.count,
        p75,
        good: isGoodP75(row._id.metric, p75),
        sufficientSample: row.count >= 75,
      };
    });
    return res.json({ days, since, metrics });
  })
);

module.exports = router;
