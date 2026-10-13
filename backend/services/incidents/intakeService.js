const { reportOperationalFailure } = require("../../utils/operationalFailure");
const crypto = require("crypto");
const mongoose = require("mongoose");

const Incident = require("../../models/Incident");
const IncidentEvent = require("../../models/IncidentEvent");
const IncidentArtifact = require("../../models/IncidentArtifact");
const IncidentNotification = require("../../models/IncidentNotification");
const Notification = require("../../models/Notification");
const { LpcEvent } = require("../../models/LpcEvent");
const { publishEventSafe } = require("../lpcEvents/publishEventService");
const { canReadIncident, generateReporterAccessToken, hashReporterAccessToken } = require("../../utils/incidentAccess");
const { syncIncidentNotifications, stageHelpReportReceived } = require("./notificationService");
const { encryptString, decryptString, isEncryptionEnabled, isEncrypted } = require("../../utils/dataEncryption");
const { publishNotificationEvent } = require("../../utils/notificationEvents");
const runtimeLogger = require("../../utils/logger").createLogger("services:incidents:intakeService");

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

async function publishIncidentCreatedEvent(incident = {}, { session = null } = {}) {
  if (!incident?._id) return;

  const payload = {
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
  };
  if (session) {
    const [event] = await LpcEvent.create([{ ...payload, occurredAt: incident.createdAt || new Date() }], { session });
    return event;
  }
  return publishEventSafe(payload);
}

function intakeError(statusCode, publicCode, message, cause) {
  return Object.assign(new Error(message, { cause }), { statusCode, publicCode });
}

function keyedHelpRequest(input, user, normalizedInput) {
  if (!Object.hasOwn(input, "requestId") && !Object.hasOwn(input, "reporterId")) return null;
  const requestId = typeof input.requestId === "string" ? input.requestId.trim().toLowerCase() : "";
  const reporterId = typeof input.reporterId === "string" ? input.reporterId.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId) || !/^[a-f0-9]{24}$/.test(reporterId)) {
    throw intakeError(400, "HELP_REQUEST_INVALID", "A valid report request and reporter account are required.");
  }
  if (reporterId !== String(user?.id || user?._id || "").toLowerCase()) {
    throw intakeError(403, "HELP_REPORTER_CHANGED", "Your signed-in account changed. Return to Help in the correct account before sending this report.");
  }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return {
    requestId,
    query: { "reporter.userId": new mongoose.Types.ObjectId(reporterId), "intakeRequest.requestId": requestId },
    fingerprint: sha256For(JSON.stringify(canonical(JSON.parse(JSON.stringify(normalizedInput))))),
  };
}

async function readyKeyedHelpIntake() {
  if (!isEncryptionEnabled()) throw intakeError(503, "HELP_INTAKE_UNAVAILABLE", "Report recovery is unavailable. Keep this report and try again shortly.");
  let timer;
  try {
    await Promise.race([
      Promise.all([Incident, IncidentArtifact, IncidentEvent, IncidentNotification, Notification, LpcEvent].map(Model => Model.init())),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Help intake initialization incomplete")), 8000); }),
    ]);
    const indexes = await Incident.collection.indexes();
    if (!indexes.some(index => index.unique === true
      && JSON.stringify(index.key) === JSON.stringify({ "reporter.userId": 1, "intakeRequest.requestId": 1 })
      && JSON.stringify(index.partialFilterExpression) === JSON.stringify({ "intakeRequest.requestId": { $type: "string" } }))) {
      throw new Error("Help request uniqueness index is unavailable");
    }
  } catch (error) {
    throw intakeError(503, "HELP_INTAKE_UNAVAILABLE", "Report recovery is unavailable. Keep this report and try again shortly.", error);
  } finally { clearTimeout(timer); }
}

