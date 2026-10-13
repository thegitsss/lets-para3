const mongoose = require("mongoose");

const Incident = require("../../models/Incident");
const IncidentEvent = require("../../models/IncidentEvent");
const IncidentInvestigation = require("../../models/IncidentInvestigation");
const IncidentPatch = require("../../models/IncidentPatch");
const IncidentVerification = require("../../models/IncidentVerification");
const IncidentRelease = require("../../models/IncidentRelease");
const IncidentApproval = require("../../models/IncidentApproval");
const IncidentArtifact = require("../../models/IncidentArtifact");
const IncidentNotification = require("../../models/IncidentNotification");

const {
  INCIDENT_STATES,
  INCIDENT_TERMINAL_STATES,
  INCIDENT_RISK_LEVELS,
  INCIDENT_APPROVAL_STATES,
  INCIDENT_SURFACES,
} = require("../../utils/incidentConstants");

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_TIMELINE_LIMIT = 200;
const DEFAULT_CLUSTER_LIMIT = 10;
const MAX_CLUSTER_LIMIT = 50;
const OPEN_INCIDENT_STATES = INCIDENT_STATES.filter((state) => !INCIDENT_TERMINAL_STATES.includes(state));
const RISK_WEIGHT = { high: 3, medium: 2, low: 1 };

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactText(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${Number(count) || 0} ${Number(count) === 1 ? singular : plural}`;
}

function normalizeLimit(value, defaultLimit, maxLimit) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(maxLimit, parsed);
}

function normalizePage(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeWindowHours(value, fallback = 168) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isValidEnumValue(value, allowedValues = []) {
  return allowedValues.includes(String(value || "").trim());
}

function buildIncidentListMatch(query = {}) {
  const match = {};
  const state = String(query.state || "").trim();
  const riskLevel = String(query.riskLevel || "").trim();
  const approvalState = String(query.approvalState || "").trim();
  const surface = String(query.surface || "").trim();
  const clusterKey = String(query.clusterKey || "").trim();
  const q = String(query.q || "").trim();

  if (isValidEnumValue(state, INCIDENT_STATES)) {
    match.state = state;
  }
  if (isValidEnumValue(riskLevel, INCIDENT_RISK_LEVELS)) {
    match["classification.riskLevel"] = riskLevel;
  }
  if (isValidEnumValue(approvalState, INCIDENT_APPROVAL_STATES)) {
    match.approvalState = approvalState;
  }
  if (isValidEnumValue(surface, INCIDENT_SURFACES)) {
    match["context.surface"] = surface;
  }
  if (clusterKey) {
    match["classification.clusterKey"] = clusterKey;
  }
  if (q) {
    const regex = new RegExp(escapeRegex(q), "i");
    match.$or = [
      { publicId: regex },
      { summary: regex },
      { "classification.clusterKey": regex },
      { "classification.domain": regex },
      { "context.routePath": regex },
      { "context.pageUrl": regex },
    ];
  }

  return match;
}

function resolveIncidentIdMatch(identifier) {
  const value = String(identifier || "").trim();
  if (!value) return null;
  if (mongoose.isValidObjectId(value)) {
    return {
      $or: [{ _id: new mongoose.Types.ObjectId(value) }, { publicId: value }],
    };
  }
  return { publicId: value };
}

function toId(value) {
  return value ? String(value) : "";
}

function serializeReporter(reporter = {}) {
  return {
    userId: toId(reporter.userId),
    role: reporter.role || "",
    email: reporter.email || "",
    accessTokenIssuedAt: reporter.accessTokenIssuedAt || null,
  };
}

function serializeContext(context = {}) {
  return {
    surface: context.surface || "",
    pageUrl: context.pageUrl || "",
    featureKey: context.featureKey || "",
    caseId: toId(context.caseId),
    jobId: toId(context.jobId),
    applicationId: toId(context.applicationId),
    browser: context.browser || "",
    device: context.device || "",
    routePath: context.routePath || "",
  };
}

function serializeClassification(classification = {}) {
  return {
    domain: classification.domain || "",
    severity: classification.severity || "",
    riskLevel: classification.riskLevel || "",
    confidence: classification.confidence || "",
    issueFingerprint: classification.issueFingerprint || "",
    clusterKey: classification.clusterKey || "",
    riskFlags: classification.riskFlags || {},
    suspectedRoutes: Array.isArray(classification.suspectedRoutes) ? classification.suspectedRoutes : [],
    suspectedFiles: Array.isArray(classification.suspectedFiles) ? classification.suspectedFiles : [],
  };
}

function serializeOrchestration(orchestration = {}) {
  return {
    nextJobType: orchestration.nextJobType || "none",
    nextJobRunAt: orchestration.nextJobRunAt || null,
    stageAttempts: orchestration.stageAttempts || {},
    lastWorkerAt: orchestration.lastWorkerAt || null,
  };
}

function serializeIncidentSummary(incident = {}) {
  return {
    id: toId(incident._id),
    publicId: incident.publicId || "",
    source: incident.source || "",
    summary: incident.summary || "",
    state: incident.state || "",
    approvalState: incident.approvalState || "",
    autonomyMode: incident.autonomyMode || "",
    userVisibleStatus: incident.userVisibleStatus || "",
    adminVisibleStatus: incident.adminVisibleStatus || "",
    reporter: serializeReporter(incident.reporter),
    context: serializeContext(incident.context),
    classification: serializeClassification(incident.classification),
    lastEventSeq: Number(incident.lastEventSeq || 0),
    currentApprovalId: toId(incident.currentApprovalId),
    createdAt: incident.createdAt || null,
    updatedAt: incident.updatedAt || null,
  };
}

function serializeIncidentDetail(incident = {}) {
  return {
    ...serializeIncidentSummary(incident),
    originalReportText: incident.originalReportText || "",
    duplicateOfIncidentId: toId(incident.duplicateOfIncidentId),
    currentInvestigationId: toId(incident.currentInvestigationId),
    currentPatchId: toId(incident.currentPatchId),
    currentVerificationId: toId(incident.currentVerificationId),
    currentReleaseId: toId(incident.currentReleaseId),
    currentApprovalId: toId(incident.currentApprovalId),
    latestNotificationId: toId(incident.latestNotificationId),
    orchestration: serializeOrchestration(incident.orchestration),
    resolution: incident.resolution || null,
  };
}

function serializeInvestigation(investigation = null) {
  if (!investigation) return null;
  return {
    id: toId(investigation._id),
    incidentId: toId(investigation.incidentId),
    attemptNumber: Number(investigation.attemptNumber || 0),
    status: investigation.status || "",
    triggerType: investigation.triggerType || "",
    assignedAgent: investigation.assignedAgent || "",
    rootCauseSummary: investigation.rootCauseSummary || "",
    rootCauseConfidence: investigation.rootCauseConfidence || "",
    reproductionStatus: investigation.reproductionStatus || "",
    hypotheses: Array.isArray(investigation.hypotheses) ? investigation.hypotheses : [],
    impactedDomains: Array.isArray(investigation.impactedDomains) ? investigation.impactedDomains : [],
    suspectedRoutes: Array.isArray(investigation.suspectedRoutes) ? investigation.suspectedRoutes : [],
    suspectedFiles: Array.isArray(investigation.suspectedFiles) ? investigation.suspectedFiles : [],
    suspectedDeploySha: investigation.suspectedDeploySha || "",
    recommendedAction: investigation.recommendedAction || "",
    summaryArtifactId: toId(investigation.summaryArtifactId),
    startedAt: investigation.startedAt || null,
    completedAt: investigation.completedAt || null,
    failedAt: investigation.failedAt || null,
    createdAt: investigation.createdAt || null,
    updatedAt: investigation.updatedAt || null,
  };
}

function serializePatch(patch = null) {
  if (!patch) return null;
  return {
    id: toId(patch._id),
    incidentId: toId(patch.incidentId),
    investigationId: toId(patch.investigationId),
    attemptNumber: Number(patch.attemptNumber || 0),
    status: patch.status || "",
    patchStrategy: patch.patchStrategy || "",
    baseCommitSha: patch.baseCommitSha || "",
    gitBranch: patch.gitBranch || "",
    worktreePath: patch.worktreePath || "",
    headCommitSha: patch.headCommitSha || "",
    prRef: patch.prRef || "",
    patchSummary: patch.patchSummary || "",
    filesTouched: Array.isArray(patch.filesTouched) ? patch.filesTouched : [],
    testsAdded: Array.isArray(patch.testsAdded) ? patch.testsAdded : [],
    testsModified: Array.isArray(patch.testsModified) ? patch.testsModified : [],
    highRiskTouched: patch.highRiskTouched === true,
    requiresApproval: patch.requiresApproval === true,
    blockedReason: patch.blockedReason || "",
    failureReason: patch.failureReason || "",
    startedAt: patch.startedAt || null,
    completedAt: patch.completedAt || null,
    createdAt: patch.createdAt || null,
    updatedAt: patch.updatedAt || null,
  };
}

function serializeVerification(verification = null) {
  if (!verification) return null;
  return {
    id: toId(verification._id),
    incidentId: toId(verification.incidentId),
    patchId: toId(verification.patchId),
    attemptNumber: Number(verification.attemptNumber || 0),
    status: verification.status || "",
    verificationLevel: verification.verificationLevel || "",
    requiredChecks: Array.isArray(verification.requiredChecks) ? verification.requiredChecks : [],
    failedCheckKeys: Array.isArray(verification.failedCheckKeys) ? verification.failedCheckKeys : [],
    summary: verification.summary || "",
    startedAt: verification.startedAt || null,
    completedAt: verification.completedAt || null,
    verifierAgent: verification.verifierAgent || "",
    createdAt: verification.createdAt || null,
    updatedAt: verification.updatedAt || null,
  };
}

function derivePreviewDeployStage(release = {}) {
  if (!release?.previewDeployRequestedAt) return "not_requested";
  if (release?.previewVerifiedAt) return "verified";
  if (release?.previewEvidenceReceivedAt) return "evidence_received";
  if (release?.previewDeployAcknowledgedAt) return "acknowledged";
  return "requested";
}

function deriveProductionDeployStage(release = {}) {
  if (!release?.productionDeployRequestedAt) return "not_requested";
  if (release?.productionVerifiedAt) return "verified_to_continue";
  if (release?.productionEvidenceReceivedAt) return "evidence_received";
  if (release?.productionDeployAcknowledgedAt) return "acknowledged";
  return "requested";
}

function serializeRelease(release = null) {
  if (!release) return null;
  const legacyPreviewPassed = release.status === "preview_passed";
  return {
    id: toId(release._id),
    incidentId: toId(release.incidentId),
    verificationId: toId(release.verificationId),
    attemptNumber: Number(release.attemptNumber || 0),
    status: legacyPreviewPassed ? "preview_blocked" : release.status || "",
    policyDecision: release.policyDecision || "",
    deployProvider: release.deployProvider || "",
    previewDeployId: release.previewDeployId || "",
    previewUrl: release.previewUrl || "",
    previewCommitSha: release.previewCommitSha || "",
    previewDeployRequestedAt: release.previewDeployRequestedAt || null,
    previewDeployAcknowledgedAt: release.previewDeployAcknowledgedAt || null,
    previewEvidenceReceivedAt: release.previewEvidenceReceivedAt || null,
    previewEvidenceQuality: release.previewEvidenceQuality || "none",
    previewDeployStage: derivePreviewDeployStage(release),
    previewPreparedAt: release.previewPreparedAt || null,
    previewVerifiedAt: release.previewVerifiedAt || null,
    previewVerificationStatus: legacyPreviewPassed
      ? "blocked"
      : release.previewVerificationStatus || "not_started",
    previewVerificationSummary: legacyPreviewPassed
      ? "Legacy preview_passed status is deprecated and is not treated as verified preview evidence."
      : release.previewVerificationSummary || "",
    previewBlockingReason:
      legacyPreviewPassed || (release.previewVerificationStatus && release.previewVerificationStatus !== "passed")
        ? release.previewVerificationSummary ||
          "Preview evidence or verification is not strong enough to continue safely."
        : "",
    previewVerificationChecks: legacyPreviewPassed
      ? [
          {
            key: "legacy_preview_status",
            status: "blocked",
            details:
              "Legacy preview_passed status is deprecated and must be re-verified before production continuation.",
            artifactId: null,
          },
        ]
      : Array.isArray(release.previewVerificationChecks)
        ? release.previewVerificationChecks
        : [],
    productionDeployId: release.productionDeployId || "",
    productionCommitSha: release.productionCommitSha || "",
    productionDeployRequestedAt: release.productionDeployRequestedAt || null,
    productionDeployAcknowledgedAt: release.productionDeployAcknowledgedAt || null,
    productionEvidenceReceivedAt: release.productionEvidenceReceivedAt || null,
    productionEvidenceQuality: release.productionEvidenceQuality || "none",
    productionDeployStage: deriveProductionDeployStage(release),
    productionVerifiedAt: release.productionVerifiedAt || null,
    productionAttestationStatus: release.productionAttestationStatus || "not_started",
    productionAttestationSummary: release.productionAttestationSummary || "",
    productionBlockingReason:
      release.productionAttestationStatus && release.productionAttestationStatus !== "passed"
        ? release.productionAttestationSummary ||
          "Production deploy evidence is not strong enough to continue automatically."
        : "",
    productionAttestationChecks: Array.isArray(release.productionAttestationChecks)
      ? release.productionAttestationChecks
      : [],
    rollbackTargetDeployId: release.rollbackTargetDeployId || "",
    rollbackTargetSource: release.rollbackTargetSource || "unknown",
    rollbackTargetValidationStatus: release.rollbackTargetValidationStatus || "not_started",
    rollbackTargetValidationSummary: release.rollbackTargetValidationSummary || "",
    rollbackTargetValidationChecks: Array.isArray(release.rollbackTargetValidationChecks)
      ? release.rollbackTargetValidationChecks
      : [],
    rollbackReason: release.rollbackReason || "",
    smokeStatus: release.smokeStatus || "",
    deployedAt: release.deployedAt || null,
    rollbackAt: release.rollbackAt || null,
    createdAt: release.createdAt || null,
    updatedAt: release.updatedAt || null,
  };
}

function serializeArtifact(artifact = null) {
  if (!artifact) return null;
  return {
    id: toId(artifact._id),
    incidentId: toId(artifact.incidentId),
    releaseId: toId(artifact.releaseId),
    artifactType: artifact.artifactType || "",
    stage: artifact.stage || "",
    label: artifact.label || "",
    contentType: artifact.contentType || "",
    body: artifact.body ?? null,
    createdAt: artifact.createdAt || null,
  };
}

function serializeApproval(approval = null) {
  if (!approval) return null;
  return {
    id: toId(approval._id),
    incidentId: toId(approval.incidentId),
    attemptNumber: Number(approval.attemptNumber || 0),
    approvalType: approval.approvalType || "",
    status: approval.status || "",
    requiredByPolicy: approval.requiredByPolicy === true,
    requestedAt: approval.requestedAt || null,
    releaseId: toId(approval.releaseId),
    packetArtifactId: toId(approval.packetArtifactId),
    decisionByUserId: toId(approval.decisionByUserId),
    decisionByEmail: approval.decisionByEmail || "",
    decisionRole: approval.decisionRole || "",
    decisionNote: approval.decisionNote || "",
    decisionScope: approval.decisionScope || null,
    decidedAt: approval.decidedAt || null,
    expiresAt: approval.expiresAt || null,
    createdAt: approval.createdAt || null,
    updatedAt: approval.updatedAt || null,
  };
}

function serializeNotification(notification = null) {
  if (!notification) return null;
  return {
    id: toId(notification._id),
    incidentId: toId(notification.incidentId),
    audience: notification.audience || "",
    channel: notification.channel || "",
    templateKey: notification.templateKey || "",
    status: notification.status || "",
    bodyPreview: notification.bodyPreview || "",
    eventId: toId(notification.eventId),
    recipientUserId: toId(notification.recipientUserId),
    recipientEmail: notification.recipientEmail || "",
    subject: notification.subject || "",
    payload: notification.payload || {},
    externalMessageId: notification.externalMessageId || "",
    sentAt: notification.sentAt || null,
    createdAt: notification.createdAt || null,
    updatedAt: notification.updatedAt || null,
  };
}

function serializeEvent(event = {}) {
  return {
    id: toId(event._id),
    incidentId: toId(event.incidentId),
    seq: Number(event.seq || 0),
    eventType: event.eventType || "",
    actor: event.actor || {},
    summary: event.summary || "",
    fromState: event.fromState || "",
    toState: event.toState || "",
    detail: event.detail || {},
    artifactIds: Array.isArray(event.artifactIds) ? event.artifactIds.map((id) => toId(id)) : [],
    createdAt: event.createdAt || null,
  };
}

function buildIncidentLine(incident = {}) {
  const prefix = incident.publicId ? `${incident.publicId}: ` : "";
  const summary = compactText(incident.summary || "Untitled incident", 96);
  const suffix = incident.classification?.clusterKey
    ? ` Cluster ${incident.classification.clusterKey}.`
    : "";
  return `${prefix}${summary}.${suffix}`.replace(/\.\./g, ".");
}

function compareIncidentPriority(a = {}, b = {}) {
  const riskDelta =
    (RISK_WEIGHT[b.classification?.riskLevel] || 0) - (RISK_WEIGHT[a.classification?.riskLevel] || 0);
  if (riskDelta) return riskDelta;
  const updatedDelta = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
  if (updatedDelta) return updatedDelta;
  return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
}

async function findIncidentByIdentifier(identifier) {
  const match = resolveIncidentIdMatch(identifier);
  if (!match) return null;
  return Incident.findOne(match).lean();
}

async function findLatestByAttempt(Model, incidentId, attempt) {
  const query = { incidentId };
  const parsedAttempt = Number.parseInt(attempt, 10);
  if (Number.isFinite(parsedAttempt) && parsedAttempt > 0) {
    query.attemptNumber = parsedAttempt;
  }
  return Model.findOne(query).sort({ attemptNumber: -1, updatedAt: -1, createdAt: -1 }).lean();
}

async function getIncidentList(query = {}) {
  const page = normalizePage(query.page);
  const limit = normalizeLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const skip = (page - 1) * limit;
  const match = buildIncidentListMatch(query);

  const [items, total] = await Promise.all([
    Incident.find(match).sort({ updatedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Incident.countDocuments(match),
  ]);

  return {
    items: items.map(serializeIncidentSummary),
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

async function getIncidentDetail(identifier) {
  const incident = await findIncidentByIdentifier(identifier);
  if (!incident) return null;

  const incidentId = incident._id;
  const [latestInvestigation, latestPatch, latestVerification, latestRelease, latestApproval] =
    await Promise.all([
      IncidentInvestigation.findOne({ incidentId })
        .sort({ attemptNumber: -1, updatedAt: -1, createdAt: -1 })
        .lean(),
      IncidentPatch.findOne({ incidentId }).sort({ attemptNumber: -1, updatedAt: -1, createdAt: -1 }).lean(),
      IncidentVerification.findOne({ incidentId })
        .sort({ attemptNumber: -1, updatedAt: -1, createdAt: -1 })
        .lean(),
      IncidentRelease.findOne({ incidentId }).sort({ attemptNumber: -1, updatedAt: -1, createdAt: -1 }).lean(),
      IncidentApproval.findOne({ incidentId }).sort({ requestedAt: -1, createdAt: -1 }).lean(),
    ]);

  const latestNotifications = await IncidentNotification.find({ incidentId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(10)
    .lean();

  const latestReleaseArtifacts = latestRelease
    ? await IncidentArtifact.find({
        incidentId,
        releaseId: latestRelease._id,
        artifactType: {
          $in: ["preview_url", "deploy_log", "health_snapshot", "coverage_summary", "rollback_report"],
        },
      })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
    : [];

  return {
    incident: serializeIncidentDetail(incident),
    latestInvestigation: serializeInvestigation(latestInvestigation),
    latestPatch: serializePatch(latestPatch),
    latestVerification: serializeVerification(latestVerification),
    latestRelease: serializeRelease(latestRelease),
    latestReleaseArtifacts: latestReleaseArtifacts.map(serializeArtifact),
    latestApproval: serializeApproval(latestApproval),
    latestNotifications: latestNotifications.map(serializeNotification),
  };
}

async function getIncidentTimeline(identifier, query = {}) {
  const incident = await findIncidentByIdentifier(identifier);
  if (!incident) return null;

  const limit = normalizeLimit(query.limit, DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT);
  const events = await IncidentEvent.find({ incidentId: incident._id })
    .sort({ seq: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  return {
    incident: serializeIncidentSummary(incident),
    events: events.reverse().map(serializeEvent),
    pagination: { limit, count: events.length },
  };
}

async function getIncidentVerificationRecord(identifier, query = {}) {
  const incident = await findIncidentByIdentifier(identifier);
  if (!incident) return null;

  const verification = await findLatestByAttempt(IncidentVerification, incident._id, query.attempt);
  return {
    incident: serializeIncidentSummary(incident),
    verification: serializeVerification(verification),
  };
}

async function getIncidentReleaseRecord(identifier, query = {}) {
  const incident = await findIncidentByIdentifier(identifier);
  if (!incident) return null;

  const release = await findLatestByAttempt(IncidentRelease, incident._id, query.attempt);
  return {
    incident: serializeIncidentSummary(incident),
    release: serializeRelease(release),
  };
}

async function getIncidentClusters(query = {}) {
  const limit = normalizeLimit(query.limit, DEFAULT_CLUSTER_LIMIT, MAX_CLUSTER_LIMIT);
  const windowHours = normalizeWindowHours(query.windowHours);
  const match = {
    "classification.clusterKey": { $nin: ["", null] },
  };

  const state = String(query.state || "").trim();
  const riskLevel = String(query.riskLevel || "").trim();

  if (isValidEnumValue(state, INCIDENT_STATES)) {
    match.state = state;
  }
  if (isValidEnumValue(riskLevel, INCIDENT_RISK_LEVELS)) {
    match["classification.riskLevel"] = riskLevel;
  }

  if (windowHours > 0) {
    const threshold = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    match.createdAt = { $gte: threshold };
  }

  const rows = await Incident.aggregate([
    { $match: match },
    { $sort: { updatedAt: -1, createdAt: -1 } },
    {
      $group: {
        _id: "$classification.clusterKey",
        count: { $sum: 1 },
        newestAt: { $max: "$updatedAt" },
        latestRiskLevel: { $first: "$classification.riskLevel" },
        topSummary: { $first: "$summary" },
        incidentIds: { $push: "$_id" },
        publicIds: { $push: "$publicId" },
        states: { $push: "$state" },
      },
    },
    { $sort: { count: -1, newestAt: -1, _id: 1 } },
    { $limit: limit },
  ]);

  const clusters = rows.map((row) => {
    const stateBreakdown = (row.states || []).reduce((acc, stateValue) => {
      const key = String(stateValue || "unknown");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    return {
      clusterKey: row._id,
      count: Number(row.count || 0),
      newestAt: row.newestAt || null,
      riskLevel: row.latestRiskLevel || "low",
      topSummary: row.topSummary || "",
      incidentIds: Array.isArray(row.incidentIds) ? row.incidentIds.slice(0, 5).map((id) => toId(id)) : [],
      publicIds: Array.isArray(row.publicIds) ? row.publicIds.slice(0, 5) : [],
      stateBreakdown,
    };
  });

  return { clusters, filters: { limit, windowHours, state, riskLevel } };
}

async function getIncidentControlRoomView() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    openCount,
    highRiskCount,
    awaitingApprovalCount,
    verificationFailedCount,
    resolvedTodayCount,
    clusterRows,
    openIncidents,
  ] = await Promise.all([
    Incident.countDocuments({ state: { $in: OPEN_INCIDENT_STATES } }),
    Incident.countDocuments({
      state: { $in: OPEN_INCIDENT_STATES },
      "classification.riskLevel": "high",
    }),
    Incident.countDocuments({
      $or: [{ state: "awaiting_founder_approval" }, { approvalState: "pending" }],
    }),
    Incident.countDocuments({ state: "verification_failed" }),
    Incident.countDocuments({ state: "resolved", updatedAt: { $gte: startOfDay } }),
    Incident.aggregate([
      {
        $match: {
          state: { $in: OPEN_INCIDENT_STATES },
          "classification.clusterKey": { $nin: ["", null] },
        },
      },
      { $group: { _id: "$classification.clusterKey" } },
      { $count: "total" },
    ]),
    Incident.find({ state: { $in: OPEN_INCIDENT_STATES } })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(25)
      .lean(),
  ]);

  const clusterCount = Number(clusterRows?.[0]?.total || 0);
  const { clusters } = await getIncidentClusters({ windowHours: 168, limit: 5 });
  const prioritizedIncidents = [...openIncidents].sort(compareIncidentPriority).slice(0, 8);

  let recommendation = "No incidents are currently visible.";
  if (highRiskCount) {
    recommendation = "Review high-risk incidents first and inspect any approval-gated release candidates.";
  } else if (awaitingApprovalCount) {
    recommendation = "Review incidents currently paused for founder approval before lower-risk queue work.";
  } else if (verificationFailedCount) {
    recommendation = "Review verification-failed incidents next because the fix path is already narrowed.";
  } else if (openCount) {
    recommendation = "Review the newest active incidents and repeated clusters before routine queue cleanup.";
  }

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      openCount,
      highRiskCount,
      awaitingApprovalCount,
      verificationFailedCount,
      resolvedTodayCount,
      clusterCount,
      recommendation,
    },
    view: {
      title: "Incident Control Room",
      status: highRiskCount || awaitingApprovalCount ? "Priority" : openCount ? "Active" : "Healthy",
      tone: highRiskCount || awaitingApprovalCount ? "priority" : openCount ? "active" : "healthy",
      queueLabel: `${pluralize(openCount, "open incident")}`,
      primary: {
        title: "Recommended Focus",
        body: recommendation,
      },
      secondary: {
        title: "Visible Facts",
        items: [
          `${pluralize(openCount, "incident")} ${
            openCount === 1 ? "is" : "are"
          } currently active in the new Incident system.`,
          `${pluralize(highRiskCount, "incident")} ${
            highRiskCount === 1 ? "is" : "are"
          } currently classified high-risk.`,
          `${pluralize(awaitingApprovalCount, "incident")} ${
            awaitingApprovalCount === 1 ? "is" : "are"
          } currently paused on approval or approval-ready state.`,
        ],
      },
      tertiary: {
        title: "Open Incident Queue",
        items: prioritizedIncidents.length
          ? prioritizedIncidents.map((incident) => buildIncidentLine(incident))
          : ["No incidents are currently visible."],
      },
      quaternary: {
        title: "Repeated Clusters",
        items: clusters.length
          ? clusters.map(
              (cluster) =>
                `${cluster.clusterKey}: ${pluralize(cluster.count, "incident")} · ${compactText(
                  cluster.topSummary,
                  88
                )}`
            )
          : ["No repeated issue clusters are currently visible."],
      },
    },
    incidents: prioritizedIncidents.map(serializeIncidentSummary),
    clusters,
  };
}

module.exports = {
  getIncidentList,
  getIncidentDetail,
  getIncidentTimeline,
  getIncidentVerificationRecord,
  getIncidentReleaseRecord,
  getIncidentClusters,
  getIncidentControlRoomView,
  serializeIncidentSummary,
  serializeIncidentDetail,
};
