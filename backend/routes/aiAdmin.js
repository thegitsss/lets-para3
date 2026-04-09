const express = require("express");
const mongoose = require("mongoose");

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const AiIssueReport = require("../models/AiIssueReport");
const Incident = require("../models/Incident");
const SupportTicket = require("../models/SupportTicket");
const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const SupportInsight = require("../models/SupportInsight");
const AutonomousAction = require("../models/AutonomousAction");
const controlRoomService = require("../services/incidents/controlRoomService");
const { getMarketingControlRoomView, getMarketingOverview } = require("../services/marketing/reviewService");
const { getPublishingOverview } = require("../services/marketing/publishingCycleService");
const { getSupportOverview, listSupportTickets } = require("../services/support/ticketService");
const { listFAQCandidates } = require("../services/support/faqCandidateService");
const { listSupportInsights } = require("../services/support/patternDetectionService");
const { getSalesOverview } = require("../services/sales/accountService");
const { listSalesDraftPackets } = require("../services/sales/outreachDraftService");
const {
  getApprovalWorkspaceOverview,
  listApprovalWorkspaceItems,
} = require("../services/approvals/workspaceService");
const { getEngineeringOverview } = require("../services/engineering/workspaceService");
const { runCtoDiagnosis } = require("../services/ai/ctoAgentService");
const { buildExecutionPacket } = require("../services/ai/ctoExecutionService");
const {
  CONTROL_ROOM_DECISION_POLICY,
  evaluateControlRoomPolicy,
} = require("../services/ai/controlRoomDecisionPolicy");
const {
  getAutonomyPreferencesSnapshot,
  processAutoModeActions,
  setAutonomyPreferenceMode,
} = require("../services/ai/autonomyPreferenceService");
const {
  buildFounderFocusView,
  getFounderCopilotRollup,
} = require("../services/founderCopilot/rollupService");
const { INCIDENT_STATES, INCIDENT_TERMINAL_STATES } = require("../utils/incidentConstants");

const router = express.Router();

const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    },
  });
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(verifyToken, requireApproved, requireRole("admin"));

const LEGACY_AI_ISSUE_ROUTE_META = Object.freeze({
  legacy: true,
  canonical: false,
  visibility: "compatibility_only",
  deprecationStatus: "non_canonical",
  sourceModel: "AiIssueReport",
  canonicalOpsSource: "Incident",
  replacementRoute: "/api/admin/incidents",
  operatorWarning:
    "Compatibility-only legacy issue route. Use Incident Control Room and /api/admin/incidents for canonical operator truth.",
  message: "Legacy AI issue queue only. Incident is the canonical operational system.",
});

const OPEN_INCIDENT_STATES = INCIDENT_STATES.filter((state) => !INCIDENT_TERMINAL_STATES.includes(state));
const SUPPORT_INCIDENT_SURFACES = ["public", "attorney", "paralegal"];
const ACTIVE_INCIDENT_JOB_TYPES = Object.freeze([
  "intake_validation",
  "classification",
  "investigation",
  "patch_planning",
  "patch_execution",
  "verification",
  "deployment",
  "post_deploy_verification",
  "rollback",
]);
const ACTIVE_SUPPORT_TICKET_STATUSES = Object.freeze([
  "open",
  "in_review",
  "waiting_on_user",
  "waiting_on_info",
]);
const MONEY_INCIDENT_DOMAINS = new Set([
  "payments",
  "stripe_onboarding",
  "escrow",
  "payouts",
  "withdrawals",
  "disputes",
]);
const AUTH_INCIDENT_DOMAINS = new Set([
  "auth",
  "permissions",
  "approvals",
  "profile_visibility",
]);
const PRODUCT_INCIDENT_DOMAINS = new Set([
  "ui",
  "navigation",
  "profile",
  "case_lifecycle",
  "matching",
  "messaging",
  "documents",
  "notifications",
  "performance",
  "data_integrity",
]);
const BLOCKED_INCIDENT_STATES = new Set([
  "needs_more_context",
  "needs_human_owner",
  "verification_failed",
  "deploy_failed",
]);
const SYNTHETIC_NAME_PATTERNS = Object.freeze([
  /\bqa\b/i,
  /\btest(?:er|ing)?\b/i,
  /\bdemo\b/i,
  /\bsample\b/i,
  /\bdummy\b/i,
]);
const SYNTHETIC_EMAIL_PATTERNS = Object.freeze([
  /@[^@\s]+\.(?:test|local)$/i,
  /@example\.(?:com|org|net)$/i,
  /@(mailinator|ethereal)\./i,
]);

