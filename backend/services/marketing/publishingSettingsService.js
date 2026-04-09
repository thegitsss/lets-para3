const MarketingPublishingSettings = require("../../models/MarketingPublishingSettings");
const {
  MARKETING_PUBLISHING_CADENCE_MODES,
  MARKETING_PUBLISHING_CHANNELS,
} = require("./constants");

const DEFAULT_SETTINGS = Object.freeze({
  singletonKey: "marketing_publishing",
  isEnabled: false,
  cadenceMode: "manual_only",
  timezone: "America/New_York",
  preferredHourLocal: 9,
  enabledChannels: ["linkedin_company", "facebook_page"],
  pauseReason: "",
  maxOpenCycles: 1,
});

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "system",
    userId: actor.userId || actor._id || actor.id || null,
    label: actor.label || actor.email || "System",
  };
}

function uniqueStrings(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeCadenceMode(value = "") {
  const next = String(value || "").trim();
  return MARKETING_PUBLISHING_CADENCE_MODES.includes(next) ? next : DEFAULT_SETTINGS.cadenceMode;
}

function normalizeEnabledChannels(values = []) {
  const channels = uniqueStrings(values).filter((value) => MARKETING_PUBLISHING_CHANNELS.includes(value));
  return channels.length ? channels : DEFAULT_SETTINGS.enabledChannels.slice();
}

function normalizeTimezone(value = "") {
  const timezone = String(value || "").trim();
  if (!timezone) return DEFAULT_SETTINGS.timezone;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch (_err) {
    return DEFAULT_SETTINGS.timezone;
  }
}

function normalizePreferredHourLocal(value) {
  const hour = Number(value);
  if (!Number.isFinite(hour)) return DEFAULT_SETTINGS.preferredHourLocal;
  return Math.min(23, Math.max(0, Math.round(hour)));
}

function normalizeMaxOpenCycles(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return DEFAULT_SETTINGS.maxOpenCycles;
  return Math.min(5, Math.max(1, Math.round(count)));
}

function getTimeZoneParts(date = new Date(), timeZone = DEFAULT_SETTINGS.timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = Number(part.value);
    return acc;
  }, {});
  return {
    year: Number(parts.year || 0),
    month: Number(parts.month || 1),
    day: Number(parts.day || 1),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0),
  };
}

function zonedDateTimeToUtc({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
} = {}, timeZone = DEFAULT_SETTINGS.timezone) {
  let guess = Date.UTC(year, Math.max(0, Number(month || 1) - 1), day, hour, minute, second);
  for (let index = 0; index < 4; index += 1) {
    const actual = getTimeZoneParts(new Date(guess), timeZone);
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualUtc = Date.UTC(
      actual.year,
      Math.max(0, Number(actual.month || 1) - 1),
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const diffMs = desiredUtc - actualUtc;
    if (diffMs === 0) break;
    guess += diffMs;
  }
  return new Date(guess);
}

function startOfLocalDay(date = new Date(), timeZone = DEFAULT_SETTINGS.timezone) {
  const parts = getTimeZoneParts(date, timeZone);
  return zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );
}

function addDays(date = new Date(), days = 0) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + Number(days || 0));
  return next;
}

function cadenceIntervalDays(cadenceMode = DEFAULT_SETTINGS.cadenceMode) {
  if (cadenceMode === "daily") return 1;
  if (cadenceMode === "every_2_days") return 2;
  if (cadenceMode === "every_3_days") return 3;
  return null;
}

function computeNextDueAt({
  cadenceMode = DEFAULT_SETTINGS.cadenceMode,
  timeZone = DEFAULT_SETTINGS.timezone,
  preferredHourLocal = DEFAULT_SETTINGS.preferredHourLocal,
  now = new Date(),
  lastDueAt = null,
} = {}) {
  const intervalDays = cadenceIntervalDays(cadenceMode);
  if (!intervalDays) return null;

  if (lastDueAt) {
    const next = addDays(new Date(lastDueAt), intervalDays);
    next.setUTCMinutes(0, 0, 0);
    return next;
  }

  const localDayStart = startOfLocalDay(now, timeZone);
  const currentDayDue = new Date(localDayStart);
  currentDayDue.setUTCHours(currentDayDue.getUTCHours() + Number(preferredHourLocal || 0));
  if (currentDayDue.getTime() > now.getTime()) {
    return currentDayDue;
  }
  return addDays(currentDayDue, intervalDays);
}

