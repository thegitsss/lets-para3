let cron = null;

try {
  cron = require("node-cron");
} catch (_) {
  cron = null;
}

const { generateMonitoringReport } = require("../ai/monitoringAgent");
const { runTimedTriggers } = require("../services/lpcEvents/timedTriggerService");
const { prepareFounderDailyLogIfDue } = require("../services/marketing/founderDailyLogService");
const { cleanupJrCmoLibrary, refreshJrCmoLibrary } = require("../services/marketing/jrCmoResearchService");
const { runScheduledCycleCreation } = require("../services/marketing/publishingCycleService");
const { createLogger } = require("../utils/logger");

const logger = createLogger("scheduler:agents");
let monitoringTask = null;

function startAgentScheduler() {
  if (process.env.AGENT_SCHEDULER_ENABLED === "false") {
    logger.info("Agent scheduler disabled by environment.");
    return { started: false, reason: "disabled" };
  }

  if (!cron?.schedule) {
    logger.warn("node-cron is unavailable; agent scheduler was not started.");
    return { started: false, reason: "missing_node_cron" };
  }

  if (monitoringTask) {
    return { started: true, reused: true, schedule: "*/10 * * * *" };
  }

  monitoringTask = cron.schedule("*/10 * * * *", async () => {
    try {
      const report = await generateMonitoringReport();
      const timed = await runTimedTriggers();
      const jrCmoResearch = await refreshJrCmoLibrary();
      const jrCmoCleanup = await cleanupJrCmoLibrary();
      const marketingPublishing = await runScheduledCycleCreation({
        actor: { actorType: "system", label: "Marketing Publishing Scheduler" },
      });
      const founderDailyPrep = await prepareFounderDailyLogIfDue({
        now: new Date(),
        schedulerState: {
          marketingPublishing,
          generatedFromScheduler: true,
        },
      });
      logger.info("Monitoring report generated.", {
        ok: report.ok,
        alerts: Array.isArray(report.alerts) ? report.alerts.length : 0,
        countsByCategory: report.countsByCategory,
        countsByUrgency: report.countsByUrgency,
        timedTriggers: timed,
        jrCmoResearch: {
          dayContextId: jrCmoResearch.dayContext?._id ? String(jrCmoResearch.dayContext._id) : "",
          opportunityCount: Array.isArray(jrCmoResearch.opportunities) ? jrCmoResearch.opportunities.length : 0,
          factCount: Array.isArray(jrCmoResearch.facts) ? jrCmoResearch.facts.length : 0,
        },
        jrCmoCleanup,
        marketingPublishing,
        founderDailyPrep: founderDailyPrep?.prepared
          ? {
              prepared: true,
              generatedAt: founderDailyPrep.log?.generatedAt || null,
              readyPosts: Array.isArray(founderDailyPrep.log?.readyPosts) ? founderDailyPrep.log.readyPosts.length : 0,
            }
          : {
              prepared: false,
              reason: founderDailyPrep?.reason || "skipped",
            },
      });
    } catch (err) {
      logger.error("Scheduled monitoring run failed.", err?.message || err);
    }
  });

  logger.info("Agent scheduler started.", {
    schedule: "*/10 * * * *",
    timezone: process.env.AGENT_SCHEDULER_TIMEZONE || process.env.TZ || "system",
  });

  return { started: true, schedule: "*/10 * * * *" };
}

module.exports = {
  startAgentScheduler,
};
