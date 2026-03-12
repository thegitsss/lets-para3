let cron = null;

try {
  cron = require("node-cron");
} catch (_) {
  cron = null;
}

const { generateMonitoringReport } = require("../ai/monitoringAgent");
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
      logger.info("Monitoring report generated.", {
        ok: report.ok,
        alerts: Array.isArray(report.alerts) ? report.alerts.length : 0,
        countsByCategory: report.countsByCategory,
        countsByUrgency: report.countsByUrgency,
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
