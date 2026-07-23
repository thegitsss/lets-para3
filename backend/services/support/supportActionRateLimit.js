const { rateLimit } = require("express-rate-limit");

const SUPPORT_ACTION_RATE_LIMIT = Object.freeze({
  windowMs: 60 * 1000,
  limit: 30,
});

function supportActionKey(req = {}) {
  return String(req.user?._id || req.user?.id || req.ip || "anonymous");
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
