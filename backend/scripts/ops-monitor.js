#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const { sendOwnerAlert } = require("../utils/opsAlerting");
const WebhookEvent = require("../models/WebhookEvent");

const HEALTH_URL = String(
  process.env.OPS_HEALTHCHECK_URL ||
    process.env.HEALTHCHECK_URL ||
    (process.env.APP_BASE_URL ? `${String(process.env.APP_BASE_URL).replace(/\/+$/g, "")}/api/health` : "")
).trim();
const IS_RENDER = Boolean(
  String(process.env.RENDER || process.env.RENDER_EXTERNAL_URL || process.env.RENDER_SERVICE_ID || "").trim()
);
const BACKUP_STATUS_FILE = String(
  process.env.BACKUP_STATUS_FILE ||
    path.join(__dirname, "..", "backups", "last-backup.json")
).trim();
const STATE_FILE = String(
  process.env.OPS_MONITOR_STATE_FILE ||
    path.join(__dirname, "..", "ops", "monitor-state.json")
).trim();
const BACKUP_MAX_AGE_HOURS = Number(process.env.BACKUP_MAX_AGE_HOURS || "36");
const WEBHOOK_FAILURE_LOOKBACK_MINUTES = Number(
  process.env.WEBHOOK_FAILURE_LOOKBACK_MINUTES || "30"
);
const MONITOR_CHECK_WEBHOOKS = String(process.env.MONITOR_CHECK_WEBHOOKS || "true").toLowerCase() !== "false";
const MONITOR_REQUIRE_BACKUP = String(
  process.env.MONITOR_REQUIRE_BACKUP || (IS_RENDER ? "false" : "true")
).toLowerCase() !== "false";
const MONITOR_ALERT_ON_OK = String(process.env.MONITOR_ALERT_ON_OK || "true").toLowerCase() !== "false";
const MONITOR_PERSIST_STATE = String(
  process.env.MONITOR_PERSIST_STATE || (IS_RENDER ? "false" : "true")
).toLowerCase() !== "false";
const MONITOR_SEND_OWNER_ALERTS = String(
  process.env.MONITOR_SEND_OWNER_ALERTS || (IS_RENDER ? "false" : "true")
).toLowerCase() !== "false";

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function checkHealth() {
  if (!HEALTH_URL) {
    return {
      ok: false,
      code: "health_url_missing",
      message: "Health check URL is not configured.",
    };
  }

  try {
    const response = await fetch(HEALTH_URL, { method: "GET" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true) {
      return {
        ok: false,
        code: "health_failed",
        message: `Health check failed with HTTP ${response.status}.`,
        details: { status: response.status, body },
      };
    }
    return {
      ok: true,
      code: "health_ok",
      message: "Health check passed.",
      details: { status: response.status, body },
    };
  } catch (error) {
    return {
      ok: false,
      code: "health_request_failed",
      message: `Health check request failed: ${error?.message || error}`,
    };
  }
}

function checkBackupFreshness() {
  if (!MONITOR_REQUIRE_BACKUP) {
    return {
      ok: true,
      code: "backup_check_disabled",
      message: "Backup freshness check disabled.",
    };
  }

  const status = readJsonFile(BACKUP_STATUS_FILE);
  if (!status) {
    return {
      ok: false,
      code: "backup_status_missing",
      message: `Backup status file is missing: ${BACKUP_STATUS_FILE}`,
    };
  }

  if (status.status !== "ok") {
    return {
      ok: false,
      code: "backup_last_run_failed",
      message: "Last backup run did not succeed.",
      details: status,
    };
  }

  const completedAt = status.completedAt ? Date.parse(status.completedAt) : NaN;
  if (!Number.isFinite(completedAt)) {
    return {
      ok: false,
      code: "backup_timestamp_invalid",
      message: "Backup status file does not contain a valid completion timestamp.",
      details: status,
    };
  }

  const maxAgeMs = Math.max(1, BACKUP_MAX_AGE_HOURS) * 60 * 60 * 1000;
  const ageMs = Date.now() - completedAt;
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      code: "backup_stale",
      message: `Backup is stale (${Math.round(ageMs / (60 * 60 * 1000))}h old).`,
      details: status,
    };
  }

  return {
    ok: true,
    code: "backup_ok",
    message: "Backup freshness check passed.",
    details: status,
  };
}

