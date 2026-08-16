#!/usr/bin/env node
"use strict";

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

const mongoose = require("mongoose");
const { generateMonitoringReport } = require("../ai/monitoringAgent");
const { runTimedTriggers } = require("../services/lpcEvents/timedTriggerService");
const { prepareFounderDailyLogIfDue } = require("../services/marketing/founderDailyLogService");
const { cleanupJrCmoLibrary, refreshJrCmoLibrary } = require("../services/marketing/jrCmoResearchService");
const { runScheduledCycleCreation } = require("../services/marketing/publishingCycleService");
const {
  autoImportDirectorMail,
  processAutomaticDirectorFollowUps,
} = require("../services/director/directorPortalService");
const { purgeExpiredCases } = require("../services/caseLifecycle");
const { processPersonalStorageDeletionTasks } = require("../services/personalStorageDeletion");
const {
  processAdminOverdueDisputes,
  processExpiredWithdrawalWindows,
} = require("../services/withdrawalLifecycle");
const { createLogger } = require("../utils/logger");
const { releaseCommit } = require("../utils/releaseIdentity");
const { readMaintenanceMode } = require("../utils/appSettings");
const { assertAutomationConfiguration } = require("../utils/workerProductionConfig");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const logger = createLogger("automation-cycle");

function isFullCycle(now = new Date()) {
  return Math.floor(now.getUTCMinutes() / 5) % 2 === 0;
}

function serializeError(error) {
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || error || "Unknown error"),
  };
}

async function runTask(name, operation, results, failures) {
  const startedAt = Date.now();
  try {
    const value = await operation();
    results[name] = { ok: true, durationMs: Date.now() - startedAt, value };
    return value;
  } catch (error) {
    const failure = { name, durationMs: Date.now() - startedAt, error: serializeError(error) };
    results[name] = { ok: false, durationMs: failure.durationMs, error: failure.error };
    failures.push(failure);
    logger.error({ task: name, ...failure.error, message: "Scheduled automation task failed." });
    return null;
  }
}

async function runAutomationCycle({ now = new Date(), dependencies = {} } = {}) {
  const deps = {
    readMaintenanceMode,
    generateMonitoringReport,
    runTimedTriggers,
    prepareFounderDailyLogIfDue,
    cleanupJrCmoLibrary,
    refreshJrCmoLibrary,
    runScheduledCycleCreation,
    autoImportDirectorMail,
    processAutomaticDirectorFollowUps,
    purgeExpiredCases,
    processPersonalStorageDeletionTasks,
    processAdminOverdueDisputes,
    processExpiredWithdrawalWindows,
    ...dependencies,
  };
  const results = {};
  const failures = [];
  const fullCycle = isFullCycle(now);

  const automationControl = await runTask(
    "automationControl",
    async () => {
      try {
        const maintenanceMode = await deps.readMaintenanceMode();
        if (typeof maintenanceMode !== "boolean") throw new TypeError("Invalid maintenance-mode value.");
        return { maintenanceMode };
      } catch {
        const error = new Error("Automation control settings could not be read.");
        error.name = "AutomationControlUnavailableError";
        throw error;
      }
    },
    results,
    failures
  );

  if (!automationControl) {
    return {
      ok: false,
      paused: true,
      pauseReason: "settings_unavailable",
      fullCycle,
      now: now.toISOString(),
      results,
      failures,
    };
  }

  if (automationControl.maintenanceMode) {
    return {
      ok: true,
      paused: true,
      pauseReason: "maintenance_mode",
      fullCycle,
      now: now.toISOString(),
      results,
      failures,
    };
  }

  const expiredWithdrawals = await runTask(
    "expiredWithdrawals",
    async () => {
      const result = await deps.processExpiredWithdrawalWindows({ now });
      if (Number(result?.failed || 0) > 0) {
        throw new Error(`${result.failed} expired withdrawal finalization(s) failed.`);
      }
      return result;
    },
    results,
    failures
  );

  const overdueDisputes = await runTask(
    "overdueDisputes",
    async () => {
      const result = await deps.processAdminOverdueDisputes({ now });
      if (Number(result?.failed || 0) > 0) {
        throw new Error(`${result.failed} overdue dispute notification(s) failed.`);
      }
      return result;
    },
    results,
    failures
  );

  const casePurge = await runTask(
    "casePurge",
    () => deps.purgeExpiredCases(),
    results,
    failures
  );

  const personalStorageDeletion = await runTask(
    "personalStorageDeletion",
    () => deps.processPersonalStorageDeletionTasks(),
    results,
    failures
  );

  const mailImport = await runTask(
    "directorMailImport",
    async () => {
      const result = await deps.autoImportDirectorMail({ now, toDate: now, lookbackHours: 24, limit: 25 });
      if (Number(result?.failed || 0) > 0) {
        throw new Error(`${result.failed} director mailbox import(s) failed.`);
      }
      return result;
    },
    results,
    failures
  );

  if (!fullCycle) {
    return {
      ok: failures.length === 0,
      paused: false,
      fullCycle,
      now: now.toISOString(),
      casePurge,
      personalStorageDeletion,
      expiredWithdrawals,
      overdueDisputes,
      mailImport,
      results,
      failures,
    };
  }

  const monitoring = await runTask(
    "monitoringReport",
    () => deps.generateMonitoringReport(),
    results,
    failures
  );
  const timedTriggers = await runTask(
    "timedTriggers",
    () => deps.runTimedTriggers(),
    results,
    failures
  );
  const research = await runTask(
    "marketingResearch",
    () => deps.refreshJrCmoLibrary({ now }),
    results,
    failures
  );
  const cleanup = await runTask(
    "marketingCleanup",
    () => deps.cleanupJrCmoLibrary({ now }),
    results,
    failures
  );
  const marketingPublishing = await runTask(
    "marketingPublishing",
    () => deps.runScheduledCycleCreation({ actor: { actorType: "system", label: "Render Automation Cron" }, now }),
    results,
    failures
  );
  const directorFollowUps = await runTask(
    "directorFollowUps",
    () => deps.processAutomaticDirectorFollowUps({ now, limit: 50 }),
    results,
    failures
  );
  const founderDailyPrep = await runTask(
    "founderDailyPrep",
    () =>
      deps.prepareFounderDailyLogIfDue({
        now,
        schedulerState: {
          marketingPublishing,
          directorFollowUps,
          generatedFromScheduler: true,
        },
      }),
    results,
    failures
  );

  return {
    ok: failures.length === 0,
    paused: false,
    fullCycle,
    now: now.toISOString(),
    casePurge,
    personalStorageDeletion,
    expiredWithdrawals,
    overdueDisputes,
    mailImport,
    monitoring,
    timedTriggers,
    research,
    cleanup,
    marketingPublishing,
    directorFollowUps,
    founderDailyPrep,
    results,
    failures,
  };
}

async function main() {
  assertAutomationConfiguration(process.env);
  const mongoUri = requireMongoUri(process.env.MONGO_URI);
  await mongoose.connect(mongoUri, MONGO_OPERATION_OPTIONS);
  try {
    const summary = await runAutomationCycle({ now: new Date() });
    process.stdout.write(`${JSON.stringify({ ...summary, releaseCommit: releaseCommit(process.env) }, null, 2)}\n`);
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    logger.error({ ...serializeError(error), message: "Scheduled automation cycle could not finish." });
    await mongoose.disconnect().catch(() => {});
    process.exitCode = 1;
  });
}

module.exports = {
  isFullCycle,
  runAutomationCycle,
};
