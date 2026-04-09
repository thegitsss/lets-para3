const mongoose = require("mongoose");

const Incident = require("../../models/Incident");
const SupportTicket = require("../../models/SupportTicket");
const CtoAgentRun = require("../../models/CtoAgentRun");
const CtoExecutionRun = require("../../models/CtoExecutionRun");
const controlRoomService = require("../incidents/controlRoomService");
const { runCtoDiagnosis } = require("../ai/ctoAgentService");
const { buildExecutionPacket } = require("../ai/ctoExecutionService");
const { INCIDENT_TERMINAL_STATES } = require("../../utils/incidentConstants");
const {
  buildEventRecorder,
  buildNextJobFields,
  clearIncidentLock,
} = require("../incidents/workflowService");

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

const ENGINEERING_STATUSES = Object.freeze([
  "Needs Diagnosis",
  "Diagnosed",
  "Awaiting Approval",
  "In Progress",
  "Ready for Test",
  "Blocked",
  "Resolved",
]);

const STATUS_ORDER = Object.freeze({
  Blocked: 0,
  "Awaiting Approval": 1,
  "Ready for Test": 2,
  "In Progress": 3,
  "Needs Diagnosis": 4,
  Diagnosed: 5,
  Resolved: 6,
});

const RISK_ORDER = Object.freeze({
  high: 3,
  medium: 2,
  low: 1,
});

const SEVERITY_ORDER = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

function compactText(value = "", max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function titleize(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, parsed);
}

function isTerminalIncident(incident = {}) {
  return INCIDENT_TERMINAL_STATES.includes(String(incident.state || ""));
}

function incidentRiskWeight(incident = {}) {
  const riskLevel = String(incident.classification?.riskLevel || "low").toLowerCase();
  const severity = String(incident.classification?.severity || "low").toLowerCase();
  const risk = RISK_ORDER[riskLevel] || 0;
  const severityBonus = severity === "critical" ? 2 : severity === "high" ? 1 : 0;
  return risk + severityBonus;
}

function resolveIncidentLookup(identifier = "") {
  const value = String(identifier || "").trim();
  if (!value) return null;
  if (mongoose.isValidObjectId(value)) {
    return {
      $or: [{ _id: new mongoose.Types.ObjectId(value) }, { publicId: value }],
    };
  }
  return { publicId: value };
}

function buildIncidentMetadataQuery(incident = {}) {
  const incidentId = String(incident._id || "").trim();
  const publicId = String(incident.publicId || "").trim();
  const or = [];

  if (incidentId) {
    or.push(
      { "metadata.incidentId": incidentId },
      { "metadata.metadata.incidentId": incidentId },
      { "sourceIssueSnapshot.metadata.incidentId": incidentId },
      { "sourceDiagnosisSnapshot.metadata.incidentId": incidentId }
    );
  }
  if (publicId) {
    or.push(
      { "metadata.incidentPublicId": publicId },
      { "metadata.metadata.incidentPublicId": publicId },
      { "sourceIssueSnapshot.metadata.incidentPublicId": publicId },
      { "sourceDiagnosisSnapshot.metadata.incidentPublicId": publicId }
    );
  }

  return or.length ? { $or: or } : null;
}

async function findLatestLinkedCtoRun(incident = {}) {
  const query = buildIncidentMetadataQuery(incident);
  if (!query) return null;
  return CtoAgentRun.findOne(query).sort({ createdAt: -1, generatedAt: -1 }).lean();
}

async function findLatestLinkedExecutionRun(incident = {}, latestCtoRun = null) {
  if (latestCtoRun?._id) {
    const direct = await CtoExecutionRun.findOne({ ctoRunId: latestCtoRun._id })
      .sort({ createdAt: -1, generatedAt: -1 })
      .lean();
    if (direct) return direct;
  }
  const query = buildIncidentMetadataQuery(incident);
  if (!query) return null;
  return CtoExecutionRun.findOne(query).sort({ createdAt: -1, generatedAt: -1 }).lean();
}

async function findLinkedSupportTickets(incident = {}, limit = 5) {
  if (!incident?._id) return [];
  return SupportTicket.find({ linkedIncidentIds: incident._id })
    .select(
      "subject status urgency requesterRole requesterEmail requesterUserId routePath latestUserMessage routingSuggestion updatedAt createdAt"
    )
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(Math.max(1, Number(limit) || 5))
    .lean();
}

