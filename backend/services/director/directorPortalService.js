const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../../utils/logger");
const runtimeLogger = createRuntimeLogger("services:director:directorPortalService");
const mongoose = require("mongoose");
const { randomUUID, createHash } = require("crypto");
const { lockActiveAccounts } = require("../../utils/activeAccountWrite");
const { isDefiniteSmtpFailure } = require("../../utils/smtpDeliveryOutcome");

const Case = require("../../models/Case");
const DirectorOutreachEvent = require("../../models/DirectorOutreachEvent");
const DirectorOutreachRecord = require("../../models/DirectorOutreachRecord");
const DirectorProfile = require("../../models/DirectorProfile");
const User = require("../../models/User");
const AuditLog = require("../../models/AuditLog");
const { COMMISSION_CAP } = require("./commissionCap");
const commissionEvidence = require("./commissionEvidence");
const manualImportAuthority = require("./manualImportAuthority");
const sendEmail = require("../../utils/email");
const {
  directorStageLabel,
  buildDirectorFollowUpHtml,
  buildDirectorFollowUpText,
  DIRECTOR_FOLLOW_UP_SUBJECT,
  DIRECTOR_OUTREACH_SUBJECT,
  DIRECTOR_STAGE_LABELS,
  US_STATE_CODES,
} = require("./constants");
const { fetchZohoMessages, mapInboxMessage, mapSentMessage, normalizeEmail } = require("./mailImportService");

function normalizeState(value = "") {
  const state = String(value || "").trim().toUpperCase();
  return US_STATE_CODES.includes(state) ? state : "";
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfRecentImportWindow(hours = 36) {
  const date = new Date();
  date.setTime(date.getTime() - Math.max(1, Number(hours) || 36) * 60 * 60 * 1000);
  return date;
}

function startOfUtcDay(value = new Date()) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date;
}

function dateKey(value) {
  if (!value) return "";
  return startOfUtcDay(value).toISOString().slice(0, 10);
}

function buildDateBuckets({ days = 14, now = new Date() } = {}) {
  const count = Math.min(90, Math.max(1, Number(days) || 14));
  const end = startOfUtcDay(now);
  const start = addUtcDays(end, -(count - 1));
  const buckets = [];
  for (let i = 0; i < count; i += 1) {
    const date = addUtcDays(start, i);
    buckets.push({
      date,
      dateKey: date.toISOString().slice(0, 10),
      emailsSent: 0,
      registrations: 0,
      followUps: 0,
      replies: 0,
      mattersPosted: 0,
      mattersCompleted: 0,
      commissionableMatters: 0,
    });
  }
  return { start, end: addUtcDays(end, 1), buckets };
}

function normalizeRangeDays(value, fallback = 7) {
  const numeric = Number(value);
  if ([1, 7, 30].includes(numeric)) return numeric;
  return fallback;
}

function buildRecordDateRangeFilter(days) {
  const normalizedDays = normalizeRangeDays(days, 7);
  const { start, end } = buildDateBuckets({ days: normalizedDays });
  return {
    range: {
      days: normalizedDays,
      start,
      end,
    },
    filter: {
      $or: [
        { firstOutreachSentAt: { $gte: start, $lt: end } },
        { followUpSentAt: { $gte: start, $lt: end } },
        { lastReplyAt: { $gte: start, $lt: end } },
        { registeredAt: { $gte: start, $lt: end } },
        { firstMatterPostedAt: { $gte: start, $lt: end } },
        { firstMatterCompletedAt: { $gte: start, $lt: end } },
      ],
    },
  };
}

function serializeProfile(profile = {}) {
  return {
    id: profile._id ? String(profile._id) : "",
    userId: profile.userId ? String(profile.userId) : "",
    email: profile.email || "",
    zohoEmail: profile.zohoEmail || "",
    displayName: profile.displayName || "",
    activeState: profile.activeState || "TX",
    status: profile.status || "active",
    outreachSubject: profile.outreachSubject || DIRECTOR_OUTREACH_SUBJECT,
    outreachConfigured: Boolean(String(profile.outreachTemplateText || profile.outreachTemplateHtml || "").trim()),
    commissionCapMatterCount: COMMISSION_CAP,
    commissionSharePctOfAttorneyFee: profile.commissionSharePctOfAttorneyFee || 50,
  };
}

function escapeHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initialDirectorProfile(user = {}) {
  const email = normalizeEmail(user.email);
  return { userId: user.id || user._id, email, zohoEmail: email,
    displayName: String(user.email || "").split("@")[0] || "Director",
    activeState: "TX", outreachSubject: DIRECTOR_OUTREACH_SUBJECT };
}

async function ensureDirectorProfile(user = {}, { session = null } = {}) {
  const email = normalizeEmail(user.email);
  if (!user.id && !user._id) throw new Error("Director user is required.");
  let profile = await DirectorProfile.findOne({ userId: user.id || user._id }).session(session);
  if (profile) return profile;
  try {
    profile = await DirectorProfile.findOneAndUpdate({ userId: user.id || user._id }, { $setOnInsert: {
      userId: user.id || user._id, email, zohoEmail: email,
      displayName: String(user.email || "").split("@")[0] || "Director",
      activeState: "TX", outreachSubject: DIRECTOR_OUTREACH_SUBJECT,
    } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, session });
  } catch (error) {
    // Another initial request may have inserted the same unique user profile.
    // Do not hide unrelated write failures or overwrite that profile's settings.
    if (error.code !== 11000 || session) throw error;
    profile = await DirectorProfile.findOne({ userId: user.id || user._id });
    if (!profile) throw error;
  }
  return profile;
}

async function getProfileForRequest(user = {}) {
  if (String(user.role || "").toLowerCase() !== "director") return null;
  return ensureDirectorProfile(user);
}

async function updateDirectorProfile(user = {}, payload = {}, { session = null } = {}) {
  const profile = await ensureDirectorProfile(user, { session });
  const activeState = normalizeState(payload.activeState);
  if (activeState) profile.activeState = activeState;
  if (typeof payload.displayName === "string") profile.displayName = payload.displayName.trim().slice(0, 160);
  if (session) await profile.save({ session });
  else await profile.save();
  return profile;
}

