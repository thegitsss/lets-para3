import { objectId } from "./workspace-model.mjs";
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validIso = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const dateTypes = { deadline: "Deadline", meeting: "Meeting", call: "Call", court: "Court date", misc: "Other date" };
export function readCalendarEntry(value, caseId) {
  if (!objectId(value?.id) || value.caseId !== caseId || !digest(value.revision) || typeof value.title !== "string" || typeof value.isAllDay !== "boolean" || value.start !== null && !validIso(value.start) || value.end !== null && !validIso(value.end) || ![...Object.keys(dateTypes), "unknown"].includes(value.type) || ["where", "notes", "timezone", "rrule"].some(key => typeof value[key] !== "string") || !Array.isArray(value.attendees) || !Array.isArray(value.reminders)) throw new Error("invalid_calendar_entry");
  if (value.attendees.some(entry => !entry || ["name", "email", "response", "role"].some(key => typeof entry[key] !== "string") || typeof entry.required !== "boolean") || value.reminders.some(entry => !entry || typeof entry.method !== "string" || entry.minutesBefore !== null && !Number.isFinite(entry.minutesBefore))) throw new Error("invalid_calendar_details");
  return value;
}
export function readDateOperation(value, caseId) {
  if (!value || !["missing", "recorded"].includes(value.status) || value.event !== null && !value.event) throw new Error("invalid_calendar_operation");
  if (value.status === "missing" && value.event !== null || value.status === "recorded" && (!objectId(value.eventId) || !["create", "update", "delete", "attendee", "reminder"].includes(value.action) || typeof value.changedSinceSave !== "boolean")) throw new Error("invalid_calendar_operation");
  if (value.event && readCalendarEntry(value.event, caseId).id !== value.eventId) throw new Error("invalid_calendar_operation");
  return value;
}
export function readDates(value, caseId, ownerId) {
  if (value?.caseId !== caseId || value.ownerId !== ownerId || !digest(value.revision) || !Array.isArray(value.items) || value.items.length > 50 || !Number.isSafeInteger(value.total) || value.total < 0 || value.nextCursor !== null && (typeof value.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.nextCursor)) || !["none", "found", "unavailable"].includes(value.selection)) throw new Error("invalid_calendar_review");
  const ids = new Set(); for (const item of value.items) { readCalendarEntry(item, caseId); if (ids.has(item.id)) throw new Error("repeated_calendar_entry"); ids.add(item.id); }
  if (value.selection === "found") readCalendarEntry(value.selectedEvent, caseId); else if (value.selectedEvent !== null) throw new Error("invalid_calendar_selection");
  if (value.operation !== null) readDateOperation(value.operation, caseId);
  return value;
}
export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(Date.parse(`${value}T12:00:00.000Z`)) && new Date(`${value}T12:00:00.000Z`).toISOString().slice(0, 10) === value;
}
export function wallParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}`, second: values.second };
}
// Enumerate real instants rather than silently normalizing a skipped or repeated
// wall-clock time. Sampling both sides also covers half-hour DST changes.
export function wallInstants(date, time, timezone) {
  if (!validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) return [];
  const target = Date.parse(`${date}T${time}:00.000Z`), offsets = new Set();
  try {
    for (let hours = -48; hours <= 48; hours += 6) {
      const sample = target + hours * 3600000, part = wallParts(sample, timezone);
      offsets.add(Date.parse(`${part.date}T${part.time}:${part.second}.000Z`) - sample);
    }
    return [...offsets].map(offset => target - offset).filter(instant => { const part = wallParts(instant, timezone); return part.date === date && part.time === time && part.second === "00"; }).sort((a, b) => a - b).map(instant => new Date(instant).toISOString());
  } catch { return []; }
}
export function occurrenceLabel(instant, timezone) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "longOffset" }).format(new Date(instant));
}
export function dateFields(entry) {
  const timezone = entry?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", allDay = entry?.isAllDay ?? true;
  const parts = instant => {
    if (!instant) return { date: "", time: "" };
    if (allDay) return { date: instant.slice(0, 10), time: "" };
    try { return wallParts(instant, timezone); } catch { return wallParts(instant, "UTC"); }
  };
  const start = parts(entry?.start), end = parts(entry?.end);
  return { title: entry?.title || "", type: entry?.type || "misc", where: entry?.where || "", notes: entry?.notes || "", isAllDay: allDay, timezone, startDate: start.date, startTime: start.time, endDate: end.date, endTime: end.time, startOccurrence: entry?.start || "", endOccurrence: entry?.end || "" };
}
export function dateChanges(fields, original) {
  const baseline = dateFields(original), changes = {};
  for (const key of ["title", "type", "where", "notes", "isAllDay", "timezone"]) if (!original || fields[key] !== baseline[key]) changes[key] = fields[key];
  if (!fields.title.trim()) throw new Error("Enter a title for this calendar entry.");
  const changedTime = prefix => !original || ["isAllDay", "timezone", `${prefix}Date`, `${prefix}Time`, `${prefix}Occurrence`].some(key => fields[key] !== baseline[key]);
  if (changedTime("start") || changedTime("end")) {
    function instant(prefix) {
      const date = fields[`${prefix}Date`], time = fields[`${prefix}Time`];
      if (prefix === "end" && !date && !time) return null;
      if (!validDate(date)) throw new Error(`Enter a valid ${prefix} date.`);
      if (fields.isAllDay) return `${date}T12:00:00.000Z`;
      const options = wallInstants(date, time, fields.timezone);
      if (!options.length) throw new Error(`The ${prefix} time does not exist in the selected time zone. Check the date, time and time zone.`);
      if (options.length === 1) return options[0];
      const chosen = fields[`${prefix}Occurrence`]; if (!options.includes(chosen)) throw new Error(`The ${prefix} time occurs twice. Choose which occurrence you mean.`); return chosen;
    }
    const start = changedTime("start") ? instant("start") : original.start, end = changedTime("end") ? instant("end") : original.end;
    if (end && end < start) throw new Error("The end must be on or after the start.");
    if (changedTime("start")) changes.start = start;
    if (changedTime("end")) changes.end = end;
  }
  return changes;
}
export function calendarLabel(entry) {
  if (!entry.start) return "Date not recorded";
  if (entry.isAllDay) {
    const start = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(entry.start));
    const end = entry.end && entry.end.slice(0, 10) !== entry.start.slice(0, 10) ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(entry.end)) : null;
    return `${start}${end ? ` – ${end}` : ""} · All day`;
  }
  try { return new Intl.DateTimeFormat("en-US", { timeZone: entry.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.start)) + ` · ${entry.timezone}`; }
  catch { return `${new Date(entry.start).toISOString()} · Recorded time zone unavailable`; }
}