async function getSupportReportSignals(incident = {}) {
  if (!incident?._id) {
    return {
      reportCount: 0,
      latestTicket: null,
      lastReportedAt: null,
    };
  }

  const [reportCount, latestTicket] = await Promise.all([
    SupportTicket.countDocuments({ linkedIncidentIds: incident._id }),
    SupportTicket.findOne({ linkedIncidentIds: incident._id })
      .select(
        "subject status urgency requesterRole requesterEmail requesterUserId routePath latestUserMessage routingSuggestion updatedAt createdAt"
      )
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean(),
  ]);

  return {
    reportCount,
    latestTicket,
    lastReportedAt: latestTicket?.updatedAt || latestTicket?.createdAt || null,
  };
}

function mapExecutionStatus(executionStatus = "") {
  const normalized = String(executionStatus || "").trim().toLowerCase();
  if (normalized === "resolved") return "Resolved";
  if (normalized === "blocked") return "Blocked";
  if (normalized === "awaiting_approval") return "Awaiting Approval";
  if (normalized === "ready_for_test") return "Ready for Test";
  if (["in_progress", "ready_for_review", "ready_for_deploy"].includes(normalized)) return "In Progress";
  return "";
}

function deriveEngineeringStatus({
  incident = {},
  latestInvestigation = null,
  latestPatch = null,
  latestVerification = null,
  latestApproval = null,
  latestCtoRun = null,
  latestExecutionRun = null,
} = {}) {
  if (isTerminalIncident(incident)) return "Resolved";
  const executionMapped = mapExecutionStatus(latestExecutionRun?.executionStatus);
  if (executionMapped) return executionMapped;

  const incidentState = String(incident.state || "").trim().toLowerCase();
  const approvalState = String(incident.approvalState || "").trim().toLowerCase();
  const investigationStatus = String(latestInvestigation?.status || "").trim().toLowerCase();
  const patchStatus = String(latestPatch?.status || "").trim().toLowerCase();
  const verificationStatus = String(latestVerification?.status || "").trim().toLowerCase();
  const approvalStatus = String(latestApproval?.status || "").trim().toLowerCase();

  if (
    ["verification_failed", "deploy_failed", "needs_more_context", "needs_human_owner"].includes(incidentState) ||
    ["failed", "blocked"].includes(patchStatus) ||
    verificationStatus === "failed" ||
    approvalStatus === "rejected" ||
    approvalState === "rejected"
  ) {
    return "Blocked";
  }

  if (incidentState === "awaiting_founder_approval" || approvalStatus === "pending" || approvalState === "pending") {
    return "Awaiting Approval";
  }

  if (
    incidentState === "awaiting_verification" ||
    verificationStatus === "queued" ||
    (patchStatus === "completed" && !latestVerification)
  ) {
    return "Ready for Test";
  }

  if (
    ["investigating", "patch_planning", "patching", "deploying_preview", "deploying_production", "post_deploy_verifying", "rollback_in_progress"].includes(
      incidentState
    ) ||
    ["running"].includes(investigationStatus) ||
    ["planned", "running"].includes(patchStatus) ||
    verificationStatus === "running"
  ) {
    return "In Progress";
  }

  if (
    latestCtoRun ||
    ["completed", "escalated", "no_repro"].includes(investigationStatus) ||
    compactText(latestInvestigation?.rootCauseSummary || "", 20)
  ) {
    return "Diagnosed";
  }

  return "Needs Diagnosis";
}

function statusTone(status = "") {
  if (status === "Resolved") return "healthy";
  if (status === "Blocked") return "blocked";
  if (status === "Awaiting Approval") return "needs-review";
  if (status === "Ready for Test") return "active";
  if (status === "In Progress") return "active";
  if (status === "Diagnosed") return "active";
  return "priority";
}

function summarizeSourceContext(incident = {}) {
  const parts = [];
  if (incident.context?.surface) parts.push(titleize(incident.context.surface));
  if (incident.context?.featureKey) parts.push(titleize(incident.context.featureKey));
  if (incident.context?.routePath) parts.push(incident.context.routePath);
  return parts.join(" · ");
}

