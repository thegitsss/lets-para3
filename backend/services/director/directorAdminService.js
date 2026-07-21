const mongoose = require("mongoose");

const Case = require("../../models/Case");
const AuditLog = require("../../models/AuditLog");
const DirectorOutreachEvent = require("../../models/DirectorOutreachEvent");
const DirectorOutreachRecord = require("../../models/DirectorOutreachRecord");
const DirectorProfile = require("../../models/DirectorProfile");
const PlatformIncome = require("../../models/PlatformIncome");
const User = require("../../models/User");
const { DIRECTOR_STAGE_LABELS } = require("./constants");

function serializeDate(value) {
  return value ? new Date(value).toISOString() : null;
}

function cents(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function csvCell(value) {
  const raw = String(value ?? "");
  if (!/[",\n\r]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

function serializeDirector(profile = {}, user = null, records = []) {
  const totals = records.reduce(
    (acc, record) => {
      acc.totalRecords += 1;
      acc[record.stage] = (acc[record.stage] || 0) + 1;
      acc.commissionEarnedCents += cents(record.commissionEarnedCents);
      if (record.commissionPayoutStatus !== "paid") acc.commissionUnpaidCents += cents(record.commissionEarnedCents);
      acc.commissionableMatterCount += Number(record.commissionableMatterCount || 0);
      return acc;
    },
    {
      totalRecords: 0,
      commissionEarnedCents: 0,
      commissionUnpaidCents: 0,
      commissionableMatterCount: 0,
      founder_attention: 0,
      follow_up_failed: 0,
      follow_up_sent: 0,
    }
  );
  return {
    id: String(profile._id || ""),
    userId: String(profile.userId || user?._id || ""),
    displayName: profile.displayName || `${user?.firstName || ""} ${user?.lastName || ""}`.trim() || profile.email || "",
    email: profile.email || user?.email || "",
    zohoEmail: profile.zohoEmail || profile.email || user?.email || "",
    status: profile.status || "active",
    activeState: profile.activeState || "",
    commissionCapMatterCount: profile.commissionCapMatterCount || 50,
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
    commissionableMatterCount: Number(record.commissionableMatterCount || 0),
    commissionEarnedCents: cents(record.commissionEarnedCents),
    commissionPayoutStatus: record.commissionPayoutStatus || "unpaid",
    commissionPaidAt: serializeDate(record.commissionPaidAt),
    commissionPaidByAdminId: record.commissionPaidByAdminId ? String(record.commissionPaidByAdminId) : "",
    commissionPayoutNote: record.commissionPayoutNote || "",
    lastFollowUpError: record.metadata?.lastFollowUpError || "",
    updatedAt: serializeDate(record.updatedAt),
  };
}

function isCommissionableRecord(record = {}) {
  return cents(record.commissionEarnedCents) > 0 || Number(record.commissionableMatterCount || 0) > 0;
}

async function listDirectorOversight({ limit = 500 } = {}) {
  const profiles = await DirectorProfile.find({}).sort({ createdAt: 1 }).lean();
  const profileUserIds = profiles.map((profile) => profile.userId).filter(Boolean);
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

  const userIds = Array.from(new Set([...profileUserIds, ...directorUsers.map((user) => user._id)].map(String))).map(
    (id) => new mongoose.Types.ObjectId(id)
  );
  const records = userIds.length
    ? await DirectorOutreachRecord.find({ directorUserId: { $in: userIds } })
        .sort({ founderAttentionAt: -1, updatedAt: -1 })
        .limit(Math.min(1000, Math.max(1, Number(limit) || 500)))
        .lean()
    : [];
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

  return {
    directors: profiles.map((profile) =>
      serializeDirector(profile, userById.get(String(profile.userId)), recordsByDirector.get(String(profile.userId)) || [])
    ),
    records: records.map(serializeRecord),
    replies: records.filter((record) => record.stage === "founder_attention" || record.lastReplyAt).map(serializeRecord),
    failedFollowUps: records.filter((record) => record.stage === "follow_up_failed").map(serializeRecord),
    commissionPayables: records.filter(isCommissionableRecord).map(serializeRecord),
    duplicates,
    stageLabels: DIRECTOR_STAGE_LABELS,
  };
}

async function updateDirectorCommissionPayout({ recordId, paid, note = "", req } = {}) {
  if (!mongoose.isValidObjectId(recordId)) return null;
  const record = await DirectorOutreachRecord.findById(recordId);
  if (!record) return null;

  const commissionCents = cents(record.commissionEarnedCents);
  if (commissionCents <= 0) {
    const err = new Error("Only records with earned commission can be marked paid.");
    err.statusCode = 400;
    throw err;
  }

  const markPaid = Boolean(paid);
  record.commissionPayoutStatus = markPaid ? "paid" : "unpaid";
  record.commissionPaidAt = markPaid ? new Date() : null;
  record.commissionPaidByAdminId = markPaid ? req?.user?.id || req?.user?._id || null : null;
  record.commissionPayoutNote = String(note || "").trim().slice(0, 500);
  await record.save();

  await AuditLog.logFromReq(req, markPaid ? "director.commission.mark_paid" : "director.commission.mark_unpaid", {
    targetType: "other",
    targetId: String(record._id),
    meta: {
      directorUserId: String(record.directorUserId || ""),
      directorEmail: record.directorEmail || "",
      attorneyEmail: record.attorneyEmail || "",
      commissionEarnedCents: commissionCents,
      commissionableMatterCount: Number(record.commissionableMatterCount || 0),
      note: record.commissionPayoutNote || "",
    },
  });

  return serializeRecord(record);
}

async function getDirectorRecordAudit(recordId) {
  if (!mongoose.isValidObjectId(recordId)) return null;
  const record = await DirectorOutreachRecord.findById(recordId).lean();
  if (!record) return null;
  const attorney = await User.findOne({ email: record.attorneyEmail, role: "attorney" }).select("_id email firstName lastName").lean();
  const cases = attorney
    ? await Case.find({ $or: [{ attorney: attorney._id }, { attorneyId: attorney._id }] })
        .select("_id title status createdAt completedAt payoutFinalizedAt payoutTransferId feeAttorneyAmount feeAttorneyPct lockedTotalAmount totalAmount")
        .sort({ createdAt: 1 })
        .lean()
    : [];
  const incomeDocs = cases.length ? await PlatformIncome.find({ caseId: { $in: cases.map((caseDoc) => caseDoc._id) } }).lean() : [];
  const incomeByCase = new Map(incomeDocs.map((income) => [String(income.caseId), income]));
  const audit = cases.map((caseDoc) => {
    const income = incomeByCase.get(String(caseDoc._id));
    const base = cents(caseDoc.lockedTotalAmount || caseDoc.totalAmount);
    const attorneyFee =
      cents(caseDoc.feeAttorneyAmount) || cents(Math.round(base * (Number(caseDoc.feeAttorneyPct || 22) / 100)));
    const paid = Boolean(income || caseDoc.payoutFinalizedAt || caseDoc.payoutTransferId);
    return {
      caseId: String(caseDoc._id),
      title: caseDoc.title || "Matter",
      status: caseDoc.status || "",
      createdAt: serializeDate(caseDoc.createdAt),
      completedAt: serializeDate(caseDoc.completedAt || caseDoc.payoutFinalizedAt),
      paid,
      matterAmountCents: base,
      attorneyPlatformFeeCents: attorneyFee,
      directorCommissionCents: paid ? cents(attorneyFee * 0.5) : 0,
      incomeId: income?._id ? String(income._id) : "",
    };
  });
  const events = await DirectorOutreachEvent.find({ recordId: record._id }).sort({ occurredAt: 1 }).lean();
  return {
    record: serializeRecord(record),
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
  const { records } = await listDirectorOversight({ limit: 1000 });
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
    "Payout Status",
    "Paid At",
    "Payout Note",
  ];
  const rows = records.map((record) => [
    record.directorEmail,
    record.attorneyName,
    record.attorneyEmail,
    record.state,
    record.stageLabel,
    record.firstOutreachSentAt,
    record.followUpSentAt,
    record.lastReplyAt,
    record.registeredAt,
    record.firstMatterPostedAt,
    record.firstMatterCompletedAt,
    (record.commissionEarnedCents / 100).toFixed(2),
    record.commissionPayoutStatus,
    record.commissionPaidAt,
    record.commissionPayoutNote,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

module.exports = {
  buildDirectorRecordsCsv,
  getDirectorRecordAudit,
  listDirectorOversight,
  updateDirectorCommissionPayout,
};
