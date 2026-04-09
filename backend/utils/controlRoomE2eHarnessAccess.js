function normalizeFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function isStagingEnvironment(env = process.env) {
  const appEnv = String(env.APP_ENV || env.ENVIRONMENT || "").trim().toLowerCase();
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  if (appEnv === "staging") return true;
  if (normalizeFlag(env.STAGING)) return true;
  if (String(env.RAILWAY_ENVIRONMENT || "").trim().toLowerCase() === "staging") return true;
  if (String(env.VERCEL_ENV || "").trim().toLowerCase() === "preview") return true;
  return nodeEnv === "staging";
}

function isControlRoomE2eHarnessEnabled(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  if (nodeEnv === "development" || nodeEnv === "test") {
    return true;
  }

  return isStagingEnvironment(env) && normalizeFlag(env.ENABLE_AI_CONTROL_ROOM_E2E_HARNESS);
}

function requiresHarnessSecret(env = process.env) {
  return isStagingEnvironment(env);
}

function resolveHarnessSecret(env = process.env) {
  return String(env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET || "").trim();
}

function createHarnessUnavailableError() {
  const error = new Error("AI Control Room e2e harness is unavailable in this environment.");
  error.statusCode = 404;
  return error;
}

function createHarnessSecretError(message = "AI Control Room e2e harness secret is invalid.") {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function assertControlRoomE2eHarnessEnabled(env = process.env) {
  if (!isControlRoomE2eHarnessEnabled(env)) {
    throw createHarnessUnavailableError();
  }
}

function assertValidHarnessSecret(value = "", env = process.env) {
  if (!requiresHarnessSecret(env)) return true;

  const configuredSecret = resolveHarnessSecret(env);
  if (!configuredSecret) {
    throw createHarnessSecretError("AI Control Room e2e harness secret is not configured for staging.");
  }
  if (String(value || "").trim() !== configuredSecret) {
    throw createHarnessSecretError();
  }
  return true;
}

function readHarnessSecretFromRequest(req = {}) {
  return (
    req.headers?.["x-ai-control-room-e2e-secret"] ||
    req.headers?.["x-control-room-e2e-secret"] ||
    req.query?.secret ||
    req.body?.secret ||
    ""
  );
}

function requireControlRoomE2eHarnessEnabled(req, res, next) {
  if (!isControlRoomE2eHarnessEnabled(process.env)) {
    return res.status(404).json({ error: "Not found" });
  }
  return next();
}

function requireControlRoomE2eHarnessSecret(req, res, next) {
  try {
    assertValidHarnessSecret(readHarnessSecretFromRequest(req), process.env);
    return next();
  } catch (error) {
    const statusCode = Number(error.statusCode || 403);
    return res.status(statusCode).json({ error: error.message || "Forbidden" });
  }
}

module.exports = {
  assertControlRoomE2eHarnessEnabled,
  assertValidHarnessSecret,
  createHarnessSecretError,
  createHarnessUnavailableError,
  isControlRoomE2eHarnessEnabled,
  readHarnessSecretFromRequest,
  requireControlRoomE2eHarnessEnabled,
  requireControlRoomE2eHarnessSecret,
  requiresHarnessSecret,
  resolveHarnessSecret,
};