function buildPrimaryAction({ status = "", incident = {}, linkedSupportTickets = [], latestCtoRun = null } = {}) {
  if (status === "Needs Diagnosis") {
    return {
      key: "run-diagnosis",
      label: "Run Diagnosis",
      actionType: "run_diagnosis",
      incidentId: incident.publicId || String(incident._id || ""),
      description: "Generate a CTO diagnosis packet from this engineering item.",
      enabled: true,
    };
  }
  if (status === "Diagnosed" && latestCtoRun?._id) {
    return {
      key: "build-execution",
      label: "Build Execution Packet",
      actionType: "build_execution",
      incidentId: incident.publicId || String(incident._id || ""),
      description: "Turn the current diagnosis into an execution packet.",
      enabled: true,
    };
  }
  if (status === "Diagnosed") {
    return {
      key: "run-diagnosis-diagnosed",
      label: "Run Diagnosis",
      actionType: "run_diagnosis",
      incidentId: incident.publicId || String(incident._id || ""),
      description: "Generate a founder-readable CTO diagnosis packet for this already-investigated incident.",
      enabled: true,
    };
  }
  if (status === "Awaiting Approval") {
    return {
      key: "open-incident-workspace",
      label: "Open Incident Workspace",
      actionType: "open_incident_workspace",
      incidentId: incident.publicId || String(incident._id || ""),
      description: "Review the approval-gated incident release context.",
      enabled: true,
    };
  }
  if (status === "Ready for Test") {
    return {
      key: "review-verification",
      label: "Review Test Context",
      actionType: "open_incident_workspace",
      incidentId: incident.publicId || String(incident._id || ""),
      description: "Inspect verification and release readiness in the incident workspace.",
      enabled: true,
    };
  }
  if (status === "Blocked") {
    if (linkedSupportTickets.length) {
      return {
        key: "open-support-context",
        label: "Open Support Context",
        actionType: "open_support_ticket",
        ticketId: String(linkedSupportTickets[0]._id || ""),
        description: "Open the highest-signal linked support ticket for user impact context.",
        enabled: true,
      };
    }
    return {
      key: "open-incident-workspace-blocked",
      label: "Review Blocker",
      actionType: "open_incident_workspace",
      incidentId: incident.publicId || String(incident._id || ""),
      description: "Inspect the incident blocker and approval posture.",
      enabled: true,
    };
  }
  if (status === "Resolved") {
    return {
      key: "open-incident-workspace-resolved",
      label: "Review Resolution",
      actionType: "open_incident_workspace",
      incidentId: incident.publicId || String(incident._id || ""),
      description: "Open the canonical incident record and review how this was resolved.",
      enabled: true,
    };
  }
  return {
    key: "open-incident-workspace-progress",
    label: "Open Incident Workspace",
    actionType: "open_incident_workspace",
    incidentId: incident.publicId || String(incident._id || ""),
    description: "Open the source incident and review current engineering state.",
    enabled: true,
  };
}

function buildSecondaryAction({ incident = {}, linkedSupportTickets = [] } = {}) {
  if (linkedSupportTickets.length) {
    return {
      key: "open-support-ticket",
      label: "Open Support Ops",
      actionType: "open_support_ticket",
      ticketId: String(linkedSupportTickets[0]._id || ""),
      description: "Open the linked support ticket in Support Ops.",
      enabled: true,
    };
  }
  if (incident.context?.pageUrl) {
    return {
      key: "open-source-page",
      label: "Open Source Page",
      actionType: "open_source_page",
      href: incident.context.pageUrl,
      description: "Open the source page URL in a new tab.",
      enabled: true,
    };
  }
  return null;
}

function buildResolveAction({ incident = {} } = {}) {
  if (isTerminalIncident(incident)) return null;
  return {
    key: "mark-resolved",
    label: "Mark as Resolved",
    actionType: "mark_resolved",
    incidentId: incident.publicId || String(incident._id || ""),
    description:
      "Resolve the incident, close linked support tickets, and notify the user immediately in their support chat.",
    enabled: true,
    emphasis: "success",
  };
}

function buildRecommendedNextAction({
  status = "",
  incident = {},
  latestCtoRun = null,
  latestExecutionRun = null,
} = {}) {
  const incidentId = incident.publicId || String(incident._id || "");
  if (status === "Resolved") {
    return {
      key: "review-resolution",
      label: "Review Resolution",
      actionType: "open_incident_workspace",
      incidentId,
      description: "Review the resolved incident record and verify the closure quality.",
      enabled: true,
      emphasis: "neutral",
    };
  }
  if (!latestCtoRun) {
    return {
      key: "recommended-run-diagnosis",
      label: "Run Diagnosis",
      actionType: "run_diagnosis",
      incidentId,
      description: "No CTO diagnosis packet is attached yet. Generate that first so the next engineering step is explicit.",
      enabled: true,
      emphasis: "priority",
    };
  }
  if (!latestExecutionRun) {
    return {
      key: "recommended-build-execution",
      label: "Build Execution Packet",
      actionType: "build_execution",
      incidentId,
      description: "The diagnosis exists. Build the execution packet now so engineering has a concrete fix prompt and test plan.",
      enabled: true,
      emphasis: "priority",
    };
  }
  if (status === "Ready for Test") {
    return {
      key: "recommended-mark-resolved",
      label: "Mark as Resolved",
      actionType: "mark_resolved",
      incidentId,
      description:
        "The fix looks applied and ready to close. Resolve the incident to close linked support tickets and notify the user immediately.",
      enabled: true,
      emphasis: "success",
    };
  }
  return {
    key: "recommended-copy-prompt",
    label: "Ready to Fix - Copy Prompt",
    actionType: "copy_prompt",
    incidentId,
    description:
      "Copy the CTO execution prompt so the fix can be applied quickly, then come back here and mark the incident resolved.",
    enabled: true,
    emphasis: "active",
  };
}

