const os = require("os");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");

const {
  claimNextIncidentJob,
  renewIncidentJobLock,
  processClaimedIncidentJob,
} = require("../scheduler/incidentScheduler");
const { createLogger } = require("../utils/logger");

const logger = createLogger("incident-runner");
const MAX_JOBS_PER_RUN = Number(process.env.INCIDENT_RUNNER_MAX_JOBS || 5);
const DEFAULT_POLL_MS = Number(process.env.INCIDENT_RUNNER_POLL_MS || 5000);
const DEFAULT_LOCK_MS = Number(process.env.INCIDENT_RUNNER_LOCK_MS || 15 * 60 * 1000);
const DEFAULT_LOCK_RENEW_MS = Number(process.env.INCIDENT_RUNNER_LOCK_RENEW_MS || 60 * 1000);
const DEFAULT_HEARTBEAT_MS = Number(process.env.INCIDENT_RUNNER_HEARTBEAT_MS || 5 * 60 * 1000);
const DEFAULT_MONGO_CONNECT_TIMEOUT_MS = Number(
  process.env.INCIDENT_RUNNER_MONGO_CONNECT_TIMEOUT_MS || 15000
);
const DEFAULT_JOB_TYPES = Object.freeze([
  "investigation",
  "patch_planning",
  "patch_execution",
  "verification",
  "deployment",
]);

function normalizePositiveNumber(value, fallback, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.max(minimum, Math.floor(parsed));
}

function defaultWorkerId() {
  return `incident-runner:${os.hostname()}:${process.pid}`;
}

function buildRunnerConfig(overrides = {}) {
  const maxJobs = normalizePositiveNumber(overrides.maxJobs, MAX_JOBS_PER_RUN);
  const lockMs = normalizePositiveNumber(overrides.lockMs, DEFAULT_LOCK_MS, 1000);
  const requestedLockRenewMs = normalizePositiveNumber(
    overrides.lockRenewMs,
    DEFAULT_LOCK_RENEW_MS,
    1000
  );
  const lockRenewMs = Math.min(
    requestedLockRenewMs,
    Math.max(1000, lockMs - 1000)
  );
  const mongoConnectTimeoutMs = normalizePositiveNumber(
    overrides.mongoConnectTimeoutMs,
    DEFAULT_MONGO_CONNECT_TIMEOUT_MS,
    1000
  );
  const shutdownGraceMs = normalizePositiveNumber(
    overrides.shutdownGraceMs,
    Math.max(lockMs + 15000, 30000),
    1000
  );
  return {
    maxJobs,
    workerId: overrides.workerId || defaultWorkerId(),
    jobTypes:
      Array.isArray(overrides.jobTypes) && overrides.jobTypes.length
        ? [...new Set(overrides.jobTypes.map((jobType) => String(jobType || "").trim()).filter(Boolean))]
        : DEFAULT_JOB_TYPES,
    pollMs: normalizePositiveNumber(overrides.pollMs, DEFAULT_POLL_MS, 250),
    lockMs,
    lockRenewMs,
    heartbeatMs: normalizePositiveNumber(overrides.heartbeatMs, DEFAULT_HEARTBEAT_MS, 1000),
    mongoConnectTimeoutMs,
    shutdownGraceMs,
  };
}

function summarizeBatchResults(results = []) {
  return results.reduce(
    (summary, result) => {
      if (result?.ok === true) summary.succeeded += 1;
      else if (result?.skipped === true) summary.skipped += 1;
      else summary.failed += 1;

      const jobType = String(result?.jobType || "unknown");
      summary.jobTypes[jobType] = (summary.jobTypes[jobType] || 0) + 1;
      return summary;
    },
    { succeeded: 0, skipped: 0, failed: 0, jobTypes: {} }
  );
}

function createRunnerLifecycle() {
  let stopRequested = false;
  let stopReason = "";
  const listeners = new Set();

  return {
    requestStop(reason = "stop_requested") {
      if (stopRequested) return false;
      stopRequested = true;
      stopReason = String(reason || "stop_requested");
      listeners.forEach((listener) => {
        try {
          listener(stopReason);
        } catch (_error) {
          // Ignore listener errors during shutdown.
        }
      });
      return true;
    },
    onStop(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get stopRequested() {
      return stopRequested;
    },
    get stopReason() {
      return stopReason;
    },
  };
}

function waitForStopAwareDelay(
  delayMs,
  lifecycle,
  { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}
) {
  const timeoutMs = Math.max(0, Number(delayMs) || 0);
  if (!timeoutMs || lifecycle?.stopRequested) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let unsubscribe = () => {};

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeoutFn(timer);
      unsubscribe();
      resolve();
    };

    unsubscribe = lifecycle?.onStop ? lifecycle.onStop(() => finish()) : () => {};
    timer = setTimeoutFn(() => finish(), timeoutMs);
  });
}

