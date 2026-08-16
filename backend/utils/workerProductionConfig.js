"use strict";

const { assertRenderReleaseIdentity } = require("./releaseIdentity");

function present(env, name) {
  return String(env[name] || "").trim();
}

function requireNames(env, names, scope) {
  const missing = names.filter((name) => !present(env, name));
  if (missing.length) throw new Error(`[config] ${scope} is missing: ${missing.join(", ")}.`);
}

function assertMongo(env, scope) {
  if (!/^mongodb(?:\+srv)?:\/\//i.test(present(env, "MONGO_URI"))) {
    throw new Error(`[config] ${scope} requires a valid MONGO_URI.`);
  }
}

function assertEncryption(env, scope) {
  const key = present(env, "DATA_ENCRYPTION_KEY");
  const validHex = /^[0-9a-fA-F]{64}$/.test(key);
  let validBase64 = false;
  try {
    validBase64 = Buffer.from(key, "base64").length === 32;
  } catch {
    validBase64 = false;
  }
  if (!validHex && !validBase64) throw new Error(`[config] ${scope} requires a 32-byte DATA_ENCRYPTION_KEY.`);
}

function assertEmail(env, scope, { requireOwner = false } = {}) {
  requireNames(env, [
    "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_FROM_EMAIL", "SMTP_FROM_NAME",
  ], scope);
  const port = Number(env.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[config] ${scope} requires SMTP_PORT from 1 to 65535.`);
  }
  if (!["true", "false"].includes(present(env, "SMTP_SECURE").toLowerCase())) {
    throw new Error(`[config] ${scope} requires SMTP_SECURE=true or false.`);
  }
  if (String(env.EMAIL_DISABLE || "").trim().toLowerCase() !== "false") {
    throw new Error(`[config] ${scope} requires EMAIL_DISABLE=false.`);
  }
  if (requireOwner) requireNames(env, ["OWNER_ALERT_EMAILS"], scope);
}

function assertAi(env, scope) {
  requireNames(env, ["OPENAI_API_KEY", "OPENAI_SAFETY_SALT"], scope);
  if (Buffer.byteLength(present(env, "OPENAI_SAFETY_SALT"), "utf8") < 32) {
    throw new Error(`[config] ${scope} requires OPENAI_SAFETY_SALT with at least 32 bytes.`);
  }
}

function assertIncidentWorkerConfiguration(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  const scope = "incident runner";
  assertRenderReleaseIdentity(env, scope);
  assertMongo(env, scope);
  assertEncryption(env, scope);
  assertAi(env, scope);
  assertEmail(env, scope);
  requireNames(env, ["INCIDENT_FOUNDER_APPROVER_EMAILS", "INCIDENT_FOUNDER_ALERT_EMAILS"], scope);
  const shutdownGraceMs = Number(env.INCIDENT_RUNNER_SHUTDOWN_GRACE_MS);
  const lockMs = Number(env.INCIDENT_RUNNER_LOCK_MS);
  if (!Number.isFinite(lockMs) || !Number.isFinite(shutdownGraceMs) || lockMs >= shutdownGraceMs) {
    throw new Error("[config] Incident runner lock window must be shorter than its shutdown grace window.");
  }
}

function assertAutomationConfiguration(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  const scope = "automation cron";
  assertRenderReleaseIdentity(env, scope);
  assertMongo(env, scope);
  assertEncryption(env, scope);
  assertAi(env, scope);
  assertEmail(env, scope);
  requireNames(env, [
    "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY",
    "FOUNDER_EMAIL", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_OAUTH_REDIRECT_URI",
    "ZOHO_MAIL_REFRESH_TOKEN", "ZOHO_MAIL_CLIENT_ID", "ZOHO_MAIL_CLIENT_SECRET",
    "DIRECTOR_SMTP_USER", "DIRECTOR_SMTP_PASS",
  ], scope);
}

function assertOpsMonitorConfiguration(env = process.env) {
  if (env.NODE_ENV !== "production") return;
  const scope = "operations monitor";
  assertRenderReleaseIdentity(env, scope);
  assertMongo(env, scope);
  assertEmail(env, scope, { requireOwner: true });
  requireNames(env, [
    "OPS_HEALTHCHECK_URL", "ATLAS_PROJECT_ID", "ATLAS_CLUSTER_NAME", "ATLAS_CLIENT_ID", "ATLAS_CLIENT_SECRET",
  ], scope);
  for (const name of ["MONITOR_CHECK_WEBHOOKS", "MONITOR_REQUIRE_BACKUP", "MONITOR_PERSIST_STATE", "MONITOR_SEND_OWNER_ALERTS"]) {
    if (present(env, name).toLowerCase() !== "true") throw new Error(`[config] ${scope} requires ${name}=true.`);
  }
}

module.exports = {
  assertAutomationConfiguration,
  assertIncidentWorkerConfiguration,
  assertOpsMonitorConfiguration,
};
