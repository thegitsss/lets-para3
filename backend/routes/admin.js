// backend/routes/admin.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const User = require("../models/User");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog"); // NOTE: file name fix
const Payout = require("../models/Payout");
const PlatformIncome = require("../models/PlatformIncome");
const sendEmail = require("../utils/email");
const { sendWelcomePacket } = sendEmail;

// -----------------------------------------
// Optional CSRF (enable via ENABLE_CSRF=true)
// -----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
if (process.env.ENABLE_CSRF === "true") {
const csrf = require("csurf");
csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const LOGIN_URL = APP_BASE_URL ? `${APP_BASE_URL}/login.html` : "https://www.lets-paraconnect.com/login.html";
const APPROVAL_EMAIL_SUBJECT =
"Welcome to Let's-ParaConnect. Your account has been approved. You may now log in and begin using your dashboard.";
const DENIAL_EMAIL_SUBJECT =
"Your application to join Let's-ParaConnect has been reviewed and was unfortunately not approved.";
const VERIFICATION_ACCEPT_SUBJECT = "Let’s-ParaConnect Verification Approval";
const VERIFICATION_REJECT_SUBJECT = "Let’s-ParaConnect Verification Update";

// -----------------------------------------
// Helpers
// -----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const formatFullName = (u = {}) => {
const joined = `${u.firstName || ""} ${u.lastName || ""}`.trim();
return joined || null;
};

function parsePagination(req, { maxLimit = 100, defaultLimit = 20 } = {}) {
const page = Math.max(1, parseInt(req.query.page, 10) || 1);
const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
const skip = (page - 1) * limit;
return { page, limit, skip };
}

function startOfMonthWindow(months = 12) {
const now = new Date();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
start.setUTCHours(0, 0, 0, 0);
return start;
}

function formatMonthFromGroup(group) {
if (!group?._id) return "";
const { year, month } = group._id;
return `${year}-${String(month).padStart(2, "0")}`;
}