async function upsertRecordFromImport({ profile, item, state = "", session = null, committedEvents = null } = {}) {
  const attorneyEmail = normalizeEmail(item.attorneyEmail);
  if (!attorneyEmail) return null;
  const existingOtherDirectorRecord = await DirectorOutreachRecord.findOne({
    attorneyEmail,
    directorUserId: { $ne: profile.userId },
    stage: { $ne: "suppressed" },
  }).session(session).lean();
  if (existingOtherDirectorRecord) return null;

  const eventType = item.eventType;
  if (eventType === "reply_received") {
    const existingDirectorRecord = await DirectorOutreachRecord.findOne({
      directorUserId: profile.userId,
      attorneyEmail,
      stage: { $ne: "suppressed" },
    })
      .select("_id")
      .session(session)
      .lean();
    if (!existingDirectorRecord) return null;
  }
  const assignedState = normalizeState(state);
  // An existing provider event is an idempotent manual no-op. Catching a
  // duplicate-key error would leave the transaction aborted and unusable.
  if (session && item.providerMessageId) {
    const existing = await DirectorOutreachEvent.findOne({ directorUserId: profile.userId,
      providerMessageId: item.providerMessageId, eventType }).session(session).lean();
    if (existing) return DirectorOutreachRecord.findOne({ _id: existing.recordId,
      directorUserId: profile.userId, attorneyEmail }).session(session);
  }
  const update = {
    $setOnInsert: {
      directorUserId: profile.userId,
      directorEmail: profile.email,
      attorneyEmail,
      attorneyName: item.attorneyName || "",
      source: "zoho_import",
    },
    $set: {
      updatedAt: new Date(),
    },
  };
  if (assignedState) update.$setOnInsert.state = assignedState;

  if (item.attorneyName) update.$setOnInsert.attorneyName = item.attorneyName;
  if (eventType === "outreach_sent") {
    update.$set.firstOutreachSentAt = item.occurredAt || new Date();
    update.$set.lastOutboundAt = item.occurredAt || new Date();
    update.$set.stage = "outreach_sent";
  } else if (eventType === "follow_up_sent") {
    update.$set.followUpSentAt = item.occurredAt || new Date();
    update.$set.lastOutboundAt = item.occurredAt || new Date();
    update.$set.stage = "follow_up_sent";
  } else if (eventType === "reply_received") {
    update.$set.lastReplyAt = item.occurredAt || new Date();
    update.$set.founderAttentionAt = item.occurredAt || new Date();
    update.$set.stage = "founder_attention";
  }

  const record = await DirectorOutreachRecord.findOneAndUpdate(
    { directorUserId: profile.userId, attorneyEmail },
    update,
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true, session }
  );

  let eventCreated = false;
  try {
    const event = {
      recordId: record._id,
      directorUserId: profile.userId,
      directorEmail: profile.email,
      attorneyEmail,
      eventType,
      subject: item.subject || "",
      summary: item.summary || "",
      providerMessageId: item.providerMessageId || "",
      providerThreadId: item.providerThreadId || "",
      occurredAt: item.occurredAt || new Date(),
      metadata: item.metadata || {},
    };
    if (session) await DirectorOutreachEvent.create([event], { session });
    else await DirectorOutreachEvent.create(event);
    eventCreated = true;
  } catch (err) {
    if (err?.code !== 11000 || session) throw err;
  }

  if (eventCreated && committedEvents) committedEvents.push({ record, item });
  if (eventCreated && eventType === "reply_received" && !committedEvents) {
    await notifyFounderOfReply({ record, item }).catch((err) => {
      runtimeLogger.warn("[director] founder reply notification failed", err?.message || err);
    });
  }

  return record;
}