function compactText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function isSyntheticUserRecord(user = {}) {
  const email = String(user.email || "").trim().toLowerCase();
  const fullName = `${String(user.firstName || "").trim()} ${String(user.lastName || "").trim()}`.trim();

  if (email && SYNTHETIC_EMAIL_PATTERNS.some((pattern) => pattern.test(email))) {
    return true;
  }

  return SYNTHETIC_NAME_PATTERNS.some((pattern) => pattern.test(fullName));
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${Number(count) || 0} ${Number(count) === 1 ? singular : plural}`;
}

function buildExecutiveStatus({ unavailable = false, priority = false, review = false } = {}) {
  if (unavailable) {
    return { status: "UNAVAILABLE", tone: "blocked" };
  }
  if (priority) {
    return { status: "PRIORITY", tone: "priority" };
  }
  if (review) {
    return { status: "NEEDS REVIEW", tone: "needs-review" };
  }
  return { status: "HEALTHY", tone: "healthy" };
}

function formatMetricValue(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function buildExecutiveCard({
  key,
  title,
  department,
  status,
  tone,
  description,
  metric1,
  metric2,
  recommendedAction,
  footerNote,
  actionButton,
}) {
  return {
    key,
    title,
    department,
    status,
    tone,
    description,
    metric1: {
      label: metric1?.label || "",
      value: formatMetricValue(metric1?.value),
    },
    metric2: {
      label: metric2?.label || "",
      value: formatMetricValue(metric2?.value),
    },
    actionText: recommendedAction || "",
    recommendedAction: recommendedAction || "",
    footerNote: footerNote || "",
    actionButton: {
      label: actionButton?.label || "Open",
      targetTab: actionButton?.targetTab || "",
      disabled: actionButton?.disabled === true,
    },
  };
}

function minutesSince(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (60 * 1000)));
}

function formatUserName(user = {}) {
  const name = `${String(user.firstName || "").trim()} ${String(user.lastName || "").trim()}`.trim();
  return name || String(user.email || "Applicant").trim() || "Applicant";
}

function applyLegacyIssueRouteHeaders(res) {
  res.set("X-LPC-Legacy-Route", "true");
  res.set("X-LPC-Canonical-Ops-Source", LEGACY_AI_ISSUE_ROUTE_META.canonicalOpsSource);
  res.set("Deprecation", "true");
  res.set("Warning", '299 - "Compatibility-only legacy route. Incident is the canonical ops source."');
  res.set("Cache-Control", "no-store");
}

function buildLegacyIssueRouteMeta() {
  return { ...LEGACY_AI_ISSUE_ROUTE_META };
}

function buildAdmissionsMissingFields(user = {}) {
  const role = String(user.role || "").toLowerCase();
  const missing = [];
  if (!user.emailVerified) missing.push("email verification");
  if (!user.termsAccepted) missing.push("accepted terms");

  if (role === "attorney") {
    if (!String(user.barNumber || "").trim()) missing.push("bar number");
    if (!String(user.state || "").trim()) missing.push("licensed state");
    if (!String(user.lawFirm || "").trim() && !String(user.firmWebsite || "").trim()) {
      missing.push("firm identity");
    }
  }

  if (role === "paralegal") {
    if (!String(user.resumeURL || "").trim()) missing.push("resume");
    if (!String(user.certificateURL || "").trim()) missing.push("certificate");
    if (!Number.isFinite(Number(user.yearsExperience)) || Number(user.yearsExperience) <= 0) {
      missing.push("experience history");
    }
  }

  return missing;
}

function buildAdmissionSignals(user = {}) {
  const role = String(user.role || "").toLowerCase();
  const missing = buildAdmissionsMissingFields(user);
  const readyForFounderReview = missing.length === 0;
  const riskLevel = readyForFounderReview ? "low" : missing.length >= 3 ? "high" : "medium";
  const action = readyForFounderReview ? "founder_review" : "request_more_info";
  const facts = [];

  if (user.emailVerified) facts.push("Email verified");
  if (user.termsAccepted) facts.push("Terms accepted");

  if (role === "attorney") {
    if (user.barNumber) facts.push("Bar number provided");
    if (user.state) facts.push(`State listed: ${user.state}`);
    if (user.lawFirm) facts.push("Law firm listed");
    else if (user.firmWebsite) facts.push("Firm website listed");
  } else if (role === "paralegal") {
    if (user.resumeURL) facts.push("Resume uploaded");
    if (user.certificateURL) facts.push("Certificate uploaded");
    if (Number.isFinite(Number(user.yearsExperience)) && Number(user.yearsExperience) > 0) {
      facts.push(`${Number(user.yearsExperience)} years experience listed`);
    }
  }

  const recommendation = readyForFounderReview
    ? "Recommend founder review based on the visible record."
    : `Recommend request-more-info because ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} still missing.`;

  const outboundMessage = readyForFounderReview
    ? "Thanks for your application. Your profile is under review and we’ll follow up if anything else is needed."
    : `Thanks for your application. Before we continue, please provide your ${missing.slice(0, 2).join(" and ")}.`;

  return {
    action,
    facts,
    missing,
    readyForFounderReview,
    riskLevel,
    recommendation,
    outboundMessage,
  };
}

function toneFromRisk(level = "") {
  const risk = String(level || "").toLowerCase();
  if (risk === "high" || risk === "critical") return "priority";
  if (risk === "medium") return "needs-review";
  return "active";
}

function incidentSeverityWeight(incident = {}) {
  const severity = String(incident.classification?.severity || "low").toLowerCase();
  const riskLevel = String(incident.classification?.riskLevel || "low").toLowerCase();
  const base = severity === "critical" ? 8 : severity === "high" ? 6 : severity === "medium" ? 3 : 1;
  const risk = riskLevel === "high" ? 4 : riskLevel === "medium" ? 2 : 0;
  const auth = isAuthIncident(incident) ? 5 : 0;
  const money = isMoneyIncident(incident) ? 4 : 0;
  const approval = incident.approvalState === "pending" || incident.state === "awaiting_founder_approval" ? 3 : 0;
  return base + risk + auth + money + approval;
}

function incidentSurface(incident = {}) {
  return String(incident.context?.surface || "").trim().toLowerCase();
}

function isMoneyIncident(incident = {}) {
  const domain = String(incident.classification?.domain || "").trim().toLowerCase();
  const flags = incident.classification?.riskFlags || {};
  return (
    MONEY_INCIDENT_DOMAINS.has(domain) ||
    flags.affectsMoney === true ||
    flags.affectsDisputes === true ||
    flags.affectsWithdrawals === true
  );
}

function isAuthIncident(incident = {}) {
  const domain = String(incident.classification?.domain || "").trim().toLowerCase();
  const flags = incident.classification?.riskFlags || {};
  return (
    AUTH_INCIDENT_DOMAINS.has(domain) ||
    flags.affectsAuth === true ||
    flags.affectsAccess === true ||
    flags.affectsPermissions === true ||
    flags.affectsApprovalDecision === true ||
    flags.affectsProfileVisibility === true
  );
}

function isSupportIncident(incident = {}) {
  return SUPPORT_INCIDENT_SURFACES.includes(incidentSurface(incident)) && !isMoneyIncident(incident);
}

function isSupportBlockerIncident(incident = {}) {
  const severity = String(incident.classification?.severity || "").toLowerCase();
  const riskLevel = String(incident.classification?.riskLevel || "").toLowerCase();
  return (
    ["high", "critical"].includes(severity) ||
    riskLevel === "high" ||
    isAuthIncident(incident) ||
    ["verification_failed", "deploy_failed", "needs_human_owner"].includes(String(incident.state || ""))
  );
}

function isCaseProgressIncident(incident = {}) {
  const domain = String(incident.classification?.domain || "").trim().toLowerCase();
  const routeText = `${String(incident.context?.routePath || "")} ${String(incident.context?.pageUrl || "")} ${String(
    incident.context?.featureKey || ""
  )} ${String(incident.summary || "")}`.toLowerCase();
  return (
    ["ui", "navigation", "case_lifecycle", "matching", "messaging", "documents", "notifications"].includes(domain) ||
    /\b(case|matter|hire|application|job)\b/.test(routeText)
  );
}

function isProductIncident(incident = {}) {
  const domain = String(incident.classification?.domain || "").trim().toLowerCase();
  return PRODUCT_INCIDENT_DOMAINS.has(domain) || isCaseProgressIncident(incident);
}

function isBlockedIncident(incident = {}) {
  return BLOCKED_INCIDENT_STATES.has(String(incident.state || "").trim().toLowerCase());
}

function isPriorityIncident(incident = {}) {
  const severity = String(incident.classification?.severity || "").trim().toLowerCase();
  const riskLevel = String(incident.classification?.riskLevel || "").trim().toLowerCase();
  const state = String(incident.state || "").trim().toLowerCase();
  return (
    severity === "critical" ||
    severity === "high" ||
    riskLevel === "high" ||
    state === "awaiting_founder_approval"
  );
}

function buildIncidentLine(incident = {}) {
  const area = String(
    incident.context?.featureKey ||
      incident.context?.routePath ||
      incident.context?.pageUrl ||
      incident.publicId ||
      "incident"
  ).trim();
  const description = compactText(incident.summary || incident.originalReportText || "No incident summary provided.", 120);
  const extras = [];
  if (incident.classification?.domain) extras.push(incident.classification.domain);
  if (incident.state) extras.push(`state ${incident.state}`);
  const extraText = extras.length ? ` (${extras.join(", ")})` : "";
  return `${area}: ${description}${extraText}.`;
}

function buildIncidentEscalationTitle(incident = {}) {
  return compactText(
    incident.context?.featureKey ||
      incident.summary ||
      incident.context?.routePath ||
      incident.publicId ||
      "Incident escalation",
    52
  );
}

async function getOpenIncidentsForWarRoom() {
  return Incident.find({ state: { $in: OPEN_INCIDENT_STATES } })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
}

function daysSince(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

async function getAdmissionsSnapshot() {
  const allUsers = await User.find({
    role: { $in: ["attorney", "paralegal"] },
    status: "pending",
    deleted: { $ne: true },
    disabled: { $ne: true },
  })
    .select(
      "firstName lastName email role createdAt emailVerified termsAccepted barNumber lawFirm firmWebsite state resumeURL certificateURL yearsExperience"
    )
    .sort({ createdAt: 1 })
    .lean();
  const users = allUsers.filter((user) => !isSyntheticUserRecord(user));

  const items = users.map((user) => {
    const signals = buildAdmissionSignals(user);
    return {
      id: String(user._id),
      role: String(user.role || "").toLowerCase(),
      name: formatUserName(user),
      createdAt: user.createdAt || null,
      ...signals,
    };
  });

  const attorneys = items.filter((item) => item.role === "attorney");
  const paralegals = items.filter((item) => item.role === "paralegal");
  const readyItems = items.filter((item) => item.readyForFounderReview);
  const needsInfoItems = items.filter((item) => !item.readyForFounderReview);

  let recommendation = "No pending admissions are currently visible.";
  if (readyItems.length && needsInfoItems.length) {
    recommendation = `${pluralize(
      readyItems.length,
      "application"
    )} appear ready for founder review, and ${pluralize(needsInfoItems.length, "record")} should receive a request for more information.`;
  } else if (readyItems.length) {
    recommendation = `${pluralize(readyItems.length, "application")} appear ready for founder review based on visible completeness.`;
  } else if (needsInfoItems.length) {
    recommendation = `${pluralize(needsInfoItems.length, "pending record")} still need core information before founder review.`;
  }

  return {
    total: items.length,
    attorneyCount: attorneys.length,
    paralegalCount: paralegals.length,
    readyCount: readyItems.length,
    needsInfoCount: needsInfoItems.length,
    recommendation,
    items,
    readyItems,
    needsInfoItems,
  };
}

async function getSupportSnapshot() {
  const [incidents, supportOverview, openTickets, faqCandidates, insights, activeIssueCount, escalationCount] = await Promise.all([
    getOpenIncidentsForWarRoom(),
    getSupportOverview(),
    listSupportTickets({ limit: 24 }),
    listFAQCandidates({ approvalState: "pending_review", limit: 6 }),
    listSupportInsights({ limit: 6 }),
    SupportTicket.countDocuments({ status: { $in: ACTIVE_SUPPORT_TICKET_STATUSES } }),
    SupportTicket.countDocuments({
      status: { $in: ACTIVE_SUPPORT_TICKET_STATUSES },
      $or: [
        { urgency: "high" },
        { "routingSuggestion.priority": "high" },
        { linkedIncidentIds: { $exists: true, $not: { $size: 0 } } },
        { riskFlags: "active_incident" },
        { riskFlags: "account_access" },
        { riskFlags: "money_sensitive" },
      ],
    }),
  ]);

  const actionableTickets = openTickets.filter((ticket) =>
    ["open", "in_review", "waiting_on_user", "waiting_on_info"].includes(ticket.status)
  );
  const linkedIncidentIds = new Set(
    actionableTickets.flatMap((ticket) => (ticket.linkedIncidentIds || []).map((id) => String(id)))
  );
  const supportIncidents = incidents.filter(isSupportIncident);
  const orphanSupportIncidents = supportIncidents.filter((incident) => !linkedIncidentIds.has(String(incident._id)));
  const rankedIncidents = [...orphanSupportIncidents].sort((a, b) => incidentSeverityWeight(b) - incidentSeverityWeight(a));
  const blockerIncidents = rankedIncidents.filter(isSupportBlockerIncident);
  const authIncidents = rankedIncidents.filter(isAuthIncident);
  const caseIncidents = rankedIncidents.filter(isCaseProgressIncident);

  const authTickets = actionableTickets.filter(
    (ticket) => ticket.classification?.category === "account_access" || (ticket.riskFlags || []).includes("account_access")
  );
  const caseTickets = actionableTickets.filter(
    (ticket) =>
      ["case_workflow", "job_application"].includes(ticket.classification?.category) ||
      (ticket.riskFlags || []).includes("case_progress")
  );
  const blockerTickets = actionableTickets.filter(
    (ticket) =>
      ticket.routingSuggestion?.priority === "high" ||
      (ticket.riskFlags || []).includes("active_incident") ||
      (ticket.riskFlags || []).includes("money_sensitive")
  );

  let recommendation = "No active support work is currently visible.";
  if (authTickets.length || authIncidents.length) {
    recommendation = "Review account-access support work first because it can fully block platform use.";
  } else if (blockerTickets.length || blockerIncidents.length) {
    recommendation = "Review blocking support items before routine queue cleanup because they interrupt active work.";
  } else if (caseTickets.length || caseIncidents.length) {
    recommendation = "Review case and application workflow questions before lower-priority support because they affect active work.";
  } else if (actionableTickets.length) {
    recommendation = "Review the newest support tickets and confirm the draft packet before replying externally.";
  } else if (rankedIncidents.length) {
    recommendation = "Review the newest incident-backed support issues before routine queue cleanup.";
  }

  return {
    total: actionableTickets.length + rankedIncidents.length,
    activeIssueCount: Number(activeIssueCount || 0),
    escalationCount: Number(escalationCount || 0),
    openTicketCount: supportOverview.counts.open,
    blockerCount: blockerTickets.length + blockerIncidents.length,
    authCount: authTickets.length + authIncidents.length,
    moneyCount: actionableTickets.filter((ticket) => (ticket.riskFlags || []).includes("money_sensitive")).length,
    caseCount: caseTickets.length + caseIncidents.length,
    pendingInfoCount: supportOverview.counts.waitingOnInfo,
    faqPendingCount: faqCandidates.length,
    insightCount: insights.length,
    recommendation,
    incidents: rankedIncidents,
    topIncidents: rankedIncidents.slice(0, 6),
    topTickets: actionableTickets.slice(0, 6),
    faqCandidates,
    insights,
  };
}

async function getPaymentsRiskSnapshot() {
  const openDisputes = await Case.aggregate([
    { $match: { "disputes.0": { $exists: true } } },
    { $unwind: "$disputes" },
    {
      $match: {
        $or: [
          { "disputes.status": "open" },
          { "disputes.status": { $exists: false } },
          { "disputes.status": null },
          { "disputes.status": "" },
        ],
      },
    },
    {
      $project: {
        caseId: "$_id",
        caseTitle: "$title",
        caseStatus: "$status",
        pausedReason: "$pausedReason",
        withdrawnParalegalId: "$withdrawnParalegalId",
        lockedTotalAmount: "$lockedTotalAmount",
        remainingAmount: "$remainingAmount",
        disputeMessage: "$disputes.message",
        disputeCreatedAt: "$disputes.createdAt",
        amountRequestedCents: "$disputes.amountRequestedCents",
      },
    },
    { $sort: { disputeCreatedAt: -1 } },
  ]);

  const openIncidents = await getOpenIncidentsForWarRoom();
  const activeMoneyIncidents = openIncidents
    .filter(isMoneyIncident)
    .sort((a, b) => incidentSeverityWeight(b) - incidentSeverityWeight(a));

  const withdrawalReviews = openDisputes.filter(
    (item) => item.withdrawnParalegalId || String(item.pausedReason || "").toLowerCase() === "paralegal_withdrew"
  );

  let recommendation = "No active payment or risk items are currently visible.";
  if (openDisputes.length && withdrawalReviews.length) {
    recommendation = "Review open disputes and withdrawal-related payout items before lower-risk queue work.";
  } else if (openDisputes.length) {
    recommendation = "Review open disputes first because they carry the clearest financial and trust risk.";
  } else if (activeMoneyIncidents.length) {
    recommendation = "Review money-risk incidents first because they can affect funding, payout confidence, or compliance exposure.";
  }

  return {
    openDisputesCount: openDisputes.length,
    withdrawalCount: withdrawalReviews.length,
    moneyIssueCount: activeMoneyIncidents.length,
    recommendation,
    openDisputes,
    withdrawalReviews,
    moneyIncidents: activeMoneyIncidents.slice(0, 6),
  };
}

async function getLifecycleSnapshot() {
  const allUsers = await User.find({
    role: { $in: ["attorney", "paralegal"] },
    status: { $in: ["pending", "approved"] },
    deleted: { $ne: true },
    disabled: { $ne: true },
  })
    .select(
      "firstName lastName email role status createdAt approvedAt lastLoginAt emailVerified termsAccepted barNumber lawFirm firmWebsite state resumeURL certificateURL yearsExperience stripeAccountId stripeOnboarded stripePayoutsEnabled"
    )
    .lean();
  const users = allUsers.filter((user) => !isSyntheticUserRecord(user));

  const [jobCountsAgg, applicationCountsAgg] = await Promise.all([
    Job.aggregate([{ $group: { _id: "$attorneyId", count: { $sum: 1 } } }]),
    Application.aggregate([{ $group: { _id: "$paralegalId", count: { $sum: 1 } } }]),
  ]);

  const jobCounts = new Map(jobCountsAgg.map((row) => [String(row._id), Number(row.count || 0)]));
  const applicationCounts = new Map(applicationCountsAgg.map((row) => [String(row._id), Number(row.count || 0)]));

  const pendingIncomplete = [];
  const stripeIncomplete = [];
  const approvedInactive = [];
  const attorneyNoMatter = [];
  const paralegalNoApplication = [];
  const stalledUserIds = new Set();
  const followUpCandidates = [];

  users.forEach((user) => {
    const id = String(user._id);
    const role = String(user.role || "").toLowerCase();
    const status = String(user.status || "").toLowerCase();
    const name = formatUserName(user);
    const createdDays = daysSince(user.createdAt);
    const approvedDays = daysSince(user.approvedAt);
    const lastLoginDays = daysSince(user.lastLoginAt);
    const missing = buildAdmissionsMissingFields(user);
    const userSignals = [];

    if (status === "pending" && missing.length) {
      const entry = {
        id,
        role,
        name,
        reason: `Missing ${missing.slice(0, 2).join(" and ")}.`,
        ageDays: createdDays,
      };
      pendingIncomplete.push(entry);
      stalledUserIds.add(id);
      if (createdDays >= 3) {
        userSignals.push({
          priority: 90,
          sortDays: createdDays,
          id,
          title: `${name} · ${role}`,
          reason: `Pending profile is still missing ${missing.slice(0, 2).join(" and ")}.`,
          tone: "needs-review",
        });
      }
    }

    if (status === "approved" && role === "paralegal" && (!user.stripeAccountId || !user.stripeOnboarded || !user.stripePayoutsEnabled)) {
      const entry = {
        id,
        role,
        name,
        reason: "Approved, but Stripe Connect is still incomplete.",
        ageDays: approvedDays,
      };
      stripeIncomplete.push(entry);
      stalledUserIds.add(id);
      if (approvedDays >= 3) {
        userSignals.push({
          priority: 100,
          sortDays: approvedDays,
          id,
          title: `${name} · paralegal`,
          reason: "Approved, but Stripe onboarding is still incomplete.",
          tone: "priority",
        });
      }
    }

    if (status === "approved" && approvedDays >= 14 && (!user.lastLoginAt || lastLoginDays >= 14)) {
      const entry = {
        id,
        role,
        name,
        reason: "Approved, but no recent login activity is visible.",
        ageDays: approvedDays,
      };
      approvedInactive.push(entry);
      stalledUserIds.add(id);
      userSignals.push({
        priority: 60,
        sortDays: Math.max(approvedDays, lastLoginDays),
        id,
        title: `${name} · ${role}`,
        reason: "Approved, but no recent login activity is visible.",
        tone: "active",
      });
    }

    if (status === "approved" && role === "attorney" && approvedDays >= 14 && (jobCounts.get(id) || 0) === 0) {
      const entry = {
        id,
        role,
        name,
        reason: "Approved attorney account with no matter posted yet.",
        ageDays: approvedDays,
      };
      attorneyNoMatter.push(entry);
      stalledUserIds.add(id);
      userSignals.push({
        priority: 80,
        sortDays: approvedDays,
        id,
        title: `${name} · attorney`,
        reason: "Approved, but no matter has been posted yet.",
        tone: "active",
      });
    }

    if (status === "approved" && role === "paralegal" && approvedDays >= 14 && (applicationCounts.get(id) || 0) === 0) {
      const entry = {
        id,
        role,
        name,
        reason: "Approved paralegal account with no application activity yet.",
        ageDays: approvedDays,
      };
      paralegalNoApplication.push(entry);
      stalledUserIds.add(id);
      userSignals.push({
        priority: 75,
        sortDays: approvedDays,
        id,
        title: `${name} · paralegal`,
        reason: "Approved, but no application activity is visible yet.",
        tone: "active",
      });
    }

    if (userSignals.length) {
      const dominantSignal = userSignals.sort(
        (left, right) => Number(right.priority || 0) - Number(left.priority || 0) ||
          Number(right.sortDays || 0) - Number(left.sortDays || 0) ||
          String(left.title || "").localeCompare(String(right.title || ""))
      )[0];
      followUpCandidates.push(dominantSignal);
    }
  });

  followUpCandidates.sort(
    (left, right) => Number(right.priority || 0) - Number(left.priority || 0) ||
      Number(right.sortDays || 0) - Number(left.sortDays || 0) ||
      String(left.title || "").localeCompare(String(right.title || ""))
  );

  const followUpTodayCount = followUpCandidates.length;
  const followUpToday = followUpCandidates.slice(0, 8).map(({ priority, sortDays, ...signal }) => signal);
  const stalledCount = stalledUserIds.size;

  let recommendation = "No lifecycle follow-up signals are currently visible.";
  if (stripeIncomplete.length) {
    recommendation = "Follow up with approved paralegals who still have incomplete Stripe onboarding before lower-priority lifecycle outreach.";
  } else if (pendingIncomplete.length) {
    recommendation = "Follow up with pending users who are missing core profile fields before they go cold.";
  } else if (attorneyNoMatter.length) {
    recommendation = "Follow up with approved attorneys who have not posted a matter yet.";
  } else if (paralegalNoApplication.length) {
    recommendation = "Follow up with approved paralegals who have not applied to any matters yet.";
  } else if (approvedInactive.length) {
    recommendation = "Follow up with approved but inactive users before routine lifecycle cleanup.";
  }

  return {
    pendingIncomplete,
    stripeIncomplete,
    approvedInactive,
    attorneyNoMatter,
    paralegalNoApplication,
    followUpToday,
    followUpTodayCount,
    stalledCount,
    recommendation,
  };
}

function getLifecycleActionUserId(action = {}) {
  const subjectType = String(action.subject?.entityType || "").trim().toLowerCase();
  if (subjectType === "user" && action.subject?.entityId) {
    return String(action.subject.entityId);
  }
  if (action.related?.userId) {
    return String(action.related.userId);
  }
  return "";
}

function mergeLifecycleSnapshot({ eventLifecycle = {}, legacyLifecycle = {} } = {}) {
  const actionItems = Array.isArray(eventLifecycle.latestItems) ? eventLifecycle.latestItems : [];
  const legacyFollowUps = Array.isArray(legacyLifecycle.followUpToday) ? legacyLifecycle.followUpToday : [];
  const actionGroupedCounts = eventLifecycle.groupedCounts || {};

  const userFollowUpMap = new Map();
  const publicContactItems = [];
  const stalledUserIds = new Set();

  const addLegacyUserItem = (item = {}, titleFallback = "Lifecycle follow-up") => {
    const id = String(item?.id || "").trim();
    if (!id) return;
    stalledUserIds.add(id);
    if (userFollowUpMap.has(id)) return;
    const title = compactText(item?.title || item?.name || titleFallback, 64);
    const reason = compactText(item?.reason || "", 140);
    userFollowUpMap.set(id, reason ? `${title}: ${reason}` : title);
  };

  (legacyLifecycle.pendingIncomplete || []).forEach((item) => addLegacyUserItem(item, "Pending profile"));
  (legacyLifecycle.stripeIncomplete || []).forEach((item) => addLegacyUserItem(item, "Stripe setup"));
  (legacyLifecycle.approvedInactive || []).forEach((item) => addLegacyUserItem(item, "Inactive approved user"));
  (legacyLifecycle.attorneyNoMatter || []).forEach((item) => addLegacyUserItem(item, "Attorney activation"));
  (legacyLifecycle.paralegalNoApplication || []).forEach((item) => addLegacyUserItem(item, "Paralegal activation"));

  legacyFollowUps.forEach((item) => {
    const id = String(item?.id || "").trim();
    const text = `${item.title}: ${compactText(item.reason || "", 140)}`;
    if (id) {
      stalledUserIds.add(id);
      userFollowUpMap.set(id, text);
    }
  });

  actionItems.forEach((action) => {
    const userId = getLifecycleActionUserId(action);
    const text = `${action.title}: ${compactText(action.summary || action.recommendedAction || "", 140)}`;
    if (userId) {
      stalledUserIds.add(userId);
      if (!userFollowUpMap.has(userId)) userFollowUpMap.set(userId, text);
      return;
    }
    publicContactItems.push(text);
  });

  const followUpToday = [...Array.from(userFollowUpMap.values()), ...publicContactItems].slice(0, 12);
  const followUpTodayCount = Math.max(
    userFollowUpMap.size + publicContactItems.length,
    Number(legacyLifecycle.followUpTodayCount || 0) + publicContactItems.length
  );
  const stalledCount = stalledUserIds.size + publicContactItems.length;
  const legacyCompatibilityCount = Math.max(
    0,
    stalledUserIds.size - Number(eventLifecycle.totalOpen || 0)
  );

  let recommendation = eventLifecycle.totalOpen ? eventLifecycle.recommendation : legacyLifecycle.recommendation;
  if (!recommendation || /No lifecycle follow-up signals/i.test(recommendation)) {
    recommendation = legacyLifecycle.recommendation || recommendation;
  }
  if (!recommendation) {
    recommendation = followUpTodayCount
      ? "Review the visible lifecycle follow-ups before lower-priority queue work."
      : "No lifecycle follow-up signals are currently visible.";
  }

  return {
    ...legacyLifecycle,
    ...eventLifecycle,
    followUpToday,
    followUpTodayCount,
    stalledCount,
    recommendation,
    groupedCounts: {
      signupReview: Number(actionGroupedCounts.signupReview || 0),
      incompleteProfile: Math.max(
        Number(actionGroupedCounts.incompleteProfile || 0),
        Number((legacyLifecycle.pendingIncomplete || []).length)
      ),
      publicContact: Number(actionGroupedCounts.publicContact || 0),
    },
    eventBackedOpenCount: Number(eventLifecycle.totalOpen || 0),
    publicContactOpenCount: publicContactItems.length,
    legacyCompatibilityCount,
    hasLegacyCompatibility: legacyCompatibilityCount > 0,
  };
}

function mergeFounderSnapshot({ eventFounder = {}, lifecycle = {}, payments = {} } = {}) {
  const fallbackUrgentItems = [
    ...(payments.openDisputes || []).slice(0, 2).map((item) => ({
      count: 1,
      title: compactText(item.caseTitle || "Open dispute", 52),
      tone: "priority",
      badge: "Risk",
      body: `${compactText(item.disputeMessage || "Open dispute raised.", 120)} Review is still open.`,
    })),
    ...(payments.moneyIncidents || []).slice(0, 2).map((incident) => ({
      count: 1,
      title: buildIncidentEscalationTitle(incident),
      tone: toneFromRisk(incident.classification?.riskLevel || incident.classification?.severity),
      badge: "Money Risk",
      body: buildIncidentLine(incident),
    })),
  ].slice(0, 4);

  const useFallbackUrgent = !Number(eventFounder.urgentCount || 0) && fallbackUrgentItems.length > 0;
  const urgentItems = useFallbackUrgent ? fallbackUrgentItems : eventFounder.urgentItems || [];
  const urgentCount = useFallbackUrgent ? fallbackUrgentItems.length : Number(eventFounder.urgentCount || 0);
  const lifecycleReviewCount = Number(lifecycle.followUpTodayCount || 0);
  const reviewCount = Math.max(Number(eventFounder.reviewCount || 0), urgentCount + lifecycleReviewCount);

  let recommendation = eventFounder.recommendation;
  if (useFallbackUrgent) {
    recommendation =
      "Review money-risk and dispute items first because they remain founder-priority operational risks.";
  } else if (!urgentCount && lifecycleReviewCount) {
    recommendation = "Review the open lifecycle follow-ups and clear the oldest operational nudges first.";
  } else if (!recommendation) {
    recommendation = "No founder-priority items are currently visible.";
  }

  return {
    ...eventFounder,
    urgentItems,
    urgentCount,
    reviewCount,
    recommendation,
    fallbackUrgentCount: useFallbackUrgent ? fallbackUrgentItems.length : 0,
    usesFallbackUrgent: useFallbackUrgent,
  };
}

async function getMarketingSnapshot() {
  const [overview, publishingOverview] = await Promise.all([getMarketingOverview(), getPublishingOverview()]);
  const blockedCycleCount = Number(publishingOverview?.counts?.blocked || 0);
  const openCycleCount = Number(publishingOverview?.openCycleCount || 0);

  let recommendation = "No marketing review or publishing blockers are currently visible.";
  if (blockedCycleCount) {
    recommendation = "Review blocked marketing publishing cycles first because they can stall approved outbound work.";
  } else if (overview.counts.pendingReview) {
    recommendation = "Review the newest founder-facing marketing draft packets before creating more.";
  } else if (openCycleCount) {
    recommendation = "Review the live marketing publishing cycles and confirm they are moving cleanly.";
  }

  return {
    pendingReviewCount: overview.counts.pendingReview,
    packetsCount: overview.counts.packets,
    approvedCount: overview.counts.approved,
    blockedCycleCount,
    openCycleCount,
    latestPackets: overview.latestPackets,
    recommendation,
  };
}

async function getSalesSnapshot() {
  const overview = await getSalesOverview();
  return {
    pendingReviewCount: overview.counts.pendingReview,
    accountsCount: overview.counts.accounts,
    interactionsCount: overview.counts.interactions,
    packetsCount: overview.counts.packets,
    latestAccounts: overview.latestAccounts,
    latestPackets: overview.latestPackets,
    recommendation: overview.counts.pendingReview
      ? "Review the newest sales packets before any outreach or answer draft is used externally."
      : overview.counts.accounts
        ? "No sales packets are currently awaiting Samantha review."
        : "No sales accounts are currently active.",
  };
}

async function getEngineeringSnapshot() {
  const overview = await getEngineeringOverview();
  return {
    activeCount: Number(overview?.summary?.activeCount || 0),
    blockedCount: Number(overview?.summary?.blockedCount || 0),
    awaitingApprovalCount: Number(overview?.summary?.awaitingApprovalCount || 0),
    readyForTestCount: Number(overview?.summary?.readyForTestCount || 0),
    resolvedTodayCount: Number(overview?.summary?.resolvedTodayCount || 0),
    recommendation: overview?.summary?.recommendation || "No engineering work is currently visible.",
    guardrail: overview?.summary?.guardrail || "",
  };
}

async function getProductSnapshot() {
  const [openIncidents, activeInsightCount, patternAlertCount] = await Promise.all([
    getOpenIncidentsForWarRoom(),
    SupportInsight.countDocuments({ state: "active" }),
    SupportInsight.countDocuments({ state: "active", priority: "needs_review" }),
  ]);

  const productIncidents = openIncidents
    .filter((incident) => !isMoneyIncident(incident) && isProductIncident(incident))
    .sort((a, b) => incidentSeverityWeight(b) - incidentSeverityWeight(a));
  const priorityIssueCount = productIncidents.filter((incident) => {
    const severity = String(incident.classification?.severity || "").toLowerCase();
    const riskLevel = String(incident.classification?.riskLevel || "").toLowerCase();
    const state = String(incident.state || "").toLowerCase();
    return (
      ["high", "critical"].includes(severity) ||
      riskLevel === "high" ||
      ["verification_failed", "deploy_failed", "needs_more_context", "needs_human_owner"].includes(state)
    );
  }).length;

  let recommendation = "No live product issues or repeated customer patterns are currently visible.";
  if (priorityIssueCount) {
    recommendation = "Review the highest-risk product incidents first because live user workflow problems are still open.";
  } else if (productIncidents.length && patternAlertCount) {
    recommendation = "Review open product incidents alongside repeated customer patterns before lower-priority cleanup.";
  } else if (productIncidents.length) {
    recommendation = "Review the open product-impact incidents before lower-priority queue cleanup.";
  } else if (patternAlertCount) {
    recommendation = "Review the repeated customer friction patterns and decide whether they need incident promotion or knowledge updates.";
  }

  return {
    openIssueCount: productIncidents.length,
    priorityIssueCount,
    activeInsightCount: Number(activeInsightCount || 0),
    patternAlertCount: Number(patternAlertCount || 0),
    recommendation,
  };
}

async function getAdminOpsSnapshot() {
  const overview = await getApprovalWorkspaceOverview();
  return {
    pendingApprovalCount: Number(overview?.counts?.pending || 0),
    knowledgeApprovalCount: Number(overview?.counts?.knowledge || 0),
    latestItems: Array.isArray(overview?.latestItems) ? overview.latestItems : [],
    recommendation:
      Number(overview?.counts?.pending || 0) > 0
        ? "Clear the pending approval queue before adding more governed admin work."
        : "No cross-functional approval tasks are currently waiting in the admin workspace.",
  };
}

async function getEngineeringIncidentSnapshot() {
  const openIncidents = await getOpenIncidentsForWarRoom();
  const blockedCount = openIncidents.filter(isBlockedIncident).length;
  const priorityCount = openIncidents.filter(isPriorityIncident).length;

  let recommendation = "No open incidents are currently visible.";
  if (blockedCount) {
    recommendation = "Review blocked incidents first because engineering work is currently stuck in a non-terminal state.";
  } else if (priorityCount) {
    recommendation = "Review the highest-risk open incidents before lower-priority engineering cleanup.";
  } else if (openIncidents.length) {
    recommendation = "Review the newest open incidents and clear the oldest unresolved engineering work first.";
  }

  return {
    openCount: openIncidents.length,
    blockedCount,
    priorityCount,
    recommendation,
  };
}

function buildAiControlRoomCards({
  admissions,
  support,
  payments,
  lifecycle,
  marketing,
  sales,
  engineeringIncident,
}) {
  const cmoStatus = buildExecutiveStatus({
    review: Number(marketing.pendingReviewCount || 0) > 0,
  });
  const ctoStatus = buildExecutiveStatus({
    priority: Number(engineeringIncident.blockedCount || 0) > 0 || Number(engineeringIncident.priorityCount || 0) > 0,
    review: Number(engineeringIncident.openCount || 0) > 0,
  });
  const cfoStatus = buildExecutiveStatus({
    priority: Number(payments.moneyIssueCount || 0) > 0,
    review: Number(payments.openDisputesCount || 0) > 0,
  });
  const cooStatus = buildExecutiveStatus({
    priority: Number((lifecycle.stripeIncomplete || []).length || 0) > 0,
    review: Number(lifecycle.stalledCount || 0) > 0 || Number(lifecycle.followUpTodayCount || 0) > 0,
  });
  const csoStatus = buildExecutiveStatus({
    review: Number(sales.pendingReviewCount || 0) > 0,
  });
  const ccoStatus = buildExecutiveStatus({
    priority: Number(support.escalationCount || 0) > 0,
    review: Number(support.activeIssueCount || 0) > 0,
  });
  const caoStatus = buildExecutiveStatus({
    review: Number(admissions.attorneyCount || 0) > 0 || Number(admissions.paralegalCount || 0) > 0,
  });
  const cpoStatus = buildExecutiveStatus({ unavailable: true });

  return [
    buildExecutiveCard({
      key: "cmo",
      title: "CMO",
      department: "Marketing",
      status: cmoStatus.status,
      tone: cmoStatus.tone,
      description: "Oversees founder-reviewed marketing draft volume and outbound packet readiness on LPC.",
      metric1: { label: "Pending review", value: marketing.pendingReviewCount },
      metric2: { label: "Draft packets", value: marketing.packetsCount },
      recommendedAction: marketing.recommendation,
      footerNote: "Source: MarketingDraftPacket records. Publishing state is not shown on this card.",
      actionButton: { label: "Open Marketing", targetTab: "marketing-drafts" },
    }),
    buildExecutiveCard({
      key: "cto",
      title: "CTO",
      department: "Engineering",
      status: ctoStatus.status,
      tone: ctoStatus.tone,
      description: "Oversees live incident load and blocked engineering work across LPC.",
      metric1: { label: "Open incidents", value: engineeringIncident.openCount },
      metric2: { label: "Blocked incidents", value: engineeringIncident.blockedCount },
      recommendedAction: engineeringIncident.recommendation,
      footerNote: "Source: Incident collection only. Blocked counts are derived from non-terminal blocker states.",
      actionButton: { label: "Open Engineering", targetTab: "engineering" },
    }),
    buildExecutiveCard({
      key: "cfo",
      title: "CFO",
      department: "Payments & Risk",
      status: cfoStatus.status,
      tone: cfoStatus.tone,
      description: "Oversees dispute exposure and money-sensitive incident risk.",
      metric1: { label: "Open disputes", value: payments.openDisputesCount },
      metric2: { label: "Money issues", value: payments.moneyIssueCount },
      recommendedAction: payments.recommendation,
      footerNote: "Disputes live on Case records; money issues come from Incident risk classification.",
      actionButton: { label: "Open Disputes", targetTab: "disputes" },
    }),
    buildExecutiveCard({
      key: "coo",
      title: "COO",
      department: "Operations",
      status: cooStatus.status,
      tone: cooStatus.tone,
      description: "Oversees stalled user operations and the current lifecycle follow-up load.",
      metric1: { label: "Stalled users", value: lifecycle.stalledCount },
      metric2: { label: "Follow-ups today", value: lifecycle.followUpTodayCount },
      recommendedAction: lifecycle.recommendation,
      footerNote: lifecycle.hasLegacyCompatibility
        ? "Lifecycle counts blend event-backed follow-ups with legacy compatibility signals."
        : "Source: lifecycle follow-up system and live user activity.",
      actionButton: { label: "Open Operations", targetTab: "user-management" },
    }),
    buildExecutiveCard({
      key: "cso",
      title: "CSO",
      department: "Sales",
      status: csoStatus.status,
      tone: csoStatus.tone,
      description: "Oversees awareness accounts and the current sales review workload.",
      metric1: { label: "Pending review", value: sales.pendingReviewCount },
      metric2: { label: "Active accounts", value: sales.accountsCount },
      recommendedAction: sales.recommendation,
      footerNote: "Source: SalesAccount and SalesDraftPacket records. No outbound sending is automated here.",
      actionButton: { label: "Open Sales", targetTab: "sales-workspace" },
    }),
    buildExecutiveCard({
      key: "cco",
      title: "CCO",
      department: "Customer Support",
      status: ccoStatus.status,
      tone: ccoStatus.tone,
      description: "Oversees open support workload and tickets that have already escalated.",
      metric1: { label: "Open support issues", value: support.activeIssueCount },
      metric2: { label: "Escalations", value: support.escalationCount },
      recommendedAction: support.recommendation,
      footerNote: "Source: SupportTicket collection. Escalations include high-priority and handed-off tickets.",
      actionButton: { label: "Open Support", targetTab: "support-ops" },
    }),
    buildExecutiveCard({
      key: "cpo",
      title: "CPO",
      department: "Product",
      status: cpoStatus.status,
      tone: cpoStatus.tone,
      description: "Will surface product issue and roadmap signal quality once a dedicated product source exists.",
      metric1: { label: "Open product issues", value: null },
      metric2: { label: "Pattern alerts", value: null },
      recommendedAction: "No standalone product data source exists yet for this dashboard.",
      footerNote: "No dedicated product collection is wired into the admin control room yet.",
      actionButton: { label: "Coming Soon", targetTab: "", disabled: true },
    }),
    buildExecutiveCard({
      key: "cao",
      title: "CAO",
      department: "Admissions",
      status: caoStatus.status,
      tone: caoStatus.tone,
      description: "Oversees pending attorney and paralegal admissions review volume.",
      metric1: { label: "Attorney review", value: admissions.attorneyCount },
      metric2: { label: "Paralegal review", value: admissions.paralegalCount },
      recommendedAction: admissions.recommendation,
      footerNote: "Source: pending User admissions records. Completeness remains heuristic until reviewed.",
      actionButton: { label: "Open Admissions", targetTab: "user-management" },
    }),
  ];
}

async function getControlRoomHealthSnapshot() {
  if (mongoose.connection.readyState !== 1) {
    return {
      value: "Degraded",
      note: "Database connectivity is degraded. Control Room health is not fully available.",
      tone: "blocked",
    };
  }

  const now = new Date();
  const [queuedJobCount, overdueJobCount, oldestOverdueJob] = await Promise.all([
    Incident.countDocuments({
      state: { $in: OPEN_INCIDENT_STATES },
      "orchestration.nextJobType": { $in: ACTIVE_INCIDENT_JOB_TYPES },
    }),
    Incident.countDocuments({
      state: { $in: OPEN_INCIDENT_STATES },
      "orchestration.nextJobType": { $in: ACTIVE_INCIDENT_JOB_TYPES },
      "orchestration.nextJobRunAt": { $lte: now },
    }),
    Incident.findOne({
      state: { $in: OPEN_INCIDENT_STATES },
      "orchestration.nextJobType": { $in: ACTIVE_INCIDENT_JOB_TYPES },
      "orchestration.nextJobRunAt": { $lte: now },
    })
      .sort({ "orchestration.nextJobRunAt": 1, updatedAt: 1, createdAt: 1 })
      .select("publicId orchestration.nextJobType orchestration.nextJobRunAt")
      .lean(),
  ]);

  if (!overdueJobCount) {
    return {
      value: "Stable",
      note: queuedJobCount
        ? `${pluralize(queuedJobCount, "incident job")} queued with no overdue work visible.`
        : "No queued incident work is currently overdue.",
      tone: "healthy",
    };
  }

  const oldestMinutes = minutesSince(oldestOverdueJob?.orchestration?.nextJobRunAt);
  const oldestLabel = oldestOverdueJob?.publicId
    ? ` Oldest: ${oldestOverdueJob.publicId} waiting on ${oldestOverdueJob.orchestration?.nextJobType || "work"} for ${oldestMinutes}m.`
    : "";

  if (oldestMinutes >= 15) {
    return {
      value: "Needs Review",
      note: `${pluralize(overdueJobCount, "incident job")} overdue in the incident pipeline.${oldestLabel}`,
      tone: "blocked",
    };
  }

  return {
    value: "Watch",
    note: `${pluralize(overdueJobCount, "incident job")} overdue in the incident pipeline.${oldestLabel}`,
    tone: "priority",
  };
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function createNavAction(navSection = "", label = "Open") {
  return {
    kind: "nav",
    label,
    navSection,
    disabled: !navSection,
  };
}

function createApprovalDecisionAction(workKey = "", decision = "") {
  return {
    kind: "approval_item",
    label: decision === "approve" ? "Yes" : "No",
    workKey,
    decision,
    disabled: !workKey || !decision,
  };
}

function createIncidentDecisionAction({ incidentId = "", approvalId = "", decision = "" } = {}) {
  return {
    kind: "incident_approval",
    label: decision === "approve" ? "Yes" : "No",
    incidentId,
    approvalId,
    decision,
    disabled: !incidentId || !approvalId || !decision,
  };
}

function createUserReviewAction(userId = "", decision = "") {
  return {
    kind: "user_review",
    label: decision === "approve" ? "Yes" : "No",
    userId,
    decision,
    disabled: !userId || !decision,
  };
}

function createAutonomyPreferenceAction({ agentRole = "", actionType = "", decision = "" } = {}) {
  return {
    kind: "autonomy_preference",
    label: decision === "enable" ? "Enable Auto" : "Keep Reviewing",
    agentRole,
    actionType,
    decision,
    disabled: !agentRole || !actionType || !decision,
  };
}

function createDecisionGroupAction({ groupKey = "", decision = "", batchActions = [] } = {}) {
  return {
    kind: "decision_group",
    label: decision === "approve" ? "Yes" : "No",
    groupKey,
    decision,
    batchActions: Array.isArray(batchActions) ? batchActions.filter(Boolean) : [],
    disabled: !groupKey || !decision || !Array.isArray(batchActions) || batchActions.length === 0,
  };
}

function withActionUiCopy(action = null, { label = "", successMessage = "" } = {}) {
  if (!action) return null;
  return {
    ...action,
    label: label || action.label || "",
    successMessage: successMessage || action.successMessage || "",
  };
}

function urgencyLabelFromTone(tone = "") {
  const normalized = String(tone || "").trim().toLowerCase();
  if (normalized === "priority") return "Urgent today";
  if (normalized === "needs-review") return "Needs attention today";
  if (normalized === "active") return "Can wait if higher-priority work exists";
  return "Informational";
}

function createControlRoomLaneRegistry() {
  return Object.keys(CONTROL_ROOM_DECISION_POLICY).reduce((registry, laneKey) => {
    registry[laneKey] = {
      decisionItems: [],
      autoHandledItems: [],
      blockedItems: [],
      infoItems: [],
    };
    return registry;
  }, {});
}

function applyControlRoomPolicyToItem({
  laneKey = "",
  policyType = "",
  item = {},
  hasExecutionPath = false,
} = {}) {
  const evaluation = evaluateControlRoomPolicy({ laneKey, itemType: policyType, hasExecutionPath });
  return {
    ...item,
    laneKey: evaluation.laneKey || item.laneKey || "",
    agentRole: item.agentRole || "",
    policyType: evaluation.itemType,
    policy: {
      autoHandled: evaluation.isAutoHandled,
      founderDecision: evaluation.isFounderDecision,
      blocked: evaluation.isBlocked,
      informational: evaluation.isInformational,
      neverQuickApprove: evaluation.isNeverQuickApprove,
      canQuickApprove: evaluation.canQuickApprove,
    },
    actions: {
      yes: evaluation.canQuickApprove ? item.actions?.yes || null : null,
      no: evaluation.canQuickApprove ? item.actions?.no || null : null,
      open: item.actions?.open || null,
      edit: evaluation.canQuickApprove ? item.actions?.edit || null : null,
    },
  };
}

function registerControlRoomItem(registry, item = {}) {
  const laneKey = String(item.laneKey || "").trim().toLowerCase();
  const lane = registry[laneKey];
  if (!lane) return item;

  if (item.policy?.founderDecision) lane.decisionItems.push(item);
  if (item.policy?.autoHandled) lane.autoHandledItems.push(item);
  if (item.policy?.blocked) lane.blockedItems.push(item);
  if (item.policy?.informational || item.policy?.neverQuickApprove) lane.infoItems.push(item);

  return item;
}

function registerAutonomousControlRoomItem(registry, item = {}) {
  const normalizedItem = {
    ...item,
    policyType: item.policyType || item.actionType || "",
    policy: {
      autoHandled: true,
      founderDecision: false,
      blocked: false,
      informational: false,
      neverQuickApprove: false,
      canQuickApprove: false,
    },
  };
  const laneKey = String(normalizedItem.laneKey || "").trim().toLowerCase();
  const lane = registry[laneKey];
  if (!lane) return normalizedItem;
  lane.autoHandledItems.push(normalizedItem);
  return normalizedItem;
}

function confidenceFromText(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "high") return 0.92;
  if (normalized === "medium") return 0.74;
  if (normalized === "low") return 0.56;
  return null;
}

function decisionPriority(item = {}) {
  const lane = String(item.laneKey || "").toLowerCase();
  const tone = String(item.tone || "").toLowerCase();
  const base = lane === "cto" ? 500 : lane === "cco" ? 450 : lane === "cmo" ? 400 : lane === "cso" ? 350 : lane === "cao" ? 300 : 200;
  const toneBoost = tone === "priority" ? 50 : tone === "needs-review" ? 25 : 0;
  const blockedBoost = item.blocksProgress === true ? 20 : 0;
  return base + toneBoost + blockedBoost;
}

function compareDecisionItems(left = {}, right = {}) {
  const priorityDelta = decisionPriority(right) - decisionPriority(left);
  if (priorityDelta) return priorityDelta;
  return new Date(right.updatedAt || right.createdAt || 0).getTime() - new Date(left.updatedAt || left.createdAt || 0).getTime();
}

function buildApprovalDecisionItem(item = {}, config = {}) {
  const navSection = config.navSection || "";
  const itemType = String(item.itemType || "").trim();
  const preview = item.summary || item.subtitle || "";
  const tone = item.riskLevel === "high" ? "priority" : "needs-review";
  const clarity =
    itemType === "marketing_draft_packet"
      ? {
          title: "Publish LinkedIn post",
          explanation: "This post is ready, and your Yes will move it into the approved outbound queue.",
          cardBody: "One public post is waiting on your yes or no.",
          proposedAction: "Publish this LinkedIn company post through the current marketing workflow.",
          actionHelperText: "Yes will approve this LinkedIn post for external use. No will keep it out of the approved queue.",
          yesLabel: "Yes, publish post",
          noLabel: "No, keep out",
          yesSuccessMessage: "LinkedIn post approved. It can now move forward in the existing publishing workflow.",
          noSuccessMessage: "LinkedIn post held back. It will stay out of the approved outbound queue.",
        }
      : itemType === "sales_draft_packet"
        ? {
            title: "Send outreach message",
            explanation: "This message is ready, and your Yes will make it available for governed outbound use.",
            cardBody: "One outreach message is waiting on your yes or no.",
            proposedAction: "Send this outreach in the existing governed sales workflow.",
            actionHelperText: "Yes will allow this outreach message into governed outbound use. No will keep it out of outbound use.",
            yesLabel: "Yes, allow outreach",
            noLabel: "No, hold draft",
            yesSuccessMessage: "Outreach draft approved. It is now available for the existing outbound workflow.",
            noSuccessMessage: "Outreach draft held back. It will not be used in outreach.",
          }
        : itemType === "faq_candidate"
          ? {
              title: "Use this support answer",
              explanation: "Support is waiting on one governed answer, and your Yes will let the team use it.",
              cardBody: "One support answer is waiting on your yes or no.",
              proposedAction: "Use this answer in the governed support workflow.",
              actionHelperText:
                "Yes will let support use this answer as governed language. No will keep it out of the FAQ queue. No customer message is sent automatically.",
              yesLabel: "Yes, use answer",
              noLabel: "No, keep out",
              yesSuccessMessage: "Support answer approved. Support can now use it as governed language.",
              noSuccessMessage: "Support answer held back. Support will not use it as governed language.",
            }
          : {
              title: item.title || "Move this item forward",
              explanation:
                item.whatStillNeedsSamantha?.[0] ||
                item.subtitle ||
                "This governed item is waiting on a yes or no before the workflow can continue.",
              cardBody: "One governed item is waiting on your yes or no.",
              proposedAction: "Move this item forward in the current workflow.",
              actionHelperText: "Yes will move this item forward in the current workflow. No will keep it out of the active queue.",
              yesLabel: "Yes, move forward",
              noLabel: "No, keep paused",
              yesSuccessMessage: "Approval recorded.",
              noSuccessMessage: "Rejection recorded.",
            };

  return {
    id: item.workKey,
    laneKey: config.laneKey || "",
    agentRole: config.agentRole || "",
    actionType: itemType,
    decisionContext:
      itemType === "marketing_draft_packet"
        ? "marketing_draft"
        : itemType === "sales_draft_packet"
          ? "sales_outreach"
          : itemType === "faq_candidate"
            ? "support_answer"
            : itemType || "approval_item",
    title: compactText(clarity.title || item.title || "Move this item forward", 72),
    explanation: compactText(clarity.explanation, 180),
    cardBody: compactText(clarity.cardBody, 140),
    preview: compactText(preview, 180),
    proposedAction: compactText(clarity.proposedAction, 180),
    actionHelperText: compactText(clarity.actionHelperText, 200),
    urgencyLabel: urgencyLabelFromTone(tone),
    tone,
    blocksProgress: true,
    confidenceScore: null,
    confidenceReason: "",
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
    actions: {
      yes: withActionUiCopy(createApprovalDecisionAction(item.workKey, "approve"), {
        label: clarity.yesLabel,
        successMessage: clarity.yesSuccessMessage,
      }),
      no: withActionUiCopy(createApprovalDecisionAction(item.workKey, "reject"), {
        label: clarity.noLabel,
        successMessage: clarity.noSuccessMessage,
      }),
      open: createNavAction(navSection, "Open Details"),
      edit:
        config.allowEdit === true
          ? createNavAction(config.editSection || navSection, "Edit")
          : null,
    },
  };
}

function buildIncidentApprovalDecisionItem(incident = {}) {
  const confidenceScore = confidenceFromText(incident.classification?.confidence);
  return {
    id: incident.id || incident.publicId || "",
    laneKey: "cto",
    agentRole: "CTO",
    actionType: "incident_approval",
    decisionContext: "incident_fix",
    title: compactText("Approve engineering fix for incident", 72),
    explanation: compactText(
      "Engineering is paused here, and your Yes will let the current fix path continue.",
      180
    ),
    cardBody: "One engineering fix is waiting on your yes or no.",
    preview: compactText(
      incident.summary ||
        `State ${incident.state || "unknown"}. Approval ${incident.approvalState || "pending"}. ${incident.userVisibleStatus || incident.adminVisibleStatus || ""}`.trim(),
      180
    ),
    proposedAction: "Move this incident fix forward in the current engineering workflow.",
    actionHelperText: "Yes will let the current engineering fix path continue. No will keep this fix paused for review.",
    urgencyLabel: urgencyLabelFromTone(
      incident.classification?.riskLevel === "high" ? "priority" : "needs-review"
    ),
    tone: incident.classification?.riskLevel === "high" ? "priority" : "needs-review",
    blocksProgress: true,
    confidenceScore,
    confidenceReason: confidenceScore
      ? `Incident classification confidence is ${String(incident.classification?.confidence || "").toLowerCase()}.`
      : "",
    createdAt: incident.createdAt || null,
    updatedAt: incident.updatedAt || null,
    actions: {
      yes: withActionUiCopy(
        createIncidentDecisionAction({
          incidentId: incident.publicId || incident.id,
          approvalId: incident.currentApprovalId || "",
          decision: "approve",
        }),
        {
          label: "Yes, move fix forward",
          successMessage: "Engineering approval recorded. The existing release path can continue.",
        }
      ),
      no: withActionUiCopy(
        createIncidentDecisionAction({
          incidentId: incident.publicId || incident.id,
          approvalId: incident.currentApprovalId || "",
          decision: "reject",
        }),
        {
          label: "No, keep paused",
          successMessage: "Engineering rejection recorded. The release path stays paused for review.",
        }
      ),
      open: createNavAction("engineering", "Open Details"),
      edit: null,
    },
  };
}

function buildAdmissionsDecisionItem(item = {}) {
  const missingLine = item.missing?.length ? ` Missing: ${item.missing.join(", ")}.` : " Visible core fields are present.";
  return {
    id: String(item.id || ""),
    laneKey: "cao",
    agentRole: "CAO",
    actionType: "admissions_review",
    decisionContext: "admissions_application",
    title: compactText("Approve applicant for admissions", 72),
    explanation: compactText(
      item.readyForFounderReview
        ? "This application is ready, and your Yes will move the applicant through admissions."
        : item.recommendation || "This application is ready for a yes or no in the current admissions flow.",
      180
    ),
    cardBody: "One admissions decision is waiting on your yes or no.",
    preview: compactText(`${item.outboundMessage || "Pending application review."}${missingLine}`, 180),
    proposedAction: "Move this applicant through the existing admissions workflow.",
    actionHelperText: "Yes will approve this applicant. No will deny the application in the current admissions route.",
    urgencyLabel: urgencyLabelFromTone(item.riskLevel === "high" ? "priority" : "needs-review"),
    tone: item.riskLevel === "high" ? "priority" : "needs-review",
    blocksProgress: true,
    confidenceScore: null,
    confidenceReason: "",
    createdAt: item.createdAt || null,
    updatedAt: item.createdAt || null,
    actions: {
      yes: withActionUiCopy(createUserReviewAction(String(item.id || ""), "approve"), {
        label: "Yes, admit applicant",
        successMessage: "Applicant approved through the existing admissions workflow.",
      }),
      no: withActionUiCopy(createUserReviewAction(String(item.id || ""), "deny"), {
        label: "No, deny application",
        successMessage: "Applicant denied through the existing admissions workflow.",
      }),
      open: createNavAction("user-management", "Open Details"),
      edit: null,
    },
  };
}

function serializeDecisionBatchAction(action = null) {
  if (!action || typeof action !== "object") return null;
  return {
    kind: String(action.kind || "").trim(),
    decision: String(action.decision || "").trim(),
    workKey: String(action.workKey || "").trim(),
    incidentId: String(action.incidentId || "").trim(),
    approvalId: String(action.approvalId || "").trim(),
    userId: String(action.userId || "").trim(),
    agentRole: String(action.agentRole || "").trim(),
    actionType: String(action.actionType || "").trim(),
  };
}

function getDecisionGroupingConfig(item = {}) {
  const laneKey = String(item.laneKey || "").trim().toLowerCase();
  const policyType = String(item.policyType || item.actionType || "").trim();
  if (!laneKey || !policyType) return null;

  if (laneKey === "cco" && policyType === "faq_candidate") {
    return {
      contextKey: "support_answer",
      title: (count) => `${count} support answers ready to use`,
      explanation: (count) =>
        `${pluralize(count, "governed support answer")} are waiting on the same yes or no, and your Yes will let support use all ${count}.`,
      cardBody: (count) => `${count} support answers are paused at the same governed approval step.`,
      proposedAction: (count) => `Use all ${count} answers in the governed support workflow.`,
      actionHelperText: (count) =>
        `Yes will let support use all ${count} answers as governed language. No will keep all ${count} out of the FAQ queue. No customer message is sent automatically.`,
      yesLabel: "Yes, use all",
      noLabel: "No, keep all out",
      yesSuccessMessage: (count) =>
        `${pluralize(count, "support answer")} approved. Support can now use all ${count} as governed language.`,
      noSuccessMessage: (count) =>
        `${pluralize(count, "support answer")} held back. Support will not use them as governed language.`,
    };
  }

  if (laneKey === "cmo" && policyType === "marketing_draft_packet") {
    return {
      contextKey: "marketing_draft",
      title: (count) => `${count} posts ready to publish`,
      explanation: (count) =>
        `${count} public posts are waiting on the same yes or no, and your Yes will move all ${count} into the approved outbound queue.`,
      cardBody: (count) => `${count} LinkedIn posts are waiting on the same founder decision.`,
      proposedAction: (count) => `Publish all ${count} LinkedIn company posts through the current marketing workflow.`,
      actionHelperText: (count) =>
        `Yes will approve all ${count} LinkedIn posts for external use. No will keep all ${count} out of the approved queue.`,
      yesLabel: "Yes, publish all",
      noLabel: "No, keep all out",
      yesSuccessMessage: (count) =>
        `${count} LinkedIn ${count === 1 ? "post" : "posts"} approved. They can now move forward in the existing publishing workflow.`,
      noSuccessMessage: (count) =>
        `${count} LinkedIn ${count === 1 ? "post" : "posts"} held back. They will stay out of the approved outbound queue.`,
    };
  }

  if (laneKey === "cso" && policyType === "sales_draft_packet") {
    return {
      contextKey: "sales_outreach",
      title: (count) => `${count} outreach messages ready to send`,
      explanation: (count) =>
        `${count} outreach drafts are waiting on the same yes or no, and your Yes will make all ${count} available for governed outbound use.`,
      cardBody: (count) => `${count} outreach drafts are waiting on the same founder decision.`,
      proposedAction: (count) => `Send all ${count} outreach messages in the existing governed sales workflow.`,
      actionHelperText: (count) =>
        `Yes will allow all ${count} outreach messages into governed outbound use. No will keep all ${count} out of outbound use.`,
      yesLabel: "Yes, allow all",
      noLabel: "No, hold all",
      yesSuccessMessage: (count) =>
        `${count} outreach ${count === 1 ? "draft" : "drafts"} approved. They are now available for the existing outbound workflow.`,
      noSuccessMessage: (count) =>
        `${count} outreach ${count === 1 ? "draft" : "drafts"} held back. They will not be used in outreach.`,
    };
  }

  if (laneKey === "cto" && policyType === "incident_approval") {
    return {
      contextKey: "incident_fix",
      title: (count) => `${count} engineering fixes waiting on approval`,
      explanation: (count) =>
        `${count} incident fixes are paused at the same approval step, and your Yes will let all ${count} continue in the current engineering workflow.`,
      cardBody: (count) => `${count} engineering fixes are waiting on the same founder decision.`,
      proposedAction: (count) => `Move all ${count} incident fixes forward in the current engineering workflow.`,
      actionHelperText: (count) =>
        `Yes will let all ${count} engineering fixes continue. No will keep all ${count} paused for review.`,
      yesLabel: "Yes, move all forward",
      noLabel: "No, keep all paused",
      yesSuccessMessage: (count) =>
        `Engineering approvals recorded for ${pluralize(count, "incident")}. The existing fix paths can continue.`,
      noSuccessMessage: (count) =>
        `Engineering rejections recorded for ${pluralize(count, "incident")}. The fix paths stay paused for review.`,
    };
  }

  if (laneKey === "cao" && policyType === "admissions_review") {
    return {
      contextKey: "admissions_application",
      title: (count) => `${count} applicants ready for admissions`,
      explanation: (count) =>
        `${count} ready applications are waiting on the same yes or no, and your Yes will move all ${count} through the admissions workflow.`,
      cardBody: (count) => `${count} applications are waiting on the same founder decision.`,
      proposedAction: (count) => `Move all ${count} applicants through the existing admissions workflow.`,
      actionHelperText: (count) =>
        `Yes will approve all ${count} applicants. No will deny all ${count} applications in the current admissions route.`,
      yesLabel: "Yes, admit all",
      noLabel: "No, deny all",
      yesSuccessMessage: (count) =>
        `${pluralize(count, "applicant")} approved through the existing admissions workflow.`,
      noSuccessMessage: (count) =>
        `${pluralize(count, "application")} denied through the existing admissions workflow.`,
    };
  }

  return null;
}

function resolveGroupedDecisionConfidence(items = []) {
  const scores = items
    .map((item) => Number(item?.confidenceScore))
    .filter((value) => Number.isFinite(value));
  const reasons = [...new Set(items.map((item) => String(item?.confidenceReason || "").trim()).filter(Boolean))];
  const confidenceScore =
    scores.length === items.length && new Set(scores.map((value) => value.toFixed(4))).size === 1 ? scores[0] : null;
  const confidenceReason = reasons.length === 1 ? reasons[0] : "";
  return { confidenceScore, confidenceReason };
}

function buildGroupedDecisionItem({ groupKey = "", items = [], config = null } = {}) {
  if (!groupKey || !config || !Array.isArray(items) || items.length < 2) return null;
  const first = items[0] || {};
  const yesBatchActions = items.map((item) => serializeDecisionBatchAction(item?.actions?.yes)).filter(Boolean);
  const noBatchActions = items.map((item) => serializeDecisionBatchAction(item?.actions?.no)).filter(Boolean);
  if (yesBatchActions.length !== items.length || noBatchActions.length !== items.length) return null;

  const tone = items.some((item) => String(item?.tone || "").toLowerCase() === "priority")
    ? "priority"
    : first.tone || "needs-review";
  const latestUpdatedAt = items
    .map((item) => new Date(item?.updatedAt || item?.createdAt || 0).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
  const { confidenceScore, confidenceReason } = resolveGroupedDecisionConfidence(items);
  const count = items.length;

  return {
    id: `group:${groupKey}`,
    groupKey,
    groupCount: count,
    groupedItemIds: items.map((item) => String(item?.id || "")).filter(Boolean),
    laneKey: first.laneKey || "",
    agentRole: first.agentRole || "",
    actionType: String(first.actionType || first.policyType || ""),
    decisionContext: config.contextKey,
    policyType: String(first.policyType || first.actionType || ""),
    policy: first.policy || null,
    title: compactText(config.title(count), 72),
    explanation: compactText(config.explanation(count), 180),
    cardBody: compactText(config.cardBody(count), 140),
    preview: compactText(first.preview || "", 180),
    proposedAction: compactText(config.proposedAction(count), 180),
    actionHelperText: compactText(config.actionHelperText(count), 220),
    urgencyLabel: urgencyLabelFromTone(tone),
    tone,
    blocksProgress: true,
    confidenceScore,
    confidenceReason: compactText(confidenceReason, 180),
    createdAt: first.createdAt || null,
    updatedAt: Number.isFinite(latestUpdatedAt) && latestUpdatedAt > 0 ? new Date(latestUpdatedAt) : first.updatedAt || null,
    actions: {
      yes: withActionUiCopy(
        createDecisionGroupAction({
          groupKey,
          decision: "approve",
          batchActions: yesBatchActions,
        }),
        {
          label: config.yesLabel,
          successMessage: config.yesSuccessMessage(count),
        }
      ),
      no: withActionUiCopy(
        createDecisionGroupAction({
          groupKey,
          decision: "reject",
          batchActions: noBatchActions,
        }),
        {
          label: config.noLabel,
          successMessage: config.noSuccessMessage(count),
        }
      ),
      open: first.actions?.open || null,
      edit: null,
    },
  };
}

function groupFounderDecisionQueue(decisionItems = []) {
  const ordered = Array.isArray(decisionItems) ? decisionItems.slice().sort(compareDecisionItems) : [];
  const queue = [];
  const buckets = new Map();

  for (const item of ordered) {
    const config = getDecisionGroupingConfig(item);
    if (!config) {
      queue.push({ type: "single", item });
      continue;
    }
    const actionType = String(item.actionType || item.policyType || "").trim();
    const groupKey = `${String(item.agentRole || "").trim()}:${actionType}:${config.contextKey}`;
    const existing = buckets.get(groupKey);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const bucket = {
      type: "group",
      groupKey,
      config,
      items: [item],
    };
    buckets.set(groupKey, bucket);
    queue.push(bucket);
  }

  return queue.flatMap((entry) => {
    if (entry.type !== "group") return [entry.item];
    if (entry.items.length < 2) return entry.items;
    const grouped = buildGroupedDecisionItem(entry);
    return grouped ? [grouped] : entry.items;
  });
}

function buildAutonomousActionItem(action = {}) {
  const actionType = String(action.actionType || "").replace(/_/g, " ");
  const role = String(action.agentRole || "CCO").trim().toUpperCase();
  const clarity =
    action.actionType === "ticket_reopened"
      ? {
          laneKey: "cco",
          agentRole: "CCO",
          navSection: "support-ops",
          title: "Support reopened a ticket automatically",
          explanation: "A previously resolved support issue was reopened after the customer clearly said it was still broken.",
        }
      : action.actionType === "ticket_escalated"
        ? {
            laneKey: "cco",
            agentRole: "CCO",
            navSection: "support-ops",
            title: "Support escalated a ticket automatically",
            explanation: "The system handed the ticket to a human because the current support flow clearly required human help.",
          }
        : action.actionType === "incident_routed_from_support"
          ? {
              laneKey: "cco",
              agentRole: "CCO",
              navSection: "support-ops",
              title: "Support routed an issue into engineering automatically",
              explanation: "The system linked the support issue to engineering because the current signals pointed clearly to a product problem.",
            }
          : action.actionType === "support_governed_content_auto_approved"
            ? {
                laneKey: "cco",
                agentRole: "CCO",
                navSection: "support-ops",
                title: "Support approved a governed answer automatically",
                explanation: "The system approved a repeated safe support answer after founder-enabled autonomy and matching prior decisions.",
              }
            : action.actionType === "marketing_publish_auto_approved"
              ? {
                  laneKey: "cmo",
                  agentRole: "CMO",
                  navSection: "marketing-drafts",
                  title: "Marketing approved a LinkedIn post automatically",
                  explanation: "The system approved a LinkedIn company post automatically after repeated matching founder approvals.",
                }
              : action.actionType === "sales_outreach_auto_approved"
                ? {
                    laneKey: "cso",
                    agentRole: "CSO",
                    navSection: "sales-workspace",
                    title: "Sales approved an outreach draft automatically",
                    explanation: "The system approved an outreach draft automatically after repeated matching founder approvals.",
                  }
                : action.actionType === "incident_approval_auto_approved"
                  ? {
                      laneKey: "cto",
                      agentRole: "CTO",
                      navSection: "engineering",
                      title: "Engineering moved an incident fix forward automatically",
                      explanation: "The system recorded a low-risk engineering approval automatically after repeated matching founder approvals.",
                    }
                  : {
                      laneKey: role === "CMO" ? "cmo" : role === "CSO" ? "cso" : role === "CTO" ? "cto" : "cco",
                      agentRole: role,
                      navSection:
                        role === "CMO"
                          ? "marketing-drafts"
                          : role === "CSO"
                            ? "sales-workspace"
                            : role === "CTO"
                              ? "engineering"
                              : "support-ops",
                      title: `${role} completed ${actionType}`,
                      explanation: `The ${role} system completed ${actionType} automatically in the live workflow.`,
                    };
  return {
    id: String(action._id || ""),
    actionType: String(action.actionType || ""),
    laneKey: clarity.laneKey,
    agentRole: clarity.agentRole,
    title: compactText(clarity.title, 72),
    explanation: compactText(action.actionTaken || clarity.explanation, 180),
    cardBody: "Handled safely without founder intervention.",
    preview: compactText(
      action.confidenceReason ? `Safe because: ${action.confidenceReason}` : "",
      180
    ),
    proposedAction: "No founder decision is needed unless you want to inspect the source record.",
    actionHelperText: "Already handled automatically in the existing support flow.",
    urgencyLabel: "Handled automatically",
    tone: "active",
    confidenceScore: Number.isFinite(Number(action.confidenceScore)) ? Number(action.confidenceScore) : null,
    confidenceReason: compactText(action.confidenceReason || "", 180),
    createdAt: action.createdAt || null,
    updatedAt: action.createdAt || null,
    actions: {
      yes: null,
      no: null,
      open: createNavAction(clarity.navSection, "Open Details"),
      edit: null,
    },
  };
}

function buildAutonomyUpgradeSuggestionItem(suggestion = {}) {
  if (!suggestion) return null;
  return {
    id: String(suggestion.id || ""),
    laneKey: String(suggestion.laneKey || "").trim().toLowerCase(),
    agentRole: suggestion.agentRole || "",
    actionType: suggestion.actionType || "",
    title: compactText(suggestion.title || "Enable autonomy", 72),
    explanation: compactText(suggestion.explanation || "", 180),
    cardBody: "One-time autonomy upgrade opportunity.",
    preview: compactText(suggestion.preview || "", 180),
    proposedAction: compactText(suggestion.proposedAction || "", 180),
    actionHelperText: compactText(suggestion.actionHelperText || "", 220),
    urgencyLabel: suggestion.urgencyLabel || "One-time upgrade",
    tone: suggestion.tone || "active",
    confidenceScore: null,
    confidenceReason: "",
    createdAt: suggestion.createdAt || null,
    updatedAt: suggestion.updatedAt || null,
    actions: {
      yes: withActionUiCopy(
        createAutonomyPreferenceAction({
          agentRole: suggestion.agentRole,
          actionType: suggestion.actionType,
          decision: "enable",
        }),
        {
          label: suggestion.actions?.yes?.label || "Enable Auto",
          successMessage:
            suggestion.actions?.yes?.successMessage || "Auto-mode enabled for this action type.",
        }
      ),
      no: withActionUiCopy(
        createAutonomyPreferenceAction({
          agentRole: suggestion.agentRole,
          actionType: suggestion.actionType,
          decision: "manual",
        }),
        {
          label: suggestion.actions?.no?.label || "Keep Reviewing",
          successMessage:
            suggestion.actions?.no?.successMessage ||
            "This action type will stay manual and this upgrade prompt will not show again.",
        }
      ),
      open: suggestion.actions?.open || null,
      edit: null,
    },
  };
}

function buildFounderAlertInfoItem(item = {}) {
  const badge = String(item.badge || "");
  const isRiskLane = badge === "Risk" || badge === "Money Risk";
  return {
    id: String(item.actionId || item.title || ""),
    laneKey: "founder",
    agentRole: isRiskLane ? "CFO" : badge === "Lifecycle" ? "COO" : "Founder",
    title: compactText(item.title || "Founder signal", 72),
    explanation: compactText(item.body || "Founder-visible operational signal.", 180),
    preview: compactText(item.body || "", 180),
    proposedAction: "Open the source workflow for more detail.",
    actionHelperText: isRiskLane
      ? "This stays informational here. Money and dispute actions are still handled manually in their source workflow."
      : "This is informational only. Open the source workflow if you want more detail.",
    urgencyLabel: urgencyLabelFromTone(item.tone || "active"),
    tone: item.tone || "active",
    confidenceScore: null,
    confidenceReason: "",
    createdAt: null,
    updatedAt: null,
    actions: {
      yes: null,
      no: null,
      open: createNavAction(
        isRiskLane ? "disputes" : badge === "Lifecycle" ? "user-management" : "ai-control-room",
        "Open Details"
      ),
      edit: null,
    },
  };
}

function buildOperationalInfoItem({
  id = "",
  laneKey = "",
  agentRole = "",
  title = "",
  explanation = "",
  preview = "",
  proposedAction = "Open the source workflow for more detail.",
  actionHelperText = "",
  urgencyLabel = "",
  blockedReason = "",
  unblockAction = "",
  cardBody = "",
  tone = "active",
  navSection = "",
  createdAt = null,
  updatedAt = null,
} = {}) {
  return {
    id,
    laneKey,
    agentRole,
    title: compactText(title || "Operational signal", 72),
    explanation: compactText(explanation || "Operational visibility item.", 180),
    cardBody: compactText(cardBody || explanation || "Operational visibility item.", 140),
    preview: compactText(preview || "", 180),
    proposedAction,
    actionHelperText: compactText(actionHelperText || "", 220),
    urgencyLabel: urgencyLabel || urgencyLabelFromTone(tone),
    blockedReason: compactText(blockedReason || "", 180),
    unblockAction: compactText(unblockAction || "", 180),
    tone,
    confidenceScore: null,
    confidenceReason: "",
    createdAt,
    updatedAt,
    actions: {
      yes: null,
      no: null,
      open: createNavAction(navSection, "Open Details"),
      edit: null,
    },
  };
}

function buildLaneState({
  key,
  needsDecisionCount = 0,
  blockedWaitingCount = 0,
  autoHandledCount = 0,
  topDecision = null,
  autoStatus = "",
  noDecisionLabel = "No founder decision needed",
  nextAction = "",
}) {
  const decisionSummary =
    needsDecisionCount > 0
      ? `${pluralize(needsDecisionCount, "decision")} need your yes or no.`
      : noDecisionLabel;
  const blockedSummary = blockedWaitingCount > 0
    ? `${pluralize(blockedWaitingCount, "item")} are paused until you decide.`
    : "Nothing is blocked waiting on founder input.";
  const attentionStatus =
    needsDecisionCount > 0
      ? "Founder attention needed now"
      : blockedWaitingCount > 0
        ? "Waiting on founder input"
        : autoHandledCount > 0
          ? "Mostly autonomous today"
          : /awaiting system processing/i.test(noDecisionLabel)
            ? "Awaiting system processing"
            : /quick decision available/i.test(noDecisionLabel)
              ? "Manual lane"
              : "No founder attention needed";

  return {
    key,
    needsDecisionCount,
    blockedWaitingCount,
    autoHandledCount,
    topDecision,
    decisionSummary,
    blockedSummary,
    attentionStatus,
    autoStatus:
      autoStatus ||
      (autoHandledCount > 0
        ? `${pluralize(autoHandledCount, "item")} were handled automatically today.`
        : "No autonomous work is currently visible."),
    nextAction: nextAction || (topDecision ? topDecision.proposedAction : "Open the lane workspace for more detail."),
  };
}

function buildFounderOperatingSurface({
  admissions,
  support,
  payments,
  founder,
  lifecycle,
  incidents,
  marketing,
  sales,
  engineering,
  approvals,
  autonomy,
  autonomyPreferences,
}) {
  const laneRegistry = createControlRoomLaneRegistry();

  const supportDecisions = (approvals.support || []).map((item) =>
    registerControlRoomItem(
      laneRegistry,
      applyControlRoomPolicyToItem({
        laneKey: "cco",
        policyType: item.itemType === "faq_candidate" ? "faq_candidate" : "support_governed_content_approval",
        hasExecutionPath: Boolean(item.workKey),
        item: buildApprovalDecisionItem(item, {
          laneKey: "cco",
          agentRole: "CCO",
          navSection: "support-ops",
          allowEdit: false,
        }),
      })
    )
  );
  const marketingDecisions = (approvals.marketing || []).map((item) =>
    registerControlRoomItem(
      laneRegistry,
      applyControlRoomPolicyToItem({
        laneKey: "cmo",
        policyType: "marketing_draft_packet",
        hasExecutionPath: Boolean(item.workKey),
        item: buildApprovalDecisionItem(item, {
          laneKey: "cmo",
          agentRole: "CMO",
          navSection: "marketing-drafts",
          allowEdit: true,
          editSection: "marketing-drafts",
        }),
      })
    )
  );
  const salesDecisions = (approvals.sales || []).map((item) =>
    registerControlRoomItem(
      laneRegistry,
      applyControlRoomPolicyToItem({
        laneKey: "cso",
        policyType: "sales_draft_packet",
        hasExecutionPath: Boolean(item.workKey),
        item: buildApprovalDecisionItem(item, {
          laneKey: "cso",
          agentRole: "CSO",
          navSection: "sales-workspace",
          allowEdit: true,
          editSection: "sales-workspace",
        }),
      })
    )
  );
  const incidentDecisions = (incidents.incidents || [])
    .filter((incident) => {
      const incidentState = String(incident.state || "").toLowerCase();
      const approvalState = String(incident.approvalState || "").toLowerCase();
      return (
        incident.currentApprovalId &&
        (incidentState === "awaiting_founder_approval" || approvalState === "pending")
      );
    })
    .map((incident) =>
      registerControlRoomItem(
        laneRegistry,
        applyControlRoomPolicyToItem({
          laneKey: "cto",
          policyType: "incident_approval",
          hasExecutionPath: Boolean(incident.currentApprovalId && (incident.publicId || incident.id)),
          item: buildIncidentApprovalDecisionItem(incident),
        })
      )
    );
  const admissionsDecisions = (admissions.readyItems || []).map((item) =>
    registerControlRoomItem(
      laneRegistry,
      applyControlRoomPolicyToItem({
        laneKey: "cao",
        policyType: "admissions_review",
        hasExecutionPath: Boolean(item.id),
        item: buildAdmissionsDecisionItem(item),
      })
    )
  );

  const autoHandledItems = (autonomy.items || []).map((action) =>
    registerAutonomousControlRoomItem(laneRegistry, buildAutonomousActionItem(action))
  );

  const infoItems = [
    ...(founder.urgentItems || []).map((item) =>
      registerControlRoomItem(
        laneRegistry,
        applyControlRoomPolicyToItem({
          laneKey: item.badge === "Risk" || item.badge === "Money Risk" ? "cfo" : "coo",
          policyType: item.badge === "Risk" || item.badge === "Money Risk" ? "finance_risk_metric" : "ops_lifecycle_alert",
          item: buildFounderAlertInfoItem(item),
        })
      )
    ),
    ...(lifecycle.followUpToday || []).slice(0, 3).map((entry, index) =>
      registerControlRoomItem(
        laneRegistry,
        applyControlRoomPolicyToItem({
          laneKey: "coo",
          policyType: "ops_follow_up_metric",
          item: buildOperationalInfoItem({
            id: `lifecycle-${index}`,
            laneKey: "coo",
            agentRole: "COO",
            title: `Lifecycle follow-up ${index + 1}`,
            explanation: entry,
            preview: entry,
            proposedAction: "Open User Management if you want to inspect or act on this follow-up.",
            actionHelperText: "Informational only in Control Room.",
            cardBody: "Operations follow-up surfaced for visibility.",
            navSection: "user-management",
          }),
        })
      )
    ),
    ...(marketing.blockedCycleCount
      ? [
          registerControlRoomItem(
            laneRegistry,
            applyControlRoomPolicyToItem({
              laneKey: "cmo",
              policyType: "marketing_cycle_blocked",
              item: buildOperationalInfoItem({
                id: "marketing-cycles-blocked",
                laneKey: "cmo",
                agentRole: "CMO",
                title: "Publishing cycles are blocked",
                explanation: `${pluralize(marketing.blockedCycleCount, "publishing cycle")} are blocked in the live marketing workflow.`,
                preview: marketing.recommendation || "",
                tone: "priority",
                proposedAction: "Open Marketing Drafts to inspect the blocked cycle.",
                actionHelperText: "Informational here. Use the existing marketing workflow for the actual fix.",
                blockedReason: "Blocked inside the current publishing workflow.",
                unblockAction: "Inspect the blocked cycle in Marketing Drafts.",
                urgencyLabel: "Urgent today",
                cardBody: "A marketing publishing cycle is blocked in the live workflow.",
                navSection: "marketing-drafts",
              }),
            })
          ),
        ]
      : []),
  ].slice(0, 6);

  const decisionQueue = [
    ...laneRegistry.cto.decisionItems,
    ...laneRegistry.cco.decisionItems,
    ...laneRegistry.cmo.decisionItems,
    ...laneRegistry.cso.decisionItems,
    ...laneRegistry.cao.decisionItems,
  ];
  const groupedDecisionQueue = groupFounderDecisionQueue(decisionQueue);
  const groupedLaneQueues = {
    cco: groupedDecisionQueue.filter((item) => String(item?.laneKey || "").toLowerCase() === "cco"),
    cmo: groupedDecisionQueue.filter((item) => String(item?.laneKey || "").toLowerCase() === "cmo"),
    cso: groupedDecisionQueue.filter((item) => String(item?.laneKey || "").toLowerCase() === "cso"),
    cto: groupedDecisionQueue.filter((item) => String(item?.laneKey || "").toLowerCase() === "cto"),
    cao: groupedDecisionQueue.filter((item) => String(item?.laneKey || "").toLowerCase() === "cao"),
  };

  const blockedItems = [
    laneRegistry.cco.blockedItems.length
      ? buildOperationalInfoItem({
          id: "blocked-cco",
          laneKey: "cco",
          agentRole: "CCO",
          title: "Support language is blocked waiting on your decision",
          explanation: `${pluralize(laneRegistry.cco.blockedItems.length, "support review item")} cannot become governed support language until you approve or reject it.`,
          preview: groupedLaneQueues.cco[0]?.title || laneRegistry.cco.blockedItems[0]?.title || "",
          proposedAction: "Approve or reject the top FAQ candidate in Support Ops.",
          actionHelperText: "Once you decide, support can either use the approved wording or keep it out of the governed queue.",
          blockedReason: "Blocked because governed support wording still needs founder approval.",
          unblockAction: "Approve or reject the pending FAQ candidate.",
          urgencyLabel: "Needs attention today",
          cardBody: "Governed support wording is paused until you decide.",
          tone: "needs-review",
          navSection: "support-ops",
        })
      : null,
    laneRegistry.cmo.blockedItems.length
      ? buildOperationalInfoItem({
          id: "blocked-cmo",
          laneKey: "cmo",
          agentRole: "CMO",
          title: "Marketing drafts are blocked waiting on your approval",
          explanation: `${pluralize(laneRegistry.cmo.blockedItems.length, "marketing packet")} cannot move into approved outbound use until you decide.`,
          preview: groupedLaneQueues.cmo[0]?.title || laneRegistry.cmo.blockedItems[0]?.title || "",
          proposedAction: "Approve or reject the top marketing draft.",
          actionHelperText: "Your decision determines whether the draft can move into the approved outbound workflow.",
          blockedReason: "Blocked because public-facing content still needs founder approval.",
          unblockAction: "Approve or reject the pending marketing draft.",
          urgencyLabel: "Needs attention today",
          cardBody: "Public-facing marketing content is paused until you decide.",
          tone: "needs-review",
          navSection: "marketing-drafts",
        })
      : null,
    laneRegistry.cso.blockedItems.length
      ? buildOperationalInfoItem({
          id: "blocked-cso",
          laneKey: "cso",
          agentRole: "CSO",
          title: "Sales drafts are blocked waiting on your approval",
          explanation: `${pluralize(laneRegistry.cso.blockedItems.length, "sales packet")} cannot move into governed outbound use until you decide.`,
          preview: groupedLaneQueues.cso[0]?.title || laneRegistry.cso.blockedItems[0]?.title || "",
          proposedAction: "Approve or reject the top sales draft.",
          actionHelperText: "Your decision determines whether this outreach content can be used in the existing sales workflow.",
          blockedReason: "Blocked because outbound sales content still needs founder approval.",
          unblockAction: "Approve or reject the pending sales draft.",
          urgencyLabel: "Needs attention today",
          cardBody: "Outbound sales content is paused until you decide.",
          tone: "needs-review",
          navSection: "sales-workspace",
        })
      : null,
    laneRegistry.cto.blockedItems.length
      ? buildOperationalInfoItem({
          id: "blocked-cto",
          laneKey: "cto",
          agentRole: "CTO",
          title: "Engineering release work is blocked waiting on your approval",
          explanation: `${pluralize(laneRegistry.cto.blockedItems.length, "incident")} are paused because the existing release path needs your decision.`,
          preview: groupedLaneQueues.cto[0]?.title || laneRegistry.cto.blockedItems[0]?.title || "",
          proposedAction: "Approve or reject the top engineering release decision.",
          actionHelperText: "Your yes or no determines whether the existing engineering release path can continue.",
          blockedReason: "Blocked because an engineering release step is approval-gated in the current workflow.",
          unblockAction: "Approve or reject the pending engineering release decision.",
          urgencyLabel: "Urgent today",
          cardBody: "Engineering release work is paused until you decide.",
          tone: "priority",
          navSection: "engineering",
        })
      : null,
    laneRegistry.cao.blockedItems.length
      ? buildOperationalInfoItem({
          id: "blocked-cao",
          laneKey: "cao",
          agentRole: "CAO",
          title: "Admissions review is blocked waiting on your decision",
          explanation: `${pluralize(laneRegistry.cao.blockedItems.length, "application")} are ready for a founder decision and cannot move until you choose.`,
          preview: groupedLaneQueues.cao[0]?.title || laneRegistry.cao.blockedItems[0]?.title || "",
          proposedAction: "Approve or deny the top ready application.",
          actionHelperText: "Your decision will move the applicant through the existing admissions route.",
          blockedReason: "Blocked because the application is ready for founder review.",
          unblockAction: "Approve or deny the pending application.",
          urgencyLabel: "Needs attention today",
          cardBody: "Ready admissions are paused until you decide.",
          tone: "needs-review",
          navSection: "user-management",
        })
      : null,
  ].filter(Boolean);

  const byLane = {
    cco: buildLaneState({
      key: "cco",
      needsDecisionCount: groupedLaneQueues.cco.length,
      blockedWaitingCount: laneRegistry.cco.blockedItems.length,
      autoHandledCount: laneRegistry.cco.autoHandledItems.length,
      topDecision: groupedLaneQueues.cco[0] || null,
      autoStatus: laneRegistry.cco.autoHandledItems.length
        ? `${pluralize(laneRegistry.cco.autoHandledItems.length, "support action")} were already handled safely today.`
        : support.total
          ? "Support is mostly handling routine queue work without founder input."
          : "No support autonomy ran today.",
      noDecisionLabel: support.total ? "No founder decision needed right now" : "Awaiting system processing",
      nextAction: groupedLaneQueues.cco[0]
        ? groupedLaneQueues.cco[0].proposedAction
        : support.blockerCount
          ? "Open Support Ops and inspect the highest-pressure support item."
          : "No founder support decision is currently required.",
    }),
    cmo: buildLaneState({
      key: "cmo",
      needsDecisionCount: groupedLaneQueues.cmo.length,
      blockedWaitingCount: laneRegistry.cmo.blockedItems.length,
      autoHandledCount: laneRegistry.cmo.autoHandledItems.length,
      topDecision: groupedLaneQueues.cmo[0] || null,
      autoStatus: marketing.openCycleCount
        ? `${pluralize(marketing.openCycleCount, "publishing cycle")} are already moving through the existing system workflow.`
        : "No marketing cycle is currently in flight.",
      noDecisionLabel: marketing.openCycleCount ? "Awaiting system processing" : "No founder decision needed right now",
      nextAction: groupedLaneQueues.cmo[0]
        ? groupedLaneQueues.cmo[0].proposedAction
        : marketing.blockedCycleCount
          ? "Open Marketing Drafts and inspect the blocked cycle."
          : "No founder marketing decision is currently required.",
    }),
    cso: buildLaneState({
      key: "cso",
      needsDecisionCount: groupedLaneQueues.cso.length,
      blockedWaitingCount: laneRegistry.cso.blockedItems.length,
      autoHandledCount: laneRegistry.cso.autoHandledItems.length,
      topDecision: groupedLaneQueues.cso[0] || null,
      autoStatus: sales.accountsCount
        ? "Sales account memory is current; outbound use still stays approval-first."
        : "No active sales processing is currently visible.",
      noDecisionLabel: sales.accountsCount ? "No founder decision needed" : "Awaiting system processing",
      nextAction: groupedLaneQueues.cso[0]
        ? groupedLaneQueues.cso[0].proposedAction
        : "No founder sales decision is currently required.",
    }),
    cto: buildLaneState({
      key: "cto",
      needsDecisionCount: groupedLaneQueues.cto.length,
      blockedWaitingCount: laneRegistry.cto.blockedItems.length,
      autoHandledCount: laneRegistry.cto.autoHandledItems.length,
      topDecision: groupedLaneQueues.cto[0] || null,
      autoStatus:
        engineering.activeCount > engineering.awaitingApprovalCount
          ? `${pluralize(
              engineering.activeCount - engineering.awaitingApprovalCount,
              "engineering item"
            )} are already moving through diagnosis or execution planning.`
          : engineering.activeCount
            ? "No additional engineering item is currently moving without approval."
            : "No engineering automation is currently visible.",
      noDecisionLabel:
        engineering.activeCount > engineering.awaitingApprovalCount
          ? "Awaiting system processing"
          : "No founder decision needed",
      nextAction: groupedLaneQueues.cto[0]
        ? groupedLaneQueues.cto[0].proposedAction
        : "Open Engineering to inspect the active incident queue.",
    }),
    cfo: buildLaneState({
      key: "cfo",
      needsDecisionCount: laneRegistry.cfo.decisionItems.length,
      blockedWaitingCount: laneRegistry.cfo.blockedItems.length,
      autoHandledCount: laneRegistry.cfo.autoHandledItems.length,
      topDecision: laneRegistry.cfo.decisionItems[0] || null,
      autoStatus:
        payments.openDisputesCount || payments.moneyIssueCount
          ? "Manual only. Money and dispute actions stay outside quick Control Room yes/no decisions."
          : "No founder finance decision is currently required.",
      noDecisionLabel: "No founder quick decision available",
      nextAction: payments.openDisputesCount || payments.moneyIssueCount
        ? "Open Disputes for manual review."
        : "No finance action is currently required.",
    }),
    coo: buildLaneState({
      key: "coo",
      needsDecisionCount: laneRegistry.coo.decisionItems.length,
      blockedWaitingCount: laneRegistry.coo.blockedItems.length,
      autoHandledCount: laneRegistry.coo.autoHandledItems.length,
      topDecision: laneRegistry.coo.decisionItems[0] || null,
      autoStatus: lifecycle.followUpTodayCount
        ? `${pluralize(lifecycle.followUpTodayCount, "follow-up")} were surfaced automatically for operations visibility today.`
        : "No lifecycle follow-up is currently due.",
      noDecisionLabel: "No founder decision needed",
      nextAction: lifecycle.followUpTodayCount
        ? "Open User Management for the follow-up queue."
        : "No operations action is currently required.",
    }),
    cao: buildLaneState({
      key: "cao",
      needsDecisionCount: groupedLaneQueues.cao.length,
      blockedWaitingCount: laneRegistry.cao.blockedItems.length,
      autoHandledCount: laneRegistry.cao.autoHandledItems.length,
      topDecision: groupedLaneQueues.cao[0] || null,
      autoStatus: admissions.needsInfoCount
        ? `${pluralize(admissions.needsInfoCount, "application")} still need more information before founder review.`
        : "No incomplete admissions are currently waiting on follow-up.",
      noDecisionLabel: admissions.total ? "Awaiting system processing" : "No founder decision needed right now",
      nextAction: groupedLaneQueues.cao[0]
        ? groupedLaneQueues.cao[0].proposedAction
        : "Open User Management for admissions detail.",
    }),
    cpo: buildLaneState({
      key: "cpo",
      needsDecisionCount: laneRegistry.cpo.decisionItems.length,
      blockedWaitingCount: laneRegistry.cpo.blockedItems.length,
      autoHandledCount: laneRegistry.cpo.autoHandledItems.length,
      topDecision: laneRegistry.cpo.decisionItems[0] || null,
      autoStatus: "No dedicated product decision system is wired into Control Room yet.",
      noDecisionLabel: "No founder decision available",
      nextAction: "Open Engineering for product-adjacent issue detail.",
    }),
  };

  return {
    counts: {
      needsDecisionCount: groupedDecisionQueue.length,
      autoHandledCount: autoHandledItems.length,
      blockedWaitingCount: blockedItems.length
        ? laneRegistry.cco.blockedItems.length +
          laneRegistry.cmo.blockedItems.length +
          laneRegistry.cso.blockedItems.length +
          laneRegistry.cto.blockedItems.length +
          laneRegistry.cao.blockedItems.length
        : 0,
      highRiskCount: Number(payments.openDisputesCount || 0) + Number(payments.moneyIssueCount || 0),
    },
    decisionQueue: groupedDecisionQueue,
    autonomyUpgradeSuggestion: buildAutonomyUpgradeSuggestionItem(autonomyPreferences?.suggestion || null),
    autoHandledItems,
    blockedItems,
    infoItems,
    byLane,
  };
}

async function getPendingApprovalSnapshot() {
  const items = await listApprovalWorkspaceItems({ status: "pending" });
  const grouped = items.reduce(
    (accumulator, item) => {
      const key = String(item.sourcePillar || "").trim().toLowerCase();
      if (!accumulator[key]) accumulator[key] = [];
      accumulator[key].push(item);
      return accumulator;
    },
    { support: [], marketing: [], sales: [], knowledge: [] }
  );

  return {
    items,
    support: grouped.support || [],
    marketing: grouped.marketing || [],
    sales: grouped.sales || [],
    knowledge: grouped.knowledge || [],
  };
}

async function getAutonomousActionSnapshot() {
  const items = await AutonomousAction.find({
    agentRole: { $in: ["CCO", "CMO", "CSO", "CTO"] },
    status: "completed",
    createdAt: { $gte: startOfToday() },
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(8)
    .select("agentRole actionType actionTaken confidenceScore confidenceReason targetModel targetId createdAt")
    .lean();

  return {
    todayCount: items.length,
    items,
  };
}

function buildSummaryPayload({
  admissions,
  support,
  payments,
  founder,
  lifecycle,
  incidents,
  health,
  marketing,
  sales,
  engineering,
  product,
  adminOps,
  founderOperating,
}) {
  const lanes = founderOperating?.byLane || {};
  const cmoLane = lanes.cmo || {};
  const ctoLane = lanes.cto || {};
  const cfoLane = lanes.cfo || {};
  const cooLane = lanes.coo || {};
  const csoLane = lanes.cso || {};
  const ccoLane = lanes.cco || {};
  const cpoLane = lanes.cpo || {};
  const caoLane = lanes.cao || {};

  const cmoStatus = buildExecutiveStatus({
    priority: marketing.blockedCycleCount > 0 || Number(cmoLane.blockedWaitingCount || 0) > 0,
    review: marketing.pendingReviewCount > 0 || Number(cmoLane.needsDecisionCount || 0) > 0,
  });
  const ctoStatus = buildExecutiveStatus({
    priority: engineering.blockedCount > 0 || Number(ctoLane.blockedWaitingCount || 0) > 0,
    review:
      engineering.activeCount > 0 ||
      engineering.awaitingApprovalCount > 0 ||
      engineering.readyForTestCount > 0 ||
      Number(ctoLane.needsDecisionCount || 0) > 0,
  });
  const cfoStatus = buildExecutiveStatus({
    priority: payments.openDisputesCount > 0 || payments.moneyIssueCount > 0,
    review: payments.withdrawalCount > 0,
  });
  const cooStatus = buildExecutiveStatus({
    priority: (lifecycle.stripeIncomplete || []).length > 0,
    review: lifecycle.followUpTodayCount > 0 || lifecycle.stalledCount > 0,
  });
  const csoStatus = buildExecutiveStatus({
    review: sales.pendingReviewCount > 0 || Number(csoLane.needsDecisionCount || 0) > 0,
  });
  const ccoStatus = buildExecutiveStatus({
    priority: support.blockerCount > 0,
    review: support.openTicketCount > 0 || Number(ccoLane.needsDecisionCount || 0) > 0,
  });
  const cpoStatus = buildExecutiveStatus({
    priority: product.priorityIssueCount > 0,
    review: product.openIssueCount > 0 || product.patternAlertCount > 0,
  });
  const caoStatus = buildExecutiveStatus({
    review: adminOps.pendingApprovalCount > 0 || admissions.total > 0 || Number(caoLane.needsDecisionCount || 0) > 0,
  });

  const buildCard = ({
    key,
    title,
    description,
    status,
    tone,
    queues,
    recommendation,
    actionLabel,
    navSection,
    meta,
    laneState = {},
  }) => ({
    key,
    title,
    description,
    status,
    tone,
    queues,
    recommendation,
    actionLabel,
    navSection,
    meta,
    decisionState: {
      needsDecisionCount: Number(laneState.needsDecisionCount || 0),
      autoHandledCount: Number(laneState.autoHandledCount || 0),
      blockedWaitingCount: Number(laneState.blockedWaitingCount || 0),
      attentionStatus: laneState.attentionStatus || "No founder attention needed",
      decisionSummary: laneState.decisionSummary || "No founder decision needed.",
      autoStatus: laneState.autoStatus || "No autonomous work is currently visible.",
      blockedSummary: laneState.blockedSummary || "Nothing is blocked waiting on founder input.",
      nextAction: laneState.nextAction || recommendation || "",
      topDecision: laneState.topDecision || null,
    },
  });

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      urgent: {
        value: String(founderOperating?.counts?.needsDecisionCount || 0),
        note:
          Number(founderOperating?.counts?.needsDecisionCount || 0) > 0
            ? `${pluralize(founderOperating?.counts?.needsDecisionCount || 0, "decision")} need a yes or no right now across the live lanes.`
            : "No founder decision is currently required across the live lanes.",
      },
      review: {
        value: String(founderOperating?.counts?.autoHandledCount || 0),
        note:
          Number(founderOperating?.counts?.autoHandledCount || 0) > 0
            ? `${pluralize(founderOperating?.counts?.autoHandledCount || 0, "action")} were handled automatically today and logged for audit.`
            : "No founder-visible autonomous actions have been logged today.",
      },
      blocked: {
        value: String(founderOperating?.counts?.blockedWaitingCount || 0),
        note:
          Number(founderOperating?.counts?.blockedWaitingCount || 0) > 0
            ? `${pluralize(founderOperating?.counts?.blockedWaitingCount || 0, "item")} are paused until you decide.`
            : "Nothing is currently blocked waiting on founder input.",
      },
      risk: {
        value: String(founderOperating?.counts?.highRiskCount || 0),
        note: "Open disputes and money-impacting issues currently visible.",
      },
      health: health || null,
    },
    cards: [
      buildCard({
        key: "cmo",
        title: "CMO / Marketing",
        description: "Founder-approved marketing drafting and publishing cycle readiness across LPC.",
        status: cmoStatus.status,
        tone: cmoStatus.tone,
        queues: [
          { label: "Pending review", value: marketing.pendingReviewCount },
          { label: "Blocked cycles", value: marketing.blockedCycleCount },
        ],
        recommendation: marketing.recommendation,
        actionLabel: "Open Marketing Drafts",
        navSection: "marketing-drafts",
        meta: "MarketingDraftPacket + MarketingPublishingCycle; no auto-publish.",
        laneState: cmoLane,
      }),
      buildCard({
        key: "cto",
        title: "CTO / Engineering",
        description: "Incidents, diagnosis packets, execution context, and release blockers across the platform.",
        status: ctoStatus.status,
        tone: ctoStatus.tone,
        queues: [
          { label: "Open items", value: engineering.activeCount },
          { label: "Blocked items", value: engineering.blockedCount },
        ],
        recommendation: engineering.recommendation,
        actionLabel: "Open Engineering",
        navSection: "engineering",
        meta: "Incident + CtoAgentRun + CtoExecutionRun; manual review only.",
        laneState: ctoLane,
      }),
      buildCard({
        key: "cfo",
        title: "CFO / Finance",
        description: "Disputes, withdrawal exposure, and money-sensitive incident risk on LPC.",
        status: cfoStatus.status,
        tone: cfoStatus.tone,
        queues: [
          { label: "Open disputes", value: payments.openDisputesCount },
          { label: "Money issues", value: payments.moneyIssueCount },
        ],
        recommendation: payments.recommendation,
        actionLabel: "Open Disputes",
        navSection: "disputes",
        meta: "Case disputes + incident money-risk signals.",
        laneState: cfoLane,
      }),
      buildCard({
        key: "coo",
        title: "COO / Operations",
        description: "User activation, follow-up timing, and stalled operational workflows across LPC.",
        status: cooStatus.status,
        tone: cooStatus.tone,
        queues: [
          { label: "Follow-ups today", value: lifecycle.followUpTodayCount },
          { label: "Stalled users", value: lifecycle.stalledCount },
        ],
        recommendation: lifecycle.recommendation,
        actionLabel: "Open User Management",
        navSection: "user-management",
        meta: lifecycle.hasLegacyCompatibility
          ? "Event-backed lifecycle ledger with compatibility-only heuristic merge."
          : "Event-backed lifecycle follow-up ledger.",
        laneState: cooLane,
      }),
      buildCard({
        key: "cso",
        title: "CSO / Sales",
        description: "Awareness accounts, outreach drafting, and governed sales review workload.",
        status: csoStatus.status,
        tone: csoStatus.tone,
        queues: [
          { label: "Pending review", value: sales.pendingReviewCount },
          { label: "Active accounts", value: sales.accountsCount },
        ],
        recommendation: sales.recommendation,
        actionLabel: "Open Sales Workspace",
        navSection: "sales-workspace",
        meta: "SalesAccount + SalesDraftPacket; no outbound sending.",
        laneState: csoLane,
      }),
      buildCard({
        key: "cco",
        title: "CCO / Customer",
        description: "Support queue health, escalations, and customer-facing issue pressure on LPC.",
        status: ccoStatus.status,
        tone: ccoStatus.tone,
        queues: [
          { label: "Open tickets", value: support.openTicketCount },
          { label: "Escalations", value: support.blockerCount },
        ],
        recommendation: support.recommendation,
        actionLabel: "Open Support Ops",
        navSection: "support-ops",
        meta: "SupportTicket + Incident; replies stay manual.",
        laneState: ccoLane,
      }),
      buildCard({
        key: "cpo",
        title: "CPO / Product",
        description: "User-facing workflow issues and repeated product friction signals across LPC.",
        status: cpoStatus.status,
        tone: cpoStatus.tone,
        queues: [
          { label: "Open issues", value: product.openIssueCount },
          { label: "Pattern alerts", value: product.patternAlertCount },
        ],
        recommendation: product.recommendation,
        actionLabel: "Open Engineering",
        navSection: "engineering",
        meta: "Incident + SupportInsight; no standalone product backlog model yet.",
        laneState: cpoLane,
      }),
      buildCard({
        key: "cao",
        title: "CAO / Administration",
        description: "Governed approvals, signup review load, and internal administrative throughput.",
        status: caoStatus.status,
        tone: caoStatus.tone,
        queues: [
          { label: "Pending approvals", value: adminOps.pendingApprovalCount },
          { label: "Pending applications", value: admissions.total },
        ],
        recommendation:
          admissions.total && adminOps.pendingApprovalCount
            ? "Review pending applications and cross-functional approval tasks before adding more admin work."
            : admissions.total
              ? admissions.recommendation
              : adminOps.recommendation,
        actionLabel: "Open Approvals",
        navSection: "approvals-workspace",
        meta: "ApprovalTask + pending User reviews; admissions completeness stays heuristic until reviewed.",
        laneState: caoLane,
      }),
    ],
    decisionQueue: (founderOperating?.decisionQueue || []).slice(0, 8),
    autoHandledQueue: (founderOperating?.autoHandledItems || []).slice(0, 6),
    blockedQueue: (founderOperating?.blockedItems || []).slice(0, 6),
    infoQueue: (founderOperating?.infoItems || []).slice(0, 6),
    urgentQueue: founder.urgentItems.slice(0, 4),
    awaitingReview: [
      admissions.readyCount
        ? {
            title: "Admissions ready for founder review",
            tone: "needs-review",
            badge: "Admissions",
            body: `${pluralize(admissions.readyCount, "application")} have the visible core fields for founder review.`,
          }
        : null,
      admissions.needsInfoCount
        ? {
            title: "Admissions needing more information",
            tone: "active",
            badge: "Follow-Up",
            body: `${pluralize(admissions.needsInfoCount, "record")} still need core information before final review.`,
          }
        : null,
      payments.openDisputesCount
        ? {
            title: "Disputes awaiting founder-visible review",
            tone: "priority",
            badge: "Risk",
            body: `${pluralize(payments.openDisputesCount, "open dispute")} need recommendation framing, not automatic outcomes.`,
          }
        : null,
      lifecycle.followUpTodayCount
        ? {
            title: "Lifecycle follow-ups due now",
            tone: "active",
            badge: "Lifecycle",
            body: `${Number(lifecycle.followUpTodayCount)} distinct users meet visible follow-up criteria today.`,
          }
        : null,
      marketing.pendingReviewCount
        ? {
            title: "Marketing packets awaiting approval",
            tone: "needs-review",
            badge: "Marketing",
            body: `${pluralize(marketing.pendingReviewCount, "packet")} ${
              marketing.pendingReviewCount === 1 ? "is" : "are"
            } awaiting Samantha review before any external use.`,
          }
        : null,
      sales.pendingReviewCount
        ? {
            title: "Sales packets awaiting approval",
            tone: "needs-review",
            badge: "Sales",
            body: `${pluralize(sales.pendingReviewCount, "packet")} await Samantha review before any external use.`,
          }
        : null,
      incidents.summary.awaitingApprovalCount
        ? {
            title: "Incidents awaiting approval",
            tone: "priority",
            badge: "Incidents",
            body: `${pluralize(
              incidents.summary.awaitingApprovalCount,
              "incident"
            )} ${
              incidents.summary.awaitingApprovalCount === 1 ? "is" : "are"
            } currently paused on approval-sensitive state.`,
          }
        : null,
    ].filter(Boolean),
    recentEscalations: [
      ...support.topTickets.slice(0, 2).map((ticket) => ({
        title: compactText(ticket.subject || "Support ticket", 52),
        tone: ticket.routingSuggestion?.priority === "high" ? "priority" : "active",
        badge: "Support",
        body: compactText(ticket.latestResponsePacket?.recommendedReply || ticket.message || "Support ticket queued.", 110),
      })),
      ...support.topIncidents.slice(0, 2).map((incident) => ({
        title: buildIncidentEscalationTitle(incident),
        tone: toneFromRisk(incident.classification?.riskLevel || incident.classification?.severity),
        badge: isAuthIncident(incident) ? "Auth Risk" : "Support",
        body: buildIncidentLine(incident),
      })),
      ...payments.moneyIncidents.slice(0, 1).map((incident) => ({
        title: buildIncidentEscalationTitle(incident),
        tone: toneFromRisk(incident.classification?.riskLevel || incident.classification?.severity),
        badge: "Money Risk",
        body: buildIncidentLine(incident),
      })),
      ...payments.openDisputes.slice(0, 1).map((item) => ({
        title: compactText(item.caseTitle || "Open dispute", 52),
        tone: "needs-review",
        badge: "Risk",
        body: `${compactText(item.disputeMessage || "Open dispute raised.", 110)} Review is still open.`,
      })),
      ...incidents.incidents.slice(0, 1).map((incident) => ({
        title: compactText(incident.publicId || "Incident", 52),
        tone: incident.classification?.riskLevel === "high" ? "priority" : "active",
        badge: "Incidents",
        body: `${compactText(incident.summary || "Open incident", 110)} State: ${incident.state}.`,
      })),
    ].slice(0, 4),
    outboundMessages: marketing.latestPackets.slice(0, 3).map((packet) => ({
      title: compactText(packet.workflowType.replace(/_/g, " "), 52),
      tone: packet.approvalState === "pending_review" ? "needs-review" : "active",
      badge: "Marketing",
      body: compactText(packet.packetSummary || "Draft packet available.", 110),
    })).concat(
      sales.latestPackets.slice(0, 2).map((packet) => ({
        title: compactText(packet.packetType.replace(/_/g, " "), 52),
        tone: packet.approvalState === "pending_review" ? "needs-review" : "active",
        badge: "Sales",
        body: compactText(packet.packetSummary || "Sales packet available.", 110),
      }))
    ).slice(0, 4),
  };
}

function buildFounderFocus({ founder, lifecycle, founderOperating }) {
  const view = buildFounderFocusView({ founder, lifecycle });
  const needsDecisionCount = Number(founderOperating?.counts?.needsDecisionCount || 0);
  const autoHandledCount = Number(founderOperating?.counts?.autoHandledCount || 0);
  const blockedWaitingCount = Number(founderOperating?.counts?.blockedWaitingCount || 0);

  view.queueLabel = `${pluralize(needsDecisionCount, "decision")} pending`;
  view.primary = {
    title: "What Needs Samantha Today",
    body:
      needsDecisionCount > 0
        ? `Start with the first card below. ${pluralize(needsDecisionCount, "decision")} need a clear yes or no across the live lanes.`
        : blockedWaitingCount > 0
          ? `${pluralize(blockedWaitingCount, "item")} are paused waiting on founder input, but no direct yes or no is surfaced here.`
          : autoHandledCount > 0
            ? `No founder decision is required right now. ${pluralize(autoHandledCount, "action")} were already handled automatically today.`
            : "No founder decision is required right now. The Control Room is acting as a calm watch and triage surface.",
  };
  view.secondary = {
    title: "Current Ops Facts",
    items: [
      `${pluralize(needsDecisionCount, "decision")} need a yes or no right now.`,
      `${pluralize(autoHandledCount, "action")} were auto-handled today.`,
      `${pluralize(blockedWaitingCount, "item")} are paused waiting on your input.`,
      `${pluralize(founder.latestFounderAlerts.length, "open founder alert")} are visible.`,
      `${pluralize(lifecycle.totalOpen || 0, "event-backed lifecycle follow-up")} are open.`,
    ],
  };
  view.tertiary = {
    title: "Decision Queue",
    items: needsDecisionCount
      ? founderOperating.decisionQueue.slice(0, 4).map((item) => `${item.agentRole}: ${item.title} — ${item.explanation}`)
      : ["No founder decisions are currently waiting in the live approval lanes."],
  };
  view.quaternary = {
    title: "How This Surface Works",
    items: [
      "Yes and No always use the existing approval or incident path; deeper work still lives in the source subpages.",
      "Autonomous work shown here is already complete and logged for audit.",
      "Informational alerts stay visible without creating a second approval workflow.",
    ],
  };
  view.decisionQueue = (founderOperating?.decisionQueue || []).slice(0, 8);
  view.autonomyUpgradeSuggestion = founderOperating?.autonomyUpgradeSuggestion || null;
  view.autoHandledItems = (founderOperating?.autoHandledItems || []).slice(0, 6);
  view.blockedItems = (founderOperating?.blockedItems || []).slice(0, 6);
  view.infoItems = (founderOperating?.infoItems || []).slice(0, 6);
  view.surfaceMode = "decision_hub";

  if (founder?.usesFallbackUrgent || lifecycle?.hasLegacyCompatibility) {
    const secondaryItems = [...(view.secondary?.items || [])];

    if (founder?.usesFallbackUrgent) {
      const fallbackCount = Number(founder.fallbackUrgentCount || 0);
      secondaryItems.push(
        `${pluralize(fallbackCount, "founder-priority risk item")} ${
          fallbackCount === 1 ? "is" : "are"
        } currently shown from live disputes or money-risk incidents.`
      );
    }

    if (lifecycle?.hasLegacyCompatibility) {
      secondaryItems.push(
        `${pluralize(lifecycle.legacyCompatibilityCount || 0, "compatibility-only lifecycle signal")} are still merged for continuity.`
      );
    }

    view.secondary = {
      title: "Current Ops Facts",
      items: secondaryItems,
    };
    view.quaternary = {
      title: "Canonical Source Notes",
      items: [
        "Routed founder alerts remain canonical where present.",
        founder?.usesFallbackUrgent
          ? "When no routed founder alert is open, War Room can still surface live disputes and money-risk incidents as founder-priority operational fallbacks."
          : "No founder-priority operational fallback is currently being used.",
        lifecycle?.hasLegacyCompatibility
          ? "Some lifecycle items are still merged from legacy compatibility logic and should not be treated as canonical ledger records."
          : "Lifecycle counts shown here come from the current event-backed follow-up ledger.",
      ],
    };
  }
  return view;
}

function buildAdmissionsFocus(admissions) {
  const priorityItems = admissions.items.slice(0, 5).map((item) => {
    const missing = item.missing.length ? ` Missing: ${item.missing.join(", ")}.` : " Core fields are visible.";
    return `${item.name} · ${item.role}: ${item.recommendation}${missing}`;
  });

  return {
    title: "Admissions / Review",
    status: admissions.total ? "Needs Review" : "Healthy",
    tone: admissions.total ? "needs-review" : "healthy",
    queueLabel: `${pluralize(admissions.total, "pending application")}`,
    primary: {
      title: "Recommended Focus",
      body: admissions.recommendation,
    },
    secondary: {
      title: "Visible Completeness Facts",
      items: [
        `${pluralize(admissions.attorneyCount, "attorney application")} pending.`,
        `${pluralize(admissions.paralegalCount, "paralegal application")} pending.`,
        `${pluralize(admissions.needsInfoCount, "record")} still need more information.`,
      ],
    },
    tertiary: {
      title: "Current Review Items",
      items: priorityItems.length ? priorityItems : ["No pending admissions are currently visible."],
    },
    quaternary: {
      title: "Heuristic Follow-Up Cues",
      items: admissions.items.length
        ? [
            "These suggested messages come from visible completeness only and should not be treated as final decisions.",
            ...[...new Set(admissions.items.slice(0, 2).map((item) => item.outboundMessage))],
          ]
        : ["No admissions outreach cues are currently needed."],
    },
  };
}

function buildSupportFocus(support) {
  return {
    title: "Support Ops",
    status: support.blockerCount ? "Priority" : support.total ? "Active" : "Healthy",
    tone: support.blockerCount ? "priority" : support.total ? "active" : "healthy",
    queueLabel: `${pluralize(support.total, "active support item")}`,
    primary: {
      title: "Recommended Focus",
      body: support.recommendation,
    },
    secondary: {
      title: "Visible Facts",
      items: [
        `${pluralize(support.openTicketCount, "support ticket")} are open in Support Ops.`,
        `${pluralize(support.blockerCount, "item")} currently look operationally blocking.`,
        `${pluralize(support.faqPendingCount, "FAQ candidate")} are pending review.`,
        `${pluralize(support.insightCount, "support insight")} are currently surfaced.`,
      ],
    },
    tertiary: {
      title: "Current Queue",
      items: support.topTickets.length
        ? support.topTickets.map((ticket) => {
            const owner = ticket.routingSuggestion?.ownerKey || "support_ops";
            return `${ticket.subject}: ${compactText(ticket.latestResponsePacket?.recommendedReply || ticket.message, 100)} Owner ${owner}.`;
          })
        : support.topIncidents.length
          ? support.topIncidents.map((incident) => buildIncidentLine(incident))
          : ["No unresolved support items are currently visible."],
    },
    quaternary: {
      title: "Support Signals",
      items: [
        ...support.faqCandidates.slice(0, 2).map((candidate) => `${candidate.title}: ${candidate.summary}`),
        ...support.insights.slice(0, 2).map((insight) => `${insight.title}: ${insight.summary}`),
      ].length
        ? [
            ...support.faqCandidates.slice(0, 2).map((candidate) => `${candidate.title}: ${candidate.summary}`),
            ...support.insights.slice(0, 2).map((insight) => `${insight.title}: ${insight.summary}`),
          ]
        : ["No FAQ candidates or support insights are currently surfaced."],
    },
  };
}

function buildPaymentsFocus(payments) {
  return {
    title: "Payments & Risk",
    status: payments.openDisputesCount || payments.moneyIssueCount ? "Priority" : "Active",
    tone: payments.openDisputesCount || payments.moneyIssueCount ? "priority" : "active",
    queueLabel: `${pluralize(payments.openDisputesCount + payments.moneyIssueCount, "risk item")}`,
    primary: {
      title: "Recommended Focus",
      body: payments.recommendation,
    },
    secondary: {
      title: "Visible Facts",
      items: [
        `${pluralize(payments.openDisputesCount, "open dispute")} are currently visible.`,
        `${pluralize(payments.withdrawalCount, "withdrawal-related item")} are currently visible.`,
        `${pluralize(payments.moneyIssueCount, "money-risk incident")} are currently visible in the Incident system.`,
      ],
    },
    tertiary: {
      title: "Current Watch Items",
      items: payments.openDisputes.length
        ? payments.openDisputes.slice(0, 5).map((item) => {
            const flag = item.withdrawnParalegalId || String(item.pausedReason || "").toLowerCase() === "paralegal_withdrew"
              ? " Withdrawal-related."
              : "";
            return `${compactText(item.caseTitle || "Open dispute", 52)}: ${compactText(item.disputeMessage || "Open dispute raised.", 100)}.${flag}`;
          })
        : payments.moneyIncidents.length
          ? payments.moneyIncidents.map((incident) => buildIncidentLine(incident))
          : ["No open disputes or money-risk incidents are currently visible."],
    },
    quaternary: {
      title: "Canonical Source Notes",
      items: [
        "Disputes remain authoritative on the Case record.",
        "Money-risk incidents remain authoritative in the Incident system.",
      ],
    },
  };
}

function buildLifecycleFocus(lifecycle) {
  const count = Number(lifecycle.followUpTodayCount || 0);
  const stalled = Number(lifecycle.stalledCount || 0);
  const compatibilityCount = Number(lifecycle.legacyCompatibilityCount || 0);

  return {
    title: "Lifecycle & Follow-Up",
    status: count ? "Needs Review" : stalled ? "Active" : "Healthy",
    tone: count ? "needs-review" : stalled ? "active" : "healthy",
    queueLabel: `${pluralize(count, "follow-up")} recommended today`,
    primary: {
      title: "Recommended Focus",
      body: lifecycle.recommendation,
    },
    secondary: {
      title: lifecycle.hasLegacyCompatibility ? "Current Ops Facts" : "Event-Backed Facts",
      items: [
        `Distinct users recommended for follow-up today: ${count}`,
        `Stalled lifecycle records visible: ${stalled}`,
        `Signup reviews open: ${Number(lifecycle.groupedCounts?.signupReview || 0)}`,
        `Incomplete pending profiles open: ${Number(lifecycle.groupedCounts?.incompleteProfile || 0)}`,
        `Public contact follow-ups open: ${Number(lifecycle.groupedCounts?.publicContact || 0)}`,
        lifecycle.hasLegacyCompatibility
          ? `Compatibility-only lifecycle signals still merged: ${compatibilityCount}`
          : "No legacy lifecycle compatibility merge is currently visible.",
      ],
    },
    tertiary: {
      title: "Current Lifecycle Queue",
      items: count
        ? [
            `Distinct users recommended for follow-up today: ${count}`,
            ...lifecycle.followUpToday.slice(0, 7),
          ]
        : ["No lifecycle follow-ups are currently visible."],
    },
    quaternary: {
      title: "Canonical Source Notes",
      items: lifecycle.hasLegacyCompatibility
        ? [
            "Event-backed lifecycle follow-ups are canonical where present.",
            "Some legacy lifecycle heuristics are still merged for continuity and remain compatibility-only until migrated.",
          ]
        : ["Lifecycle follow-ups are event-backed in the current canonical flow."],
    },
  };
}

function buildMarketingFocus(marketingView = {}) {
  return marketingView.focusView;
}

function buildSalesFocus(sales = {}) {
  return {
    title: "Sales / Awareness",
    status: sales.pendingReviewCount ? "Needs Review" : sales.accountsCount ? "Active" : "Healthy",
    tone: sales.pendingReviewCount ? "needs-review" : sales.accountsCount ? "active" : "healthy",
    queueLabel: `${pluralize(sales.pendingReviewCount, "packet")} pending review`,
    primary: {
      title: "Recommended Focus",
      body: sales.recommendation,
    },
    secondary: {
      title: "Visible Facts",
      items: [
        `${pluralize(sales.accountsCount, "account")} are active in Sales Workspace.`,
        `${pluralize(sales.interactionsCount, "interaction")} are recorded.`,
        `${pluralize(sales.packetsCount, "draft packet")} exist.`,
      ],
    },
    tertiary: {
      title: "Recent Accounts",
      items: sales.latestAccounts.length
        ? sales.latestAccounts.map((account) => `${account.name}: ${account.accountSummary || "Account record available."}`)
        : ["No sales accounts are currently visible."],
    },
    quaternary: {
      title: "Draft Packets",
      items: sales.latestPackets.length
        ? sales.latestPackets.map((packet) => `${packet.packetType}: ${packet.packetSummary || "Packet available."}`)
        : ["No sales draft packets are currently visible."],
    },
  };
}

function buildEngineeringFocus() {
  return {
    title: "Engineering Triage",
    status: "Unavailable",
    tone: "blocked",
    queueLabel: "Unavailable",
    primary: {
      title: "Status",
      body: "Engineering triage is not yet wired into the War Room. Incident Control Room is the canonical operator path.",
    },
    secondary: {
      title: "Availability",
      items: ["No live backend source is available for engineering triage in this pass."],
    },
    tertiary: {
      title: "Queue",
      items: ["No engineering triage queue is available."],
    },
    quaternary: {
      title: "Canonical Source Notes",
      items: [
        "Legacy AI issue routes remain compatibility-only.",
        "Incident Control Room is the canonical operational queue for incident-like work.",
      ],
    },
  };
}

function buildIncidentFocus(incidents) {
  return incidents.view;
}

async function getControlRoomSourceData() {
  await processAutoModeActions();
  const [
    admissions,
    support,
    payments,
    founderRollup,
    legacyLifecycle,
    incidents,
    health,
    marketing,
    sales,
    engineering,
    product,
    adminOps,
    approvals,
    autonomy,
    autonomyPreferences,
  ] = await Promise.all([
    getAdmissionsSnapshot(),
    getSupportSnapshot(),
    getPaymentsRiskSnapshot(),
    getFounderCopilotRollup(),
    getLifecycleSnapshot(),
    controlRoomService.getIncidentControlRoomView(),
    getControlRoomHealthSnapshot(),
    getMarketingSnapshot(),
    getSalesSnapshot(),
    getEngineeringSnapshot(),
    getProductSnapshot(),
    getAdminOpsSnapshot(),
    getPendingApprovalSnapshot(),
    getAutonomousActionSnapshot(),
    getAutonomyPreferencesSnapshot(),
  ]);
  const lifecycle = mergeLifecycleSnapshot({
    eventLifecycle: founderRollup.lifecycle,
    legacyLifecycle,
  });
  const founder = mergeFounderSnapshot({
    eventFounder: founderRollup.founder,
    lifecycle,
    payments,
  });
  const founderOperating = buildFounderOperatingSurface({
    admissions,
    support,
    payments,
    founder,
    lifecycle,
    incidents,
    marketing,
    sales,
    engineering,
    approvals,
    autonomy,
    autonomyPreferences,
  });
  return {
    admissions,
    support,
    payments,
    lifecycle,
    founder,
    incidents,
    health,
    marketing,
    sales,
    engineering,
    product,
    adminOps,
    approvals,
    autonomy,
    autonomyPreferences,
    founderOperating,
  };
}

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const data = await getControlRoomSourceData();
    const summaryPayload = buildSummaryPayload(data);
    const generatedAt = new Date().toISOString();

    return res.json({
      ok: true,
      liveLabel: "Live data",
      generatedAt,
      summary: summaryPayload.summary,
      cards: summaryPayload.cards,
    });
  })
);

router.get(
  "/control-room/summary",
  asyncHandler(async (_req, res) => {
    const data = await getControlRoomSourceData();
    return res.json({
      ok: true,
      meta: {
        canonicalOpsSources: ["Incident", "LpcAction", "ApprovalTask", "SupportTicket", "KnowledgeRevision"],
        compatibilityOnlySources: data.lifecycle?.hasLegacyCompatibility ? ["legacy_lifecycle_snapshot"] : [],
      },
      ...buildSummaryPayload(data),
    });
  })
);

router.get(
  "/control-room/marketing",
  asyncHandler(async (_req, res) => {
    const marketing = await getMarketingControlRoomView();
    return res.json({ ok: true, generatedAt: marketing.generatedAt, view: buildMarketingFocus(marketing) });
  })
);

router.get(
  "/control-room/sales",
  asyncHandler(async (_req, res) => {
    const sales = await getSalesSnapshot();
    return res.json({ ok: true, generatedAt: new Date().toISOString(), view: buildSalesFocus(sales) });
  })
);

router.get(
  "/control-room/founder",
  asyncHandler(async (_req, res) => {
    const data = await getControlRoomSourceData();
    return res.json({ ok: true, generatedAt: new Date().toISOString(), view: buildFounderFocus(data) });
  })
);

router.post(
  "/control-room/autonomy-preferences/:agentRole/:actionType/enable",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const preference = await setAutonomyPreferenceMode(
      req.params.agentRole,
      req.params.actionType,
      "auto"
    );
    return res.json({ ok: true, preference });
  })
);

router.post(
  "/control-room/autonomy-preferences/:agentRole/:actionType/manual",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const preference = await setAutonomyPreferenceMode(
      req.params.agentRole,
      req.params.actionType,
      "manual"
    );
    return res.json({ ok: true, preference });
  })
);

router.get(
  "/control-room/admissions",
  asyncHandler(async (_req, res) => {
    const admissions = await getAdmissionsSnapshot();
    return res.json({ ok: true, generatedAt: new Date().toISOString(), view: buildAdmissionsFocus(admissions) });
  })
);

router.get(
  "/control-room/support",
  asyncHandler(async (_req, res) => {
    const support = await getSupportSnapshot();
    return res.json({ ok: true, generatedAt: new Date().toISOString(), view: buildSupportFocus(support) });
  })
);

router.get(
  "/control-room/engineering",
  asyncHandler(async (_req, res) => {
    return res.json({ ok: true, generatedAt: new Date().toISOString(), view: buildEngineeringFocus() });
  })
);

router.get(
  "/control-room/payments-risk",
  asyncHandler(async (_req, res) => {
    const payments = await getPaymentsRiskSnapshot();
    return res.json({ ok: true, generatedAt: new Date().toISOString(), view: buildPaymentsFocus(payments) });
  })
);

router.get(
  "/control-room/lifecycle",
  asyncHandler(async (_req, res) => {
    const { lifecycle } = await getControlRoomSourceData();
    return res.json({ ok: true, generatedAt: new Date().toISOString(), view: buildLifecycleFocus(lifecycle) });
  })
);

router.get(
  "/control-room/incidents",
  asyncHandler(async (_req, res) => {
    const incidents = await controlRoomService.getIncidentControlRoomView();
    return res.json({ ok: true, generatedAt: incidents.generatedAt, view: buildIncidentFocus(incidents) });
  })
);

router.get(
  "/issues",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;

    const filter = {};
    const status = String(req.query.status || "").trim().toLowerCase();
    const surface = String(req.query.surface || "").trim().toLowerCase();

    if (["new", "reviewed", "resolved"].includes(status)) {
      filter.status = status;
    }
    if (["public", "attorney", "paralegal"].includes(surface)) {
      filter.surface = surface;
    }

    const [issues, total] = await Promise.all([
      AiIssueReport.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AiIssueReport.countDocuments(filter),
    ]);

    applyLegacyIssueRouteHeaders(res);
    return res.json({
      ok: true,
      meta: buildLegacyIssueRouteMeta(),
      issues,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  })
);

router.post(
  "/cto-diagnose-test",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const diagnosis = await runCtoDiagnosis(req.body || {});
    return res.status(diagnosis.ok ? 200 : Number(diagnosis.statusCode) || 400).json(diagnosis);
  })
);

router.post(
  "/cto-execution-test",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const execution = await buildExecutionPacket(req.body || {});
    return res.status(execution.ok ? 200 : Number(execution.statusCode) || 400).json(execution);
  })
);

router.patch(
  "/issues/:id",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const issueId = String(req.params.id || "").trim();
    if (!mongoose.isValidObjectId(issueId)) {
      return res.status(400).json({ error: "Invalid issue id" });
    }

    const nextStatus = String(req.body?.status || "").trim().toLowerCase();
    if (!["new", "reviewed", "resolved"].includes(nextStatus)) {
      return res.status(400).json({ error: "Valid status is required" });
    }

    const issue = await AiIssueReport.findByIdAndUpdate(
      issueId,
      { status: nextStatus },
      { new: true, runValidators: true }
    );

    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }

    applyLegacyIssueRouteHeaders(res);
    return res.json({
      ok: true,
      meta: buildLegacyIssueRouteMeta(),
      issue,
    });
  })
);

router.use((err, _req, res, _next) => {
  console.error("[aiAdmin]", err);
  return res.status(500).json({ error: "Unable to process admin AI request" });
});

module.exports = router;