function formatFilingDeadline() {
const now = new Date();
let year = now.getUTCFullYear();
let deadline = new Date(Date.UTC(year, 3, 15)); // April (0-indexed month)
if (deadline <= now) {
year += 1;
deadline = new Date(Date.UTC(year, 3, 15));
}
return deadline.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function isObjId(id) {
return mongoose.isValidObjectId(id);
}

function pickUserSafe(u) {
// fields safe to return to admin tools
const {
_id, firstName, lastName, email, role, status, bio, about, availability, emailVerified,
lastLoginAt, lockedUntil, failedLogins, audit, createdAt, updatedAt,
specialties, jurisdictions, skills, yearsExperience, languages,
avatarURL, timezone, location, kycStatus, stripeCustomerId, stripeAccountId,
barNumber, resumeURL, certificateURL, practiceAreas, experience, education,
disabled,
} = u;
return {
id: _id,
firstName,
lastName,
name: formatFullName(u),
email,
role,
status,
bio,
about,
availability,
emailVerified,
lastLoginAt, lockedUntil, failedLogins, audit, createdAt, updatedAt,
specialties, jurisdictions, skills, yearsExperience, languages,
avatarURL, timezone, location, kycStatus, stripeCustomerId, stripeAccountId,
barNumber,
resumeURL,
certificateURL,
practiceAreas,
experience,
education,
disabled,
};
}

function normalizeUserStatus(value) {
const safe = String(value || "").trim().toLowerCase();
if (!safe) return null;
if (safe === "rejected") return "denied";
if (["pending", "approved", "denied"].includes(safe)) return safe;
return null;
}

function sanitizeNote(note) {
if (!note && note !== 0) return undefined;
const text = String(note).trim();
return text ? text.slice(0, 1000) : undefined;
}

function buildVerificationAcceptanceBody(user) {
if (typeof sendEmail.sendAcceptedEmail === "function") {
return sendEmail.sendAcceptedEmail(user?.lastName || "");
}
const last = user?.lastName || "Applicant";
return `Dear Ms./Mr. ${last},<br/><br/>Congratulations! Your application has been approved. We will send onboarding instructions as we approach the official platform launch.<br/><br/>If you have any questions, contact us at admin@lets-paraconnect.com.<br/><br/>Let’s-ParaConnect Verification Division`;
}

function buildVerificationRejectionBody(user) {
if (typeof sendEmail.sendNotAcceptedEmail === "function") {
return sendEmail.sendNotAcceptedEmail(user?.lastName || "");
}
const last = user?.lastName || "Applicant";
return `Dear Ms./Mr. ${last},<br/><br/>Thank you for your interest in Let’s-ParaConnect. After reviewing your submission, we are unable to extend an invitation at this time. You are welcome to reapply in the future if circumstances change.<br/><br/>If you have any questions, contact us at admin@lets-paraconnect.com.<br/><br/>Let’s-ParaConnect Verification Division`;
}

async function dispatchDecisionEmail(user, status) {
if (!user?.email) return;
const friendlyName = formatFullName(user) || "there";
const loginLine = LOGIN_URL ? `<br/><br/>Log in here: <a href="${LOGIN_URL}">${LOGIN_URL}</a>` : "";
if (status === "approved") {
const html = `Hi ${friendlyName},<br/><br/>Welcome to Let's-ParaConnect. Your account has been approved. You may now log in and begin using your dashboard.${loginLine}<br/><br/>We're excited to have you onboard.<br/>— Let's-ParaConnect`;
await sendEmail(user.email, APPROVAL_EMAIL_SUBJECT, html);
return;
}
if (status === "denied") {
const html = `Hi ${friendlyName},<br/><br/>Your application to join Let's-ParaConnect has been reviewed and was unfortunately not approved. Our team reviews every submission carefully, and you can reply to this email if you believe we missed important information.<br/><br/>Thank you for your interest in the community.<br/>— Let's-ParaConnect`;
await sendEmail(user.email, DENIAL_EMAIL_SUBJECT, html);
}
}

async function sendDecisionEmailSafe(user, status) {
try {
await dispatchDecisionEmail(user, status);
} catch (err) {
console.warn(`[admin] Failed to send ${status} email to ${user?.email || "unknown"}`, err?.message || err);
}
}

async function applyUserDecision(req, user, status, note) {
const normalized = normalizeUserStatus(status);
if (!normalized || normalized === "pending") {
const error = new Error("Invalid status");
error.statusCode = 400;
throw error;
}
  const cleanNote = sanitizeNote(note);
  user.status = normalized;
  if (normalized === "approved" && !user.approvedAt) {
    user.approvedAt = new Date();
  }
if (!Array.isArray(user.audit)) user.audit = [];
user.audit.push({
adminId: req.user?.id || null,
action: normalized === "denied" ? "denied" : "approved",
note: cleanNote,
});
await user.save();

const auditEvent = normalized === "denied" ? "admin.user.denied" : "admin.user.approved";
try {
await AuditLog.logFromReq(req, auditEvent, {
targetType: "user",
targetId: user._id,
meta: { status: normalized, note: cleanNote },
});
} catch (err) {
console.warn("[admin] Failed to log audit event", err?.message || err);
}

await sendDecisionEmailSafe(user, normalized);
return user;
}

// All admin routes are protected & admin-only
router.use(verifyToken, requireRole("admin"));

router.get("/metrics", asyncHandler(async (_req, res) => {
const ACTIVE_CASE_STATUSES = ["open", "assigned", "active", "awaiting_documents", "reviewing", "in_progress"];

const [roleAggregation, pendingApprovals, suspendedUsers, recentUsersRaw, monthlyRegistrationsRaw, caseAggregation, escrowAggregation, revenueAggregation] =
await Promise.all([
User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
User.countDocuments({ status: "pending" }),
User.countDocuments({ status: { $in: ["denied", "rejected"] } }),
User.find()
.sort({ createdAt: -1 })
.limit(10)
.select("firstName lastName email role status createdAt")
.lean(),
User.aggregate([
{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
Case.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
Case.aggregate([
{ $match: { paymentReleased: { $ne: true } } },
{ $group: { _id: null, total: { $sum: "$totalAmount" } } },
]),
PlatformIncome.aggregate([{ $group: { _id: null, total: { $sum: "$feeAmount" }, count: { $sum: 1 } } }]),
]);

const roleMap = roleAggregation.reduce((acc, item) => {
acc[item._id] = item.count;
return acc;
}, {});

const totalUsers = Object.values(roleMap).reduce((sum, value) => sum + value, 0);

let activeCases = 0;
let completedCases = 0;
caseAggregation.forEach((item) => {
if (item._id === "completed") {
completedCases = item.count;
} else if (ACTIVE_CASE_STATUSES.includes(item._id)) {
activeCases += item.count;
}
});

const monthlyRegistrations = monthlyRegistrationsRaw.map((entry) => ({
month: `${entry._id.year}-${String(entry._id.month).padStart(2, "0")}`,
count: entry.count,
}));

const recentUsers = recentUsersRaw.map((user) => ({
id: user._id,
name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "User",
email: user.email || "",
role: user.role || "",
status: user.status || "",
createdAt: user.createdAt,
}));

const escrowHeld = escrowAggregation[0]?.total || 0;
const totalRevenue = revenueAggregation[0]?.total || 0;

res.json({
totals: {
totalUsers,
attorneys: roleMap.attorney || 0,
paralegals: roleMap.paralegal || 0,
pendingApprovals,
suspendedUsers,
escrowHeld,
activeCases,
completedCases,
totalRevenue,
},
monthlyRegistrations,
recentUsers,
});
}));

router.get(
"/pending-paralegals",
asyncHandler(async (_req, res) => {
const pending = await User.find({ role: "paralegal", status: "pending" })
.select("firstName lastName email linkedInURL certificateURL yearsExperience ref1Name ref1Email ref2Name ref2Email createdAt")
.sort({ createdAt: 1 })
.lean();
res.json({ items: pending });
})
);

router.post(
"/approve/:id",
asyncHandler(async (req, res) => {
const { id } = req.params;
  if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
  const user = await User.findById(id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.role !== "paralegal") return res.status(400).json({ error: "Only paralegals can be approved here" });
  user.status = "approved";
  if (!user.approvedAt) {
    user.approvedAt = new Date();
  }
  if (Object.prototype.hasOwnProperty.call(user, "verified")) {
    user.verified = true;
  }
await user.save();
await sendWelcomePacket(user);
const html = buildVerificationAcceptanceBody(user);
if (user.email) {
try {
await sendEmail(user.email, VERIFICATION_ACCEPT_SUBJECT, html);
} catch (err) {
console.warn("[admin] Failed to send acceptance email", err?.message || err);
}
}
res.json({ ok: true });
})
);

router.post(
"/reject/:id",
asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ error: "User not found" });
if (user.role !== "paralegal") return res.status(400).json({ error: "Only paralegals can be reviewed here" });
user.status = "rejected";
await user.save();
const html = buildVerificationRejectionBody(user);
if (user.email) {
try {
await sendEmail(user.email, VERIFICATION_REJECT_SUBJECT, html);
} catch (err) {
console.warn("[admin] Failed to send rejection email", err?.message || err);
}
}
res.json({ ok: true });
})
);

