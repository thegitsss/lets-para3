let cron = null;

try {
  cron = require("node-cron");
} catch (_) {
  cron = null;
}

const { autoImportDirectorMail } = require("../services/director/directorPortalService");
const { createLogger } = require("../utils/logger");

const logger = createLogger("scheduler:director-mail-import");
let directorMailImportTask = null;

function startDirectorMailImportScheduler() {
  if (process.env.DIRECTOR_MAIL_IMPORT_SCHEDULER_ENABLED === "false") {
    logger.info("Director mail import scheduler disabled by environment.");
    return { started: false, reason: "disabled" };
  }

  if (!cron?.schedule) {
    logger.warn("node-cron is unavailable; director mail import scheduler was not started.");
    return { started: false, reason: "missing_node_cron" };
  }

  const schedule = process.env.DIRECTOR_MAIL_IMPORT_CRON || "*/5 * * * *";
  const lookbackHours = Number(process.env.DIRECTOR_MAIL_IMPORT_LOOKBACK_HOURS || 24);
  const limit = Number(process.env.DIRECTOR_MAIL_IMPORT_DIRECTOR_LIMIT || 25);

  if (directorMailImportTask) {
    return { started: true, reused: true, schedule };
  }

  directorMailImportTask = cron.schedule(schedule, async () => {
    try {
      const result = await autoImportDirectorMail({
        toDate: new Date(),
        lookbackHours,
        limit,
      });
      logger.info("Director mail import run completed.", result);
    } catch (err) {
      logger.error("Director mail import run failed.", err?.message || err);
    }
  });

  logger.info("Director mail import scheduler started.", {
    schedule,
    lookbackHours,
    limit,
    timezone: process.env.TZ || "system",
  });

  return { started: true, schedule };
}

module.exports = {
  startDirectorMailImportScheduler,
};
