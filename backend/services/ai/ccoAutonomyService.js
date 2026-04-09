const mongoose = require("mongoose");

const { logAction } = require("./autonomousActionService");
const { scoreConfidence } = require("./confidenceScorer");
const { createLogger } = require("../../utils/logger");

const logger = createLogger("ai:cco-autonomy");

const FINANCIAL_PATTERN = /\b(payment|payments|payout|payouts|billing|refund|refunds|charge|charges|fee|fees|escrow|stripe|withdraw|withdrawal)\b/i;
const BILLING_PROMISE_PATTERN = /\b(refund|credit|waive|waiver|reimburse|comp(?:ed|ensation)?|fee back|billing promise)\b/i;
const DISPUTE_PATTERN = /\b(dispute|disputed|chargeback|legal|lawsuit|arbitration)\b/i;
const REOPEN_PATTERN = /\b(still happening|still broken|still not working|same issue|came back|back again|not fixed|happening again)\b/i;
const HUMAN_HELP_PATTERN = /\b(human help|talk to someone|talk to a person|speak to someone|contact support|send to the team|team review)\b/i;
const BUG_SIGNAL_PATTERN = /\b(bug|broken|not working|does(?:n't| not) work|blocked|stuck|error|failed|blank|unauthorized|forbidden)\b/i;

const REOPEN_FIELD_PATHS = [
  "status",
  "resolvedAt",
  "resolutionSummary",
  "resolutionIsStable",
  "latestUserMessage",
  "assistantSummary",
  "supportFactsSnapshot",
  "pageContext",
  "routePath",
  "escalationReason",
  "urgency",
];

const ESCALATION_FIELD_PATHS = [
  "status",
  "latestUserMessage",
  "assistantSummary",
  "supportFactsSnapshot",
  "pageContext",
  "routePath",
  "escalationReason",
  "urgency",
  "routingSuggestion",
];

const INCIDENT_ROUTING_FIELD_PATHS = [
  "linkedIncidentIds",
  "latestResponsePacket.linkedIncidents",
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    if (value._id) return String(value._id).trim();
    if (value.id) return String(value.id).trim();
  }
  return String(value).trim();
}

function readPath(source = {}, path = "") {
  if (!path) return undefined;
  return String(path)
    .split(".")
    .reduce((value, part) => {
      if (value === null || typeof value === "undefined") return undefined;
      return value[part];
    }, source);
}

function hasPath(source = {}, path = "") {
  if (!path) return false;
  const parts = String(path).split(".");
  let current = source;
  for (const part of parts) {
    if (current === null || typeof current === "undefined") return false;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = current[part];
  }
  return true;
}

function setPath(target = {}, path = "", value) {
  const parts = String(path).split(".");
  let current = target;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!isPlainObject(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[0]] = value;
  return target;
}

function cloneValue(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof mongoose.Types.ObjectId) return new mongoose.Types.ObjectId(String(value));
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (isPlainObject(value)) {
    return Object.entries(value).reduce((accumulator, [key, nestedValue]) => {
      accumulator[key] = cloneValue(nestedValue);
      return accumulator;
    }, {});
  }
  return value;
}

function comparableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (Array.isArray(value)) return value.map((item) => comparableValue(item));
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = comparableValue(value[key]);
        return accumulator;
      }, {});
  }
  return value;
}

function valuesEqual(left, right) {
  return JSON.stringify(comparableValue(left)) === JSON.stringify(comparableValue(right));
}

function buildFieldDiff(before = {}, after = {}, paths = []) {
  const changedFields = {};
  const previousValues = {};

  paths.forEach((path) => {
    const beforeHasPath = hasPath(before || {}, path);
    const afterHasPath = hasPath(after || {}, path);
    if (!beforeHasPath && !afterHasPath) return;

    const beforeValue = beforeHasPath ? readPath(before, path) : undefined;
    const afterValue = afterHasPath ? readPath(after, path) : undefined;
    if (beforeHasPath && afterHasPath && valuesEqual(beforeValue, afterValue)) return;
    if (!beforeHasPath && !afterHasPath) return;

    if (afterHasPath) {
      setPath(changedFields, path, cloneValue(afterValue));
    }
    if (beforeHasPath) {
      setPath(previousValues, path, cloneValue(beforeValue));
    }
  });

  return {
    changedFields,
    previousValues,
    hasChanges: Object.keys(changedFields).length > 0,
  };
}

function buildSafetyContext({ ticket = {}, submission = {}, userMessageText = "", assistantReply = null } = {}) {
  const text = [
    ticket?.subject,
    ticket?.message,
    ticket?.latestUserMessage,
    submission?.subject,
    submission?.message,
    userMessageText,
    assistantReply?.payload?.paymentSubIntent,
    assistantReply?.payload?.currentIssueSummary,
  ]
    .filter(Boolean)
    .join(" ");
  const normalizedText = normalizeText(text);
  const riskFlags = new Set((ticket?.riskFlags || []).map((value) => String(value || "").trim().toLowerCase()));
  const category = String(ticket?.classification?.category || "").trim().toLowerCase();

  const involvesPayment =
    category === "payments_risk" || riskFlags.has("money_sensitive") || FINANCIAL_PATTERN.test(normalizedText);
  const involvesPayout = /\b(payout|payouts|withdraw|withdrawal|bank account|stripe connect)\b/i.test(normalizedText);
  const involvesBillingPromise = BILLING_PROMISE_PATTERN.test(normalizedText);
  const legalOrDisputeContext = DISPUTE_PATTERN.test(normalizedText);

  return {
    involvesPayment,
    involvesPayout,
    involvesBillingPromise,
    legalOrDisputeContext,
  };
}

