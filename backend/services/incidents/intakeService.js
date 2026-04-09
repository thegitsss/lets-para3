const crypto = require("crypto");
const mongoose = require("mongoose");

const Incident = require("../../models/Incident");
const IncidentEvent = require("../../models/IncidentEvent");
const IncidentArtifact = require("../../models/IncidentArtifact");
const { publishEventSafe } = require("../lpcEvents/publishEventService");
const { canReadIncident, generateReporterAccessToken } = require("../../utils/incidentAccess");
const { syncIncidentNotifications } = require("./notificationService");

const SUMMARY_MAX_LENGTH = 180;
const DESCRIPTION_MAX_LENGTH = 5000;
const FEATURE_KEY_MAX_LENGTH = 120;
const URL_MAX_LENGTH = 2000;
const ROUTE_PATH_MAX_LENGTH = 300;
const CONTEXT_STRING_MAX_LENGTH = 160;
const DIAGNOSTICS_MAX_BYTES = 50 * 1024;
const REPORTER_TIMELINE_LIMIT = 100;

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : "";
}

function normalizeLongText(value, maxLength) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  return text ? text.slice(0, maxLength) : "";
}

function safeJsonClone(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function sha256For(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function formatDatePart(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

async function generateIncidentPublicId() {
  const datePart = formatDatePart();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    const publicId = `INC-${datePart}-${suffix}`;
    const exists = await Incident.exists({ publicId });
    if (!exists) return publicId;
  }
  throw new Error("Unable to generate a unique incident reference.");
}

function validateObjectId(value, field, errors) {
  const normalized = compactText(value, 64);
  if (!normalized) return null;
  if (!mongoose.isValidObjectId(normalized)) {
    errors[field] = "Must be a valid id.";
    return null;
  }
  return new mongoose.Types.ObjectId(normalized);
}

function deriveRoutePath(pageUrl, routePath) {
  const explicitRoutePath = compactText(routePath, ROUTE_PATH_MAX_LENGTH);
  if (explicitRoutePath) return explicitRoutePath;
  const normalizedPageUrl = compactText(pageUrl, URL_MAX_LENGTH);
  if (!normalizedPageUrl) return "";
  try {
    if (/^https?:\/\//i.test(normalizedPageUrl)) {
      const parsed = new URL(normalizedPageUrl);
      return compactText(parsed.pathname || "", ROUTE_PATH_MAX_LENGTH);
    }
    return compactText(new URL(normalizedPageUrl, "https://lets-paraconnect.local").pathname, ROUTE_PATH_MAX_LENGTH);
  } catch {
    return compactText(normalizedPageUrl.split("?")[0] || "", ROUTE_PATH_MAX_LENGTH);
  }
}

function normalizeDiagnostics(rawDiagnostics, errors) {
  if (rawDiagnostics == null) return null;
  const diagnostics = safeJsonClone(rawDiagnostics);
  if (!diagnostics) {
    errors.diagnostics = "Diagnostics must be a plain object.";
    return null;
  }
  const serialized = JSON.stringify(diagnostics);
  if (Buffer.byteLength(serialized, "utf8") > DIAGNOSTICS_MAX_BYTES) {
    errors.diagnostics = "Diagnostics payload is too large.";
    return null;
  }
  return diagnostics;
}

function normalizeIntakePayload(input = {}) {
  const errors = {};
  const summary = compactText(input.summary, SUMMARY_MAX_LENGTH);
  const description = normalizeLongText(input.description, DESCRIPTION_MAX_LENGTH);
  const pageUrl = compactText(input.pageUrl, URL_MAX_LENGTH);
  const featureKey = compactText(input.featureKey, FEATURE_KEY_MAX_LENGTH);
  const routePath = deriveRoutePath(pageUrl, input.routePath);
  const diagnostics = normalizeDiagnostics(input.diagnostics, errors);
  const caseId = validateObjectId(input.caseId, "caseId", errors);
  const jobId = validateObjectId(input.jobId, "jobId", errors);
  const applicationId = validateObjectId(input.applicationId, "applicationId", errors);

  if (!summary) errors.summary = "Summary is required.";
  if (!description) errors.description = "Description is required.";

  const browser = compactText(
    diagnostics?.browserName || diagnostics?.browser || diagnostics?.client?.browser || "",
    CONTEXT_STRING_MAX_LENGTH
  );
  const device = compactText(
    diagnostics?.deviceType || diagnostics?.device || diagnostics?.client?.device || "",
    CONTEXT_STRING_MAX_LENGTH
  );

  return {
    errors,
    value: {
      summary,
      description,
      pageUrl,
      routePath,
      featureKey,
      caseId,
      jobId,
      applicationId,
      diagnostics,
      browser,
      device,
    },
  };
}

function serializeResolution(resolution = {}) {
  if (!resolution || !resolution.code) return null;
  return {
    code: resolution.code || "",
    summary: resolution.summary || "",
    resolvedAt: resolution.resolvedAt || null,
    closedAt: resolution.closedAt || null,
  };
}

function serializeReporterIncident(incident = {}) {
  return {
    publicId: incident.publicId || "",
    state: incident.state || "",
    userVisibleStatus: incident.userVisibleStatus || "",
    summary: incident.summary || "",
    createdAt: incident.createdAt || null,
    updatedAt: incident.updatedAt || null,
    resolution: serializeResolution(incident.resolution),
  };
}

function summarizeStateForReporter(state = "", fallbackSummary = "") {
  switch (String(state || "")) {
    case "reported":
      return "We received your report.";
    case "intake_validated":
    case "classified":
    case "investigating":
    case "patch_planning":
    case "patching":
      return "We’re reviewing your report.";
    case "awaiting_verification":
    case "verification_failed":
    case "verified_release_candidate":
    case "deploying_preview":
    case "deploying_production":
    case "post_deploy_verifying":
      return "We’re testing a fix.";
    case "awaiting_founder_approval":
      return "Your report is under internal review.";
    case "needs_more_context":
      return "We need a bit more information to continue.";
    case "needs_human_owner":
      return "Your report has been escalated for internal review.";
    case "resolved":
      return "The issue has been resolved.";
    case "closed_duplicate":
      return "This report was linked to an existing issue.";
    case "closed_no_repro":
      return "We could not reproduce the issue with the available context.";
    case "closed_not_actionable":
      return "This report was closed without an engineering change.";
    case "closed_rejected":
      return "This report was closed after internal review.";
    case "closed_rolled_back":
      return "A deployed change related to this report was rolled back.";
    default:
      return compactText(fallbackSummary, 160) || "Status updated.";
  }
}

function serializeReporterEvent(event = {}) {
  const toState = String(event.toState || "");
  return {
    seq: Number(event.seq || 0),
    eventType: event.eventType || "",
    summary: summarizeStateForReporter(toState, event.summary),
    toState,
    createdAt: event.createdAt || null,
  };
}

function buildUserReportArtifactBody(incidentInput, user) {
  return {
    summary: incidentInput.summary,
    description: incidentInput.description,
    reporter: {
      userId: String(user.id || user._id || ""),
      role: String(user.role || "").toLowerCase(),
      email: String(user.email || "").toLowerCase(),
    },
    context: {
      surface: String(user.role || "").toLowerCase(),
      pageUrl: incidentInput.pageUrl,
      routePath: incidentInput.routePath,
      featureKey: incidentInput.featureKey,
      caseId: incidentInput.caseId ? String(incidentInput.caseId) : "",
      jobId: incidentInput.jobId ? String(incidentInput.jobId) : "",
      applicationId: incidentInput.applicationId ? String(incidentInput.applicationId) : "",
    },
    submittedAt: new Date().toISOString(),
  };
}

function normalizeSupportReporterRole(value = "") {
  const role = String(value || "").trim().toLowerCase();
  if (["visitor", "attorney", "paralegal", "admin"].includes(role)) return role;
  return "visitor";
}

function normalizeSupportSurface(value = "") {
  const surface = String(value || "").trim().toLowerCase();
  if (["public", "attorney", "paralegal", "admin", "system"].includes(surface)) return surface;
  return "public";
}

function buildSupportSignalArtifactBody(incidentInput, submission = {}) {
  return {
    summary: incidentInput.summary,
    description: incidentInput.description,
    reporter: {
      userId: submission.requesterUserId ? String(submission.requesterUserId) : "",
      role: normalizeSupportReporterRole(submission.requesterRole),
      email: String(submission.requesterEmail || "").toLowerCase(),
    },
    context: {
      surface: normalizeSupportSurface(submission.sourceSurface || submission.requesterRole),
      pageUrl: incidentInput.pageUrl,
      routePath: incidentInput.routePath,
      featureKey: incidentInput.featureKey,
      caseId: incidentInput.caseId ? String(incidentInput.caseId) : "",
      jobId: incidentInput.jobId ? String(incidentInput.jobId) : "",
      applicationId: incidentInput.applicationId ? String(incidentInput.applicationId) : "",
    },
    submittedAt: new Date().toISOString(),
    sourceLabel: String(submission.sourceLabel || "Support submission").trim(),
    contactName: String(submission.requesterName || "").trim(),
  };
}

async function publishIncidentCreatedEvent(incident = {}) {
  if (!incident?._id) return;

  await publishEventSafe({
    eventType: "incident.created",
    eventFamily: "incident",
    idempotencyKey: `incident:${incident._id}:created`,
    correlationId: `incident:${incident._id}`,
    actor: {
      actorType: incident.reporter?.userId ? "user" : "system",
      userId: incident.reporter?.userId || null,
      role: incident.reporter?.role || "",
      email: incident.reporter?.email || "",
    },
    subject: {
      entityType: "incident",
      entityId: String(incident._id),
      publicId: incident.publicId || "",
    },
    related: {
      userId: incident.reporter?.userId || null,
      caseId: incident.context?.caseId || null,
      jobId: incident.context?.jobId || null,
      applicationId: incident.context?.applicationId || null,
      incidentId: incident._id,
    },
    source: {
      surface: incident.context?.surface || "system",
      route: incident.context?.routePath || "",
      service: "incidents",
      producer: "service",
    },
    facts: {
      summary: incident.summary || "",
      after: {
        state: incident.state || "",
        publicId: incident.publicId || "",
        domain: incident.classification?.domain || "",
        severity: incident.classification?.severity || "",
        riskLevel: incident.classification?.riskLevel || "",
        routePath: incident.context?.routePath || "",
      },
    },
    signals: {
      confidence: incident.classification?.confidence || "medium",
      priority: incident.classification?.riskLevel === "high" ? "high" : "normal",
      moneyRisk: incident.classification?.riskFlags?.affectsMoney === true,
      authRisk: incident.classification?.riskFlags?.affectsAuth === true,
    },
  });
}

async function createIncidentFromHelpReport({ user, input }) {
  const normalized = normalizeIntakePayload(input);
  if (Object.keys(normalized.errors).length) {
    const error = new Error("Validation failed");
    error.statusCode = 400;
    error.fields = normalized.errors;
    throw error;
  }

  const reporterRole = String(user?.role || "").toLowerCase();
  const reporterEmail = String(user?.email || "").trim().toLowerCase();
  const publicId = await generateIncidentPublicId();
  const { token, hash, issuedAt } = generateReporterAccessToken();
  const incidentInput = normalized.value;

  let incident = null;
  let artifacts = [];

  try {
    incident = await Incident.create({
      publicId,
      source: "help_form",
      reporter: {
        userId: user.id || user._id || null,
        role: reporterRole,
        email: reporterEmail,
        accessTokenHash: hash,
        accessTokenIssuedAt: issuedAt,
      },
      context: {
        surface: reporterRole,
        pageUrl: incidentInput.pageUrl,
        featureKey: incidentInput.featureKey,
        caseId: incidentInput.caseId,
        jobId: incidentInput.jobId,
        applicationId: incidentInput.applicationId,
        browser: incidentInput.browser,
        device: incidentInput.device,
        routePath: incidentInput.routePath,
      },
      summary: incidentInput.summary,
      originalReportText: incidentInput.description,
      state: "reported",
      classification: {
        domain: "unknown",
        severity: "low",
        riskLevel: "low",
        confidence: "low",
      },
      approvalState: "not_needed",
      autonomyMode: "full_auto",
      userVisibleStatus: "received",
      adminVisibleStatus: "new",
      orchestration: {
        nextJobType: "intake_validation",
        nextJobRunAt: new Date(),
      },
      lastEventSeq: 0,
    });

    const userReportBody = buildUserReportArtifactBody(incidentInput, user);
    const artifactDocs = [
      {
        incidentId: incident._id,
        artifactType: "user_report",
        stage: "intake",
        label: "User report",
        contentType: "json",
        storageMode: "inline",
        body: userReportBody,
        sha256: sha256For(JSON.stringify(userReportBody)),
      },
    ];

    if (incidentInput.diagnostics) {
      artifactDocs.push({
        incidentId: incident._id,
        artifactType: "browser_diagnostics",
        stage: "intake",
        label: "Submitted diagnostics",
        contentType: "json",
        storageMode: "inline",
        body: incidentInput.diagnostics,
        sha256: sha256For(JSON.stringify(incidentInput.diagnostics)),
      });
    }

    artifacts = await IncidentArtifact.insertMany(artifactDocs, { ordered: true });

    await IncidentEvent.create({
      incidentId: incident._id,
      seq: 1,
      eventType: "state_changed",
      actor: {
        type: "user",
        userId: user.id || user._id || null,
        role: reporterRole,
      },
      summary: "We received your report.",
      fromState: "",
      toState: "reported",
      artifactIds: artifacts.map((artifact) => artifact._id),
    });

    incident.lastEventSeq = 1;
    await incident.save();

    await syncIncidentNotifications({ incident });

    const freshIncident = await Incident.findById(incident._id).lean();
    await publishIncidentCreatedEvent(freshIncident);
    return {
      incident: serializeReporterIncident(freshIncident),
      reporterAccessToken: token,
    };
  } catch (error) {
    if (incident?._id) {
      await Promise.allSettled([
        IncidentEvent.deleteMany({ incidentId: incident._id }),
        IncidentArtifact.deleteMany({ incidentId: incident._id }),
        Incident.deleteOne({ _id: incident._id }),
      ]);
    } else if (artifacts.length) {
      await IncidentArtifact.deleteMany({ _id: { $in: artifacts.map((artifact) => artifact._id) } });
    }
    throw error;
  }
}

async function createIncidentFromSupportSignal({ submission = {} } = {}) {
  const normalized = normalizeIntakePayload({
    summary: submission.summary || submission.subject || submission.message,
    description: submission.description || submission.message,
    pageUrl: submission.pageUrl,
    routePath: submission.routePath,
    featureKey: submission.featureKey,
    caseId: submission.caseId,
    jobId: submission.jobId,
    applicationId: submission.applicationId,
    diagnostics: submission.diagnostics,
  });

  if (Object.keys(normalized.errors).length) {
    const error = new Error("Validation failed");
    error.statusCode = 400;
    error.fields = normalized.errors;
    throw error;
  }

  const reporterRole = normalizeSupportReporterRole(submission.requesterRole || submission.sourceSurface);
  const surface = normalizeSupportSurface(submission.sourceSurface || reporterRole);
  const reporterEmail = String(submission.requesterEmail || "").trim().toLowerCase();
  const publicId = await generateIncidentPublicId();
  const incidentInput = normalized.value;

  let incident = null;
  let artifacts = [];

  try {
    incident = await Incident.create({
      publicId,
      source: "inline_help",
      reporter: {
        userId: submission.requesterUserId || null,
        role: reporterRole,
        email: reporterEmail,
      },
      context: {
        surface,
        pageUrl: incidentInput.pageUrl,
        featureKey: incidentInput.featureKey,
        caseId: incidentInput.caseId,
        jobId: incidentInput.jobId,
        applicationId: incidentInput.applicationId,
        browser: incidentInput.browser,
        device: incidentInput.device,
        routePath: incidentInput.routePath,
      },
      summary: incidentInput.summary,
      originalReportText: incidentInput.description,
      state: "reported",
      classification: {
        domain: "unknown",
        severity: "low",
        riskLevel: "low",
        confidence: "low",
      },
      approvalState: "not_needed",
      autonomyMode: "full_auto",
      userVisibleStatus: "received",
      adminVisibleStatus: "new",
      orchestration: {
        nextJobType: "intake_validation",
        nextJobRunAt: new Date(),
      },
      lastEventSeq: 0,
    });

    const supportSignalBody = buildSupportSignalArtifactBody(incidentInput, submission);
    const artifactDocs = [
      {
        incidentId: incident._id,
        artifactType: "user_report",
        stage: "intake",
        label: "Support submission",
        contentType: "json",
        storageMode: "inline",
        body: supportSignalBody,
        sha256: sha256For(JSON.stringify(supportSignalBody)),
      },
    ];

    if (incidentInput.diagnostics) {
      artifactDocs.push({
        incidentId: incident._id,
        artifactType: "browser_diagnostics",
        stage: "intake",
        label: "Submitted diagnostics",
        contentType: "json",
        storageMode: "inline",
        body: incidentInput.diagnostics,
        sha256: sha256For(JSON.stringify(incidentInput.diagnostics)),
      });
    }

    artifacts = await IncidentArtifact.insertMany(artifactDocs, { ordered: true });

    await IncidentEvent.create({
      incidentId: incident._id,
      seq: 1,
      eventType: "state_changed",
      actor: {
        type: submission.requesterUserId ? "user" : "system",
        userId: submission.requesterUserId || null,
        role: reporterRole,
      },
      summary: "We received a support-linked incident report.",
      fromState: "",
      toState: "reported",
      artifactIds: artifacts.map((artifact) => artifact._id),
    });

    incident.lastEventSeq = 1;
    await incident.save();
    await syncIncidentNotifications({ incident });

    const freshIncident = await Incident.findById(incident._id).lean();
    await publishIncidentCreatedEvent(freshIncident);
    return freshIncident;
  } catch (error) {
    if (incident?._id) {
      await Promise.allSettled([
        IncidentEvent.deleteMany({ incidentId: incident._id }),
        IncidentArtifact.deleteMany({ incidentId: incident._id }),
        Incident.deleteOne({ _id: incident._id }),
      ]);
    } else if (artifacts.length) {
      await IncidentArtifact.deleteMany({ _id: { $in: artifacts.map((artifact) => artifact._id) } });
    }
    throw error;
  }
}

async function findIncidentByPublicId(publicId) {
  const normalizedId = compactText(publicId, 64);
  if (!normalizedId) return null;
  return Incident.findOne({ publicId: normalizedId }).lean();
}

async function getReporterIncidentStatus({ publicId, user = null, accessToken = "" }) {
  const incident = await findIncidentByPublicId(publicId);
  if (!incident || !canReadIncident(incident, { user, accessToken })) return null;
  return serializeReporterIncident(incident);
}

async function getReporterIncidentTimeline({ publicId, user = null, accessToken = "", limit = 50 }) {
  const incident = await findIncidentByPublicId(publicId);
  if (!incident || !canReadIncident(incident, { user, accessToken })) return null;

  const normalizedLimit = Math.min(
    REPORTER_TIMELINE_LIMIT,
    Math.max(1, Number.parseInt(limit, 10) || 50)
  );

  const events = await IncidentEvent.find({
    incidentId: incident._id,
    eventType: "state_changed",
  })
    .sort({ seq: 1, createdAt: 1 })
    .limit(normalizedLimit)
    .lean();

  return {
    incident: serializeReporterIncident(incident),
    events: events.map(serializeReporterEvent),
  };
}

module.exports = {
  normalizeIntakePayload,
  createIncidentFromHelpReport,
  createIncidentFromSupportSignal,
  getReporterIncidentStatus,
  getReporterIncidentTimeline,
  publishIncidentCreatedEvent,
  serializeReporterIncident,
  serializeReporterEvent,
};
