const { reportOperationalFailure } = require("../utils/operationalFailure");
const mongoose = require("mongoose"), Event = require("../models/Event"), Case = require("../models/Case"), AuditLog = require("../models/AuditLog");
const { fingerprint } = require("./matterDraftRevision");
const { publishNotificationEvent } = require("../utils/notificationEvents");
const logger = require("../utils/logger").createLogger("attorney-matter-dates");
function createMatterCalendar({ access: files, role, kind, eventType = null, validateInput } = {}) {
const id = value => String(value || ""), validId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const requestIdValid = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/.test(value);
const refs = value => [new mongoose.Types.ObjectId(value), id(value)];
const fail = (status, suffix) => { throw Object.assign(new Error("The calendar entry could not be verified."), { status, publicCode: `WORKSPACE_DATE_${suffix}` }); };
const iso = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" && !(value instanceof Date) && !value._bsontype ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const revision = raw => fingerprint(stable(raw));
const fields = ["title", "start", "end", "type", "where", "notes", "isAllDay", "timezone"];
const actions = { create: "calendar.event.create", update: "calendar.event.update", delete: "calendar.event.delete", attendee: "calendar.event.attendee.add", reminder: "calendar.event.reminder.add" };
const ownerQuery = (req, doc) => ({ owner: { $in: refs(req.user.id) }, caseId: { $in: refs(doc._id) }, ...(eventType ? { type: eventType } : {}) });
// Finish the models' configured collection/index initialization before opening
// a transaction. Do not race first-use writes against their catalog changes.
async function ready() {
  let timer;
  try { await Promise.race([Promise.all([Event.init(), AuditLog.init()]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Calendar initialization is incomplete")), 8000); })]); }
  finally { clearTimeout(timer); }
}
function shape(raw) {
  return { id: id(raw._id), caseId: id(raw.caseId), revision: revision(raw), title: typeof raw.title === "string" ? raw.title : "Untitled calendar entry", start: iso(raw.start), end: iso(raw.end), isAllDay: raw.isAllDay === true, type: ["deadline", "meeting", "call", "court", "misc"].includes(raw.type) ? raw.type : "unknown", where: typeof raw.where === "string" ? raw.where : "", notes: typeof raw.notes === "string" ? raw.notes : "", timezone: typeof raw.timezone === "string" ? raw.timezone : "UTC", visibility: ["private", "case_team", "public"].includes(raw.visibility) ? raw.visibility : "unknown", rrule: typeof raw.rrule === "string" ? raw.rrule : "", source: ["user", "system"].includes(raw.source) ? raw.source : "unknown", attendees: (Array.isArray(raw.attendees) ? raw.attendees : []).map(value => ({ user: validId(id(value.user)) ? id(value.user) : null, name: typeof value.name === "string" ? value.name : "", email: typeof value.email === "string" ? value.email : "", response: ["needsAction", "accepted", "declined", "tentative"].includes(value.response) ? value.response : "unknown", role: ["attorney", "paralegal", "admin", "guest"].includes(value.role) ? value.role : "unknown", required: value.required !== false })), reminders: (Array.isArray(raw.reminders) ? raw.reminders : []).map(value => ({ minutesBefore: Number.isFinite(value.minutesBefore) ? value.minutesBefore : null, method: ["email", "push", "none"].includes(value.method) ? value.method : "unknown" })) };
}
function decodeCursor(value) {
  try {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) fail(400, "INVALID");
    const pair = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(pair) || pair.length !== 2) fail(400, "INVALID");
    const [at, key] = pair;
    if (!validId(key) || iso(at) !== at) fail(400, "INVALID");
    return { start: new Date(at), _id: new mongoose.Types.ObjectId(key) };
  } catch { fail(400, "INVALID"); }
}
const receiptId = (req, requestId) => new mongoose.Types.ObjectId(fingerprint([kind, req.user.id, requestId]).slice(0, 24));
async function receipt(req, requestId, session) {
  const raw = await AuditLog.collection.findOne({ _id: receiptId(req, requestId) }, { session, ...(session ? {} : { readConcern: { level: "majority" } }) });
  if (!raw) return null;
  if (id(raw.actor) !== id(req.user.id) || id(raw.case) !== id(req.params.caseId) || raw.actorRole !== role || raw.meta?.kind !== kind || actions[raw.meta?.operation] !== raw.action) fail(409, "REQUEST_CHANGED");
  return raw;
}
async function outcome(req, doc, saved) {
  if (!saved) return { status: "missing", event: null };
  const current = await Event.collection.findOne({ ...ownerQuery(req, doc), _id: new mongoose.Types.ObjectId(saved.targetId) });
  return { status: "recorded", action: saved.meta.operation, eventId: saved.targetId, event: current ? shape(current) : null, changedSinceSave: saved.meta.operation === "delete" ? Boolean(current) : !current || revision(current) !== saved.meta.savedRevision };
}
async function read(req) {
  const query = req.query || {};
  if (Object.keys(query).some(key => !["expectedOwnerId", "cursor", "eventId", "from", "to", "requestId"].includes(key)) || query.eventId !== undefined && !validId(query.eventId) || query.requestId !== undefined && !requestIdValid(query.requestId)) fail(400, "INVALID");
  for (const key of ["from", "to"]) if (query[key] !== undefined && iso(query[key]) !== query[key]) fail(400, "INVALID");
  if (query.from && query.to && query.from > query.to) fail(400, "INVALID");
  await files.actor(req); await ready();
  const doc = await files.matter(req), base = ownerQuery(req, doc), cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.from || query.to) base.start = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lte: new Date(query.to) } : {}) };
  const filter = cursor ? { $and: [base, { $or: [{ start: { $gt: cursor.start } }, { start: cursor.start, _id: { $gt: cursor._id } }] }] } : base;
  const [rows, total, selected, ack] = await Promise.all([
    Event.collection.find(filter).sort({ start: 1, _id: 1 }).limit(51).toArray(), Event.collection.countDocuments(base),
    query.eventId ? Event.collection.findOne({ ...ownerQuery(req, doc), _id: new mongoose.Types.ObjectId(query.eventId) }) : null,
    query.requestId ? receipt(req, query.requestId) : null,
  ]);
  const operation = query.requestId ? await outcome(req, doc, ack) : null;
  const current = await files.matter(req);
  if (files.matterRevision(current) !== files.matterRevision(doc)) fail(409, "MATTER_CHANGED");
  const items = rows.slice(0, 50), last = items.at(-1);
  if (rows.length > 50 && !iso(last.start)) fail(409, "INVALID_RECORD");
  return { caseId: id(doc._id), ownerId: id(req.user.id), revision: files.matterRevision(doc), items: items.map(shape), total, nextCursor: rows.length > 50 ? Buffer.from(JSON.stringify([iso(last.start), id(last._id)])).toString("base64url") : null, selection: !query.eventId ? "none" : selected ? "found" : "unavailable", selectedEvent: selected ? shape(selected) : null, operation };
}
function input(req) {
  const body = req.body || {}, action = body.action, values = body.values;
  if (Object.keys(body).some(key => !["expectedOwnerId", "requestId", "reviewedMatterRevision", "reviewedRevision", "eventId", "action", "values"].includes(key)) || !Object.hasOwn(actions, action || "") || !requestIdValid(body.requestId) || !/^[a-f0-9]{64}$/.test(body.reviewedMatterRevision || "") || !values || typeof values !== "object" || Array.isArray(values)) fail(400, "INVALID");
  if (action !== "create" && (!validId(body.eventId) || !/^[a-f0-9]{64}$/.test(body.reviewedRevision || ""))) fail(400, "INVALID");
  if (action === "create" && (body.eventId !== undefined || body.reviewedRevision !== undefined)) fail(400, "INVALID");
  const allowed = action === "delete" ? [] : action === "attendee" ? ["user", "name", "email", "role", "required", "response"] : action === "reminder" ? ["minutesBefore", "method"] : fields;
  if (Object.keys(values).some(key => !allowed.includes(key))) fail(400, "INVALID");
  if (["create", "update"].includes(action)) {
    for (const [key, max] of [["title", 500], ["where", 2000], ["notes", 20000]]) if (values[key] !== undefined && (typeof values[key] !== "string" || values[key].length > max || key === "title" && !values[key].trim())) fail(400, "INVALID");
    if (values.isAllDay !== undefined && typeof values.isAllDay !== "boolean") fail(400, "INVALID");
    for (const key of ["start", "end"]) if (values[key] !== undefined && (key !== "end" || values[key] !== null) && iso(values[key]) !== values[key]) fail(400, "INVALID");
    if (values.timezone !== undefined) { try { if (typeof values.timezone !== "string" || values.timezone.length > 100) fail(400, "INVALID"); new Intl.DateTimeFormat("en-US", { timeZone: values.timezone }); } catch { fail(400, "INVALID_TIMEZONE"); } }
    if (action === "create" && (!values.title || !values.start)) fail(400, "INVALID");
  }
  if (action === "attendee") {
    for (const [key, max] of [["name", 300], ["email", 320]]) if (values[key] !== undefined && (typeof values[key] !== "string" || values[key].length > max)) fail(400, "INVALID");
    if (values.required !== undefined && typeof values.required !== "boolean") fail(400, "INVALID");
    if (!values.name?.trim() && !values.email?.trim() && !validId(values.user)) fail(400, "INVALID");
  }
  if (action === "attendee" && (values.email !== undefined && (typeof values.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) || values.user !== undefined && !validId(values.user))) fail(400, "INVALID");
  if (action === "reminder" && values.minutesBefore !== undefined && (!Number.isSafeInteger(values.minutesBefore) || values.minutesBefore < 0 || values.minutesBefore > 20160)) fail(400, "INVALID");
  return { body, action, values, fingerprint: fingerprint(stable([action, body.eventId || null, values])) };
}
async function save(req) {
  const data = input(req); validateInput?.(data); await files.actor(req); await ready();
  const initial = await files.matter(req), existing = await receipt(req, data.body.requestId);
  if (existing) { if (existing.meta.fingerprint !== data.fingerprint) fail(409, "REQUEST_CHANGED"); const result = await outcome(req, initial, existing); await files.matter(req); return { operation: result }; }
  if (files.matterRevision(initial) !== data.body.reviewedMatterRevision) fail(409, "MATTER_CHANGED");
  const session = await mongoose.startSession(); let saved, doc, stage = "read";
  try {
    session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    doc = await files.matter(req, session);
    if (files.lock) await files.lock(req, session);
    if (files.matterRevision(doc) !== data.body.reviewedMatterRevision) fail(409, "MATTER_CHANGED");
    const raw = data.action === "create" ? null : await Event.collection.findOne({ ...ownerQuery(req, doc), _id: new mongoose.Types.ObjectId(data.body.eventId) }, { session });
    if (data.action !== "create" && (!raw || revision(raw) !== data.body.reviewedRevision)) fail(409, "CHANGED");
    const now = new Date(); let next;
    if (data.action !== "delete") {
      const changes = ["create", "update"].includes(data.action) ? { ...data.values } : {};
      if (changes.end === null) changes.end = changes.start || raw?.start;
      const prepared = new Event(raw ? { ...raw, ...changes } : { ...changes, caseId: doc._id, owner: req.user.id, visibility: "private" });
      if (data.action === "attendee") prepared.addAttendee(data.values);
      if (data.action === "reminder") prepared.addReminder(data.values.minutesBefore, data.values.method);
      try { await prepared.validate(); } catch { fail(400, "INVALID"); }
      const clean = prepared.toObject();
      if (raw && data.action === "attendee") clean.attendees = [...(raw.attendees || []), ...clean.attendees.slice((raw.attendees || []).length)];
      if (raw && data.action === "reminder") clean.reminders = [...(raw.reminders || []), ...clean.reminders.slice((raw.reminders || []).length)];
      if (!raw) { stage = "event_create"; next = { ...clean, createdAt: now, updatedAt: now }; await Event.collection.insertOne(next, { session }); }
      else {
        const keys = data.action === "attendee" ? ["attendees"] : data.action === "reminder" ? ["reminders"] : Object.keys(changes);
        const change = { ...Object.fromEntries(keys.map(key => [key, clean[key]])), updatedAt: now };
        stage = "event_update"; const result = await Event.collection.updateOne(files.exact(raw, Object.keys(raw)), { $set: change }, { session });
        if (result.matchedCount !== 1) fail(409, "CHANGED"); next = { ...raw, ...change };
      }
    } else {
      stage = "event_delete"; const result = await Event.collection.deleteOne(files.exact(raw, Object.keys(raw)), { session }); if (result.deletedCount !== 1) fail(409, "CHANGED");
    }
    stage = "case_guard"; const guarded = await Case.collection.updateOne(files.exact(doc, files.matterFields), { $inc: { __v: 1 }, $set: { updatedAt: now } }, { session });
    if (guarded.matchedCount !== 1) fail(409, "MATTER_CHANGED");
    const entry = { _id: receiptId(req, data.body.requestId), actor: req.user.id, actorRole: role, action: actions[data.action], targetType: "event", targetId: id(raw?._id || next._id), case: doc._id, method: req.method, path: req.originalUrl?.split("?")[0], meta: { kind, operation: data.action, fingerprint: data.fingerprint, savedRevision: next ? revision(next) : null } };
    stage = "audit_record"; const [audit] = await AuditLog.create([entry], { session });
    await files.actor(req); stage = "commit"; await session.commitTransaction(); saved = audit.toObject();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.attorneyMatterDates.transaction_abort"));
    if (error.publicCode) throw error;
    logger.warn("Calendar transaction did not confirm", { stage, code: error.code, name: error.name, codeName: error.codeName, catalogChange: /catalog/i.test(error.message || ""), labels: error.errorLabels });
    if (error.code === 112 || error.code === 11000 || error.hasErrorLabel?.("TransientTransactionError")) fail(409, "CHANGED");
    fail(503, "UNCONFIRMED");
  } finally { await session.endSession(); }
  publishNotificationEvent(req.user.id, "notifications", { at: new Date().toISOString(), type: `calendar_event_${data.action === "create" ? "created" : data.action === "delete" ? "deleted" : "updated"}_refresh` });
  const operation = await outcome(req, doc, saved); await files.matter(req); return { operation };
}
const sendError = (res, error) => res.status(error.status || 503).json({ code: error.publicCode || "WORKSPACE_DATE_UNAVAILABLE", error: "The calendar entry could not be confirmed. Check its saved status before trying again." });
return { read, save, sendError, revision };
}
module.exports = { createMatterCalendar };