function buildRecommendation({ status = "", incident = {}, linkedSupportTickets = [], latestCtoRun = null } = {}) {
  if (status === "Needs Diagnosis") {
    return linkedSupportTickets.length
      ? "This issue reached Engineering from user-facing support, but a founder-readable CTO diagnosis packet is not attached yet."
      : "This issue is visible in the engineering queue but does not yet have a founder-readable diagnosis packet.";
  }
  if (status === "Diagnosed") {
    const autoDiagnosis = latestCtoRun?.metadata?.metadata?.autoDiagnosis === true;
    if (autoDiagnosis) {
      return "A CTO diagnosis was started automatically from support escalation. Review the packet, then decide whether execution planning should move forward.";
    }
    return "A diagnosis exists. The next step is to prepare execution planning without implying deployment authority.";
  }
  if (status === "Awaiting Approval") {
    return "This item is paused on approval or approval-equivalent release review. Keep deployment and user-resolution decisions manual.";
  }
  if (status === "Ready for Test") {
    return "Implementation looks far enough along that the main question is test and verification readiness.";
  }
  if (status === "Blocked") {
    return linkedSupportTickets.length
      ? "This item is blocked. Review the linked user/support context before deciding whether the blocker is technical, procedural, or approval-related."
      : "This engineering item is blocked and needs direct review before it can move forward.";
  }
  if (status === "Resolved") {
    return "This item is resolved. Review closure quality and whether user-facing communication is still needed.";
  }
  return "This engineering item is active. Review the latest technical and user-impact context before taking the next manual step.";
}

function serializeLinkedSupportTicket(ticket = {}) {
  return {
    id: String(ticket._id || ""),
    subject: ticket.subject || "Support ticket",
    status: titleize(ticket.status || "open"),
    urgency: titleize(ticket.urgency || "medium"),
    requesterRole: titleize(ticket.requesterRole || "unknown"),
    requesterEmail: ticket.requesterEmail || "",
    routePath: ticket.routePath || "",
    latestUserMessage: compactText(ticket.latestUserMessage || ticket.message || "", 180),
    updatedAt: ticket.updatedAt || null,
  };
}

function buildSupportReportSummary({ reportCount = 0, latestTicket = null, lastReportedAt = null } = {}) {
  const normalizedCount = Math.max(0, Number(reportCount) || 0);
  const additionalReportCount = normalizedCount > 1 ? normalizedCount - 1 : 0;
  return {
    reportCount: normalizedCount,
    additionalReportCount,
    additionalReportLabel:
      additionalReportCount > 0
        ? `+${additionalReportCount} ${additionalReportCount === 1 ? "new user report" : "new user reports"}`
        : "",
    lastReportedAt: lastReportedAt || null,
    latestSupportReport: latestTicket ? serializeLinkedSupportTicket(latestTicket) : null,
  };
}

function buildUrgencyIndicator({ incident = {}, reportCount = 0 } = {}) {
  const severity = String(incident.classification?.severity || "low").trim().toLowerCase();
  const riskLevel = String(incident.classification?.riskLevel || "low").trim().toLowerCase();
  const severityRank = SEVERITY_ORDER[severity] || 1;
  const riskRank = RISK_ORDER[riskLevel] || 1;
  let visualLevel = "low";
  if (severity === "critical") visualLevel = "critical";
  else if (severityRank >= 3 || riskRank >= 3) visualLevel = "high";
  else if (severityRank >= 2 || riskRank >= 2) visualLevel = "medium";

  const affectedUsers = Math.max(0, Number(reportCount) || 0);
  return {
    severity: titleize(severity || "low"),
    riskLevel: titleize(riskLevel || "low"),
    visualLevel,
    affectedUsers,
    affectedUsersLabel: `${affectedUsers} affected ${affectedUsers === 1 ? "user" : "users"}`,
    openedAt: incident.createdAt || null,
  };
}

