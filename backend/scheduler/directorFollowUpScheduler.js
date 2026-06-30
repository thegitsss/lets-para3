let cron = null;

try {
  cron = require("node-cron");
} catch (_) {
  cron = null;
}

const { processAutomaticDirectorFollowUps } = require("../services/director/directorPortalService");
const { createLogger } = require("../utils/logger");

const logger = createLogger("scheduler:director-follow-ups");
let directorFollowUpTask = null;

function startDirectorFollowUpScheduler() {
  if (process.env.DIRECTOR_FOLLOW_UP_SCHEDULER_ENABLED === "false") {
    logger.info("Director follow-up scheduler disabled by environment.");
    return { started: false, reason: "disabled" };
  }

  if (!cron?.schedule) {
    logger.warn("node-cron is unavailable; director follow-up scheduler was not started.");
    return { started: false, reason: "missing_node_cron" };
  }

  if (directorFollowUpTask) {
    return { started: true, reused: true, schedule: "*/30 * * * *" };
  }

  directorFollowUpTask = cron.schedule("*/30 * * * *", async () => {
    try {
      const result = await processAutomaticDirectorFollowUps({
        now: new Date(),
        limit: 50,
      });
      logger.info("Director follow-up run completed.", result);
    } catch (err) {
      logger.error("Director follow-up run failed.", err?.message || err);
    }
  });

  logger.info("Director follow-up scheduler started.", {
    schedule: "*/30 * * * *",
    timezone: process.env.TZ || "system",
  });

  return { started: true, schedule: "*/30 * * * *" };
}

module.exports = {
  startDirectorFollowUpScheduler,
};
