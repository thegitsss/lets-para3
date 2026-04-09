const Incident = require("../../models/Incident");
const SupportTicket = require("../../models/SupportTicket");
const { INCIDENT_TERMINAL_STATES } = require("../../utils/incidentConstants");
const { maybeLogAutonomousIncidentRouting } = require("../ai/ccoAutonomyService");
const { buildClusterKey, buildIssueFingerprint, detectDomain, deriveRiskFlags } = require("../incidents/workflowService");
const { createIncidentFromSupportSignal } = require("../incidents/intakeService");
const { notifyFounderSupportEngineeringIssue } = require("../incidents/notificationService");
const { resolveLifecycleFollowUps } = require("../lifecycle/followUpService");
const { createSupportTicket, linkTicketToIncident } = require("../support/ticketService");
const { runEngineeringDiagnosis, buildEngineeringExecution } = require("../engineering/workspaceService");
const { buildExecutionPacket } = require("../ai/ctoExecutionService");
const { countKeywordHits } = require("../support/shared");

const SUPPORT_INTENT_KEYWORDS = Object.freeze([
  "support",
  "help",
  "issue",
  "problem",
  "question",
  "not working",
  "bug",
  "error",
  "login",
  "password",
  "verification",
  "access",
  "case",
  "matter",
  "application",
  "hire",
  "payment",
  "payout",
  "refund",
  "dispute",
  "fee",
]);

const NON_SUPPORT_PUBLIC_CONTACT_HINTS = Object.freeze([
  "demo",
  "partnership",
  "partner",
  "press",
  "media",
  "vendor",
  "investor",
  "career",
  "job opening",
  "sponsorship",
]);

const BLOCKER_KEYWORDS = Object.freeze([
  "bug",
  "broken",
  "not working",
  "doesn't work",
  "does not work",
  "cannot",
  "can't",
  "unable",
  "blocked",
  "stuck",
  "error",
  "failed",
  "failing",
  "forbidden",
  "unauthorized",
  "blank",
]);

const AUTH_FAILURE_KEYWORDS = Object.freeze([
  "locked out",
  "cannot login",
  "can't login",
  "unable to login",
  "login failed",
  "password reset failed",
  "verification failed",
  "unauthorized",
  "forbidden",
  "access denied",
]);

const MONEY_FAILURE_KEYWORDS = Object.freeze([
  "payment failed",
  "payout failed",
  "refund failed",
  "withdrawal failed",
  "unable to pay",
  "unable to withdraw",
  "can't withdraw",
  "charge error",
  "checkout error",
  "billing error",
  "stripe error",
]);

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function buildSupportSubmissionText(payload = {}) {
  return normalizeText([payload.subject, payload.message, payload.routePath, payload.pageUrl, payload.featureKey].filter(Boolean).join(" "));
}

function looksLikeSupportSubmission(payload = {}) {
  const text = buildSupportSubmissionText(payload);
  if (!text) return false;

  const supportHits = countKeywordHits(text, SUPPORT_INTENT_KEYWORDS);
  const nonSupportHits = countKeywordHits(text, NON_SUPPORT_PUBLIC_CONTACT_HINTS);
  if (supportHits === 0) return false;
  if (supportHits <= nonSupportHits) return false;
  return true;
}

function buildTicketPayloadFromEvent(event = {}) {
  const after = event.facts?.after || {};
  return {
    requesterRole: after.role || event.actor?.role || "visitor",
    requesterUserId: event.related?.userId || null,
    requesterEmail: after.email || event.actor?.email || "",
    requesterName: after.name || event.actor?.label || "",
    sourceSurface: event.source?.surface || "manual",
    sourceLabel: after.sourceLabel || "Support submission",
    routePath: after.routePath || event.source?.route || "",
    pageUrl: after.pageUrl || "",
    featureKey: after.featureKey || "",
    caseId: event.related?.caseId || null,
    jobId: event.related?.jobId || null,
    applicationId: event.related?.applicationId || null,
    conversationId: event.related?.conversationId || null,
    subject: after.subject || "Support request",
    message: after.message || event.facts?.summary || "",
  };
}