router.post(
"/disable/:id",
asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ error: "User not found" });
user.disabled = true;
await user.save();
res.json({ ok: true, disabled: true });
})
);

router.post(
"/enable/:id",
asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ error: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ error: "User not found" });
user.disabled = false;
await user.save();
res.json({ ok: true, disabled: false });
})
);

router.get(
"/summary",
asyncHandler(async (_req, res) => {
const ACTIVE_CASE_STATUSES = ["open", "assigned", "active", "awaiting_documents", "reviewing", "in_progress"];
const [roleAggregation, pendingUsers, caseAggregation, escrowHeldAgg, escrowReleasedAgg] = await Promise.all([
User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
User.countDocuments({ status: "pending" }),
Case.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
Case.aggregate([
{ $match: { paymentReleased: { $ne: true } } },
{ $group: { _id: null, total: { $sum: "$totalAmount" } } },
]),
Case.aggregate([
{ $match: { paymentReleased: true } },
{ $group: { _id: null, total: { $sum: "$totalAmount" } } },
]),
]);

const roleMap = roleAggregation.reduce((acc, item) => {
acc[item._id] = item.count;
return acc;
}, {});
const totalUsers = Object.values(roleMap).reduce((sum, value) => sum + value, 0);

let activeCases = 0;
let completedCases = 0;
caseAggregation.forEach((item) => {
if (item._id === "completed") {
completedCases = item.count;
} else if (ACTIVE_CASE_STATUSES.includes(item._id)) {
activeCases += item.count;
}
});

res.json({
totalUsers,
pendingUsers,
totalAttorneys: roleMap.attorney || 0,
totalParalegals: roleMap.paralegal || 0,
activeCases,
completedCases,
totalEscrowHold: escrowHeldAgg[0]?.total || 0,
totalEscrowReleased: escrowReleasedAgg[0]?.total || 0,
});
})
);