async function finishKeyedHelpIntake(incident) {
  // The event is durable before routing. A replay can finish a process that
  // stopped after commit; the current incident.created route has no actions.
  try {
    const event = await LpcEvent.findOne({ idempotencyKey: `incident:${incident._id}:created` });
    if (event && ["pending", "failed"].includes(event.routing.status)) {
      await require("../lpcEvents/routerService").routeEvent(event);
    }
  } catch (error) {
    runtimeLogger.warn("[incidents] Committed Help event routing remains pending", error?.message || error);
  }
  publishNotificationEvent(incident.reporter.userId, "notifications", { at: new Date().toISOString() });
}

async function replayKeyedHelpIntake(keyed) {
  const incident = await Incident.findOne(keyed.query).select("+intakeRequest").readConcern("majority").lean();
  if (!incident) return null;
  if (incident.intakeRequest.fingerprint !== keyed.fingerprint) {
    throw intakeError(409, "HELP_REQUEST_CHANGED", "This report request was already used for different content. Keep the original report when retrying.");
  }
  let token;
  try {
    const encrypted = incident.intakeRequest.encryptedAccessToken;
    if (!isEncrypted(encrypted)) throw new Error("Help replay credential is not encrypted");
    token = decryptString(encrypted);
    if (!/^[a-f0-9]{48}$/.test(token) || hashReporterAccessToken(token) !== incident.reporter.accessTokenHash) throw new Error("Help replay credential could not be verified");
  } catch (error) {
    throw intakeError(503, "HELP_INTAKE_UNAVAILABLE", "Your report is saved, but its receipt could not be recovered. Keep this request and try again shortly.", error);
  }
  await finishKeyedHelpIntake(incident);
  return { incident: serializeReporterIncident(incident), reporterAccessToken: token, idempotent: true };
}

async function createIncidentFromHelpReport({ user, input }) {
  const normalized = normalizeIntakePayload(input);
  if (Object.keys(normalized.errors).length) {
    const error = new Error("Validation failed");
    error.statusCode = 400;
    error.fields = normalized.errors;
    throw error;
  }

  const keyed = keyedHelpRequest(input, user, normalized.value);
  if (keyed) {
    await readyKeyedHelpIntake();
    const replay = await replayKeyedHelpIntake(keyed);
    if (replay) return replay;
  }

  const reporterRole = String(user?.role || "").toLowerCase();
  const reporterEmail = String(user?.email || "").trim().toLowerCase();
  const publicId = await generateIncidentPublicId();
  const { token, hash, issuedAt } = generateReporterAccessToken();
  const incidentInput = normalized.value;

  let incident = null;
  let artifacts = [];
  let session = null;
  let commitAttempted = false;

  try {
    if (keyed) {
      session = await mongoose.startSession();
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    }
    const incidentDocument = {
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
      ...(keyed ? { intakeRequest: { requestId: keyed.requestId, fingerprint: keyed.fingerprint, encryptedAccessToken: encryptString(token) } } : {}),
    };
    incident = session ? (await Incident.create([incidentDocument], { session }))[0] : await Incident.create(incidentDocument);

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

    artifacts = await IncidentArtifact.insertMany(artifactDocs, { ordered: true, ...(session ? { session } : {}) });

    const eventDocument = {
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
    };
    if (session) await IncidentEvent.create([eventDocument], { session });
    else await IncidentEvent.create(eventDocument);

    incident.lastEventSeq = 1;
    if (session) {
      await stageHelpReportReceived({ incident, session });
      await incident.save({ session });
      await publishIncidentCreatedEvent(incident, { session });
      commitAttempted = true;
      await session.commitTransaction();
    } else {
      await incident.save();
      await syncIncidentNotifications({ incident });
    }

    const freshIncident = await Incident.findById(incident._id).lean();
    if (keyed) await finishKeyedHelpIntake(freshIncident);
    else await publishIncidentCreatedEvent(freshIncident);
    return {
      incident: serializeReporterIncident(freshIncident),
      reporterAccessToken: token,
    };
  } catch (error) {
    if (keyed) {
      if (session?.inTransaction()) await session.abortTransaction().catch(reportOperationalFailure("services.incidents.intakeService.transaction_abort"));
      // A commit may have succeeded even when its acknowledgement was lost.
      // Never compensate by deleting a keyed incident. Retry the same request.
      if (!commitAttempted && [11000, 112, 24].includes(error.code)) {
        const replay = await replayKeyedHelpIntake(keyed);
        if (replay) return replay;
        throw intakeError(409, "HELP_REQUEST_PROCESSING", "This report is still being saved. Try again with the same report shortly.", error);
      }
      if (error.publicCode) throw error;
      throw intakeError(503, "HELP_INTAKE_UNCONFIRMED", "We could not confirm your report. Keep it and try sending the same report again.", error);
    }
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
  } finally {
    if (session) await session.endSession();
  }
}

