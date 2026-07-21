const mongoose = require("mongoose");

const Case = require("../../models/Case");
const DirectorOutreachEvent = require("../../models/DirectorOutreachEvent");
const DirectorOutreachRecord = require("../../models/DirectorOutreachRecord");
const DirectorProfile = require("../../models/DirectorProfile");
const PlatformIncome = require("../../models/PlatformIncome");
const User = require("../../models/User");
const sendEmail = require("../../utils/email");
const {
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
    commissionCapMatterCount: profile.commissionCapMatterCount || 50,
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

async function ensureDirectorProfile(user = {}) {
  const email = normalizeEmail(user.email);
  if (!user.id && !user._id) throw new Error("Director user is required.");
  let profile = await DirectorProfile.findOne({ userId: user.id || user._id });
  if (profile) return profile;
  profile = await DirectorProfile.create({
    userId: user.id || user._id,
    email,
    zohoEmail: email,
    displayName: String(user.email || "").split("@")[0] || "Director",
    activeState: "TX",
    outreachSubject: DIRECTOR_OUTREACH_SUBJECT,
  });
  return profile;
}

async function getProfileForRequest(user = {}) {
  if (String(user.role || "").toLowerCase() !== "director") return null;
  return ensureDirectorProfile(user);
}

async function updateDirectorProfile(user = {}, payload = {}) {
  const profile = await ensureDirectorProfile(user);
  const activeState = normalizeState(payload.activeState);
  if (activeState) profile.activeState = activeState;
  if (typeof payload.displayName === "string") profile.displayName = payload.displayName.trim().slice(0, 160);
  await profile.save();
  return profile;
}

async function upsertRecordFromImport({ profile, item, state = "" } = {}) {
  const attorneyEmail = normalizeEmail(item.attorneyEmail);
  if (!attorneyEmail) return null;
  const existingOtherDirectorRecord = await DirectorOutreachRecord.findOne({
    attorneyEmail,
    directorUserId: { $ne: profile.userId },
    stage: { $ne: "suppressed" },
  }).lean();
  if (existingOtherDirectorRecord) return null;

  const eventType = item.eventType;
  if (eventType === "reply_received") {
    const existingDirectorRecord = await DirectorOutreachRecord.findOne({
      directorUserId: profile.userId,
      attorneyEmail,
      stage: { $ne: "suppressed" },
    })
      .select("_id")
      .lean();
    if (!existingDirectorRecord) return null;
  }
  const assignedState = normalizeState(state);
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
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  let eventCreated = false;
  try {
    await DirectorOutreachEvent.create({
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
    });
    eventCreated = true;
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }

  if (eventCreated && eventType === "reply_received") {
    await notifyFounderOfReply({ record, item }).catch((err) => {
      console.warn("[director] founder reply notification failed", err?.message || err);
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

async function sendDirectorOutreach({ user = {}, attorneyName = "", attorneyEmail = "", state = "" } = {}) {
  const profile = await ensureDirectorProfile(user);
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
  }).lean();
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
    { new: true, upsert: true, setDefaultsOnInsert: true }
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

async function updateDirectorZohoSyncStatus(profile, payload = {}) {
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
    { new: true }
  );
}

async function importDirectorSentMail({
  user = {},
  state = "",
  fromDate = startOfRecentImportWindow(),
  toDate = new Date(),
  recordSyncStatus = true,
} = {}) {
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
      }).catch(() => {});
    }
    throw err;
  }
}

async function importDirectorInboxReplies({
  user = {},
  fromDate = startOfToday(),
  toDate = new Date(),
  recordSyncStatus = true,
} = {}) {
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
      }).catch(() => {});
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
      }).catch(() => {});
    }
  }

  return result;
}

