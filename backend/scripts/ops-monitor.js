#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const { sendOwnerAlert } = require("../utils/opsAlerting");
const WebhookEvent = require("../models/WebhookEvent");
const PaymentOperation = require("../models/PaymentOperation");
const Application = require("../models/Application");
const Case = require("../models/Case");
const CaseFile = require("../models/CaseFile");
const OpsMonitorState = require("../models/OpsMonitorState");
const StorageDeletionTask = require("../models/StorageDeletionTask");
const { assertOpsMonitorConfiguration } = require("../utils/workerProductionConfig");
const { createLogger, redactValue } = require("../utils/logger");
const { releaseCommit } = require("../utils/releaseIdentity");
const { readMaintenanceMode } = require("../utils/appSettings");
const { MONGO_OPERATION_OPTIONS, requireMongoUri } = require("../utils/mongooseOperationPolicy");

const logger = createLogger("ops-monitor");

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

function errorCode(error, fallback) {
  return String(error?.code || error?.name || fallback).slice(0, 80);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

async function checkHealth({
  fetchFn = fetch,
  timeoutMs = 10_000,
  expectedReleaseCommit = releaseCommit(process.env),
} = {}) {
  if (!HEALTH_URL) {
    return {
      ok: false,
      code: "health_url_missing",
      message: "Health check URL is not configured.",
    };
  }

  try {
    const response = await fetchFn(HEALTH_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    const observedReleaseCommit = String(
      response.headers?.get?.("X-LPC-Release-Commit") || ""
    ).trim().toLowerCase();
    if (expectedReleaseCommit && observedReleaseCommit !== expectedReleaseCommit) {
      return {
        ok: false,
        code: "health_release_mismatch",
        message: "Web health is serving a different or unidentified release commit.",
        details: { status: response.status },
      };
    }
    if (!response.ok || body?.ok !== true || body?.db !== "connected") {
      return {
        ok: false,
        code: "health_failed",
        message: `Health check failed with HTTP ${response.status}.`,
        details: { status: response.status },
      };
    }
    return {
      ok: true,
      code: "health_ok",
      message: "Health check passed.",
      details: { status: response.status },
    };
  } catch (error) {
    return {
      ok: false,
      code: "health_request_failed",
        message: "Health check request could not complete.",
        details: { errorCode: String(error?.name || error?.code || "HEALTH_REQUEST_FAILED").slice(0, 80) },
    };
  }
}

async function checkMaintenanceMode({ readMaintenanceModeFn = readMaintenanceMode } = {}) {
  try {
    if (await readMaintenanceModeFn()) {
      return {
        ok: false,
        code: "maintenance_mode_active",
        message: "Application maintenance mode is active and scheduled mutations are paused.",
      };
    }
    return {
      ok: true,
      code: "maintenance_mode_inactive",
      message: "Application maintenance mode is inactive.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "maintenance_mode_check_failed",
      message: "Application maintenance-mode state could not be read; scheduled mutations remain fail-closed.",
      details: { errorCode: errorCode(error, "MAINTENANCE_MODE_CHECK_FAILED") },
    };
  }
}

function atlasBackupConfig(env = process.env) {
  return {
    projectId: String(env.ATLAS_PROJECT_ID || "").trim(),
    clusterName: String(env.ATLAS_CLUSTER_NAME || "").trim(),
    clientId: String(env.ATLAS_CLIENT_ID || "").trim(),
    clientSecret: String(env.ATLAS_CLIENT_SECRET || "").trim(),
    clusterType: String(env.ATLAS_CLUSTER_TYPE || "replica_set").trim().toLowerCase(),
  };
}

function atlasSnapshotEndpoint(config) {
  const base = "https://cloud.mongodb.com/api/atlas/v2";
  const project = encodeURIComponent(config.projectId);
  const cluster = encodeURIComponent(config.clusterName);
  if (config.clusterType === "sharded") {
    return `${base}/groups/${project}/clusters/${cluster}/backup/snapshots/shardedClusters?itemsPerPage=100&pageNum=1`;
  }
  if (config.clusterType === "flex") {
    return `${base}/groups/${project}/flexClusters/${cluster}/backup/snapshots?itemsPerPage=100&pageNum=1`;
  }
  return `${base}/groups/${project}/clusters/${cluster}/backup/snapshots?itemsPerPage=100&pageNum=1`;
}

async function fetchAtlasBackupStatus(config, fetchFn = fetch) {
  const tokenResponse = await fetchFn("https://cloud.mongodb.com/api/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  });
  const tokenBody = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new Error(`Atlas service-account authentication failed with HTTP ${tokenResponse.status}.`);
  }

  const snapshotsResponse = await fetchFn(atlasSnapshotEndpoint(config), {
    headers: {
      Accept: "application/vnd.atlas.2025-03-12+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const snapshotsBody = await snapshotsResponse.json().catch(() => ({}));
  if (!snapshotsResponse.ok) {
    throw new Error(`Atlas snapshot lookup failed with HTTP ${snapshotsResponse.status}.`);
  }
  const snapshots = Array.isArray(snapshotsBody.results) ? snapshotsBody.results : [];
  const completed = snapshots
    .filter((snapshot) => ["complete", "completed"].includes(String(snapshot?.status || "").toLowerCase()))
    .map((snapshot) => ({
      id: String(snapshot.id || ""),
      completedAt: snapshot.completedAt || snapshot.finishedAt || snapshot.createdAt || null,
    }))
    .filter((snapshot) => Number.isFinite(Date.parse(snapshot.completedAt)))
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  return completed[0] || null;
}

async function checkBackupFreshness({
  env = process.env,
  fetchFn = fetch,
  now = Date.now(),
  requireBackup = MONITOR_REQUIRE_BACKUP,
} = {}) {
  if (!requireBackup) {
    return {
      ok: true,
      code: "backup_check_disabled",
      message: "Backup freshness check disabled.",
    };
  }

  const atlas = atlasBackupConfig(env);
  const atlasValues = [atlas.projectId, atlas.clusterName, atlas.clientId, atlas.clientSecret];
  const hasAnyAtlasConfig = atlasValues.some(Boolean);
  if (hasAnyAtlasConfig) {
    if (!atlasValues.every(Boolean)) {
      return {
        ok: false,
        code: "atlas_backup_config_incomplete",
        message: "MongoDB Atlas backup monitoring configuration is incomplete.",
      };
    }
    if (!/^[a-f0-9]{24}$/.test(atlas.projectId) || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(atlas.clusterName)) {
      return {
        ok: false,
        code: "atlas_backup_config_invalid",
        message: "MongoDB Atlas project or cluster identifiers are invalid.",
      };
    }
    if (!["replica_set", "sharded", "flex"].includes(atlas.clusterType)) {
      return {
        ok: false,
        code: "atlas_backup_cluster_type_invalid",
        message: "MongoDB Atlas cluster type must be replica_set, sharded, or flex.",
      };
    }
    try {
      const latest = await fetchAtlasBackupStatus(atlas, fetchFn);
      if (!latest) {
        return { ok: false, code: "atlas_backup_missing", message: "MongoDB Atlas has no completed backup snapshot." };
      }
      const maxAgeHours = Math.max(1, Number(env.BACKUP_MAX_AGE_HOURS || BACKUP_MAX_AGE_HOURS));
      const ageMs = Number(now) - Date.parse(latest.completedAt);
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeHours * 60 * 60 * 1000) {
        return {
          ok: false,
          code: "atlas_backup_stale",
          message: `Latest MongoDB Atlas backup is outside the ${maxAgeHours}-hour freshness window.`,
          details: { snapshotId: latest.id, completedAt: latest.completedAt },
        };
      }
      return {
        ok: true,
        code: "atlas_backup_ok",
        message: "MongoDB Atlas backup freshness check passed.",
        details: { snapshotId: latest.id, completedAt: latest.completedAt },
      };
    } catch (error) {
      return {
        ok: false,
        code: "atlas_backup_check_failed",
        message: "MongoDB Atlas backup check could not complete.",
        details: { errorCode: errorCode(error, "ATLAS_BACKUP_CHECK_FAILED") },
      };
    }
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
  const ageMs = Number(now) - completedAt;
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
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
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
      message: "Stripe webhook failure check could not complete.",
      details: { errorCode: errorCode(error, "WEBHOOK_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) {
      await mongoose.connection.close().catch(() => {});
    }
  }
}

async function checkPaymentReconciliationQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "payment_reconciliation_check_skipped",
      message: "Payment reconciliation check skipped because MONGO_URI is unavailable.",
    };
  }
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const stalePendingCutoff = new Date(Date.now() - 15 * 60 * 1000);
    const operations = await PaymentOperation.find({
      $or: [
        { status: "needs_reconciliation", updatedAt: { $lte: cutoff } },
        { status: "pending", lastAttemptAt: { $lte: stalePendingCutoff } },
      ],
    })
      .select("operationKey caseId kind stripeObjectId stripeRefundId stripeTransferId lastError attempts updatedAt")
      .sort({ updatedAt: 1 })
      .limit(20)
      .lean();
    if (operations.length) {
      return {
        ok: false,
        code: "payment_reconciliation_required",
        message: `${operations.length} payment operation(s) still require reconciliation.`,
        details: operations.map((operation) => ({
          operationKey: operation.operationKey,
          caseId: String(operation.caseId || ""),
          kind: operation.kind,
          externalRef:
            operation.stripeTransferId || operation.stripeRefundId || operation.stripeObjectId || "",
          attempts: operation.attempts,
          updatedAt: operation.updatedAt,
        })),
      };
    }
    return {
      ok: true,
      code: "payment_reconciliation_ok",
      message: "No aged payment operations require reconciliation.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "payment_reconciliation_check_failed",
      message: "Payment reconciliation check could not complete.",
      details: { errorCode: errorCode(error, "PAYMENT_RECONCILIATION_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkFinancialExceptionQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri && mongoose.connection.readyState !== 1) {
    return {
      ok: true,
      code: "financial_exception_check_skipped",
      message: "Financial exception check skipped because MONGO_URI is unavailable.",
    };
  }
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const cases = await Case.find({
      $or: [
        { fundingIntegrityStatus: "failed" },
        { paymentStatus: { $in: ["verification_failed", "refund_failed"] } },
        { payoutStatus: { $in: ["failed", "reversed", "needs_reconciliation"] } },
      ],
    })
      .select("paymentStatus payoutStatus fundingIntegrityStatus updatedAt")
      .sort({ updatedAt: 1 })
      .limit(20)
      .lean();
    if (cases.length) {
      return {
        ok: false,
        code: "financial_exception_attention_required",
        message: `${cases.length} Matter payment record(s) have an unresolved integrity, refund, or payout exception.`,
        details: cases.map((caseDoc) => ({
          caseId: String(caseDoc._id || ""),
          paymentStatus: caseDoc.paymentStatus || "",
          payoutStatus: caseDoc.payoutStatus || "",
          fundingIntegrityStatus: caseDoc.fundingIntegrityStatus || "",
          updatedAt: caseDoc.updatedAt || null,
        })),
      };
    }
    return {
      ok: true,
      code: "financial_exception_ok",
      message: "No unresolved Matter payment exceptions detected.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "financial_exception_check_failed",
      message: "Financial exception check could not complete.",
      details: { errorCode: errorCode(error, "FINANCIAL_EXCEPTION_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkApplicationReconciliationQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "application_reconciliation_check_skipped",
      message: "Application reconciliation check skipped because MONGO_URI is unavailable.",
    };
  }
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const applications = await Application.find({
      syncStatus: "needs_reconciliation",
      updatedAt: { $lte: cutoff },
    })
      .select("jobId paralegalId status syncError updatedAt")
      .sort({ updatedAt: 1 })
      .limit(20)
      .lean();
    if (applications.length) {
      return {
        ok: false,
        code: "application_reconciliation_required",
        message: `${applications.length} application record(s) still require reconciliation.`,
        details: applications.map((application) => ({
          applicationId: String(application._id || ""),
          jobId: String(application.jobId || ""),
          paralegalId: String(application.paralegalId || ""),
          status: application.status,
          updatedAt: application.updatedAt,
        })),
      };
    }
    return {
      ok: true,
      code: "application_reconciliation_ok",
      message: "No aged application records require reconciliation.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "application_reconciliation_check_failed",
      message: "Application reconciliation check could not complete.",
      details: { errorCode: errorCode(error, "APPLICATION_RECONCILIATION_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkHiringReconciliationQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "hiring_reconciliation_check_skipped",
      message: "Hiring reconciliation check skipped because MONGO_URI is unavailable.",
    };
  }
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const cases = await Case.find({
      hiringClaimStatus: { $in: ["claimed", "needs_reconciliation"] },
      hiringClaimedAt: { $lte: cutoff },
    })
      .select(
        "title hiringClaimStatus hiringClaimParalegalId hiringClaimedAt hiringClaimPaymentIntentId hiringClaimAmount hiringClaimError"
      )
      .sort({ hiringClaimedAt: 1 })
      .limit(20)
      .lean();
    if (cases.length) {
      return {
        ok: false,
        code: "hiring_reconciliation_required",
        message: `${cases.length} hire operation(s) still require reconciliation.`,
        details: cases.map((caseDoc) => ({
          caseId: String(caseDoc._id || ""),
          status: caseDoc.hiringClaimStatus || "",
          paralegalId: String(caseDoc.hiringClaimParalegalId || ""),
          paymentIntentId: caseDoc.hiringClaimPaymentIntentId || "",
          amount: caseDoc.hiringClaimAmount || 0,
          claimedAt: caseDoc.hiringClaimedAt,
        })),
      };
    }
    return {
      ok: true,
      code: "hiring_reconciliation_ok",
      message: "No aged hire operations require reconciliation.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "hiring_reconciliation_check_failed",
      message: "Hiring reconciliation check could not complete.",
      details: { errorCode: errorCode(error, "HIRING_RECONCILIATION_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkCompletionReconciliationQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "completion_reconciliation_check_skipped",
      message: "Completion reconciliation check skipped because MONGO_URI is unavailable.",
    };
  }
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const cases = await Case.find({
      completionClaimStatus: { $in: ["claimed", "needs_reconciliation"] },
      completionClaimedAt: { $lte: cutoff },
    })
      .select(
        "title status completionClaimStatus completionClaimedAt completionClaimTransferId completionClaimError payoutStatus payoutTransferId"
      )
      .sort({ completionClaimedAt: 1 })
      .limit(20)
      .lean();
    if (cases.length) {
      return {
        ok: false,
        code: "completion_reconciliation_required",
        message: `${cases.length} completion operation(s) still require reconciliation.`,
        details: cases.map((caseDoc) => ({
          caseId: String(caseDoc._id || ""),
          caseStatus: caseDoc.status || "",
          claimStatus: caseDoc.completionClaimStatus || "",
          transferId: caseDoc.completionClaimTransferId || caseDoc.payoutTransferId || "",
          payoutStatus: caseDoc.payoutStatus || "",
          claimedAt: caseDoc.completionClaimedAt,
        })),
      };
    }
    return {
      ok: true,
      code: "completion_reconciliation_ok",
      message: "No aged completion operations require reconciliation.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "completion_reconciliation_check_failed",
      message: "Completion reconciliation check could not complete.",
      details: { errorCode: errorCode(error, "COMPLETION_RECONCILIATION_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkInvitationReconciliationQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "invitation_reconciliation_check_skipped",
      message: "Invitation reconciliation check skipped because MONGO_URI is unavailable.",
    };
  }
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const cases = await Case.find({
      updatedAt: { $lte: cutoff },
      invites: { $elemMatch: { syncStatus: "needs_reconciliation" } },
    })
      .select("title invites updatedAt")
      .sort({ updatedAt: 1 })
      .limit(20)
      .lean();
    const invitations = cases.flatMap((caseDoc) =>
      (caseDoc.invites || [])
        .filter((invite) => invite?.syncStatus === "needs_reconciliation")
        .map((invite) => ({
          caseId: String(caseDoc._id || ""),
          paralegalId: String(invite.paralegalId || ""),
          status: invite.status || "",
          updatedAt: caseDoc.updatedAt,
        }))
    );
    if (invitations.length) {
      return {
        ok: false,
        code: "invitation_reconciliation_required",
        message: `${invitations.length} invitation record(s) still require reconciliation.`,
        details: invitations.slice(0, 20),
      };
    }
    return {
      ok: true,
      code: "invitation_reconciliation_ok",
      message: "No aged invitation records require reconciliation.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "invitation_reconciliation_check_failed",
      message: "Invitation reconciliation check could not complete.",
      details: { errorCode: errorCode(error, "INVITATION_RECONCILIATION_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkPostingReconciliationQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "posting_reconciliation_check_skipped",
      message: "Posting reconciliation check skipped because MONGO_URI is unavailable.",
    };
  }
  const cutoff = new Date(Date.now() - 5 * 60 * 1000);
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const cases = await Case.find({
      postingSyncStatus: "needs_reconciliation",
      updatedAt: { $lte: cutoff },
    })
      .select("title jobId status postingSyncError updatedAt")
      .sort({ updatedAt: 1 })
      .limit(20)
      .lean();
    if (cases.length) {
      return {
        ok: false,
        code: "posting_reconciliation_required",
        message: `${cases.length} Matter posting mirror(s) still require reconciliation.`,
        details: cases.map((caseDoc) => ({
          caseId: String(caseDoc._id || ""),
          jobId: String(caseDoc.jobId || ""),
          status: caseDoc.status || "",
          updatedAt: caseDoc.updatedAt,
        })),
      };
    }
    return {
      ok: true,
      code: "posting_reconciliation_ok",
      message: "No aged Matter posting mirrors require reconciliation.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "posting_reconciliation_check_failed",
      message: "Posting reconciliation check could not complete.",
      details: { errorCode: errorCode(error, "POSTING_RECONCILIATION_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkFileSecurityQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "file_security_check_skipped",
      message: "File security check skipped because MONGO_URI is unavailable.",
    };
  }
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const pendingCutoff = new Date(Date.now() - 15 * 60 * 1000);
    const files = await CaseFile.find({
      $or: [
        { securityStatus: { $in: ["blocked", "error", "not_required"] } },
        { securityStatus: "pending", createdAt: { $lte: pendingCutoff } },
        { securityStatus: { $exists: false }, createdAt: { $lte: pendingCutoff } },
      ],
    })
      .select("caseId securityStatus securityScanResult securityCheckedAt securityScannedAt createdAt")
      .sort({ createdAt: 1 })
      .limit(20)
      .lean();
    if (files.length) {
      return {
        ok: false,
        code: "file_security_attention_required",
        message: `${files.length} Matter document(s) are blocked, failed, unprotected, or stuck in security scanning.`,
        details: files.map((file) => ({
          fileId: String(file._id || ""),
          caseId: String(file.caseId || ""),
          status: file.securityStatus || "missing",
          result: file.securityScanResult || "",
          checkedAt: file.securityCheckedAt || null,
          scannedAt: file.securityScannedAt || null,
          createdAt: file.createdAt || null,
        })),
      };
    }
    return {
      ok: true,
      code: "file_security_ok",
      message: "No Matter documents require security-scan attention.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "file_security_check_failed",
      message: "File security check could not complete.",
      details: { errorCode: errorCode(error, "FILE_SECURITY_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkArchiveRecoveryQueue() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) {
    return {
      ok: true,
      code: "archive_recovery_check_skipped",
      message: "Archive recovery check skipped because MONGO_URI is unavailable.",
    };
  }
  let connectedHere = false;
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
      connectedHere = true;
    }
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const cases = await Case.find({
      status: "completed",
      paymentReleased: true,
      purgedAt: null,
      updatedAt: { $lte: cutoff },
      $or: [
        { archiveZipKey: "" },
        { archiveZipKey: { $exists: false } },
        { archiveReadyAt: null },
        { archiveReadyAt: { $exists: false } },
      ],
    })
      .select("title archiveZipKey archiveReadyAt completedAt updatedAt")
      .sort({ updatedAt: 1 })
      .limit(20)
      .lean();
    if (cases.length) {
      return {
        ok: false,
        code: "archive_recovery_required",
        message: `${cases.length} completed Matter archive(s) require recovery.`,
        details: cases.map((caseDoc) => ({
          caseId: String(caseDoc._id || ""),
          archiveKeyPresent: Boolean(caseDoc.archiveZipKey),
          archiveReadyAt: caseDoc.archiveReadyAt || null,
          completedAt: caseDoc.completedAt || null,
          updatedAt: caseDoc.updatedAt || null,
        })),
      };
    }
    return { ok: true, code: "archive_recovery_ok", message: "No completed Matter archives require recovery." };
  } catch (error) {
    return {
      ok: false,
      code: "archive_recovery_check_failed",
      message: "Archive recovery check could not complete.",
      details: { errorCode: errorCode(error, "ARCHIVE_RECOVERY_CHECK_FAILED") },
    };
  } finally {
    if (connectedHere) await mongoose.connection.close().catch(() => {});
  }
}

async function checkPersonalStorageDeletionQueue({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - 15 * 60 * 1000);
  try {
    const tasks = await StorageDeletionTask.find({
      $or: [
        { status: "blocked" },
        { status: "held", eligibleAt: { $lte: cutoff } },
        { status: "pending", eligibleAt: { $lte: cutoff } },
        { status: "processing", lockedAt: { $lte: cutoff } },
        { status: "retrying", attempts: { $gte: 3 } },
      ],
    })
      .select("status attempts eligibleAt lockedAt lastErrorCode createdAt")
      .sort({ createdAt: 1 })
      .limit(20)
      .lean();
    if (tasks.length) {
      return {
        ok: false,
        code: "personal_storage_deletion_attention_required",
        message: `${tasks.length} personal storage deletion task(s) are stuck or repeatedly failing.`,
        details: tasks.map((task) => ({
          taskId: String(task._id || ""),
          status: task.status,
          attempts: Number(task.attempts || 0),
          eligibleAt: task.eligibleAt || null,
          lockedAt: task.lockedAt || null,
          errorCode: task.lastErrorCode || "",
          createdAt: task.createdAt || null,
        })),
      };
    }
    return {
      ok: true,
      code: "personal_storage_deletion_ok",
      message: "Personal storage deletion queue is healthy.",
    };
  } catch (error) {
    return {
      ok: false,
      code: "personal_storage_deletion_check_failed",
      message: "Personal storage deletion check could not complete.",
      details: { errorCode: errorCode(error, "PERSONAL_STORAGE_DELETION_CHECK_FAILED") },
    };
  }
}

function buildFingerprint(failures) {
  return [...new Set(failures.map((entry) => String(entry?.code || "unknown_failure")))]
    .sort()
    .join("|");
}

function isIntentionalMaintenancePause(failures = []) {
  const entries = Array.isArray(failures) ? failures : [];
  if (!entries.some((entry) => entry?.code === "maintenance_mode_active")) return false;
  return entries.every((entry) => {
    if (entry?.code === "maintenance_mode_active") return true;
    return (
      ["health_failed", "health_release_mismatch"].includes(String(entry?.code || "")) &&
      Number(entry?.details?.status) === 503
    );
  });
}

function monitorExecutionSucceeded({ failures = [], alertDeliveryFailed = false } = {}) {
  if (alertDeliveryFailed) return false;
  return failures.length === 0 || isIntentionalMaintenancePause(failures);
}

async function loadPreviousState() {
  if (!MONITOR_PERSIST_STATE) return {};
  if (mongoose.connection.readyState === 1) {
    const state = await OpsMonitorState.findOne({ key: "platform" }).lean();
    return state || {};
  }
  return readJsonFile(STATE_FILE) || {};
}

async function persistState(summary) {
  if (!MONITOR_PERSIST_STATE) return;
  const state = {
    ok: Boolean(summary.ok),
    fingerprint: String(summary.fingerprint || "").slice(0, 8000),
    checkedAt: new Date(summary.checkedAt).toISOString(),
  };
  if (mongoose.connection.readyState === 1) {
    await OpsMonitorState.findOneAndUpdate(
      { key: "platform" },
      {
        $set: {
          ok: state.ok,
          fingerprint: state.fingerprint,
          checkedAt: new Date(state.checkedAt),
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    return;
  }
  writeJsonFile(STATE_FILE, state);
}

function summarizeMonitorForOutput(summary = {}) {
  return {
    checkedAt: summary.checkedAt,
    ok: Boolean(summary.ok),
    executionOk: Boolean(summary.executionOk),
    operatingState: String(summary.operatingState || (summary.ok ? "healthy" : "degraded")),
    fingerprint: String(summary.fingerprint || ""),
    checks: (Array.isArray(summary.checks) ? summary.checks : []).map((check) => {
      const details = check?.details;
      const safeDetails = Array.isArray(details)
        ? { itemCount: details.length }
        : details && typeof details === "object"
          ? Object.fromEntries(
            ["status", "errorCode", "completedAt"]
              .filter((key) => Object.prototype.hasOwnProperty.call(details, key))
              .map((key) => [key, details[key]])
          )
          : undefined;
      return {
        ok: Boolean(check?.ok),
        code: String(check?.code || "unknown"),
        message: String(check?.message || ""),
        ...(safeDetails && Object.keys(safeDetails).length ? { details: safeDetails } : {}),
      };
    }),
    alert: summary.alert,
    environment: summary.environment,
  };
}

async function ensureMonitorDatabaseConnection() {
  if (mongoose.connection.readyState === 1) return false;
  const mongoUri = process.env.MONGO_URI || process.env.MONGO_URL || process.env.DATABASE_URL;
  if (!mongoUri) return false;
  await mongoose.connect(requireMongoUri(mongoUri), MONGO_OPERATION_OPTIONS);
  return true;
}

async function main() {
  assertOpsMonitorConfiguration(process.env);
  const connectedHere = await ensureMonitorDatabaseConnection();
  try {
    const checks = [
      await checkHealth(),
      await checkMaintenanceMode(),
      await checkBackupFreshness(),
      await checkRecentWebhookFailures(),
      await checkPaymentReconciliationQueue(),
      await checkFinancialExceptionQueue(),
      await checkApplicationReconciliationQueue(),
      await checkInvitationReconciliationQueue(),
      await checkPostingReconciliationQueue(),
      await checkHiringReconciliationQueue(),
      await checkCompletionReconciliationQueue(),
      await checkFileSecurityQueue(),
      await checkArchiveRecoveryQueue(),
      await checkPersonalStorageDeletionQueue(),
    ];

    const failures = checks.filter((entry) => !entry.ok);
    const checksOk = failures.length === 0;
    const intentionalMaintenancePause = isIntentionalMaintenancePause(failures);
    const fingerprint = buildFingerprint(failures);
    const previous = await loadPreviousState();
    const previousOk = previous.ok !== false;
    const changed = previous.ok !== checksOk || previous.fingerprint !== fingerprint;
    let alert = { required: false, delivered: false };
    let alertDeliveryFailed = false;

    if (!checksOk && changed && MONITOR_SEND_OWNER_ALERTS) {
      alert = { required: true, delivered: false, kind: "failure" };
      try {
        const result = await sendOwnerAlert("LPC attention needed: platform check found an issue", [
          "One or more platform checks need attention.",
          ...failures.map((entry) => entry.message),
          HEALTH_URL ? `Health page: ${HEALTH_URL}` : "Health page is not configured yet.",
        ], { throwOnError: true });
        if (!result.delivered) throw Object.assign(new Error("Owner alert was not delivered."), { code: result.errorCode });
        alert.delivered = true;
      } catch (error) {
        alertDeliveryFailed = true;
        alert.errorCode = String(error?.code || error?.name || "OWNER_ALERT_DELIVERY_FAILED").slice(0, 80);
        logger.error({ errorCode: alert.errorCode, message: "Owner failure alert could not be delivered." });
      }
    } else if (checksOk && !previousOk && MONITOR_ALERT_ON_OK && MONITOR_SEND_OWNER_ALERTS) {
      alert = { required: true, delivered: false, kind: "recovery" };
      try {
        const result = await sendOwnerAlert("LPC update: platform checks look healthy again", [
          "The latest platform checks passed.",
          HEALTH_URL ? `Health page: ${HEALTH_URL}` : "Health page is not configured yet.",
        ], { throwOnError: true });
        if (!result.delivered) throw Object.assign(new Error("Owner alert was not delivered."), { code: result.errorCode });
        alert.delivered = true;
      } catch (error) {
        alertDeliveryFailed = true;
        alert.errorCode = String(error?.code || error?.name || "OWNER_ALERT_DELIVERY_FAILED").slice(0, 80);
        logger.error({ errorCode: alert.errorCode, message: "Owner recovery alert could not be delivered." });
      }
    }

    const summary = {
      checkedAt: new Date().toISOString(),
      ok: checksOk && !alertDeliveryFailed,
      executionOk: monitorExecutionSucceeded({ failures, alertDeliveryFailed }),
      operatingState: checksOk ? "healthy" : intentionalMaintenancePause ? "paused" : "degraded",
      fingerprint,
      checks,
      alert,
      environment: {
        releaseCommit: releaseCommit(process.env),
        isRender: IS_RENDER,
        persistState: MONITOR_PERSIST_STATE,
        requireBackup: MONITOR_REQUIRE_BACKUP,
        sendOwnerAlerts: MONITOR_SEND_OWNER_ALERTS,
      },
    };
    // Do not acknowledge a state transition until its required owner notification
    // succeeds. The next cron run will retry the same alert.
    if (!alertDeliveryFailed) await persistState(summary);

    process.stdout.write(`${JSON.stringify(redactValue(summarizeMonitorForOutput(summary)), null, 2)}\n`);
    process.exitCode = summary.executionOk ? 0 : 1;
  } finally {
    if (connectedHere) await mongoose.disconnect();
  }
}

if (require.main === module) main().catch(async (error) => {
  const payload = {
    checkedAt: new Date().toISOString(),
    ok: false,
    fingerprint: "monitor_fatal",
    checks: [
      {
        ok: false,
        code: "monitor_fatal",
        message: "The operations monitor encountered a fatal error.",
        details: { errorCode: String(error?.code || error?.name || "MONITOR_FATAL").slice(0, 80) },
      },
    ],
  };
  if (MONITOR_SEND_OWNER_ALERTS) {
    try {
      const result = await sendOwnerAlert("LPC attention needed: platform check could not finish", [
        "The platform check did not finish and should be reviewed.",
        `Error code: ${String(error?.code || error?.name || "MONITOR_FATAL").slice(0, 80)}`,
      ], { throwOnError: true });
      if (!result.delivered) throw new Error("Owner alert was not delivered.");
      await persistState(payload);
    } catch (alertError) {
      logger.error({
        errorCode: String(alertError?.code || alertError?.name || "OWNER_ALERT_DELIVERY_FAILED").slice(0, 80),
        message: "Fatal monitor alert could not be delivered.",
      });
    }
  } else {
    await persistState(payload).catch(() => {});
  }
  await mongoose.disconnect().catch(() => {});
  process.stdout.write(`${JSON.stringify(redactValue(payload), null, 2)}\n`);
  process.exitCode = 1;
});

module.exports = {
  buildFingerprint,
  checkBackupFreshness,
  checkFinancialExceptionQueue,
  checkHealth,
  checkMaintenanceMode,
  checkPersonalStorageDeletionQueue,
  fetchAtlasBackupStatus,
  isIntentionalMaintenancePause,
  loadPreviousState,
  monitorExecutionSucceeded,
  persistState,
  summarizeMonitorForOutput,
};
