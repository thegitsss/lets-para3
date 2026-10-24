"use strict";

const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const SUPPORT_KEYS = Object.freeze([
  "SUPPORT_ZOHO_MAILBOX", "SUPPORT_ZOHO_ACCOUNT_ID", "SUPPORT_ZOHO_INBOX_FOLDER_ID",
  "SUPPORT_ZOHO_CLIENT_ID", "SUPPORT_ZOHO_CLIENT_SECRET", "SUPPORT_ZOHO_REFRESH_TOKEN",
  "SUPPORT_ZOHO_API_BASE_URL", "SUPPORT_ZOHO_ACCOUNTS_BASE_URL",
]);

function populateMissing(env, values) {
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
}

function loadRuntimeEnvironment({ env = process.env, root = path.resolve(__dirname, "..") } = {}) {
  // Tests must never inherit workstation credentials. Explicit environment
  // variables remain authoritative in both local and hosted processes.
  if (env.NODE_ENV === "test") return { supportSource: "environment" };
  const file = path.join(root, ".env");
  if (fs.existsSync(file)) populateMissing(env, dotenv.parse(fs.readFileSync(file)));
  for (const key of ["BACKUP_DIR", "BACKUP_STATUS_FILE", "OPS_MONITOR_STATE_FILE"]) {
    if (env[key]) env[key] = path.resolve(root, env[key]);
  }
  const local = (!env.NODE_ENV || env.NODE_ENV === "development") &&
    !env.RENDER && !env.RENDER_SERVICE_ID && !env.RENDER_EXTERNAL_URL && !env.STAGING_MONGO_HOST;
  const savedFile = path.join(root, ".env.support-setup.local");
  if (!local || !fs.existsSync(savedFile)) return { supportSource: "environment" };
  const info = fs.lstatSync(savedFile);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw new Error("[config] Saved support connection must be an owner-only regular file.");
  }
  const saved = dotenv.parse(fs.readFileSync(savedFile));
  if (saved.SUPPORT_SETUP_VERIFIED !== "true") return { supportSource: "environment" };
  if (saved.SUPPORT_ZOHO_MAILBOX !== "help@lets-paraconnect.com" ||
      saved.ADMIN_ALERT_EMAIL !== "admin@lets-paraconnect.com" ||
      !SUPPORT_KEYS.every(key => saved[key]) ||
      !/^\d+$/.test(saved.SUPPORT_ZOHO_ACCOUNT_ID) || !/^\d+$/.test(saved.SUPPORT_ZOHO_INBOX_FOLDER_ID)) {
    throw new Error("[config] Saved support connection is incomplete. Run setup-support-mailbox.cjs again.");
  }
  // Do not combine a different explicitly configured account with saved tokens.
  if (SUPPORT_KEYS.some(key => env[key] !== undefined && env[key] !== saved[key])) return { supportSource: "environment" };
  populateMissing(env, Object.fromEntries([...SUPPORT_KEYS, "ADMIN_ALERT_EMAIL"].map(key => [key, saved[key]])));
  return { supportSource: "verified-local-file" };
}

module.exports = { loadRuntimeEnvironment, SUPPORT_KEYS };