function serializeCtoRun(run = null, options = {}) {
  if (!run) return null;
  const nestedMetadata = run.metadata?.metadata || {};
  const includePrompt = options.includePrompt === true;
  return {
    id: String(run._id || ""),
    category: run.category || "",
    urgency: run.urgency || "",
    technicalSeverity: run.technicalSeverity || "",
    diagnosisSummary: run.diagnosisSummary || "",
    filesToInspect: Array.isArray(run.filesToInspect) ? run.filesToInspect : [],
    recommendedFixStrategy: run.recommendedFixStrategy || "",
    testPlan: Array.isArray(run.testPlan) ? run.testPlan : [],
    deploymentRisk: run.deploymentRisk || "",
    generatedAt: run.generatedAt || run.createdAt || null,
    source: nestedMetadata.triggerSource || run.metadata?.source || "",
    autoDiagnosis: nestedMetadata.autoDiagnosis === true,
    triggerLabel: nestedMetadata.triggerLabel || "",
    ...(includePrompt ? { codexPatchPrompt: run.codexPatchPrompt || "" } : {}),
  };
}

function serializeExecutionRun(run = null, options = {}) {
  if (!run) return null;
  const includePrompt = options.includePrompt === true;
  return {
    id: String(run._id || ""),
    executionStatus: run.executionStatus || "",
    implementationSummary: run.implementationSummary || "",
    executionPlan: Array.isArray(run.executionPlan) ? run.executionPlan : [],
    requiredTests: Array.isArray(run.requiredTests) ? run.requiredTests : [],
    deploymentChecklist: Array.isArray(run.deploymentChecklist) ? run.deploymentChecklist : [],
    deploymentReadiness: run.deploymentReadiness || {},
    resolutionMessageDraft: run.resolutionMessageDraft || "",
    generatedAt: run.generatedAt || run.createdAt || null,
    ...(includePrompt ? { codexExecutionPrompt: run.codexExecutionPrompt || "" } : {}),
  };
}

async function buildEngineeringItemFromIncident(incident = {}, options = {}) {
  const incidentDetail = await controlRoomService.getIncidentDetail(incident.publicId || incident._id);
  const [linkedSupportTickets, supportReportSignals] = await Promise.all([
    findLinkedSupportTickets(incident, 4),
    getSupportReportSignals(incident),
  ]);
  const latestCtoRun = await findLatestLinkedCtoRun(incident);
  const latestExecutionRun = await findLatestLinkedExecutionRun(incident, latestCtoRun);
  const status = deriveEngineeringStatus({
    incident,
    latestInvestigation: incidentDetail?.latestInvestigation || null,
    latestPatch: incidentDetail?.latestPatch || null,
    latestVerification: incidentDetail?.latestVerification || null,
    latestApproval: incidentDetail?.latestApproval || null,
    latestCtoRun,
    latestExecutionRun,
  });

  const primaryAction = buildPrimaryAction({
    status,
    incident,
    linkedSupportTickets,
    latestCtoRun,
  });
  const secondaryAction = buildSecondaryAction({ incident, linkedSupportTickets });
  const recommendedNextAction = buildRecommendedNextAction({
    status,
    incident,
    latestCtoRun,
    latestExecutionRun,
  });
  const resolveAction = buildResolveAction({ incident });
  const supportReportSummary = buildSupportReportSummary(supportReportSignals);
  const urgency = buildUrgencyIndicator({
    incident,
    reportCount: supportReportSummary.reportCount,
  });

  return {
    id: String(incident._id || ""),
    publicId: incident.publicId || "",
    title: compactText(incident.summary || incident.originalReportText || incident.publicId || "Engineering item", 110),
    summary: compactText(incident.summary || incident.originalReportText || "", 200),
    engineeringStatus: status,
    tone: statusTone(status),
    recommendation: buildRecommendation({ status, incident, linkedSupportTickets, latestCtoRun }),
    recommendedNextAction,
    resolveAction,
    urgency,
    sourceContextLabel: summarizeSourceContext(incident),
    sourceContext: {
      surface: titleize(incident.context?.surface || ""),
      featureKey: titleize(incident.context?.featureKey || ""),
      routePath: incident.context?.routePath || "",
      pageUrl: incident.context?.pageUrl || "",
      caseId: String(incident.context?.caseId || ""),
      jobId: String(incident.context?.jobId || ""),
      applicationId: String(incident.context?.applicationId || ""),
      reporterRole: titleize(incident.reporter?.role || ""),
      reporterEmail: incident.reporter?.email || "",
    },
    incident: controlRoomService.serializeIncidentSummary
      ? controlRoomService.serializeIncidentSummary(incident)
      : incident,
    risk: {
      level: titleize(incident.classification?.riskLevel || "low"),
      severity: titleize(incident.classification?.severity || "low"),
      domain: titleize(incident.classification?.domain || "unknown"),
    },
    linkedSupportCount: supportReportSummary.reportCount,
    additionalSupportReportCount: supportReportSummary.additionalReportCount,
    additionalSupportReportLabel: supportReportSummary.additionalReportLabel,
    lastReportedAt: supportReportSummary.lastReportedAt,
    latestSupportReport: supportReportSummary.latestSupportReport,
    linkedSupportTickets: linkedSupportTickets.map(serializeLinkedSupportTicket),
    latestCtoRun: serializeCtoRun(latestCtoRun, { includePrompt: options.includePrompts === true }),
    latestExecutionRun: serializeExecutionRun(latestExecutionRun, { includePrompt: options.includePrompts === true }),
    primaryAction,
    secondaryAction,
    updatedAt: incident.updatedAt || incident.createdAt || null,
    createdAt: incident.createdAt || null,
    incidentDetail,
  };
}

