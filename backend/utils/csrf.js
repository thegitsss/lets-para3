const crypto = require("crypto");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOKEN_PATTERN = /^[a-f0-9]{64}\.[a-f0-9]{64}$/;
const PRODUCTION_COOKIE_NAME = "__Host-lpc.csrf";
const DEVELOPMENT_COOKIE_NAME = "_csrf";
const PURPOSE = "lpc:csrf:hmac:v1";
const DEVELOPMENT_SECRET = crypto
  .createHash("sha256")
  .update("lpc-local-development-csrf-only")
  .digest("hex");

function isProduction(env = process.env) {
  return env.NODE_ENV === "production" || env.PROD === "true";
}

function isCsrfEnabled(env = process.env) {
  return isProduction(env) || env.ENABLE_CSRF === "true";
}

function listSecrets(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function csrfSecrets(env = process.env) {
  const sourceSecrets = [env.JWT_SECRET, ...listSecrets(env.JWT_SECRETS)]
    .map((entry) => String(entry || ""))
    .filter(Boolean);
  if (!sourceSecrets.length) {
    if (isCsrfEnabled(env)) {
      const error = new Error("[csrf] JWT secret material is required when CSRF protection is enabled.");
      error.code = "CSRF_CONFIGURATION_ERROR";
      throw error;
    }
    return [DEVELOPMENT_SECRET];
  }
  return [...new Set(sourceSecrets)].map((secret) =>
    crypto.createHmac("sha256", secret).update(PURPOSE).digest("hex")
  );
}

function csrfCookieName(env = process.env) {
  return isProduction(env) ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
}

function csrfCookieOptions(env = process.env) {
  return {
    httpOnly: true,
    sameSite: isProduction(env) ? "strict" : "lax",
    secure: isProduction(env),
    path: "/",
  };
}

function requestSessionIdentifier(req, env = process.env) {
  const configuredCookie = String(env.JWT_COOKIE_NAME || "access");
  const cookieToken = req?.cookies?.token || req?.cookies?.[configuredCookie] || "";
  const authorization = String(req?.headers?.authorization || "");
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const credential = String(cookieToken || bearerToken || "");
  if (!credential) return "anonymous";
  return crypto.createHash("sha256").update(credential).digest("hex");
}

function tokenMessage(sessionIdentifier, randomValue) {
  return `${sessionIdentifier.length}!${sessionIdentifier}!${randomValue.length}!${randomValue}`;
}

function tokenHmac(secret, sessionIdentifier, randomValue) {
  return crypto
    .createHmac("sha256", secret)
    .update(tokenMessage(sessionIdentifier, randomValue))
    .digest("hex");
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function parseToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) return null;
  const [hmac, randomValue] = value.split(".");
  return { hmac, randomValue };
}

function isTokenValidForRequest(token, req, env = process.env) {
  const parsed = parseToken(token);
  if (!parsed) return false;
  const sessionIdentifier = requestSessionIdentifier(req, env);
  return csrfSecrets(env).some((secret) =>
    constantTimeEqual(parsed.hmac, tokenHmac(secret, sessionIdentifier, parsed.randomValue))
  );
}

function generateCsrfToken(req, res, { overwrite = false, env = process.env } = {}) {
  const cookieName = csrfCookieName(env);
  const existing = req?.cookies?.[cookieName];
  if (!overwrite && isTokenValidForRequest(existing, req, env)) {
    res.cookie(cookieName, existing, csrfCookieOptions(env));
    return existing;
  }
  const randomValue = crypto.randomBytes(32).toString("hex");
  const sessionIdentifier = requestSessionIdentifier(req, env);
  const hmac = tokenHmac(csrfSecrets(env)[0], sessionIdentifier, randomValue);
  const token = `${hmac}.${randomValue}`;
  res.cookie(cookieName, token, csrfCookieOptions(env));
  if (!req.cookies || typeof req.cookies !== "object") req.cookies = {};
  req.cookies[cookieName] = token;
  return token;
}

function csrfError() {
  const error = new Error("invalid csrf token");
  error.status = 403;
  error.statusCode = 403;
  error.code = "EBADCSRFTOKEN";
  return error;
}

function csrfTokenMiddleware(req, res, next) {
  req.csrfToken = (options) => generateCsrfToken(req, res, options);
  return next();
}

function csrfProtection(req, res, next) {
  if (!isCsrfEnabled()) return next();
  csrfTokenMiddleware(req, res, () => {});
  const method = String(req.method || "").toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  const cookieToken = req?.cookies?.[csrfCookieName()];
  const headerToken = req?.headers?.["x-csrf-token"];
  if (
    isTokenValidForRequest(cookieToken, req) &&
    constantTimeEqual(cookieToken, headerToken)
  ) {
    return next();
  }
  return next(csrfError());
}

function protectMutations(req, res, next) {
  return csrfProtection(req, res, next);
}

function isCsrfError(error) {
  return error?.code === "EBADCSRFTOKEN";
}

function respondToCsrfError(error, res, { field = "error" } = {}) {
  if (!isCsrfError(error)) return false;
  res.status(403).json({
    [field]: "Invalid CSRF token",
    code: "CSRF_INVALID",
  });
  return true;
}

module.exports = {
  DEVELOPMENT_COOKIE_NAME,
  PRODUCTION_COOKIE_NAME,
  constantTimeEqual,
  csrfCookieName,
  csrfCookieOptions,
  csrfProtection,
  csrfSecrets,
  csrfTokenMiddleware,
  generateCsrfToken,
  isCsrfEnabled,
  isCsrfError,
  isTokenValidForRequest,
  parseToken,
  protectMutations,
  requestSessionIdentifier,
  respondToCsrfError,
};
