function normalizeFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
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

function isCcoAutonomyHarnessEnabled(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  if (nodeEnv === "development" || nodeEnv === "test") {
    return true;
  }

  return isStagingEnvironment(env) && normalizeFlag(env.ENABLE_CCO_AUTONOMY_HARNESS);
}

function createHarnessUnavailableError() {
  const error = new Error("CCO autonomy harness is unavailable in this environment.");
  error.statusCode = 404;
  return error;
}

function assertCcoAutonomyHarnessEnabled(env = process.env) {
  if (!isCcoAutonomyHarnessEnabled(env)) {
    throw createHarnessUnavailableError();
  }
}

function requireCcoAutonomyHarnessEnabled(req, res, next) {
  if (!isCcoAutonomyHarnessEnabled(process.env)) {
    return res.status(404).json({ error: "Not found" });
  }
  return next();
}

module.exports = {
  assertCcoAutonomyHarnessEnabled,
  createHarnessUnavailableError,
  isCcoAutonomyHarnessEnabled,
  requireCcoAutonomyHarnessEnabled,
};