async function checkRecentWebhookFailures() {
  if (!MONITOR_CHECK_WEBHOOKS) {
    return {
      ok: true,
      code: "webhook_check_disabled",
      message: "Stripe webhook failure check disabled.",
    };
  }

  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "webhook_check_skipped",
      message: "Webhook failure check skipped because MONGO_URI is unavailable.",
    };
  }

  const cutoff = new Date(Date.now() - Math.max(1, WEBHOOK_FAILURE_LOOKBACK_MINUTES) * 60 * 1000);
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
      connectedHere = true;
    }
    const failures = await WebhookEvent.find({
      provider: "stripe",
      status: "failed",
      updatedAt: { $gte: cutoff },
    })
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    if (failures.length) {
      return {
        ok: false,
        code: "stripe_webhook_failures",
        message: `Detected ${failures.length} failed Stripe webhook events in the last ${WEBHOOK_FAILURE_LOOKBACK_MINUTES} minutes.`,
        details: failures.map((entry) => ({
          eventId: entry.eventId,
          type: entry.type,
          updatedAt: entry.updatedAt,
          lastError: entry.lastError,
          attempts: entry.attempts,
          stripeMode: entry.stripeMode,
        })),
      };
    }

    return {
      ok: true,
      code: "stripe_webhooks_ok",
      message: "No recent failed Stripe webhook events detected.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "webhook_check_failed",
      message: `Stripe webhook failure check could not complete: ${error?.message || error}`,
    };
  } finally {
    if (connectedHere) {
      await mongoose.connection.close().catch(() => {});
    }
  }
}

function buildFingerprint(failures) {
  return failures.map((entry) => `${entry.code}:${entry.message}`).join("|");
}

async function main() {
  const checks = [
    await checkHealth(),
    checkBackupFreshness(),
    await checkRecentWebhookFailures(),
  ];

  const failures = checks.filter((entry) => !entry.ok);
  const ok = failures.length === 0;
  const fingerprint = buildFingerprint(failures);
  const previous = MONITOR_PERSIST_STATE ? readJsonFile(STATE_FILE) || {} : {};
  const previousOk = previous.ok !== false;
  const changed = previous.ok !== ok || previous.fingerprint !== fingerprint;

  const summary = {
    checkedAt: new Date().toISOString(),
    ok,
    fingerprint,
    checks,
    environment: {
      isRender: IS_RENDER,
      persistState: MONITOR_PERSIST_STATE,
      requireBackup: MONITOR_REQUIRE_BACKUP,
      sendOwnerAlerts: MONITOR_SEND_OWNER_ALERTS,
    },
  };
  if (MONITOR_PERSIST_STATE) {
    writeJsonFile(STATE_FILE, summary);
  }

  if (!ok && changed && MONITOR_SEND_OWNER_ALERTS) {
    const lines = failures.map((entry) => entry.message);
    await sendOwnerAlert("LPC attention needed: platform check found an issue", [
      "One or more platform checks need attention.",
      ...lines,
      HEALTH_URL ? `Health page: ${HEALTH_URL}` : "Health page is not configured yet.",
    ]).catch(() => {});
  } else if (ok && !previousOk && MONITOR_ALERT_ON_OK && MONITOR_SEND_OWNER_ALERTS) {
    await sendOwnerAlert("LPC update: platform checks look healthy again", [
      "The latest platform checks passed.",
      HEALTH_URL ? `Health page: ${HEALTH_URL}` : "Health page is not configured yet.",
    ]).catch(() => {});
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch(async (error) => {
  const payload = {
    checkedAt: new Date().toISOString(),
    ok: false,
    fingerprint: `fatal:${error?.message || error}`,
    checks: [
      {
        ok: false,
        code: "monitor_fatal",
        message: error?.message || String(error),
      },
    ],
  };
  if (MONITOR_PERSIST_STATE) {
    writeJsonFile(STATE_FILE, payload);
  }
  if (MONITOR_SEND_OWNER_ALERTS) {
    await sendOwnerAlert("LPC attention needed: platform check could not finish", [
      "The platform check did not finish and should be reviewed.",
      error?.message || String(error),
    ]).catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
});
