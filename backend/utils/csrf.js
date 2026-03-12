const csrf = require("csurf");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const csrfMiddleware = csrf({
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
  },
});

function isCsrfEnabled() {
  return process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
}

function csrfProtection(req, res, next) {
  if (!isCsrfEnabled()) return next();
  return csrfMiddleware(req, res, next);
}

function protectMutations(req, res, next) {
  if (!isCsrfEnabled()) return next();
  const method = String(req.method || "").toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  return csrfMiddleware(req, res, next);
}

module.exports = {
  csrfProtection,
  protectMutations,
  isCsrfEnabled,
};
