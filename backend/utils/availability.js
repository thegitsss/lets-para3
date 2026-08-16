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

module.exports = { AVAILABILITY_STATUSES, parseAvailabilityUpdate };