function noDisqualifiers(context = {}) {
  return Object.values(context || {}).every((value) => value !== true);
}

function buildConfidenceReason({ actionLabel = "", positives = [] } = {}) {
  const summary = positives.length
    ? positives.join("; ")
    : "No strong support-safe factors were present.";
  return `CCO autonomous ${actionLabel} was safe because ${summary}. No payment, payout, billing-promise, or dispute context was detected.`;
}

function isThresholdOrDisqualifierError(error = null) {
  const message = String(error?.message || "");
  return /below the minimum threshold/i.test(message) || /cannot involve payments, payouts, billing promises, or disputes/i.test(message);
}

async function attemptAutonomousLog({
  actionType = "",
  ticketAfter = null,
  changedFields = {},
  previousValues = {},
  confidenceScore = 0,
  confidenceReason = "",
  actionTaken = "",
  safetyContext = {},
} = {}) {
  if (!ticketAfter?._id) {
    return { logged: false, reason: "missing_target" };
  }
  if (!Object.keys(changedFields || {}).length) {
    return { logged: false, reason: "no_field_changes" };
  }
  if (!noDisqualifiers(safetyContext)) {
    return { logged: false, reason: "disqualified" };
  }

  try {
    await logAction({
      agentRole: "CCO",
      actionType,
      confidenceScore,
      confidenceReason,
      targetModel: "SupportTicket",
      targetId: ticketAfter._id,
      changedFields,
      previousValues,
      actionTaken,
      safetyContext,
    });
    return { logged: true };
  } catch (error) {
    if (isThresholdOrDisqualifierError(error)) {
      return { logged: false, reason: "threshold_or_disqualifier" };
    }

    logger.error(`Failed to log autonomous CCO action: ${actionType}`, {
      actionType,
      ticketId: normalizeId(ticketAfter._id),
      error: error?.message || String(error),
    });
    return { logged: false, reason: "log_failed", error };
  }
}

async function maybeLogAutonomousTicketReopen({
  ticketBefore = null,
  ticketAfter = null,
  userMessageText = "",
  assistantReply = null,
  promptAction = null,
  conversation = null,
} = {}) {
  if (!ticketAfter?._id) return { logged: false, reason: "missing_ticket" };

  const diff = buildFieldDiff(ticketBefore || {}, ticketAfter || {}, REOPEN_FIELD_PATHS);
  if (!diff.hasChanges) return { logged: false, reason: "no_reopen_diff" };

  const safetyContext = buildSafetyContext({
    ticket: ticketAfter,
    userMessageText,
    assistantReply,
  });
  const clearReopenSignal =
    String(assistantReply?.payload?.primaryAsk || "").trim().toLowerCase() === "issue_reopen" ||
    REOPEN_PATTERN.test(userMessageText);
  const ticketWasResolved = ["resolved", "closed"].includes(String(ticketBefore?.status || "").trim().toLowerCase());
  const issueContextAvailable = Boolean(
    promptAction?.ticketId ||
      conversation?.metadata?.support?.proactiveTicketId ||
      conversation?.escalation?.ticketId
  );
  const reopenApplied = ["open", "in_review"].includes(String(ticketAfter?.status || "").trim().toLowerCase());

  const positives = [];
  if (clearReopenSignal) positives.push("the user clearly reported the issue was still happening");
  if (ticketWasResolved) positives.push("the target ticket was already in a resolved state");
  if (issueContextAvailable) positives.push("the same support issue was already identified in conversation metadata");
  if (reopenApplied) positives.push(`the ticket moved back into ${ticketAfter.status}`);

  const confidenceScore = scoreConfidence([
    { value: clearReopenSignal, weight: 0.45 },
    { value: ticketWasResolved, weight: 0.25 },
    { value: issueContextAvailable, weight: 0.2 },
    { value: reopenApplied, weight: 0.1 },
  ]);

  return attemptAutonomousLog({
    actionType: "ticket_reopened",
    ticketAfter,
    changedFields: diff.changedFields,
    previousValues: diff.previousValues,
    confidenceScore,
    confidenceReason: buildConfidenceReason({
      actionLabel: "ticket reopen",
      positives,
    }),
    actionTaken: "Reopened the support ticket after the user reported the issue was still happening.",
    safetyContext,
  });
}