async function refreshDirectorRecords({ directorUserId = null } = {}) {
  const filter = directorUserId ? { directorUserId } : {};
  const records = await DirectorOutreachRecord.find(filter);
  if (!records.length) return { updated: 0 };

  const emails = records.map((record) => record.attorneyEmail).filter(Boolean);
  const users = await User.find({ email: { $in: emails }, role: "attorney" })
    .select("_id email createdAt approvedAt status state location")
    .lean();
  const userByEmail = new Map(users.map((user) => [String(user.email || "").toLowerCase(), user]));
  const attorneyIds = users.map((user) => user._id);
  const cases = attorneyIds.length
    ? await Case.find({ attorney: { $in: attorneyIds } })
        .select("_id attorney attorneyId status createdAt completedAt payoutFinalizedAt payoutTransferId feeAttorneyAmount feeAttorneyPct lockedTotalAmount totalAmount")
        .lean()
    : [];
  const casesByAttorney = new Map();
  cases.forEach((caseDoc) => {
    const key = String(caseDoc.attorney || caseDoc.attorneyId || "");
    const bucket = casesByAttorney.get(key) || [];
    bucket.push(caseDoc);
    casesByAttorney.set(key, bucket);
  });
  const caseIds = cases.map((caseDoc) => caseDoc._id);
  const incomeDocs = caseIds.length ? await PlatformIncome.find({ caseId: { $in: caseIds } }).lean() : [];
  const incomeByCase = new Map(incomeDocs.map((income) => [String(income.caseId), income]));

  let updated = 0;
  for (const record of records) {
    if (record.stage === "suppressed") continue;
    const user = userByEmail.get(String(record.attorneyEmail || "").toLowerCase()) || null;
    const userCases = user ? casesByAttorney.get(String(user._id)) || [] : [];
    const postedCase = userCases.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;
    const completedCases = userCases.filter((caseDoc) => {
      const status = String(caseDoc.status || "").toLowerCase();
      return Boolean(caseDoc.completedAt || caseDoc.payoutFinalizedAt || caseDoc.payoutTransferId || status === "completed" || status === "closed");
    });
    const commissionCap = 50;
    const commissionableCases = completedCases
      .filter((caseDoc) => incomeByCase.has(String(caseDoc._id)) || Number(caseDoc.feeAttorneyAmount || 0) > 0)
      .slice(0, commissionCap);
    const commissionEarnedCents = commissionableCases.reduce((sum, caseDoc) => {
      const income = incomeByCase.get(String(caseDoc._id));
      const attorneyFee = Number(caseDoc.feeAttorneyAmount || 0) || Math.round(Number(caseDoc.lockedTotalAmount || caseDoc.totalAmount || 0) * (Number(caseDoc.feeAttorneyPct || 22) / 100));
      const amount = income ? attorneyFee : attorneyFee;
      return sum + Math.max(0, Math.round(amount * 0.5));
    }, 0);

    let nextStage = record.stage;
    if (record.stage === "follow_up_failed") {
      nextStage = "follow_up_failed";
    } else if (record.founderAttentionAt) {
      nextStage = "founder_attention";
    } else if (commissionableCases.length > 0) {
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
    record.commissionableMatterCount = commissionableCases.length;
    record.commissionEarnedCents = commissionEarnedCents;
    record.commissionStatus =
      commissionableCases.length >= commissionCap ? "cap_reached" : commissionableCases.length > 0 ? "accruing" : "none";
    record.stage = nextStage;
    await record.save();
    updated += 1;
  }

  return { updated };
}

async function sendAutomaticFollowUp({ record, profile, now = new Date() } = {}) {
  if (!record || !profile) return { sent: false, reason: "missing_record_or_profile" };
  if (record.followUpSentAt) return { sent: false, reason: "already_sent" };
  if (record.stage === "follow_up_failed") return { sent: false, reason: "failed_needs_admin_review" };
  if (record.founderAttentionAt) return { sent: false, reason: "founder_attention" };
  if (record.firstMatterPostedAt) return { sent: false, reason: "matter_posted" };
  if (!record.registeredAt) return { sent: false, reason: "not_registered" };

  const dueAt = new Date(new Date(record.registeredAt).getTime() + 8 * 24 * 60 * 60 * 1000);
  if (dueAt > now) return { sent: false, reason: "not_due" };

  const claim = await DirectorOutreachRecord.findOneAndUpdate(
    {
      _id: record._id,
      followUpSentAt: null,
      firstMatterPostedAt: null,
      founderAttentionAt: null,
      registeredAt: { $ne: null, $lte: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000) },
    },
    {
      $set: {
        followUpSentAt: now,
        lastOutboundAt: now,
        stage: "follow_up_sent",
      },
    },
    { new: true }
  );
  if (!claim) return { sent: false, reason: "not_claimed" };

  const attorneyName = claim.attorneyName || "there";
  try {
    await sendDirectorEmail(profile, claim.attorneyEmail, DIRECTOR_FOLLOW_UP_SUBJECT, buildDirectorFollowUpHtml(attorneyName), {
      text: buildDirectorFollowUpText(attorneyName),
      throwOnError: true,
      messageIdPrefix: `director-follow-up.${String(claim._id)}`,
    });

    try {
      await DirectorOutreachEvent.create({
        recordId: claim._id,
        directorUserId: claim.directorUserId,
        directorEmail: claim.directorEmail,
        attorneyEmail: claim.attorneyEmail,
        eventType: "follow_up_sent",
        subject: DIRECTOR_FOLLOW_UP_SUBJECT,
        summary: "Automatic 8-day follow-up sent after attorney registration without a posted matter.",
        provider: "smtp",
        providerMessageId: `auto-follow-up:${claim._id}`,
        occurredAt: now,
        metadata: {
          automated: true,
          dueAt,
        },
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }

    return { sent: true, recordId: String(claim._id), attorneyEmail: claim.attorneyEmail };
  } catch (err) {
    await DirectorOutreachRecord.updateOne(
      { _id: claim._id, followUpSentAt: now },
      {
        $set: {
          followUpSentAt: null,
          stage: "follow_up_failed",
          "metadata.lastFollowUpError": err?.message || String(err),
          "metadata.lastFollowUpFailedAt": new Date(),
        },
      }
    );
    throw err;
  }
}

async function processAutomaticDirectorFollowUps({ directorUserId = null, now = new Date(), limit = 25 } = {}) {
  await refreshDirectorRecords({ directorUserId });
  const dueBefore = new Date(new Date(now).getTime() - 8 * 24 * 60 * 60 * 1000);
  const filter = {
    followUpSentAt: null,
    firstMatterPostedAt: null,
    founderAttentionAt: null,
    stage: { $ne: "follow_up_failed" },
    registeredAt: { $ne: null, $lte: dueBefore },
  };
  if (directorUserId) filter.directorUserId = directorUserId;

  const records = await DirectorOutreachRecord.find(filter)
    .sort({ registeredAt: 1, updatedAt: 1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 25)));
  if (!records.length) return { scanned: 0, sent: 0, failed: 0, failures: [] };

  const profileIds = Array.from(new Set(records.map((record) => String(record.directorUserId))));
  const profiles = await DirectorProfile.find({ userId: { $in: profileIds } }).lean();
  const profileByUserId = new Map(profiles.map((profile) => [String(profile.userId), profile]));

  let sent = 0;
  let failed = 0;
  const failures = [];
  for (const record of records) {
    let profile = profileByUserId.get(String(record.directorUserId));
    if (!profile) {
      const directorUser = await User.findById(record.directorUserId).lean();
      if (directorUser) {
        const createdProfile = await ensureDirectorProfile({ ...directorUser, id: directorUser._id });
        profile = createdProfile.toObject ? createdProfile.toObject() : createdProfile;
        profileByUserId.set(String(record.directorUserId), profile);
      }
      if (!profile) {
        failed += 1;
        failures.push({ recordId: String(record._id), reason: "missing_director_profile" });
        continue;
      }
    }
    try {
      const result = await sendAutomaticFollowUp({ record, profile, now: new Date(now) });
      if (result.sent) sent += 1;
    } catch (err) {
      failed += 1;
      failures.push({ recordId: String(record._id), reason: err?.message || String(err) });
    }
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
    stageLabel: DIRECTOR_STAGE_LABELS[record.stage] || record.stage || "",
    firstOutreachSentAt: record.firstOutreachSentAt || null,
    followUpSentAt: record.followUpSentAt || null,
    lastReplyAt: record.lastReplyAt || null,
    founderAttentionAt: record.founderAttentionAt || null,
    registeredAt: record.registeredAt || null,
    firstMatterPostedAt: record.firstMatterPostedAt || null,
    firstMatterCompletedAt: record.firstMatterCompletedAt || null,
    commissionableMatterCount: record.commissionableMatterCount || 0,
    commissionEarnedCents: record.commissionEarnedCents || 0,
    commissionStatus: record.commissionStatus || "none",
    commissionPayoutStatus: record.commissionPayoutStatus || "unpaid",
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

  await refreshDirectorRecords({ directorUserId: role === "director" ? user.id || user._id : null });
  const records = await DirectorOutreachRecord.find(filter)
    .sort({ founderAttentionAt: -1, updatedAt: -1 })
    .limit(Math.min(250, Math.max(1, Number(limit) || 100)))
    .lean();
  return records.map(serializeRecord);
}

async function updateDirectorRecordState({ user = {}, recordId = "", state = "" } = {}) {
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
    { new: true }
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
  await refreshDirectorRecords({ directorUserId: profile?.userId || null });
  const records = await DirectorOutreachRecord.find(filter).lean();
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
  await refreshDirectorRecords({ directorUserId: profile?.userId || null });

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
    if (record.firstMatterCompletedAt) {
      increment(record.firstMatterCompletedAt, "commissionableMatters", Number(record.commissionableMatterCount || 0));
    }
  });

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

  return {
    range: {
      start: buckets[0]?.dateKey || "",
      end: buckets[buckets.length - 1]?.dateKey || "",
      days: buckets.length,
    },
    totals,
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