async function runIncidentRunnerOnce(
  {
    maxJobs = MAX_JOBS_PER_RUN,
    workerId = defaultWorkerId(),
    jobTypes = DEFAULT_JOB_TYPES,
    lockMs = DEFAULT_LOCK_MS,
    lockRenewMs = DEFAULT_LOCK_RENEW_MS,
  } = {},
  dependencies = {}
) {
  const config = buildRunnerConfig({ maxJobs, workerId, jobTypes, lockMs, lockRenewMs });
  const claimJob = dependencies.claimJob || claimNextIncidentJob;
  const startLockHeartbeat = dependencies.startLockHeartbeat || createClaimLockHeartbeat;
  const processJob = dependencies.processJob || processClaimedIncidentJob;
  const isDbReady = dependencies.isDbReady || (() => mongoose.connection.readyState === 1);
  const log = dependencies.logger || logger;

  if (!isDbReady()) {
    return { ok: false, reason: "db_not_ready", processed: 0, results: [] };
  }

  const results = [];

  for (let count = 0; count < config.maxJobs; count += 1) {
    // eslint-disable-next-line no-await-in-loop
    const claim = await claimJob({
      jobTypes: config.jobTypes,
      workerId: config.workerId,
      lockMs: config.lockMs,
    });
    if (!claim) break;

    const heartbeat = startLockHeartbeat(claim, config, {
      renewLock: dependencies.renewLock,
      logger: log,
      timerFns: dependencies.timerFns,
    });

    let result = null;
    let heartbeatState = { renewals: 0, lostLock: false, reason: "", lastRenewedAt: null };
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await processJob(claim);
    } finally {
      // eslint-disable-next-line no-await-in-loop
      heartbeatState = await heartbeat.stop();
    }

    if (heartbeatState.lostLock) {
      const error = {
        ok: false,
        publicId: claim.publicId,
        jobType: claim.jobType,
        error: heartbeatState.reason || "Incident runner lost the job lock before processing completed.",
      };
      results.push(error);
      return {
        ok: false,
        fatal: true,
        reason: heartbeatState.reason || "lock_lost",
        processed: results.length,
        results,
        config,
      };
    }

    if (result && typeof result === "object") {
      result.lockRenewals = heartbeatState.renewals;
    }
    results.push(result);
  }

  return {
    ok: true,
    processed: results.length,
    results,
    config,
  };
}

