const mongoose = require("mongoose");

const DirectorOutreachEvent = require("../../models/DirectorOutreachEvent");
const DirectorOutreachRecord = require("../../models/DirectorOutreachRecord");
const DirectorProfile = require("../../models/DirectorProfile");
const User = require("../../models/User");
const { DIRECTOR_STAGE_LABELS } = require("./constants");
const { refreshDirectorRecords } = require("./directorPortalService");
const { COMMISSION_CAP } = require("./commissionCap");
const commissionEvidence = require("./commissionEvidence");
const payments = require("./commissionPayments");
const { recordPayment } = require("./commissionPaymentWriter");

function serializeDate(value) {
  return value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
}

function cents(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function csvCell(value) {
  const text = String(value ?? "");
  const raw = /^[\s]*[=+@-]|^[\t\r]/.test(text) ? "'" + text : text;
  if (!/[",\n\r]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

function serializeDirector(profile = {}, user = null, records = []) {
  const totals = records.reduce(
    (acc, record) => {
      acc.totalRecords += 1;
      acc[record.stage] = (acc[record.stage] || 0) + 1;
      acc.commissionEarnedCents += cents(record.commissionEarnedCents);
      acc.commissionableMatterCount += Number(record.commissionableMatterCount || 0);
      return acc;
    },
    {
      totalRecords: 0,
      commissionEarnedCents: 0,
      commissionableMatterCount: 0,
      founder_attention: 0,
      follow_up_failed: 0,
      follow_up_sent: 0,
    }
  );
  Object.assign(totals, commissionEvidence.summarize(records));
  totals.commissionOutstanding = outstanding(records);
  totals.commissionUnpaidCents = totals.commissionOutstanding.commissionEarnedCents;
  totals.commissionUnpaidCurrencies = totals.commissionOutstanding.commissionCurrencies;
  return {
    id: String(profile._id || ""),
    userId: String(profile.userId || user?._id || ""),
    displayName: profile.displayName || `${user?.firstName || ""} ${user?.lastName || ""}`.trim() || profile.email || "",
    email: profile.email || user?.email || "",
    zohoEmail: profile.zohoEmail || profile.email || user?.email || "",
    status: profile.status || "active",
    activeState: profile.activeState || "",
    commissionCapMatterCount: COMMISSION_CAP,
    commissionSharePctOfAttorneyFee: profile.commissionSharePctOfAttorneyFee || 50,
    zohoLastSyncAt: serializeDate(profile.zohoLastSyncAt),
    zohoLastSyncStatus: profile.zohoLastSyncStatus || "never",
    zohoLastSyncSummary: profile.zohoLastSyncSummary || "",
    zohoLastSyncError: profile.zohoLastSyncError || "",
    totals,
  };
}

function serializeRecord(record = {}) {
  return {
    id: String(record._id || ""),
    directorUserId: String(record.directorUserId || ""),
    directorEmail: record.directorEmail || "",
    attorneyName: record.attorneyName || "",
    attorneyEmail: record.attorneyEmail || "",
    state: record.state || "",
    stage: record.stage || "",
    stageLabel: DIRECTOR_STAGE_LABELS[record.stage] || record.stage || "",
    firstOutreachSentAt: serializeDate(record.firstOutreachSentAt),
    followUpSentAt: serializeDate(record.followUpSentAt),
    lastReplyAt: serializeDate(record.lastReplyAt),
    registeredAt: serializeDate(record.registeredAt),
    firstMatterPostedAt: serializeDate(record.firstMatterPostedAt),
    firstMatterCompletedAt: serializeDate(record.firstMatterCompletedAt),
    commissionableMatterCount: record.commissionableMatterCount ?? null,
    commissionEarnedCents: record.commissionEarnedCents ?? null,
    commissionState: record.commissionState || "needs_review",
    commissionCurrency: record.commissionCurrency || null,
    commissionStripeMode: record.commissionStripeMode || null,
    commissionCurrencies: record.commissionCurrencies || [],
    commissionReviewCount: record.commissionReviewCount || 0,
    commissionLegacySnapshot: record.commissionLegacySnapshot || null,
    commissionPayments: payments.present(record.commissionPayments, { admin: true }),
    commissionPayoutStatus: record.commissionPayoutStatus || "unpaid",
    commissionPaidAt: serializeDate(record.commissionPaidAt),
    commissionPaidByAdminId: record.commissionPaidByAdminId ? String(record.commissionPaidByAdminId) : "",
    commissionPayoutNote: record.commissionPayoutNote || "",
    lastFollowUpError: record.metadata?.lastFollowUpError || "",
    updatedAt: serializeDate(record.updatedAt),
  };
}

function outstanding(records) { return payments.outstanding(records); }

function isCommissionableRecord(record = {}) {
  return record.commissionPayments?.history?.length > 0 || record.commissionPayments?.state === "needs_review" || record.commissionState === "needs_review" || record.commissionPayoutStatus === "paid" || cents(record.commissionEarnedCents) > 0 || Number(record.commissionableMatterCount || 0) > 0;
}

async function listDirectorOversight({ limit = 500 } = {}) {
  const refreshed = await refreshDirectorRecords({ deferVerify: true });
  const profiles = await DirectorProfile.find({}).sort({ createdAt: 1 }).lean();
  const directorUsers = await User.find({ role: "director" }).select("firstName lastName email status").lean();
  const userById = new Map(directorUsers.map((user) => [String(user._id), user]));
  const profileByUserId = new Map(profiles.map((profile) => [String(profile.userId), profile]));

  directorUsers.forEach((user) => {
    if (!profileByUserId.has(String(user._id))) {
      profiles.push({
        userId: user._id,
        email: user.email,
        zohoEmail: user.email,
        displayName: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
        status: "active",
        activeState: "",
        commissionCapMatterCount: 50,
        commissionSharePctOfAttorneyFee: 50,
        zohoLastSyncAt: null,
        zohoLastSyncStatus: "never",
        zohoLastSyncSummary: "",
        zohoLastSyncError: "",
      });
    }
  });

  // Historical referral balances survive a removed or reclassified director.
  const records = (await DirectorOutreachRecord.find({}).sort({ founderAttentionAt: -1, updatedAt: -1 }).lean())
    .map(record => commissionEvidence.attach(record, refreshed.financial));
  const knownDirectors = new Set(profiles.map(profile => String(profile.userId)));
  for (const record of records) {
    const key = String(record.directorUserId);
    if (knownDirectors.has(key)) continue;
    knownDirectors.add(key);
    profiles.push({ userId: record.directorUserId, email: record.directorEmail, displayName: record.directorEmail || 'Former director', status: 'unavailable' });
  }
  const recordsByDirector = new Map();
  records.forEach((record) => {
    const key = String(record.directorUserId || "");
    const bucket = recordsByDirector.get(key) || [];
    bucket.push(record);
    recordsByDirector.set(key, bucket);
  });

  const emailCounts = records.reduce((acc, record) => {
    if (!record.attorneyEmail) return acc;
    const key = String(record.attorneyEmail).toLowerCase();
    acc.set(key, (acc.get(key) || 0) + 1);
    return acc;
  }, new Map());
  const duplicates = records
    .filter((record) => emailCounts.get(String(record.attorneyEmail || "").toLowerCase()) > 1)
    .map(serializeRecord);

  await refreshed.financial.verify();
  return {
    directors: profiles.map((profile) =>
      serializeDirector(profile, userById.get(String(profile.userId)), recordsByDirector.get(String(profile.userId)) || [])
    ),
    records: (limit === null ? records : records.slice(0, Math.min(1000, Math.max(1, Number(limit) || 500)))).map(serializeRecord),
    totalRecords: records.length,
    ...commissionEvidence.summarize(records),
    commissionOutstanding: outstanding(records),
    replies: records.filter((record) => record.stage === "founder_attention" || record.lastReplyAt).map(serializeRecord),
    failedFollowUps: records.filter((record) => record.stage === "follow_up_failed").map(serializeRecord),
    commissionPayables: records.filter(isCommissionableRecord).map(serializeRecord),
    duplicates,
    stageLabels: DIRECTOR_STAGE_LABELS,
  };
}

async function updateDirectorCommissionPayout(options) {
  const result = await recordPayment(options);
  return result ? { ...result, record: serializeRecord(result.record) } : null;
}

async function getDirectorRecordAudit(recordId) {
  if (!mongoose.isValidObjectId(recordId)) return null;
  let record = await DirectorOutreachRecord.findById(recordId).lean();
  if (!record) return null;
  const refreshed = await refreshDirectorRecords({ directorUserId: record.directorUserId, deferVerify: true });
  record = await DirectorOutreachRecord.findById(recordId).lean();
  if (!record) return null;
  const attorney = record.registeredUserId
    ? await User.findById(record.registeredUserId).select("_id email firstName lastName").lean()
    : await User.findOne({ email: record.attorneyEmail, role: "attorney" }).select("_id email firstName lastName").lean();
  const audit = refreshed.financial.records.get(String(record._id))?.commissionAudit || [];
  const events = await DirectorOutreachEvent.find({ recordId: record._id }).sort({ occurredAt: 1 }).lean();
  await refreshed.financial.verify();
  return {
    record: serializeRecord(commissionEvidence.attach(record, refreshed.financial)),
    attorney: attorney
      ? {
          id: String(attorney._id),
          email: attorney.email,
          name: `${attorney.firstName || ""} ${attorney.lastName || ""}`.trim(),
        }
      : null,
    commissionAudit: audit,
    events: events.map((event) => ({
      id: String(event._id),
      eventType: event.eventType,
      subject: event.subject || "",
      summary: event.summary || "",
      occurredAt: serializeDate(event.occurredAt),
      provider: event.provider || "",
    })),
  };
}

async function buildDirectorRecordsCsv() {
  const { records } = await listDirectorOversight({ limit: null });
  const headers = [
    "Director",
    "Attorney Name",
    "Attorney Email",
    "State",
    "Stage",
    "Outreach Sent",
    "Follow-Up Sent",
    "Reply",
    "Registered",
    "Matter Posted",
    "Matter Completed",
    "Commission",
    "Currency",
    "Mode",
    "Commission State",
    "Payout Status",
    "Paid At",
    "Payout Note",
    "Recorded Paid",
    "Outstanding",
    "Payment Records",
  ];
  const rows = records.flatMap(record => {
    const payment = record.commissionPayments;
    const groups = payment.groups.length ? payment.groups : [{ earnedCents: record.commissionEarnedCents, currency: record.commissionCurrency, stripeMode: record.commissionStripeMode, paidCents: payment.paidCents, outstandingCents: payment.outstandingCents }];
    const amount = value => Number.isSafeInteger(value) ? (value / 100).toFixed(2) : "";
    return groups.map(group => [record.directorEmail, record.attorneyName, record.attorneyEmail, record.state, record.stageLabel,
      record.firstOutreachSentAt, record.followUpSentAt, record.lastReplyAt, record.registeredAt, record.firstMatterPostedAt, record.firstMatterCompletedAt,
      amount(group.earnedCents), group.currency || "", group.stripeMode || "", record.commissionState,
      payment.state, record.commissionPaidAt, record.commissionPayoutNote, amount(group.paidCents), amount(group.outstandingCents),
      JSON.stringify(payment.history.filter(entry => !entry.currency || entry.currency === group.currency && entry.stripeMode === group.stripeMode).map(entry => ({ id: entry.id, action: entry.action, amountCents: entry.amountCents, currency: entry.currency, mode: entry.stripeMode, paidDate: entry.paidDate, reference: entry.reference, note: entry.note, recordedAt: entry.recordedAt, recordedBy: entry.recordedBy, reverses: entry.reverses, reversed: entry.reversed })))]);
  });
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

module.exports = {
  buildDirectorRecordsCsv,
  getDirectorRecordAudit,
  listDirectorOversight,
  updateDirectorCommissionPayout,
};