function serializeSettings(settings = {}) {
  return {
    id: settings._id ? String(settings._id) : "",
    isEnabled: settings.isEnabled === true,
    cadenceMode: settings.cadenceMode || DEFAULT_SETTINGS.cadenceMode,
    timezone: settings.timezone || DEFAULT_SETTINGS.timezone,
    preferredHourLocal: Number(settings.preferredHourLocal ?? DEFAULT_SETTINGS.preferredHourLocal),
    enabledChannels: normalizeEnabledChannels(settings.enabledChannels),
    pauseReason: settings.pauseReason || "",
    maxOpenCycles: Number(settings.maxOpenCycles || DEFAULT_SETTINGS.maxOpenCycles),
    nextDueAt: settings.nextDueAt || null,
    lastDueAt: settings.lastDueAt || null,
    lastCycleCreatedAt: settings.lastCycleCreatedAt || null,
    lastMissedDueAt: settings.lastMissedDueAt || null,
    updatedAt: settings.updatedAt || null,
  };
}

async function ensurePublishingSettings() {
  let settings = await MarketingPublishingSettings.findOne({ singletonKey: DEFAULT_SETTINGS.singletonKey });
  if (settings) return settings;
  settings = await MarketingPublishingSettings.create({
    ...DEFAULT_SETTINGS,
    updatedBy: { actorType: "system", label: "Publishing Settings Service" },
  });
  return settings;
}

async function getPublishingSettings() {
  const settings = await ensurePublishingSettings();
  return serializeSettings(settings.toObject ? settings.toObject() : settings);
}

async function updatePublishingSettings(payload = {}, actor = {}, options = {}) {
  const settings = await ensurePublishingSettings();
  settings.isEnabled = payload.isEnabled === true;
  settings.cadenceMode = normalizeCadenceMode(payload.cadenceMode);
  settings.timezone = normalizeTimezone(payload.timezone);
  settings.preferredHourLocal = normalizePreferredHourLocal(payload.preferredHourLocal);
  settings.enabledChannels = normalizeEnabledChannels(payload.enabledChannels);
  settings.pauseReason = String(payload.pauseReason || "").trim().slice(0, 500);
  settings.maxOpenCycles = normalizeMaxOpenCycles(payload.maxOpenCycles);
  settings.updatedBy = toActor(actor);

  const now = options.now ? new Date(options.now) : new Date();
  if (!settings.isEnabled || settings.cadenceMode === "manual_only") {
    settings.nextDueAt = null;
  } else {
    settings.nextDueAt = computeNextDueAt({
      cadenceMode: settings.cadenceMode,
      timeZone: settings.timezone,
      preferredHourLocal: settings.preferredHourLocal,
      now,
      lastDueAt: settings.lastDueAt,
    });
  }

  await settings.save();
  return serializeSettings(settings.toObject ? settings.toObject() : settings);
}

async function markPublishingDueSlotProcessed({
  dueAt = null,
  cycleCreatedAt = null,
  missedDueAt = null,
  now = new Date(),
} = {}) {
  const settings = await ensurePublishingSettings();
  const nextNow = now ? new Date(now) : new Date();
  if (dueAt) settings.lastDueAt = new Date(dueAt);
  if (cycleCreatedAt) settings.lastCycleCreatedAt = new Date(cycleCreatedAt);
  if (missedDueAt) settings.lastMissedDueAt = new Date(missedDueAt);

  if (!settings.isEnabled || settings.cadenceMode === "manual_only") {
    settings.nextDueAt = null;
  } else {
    settings.nextDueAt = computeNextDueAt({
      cadenceMode: settings.cadenceMode,
      timeZone: settings.timezone,
      preferredHourLocal: settings.preferredHourLocal,
      now: nextNow,
      lastDueAt: settings.lastDueAt,
    });
  }

  await settings.save();
  return serializeSettings(settings.toObject ? settings.toObject() : settings);
}

module.exports = {
  DEFAULT_SETTINGS,
  cadenceIntervalDays,
  computeNextDueAt,
  ensurePublishingSettings,
  getPublishingSettings,
  getTimeZoneParts,
  markPublishingDueSlotProcessed,
  serializeSettings,
  updatePublishingSettings,
};