async function runIncidentRunnerLoop(options = {}, dependencies = {}) {
  const config = buildRunnerConfig(options);
  const lifecycle = dependencies.lifecycle || createRunnerLifecycle();
  const runBatch =
    dependencies.runBatch ||
    ((batchOptions) =>
      runIncidentRunnerOnce(batchOptions, {
        claimJob: dependencies.claimJob,
        processJob: dependencies.processJob,
        isDbReady: dependencies.isDbReady,
      }));
  const sleep = dependencies.sleep || waitForStopAwareDelay;
  const log = dependencies.logger || logger;
  const now = dependencies.now || (() => Date.now());

  let cycles = 0;
  let processedTotal = 0;
  let idleSince = now();
  let lastHeartbeatLoggedAt = 0;

  while (!lifecycle.stopRequested) {
    cycles += 1;
    const cycleStartedAt = now();
    // eslint-disable-next-line no-await-in-loop
    const result = await runBatch(config);

    if (!result?.ok && result?.reason === "db_not_ready") {
      throw new Error("Incident runner lost database connectivity.");
    }
    if (result?.fatal === true) {
      throw new Error(
        `Incident runner lost exclusive job ownership and is stopping for supervisor restart: ${result.reason || "lock_lost"}.`
      );
    }

    processedTotal += Number(result?.processed || 0);
    const summary = summarizeBatchResults(result?.results || []);

    if (Number(result?.processed || 0) > 0) {
      idleSince = now();
      lastHeartbeatLoggedAt = 0;
      const message = summary.failed
        ? "Incident runner processed jobs with failures."
        : "Incident runner processed jobs.";
      const logMethod = summary.failed ? log.warn.bind(log) : log.info.bind(log);
      logMethod({
        workerId: config.workerId,
        processed: Number(result?.processed || 0),
        succeeded: summary.succeeded,
        skipped: summary.skipped,
        failed: summary.failed,
        jobTypes: summary.jobTypes,
      });
    } else if (config.heartbeatMs > 0) {
      const idleMs = Math.max(0, now() - idleSince);
      if (idleMs >= config.heartbeatMs && idleMs - lastHeartbeatLoggedAt >= config.heartbeatMs) {
        lastHeartbeatLoggedAt = idleMs;
        log.info({
          workerId: config.workerId,
          cycles,
          idleMs,
          pollMs: config.pollMs,
          jobTypes: config.jobTypes,
          message: "Incident runner heartbeat: idle and healthy.",
        });
      }
    }

    const cycleDurationMs = Math.max(0, now() - cycleStartedAt);
    if (cycleDurationMs >= config.lockMs) {
      log.warn({
        workerId: config.workerId,
        cycleDurationMs,
        lockMs: config.lockMs,
        message: "Incident runner cycle exceeded the configured lock window.",
      });
    }

    if (lifecycle.stopRequested) break;

    const shouldContinueImmediately = Number(result?.processed || 0) >= config.maxJobs;
    if (!shouldContinueImmediately) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(config.pollMs, lifecycle, dependencies.timerFns || {});
    }
  }

  return {
    ok: true,
    workerId: config.workerId,
    cycles,
    processedTotal,
    stopReason: lifecycle.stopReason || "completed",
  };
}

function createClaimLockHeartbeat(
  claim,
  config,
  {
    renewLock = renewIncidentJobLock,
    logger: log = logger,
    timerFns = {},
  } = {}
) {
  const setTimeoutFn = timerFns.setTimeoutFn || setTimeout;
  const clearTimeoutFn = timerFns.clearTimeoutFn || clearTimeout;

  let stopped = false;
  let timer = null;
  let renewals = 0;
  let lostLock = false;
  let reason = "";
  let lastRenewedAt = null;
  let inFlightRenewal = null;

  const schedule = () => {
    if (stopped || lostLock) return;
    timer = setTimeoutFn(async () => {
      timer = null;
      if (stopped || lostLock) return;

      inFlightRenewal = (async () => {
        try {
          const renewal = await renewLock({
            incidentId: claim.incidentId,
            lockToken: claim.lockToken,
            workerId: claim.workerId || config.workerId,
            lockMs: config.lockMs,
          });
          if (!renewal?.ok) {
            lostLock = true;
            reason = renewal?.reason || "lock_lost";
            log.error({
              workerId: config.workerId,
              publicId: claim.publicId,
              jobType: claim.jobType,
              reason,
              message:
                "Incident runner lost job lock during execution and is marking the worker unhealthy.",
            });
            return;
          }
          renewals += 1;
          lastRenewedAt = renewal.lockExpiresAt || new Date();
        } catch (error) {
          lostLock = true;
          reason = error?.message || "lock_renew_failed";
          log.error({
            workerId: config.workerId,
            publicId: claim.publicId,
            jobType: claim.jobType,
            reason,
            message:
              "Incident runner failed to renew the job lock during execution and is marking the worker unhealthy.",
          });
          return;
        } finally {
          inFlightRenewal = null;
        }

        schedule();
      })();
    }, config.lockRenewMs);

    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  };

  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeoutFn(timer);
        timer = null;
      }
      if (inFlightRenewal) {
        await inFlightRenewal.catch(() => {});
      }
      return {
        renewals,
        lostLock,
        reason,
        lastRenewedAt,
      };
    },
  };
}

function buildRunnerCapabilitySummary(config) {
  const deploymentEnabled = config.jobTypes.includes("deployment");
  return {
    deploymentEnabled,
    previewMode: deploymentEnabled ? process.env.INCIDENT_PREVIEW_DEPLOY_MODE || "disabled" : "n/a",
    productionMode: deploymentEnabled ? process.env.INCIDENT_PRODUCTION_DEPLOY_MODE || "disabled" : "n/a",
    rollbackMode: deploymentEnabled ? process.env.INCIDENT_ROLLBACK_MODE || "disabled" : "n/a",
    founderApprovalConfigured: Boolean(process.env.INCIDENT_FOUNDER_APPROVER_EMAILS),
  };
}

