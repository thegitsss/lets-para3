const { ipKeyGenerator, rateLimit } = require("express-rate-limit");

const SUPPORT_ACTION_RATE_LIMIT = Object.freeze({
  windowMs: 60 * 1000,
  limit: 30,
});

function supportActionKey(req = {}) {
  const userId = req.user?._id || req.user?.id;
  if (userId) return `user:${String(userId)}`;

  const normalizedIp = ipKeyGenerator(req.ip || req.socket?.remoteAddress || "");
  return `ip:${normalizedIp || "anonymous"}`;
}

function createSupportActionRateLimiter({
  skip = () => process.env.NODE_ENV === "test",
  store,
} = {}) {
  return rateLimit({
    ...SUPPORT_ACTION_RATE_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    keyGenerator: supportActionKey,
    ...(store ? { store } : {}),
    handler: (_req, res) => {
      res.status(429).json({
        error: "Too many assistant requests. Please wait a moment and try again.",
      });
    },
  });
}

module.exports = {
  SUPPORT_ACTION_RATE_LIMIT,
  createSupportActionRateLimiter,
  supportActionKey,
};
