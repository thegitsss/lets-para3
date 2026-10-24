"use strict";

// Read-only local diagnostics. No Mongo connection, queue processing, SMTP,
// provider calls, or changes to provider settings.
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadRuntimeEnvironment, SUPPORT_KEYS } = require("../utils/runtimeEnvironment");
const { checkLocalBackupStatus } = require("../utils/localBackupStatus");

const SERVICE_SCRIPTS = Object.freeze({
  communications: "admin-communications-worker.js",
  incidents: "incident-runner.js",
  automation: "run-automation-cycle.js",
  monitor: "ops-monitor.js",
  backup: "backup-db.js",
});

function inspectLocalConfiguration({ env = process.env, root = path.resolve(__dirname, ".."), now = Date.now(), processes = null } = {}) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  const port = String(env.PORT || "5050");
  const matchesLocal = (value, suffix) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        (url.port || "80") === port && !url.username && !url.password && !url.search && !url.hash &&
        url.pathname.replace(/\/+$/, "") === suffix;
    } catch { return false; }
  };
  for (const [id, name, suffix] of [
    ["email_links", "EMAIL_BASE_URL", ""],
    ["health_target", "OPS_HEALTHCHECK_URL", "/api/health"],
  ]) {
    const ok = matchesLocal(env[name], suffix);
    add(id, ok ? "pass" : "fail", ok ? `${name} targets this localhost port.` : `${name} must target localhost:${port}${suffix}.`);
  }
  let callbackValid = false;
  try {
    const callback = new URL(env.LINKEDIN_OAUTH_REDIRECT_URI);
    callbackValid = ["https:", "http:"].includes(callback.protocol) &&
      !callback.username && !callback.password && !callback.search && !callback.hash;
  } catch { /* Missing callback configuration remains visible. */ }
  add("linkedin_callback", callbackValid ? "unverified" : "fail", callbackValid ?
    "LinkedIn callback is configured. Preserve its provider-registered URI; a different origin from localhost alone is not a defect. Registration and OAuth operation are separate checks." :
    "LinkedIn requires a valid callback URI matching its provider registration.");
  const missing = SUPPORT_KEYS.filter(key => !env[key]);
  add("support_mailbox", missing.length ? "fail" : "pass", missing.length ? `Support connection is missing: ${missing.join(", ")}.` : "Support connection settings are loaded; provider access requires a separate read-only verification.");
  const statusPath = path.resolve(root, env.BACKUP_STATUS_FILE || "backups/last-backup.json");
  const backup = checkLocalBackupStatus({ statusFile: statusPath, root, now, maxAgeHours: Number(env.BACKUP_MAX_AGE_HOURS || "36") });
  add("backup", backup.ok ? "pass" : "fail", backup.message);
  for (const [role, script] of Object.entries(SERVICE_SCRIPTS)) {
    const detected = processes === null ? null : processes.split("\n").some(line => line.includes(script) && /\bnode\b/.test(line));
    add(`process_${role}`, "unverified", detected === null ? `${role}: process inspection unavailable.` : detected ? `${role}: a process was detected; its database, release, and completed cycle still need verification.` : `${role}: no active process detected. Cron jobs may run only at scheduled intervals.`);
  }
  let isolatedMongo = false;
  try {
    const mongo = new URL(env.MONGO_URI || "");
    isolatedMongo = mongo.protocol === "mongodb:" && ["localhost", "127.0.0.1", "[::1]"].includes(mongo.hostname);
  } catch { /* An unknown database is not an isolated local target. */ }
  add("background_safety", isolatedMongo ? "unverified" : "fail", isolatedMongo ? "Loopback database selected; verify provider isolation before running queue consumers." : "Localhost uses a remote or unknown database. Do not start background consumers until that target and their external effects are approved.");
  return { ok: checks.every(check => check.status !== "fail"), scope: "local configuration only; not whole-platform readiness", checks };
}

function main() {
  loadRuntimeEnvironment();
  if (process.env.NODE_ENV === "production" || process.env.RENDER_SERVICE_ID) throw new Error("[config] This diagnostic is for localhost development only.");
  let processes = null;
  try { processes = execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 }); }
  catch { /* Configuration checks still run when process inspection is unavailable. */ }
  const result = inspectLocalConfiguration({ processes });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); }
  catch { console.error("Local configuration could not be checked. Review the private environment file and support connection permissions."); process.exitCode = 1; }
}
module.exports = { inspectLocalConfiguration, SERVICE_SCRIPTS };