function bindRunnerSignals(
  lifecycle,
  {
    logger: log = logger,
    workerId = defaultWorkerId(),
    shutdownGraceMs: requestedShutdownGraceMs = Math.max(DEFAULT_LOCK_MS + 15000, 30000),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    exitFn = (code) => process.exit(code),
  } = {}
) {
  const handlers = new Map();
  let shutdownTimer = null;
  let shutdownSignalsReceived = 0;
  const shutdownGraceMs = normalizePositiveNumber(
    requestedShutdownGraceMs,
    Math.max(DEFAULT_LOCK_MS + 15000, 30000),
    1000
  );

  ["SIGINT", "SIGTERM"].forEach((signal) => {
    const handler = () => {
      shutdownSignalsReceived += 1;
      if (shutdownSignalsReceived > 1) {
        log.error({
          workerId,
          signal,
          message:
            "Incident runner received a second shutdown signal and is exiting immediately for supervisor restart.",
        });
        exitFn(1);
        return;
      }

      if (lifecycle.requestStop(signal)) {
        log.info({
          workerId,
          signal,
          shutdownGraceMs,
          message: "Incident runner shutdown requested. Finishing the current batch before exit.",
        });
        shutdownTimer = setTimeoutFn(() => {
          log.error({
            workerId,
            signal,
            shutdownGraceMs,
            message:
              "Incident runner shutdown grace period expired before the worker stopped. Exiting for supervisor restart.",
          });
          exitFn(1);
        }, shutdownGraceMs);
        if (shutdownTimer && typeof shutdownTimer.unref === "function") {
          shutdownTimer.unref();
        }
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  });

  return () => {
    if (shutdownTimer !== null) {
      clearTimeoutFn(shutdownTimer);
      shutdownTimer = null;
    }
    handlers.forEach((handler, signal) => {
      process.off(signal, handler);
    });
  };
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required to run the incident runner.");
  }

  const lifecycle = createRunnerLifecycle();
  const config = buildRunnerConfig();
  const unbindSignals = bindRunnerSignals(lifecycle, {
    logger,
    workerId: config.workerId,
    shutdownGraceMs: config.shutdownGraceMs,
  });

  let disconnectedUnexpectedly = false;
  const handleDisconnect = () => {
    if (lifecycle.stopRequested) return;
    disconnectedUnexpectedly = true;
    logger.error({
      workerId: config.workerId,
      message: "Incident runner lost MongoDB connectivity and is stopping for supervisor restart.",
    });
    lifecycle.requestStop("db_disconnected");
  };

  mongoose.connection.on("disconnected", handleDisconnect);
  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: config.mongoConnectTimeoutMs,
    connectTimeoutMS: config.mongoConnectTimeoutMs,
  });

  logger.info({
    workerId: config.workerId,
    maxJobs: config.maxJobs,
    pollMs: config.pollMs,
    lockMs: config.lockMs,
    lockRenewMs: config.lockRenewMs,
    heartbeatMs: config.heartbeatMs,
    mongoConnectTimeoutMs: config.mongoConnectTimeoutMs,
    shutdownGraceMs: config.shutdownGraceMs,
    jobTypes: config.jobTypes,
    capabilities: buildRunnerCapabilitySummary(config),
    message: "Incident runner started.",
  });

  try {
    const result = await runIncidentRunnerLoop(config, { lifecycle, logger });
    if (disconnectedUnexpectedly) {
      throw new Error("Incident runner stopped after losing MongoDB connectivity.");
    }
    logger.info({
      workerId: config.workerId,
      cycles: result.cycles,
      processedTotal: result.processedTotal,
      stopReason: result.stopReason,
      message: "Incident runner stopped.",
    });
  } finally {
    unbindSignals();
    mongoose.connection.off("disconnected", handleDisconnect);
    await mongoose.connection.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    logger.error("Incident runner failed.", error?.message || error);
    void mongoose.connection.close().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_JOB_TYPES,
  DEFAULT_POLL_MS,
  DEFAULT_LOCK_MS,
  DEFAULT_MONGO_CONNECT_TIMEOUT_MS,
  defaultWorkerId,
  buildRunnerConfig,
  createRunnerLifecycle,
  createClaimLockHeartbeat,
  buildRunnerCapabilitySummary,
  waitForStopAwareDelay,
  runIncidentRunnerOnce,
  runIncidentRunnerLoop,
  bindRunnerSignals,
  main,
};