router.get(
"/analytics",
asyncHandler(async (_req, res) => {
const MONTHS_WINDOW = 12;
const startWindow = startOfMonthWindow(MONTHS_WINDOW);
const ACTIVE_CASE_STATUSES = ["open", "assigned", "active", "awaiting_documents", "reviewing", "in_progress"];
const COMPLETED_CASE_STATUSES = ["completed", "closed"];
const LEDGER_LIMIT = 20;

const [
roleAggregation,
pendingApprovalsCount,
suspendedUsersCount,
registrationsAgg,
escrowHeldAgg,
escrowReleasedAgg,
      escrowHeldByMonthAgg,
      escrowReleasedByMonthAgg,
grossVolumeAgg,
monthlyGrossAgg,
platformFeeAgg,
monthlyFeesAgg,
jobsPostedAgg,
jobsCompletedAgg,
practiceAgg,
escrowInProgressCount,
pendingPayoutAgg,
payoutTotalsAgg,
caseStatusAgg,
caseLedgerDocs,
payoutLedgerDocs,
feeLedgerDocs,
upcomingPayoutCases,
recentUsersRaw,
] = await Promise.all([
User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
User.countDocuments({ status: "pending" }),
User.countDocuments({ status: { $in: ["denied", "rejected"] } }),
User.aggregate([
{ $match: { createdAt: { $gte: startWindow } } },
{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
Case.aggregate([
{ $match: { paymentReleased: { $ne: true } } },
{ $group: { _id: null, total: { $sum: "$totalAmount" } } },
]),
Case.aggregate([
{ $match: { paymentReleased: true } },
{ $group: { _id: null, total: { $sum: "$totalAmount" } } },
]),
      Case.aggregate([
        { $match: { createdAt: { $gte: startWindow }, totalAmount: { $gt: 0 }, paymentReleased: { $ne: true } } },
        {
          $group: {
            _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
            total: { $sum: "$totalAmount" },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
      Payout.aggregate([
        { $match: { createdAt: { $gte: startWindow } } },
        {
          $group: {
            _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
            total: { $sum: "$amountPaid" },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
Case.aggregate([{ $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } }]),
Case.aggregate([
{ $match: { createdAt: { $gte: startWindow } } },
{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, total: { $sum: "$totalAmount" } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
PlatformIncome.aggregate([{ $group: { _id: null, total: { $sum: "$feeAmount" } } }]),
PlatformIncome.aggregate([
{ $match: { createdAt: { $gte: startWindow } } },
{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, revenue: { $sum: "$feeAmount" } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
Case.aggregate([
{ $match: { createdAt: { $gte: startWindow } } },
{ $group: { _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } }, count: { $sum: 1 } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
Case.aggregate([
{ $match: { completedAt: { $ne: null, $gte: startWindow } } },
{ $group: { _id: { year: { $year: "$completedAt" }, month: { $month: "$completedAt" } }, count: { $sum: 1 } } },
{ $sort: { "_id.year": 1, "_id.month": 1 } },
]),
Case.aggregate([
{ $group: { _id: "$practiceArea", count: { $sum: 1 } } },
{ $sort: { count: -1 } },
]),
Case.countDocuments({ paymentReleased: { $ne: true }, status: { $in: ACTIVE_CASE_STATUSES } }),
Case.aggregate([
{ $match: { paymentReleased: { $ne: true }, status: { $in: COMPLETED_CASE_STATUSES } } },
{ $group: { _id: null, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
]),
Payout.aggregate([{ $group: { _id: null, total: { $sum: "$amountPaid" }, count: { $sum: 1 } } }]),
Case.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
Case.find({ totalAmount: { $gt: 0 } })
.sort({ createdAt: -1 })
.limit(LEDGER_LIMIT)
.select("title practiceArea totalAmount paymentStatus paymentReleased createdAt")
.lean(),
Payout.find()
.sort({ createdAt: -1 })
.limit(LEDGER_LIMIT)
.select("caseId amountPaid transferId createdAt")
.lean(),
PlatformIncome.find()
.sort({ createdAt: -1 })
.limit(LEDGER_LIMIT)
.select("caseId feeAmount createdAt")
.lean(),
Case.find({ paymentReleased: { $ne: true }, paralegal: { $ne: null }, totalAmount: { $gt: 0 } })
.sort({ deadline: 1, createdAt: 1 })
.limit(5)
.select("deadline totalAmount paralegalNameSnapshot paralegal createdAt")
.populate("paralegal", "firstName lastName")
.lean(),
User.find()
.sort({ createdAt: -1 })
.limit(10)
.select("firstName lastName email role status createdAt")
.lean(),
]);

const roleMap = roleAggregation.reduce((acc, entry) => {
if (entry?._id) acc[entry._id] = entry.count;
return acc;
}, {});
const totalUsers = Object.values(roleMap).reduce((sum, value) => sum + value, 0);
const pendingApprovals = Number(pendingApprovalsCount) || 0;
const suspendedUsers = Number(suspendedUsersCount) || 0;

const registrationsByMonth = registrationsAgg.map((entry) => ({
month: formatMonthFromGroup(entry),
count: entry.count,
}));

const userMetrics = {
totalUsers,
totalAttorneys: roleMap.attorney || 0,
totalParalegals: roleMap.paralegal || 0,
pendingApprovals,
suspendedUsers,
registrationsByMonth,
};

    const heldByMonth = escrowHeldByMonthAgg.map((entry) => ({
      month: formatMonthFromGroup(entry),
      total: entry.total || 0,
    }));
    const releasedByMonth = escrowReleasedByMonthAgg.map((entry) => ({
      month: formatMonthFromGroup(entry),
      total: entry.total || 0,
    }));
    const heldMap = heldByMonth.reduce((acc, entry) => {
      if (entry.month) acc[entry.month] = entry.total;
      return acc;
    }, {});
    const releasedMap = releasedByMonth.reduce((acc, entry) => {
      if (entry.month) acc[entry.month] = entry.total;
      return acc;
    }, {});
    const escrowTrendMonths = Array.from(
      new Set([...heldByMonth.map((e) => e.month), ...releasedByMonth.map((e) => e.month)]).values()
    )
      .filter(Boolean)
      .sort();
    const escrowTrends = {
      months: escrowTrendMonths,
      held: escrowTrendMonths.map((m) => heldMap[m] || 0),
      released: escrowTrendMonths.map((m) => releasedMap[m] || 0),
    };

let activeCases = 0;
let completedCases = 0;
caseStatusAgg.forEach((item) => {
if (item?._id === "completed" || item?._id === "closed") {
completedCases += item.count;
} else if (ACTIVE_CASE_STATUSES.includes(item?._id)) {
activeCases += item.count;
}
});

const escrowMetrics = {
totalEscrowHeld: escrowHeldAgg[0]?.total || 0,
totalEscrowReleased: escrowReleasedAgg[0]?.total || 0,
escrowInProgress: escrowInProgressCount,
pendingPayouts: pendingPayoutAgg[0]?.total || 0,
pendingPayoutCount: pendingPayoutAgg[0]?.count || 0,
};

const grossVolume = grossVolumeAgg[0]?.total || 0;
const jobCount = grossVolumeAgg[0]?.count || 0;
const platformFeeTotals = platformFeeAgg[0] || { total: 0, count: 0 };
const platformFeesCollected = platformFeeTotals.total || 0;
const platformFeeCount = platformFeeTotals.count || 0;
const averageJobValue = jobCount ? Math.round(grossVolume / jobCount) : 0;
const profitMargin = grossVolume > 0 ? platformFeesCollected / grossVolume : 0;
const monthlyGrossMap = monthlyGrossAgg.reduce((acc, entry) => {
acc[formatMonthFromGroup(entry)] = entry.total;
return acc;
}, {});

const revenueMetrics = {
grossVolume,
platformFeesCollected,
totalRevenue: platformFeesCollected,
monthlyRevenue: monthlyFeesAgg.map((entry) => {
const month = formatMonthFromGroup(entry);
const gross = monthlyGrossMap[month] || 0;
const margin = gross > 0 ? Math.round((entry.revenue / gross) * 100) : 0;
return { month, revenue: entry.revenue, margin };
}),
averageJobValue,
profitMargin,
platformFeeCount,
};

const caseMetrics = {
jobsPostedByMonth: jobsPostedAgg.map((entry) => ({
month: formatMonthFromGroup(entry),
count: entry.count,
})),
jobsCompletedByMonth: jobsCompletedAgg.map((entry) => ({
month: formatMonthFromGroup(entry),
count: entry.count,
})),
casesByPracticeArea: practiceAgg.map((entry) => ({
practiceArea: (entry._id && String(entry._id).trim()) || "Unspecified",
count: entry.count,
})),
activeCases,
completedCases,
};

const ledgerEntries = [];
caseLedgerDocs.forEach((doc) => {
ledgerEntries.push({
date: doc.createdAt ? doc.createdAt.toISOString() : new Date().toISOString(),
category: "Attorney Payment",
description: doc.title
? `${doc.title}${doc.practiceArea ? ` – ${doc.practiceArea}` : ""}`
: "Case payment",
amount: doc.totalAmount || 0,
type: "income",
status: doc.paymentStatus || (doc.paymentReleased ? "Released" : "Pending"),
});
});
payoutLedgerDocs.forEach((doc) => {
ledgerEntries.push({
date: doc.createdAt ? doc.createdAt.toISOString() : new Date().toISOString(),
category: "Paralegal Payout",
description: doc.caseId ? `Payout for case ${doc.caseId}` : "Paralegal payout",
amount: doc.amountPaid || 0,
type: "expense",
status: doc.transferId ? "Transferred" : "Pending",
});
});
feeLedgerDocs.forEach((doc) => {
ledgerEntries.push({
date: doc.createdAt ? doc.createdAt.toISOString() : new Date().toISOString(),
category: "Platform Fee",
description: doc.caseId ? `Fee from case ${doc.caseId}` : "Platform income",
amount: doc.feeAmount || 0,
type: "income",
status: "Recorded",
});
});

const ledger = ledgerEntries
.sort((a, b) => new Date(b.date) - new Date(a.date))
.slice(0, LEDGER_LIMIT * 2);

const payoutSummary = payoutTotalsAgg[0] || { total: 0, count: 0 };
let operationalCosts = grossVolume - payoutSummary.total - platformFeesCollected;
if (operationalCosts < 0) {
operationalCosts = Math.max(0, Math.round(grossVolume * 0.05));
}
const expenses = {
operationalCosts,
payoutTotal: payoutSummary.total,
payoutCount: payoutSummary.count || 0,
};
const taxSummary = {
grossEarnings: platformFeesCollected,
deductibleExpenses: operationalCosts + payoutSummary.total,
estimatedTax: Math.max(0, Math.round((platformFeesCollected - operationalCosts) * 0.22)),
taxOwed: Math.max(0, Math.round((platformFeesCollected - operationalCosts) * 0.22)),
nextFilingDeadline: formatFilingDeadline(),
};

const upcomingPayouts = upcomingPayoutCases.map((caseDoc) => {
const rawDate = caseDoc.deadline || caseDoc.createdAt || new Date();
const recipient =
caseDoc.paralegalNameSnapshot ||
[caseDoc.paralegal?.firstName, caseDoc.paralegal?.lastName].filter(Boolean).join(" ") ||
"Paralegal";
return {
date: rawDate ? rawDate.toISOString().split("T")[0] : "",
amount: caseDoc.totalAmount || 0,
recipient,
};
});

const recentUsers = recentUsersRaw.map((user) => ({
id: user._id,
name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "User",
email: user.email || "",
role: user.role || "",
status: user.status || "",
createdAt: user.createdAt,
}));

res.json({
userMetrics,
escrowMetrics,
revenueMetrics,
caseMetrics,
taxSummary,
expenses,
upcomingPayouts,
ledger,
recentUsers,
      escrowTrends,
});
})
);

const listUsersHandler = asyncHandler(async (req, res) => {
const { status = "pending", role, q } = req.query;
const { skip, limit, page } = parsePagination(req, { defaultLimit: 25 });

const filter = {};
const normalizedStatus = normalizeUserStatus(status);
if (normalizedStatus) filter.status = normalizedStatus;
if (["attorney", "paralegal", "admin"].includes(role)) filter.role = role;
if (q && q.trim()) {
const rx = new RegExp(q.trim(), "i");
filter.$or = [
{ firstName: rx },
{ lastName: rx },
{ email: rx },
{ specialties: rx },
{ jurisdictions: rx },
];
}

const [items, total] = await Promise.all([
User.find(filter).select("-password").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
User.countDocuments(filter),
]);

res.json({
page, limit, total, pages: Math.ceil(total / limit),
users: items.map(pickUserSafe),
});
});

/**
* GET /api/admin/pending-users
* GET /api/admin/users/pending
* Optional query: ?status=pending|approved|denied&role=attorney|paralegal|admin&q=search&page=&limit=
* Returns paginated users (password never selected).
*/
router.get("/pending-users", listUsersHandler);
router.get("/users/pending", listUsersHandler);

/**
* PATCH /api/admin/user/:id
* Body: { status: 'approved' | 'denied', note? }
* Approve or deny a user, email them, and audit.
*/
router.patch("/user/:id", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
const { status, note } = req.body || {};
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
const normalized = normalizeUserStatus(status);
if (!normalized || normalized === "pending") return res.status(400).json({ msg: "Invalid status" });

const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });

const updated = await applyUserDecision(req, user, normalized, note);
res.json({ ok: true, user: pickUserSafe(updated.toObject()) });
}));

/**
* (Alias) POST /api/admin/approve-user/:id
* Approve via friendlier endpoint.
*/
router.post("/approve-user/:id", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });

const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });

const updated = await applyUserDecision(req, user, "approved");
res.json({ ok: true, user: pickUserSafe(updated.toObject()) });
}));

router.post("/users/:id/approve", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });
const updated = await applyUserDecision(req, user, "approved", req.body?.note);
res.json({ ok: true, user: pickUserSafe(updated.toObject()) });
}));

router.post("/users/:id/deny", csrfProtection, asyncHandler(async (req, res) => {
const { id } = req.params;
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
const user = await User.findById(id);
if (!user) return res.status(404).json({ msg: "User not found" });
const updated = await applyUserDecision(req, user, "denied", req.body?.note);
res.json({ ok: true, user: pickUserSafe(updated.toObject()) });
}));

/**
* GET /api/admin/cases
* Optional query: ?status=&attorney=&paralegal=&q=&page=&limit=
* Returns paginated cases with parties populated (name/email/role/status).
*/
router.get("/cases", asyncHandler(async (req, res) => {
const { status, attorney, paralegal, q } = req.query;
const { skip, limit, page } = parsePagination(req, { defaultLimit: 25 });

const filter = {};
if (status) filter.status = status;
if (attorney && isObjId(attorney)) filter.attorney = attorney;
if (paralegal && isObjId(paralegal)) filter.paralegal = paralegal;
if (q && q.trim()) filter.title = new RegExp(q.trim(), "i");

const [items, total] = await Promise.all([
Case.find(filter)
.sort({ createdAt: -1 })
.skip(skip).limit(limit)
.populate("attorney paralegal", "firstName lastName email role status")
.lean(),
Case.countDocuments(filter),
]);

res.json({
page, limit, total, pages: Math.ceil(total / limit),
cases: items,
});
}));

/**
* PATCH /api/admin/assign/:caseId
* Body: { paralegalId }
* Manually assign a paralegal to a case (sets status to 'assigned' if applicable).
*/
router.patch("/assign/:caseId", asyncHandler(async (req, res) => {
const { caseId } = req.params;
const { paralegalId } = req.body || {};
if (!isObjId(caseId)) return res.status(400).json({ msg: "Invalid case id" });
if (!isObjId(paralegalId)) return res.status(400).json({ msg: "Invalid paralegalId" });

const para = await User.findById(paralegalId).lean();
if (!para || para.role !== "paralegal") {
return res.status(400).json({ msg: "Invalid paralegalId" });
}

const c = await Case.findById(caseId);
if (!c) return res.status(404).json({ msg: "Case not found" });

// Prefer model helpers if present (from upgraded Case model)
if (typeof c.acceptApplicant === "function") {
try { c.acceptApplicant(paralegalId); } catch (_) { /* ignore if not applied yet */ }
}
c.paralegal = paralegalId;
if (c.status === "open" && typeof c.transitionTo === "function") {
if (c.canTransitionTo("assigned")) c.transitionTo("assigned");
else c.status = "assigned";
} else if (c.status === "open") {
c.status = "assigned";
}
await c.save();

await AuditLog.logFromReq(req, "admin.case.assign", {
targetType: "case",
targetId: c._id,
caseId: c._id,
meta: { paralegalId },
});

const populated = await Case.findById(c._id).populate("attorney paralegal", "firstName lastName email role status").lean();
res.json({ ok: true, msg: "Paralegal assigned", case: populated });
}));

/**
* PATCH /api/admin/cases/:id/status
* Body: { status }
* Update a case status as admin (uses Case transition guardrails if available).
*/
router.patch("/cases/:id/status", asyncHandler(async (req, res) => {
const { id } = req.params;
const { status } = req.body || {};
if (!isObjId(id)) return res.status(400).json({ msg: "Invalid case id" });

const ALLOWED = ["open", "assigned", "in_progress", "completed", "disputed", "closed"];
if (!ALLOWED.includes(status)) return res.status(400).json({ msg: "Invalid status" });

const c = await Case.findById(id);
if (!c) return res.status(404).json({ msg: "Case not found" });

if (typeof c.transitionTo === "function") {
// prefer safe transitions
if (!c.canTransitionTo(status)) {
return res.status(400).json({ msg: `Invalid transition from '${c.status}' to '${status}'.` });
}
c.transitionTo(status);
} else {
c.status = status;
}

await c.save();

await AuditLog.logFromReq(req, "admin.case.status.update", {
targetType: "case",
targetId: c._id,
caseId: c._id,
meta: { status },
});

const populated = await Case.findById(id)
.populate("attorney paralegal", "firstName lastName email role")
.lean();
res.json({ ok: true, msg: "Case updated", case: populated });
}));

/**
* GET /api/admin/metrics
* Quick admin overview counts.
*/
router.get("/metrics", asyncHandler(async (_req, res) => {
const [users, cases] = await Promise.all([
User.aggregate([
{ $group: { _id: { role: "$role", status: "$status" }, count: { $sum: 1 } } },
]),
Case.aggregate([
{ $group: { _id: "$status", count: { $sum: 1 } } },
]),
]);

res.json({ users, cases });
}));

router.get("/payouts", asyncHandler(async (_req, res) => {
const [items, summary] = await Promise.all([
Payout.find().sort({ createdAt: -1 }).limit(200).lean(),
Payout.aggregate([{ $group: { _id: null, total: { $sum: "$amountPaid" }, count: { $sum: 1 } } }]),
]);
res.json({
totalAmount: summary[0]?.total || 0,
count: summary[0]?.count || 0,
items,
});
}));

router.get("/income", asyncHandler(async (_req, res) => {
const [items, summary] = await Promise.all([
PlatformIncome.find().sort({ createdAt: -1 }).limit(200).lean(),
PlatformIncome.aggregate([{ $group: { _id: null, total: { $sum: "$feeAmount" }, count: { $sum: 1 } } }]),
]);
res.json({
totalAmount: summary[0]?.total || 0,
count: summary[0]?.count || 0,
items,
});
}));

// -----------------------------------------
// Fallback error handler (keeps admin routes tidy)
// -----------------------------------------
router.use((err, _req, res, _next) => {
console.error(err);
res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
});

module.exports = router;
