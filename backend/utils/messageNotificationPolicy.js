"use strict";

const DEFAULT_MESSAGE_EMAIL_SUPPRESS_MINUTES = 120;

function resolveMessageNotificationPolicy(env = process.env) {
  const parsedMinutes = Number(env.MESSAGE_EMAIL_SUPPRESS_MINUTES);
  const suppressMinutes =
    Number.isFinite(parsedMinutes) && parsedMinutes > 0 && parsedMinutes <= 24 * 60
      ? parsedMinutes
      : DEFAULT_MESSAGE_EMAIL_SUPPRESS_MINUTES;
  return {
    suppressMinutes,
    suppressMs: suppressMinutes * 60 * 1000,
  };
}

module.exports = {
  DEFAULT_MESSAGE_EMAIL_SUPPRESS_MINUTES,
  resolveMessageNotificationPolicy,
};