function buildIncidentCandidate(ticket = {}, submission = {}) {
  return {
    summary: ticket.subject || submission.subject || submission.message || "Support-linked incident",
    originalReportText: ticket.message || submission.message || "",
    context: {
      surface: ticket.sourceSurface || submission.sourceSurface || "public",
      routePath: ticket.routePath || submission.routePath || "",
      pageUrl: submission.pageUrl || "",
      featureKey: submission.featureKey || "",
      caseId: ticket.caseId || submission.caseId || null,
      jobId: ticket.jobId || submission.jobId || null,
      applicationId: ticket.applicationId || submission.applicationId || null,
    },
    reporter: {
      userId: ticket.requesterUserId || submission.requesterUserId || null,
      role: ticket.requesterRole || submission.requesterRole || "visitor",
      email: ticket.requesterEmail || submission.requesterEmail || "",
    },
  };
}

function shouldEscalateTicketToIncident(ticket = {}, submission = {}) {
  const riskFlags = new Set((ticket.riskFlags || []).map((value) => String(value || "").trim()));
  const text = buildSupportSubmissionText({
    subject: ticket.subject,
    message: ticket.message,
    routePath: ticket.routePath,
    pageUrl: submission.pageUrl,
    featureKey: submission.featureKey,
  });
  const blockerHits = countKeywordHits(text, BLOCKER_KEYWORDS);
  const authFailureHits = countKeywordHits(text, AUTH_FAILURE_KEYWORDS);
  const moneyFailureHits = countKeywordHits(text, MONEY_FAILURE_KEYWORDS);
  const category = String(ticket.classification?.category || "");

  if (category === "incident_watch") {
    return { shouldEscalate: true, reason: "Explicit bug or incident language was detected." };
  }

  if (riskFlags.has("account_access") && (authFailureHits > 0 || blockerHits > 0)) {
    return { shouldEscalate: true, reason: "Auth failure language was detected." };
  }

  if (riskFlags.has("money_sensitive") && (moneyFailureHits > 0 || blockerHits > 0)) {
    return { shouldEscalate: true, reason: "Money failure language was detected." };
  }

  if (riskFlags.has("case_progress") && blockerHits > 0) {
    return { shouldEscalate: true, reason: "Active case-progress work appears blocked." };
  }

  if (["case_workflow", "job_application"].includes(category) && blockerHits >= 2) {
    return { shouldEscalate: true, reason: "Workflow language plus blocker wording suggests a product defect." };
  }

  return { shouldEscalate: false, reason: "The visible submission is safer to keep in Support Ops." };
}

