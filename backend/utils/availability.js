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

  const fromSupplied = input?.unavailableFrom;
  const from = fromSupplied ? normalizeDateOnly(fromSupplied) : "";
  const todayDate = dateOnlyFromZonedInstant(now, timeZone);
  if (fromSupplied && (!from || from < todayDate)) return {error:"Unavailable-from date must be today or a future calendar date."};
  if (status === "available" && fromSupplied) return {error:"Unavailable-from date must be empty when status is available."};
  const suppliedDate = input?.nextAvailable;
  const hasDate = suppliedDate !== null && suppliedDate !== undefined && String(suppliedDate).trim() !== "";
  if (status === "available") {
    if (hasDate) return { error: "Next available date must be empty when status is available." };
    return { status, nextAvailableDate: "", nextAvailable: null };
  }

  if (!hasDate) return from && from > todayDate ? {error:"Choose an available-again date for scheduled unavailability."} : { status, nextAvailableDate: "", nextAvailable: null };
  const nextAvailableDate = normalizeDateOnly(suppliedDate);
  if (!nextAvailableDate) return { error: "Next available date must be a valid calendar date." };
  const today = dateOnlyFromZonedInstant(now, timeZone);
  if (!today || nextAvailableDate < today) {
    return { error: "Next available date cannot be in the past." };
  }
  if (from && nextAvailableDate <= from) return {error:"Available-again date must be after the unavailable-from date."};
  if (from && from > todayDate) return {status:"available",nextAvailableDate:"",nextAvailable:null,scheduled:{from:dateOnlyToUtcDate(from),nextAvailable:dateOnlyToUtcDate(nextAvailableDate)}};
  return {
    status,
    nextAvailableDate,
    nextAvailable: dateOnlyToUtcDate(nextAvailableDate),
  };
}

function effectiveAvailability(user = {}, { now = new Date(), timeZone = process.env.BUSINESS_TIME_ZONE || DEFAULT_BUSINESS_TIME_ZONE } = {}) {
  const details = user.availabilityDetails?.toObject?.() || user.availabilityDetails || {};
  const scheduledFrom=normalizeDateOnly(details.scheduled?.from), scheduledEnd=normalizeDateOnly(details.scheduled?.nextAvailable);
  const currentDay=dateOnlyFromZonedInstant(now,timeZone);
  if (scheduledFrom && scheduledEnd && scheduledFrom < scheduledEnd) {
    const active=currentDay >= scheduledFrom && currentDay < scheduledEnd;
    return {availability:active?"Unavailable":"Available now",availabilityDetails:{...details,status:active?"unavailable":"available",nextAvailable:active?details.scheduled.nextAvailable:null,...(currentDay>=scheduledEnd?{scheduled:null}:{})}};
  }
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
  return { $and:[{ $nor:[{ "availabilityDetails.scheduled.from":{$lte:today}, "availabilityDetails.scheduled.nextAvailable":{$gt:today} }] },{ $or: [
    { "availabilityDetails.nextAvailable": { $type: "date", $lte: today } },
    { $and: [{ "availabilityDetails.status": { $ne: "unavailable" } }, { availability: { $not: /^unavailable/i } }] },
  ] }] };
}

module.exports = { AVAILABILITY_STATUSES, parseAvailabilityUpdate, effectiveAvailability, buildEffectiveAvailableClause };
