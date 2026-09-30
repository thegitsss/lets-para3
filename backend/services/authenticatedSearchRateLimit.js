const { ipKeyGenerator, rateLimit } = require("express-rate-limit");

const AUTHENTICATED_SEARCH_RATE_LIMIT = Object.freeze({
  windowMs: 60 * 1000,
  limit: 60,
});

function authenticatedSearchKey(req = {}) {
  const userId = req.user?._id || req.user?.id;
  if (userId) return `user:${String(userId)}`;

  const normalizedIp = ipKeyGenerator(req.ip || req.socket?.remoteAddress || "");
  return `ip:${normalizedIp || "anonymous"}`;
}

function createAuthenticatedSearchRateLimiter({
  skip = () => process.env.NODE_ENV === "test",
  store,
} = {}) {
  return rateLimit({
    ...AUTHENTICATED_SEARCH_RATE_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip,
    keyGenerator: authenticatedSearchKey,
    ...(store ? { store } : {}),
    handler: (_req, res) => {
      res.status(429).json({ error: "Search is temporarily busy. Please try again shortly." });
    },
  });
}

module.exports = {
  AUTHENTICATED_SEARCH_RATE_LIMIT,
  authenticatedSearchKey,
  createAuthenticatedSearchRateLimiter,
};