async function findMatchingActiveIncident({ ticket = {}, submission = {} } = {}) {
  const candidate = buildIncidentCandidate(ticket, submission);
  const clusterKey = buildClusterKey(candidate);
  const issueFingerprint = buildIssueFingerprint(candidate);
  const relatedClauses = [];

  if (ticket.caseId) relatedClauses.push({ "context.caseId": ticket.caseId });
  if (ticket.jobId) relatedClauses.push({ "context.jobId": ticket.jobId });
  if (ticket.applicationId) relatedClauses.push({ "context.applicationId": ticket.applicationId });
  if (ticket.routePath) {
    relatedClauses.push({ "context.routePath": ticket.routePath });
    relatedClauses.push({ "context.routePath": ticket.routePath, "classification.clusterKey": clusterKey });
  }
  if (ticket.requesterUserId && clusterKey) {
    relatedClauses.push({
      "reporter.userId": ticket.requesterUserId,
      "classification.clusterKey": clusterKey,
    });
  }
  if (clusterKey) relatedClauses.push({ "classification.clusterKey": clusterKey });
  if (issueFingerprint) relatedClauses.push({ "classification.issueFingerprint": issueFingerprint });

  if (!relatedClauses.length) {
    return { incident: null, clusterKey, issueFingerprint, domain: detectDomain(candidate), riskFlags: deriveRiskFlags(candidate) };
  }

  const incident = await Incident.findOne({
    state: { $nin: INCIDENT_TERMINAL_STATES },
    $or: relatedClauses,
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  return {
    incident,
    clusterKey,
    issueFingerprint,
    domain: detectDomain(candidate),
    riskFlags: deriveRiskFlags(candidate),
  };
}

async function startEngineeringDiagnosisForIncident(incident = {}) {
  const incidentIdentifier = String(incident?.publicId || incident?._id || "").trim();
  if (!incidentIdentifier) {
    return { ok: false, started: false, reused: false, runId: "", reason: "Incident identifier unavailable." };
  }

  const buildFallbackExecutionKickoff = async (reason = "") => {
    const fallback = await buildExecutionPacket({
      saveRun: true,
      issueId: String(incident?._id || "").trim(),
      category: String(incident?.classification?.domain || "incident_watch").trim().toLowerCase(),
      urgency: String(incident?.classification?.severity || "high").trim().toLowerCase(),
      technicalSeverity: String(incident?.classification?.severity || "high").trim().toLowerCase(),
      diagnosisSummary: String(incident?.summary || incident?.originalReportText || "Support-linked engineering issue").trim(),
      likelyAffectedAreas: [incident?.context?.routePath || incident?.context?.pageUrl || incident?.context?.featureKey || ""].filter(Boolean),
      filesToInspect: Array.isArray(incident?.classification?.suspectedFiles) ? incident.classification.suspectedFiles : [],
      recommendedFixStrategy:
        "Reproduce the user-reported issue from the linked support context, confirm the failing path in code, and implement the narrowest safe fix before targeted regression checks.",
      testPlan: [
        "Reproduce the reported issue using the linked support route and context.",
        "Run targeted regression checks on the affected LPC flow after the fix.",
      ],
      executionStatus: "in_progress",
      metadata: {
        incidentId: String(incident?._id || "").trim(),
        incidentPublicId: String(incident?.publicId || "").trim(),
        page: incident?.context?.pageUrl || "",
        routePath: incident?.context?.routePath || "",
        surface: incident?.context?.surface || "",
        featureKey: incident?.context?.featureKey || "",
        triggerSource: "support_auto_execution_fallback",
        fallbackReason: reason,
      },
    });
    return {
      reused: false,
      execution: fallback,
    };
  };

  try {
    const result = await runEngineeringDiagnosis({
      incidentIdentifier,
      triggerSource: "support_auto_diagnosis",
      autoDiagnosis: true,
      triggerLabel: "Support escalation auto-start",
    });
    let execution = null;
    if (result?.diagnosis?.runId) {
      try {
        execution = await buildEngineeringExecution({
          incidentIdentifier,
        });
      } catch (executionError) {
        execution = await buildFallbackExecutionKickoff(executionError?.message || "Engineering execution kickoff failed.");
      }
    } else {
      execution = await buildFallbackExecutionKickoff("Diagnosis run was unavailable.");
    }
    return {
      ok: true,
      started: result?.reused !== true,
      reused: result?.reused === true,
      runId: String(result?.diagnosis?.runId || ""),
      executionStarted: execution?.reused === true || execution?.execution?.ok === true,
      executionReused: execution?.reused === true,
      executionRunId: String(execution?.execution?.executionRunId || ""),
      executionStatus: String(execution?.execution?.executionStatus || ""),
      executionError: execution?.execution?.ok === false ? String(execution?.execution?.error || "") : "",
      incidentId: String(result?.item?.id || incident?._id || ""),
      incidentPublicId: String(result?.item?.publicId || incident?.publicId || ""),
    };
  } catch (error) {
    console.error("Unable to start engineering diagnosis for support incident", error);
    const execution = await buildFallbackExecutionKickoff(error?.message || "Engineering diagnosis kickoff failed.");
    return {
      ok: execution?.execution?.ok === true,
      started: false,
      reused: false,
      runId: "",
      executionStarted: execution?.execution?.ok === true,
      executionReused: false,
      executionRunId: String(execution?.execution?.executionRunId || ""),
      executionStatus: String(execution?.execution?.executionStatus || ""),
      executionError: execution?.execution?.ok === false ? String(execution?.execution?.error || "") : "",
      reason: error?.message || "Engineering diagnosis kickoff failed.",
      incidentId: String(incident?._id || ""),
      incidentPublicId: String(incident?.publicId || ""),
    };
  }
}

async function routeSupportSubmissionEvent(event = {}) {
  const submission = buildTicketPayloadFromEvent(event);
  const ticket = await createSupportTicket(submission, {
    actorType: event.actor?.actorType || "system",
    userId: event.actor?.userId || null,
    label: event.actor?.label || "LPC Router",
  });
  const ticketId = String(ticket?._id || ticket?.id || "").trim();

  const actionKeys = ticketId ? [ticketId] : [];
  const routingDecision = shouldEscalateTicketToIncident(ticket, submission);
  const ticketBeforeRouting = ticketId ? await SupportTicket.findById(ticketId).lean() : null;

  if (submission.requesterEmail) {
    await resolveLifecycleFollowUps({
      dedupeKeys: [`lifecycle:public-contact:${String(submission.requesterEmail).trim().toLowerCase()}`],
      resolutionReason: "Support submission routed into Support Ops.",
      resolvedBy: {
        actorType: "system",
        label: "LPC Router",
      },
    });
  }

  if (!routingDecision.shouldEscalate) {
    return { status: "routed", actionKeys, ticket };
  }

  const linked = await findMatchingActiveIncident({ ticket, submission });
  if (linked.incident?._id) {
    const refreshedTicket = await linkTicketToIncident({
      ticketId,
      incidentId: linked.incident._id,
    });
    const ticketAfterRouting = ticketId ? await SupportTicket.findById(ticketId).lean() : null;
    await maybeLogAutonomousIncidentRouting({
      ticketBefore: ticketBeforeRouting,
      ticketAfter: ticketAfterRouting,
      submission,
      routingDecision,
      incident: linked.incident,
    });
    actionKeys.push(String(linked.incident._id));
    const diagnosisKickoff = await startEngineeringDiagnosisForIncident(linked.incident);
    await notifyFounderSupportEngineeringIssue({
      incident: linked.incident,
      ticket: refreshedTicket,
      diagnosisKickoff,
      linkedToExisting: true,
    });
    return {
      status: "routed",
      actionKeys,
      ticket: refreshedTicket,
      incident: linked.incident,
      diagnosisKickoff,
    };
  }

  const incident = await createIncidentFromSupportSignal({
    submission: {
      ...submission,
      summary: submission.subject || submission.message,
      description: submission.message,
    },
  });
  const refreshedTicket = await linkTicketToIncident({
    ticketId,
    incidentId: incident._id,
  });
  const ticketAfterRouting = ticketId ? await SupportTicket.findById(ticketId).lean() : null;
  await maybeLogAutonomousIncidentRouting({
    ticketBefore: ticketBeforeRouting,
    ticketAfter: ticketAfterRouting,
    submission,
    routingDecision,
    incident,
  });
  actionKeys.push(String(incident._id));
  const diagnosisKickoff = await startEngineeringDiagnosisForIncident(incident);
  await notifyFounderSupportEngineeringIssue({
    incident,
    ticket: refreshedTicket,
    diagnosisKickoff,
    linkedToExisting: false,
  });

  return {
    status: "routed",
    actionKeys,
    ticket: refreshedTicket,
    incident,
    diagnosisKickoff,
  };
}

module.exports = {
  buildTicketPayloadFromEvent,
  findMatchingActiveIncident,
  looksLikeSupportSubmission,
  routeSupportSubmissionEvent,
  startEngineeringDiagnosisForIncident,
  shouldEscalateTicketToIncident,
};
