const {
  DEFAULT_BUSINESS_TIME_ZONE,
  dateOnlyFromZonedInstant,
  dateOnlyToUtcDate,
  normalizeDateOnly,
} = require("./businessDate");

const AVAILABILITY_STATUSES = new Set(["available", "unavailable"]);

function parseAvailabilityUpdate(
  input = {},
  {
    now = new Date(),
    timeZone = process.env.BUSINESS_TIME_ZONE || DEFAULT_BUSINESS_TIME_ZONE,
  } = {}
) {
  const status = String(input?.status || "").trim().toLowerCase();
  if (!AVAILABILITY_STATUSES.has(status)) {
    return { error: "Status must be available or unavailable." };
  }

  const suppliedDate = input?.nextAvailable;
  const hasDate = suppliedDate !== null && suppliedDate !== undefined && String(suppliedDate).trim() !== "";
  if (status === "available") {
    if (hasDate) return { error: "Next available date must be empty when status is available." };
    return { status, nextAvailableDate: "", nextAvailable: null };
  }

  if (!hasDate) return { status, nextAvailableDate: "", nextAvailable: null };
  const nextAvailableDate = normalizeDateOnly(suppliedDate);
  if (!nextAvailableDate) return { error: "Next available date must be a valid calendar date." };
  const today = dateOnlyFromZonedInstant(now, timeZone);
  if (!today || nextAvailableDate < today) {
    return { error: "Next available date cannot be in the past." };
  }
  return {
    status,
    nextAvailableDate,
    nextAvailable: dateOnlyToUtcDate(nextAvailableDate),
  };
}

function effectiveAvailability(user = {}, { now = new Date(), timeZone = process.env.BUSINESS_TIME_ZONE || DEFAULT_BUSINESS_TIME_ZONE } = {}) {
  const details = user.availabilityDetails?.toObject?.() || user.availabilityDetails || {};
  const date = normalizeDateOnly(details.nextAvailable);
  const today = dateOnlyFromZonedInstant(now, timeZone);
  const returned = Boolean(date && today && date <= today);
  const unavailable = !returned && (details.status === "unavailable" || /^unavailable/i.test(String(user.availability || "")));
  return {
    availability: unavailable ? /^unavailable/i.test(String(user.availability || "")) ? user.availability : "Unavailable" : "Available now",
    availabilityDetails: { ...details, status: unavailable ? "unavailable" : "available", nextAvailable: unavailable ? details.nextAvailable || null : null },
  };
}

function buildEffectiveAvailableClause({ now = new Date(), timeZone = process.env.BUSINESS_TIME_ZONE || DEFAULT_BUSINESS_TIME_ZONE } = {}) {
  const today = dateOnlyToUtcDate(dateOnlyFromZonedInstant(now, timeZone));
  return { $or: [
    { "availabilityDetails.nextAvailable": { $type: "date", $lte: today } },
    { $and: [{ "availabilityDetails.status": { $ne: "unavailable" } }, { availability: { $not: /^unavailable/i } }] },
  ] };
}

module.exports = { AVAILABILITY_STATUSES, parseAvailabilityUpdate, effectiveAvailability, buildEffectiveAvailableClause };
