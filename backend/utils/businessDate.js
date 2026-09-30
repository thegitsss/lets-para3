const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_BUSINESS_TIME_ZONE = "America/New_York";

function parseDateOnlyParts(value) {
  const match = DATE_ONLY_PATTERN.exec(String(value || "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function normalizeDateOnly(value) {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const candidate = text.slice(0, 10);
  return parseDateOnlyParts(candidate) ? candidate : "";
}

function dateOnlyToUtcDate(value) {
  const dateOnly = normalizeDateOnly(value);
  return dateOnly ? new Date(`${dateOnly}T00:00:00.000Z`) : null;
}

function dateOnlyFromZonedInstant(value = new Date(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const candidate = `${map.year}-${map.month}-${map.day}`;
    return normalizeDateOnly(candidate);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

function addCalendarDays(value, days) {
  const parts = parseDateOnlyParts(normalizeDateOnly(value));
  if (!parts || !Number.isInteger(days)) return "";
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return next.toISOString().slice(0, 10);
}

function startOfWeekDateOnly(value, weekStartsOn = 1) {
  const dateOnly = normalizeDateOnly(value);
  const startDay = Number(weekStartsOn);
  if (!dateOnly || !Number.isInteger(startDay) || startDay < 0 || startDay > 6) return "";
  const date = dateOnlyToUtcDate(dateOnly);
  const offset = (date.getUTCDay() - startDay + 7) % 7;
  return addCalendarDays(dateOnly, -offset);
}

function endOfWeekDateOnly(value, weekStartsOn = 1) {
  const start = startOfWeekDateOnly(value, weekStartsOn);
  return start ? addCalendarDays(start, 6) : "";
}

function formatDateOnly(value, locale = "en-US", options = {}) {
  const dateOnly = normalizeDateOnly(value);
  if (!dateOnly) return "";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(dateOnlyToUtcDate(dateOnly));
}

function resolveMatterDeadlineDate(matter = {}) {
  return normalizeDateOnly(matter?.deadlineDate || matter?.deadline);
}

function parseMatterDeadline(
  value,
  {
    now = new Date(),
    timeZone = process.env.BUSINESS_TIME_ZONE || DEFAULT_BUSINESS_TIME_ZONE,
    maxFutureDays = 365,
  } = {}
) {
  const dateOnly = normalizeDateOnly(value);
  if (!dateOnly) return null;
  const today = dateOnlyFromZonedInstant(now, timeZone);
  const maxDate = addCalendarDays(today, maxFutureDays);
  if (!today || !maxDate || dateOnly < today || dateOnly > maxDate) return null;
  return {
    dateOnly,
    legacyDate: dateOnlyToUtcDate(dateOnly),
  };
}

module.exports = {
  DATE_ONLY_PATTERN,
  DEFAULT_BUSINESS_TIME_ZONE,
  addCalendarDays,
  dateOnlyFromZonedInstant,
  dateOnlyToUtcDate,
  endOfWeekDateOnly,
  formatDateOnly,
  normalizeDateOnly,
  parseDateOnlyParts,
  parseMatterDeadline,
  resolveMatterDeadlineDate,
  startOfWeekDateOnly,
};