async function maybeLogAutonomousTicketEscalation({
  ticketBefore = null,
  ticketAfter = null,
  userMessageText = "",
  assistantReply = null,
  conversation = null,
  existingTicket = null,
} = {}) {
  if (!ticketAfter?._id) return { logged: false, reason: "missing_ticket" };

  const diff = buildFieldDiff(ticketBefore || {}, ticketAfter || {}, ESCALATION_FIELD_PATHS);
  if (!diff.hasChanges) return { logged: false, reason: "no_escalation_diff" };

  const safetyContext = buildSafetyContext({
    ticket: ticketAfter,
    userMessageText,
    assistantReply,
  });
  const explicitHumanHelpRequest =
    String(assistantReply?.payload?.primaryAsk || "").trim().toLowerCase() === "request_human_help" ||
    HUMAN_HELP_PATTERN.test(userMessageText);
  const supportLogicRequestedEscalation = assistantReply?.payload?.needsEscalation === true;
  const existingIssueContext = Boolean(
    existingTicket?._id ||
      conversation?.metadata?.support?.proactiveTicketId ||
      conversation?.metadata?.support?.escalationSent === true ||
      conversation?.escalation?.requested === true ||
      conversation?.escalation?.ticketId
  );
  const routedForHumanReview =
    String(ticketAfter?.routingSuggestion?.ownerKey || "").trim().toLowerCase() === "founder_review" &&
    String(ticketAfter?.routingSuggestion?.priority || "").trim().toLowerCase() === "high";

  const positives = [];
  if (explicitHumanHelpRequest) positives.push("the user explicitly asked for human help");
  if (supportLogicRequestedEscalation) positives.push("the current support logic already marked the turn for escalation");
  if (existingIssueContext) positives.push("the conversation already had active issue context");
  if (routedForHumanReview) positives.push("the ticket was routed into the existing high-priority human review lane");

  const confidenceScore = scoreConfidence([
    { value: explicitHumanHelpRequest, weight: 0.4 },
    { value: supportLogicRequestedEscalation, weight: 0.2 },
    { value: existingIssueContext, weight: 0.25 },
    { value: routedForHumanReview, weight: 0.15 },
  ]);

  return attemptAutonomousLog({
    actionType: "ticket_escalated",
    ticketAfter,
    changedFields: diff.changedFields,
    previousValues: diff.previousValues,
    confidenceScore,
    confidenceReason: buildConfidenceReason({
      actionLabel: "ticket escalation",
      positives,
    }),
    actionTaken: "Escalated the support ticket into human review after a clear request for team help.",
    safetyContext,
  });
}

async function maybeLogAutonomousIncidentRouting({
  ticketBefore = null,
  ticketAfter = null,
  submission = {},
  routingDecision = {},
  incident = null,
} = {}) {
  if (!ticketAfter?._id) return { logged: false, reason: "missing_ticket" };

  const diff = buildFieldDiff(ticketBefore || {}, ticketAfter || {}, INCIDENT_ROUTING_FIELD_PATHS);
  if (!diff.hasChanges) return { logged: false, reason: "no_routing_diff" };

  const safetyContext = buildSafetyContext({
    ticket: ticketAfter,
    submission,
  });
  const routingTriggered = routingDecision?.shouldEscalate === true;
  const safeEngineeringCategory = ["incident_watch", "account_access", "case_workflow", "job_application"].includes(
    String(ticketAfter?.classification?.category || "").trim().toLowerCase()
  );
  const strongBugSignal =
    BUG_SIGNAL_PATTERN.test([submission?.subject, submission?.message, routingDecision?.reason].filter(Boolean).join(" ")) ||
    Boolean(routingDecision?.reason);
  const incidentLinked =
    (ticketBefore?.linkedIncidentIds || []).length < (ticketAfter?.linkedIncidentIds || []).length;
  const incidentAvailable = Boolean(incident?._id);

  const positives = [];
  if (routingTriggered) positives.push("the existing support routing logic identified a likely engineering issue");
  if (safeEngineeringCategory) positives.push(`the ticket category stayed in a non-financial engineering-safe lane (${ticketAfter.classification?.category})`);
  if (strongBugSignal) positives.push(`routing was backed by concrete blocker signals (${routingDecision?.reason || "bug indicators"})`);
  if (incidentLinked) positives.push("the ticket was actually linked to an incident");
  if (incidentAvailable) positives.push("an incident record was available for engineering follow-up");

  const confidenceScore = scoreConfidence([
    { value: routingTriggered, weight: 0.35 },
    { value: safeEngineeringCategory, weight: 0.25 },
    { value: strongBugSignal, weight: 0.2 },
    { value: incidentLinked, weight: 0.1 },
    { value: incidentAvailable, weight: 0.1 },
  ]);

  return attemptAutonomousLog({
    actionType: "incident_routed_from_support",
    ticketAfter,
    changedFields: diff.changedFields,
    previousValues: diff.previousValues,
    confidenceScore,
    confidenceReason: buildConfidenceReason({
      actionLabel: "incident routing",
      positives,
    }),
    actionTaken: "Routed the support ticket into the engineering incident workflow based on existing bug signals.",
    safetyContext,
  });
}

module.exports = {
  maybeLogAutonomousIncidentRouting,
  maybeLogAutonomousTicketEscalation,
  maybeLogAutonomousTicketReopen,
};