async function createIncidentFromSupportSignal({ submission = {}, session = null } = {}) {
  if (session && !session.inTransaction()) throw new Error("Support incident staging requires an active transaction.");
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
    const incidentDocument = {
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
    };
    incident = session ? (await Incident.create([incidentDocument], { session }))[0] : await Incident.create(incidentDocument);

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

    artifacts = await IncidentArtifact.insertMany(artifactDocs, { ordered: true, ...(session ? { session } : {}) });

    const eventDocument = {
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
    };
    if (session) await IncidentEvent.create([eventDocument], { session });
    else await IncidentEvent.create(eventDocument);

    incident.lastEventSeq = 1;
    await incident.save({ ...(session ? { session } : {}) });
    if (session) {
      // Support-linked received copy lives in its conversation acknowledgment.
      // Operator/provider work follows the durable routing event after commit.
      const event = await publishIncidentCreatedEvent(incident.toObject(), { session });
      event.routing.status = "skipped";
      event.routing.lastRoutedAt = new Date();
      await event.save({ session });
      return incident.toObject();
    }
    await syncIncidentNotifications({ incident });

    const freshIncident = await Incident.findById(incident._id).lean();
    await publishIncidentCreatedEvent(freshIncident);
    return freshIncident;
  } catch (error) {
    if (session) throw error;
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

async function getReporterIncidentTimeline({ publicId, user = null, accessToken = "", limit = 50, paged, cursor }) {
  const incident = await findIncidentByPublicId(publicId);
  if (!incident || !canReadIncident(incident, { user, accessToken })) return null;

  const pagedMode = paged !== undefined || cursor !== undefined;
  const invalidQuery = message => {
    const error = new Error(message);
    error.statusCode = 400;
    error.publicCode = "INVALID_INCIDENT_TIMELINE_QUERY";
    throw error;
  };
  let after = null;
  if (pagedMode) {
    if (paged !== undefined && paged !== "1") invalidQuery("Invalid timeline paging mode.");
    if (cursor !== undefined) {
      if (typeof cursor !== "string" || !/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) invalidQuery("Invalid timeline cursor.");
      after = Number(cursor);
    }
    if (!/^[1-9]\d*$/.test(String(limit)) || !["string", "number"].includes(typeof limit)
      || !Number.isSafeInteger(Number(limit)) || Number(limit) > REPORTER_TIMELINE_LIMIT) invalidQuery("Invalid timeline page limit.");
  }
  const normalizedLimit = pagedMode ? Number(limit) : Math.min(
    REPORTER_TIMELINE_LIMIT,
    Math.max(1, Number.parseInt(limit, 10) || 50)
  );

  const events = await IncidentEvent.find({
    incidentId: incident._id,
    eventType: "state_changed",
    ...(after !== null ? { seq: { $gt: after } } : {}),
  })
    // Sequence is unique within an incident; the existing index supplies the
    // paged order without depending on timestamps or an extant boundary row.
    .sort(pagedMode ? { seq: 1 } : { seq: 1, createdAt: 1 })
    .limit(normalizedLimit + (pagedMode ? 1 : 0))
    .lean();

  const hasMore = pagedMode && events.length > normalizedLimit;
  const pageEvents = hasMore ? events.slice(0, normalizedLimit) : events;
  return {
    incident: serializeReporterIncident(incident),
    events: pageEvents.map(serializeReporterEvent),
    ...(pagedMode ? { nextCursor: hasMore ? String(pageEvents.at(-1).seq) : null, hasMore } : {}),
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