function compareEngineeringItems(left = {}, right = {}) {
  const statusDelta = (STATUS_ORDER[left.engineeringStatus] ?? 99) - (STATUS_ORDER[right.engineeringStatus] ?? 99);
  if (statusDelta) return statusDelta;
  const riskDelta = incidentRiskWeight(right.incident) - incidentRiskWeight(left.incident);
  if (riskDelta) return riskDelta;
  const rightActivityAt = new Date(right.lastReportedAt || right.updatedAt || 0).getTime();
  const leftActivityAt = new Date(left.lastReportedAt || left.updatedAt || 0).getTime();
  return rightActivityAt - leftActivityAt;
}

async function listEngineeringItems({ limit = DEFAULT_LIMIT } = {}) {
  const docs = await Incident.find({})
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(normalizeLimit(limit))
    .lean();

  const items = await Promise.all(docs.map((incident) => buildEngineeringItemFromIncident(incident)));
  return items.sort(compareEngineeringItems);
}

function buildQuickActions(items = []) {
  const actions = [];
  const topBlocked = items.find((item) => item.engineeringStatus === "Blocked");
  const topNeedsDiagnosis = items.find((item) => item.engineeringStatus === "Needs Diagnosis");
  const topAwaitingApproval = items.find((item) => item.engineeringStatus === "Awaiting Approval");
  const topReadyForTest = items.find((item) => item.engineeringStatus === "Ready for Test");

  if (topBlocked?.primaryAction) actions.push(topBlocked.primaryAction);
  if (topNeedsDiagnosis?.primaryAction) actions.push(topNeedsDiagnosis.primaryAction);
  if (topAwaitingApproval?.primaryAction) actions.push(topAwaitingApproval.primaryAction);
  if (topReadyForTest?.primaryAction) actions.push(topReadyForTest.primaryAction);

  actions.push({
    key: "refresh-engineering-workspace",
    label: "Refresh Engineering Queue",
    actionType: "refresh_workspace",
    description: "Reload the engineering summary, queue, and item detail safely.",
    enabled: true,
  });

  const seen = new Set();
  return actions.filter((action) => {
    const key = `${action.actionType}:${action.incidentId || ""}:${action.ticketId || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildOverview(items = []) {
  const activeItems = items.filter((item) => item.engineeringStatus !== "Resolved");
  const blockedCount = items.filter((item) => item.engineeringStatus === "Blocked").length;
  const awaitingApprovalCount = items.filter((item) => item.engineeringStatus === "Awaiting Approval").length;
  const readyForTestCount = items.filter((item) => item.engineeringStatus === "Ready for Test").length;
  const resolvedTodayCount = items.filter((item) => {
    if (item.engineeringStatus !== "Resolved") return false;
    const updatedAt = new Date(item.updatedAt || 0);
    const today = new Date();
    return (
      updatedAt.getFullYear() === today.getFullYear() &&
      updatedAt.getMonth() === today.getMonth() &&
      updatedAt.getDate() === today.getDate()
    );
  }).length;

  let recommendation = "No engineering work is currently visible.";
  if (blockedCount) {
    recommendation = "Review blocked engineering items first, especially where user impact is already visible in linked support or incident context.";
  } else if (awaitingApprovalCount) {
    recommendation = "Review approval-gated engineering items before lower-priority queue cleanup.";
  } else if (readyForTestCount) {
    recommendation = "Review ready-for-test items next because they are closest to validated resolution without implying deployment authority.";
  } else if (activeItems.length) {
    recommendation = "Review the top engineering queue items in order of status, risk, and recency.";
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      activeCount: activeItems.length,
      blockedCount,
      awaitingApprovalCount,
      readyForTestCount,
      resolvedTodayCount,
      recommendation,
      guardrail:
        "No auto-deploy. Engineering remains approval-first and manual-review only, even when a diagnosis or execution packet exists.",
    },
    quickActions: buildQuickActions(items),
  };
}

async function getEngineeringOverview() {
  const items = await listEngineeringItems({ limit: DEFAULT_LIMIT });
  return buildOverview(items);
}

async function getEngineeringItem(identifier = "") {
  const detail = await controlRoomService.getIncidentDetail(identifier);
  if (!detail?.incident?.id) return null;
  const incident = await Incident.findById(detail.incident.id).lean();
  if (!incident) return null;
  return buildEngineeringItemFromIncident(incident, { includePrompts: true });
}

function mapIncidentToCtoCategory(incident = {}) {
  const domain = String(incident.classification?.domain || "").trim().toLowerCase();
  const routePath = String(incident.context?.routePath || "").toLowerCase();
  const pageUrl = String(incident.context?.pageUrl || "").toLowerCase();
  const summary = `${String(incident.summary || "")} ${String(incident.originalReportText || "")}`.toLowerCase();

  if (domain === "auth") return "login";
  if (domain === "approvals") return "account_approval";
  if (domain === "permissions" || domain === "admin_tools") return "admin_permissions";
  if (domain === "stripe_onboarding") return "stripe_onboarding";
  if (["payments", "escrow", "payouts", "withdrawals", "disputes"].includes(domain)) return "payment";
  if (domain === "messaging") return /\bsend|reply\b/.test(summary) ? "message_send" : "messaging";
  if (domain === "profile") return "profile_save";
  if (/dashboard/.test(routePath) || /dashboard/.test(pageUrl) || /\bdashboard\b/.test(summary)) return "dashboard_load";
  if (["case_lifecycle", "matching", "documents", "notifications"].includes(domain)) return "case_posting";
  if (["ui", "navigation", "profile_visibility", "performance", "data_integrity"].includes(domain)) return "ui_interaction";
  return "unknown";
}

function mapIncidentToCtoUrgency(incident = {}) {
  const severity = String(incident.classification?.severity || "").trim().toLowerCase();
  const riskLevel = String(incident.classification?.riskLevel || "").trim().toLowerCase();
  if (severity === "critical" || severity === "high" || riskLevel === "high") return "high";
  if (severity === "medium" || riskLevel === "medium") return "medium";
  return "low";
}

function buildDiagnosisPayloadFromIncident(incident = {}, options = {}) {
  const triggerSource = String(options.triggerSource || "engineering_workspace_incident").trim();
  const triggerLabel = String(options.triggerLabel || "").trim();
  return {
    category: mapIncidentToCtoCategory(incident),
    urgency: mapIncidentToCtoUrgency(incident),
    originalMessage: incident.originalReportText || incident.summary || "",
    internalSummary: incident.summary || incident.originalReportText || "",
    userEmail: incident.reporter?.email || "",
    source: triggerSource,
    status: incident.state || "",
    metadata: {
      incidentId: String(incident._id || ""),
      incidentPublicId: incident.publicId || "",
      domain: incident.classification?.domain || "",
      riskLevel: incident.classification?.riskLevel || "",
      severity: incident.classification?.severity || "",
      page: incident.context?.routePath || incident.context?.pageUrl || "",
      routePath: incident.context?.routePath || "",
      pageUrl: incident.context?.pageUrl || "",
      surface: incident.context?.surface || "",
      featureKey: incident.context?.featureKey || "",
      role: incident.reporter?.role || incident.context?.surface || "",
      caseId: String(incident.context?.caseId || ""),
      jobId: String(incident.context?.jobId || ""),
      applicationId: String(incident.context?.applicationId || ""),
      autoDiagnosis: options.autoDiagnosis === true,
      triggerSource,
      triggerLabel,
    },
  };
}

async function runEngineeringDiagnosis({
  incidentIdentifier = "",
  force = false,
  triggerSource = "engineering_workspace_incident",
  autoDiagnosis = false,
  triggerLabel = "",
} = {}) {
  const incidentLookup = resolveIncidentLookup(incidentIdentifier);
  if (!incidentLookup) {
    const error = new Error("Incident not found.");
    error.statusCode = 404;
    throw error;
  }
  const incident = await Incident.findOne(incidentLookup).lean();
  if (!incident) {
    const error = new Error("Incident not found.");
    error.statusCode = 404;
    throw error;
  }

  const latestCtoRun = await findLatestLinkedCtoRun(incident);
  if (!force && latestCtoRun && new Date(latestCtoRun.generatedAt || latestCtoRun.createdAt || 0) >= new Date(incident.updatedAt || 0)) {
    return {
      reused: true,
      diagnosis: {
        ok: true,
        incidentId: String(incident._id),
        incidentPublicId: incident.publicId,
        runId: String(latestCtoRun._id),
        saved: true,
      },
      item: await buildEngineeringItemFromIncident(incident, { includePrompts: true }),
    };
  }

  const diagnosis = await runCtoDiagnosis({
    ...buildDiagnosisPayloadFromIncident(incident, { triggerSource, autoDiagnosis, triggerLabel }),
    saveRun: true,
  });

  return {
    reused: false,
    diagnosis,
    item: await buildEngineeringItemFromIncident(incident, { includePrompts: true }),
  };
}

async function buildEngineeringExecution({ incidentIdentifier = "", force = false } = {}) {
  const incidentLookup = resolveIncidentLookup(incidentIdentifier);
  if (!incidentLookup) {
    const error = new Error("Incident not found.");
    error.statusCode = 404;
    throw error;
  }
  const incident = await Incident.findOne(incidentLookup).lean();
  if (!incident) {
    const error = new Error("Incident not found.");
    error.statusCode = 404;
    throw error;
  }

  const latestCtoRun = await findLatestLinkedCtoRun(incident);
  if (!latestCtoRun?._id) {
    const error = new Error("This engineering item needs a diagnosis before an execution packet can be built.");
    error.statusCode = 409;
    throw error;
  }

  const latestExecutionRun = await findLatestLinkedExecutionRun(incident, latestCtoRun);
  if (
    !force &&
    latestExecutionRun &&
    String(latestExecutionRun.ctoRunId || "") === String(latestCtoRun._id) &&
    new Date(latestExecutionRun.generatedAt || latestExecutionRun.createdAt || 0) >=
      new Date(latestCtoRun.generatedAt || latestCtoRun.createdAt || 0)
  ) {
    return {
      reused: true,
      execution: {
        ok: true,
        ctoRunId: String(latestCtoRun._id),
        executionRunId: String(latestExecutionRun._id),
        saved: true,
      },
      item: await buildEngineeringItemFromIncident(incident, { includePrompts: true }),
    };
  }

  const execution = await buildExecutionPacket({
    ctoRunId: String(latestCtoRun._id),
    saveRun: true,
  });

  return {
    reused: false,
    execution,
    item: await buildEngineeringItemFromIncident(incident, { includePrompts: true }),
  };
}

async function resolveEngineeringIncident({ incidentIdentifier = "", actor = {} } = {}) {
  const incidentLookup = resolveIncidentLookup(incidentIdentifier);
  if (!incidentLookup) {
    const error = new Error("Incident not found.");
    error.statusCode = 404;
    throw error;
  }

  const incident = await Incident.findOne(incidentLookup);
  if (!incident) {
    const error = new Error("Incident not found.");
    error.statusCode = 404;
    throw error;
  }

  if (isTerminalIncident(incident)) {
    return {
      alreadyResolved: true,
      item: await buildEngineeringItemFromIncident(incident.toObject(), { includePrompts: true }),
    };
  }

  const latestCtoRun = await findLatestLinkedCtoRun(incident);
  const latestExecutionRun = await findLatestLinkedExecutionRun(incident, latestCtoRun);
  const recorder = buildEventRecorder(incident);
  const fromState = String(incident.state || "");
  const now = new Date();
  const resolutionSummary = compactText(
    latestExecutionRun?.resolutionMessageDraft ||
      latestExecutionRun?.implementationSummary ||
      latestCtoRun?.recommendedFixStrategy ||
      incident.summary ||
      incident.originalReportText ||
      "Issue resolved by the engineering team.",
    240
  );

  clearIncidentLock(incident);
  incident.userVisibleStatus = "fixed_live";
  incident.adminVisibleStatus = "resolved";
  incident.resolution = {
    code: "fixed_deployed",
    summary: resolutionSummary,
    resolvedAt: now,
    closedAt: null,
  };
  Object.assign(incident.orchestration || (incident.orchestration = {}), buildNextJobFields("none"));
  incident.state = "resolved";

  recorder.push({
    eventType: "state_changed",
    actor: {
      type: "admin",
      userId: actor.userId || null,
      role: actor.role || "admin",
    },
    summary: "Resolved manually from the engineering workspace.",
    fromState,
    toState: "resolved",
    detail: {
      source: "engineering_workspace_manual_resolve",
      executionRunId: latestExecutionRun?._id ? String(latestExecutionRun._id) : "",
      ctoRunId: latestCtoRun?._id ? String(latestCtoRun._id) : "",
    },
  });

  recorder.finalize();
  await incident.save();
  await recorder.save();

  return {
    alreadyResolved: false,
    item: await buildEngineeringItemFromIncident(incident.toObject(), { includePrompts: true }),
  };
}

module.exports = {
  ENGINEERING_STATUSES,
  buildEngineeringExecution,
  getEngineeringItem,
  getEngineeringOverview,
  listEngineeringItems,
  resolveEngineeringIncident,
  runEngineeringDiagnosis,
};