function textToHtml(text = "") {
  return String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function renderOutreachTemplate(template = "", attorneyName = "") {
  const name = String(attorneyName || "").trim();
  return String(template || "")
    .replace(/\{\{\s*attorneyName\s*\}\}/gi, name)
    .replace(/\{\{\s*name\s*\}\}/gi, name);
}

function validationError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function envKeyForEmail(email = "") {
  const local = String(email || "").split("@")[0] || "";
  return local.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function getDirectorSmtpConfig(profile = {}) {
  const key = envKeyForEmail(profile.zohoEmail || profile.email);
  const user =
    process.env[`DIRECTOR_SMTP_${key}_USER`] ||
    process.env.DIRECTOR_SMTP_USER ||
    (process.env[`DIRECTOR_SMTP_${key}_PASS`] ? profile.zohoEmail || profile.email : "");
  const pass = process.env[`DIRECTOR_SMTP_${key}_PASS`] || process.env.DIRECTOR_SMTP_PASS || "";
  if (!user || !pass) {
    throw validationError(
      `Director SMTP is not configured for ${profile.zohoEmail || profile.email}. Add that mailbox's Zoho SMTP app password before sending.`,
      409
    );
  }
  return {
    host: process.env[`DIRECTOR_SMTP_${key}_HOST`] || process.env.DIRECTOR_SMTP_HOST || process.env.SMTP_HOST,
    port: process.env[`DIRECTOR_SMTP_${key}_PORT`] || process.env.DIRECTOR_SMTP_PORT || process.env.SMTP_PORT || 587,
    secure: process.env[`DIRECTOR_SMTP_${key}_SECURE`] || process.env.DIRECTOR_SMTP_SECURE || process.env.SMTP_SECURE,
    user,
    pass,
  };
}

function directorFrom(profile = {}) {
  const email = profile.zohoEmail || profile.email;
  const name = profile.displayName || "Let's-ParaConnect";
  return `"${String(name).replace(/"/g, "")}" <${email}>`;
}

async function sendDirectorEmail(profile = {}, to, subject, html, opts = {}) {
  const smtp = getDirectorSmtpConfig(profile);
  return sendEmail(to, subject, html, {
    ...opts,
    smtp,
    from: directorFrom(profile),
    replyTo: profile.zohoEmail || profile.email,
  });
}

async function sendDirectorOutreach({ user = {}, attorneyName = "", attorneyEmail = "", state = "", manualRequest = null } = {}) {
  let authorizationId = null;
  const prepare = async (session = null, currentUser = user) => {
    const profile = await ensureDirectorProfile(currentUser, { session });
    if (profile.status !== "active") throw validationError("Director outreach is paused for this account.", 403);
  
    const normalizedName = String(attorneyName || "").trim().slice(0, 240);
    const normalizedEmail = normalizeEmail(attorneyEmail);
    const normalizedState = normalizeState(state);
  
    if (!normalizedName) throw validationError("Attorney name is required.");
    if (!normalizedEmail) throw validationError("Attorney email is required.");
    if (!normalizedState) throw validationError("Attorney state is required.");
  
    const templateText = String(profile.outreachTemplateText || "").trim();
    const templateHtml = String(profile.outreachTemplateHtml || "").trim();
    if (!templateText && !templateHtml) {
      throw validationError("Director outreach template is not configured yet. Add the locked template before sending.", 409);
    }
  
    const existing = await DirectorOutreachRecord.findOne({
      attorneyEmail: normalizedEmail,
      firstOutreachSentAt: { $ne: null },
    }).session(session).lean();
    if (existing) {
      const sameDirector = String(existing.directorUserId || "") === String(profile.userId || "");
      throw validationError(
        sameDirector
          ? "This attorney has already been contacted by this director."
          : "This attorney is already assigned to another director.",
        409
      );
    }
  
    const subject = String(profile.outreachSubject || DIRECTOR_OUTREACH_SUBJECT).trim() || DIRECTOR_OUTREACH_SUBJECT;
    const text = templateText
      ? renderOutreachTemplate(templateText, normalizedName)
      : renderOutreachTemplate(templateHtml, normalizedName).replace(/<br\s*\/?>/gi, "\n").replace(/<\/?[^>]+>/g, "");
    const html = templateHtml ? renderOutreachTemplate(templateHtml, normalizedName) : textToHtml(text);

    if (manualRequest && session) {
      // Serialize the exact locked profile/template used for this send. This
      // short authorization transaction ends before the mail transport begins.
      const locked = await DirectorProfile.collection.updateOne({
        _id: profile._id, status: "active", updatedAt: profile.updatedAt,
      }, { $inc: { __v: 1 } }, { session });
      if (locked.modifiedCount !== 1) throw validationError("The Director profile changed. Review it before sending.", 409);
      const intentId = randomUUID();
      const payloadSha256 = createHash("sha256").update(JSON.stringify({
        recipient: normalizedEmail, attorneyName: normalizedName, state: normalizedState,
        subject, text, html, from: directorFrom(profile), replyTo: profile.zohoEmail || profile.email,
      })).digest("hex");
      const authorization = await AuditLog.logFromReq(manualRequest, "director.outreach.authorized", {
        targetType: "other", targetId: intentId, session,
        meta: { intentId, directorProfileId: String(profile._id),
          profileUpdatedAt: profile.updatedAt, recipient: normalizedEmail,
          attorneyState: normalizedState, payloadSha256 },
      });
      authorizationId = String(authorization._id);
    }
    return { profile, normalizedName, normalizedEmail, normalizedState, subject, text, html };
  };
  const prepared = manualRequest
    ? await manualImportAuthority.write(manualRequest, prepare)
    : await prepare();
  const { profile, normalizedName, normalizedEmail, normalizedState, subject, text, html } = prepared;
  const now = new Date();

  const info = await sendDirectorEmail(profile, normalizedEmail, subject, html, {
    text,
    throwOnError: true,
    messageIdPrefix: `director-outreach.${String(profile._id)}`,
  });

  const record = await DirectorOutreachRecord.findOneAndUpdate(
    { directorUserId: profile.userId, attorneyEmail: normalizedEmail },
    {
      $setOnInsert: {
        directorUserId: profile.userId,
        directorEmail: profile.email,
        attorneyEmail: normalizedEmail,
        source: "portal_send",
      },
      $set: {
        attorneyName: normalizedName,
        state: normalizedState,
        firstOutreachSentAt: now,
        lastOutboundAt: now,
        stage: "outreach_sent",
        updatedAt: now,
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );

  try {
    await DirectorOutreachEvent.create({
      recordId: record._id,
      directorUserId: profile.userId,
      directorEmail: profile.email,
      attorneyEmail: normalizedEmail,
      eventType: "outreach_sent",
      subject,
      summary: "Initial outreach sent from Director Portal.",
      provider: "smtp",
      providerMessageId: info?.messageId || "",
      occurredAt: now,
      metadata: {
        portalSend: true,
        state: normalizedState,
        ...(authorizationId ? { authorizationId } : {}),
      },
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }

  return {
    record,
    profile,
  };
}

async function notifyFounderOfReply({ record, item } = {}) {
  const founderEmail = String(process.env.FOUNDER_EMAIL || "samantha@lets-paraconnect.com").trim();
  if (!founderEmail) return;
  const attorneyLine = `${record.attorneyName || "Attorney"} <${record.attorneyEmail}>`;
  const html = `
    <p>An attorney replied to a Director of Attorney Relations outreach email.</p>
    <p><strong>Attorney:</strong> ${escapeHtml(attorneyLine)}</p>
    <p><strong>Director:</strong> ${escapeHtml(record.directorEmail)}</p>
    <p><strong>Subject:</strong> ${escapeHtml(item.subject || "")}</p>
    <p><strong>Received:</strong> ${escapeHtml((item.occurredAt || new Date()).toISOString())}</p>
    ${item.summary ? `<p><strong>Preview:</strong> ${escapeHtml(item.summary)}</p>` : ""}
    <p>Please review the reply in Zoho and respond as Founder if appropriate.</p>
  `;
  await sendEmail(founderEmail, "Attorney replied to outreach", html, {
    text: `Attorney replied to outreach.\nAttorney: ${attorneyLine}\nDirector: ${record.directorEmail}\nSubject: ${item.subject || ""}`,
    messageIdPrefix: "director-reply",
  });
}

async function updateDirectorZohoSyncStatus(profile, payload = {}, { session = null } = {}) {
  if (!profile?._id) return null;
  return DirectorProfile.findByIdAndUpdate(
    profile._id,
    {
      $set: {
        zohoLastSyncAt: payload.syncedAt || new Date(),
        zohoLastSyncStatus: payload.status || "success",
        zohoLastSyncSummary: String(payload.summary || "").slice(0, 1000),
        zohoLastSyncError: String(payload.error || "").slice(0, 1000),
      },
    },
    { returnDocument: "after", session }
  );
}

function verifyImportMailbox(before, current) {
  if (String(before.userId) !== String(current.userId) || before.email !== current.email ||
      before.zohoEmail !== current.zohoEmail || before.status !== current.status) {
    throw Object.assign(new Error("The mailbox settings changed. Refresh and review before syncing again."), { statusCode: 409, publicCode: "DIRECTOR_IMPORT_CHANGED" });
  }
}

async function importDirectorMailManually({ user, req, state, folderKind, fromDate, toDate, recordSyncStatus }) {
  await manualImportAuthority.verify(req);
  // No profile initialization is persisted before an awaited mailbox read.
  const before = await DirectorProfile.findOne({ userId: user.id || user._id }) || new DirectorProfile(initialDirectorProfile(user));
  let messages, items;
  const failureStatus = async () => manualImportAuthority.write(req, async (session, actor) => {
    const profile = await ensureDirectorProfile(actor, { session });
    verifyImportMailbox(before, profile);
    if (recordSyncStatus) await updateDirectorZohoSyncStatus(profile, { status: "failed",
      summary: folderKind === "sent" ? "Sent mail import failed." : "Inbox import failed.",
      error: "Mailbox import did not complete. Review the saved records before syncing again." }, { session });
  });
  try {
    messages = await fetchZohoMessages({ profile: before, folderKind, fromDate, toDate });
    if (!Array.isArray(messages)) throw new Error("Mailbox response was not a message list");
    items = folderKind === "sent" ? messages.flatMap(message => mapSentMessage(message, before)).filter(Boolean) : messages.map(message => mapInboxMessage(message, before)).filter(Boolean);
  } catch (_error) {
    await failureStatus();
    throw validationError("Mailbox import failed. Refresh and review saved records before syncing again.", 502);
  }
  let accepted;
  try {
    accepted = await manualImportAuthority.write(req, async (session, actor) => {
      const profile = await ensureDirectorProfile(actor, { session }), committedEvents = [];
      verifyImportMailbox(before, profile);
      for (const item of items) await upsertRecordFromImport({ profile, item, state, session, committedEvents });
      await refreshDirectorRecords({ directorUserId: profile.userId, session });
      if (recordSyncStatus) await updateDirectorZohoSyncStatus(profile, { status: "success",
        summary: `${folderKind === "sent" ? "Sent mail" : "Inbox"} scanned: ${messages.length}. ${folderKind === "sent" ? "Outreach records" : "Replies"} imported: ${committedEvents.length}.` }, { session });
      return { profile, committedEvents };
    });
  } catch (error) {
    // Authority loss, a changed source or an unknown commit is never rewritten
    // as a definite failed import, and never retried by this writer.
    if (error.status === 403 || error.statusCode === 403 || error.status === 409 || error.statusCode === 409 || error.publicCode === "ACCOUNT_WRITE_UNCONFIRMED") throw error;
    await failureStatus();
    throw validationError("Mailbox import failed. Refresh and review saved records before syncing again.", 502);
  }
  accepted.profile.$session(null);
  for (const receipt of accepted.committedEvents) receipt.record.$session(null);
  // These existing notices describe committed new reply events only. They
  // cannot escape a rolled-back import or repeat an existing provider event.
  for (const receipt of accepted.committedEvents) if (receipt.item.eventType === "reply_received") {
    try { await manualImportAuthority.verify(req); }
    catch (error) { throw manualImportAuthority.savedReview(error); }
    await notifyFounderOfReply(receipt).catch(error => runtimeLogger.warn("[director] founder reply notification failed", error?.message || error));
  }
  return { imported: accepted.committedEvents.length, scanned: messages.length, profile: serializeProfile(accepted.profile) };
}

async function importDirectorSentMail({
  user = {},
  state = "",
  fromDate = startOfRecentImportWindow(),
  toDate = new Date(),
  recordSyncStatus = true,
  manualRequest = null,
} = {}) {
  if (manualRequest) return importDirectorMailManually({ user, req: manualRequest, state, folderKind: "sent", fromDate, toDate, recordSyncStatus });
  const profile = await ensureDirectorProfile(user);
  try {
    const messages = await fetchZohoMessages({ profile, folderKind: "sent", fromDate, toDate });
    const items = messages.flatMap((message) => mapSentMessage(message, profile)).filter(Boolean);
    const records = [];
    for (const item of items) {
      const record = await upsertRecordFromImport({ profile, item, state });
      if (record) records.push(record);
    }
    await refreshDirectorRecords({ directorUserId: profile.userId });
    if (recordSyncStatus) {
      await updateDirectorZohoSyncStatus(profile, {
        status: "success",
        summary: `Sent mail scanned: ${messages.length}. Outreach records imported: ${records.length}.`,
      });
    }
    return {
      imported: records.length,
      scanned: messages.length,
      profile: serializeProfile(profile),
    };
  } catch (err) {
    if (recordSyncStatus) {
      await updateDirectorZohoSyncStatus(profile, {
        status: "failed",
        summary: "Sent mail import failed.",
        error: err?.message || String(err),
      }).catch(logPromiseFailure(runtimeLogger, "[director] sent-mail failure status persistence failed"));
    }
    throw err;
  }
}

async function importDirectorInboxReplies({
  user = {},
  fromDate = startOfToday(),
  toDate = new Date(),
  recordSyncStatus = true,
  manualRequest = null,
} = {}) {
  if (manualRequest) return importDirectorMailManually({ user, req: manualRequest, folderKind: "inbox", fromDate, toDate, recordSyncStatus });
  const profile = await ensureDirectorProfile(user);
  try {
    const messages = await fetchZohoMessages({ profile, folderKind: "inbox", fromDate, toDate });
    const items = messages.map((message) => mapInboxMessage(message, profile)).filter(Boolean);
    const records = [];
    for (const item of items) {
      const record = await upsertRecordFromImport({ profile, item });
      if (record) records.push(record);
    }
    await refreshDirectorRecords({ directorUserId: profile.userId });
    if (recordSyncStatus) {
      await updateDirectorZohoSyncStatus(profile, {
        status: "success",
        summary: `Inbox scanned: ${messages.length}. Replies imported: ${records.length}.`,
      });
    }
    return {
      imported: records.length,
      scanned: messages.length,
      profile: serializeProfile(profile),
    };
  } catch (err) {
    if (recordSyncStatus) {
      await updateDirectorZohoSyncStatus(profile, {
        status: "failed",
        summary: "Inbox import failed.",
        error: err?.message || String(err),
      }).catch(logPromiseFailure(runtimeLogger, "[director] inbox failure status persistence failed"));
    }
    throw err;
  }
}

async function autoImportDirectorMail({
  directorUserId = null,
  fromDate = null,
  toDate = new Date(),
  lookbackHours = 24,
  limit = 25,
} = {}) {
  const normalizedLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const startDate =
    fromDate ||
    new Date(new Date(toDate).getTime() - Math.max(1, Number(lookbackHours) || 24) * 60 * 60 * 1000);
  const userFilter = {
    role: "director",
    status: "approved",
  };
  if (directorUserId) userFilter._id = directorUserId;

  const directors = await User.find(userFilter)
    .select("_id email firstName lastName role status")
    .sort({ createdAt: 1 })
    .limit(normalizedLimit)
    .lean();

  const result = {
    scannedDirectors: directors.length,
    sentImported: 0,
    sentScanned: 0,
    repliesImported: 0,
    repliesScanned: 0,
    refreshed: 0,
    failed: 0,
    failures: [],
  };

  for (const director of directors) {
    const user = { ...director, id: director._id };
    const profile = await ensureDirectorProfile(user);
    try {
      const sent = await importDirectorSentMail({ user, fromDate: startDate, toDate, recordSyncStatus: false });
      const replies = await importDirectorInboxReplies({ user, fromDate: startDate, toDate, recordSyncStatus: false });
      result.sentImported += sent.imported || 0;
      result.sentScanned += sent.scanned || 0;
      result.repliesImported += replies.imported || 0;
      result.repliesScanned += replies.scanned || 0;
      result.refreshed += 1;
      await updateDirectorZohoSyncStatus(profile, {
        status: "success",
        summary: `Auto-sync scanned ${sent.scanned || 0} sent and ${replies.scanned || 0} inbox messages. Imported ${sent.imported || 0} outreach records and ${replies.imported || 0} replies.`,
      });
    } catch (err) {
      result.failed += 1;
      result.failures.push({
        directorUserId: String(director._id),
        directorEmail: director.email || "",
        reason: err?.message || String(err),
      });
      await updateDirectorZohoSyncStatus(profile, {
        status: "failed",
        summary: "Auto-sync failed.",
        error: err?.message || String(err),
      }).catch(logPromiseFailure(runtimeLogger, "[director] auto-sync failure status persistence failed"));
    }
  }

  return result;
}

async function refreshDirectorRecords({ directorUserId = null, deferVerify = false, session = null } = {}) {
  const filter = directorUserId ? { directorUserId } : {};
  const records = await DirectorOutreachRecord.find(filter).session(session);

  const emails = records.map((record) => record.attorneyEmail).filter(Boolean);
  const users = await User.find({ $or: [{ email: { $in: emails } }, { _id: { $in: records.map(record => record.registeredUserId).filter(Boolean) } }], role: "attorney" })
    .select("_id email createdAt approvedAt status state location")
    .session(session)
    .lean();
  const userByEmail = new Map(users.map((user) => [String(user.email || "").toLowerCase(), user]));
  const userById = new Map(users.map(user => [String(user._id), user]));
  const registeredUser = record => record.registeredUserId ? userById.get(String(record.registeredUserId)) : userByEmail.get(String(record.attorneyEmail || "").toLowerCase());
  const attorneyIds = [...new Set([...users.map(user => String(user._id)), ...records.map(record => record.registeredUserId ? String(record.registeredUserId) : "").filter(Boolean)])];
  const cases = attorneyIds.length
    ? await Case.find({ $or: [{ attorney: { $in: attorneyIds } }, { attorneyId: { $in: attorneyIds } }] })
        .select("_id attorney attorneyId status createdAt completedAt payoutFinalizedAt payoutTransferId feeAttorneyAmount feeAttorneyPct lockedTotalAmount totalAmount")
        .session(session)
        .lean()
    : [];
  const casesByAttorney = new Map();
  cases.forEach((caseDoc) => {
    const key = String(caseDoc.attorney || caseDoc.attorneyId || "");
    const bucket = casesByAttorney.get(key) || [];
    bucket.push(caseDoc);
    casesByAttorney.set(key, bucket);
  });
  // Bind a registration before taking the financial source snapshot. An email
  // change must not switch a retained referral to a different account.
  for (const record of records) {
    const user = registeredUser(record);
    if (user && !record.registeredUserId) {
      const bound = await DirectorOutreachRecord.updateOne({ _id: record._id, registeredUserId: null }, { $set: { registeredUserId: user._id } }, { session });
      if (!bound.matchedCount) {
        const current = await DirectorOutreachRecord.collection.findOne({ _id: record._id }, { projection: { registeredUserId: 1 }, session });
        if (String(current?.registeredUserId || "") !== String(user._id)) throw Object.assign(new Error("The referred account changed. Refresh to continue."), { statusCode: 409 });
      }
      record.registeredUserId = user._id;
    }
  }
  await commissionEvidence.retainLegacyClaims({ directorUserId, session });
  const financial = await commissionEvidence.read({ directorUserId, session });
  const isCompleted = caseDoc => Boolean(caseDoc.completedAt || caseDoc.payoutFinalizedAt || caseDoc.payoutTransferId || ["completed", "closed"].includes(String(caseDoc.status || "").toLowerCase()));
  let updated = 0;
  for (const record of records) {
    const user = registeredUser(record) || null;
    const userCases = user ? casesByAttorney.get(String(user._id)) || [] : [];
    const postedCase = userCases.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
    const completedCases = userCases.filter(isCompleted);
    const projection = financial.records.get(String(record._id));
    if (!projection) throw Object.assign(new Error("Commission records changed. Refresh to continue."), { statusCode: 409 });
    let nextStage = record.stage;
    if (record.stage === "suppressed") {
      nextStage = "suppressed";
    } else if (record.stage === "follow_up_failed") {
      nextStage = "follow_up_failed";
    } else if (record.founderAttentionAt) {
      nextStage = "founder_attention";
    } else if (projection.commissionState === "recorded" && projection.commissionableMatterCount > 0) {
      nextStage = "commission_complete";
    } else if (completedCases.length > 0) {
      nextStage = "matter_completed";
    } else if (postedCase) {
      nextStage = "matter_posted";
    } else if (user) {
      const registeredAt = user.createdAt || record.registeredAt || new Date();
      const followUpDueAt = new Date(new Date(registeredAt).getTime() + 8 * 24 * 60 * 60 * 1000);
      if (record.followUpSentAt) {
        nextStage = "follow_up_sent";
      } else {
        nextStage = followUpDueAt <= new Date() ? "follow_up_needed" : "attorney_registered";
      }
    } else if (record.firstOutreachSentAt) {
      nextStage = "outreach_sent";
    }

    record.registeredUserId = user?._id || record.registeredUserId || null;
    record.registeredAt = user?.createdAt || record.registeredAt || null;
    record.state = user ? normalizeState(user.state) || normalizeState(user.location) || record.state || "" : record.state || "";
    record.firstMatterPostedAt = postedCase?.createdAt || record.firstMatterPostedAt || null;
    record.firstMatterCompletedAt =
      completedCases[0]?.completedAt || completedCases[0]?.payoutFinalizedAt || record.firstMatterCompletedAt || null;
    for (const key of ["commissionableMatterCount", "commissionEarnedCents", "commissionStatus", "commissionState", "commissionCurrency", "commissionStripeMode", "commissionCurrencies", "commissionReviewCount"]) record.set(key, projection[key]);
    record.commissionEvidenceVersion = 1;
    record.stage = nextStage;
    await record.save({ session });
    updated += 1;
  }

  if (!deferVerify) await financial.verify();
  return { updated, commissionAllocation: financial.allocation.byRecord, commissionTotals: financial.allocation.totals, financial };
}

const FOLLOW_UP_REVIEW = 'Delivery could not be confirmed. Samantha must check the provider before another attempt.';
const FOLLOW_UP_FAILED = 'The intended recipient did not accept this follow-up. Samantha must review before another attempt.';
const activeFollowUpUser = (user, role) => user && user.role === role && user.status === 'approved' && user.emailVerified && !user.disabled && !user.deleted && !user.suspended;
const recipientMatches = (values, recipient) => Array.isArray(values) && values.some(value => normalizeEmail(value?.address || value) === recipient);

async function followUpParticipants(record, session = null) {
  const profile = await DirectorProfile.findOne({ userId: record.directorUserId, status: 'active' }).session(session).lean();
  const director = await User.findById(record.directorUserId).session(session).lean();
  const attorney = await User.findById(record.registeredUserId).session(session).lean();
  if (!profile || !activeFollowUpUser(director, 'director') || !activeFollowUpUser(attorney, 'attorney') || normalizeEmail(attorney.email) !== normalizeEmail(record.attorneyEmail)) return null;
  return { profile, director, attorney };
}

// Acceptance is durable before event history is written. Repairs never send mail
// and must match the exact accepted claim, not merely an existing message ID.
async function retainFollowUpEvent(record, now) {
  const intent = record.metadata?.automaticFollowUp;
  if (intent?.status !== 'accepted' || intent.eventRecorded || !record.followUpSentAt || (intent.eventAttempts || 0) >= 3 || intent.nextEventAttemptAt && new Date(intent.nextEventAttemptAt) > now) return;
  const match = { _id: record._id, 'metadata.automaticFollowUp.claimId': intent.claimId, 'metadata.automaticFollowUp.status': 'accepted', 'metadata.automaticFollowUp.eventRecorded': false, 'metadata.automaticFollowUp.eventAttempts': intent.eventAttempts || 0 };
  const reserved = await DirectorOutreachRecord.updateOne(match, { $inc: { 'metadata.automaticFollowUp.eventAttempts': 1 }, $set: { 'metadata.automaticFollowUp.nextEventAttemptAt': new Date(now.getTime() + 60000) } });
  if (!reserved.modifiedCount) return;
  const event = {
    recordId: record._id, directorUserId: record.directorUserId, directorEmail: intent.directorEmail,
    attorneyEmail: intent.recipient, eventType: 'follow_up_sent', subject: DIRECTOR_FOLLOW_UP_SUBJECT,
    summary: 'Automatic 8-day follow-up accepted by the mail transport for the intended attorney.',
    provider: 'smtp', providerMessageId: `auto-follow-up:${record._id}`, occurredAt: new Date(intent.acceptedAt),
    metadata: { automated: true, dueAt: new Date(intent.dueAt), claimId: intent.claimId },
  };
  let recorded = false;
  try {
    await DirectorOutreachEvent.create(event); recorded = true;
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await DirectorOutreachEvent.findOne({ directorUserId: record.directorUserId, providerMessageId: event.providerMessageId, eventType: 'follow_up_sent' }).lean();
      recorded = Boolean(existing && String(existing.recordId) === String(record._id) && existing.metadata?.claimId === intent.claimId && normalizeEmail(existing.attorneyEmail) === intent.recipient && new Date(existing.occurredAt).getTime() === new Date(intent.acceptedAt).getTime());
    }
  }
  await DirectorOutreachRecord.updateOne({ _id: record._id, 'metadata.automaticFollowUp.claimId': intent.claimId, 'metadata.automaticFollowUp.status': 'accepted' }, { $set: { 'metadata.automaticFollowUp.eventRecorded': recorded, 'metadata.automaticFollowUp.eventFailure': recorded ? '' : 'Accepted email history needs repair. No additional email will be sent.' } });
}

async function sendAutomaticFollowUp({ record, profile, now = new Date() } = {}) {
  if (!record || !profile) return { sent: false, reason: 'missing_record_or_profile' };
  const dueAt = new Date(new Date(record.registeredAt).getTime() + 8 * 86400000);
  if (record.followUpSentAt || record.metadata?.automaticFollowUp || ['follow_up_failed', 'suppressed'].includes(record.stage) || record.founderAttentionAt || record.firstMatterPostedAt || !record.registeredAt || dueAt > now) return { sent: false, reason: 'not_eligible' };
  const claimId = randomUUID(), session = await mongoose.startSession(); let claim, participants;
  try {
    await session.withTransaction(async () => {
      claim = null; participants = null;
      const current = await DirectorOutreachRecord.findById(record._id).session(session).lean();
      if (!current || current.metadata?.automaticFollowUp || current.followUpSentAt || current.firstMatterPostedAt || current.founderAttentionAt || ['follow_up_failed', 'suppressed'].includes(current.stage) || String(current.registeredUserId || '') !== String(record.registeredUserId || '') || normalizeEmail(current.attorneyEmail) !== normalizeEmail(record.attorneyEmail) || new Date(current.registeredAt).getTime() !== new Date(record.registeredAt).getTime()) return;
      participants = await followUpParticipants(current, session); if (!participants) return;
      await lockActiveAccounts([current.directorUserId, current.registeredUserId], session);
      // Serialize the claim against an owner pause of this existing profile.
      const activeProfile = await DirectorProfile.collection.updateOne({ _id: participants.profile._id, status: 'active', updatedAt: participants.profile.updatedAt }, { $inc: { __v: 1 } }, { session });
      if (!activeProfile.modifiedCount) throw new Error('The Director profile changed.');
      claim = await DirectorOutreachRecord.findOneAndUpdate({ _id: current._id, updatedAt: current.updatedAt, 'metadata.automaticFollowUp': { $exists: false }, followUpSentAt: null }, { $set: { 'metadata.automaticFollowUp': { claimId, status: 'sending', claimedAt: now, dueAt, recipient: normalizeEmail(current.attorneyEmail), directorEmail: current.directorEmail, eventRecorded: false, eventAttempts: 0 } } }, { session, returnDocument: 'after' });
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 });
  } finally { await session.endSession(); }
  if (!claim) return { sent: false, reason: 'not_claimed' };

  let status = 'unknown', attempted = false;
  const claimMatch = { _id: claim._id, 'metadata.automaticFollowUp.claimId': claimId };
  try {
    const current = await DirectorOutreachRecord.findById(claim._id).lean();
    const currentParticipants = current && await followUpParticipants(current);
    if (!currentParticipants || current.metadata?.automaticFollowUp?.claimId !== claimId || current.metadata.automaticFollowUp.status !== 'sending' || current.followUpSentAt || current.firstMatterPostedAt || current.founderAttentionAt || ['suppressed', 'follow_up_failed'].includes(current.stage) || String(current.registeredUserId) !== String(claim.registeredUserId) || normalizeEmail(current.attorneyEmail) !== normalizeEmail(claim.attorneyEmail) || new Date(current.registeredAt).getTime() !== new Date(claim.registeredAt).getTime()) status = 'skipped';
    else {
      attempted = true;
      const result = await sendDirectorEmail(currentParticipants.profile, claim.attorneyEmail, DIRECTOR_FOLLOW_UP_SUBJECT, buildDirectorFollowUpHtml(claim.attorneyName || 'there'), { text: buildDirectorFollowUpText(claim.attorneyName || 'there'), throwOnError: true, messageIdPrefix: `director-follow-up.${claim._id}` });
      const recipient = normalizeEmail(claim.attorneyEmail);
      status = result?.disabled ? 'disabled' : recipientMatches(result?.accepted, recipient) && !recipientMatches(result?.rejected, recipient) ? 'accepted' : recipientMatches(result?.rejected, recipient) ? 'failed' : 'unknown';
    }
  } catch (error) { status = isDefiniteSmtpFailure(error, attempted) ? 'failed' : 'unknown'; }
  const failure = status === 'accepted' ? '' : status === 'unknown' ? FOLLOW_UP_REVIEW : status === 'skipped' ? 'The account, profile or record changed. Samantha must review before another attempt.' : FOLLOW_UP_FAILED;
  const changes = { 'metadata.automaticFollowUp.status': status, 'metadata.automaticFollowUp.failure': failure };
  if (status === 'accepted') Object.assign(changes, { followUpSentAt: now, lastOutboundAt: now, 'metadata.automaticFollowUp.acceptedAt': now });
  else Object.assign(changes, { 'metadata.lastFollowUpError': failure, 'metadata.lastFollowUpFailedAt': now });
  // A late known acceptance may clarify an abandoned same-claim attempt. It
  // cannot replace another intent or overwrite current owner/source fields.
  const completed = await DirectorOutreachRecord.findOneAndUpdate({ ...claimMatch, 'metadata.automaticFollowUp.status': { $in: status === 'accepted' ? ['sending', 'unknown'] : ['sending'] } }, { $set: changes }, { returnDocument: 'after' });
  if (!completed) return { sent: false, reason: 'claim_changed' };
  await DirectorOutreachRecord.updateOne({ ...claimMatch, stage: { $nin: ['suppressed', 'founder_attention', 'matter_posted', 'matter_completed', 'commission_complete'] }, founderAttentionAt: null, firstMatterPostedAt: null }, { $set: { stage: status === 'accepted' ? 'follow_up_sent' : 'follow_up_failed' } });
  if (status === 'accepted') await retainFollowUpEvent(completed.toObject(), now);
  return { sent: status === 'accepted', failed: status !== 'accepted', reason: failure, recordId: String(claim._id) };
}

async function processAutomaticDirectorFollowUps({ directorUserId = null, now = new Date(), limit = 25 } = {}) {
  now = new Date(now); const scope = directorUserId ? { directorUserId } : {};
  // Recovery also runs while paused: it records uncertainty, never another send.
  const abandoned = await DirectorOutreachRecord.find({ ...scope, 'metadata.automaticFollowUp.status': 'sending', 'metadata.automaticFollowUp.claimedAt': { $lt: new Date(now.getTime() - 10 * 60000) } }).limit(Math.min(100, Math.max(1, Number(limit) || 25))).lean();
  for (const row of abandoned) {
    const match = { _id: row._id, 'metadata.automaticFollowUp.claimId': row.metadata.automaticFollowUp.claimId, 'metadata.automaticFollowUp.status': 'sending' };
    await DirectorOutreachRecord.updateOne(match, { $set: { 'metadata.automaticFollowUp.status': 'unknown', 'metadata.automaticFollowUp.failure': FOLLOW_UP_REVIEW, 'metadata.lastFollowUpError': FOLLOW_UP_REVIEW, 'metadata.lastFollowUpFailedAt': now } });
    await DirectorOutreachRecord.updateOne({ ...match, 'metadata.automaticFollowUp.status': 'unknown', stage: { $nin: ['suppressed', 'founder_attention', 'matter_posted', 'matter_completed', 'commission_complete'] }, founderAttentionAt: null, firstMatterPostedAt: null }, { $set: { stage: 'follow_up_failed' } });
  }
  const repairs = await DirectorOutreachRecord.find({ ...scope, 'metadata.automaticFollowUp.status': 'accepted', 'metadata.automaticFollowUp.eventRecorded': false, 'metadata.automaticFollowUp.eventAttempts': { $lt: 3 } }).limit(Math.min(100, Math.max(1, Number(limit) || 25))).lean();
  for (const row of repairs) await retainFollowUpEvent(row, now);
  await refreshDirectorRecords({ directorUserId });
  const records = await DirectorOutreachRecord.find({ ...scope, followUpSentAt: null, firstMatterPostedAt: null, founderAttentionAt: null, stage: { $nin: ['follow_up_failed', 'suppressed'] }, 'metadata.automaticFollowUp': { $exists: false }, registeredAt: { $ne: null, $lte: new Date(now.getTime() - 8 * 86400000) } }).sort({ registeredAt: 1, updatedAt: 1 }).limit(Math.min(100, Math.max(1, Number(limit) || 25)));
  let sent = 0, failed = 0; const failures = [];
  for (const record of records) {
    let profile = await DirectorProfile.findOne({ userId: record.directorUserId }).lean();
    if (!profile) {
      const director = await User.findById(record.directorUserId).lean();
      if (activeFollowUpUser(director, 'director')) profile = (await ensureDirectorProfile({ ...director, id: director._id })).toObject();
    }
    try {
      const result = await sendAutomaticFollowUp({ record, profile, now });
      if (result.sent) sent++;
      if (result.failed) { failed++; failures.push({ recordId: String(record._id), reason: result.reason }); }
    } catch (_error) { failed++; failures.push({ recordId: String(record._id), reason: 'The follow-up state could not be confirmed. Refresh and review before another attempt.' }); }
  }
  return { scanned: records.length, sent, failed, failures };
}

function serializeRecord(record = {}) {
  return {
    id: String(record._id),
    directorUserId: String(record.directorUserId || ""),
    directorEmail: record.directorEmail || "",
    attorneyEmail: record.attorneyEmail || "",
    attorneyName: record.attorneyName || "",
    firmName: record.firmName || "",
    state: record.state || "",
    stage: record.stage || "",
    stageLabel: directorStageLabel(record),
    firstOutreachSentAt: record.firstOutreachSentAt || null,
    followUpSentAt: record.followUpSentAt || null,
    lastReplyAt: record.lastReplyAt || null,
    founderAttentionAt: record.founderAttentionAt || null,
    registeredAt: record.registeredAt || null,
    firstMatterPostedAt: record.firstMatterPostedAt || null,
    firstMatterCompletedAt: record.firstMatterCompletedAt || null,
    commissionableMatterCount: record.commissionableMatterCount ?? null,
    commissionEarnedCents: record.commissionEarnedCents ?? null,
    commissionState: record.commissionState || "needs_review",
    commissionCurrency: record.commissionCurrency || null,
    commissionStripeMode: record.commissionStripeMode || null,
    commissionCurrencies: record.commissionCurrencies || [],
    commissionReviewCount: record.commissionReviewCount || 0,
    commissionStatus: record.commissionStatus || "none",
    commissionPayoutStatus: record.commissionPayoutStatus || "unpaid",
    commissionPayments: require('./commissionPayments').present(record.commissionPayments),
    commissionPaidAt: record.commissionPaidAt || null,
    updatedAt: record.updatedAt || null,
  };
}

async function listDirectorRecords({ user = {}, state = "", stage = "", rangeDays = 7, limit = 100 } = {}) {
  const role = String(user.role || "").toLowerCase();
  const filter = {};
  if (role === "director") {
    filter.directorUserId = new mongoose.Types.ObjectId(user.id || user._id);
  }
  const range = buildRecordDateRangeFilter(rangeDays);
  Object.assign(filter, range.filter);
  const normalizedState = normalizeState(state);
  if (normalizedState) filter.state = normalizedState;
  if (stage) filter.stage = stage;

  const refreshed = await refreshDirectorRecords({ directorUserId: role === "director" ? user.id || user._id : null, deferVerify: true });
  const records = await DirectorOutreachRecord.find(filter)
    .sort({ founderAttentionAt: -1, updatedAt: -1 })
    .limit(Math.min(250, Math.max(1, Number(limit) || 100)))
    .lean();
  await refreshed.financial.verify();
  return records.map(record => serializeRecord(commissionEvidence.attach(record, refreshed.financial)));
}

async function updateDirectorRecordState({ user = {}, recordId = "", state = "", session = null } = {}) {
  if (String(user.role || "").toLowerCase() !== "director") {
    const error = new Error("Only director accounts can update outreach record state.");
    error.statusCode = 403;
    throw error;
  }
  if (!mongoose.Types.ObjectId.isValid(recordId)) {
    const error = new Error("Invalid outreach record.");
    error.statusCode = 400;
    throw error;
  }
  const normalizedState = normalizeState(state);
  if (!normalizedState) {
    const error = new Error("Choose a valid attorney state.");
    error.statusCode = 400;
    throw error;
  }
  const record = await DirectorOutreachRecord.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(recordId),
      directorUserId: new mongoose.Types.ObjectId(user.id || user._id),
    },
    { $set: { state: normalizedState, updatedAt: new Date() } },
    { returnDocument: "after", ...(session ? { session } : {}) }
  ).lean();
  if (!record) {
    const error = new Error("Outreach record not found.");
    error.statusCode = 404;
    throw error;
  }
  return serializeRecord(record);
}

async function getDirectorOverview({ user = {}, rangeDays = 7 } = {}) {
  const profile = String(user.role || "").toLowerCase() === "director" ? await ensureDirectorProfile(user) : null;
  const filter = profile ? { directorUserId: profile.userId } : {};
  const range = buildRecordDateRangeFilter(rangeDays);
  Object.assign(filter, range.filter);
  const refreshed = await refreshDirectorRecords({ directorUserId: profile?.userId || null, deferVerify: true });
  const records = (await DirectorOutreachRecord.find(filter).lean()).map(record => commissionEvidence.attach(record, refreshed.financial));
  const counts = records.reduce(
    (acc, record) => {
      acc.total += 1;
      acc[record.stage] = (acc[record.stage] || 0) + 1;
      if (record.state) acc.byState[record.state] = (acc.byState[record.state] || 0) + 1;
      acc.commissionEarnedCents += Number(record.commissionEarnedCents || 0);
      acc.commissionableMatterCount += Number(record.commissionableMatterCount || 0);
      return acc;
    },
    { total: 0, byState: {}, commissionEarnedCents: 0, commissionableMatterCount: 0 }
  );
  Object.assign(counts, commissionEvidence.summarize(records));
  const lifetime = commissionEvidence.summarize([...refreshed.financial.records.values()]);
  await refreshed.financial.verify();
  const lastSyncedAt = records.reduce((latest, record) => {
    const values = [
      record.updatedAt,
      record.firstOutreachSentAt,
      record.followUpSentAt,
      record.lastReplyAt,
      record.registeredAt,
      record.firstMatterPostedAt,
      record.firstMatterCompletedAt,
    ]
      .map((value) => (value ? new Date(value).getTime() : 0))
      .filter(Boolean);
    const newest = values.length ? Math.max(...values) : 0;
    return newest > latest ? newest : latest;
  }, 0);
  const attention = {
    founderReplies: records.filter((record) => record.stage === "founder_attention").length,
    followUpsAutoSent: records.filter((record) => record.stage === "follow_up_sent" || record.followUpSentAt).length,
    followUpsFailed: records.filter((record) => record.stage === "follow_up_failed").length,
    commissionableRecords: records.filter((record) => Number(record.commissionableMatterCount || 0) > 0).length,
  };
  return {
    profile: profile ? serializeProfile(profile) : null,
    counts,
    commissionLifetime: {
      ...lifetime,
      commissionCapMatterCount: COMMISSION_CAP,
      remainingMatterCount: profile && lifetime.commissionState !== "needs_review" ? Math.max(0, COMMISSION_CAP - lifetime.commissionableMatterCount) : null,
    },
    attention,
    lastSyncedAt: lastSyncedAt ? new Date(lastSyncedAt) : null,
    range: {
      days: range.range.days,
      start: range.range.start,
      end: range.range.end,
    },
    stageLabels: DIRECTOR_STAGE_LABELS,
  };
}

async function getDirectorAnalytics({ user = {}, days = 14 } = {}) {
  const role = String(user.role || "").toLowerCase();
  const profile = role === "director" ? await ensureDirectorProfile(user) : null;
  const filter = profile ? { directorUserId: profile.userId } : {};
  const refreshed = await refreshDirectorRecords({ directorUserId: profile?.userId || null, deferVerify: true });

  const { start, end, buckets } = buildDateBuckets({ days });
  const bucketByKey = new Map(buckets.map((bucket) => [bucket.dateKey, bucket]));
  const records = await DirectorOutreachRecord.find({
    ...filter,
    $or: [
      { firstOutreachSentAt: { $gte: start, $lt: end } },
      { followUpSentAt: { $gte: start, $lt: end } },
      { lastReplyAt: { $gte: start, $lt: end } },
      { registeredAt: { $gte: start, $lt: end } },
      { firstMatterPostedAt: { $gte: start, $lt: end } },
      { firstMatterCompletedAt: { $gte: start, $lt: end } },
    ],
  }).lean();

  const increment = (value, field, amount = 1) => {
    const bucket = bucketByKey.get(dateKey(value));
    if (bucket) bucket[field] += amount;
  };

  records.forEach((record) => {
    increment(record.firstOutreachSentAt, "emailsSent");
    increment(record.followUpSentAt, "followUps");
    increment(record.lastReplyAt, "replies");
    increment(record.registeredAt, "registrations");
    increment(record.firstMatterPostedAt, "mattersPosted");
    increment(record.firstMatterCompletedAt, "mattersCompleted");
  });
  for (const entries of refreshed.commissionAllocation.values()) {
    for (const entry of entries) if (!refreshed.financial.reviewDirectors.has(String(entry.directorUserId))) increment(entry.completedAt, "commissionableMatters");
  }

  const totals = buckets.reduce(
    (acc, bucket) => {
      acc.emailsSent += bucket.emailsSent;
      acc.registrations += bucket.registrations;
      acc.followUps += bucket.followUps;
      acc.replies += bucket.replies;
      acc.mattersPosted += bucket.mattersPosted;
      acc.mattersCompleted += bucket.mattersCompleted;
      acc.commissionableMatters += bucket.commissionableMatters;
      return acc;
    },
    {
      emailsSent: 0,
      registrations: 0,
      followUps: 0,
      replies: 0,
      mattersPosted: 0,
      mattersCompleted: 0,
      commissionableMatters: 0,
      openRatePct: 0,
      unsubscribers: 0,
    }
  );
  totals.conversionRatePct = totals.emailsSent ? Math.round((totals.registrations / totals.emailsSent) * 100) : 0;
  totals.replyRatePct = totals.emailsSent ? Math.round((totals.replies / totals.emailsSent) * 100) : 0;

  const lifetime = commissionEvidence.summarize([...refreshed.financial.records.values()]);
  await refreshed.financial.verify();
  return {
    range: {
      start: buckets[0]?.dateKey || "",
      end: buckets[buckets.length - 1]?.dateKey || "",
      days: buckets.length,
    },
    totals,
    commissionLifetime: {
      ...lifetime,
      commissionCapMatterCount: COMMISSION_CAP,
      remainingMatterCount: profile && lifetime.commissionState !== "needs_review" ? Math.max(0, COMMISSION_CAP - lifetime.commissionableMatterCount) : null,
    },
    series: buckets.map((bucket) => ({
      date: bucket.dateKey,
      emailsSent: bucket.emailsSent,
      registrations: bucket.registrations,
      followUps: bucket.followUps,
      replies: bucket.replies,
      mattersPosted: bucket.mattersPosted,
      mattersCompleted: bucket.mattersCompleted,
      commissionableMatters: bucket.commissionableMatters,
    })),
  };
}

module.exports = {
  autoImportDirectorMail,
  ensureDirectorProfile,
  getDirectorAnalytics,
  getDirectorOverview,
  getProfileForRequest,
  importDirectorInboxReplies,
  importDirectorSentMail,
  listDirectorRecords,
  normalizeState,
  processAutomaticDirectorFollowUps,
  refreshDirectorRecords,
  sendDirectorOutreach,
  serializeProfile,
  updateDirectorProfile,
  updateDirectorRecordState,
};
