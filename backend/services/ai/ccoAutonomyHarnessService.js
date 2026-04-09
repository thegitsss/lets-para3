const mongoose = require("mongoose");

const AutonomousAction = require("../../models/AutonomousAction");
const Incident = require("../../models/Incident");
const SupportConversation = require("../../models/SupportConversation");
const SupportMessage = require("../../models/SupportMessage");
const SupportTicket = require("../../models/SupportTicket");
const User = require("../../models/User");
const { createConversationMessage } = require("../support/conversationService");
const { assertCcoAutonomyHarnessEnabled } = require("../../utils/ccoAutonomyHarnessAccess");

const SAFE_MESSAGE_PATTERN = /\b(payment|payout|billing|refund|chargeback|dispute|legal|lawsuit|arbitration)\b/i;
const DEFAULT_PASSWORD = "HarnessPassword123!";

const SCENARIOS = Object.freeze({
  reopen: {
    key: "reopen",
    label: "Resolved ticket reopen",
    expectedActionType: "ticket_reopened",
    userRole: "paralegal",
    sourceSurface: "paralegal",
    sourcePage: "/dashboard-paralegal.html",
    pageContext: {
      pathname: "/dashboard-paralegal.html",
      viewName: "dashboard-paralegal",
    },
    defaultMessage: "it's still broken",
    subject: "Harness reopen issue",
    issueLabel: "dashboard issue",
    issueSummary: "A previously resolved dashboard issue is still happening.",
    seedTicket: {
      status: "resolved",
      classificationCategory: "general_support",
      message: "Resolved dashboard issue from a prior support turn.",
      resolutionSummary: "Marked resolved after the prior support turn.",
      resolutionIsStable: true,
    },
    assistantReplyOverride: {
      reply: "I’m reopening this issue now.",
      category: "general_support",
      categoryLabel: "general_support",
      confidence: "high",
      urgency: "medium",
      needsEscalation: false,
      escalationReason: "",
      primaryAsk: "issue_reopen",
      responseMode: "DIRECT_ANSWER",
      currentIssueLabel: "dashboard issue",
      currentIssueSummary: "A previously resolved dashboard issue is still happening.",
      turnKind: "issue_reopened",
      grounded: true,
    },
  },
  escalation: {
    key: "escalation",
    label: "Conversation escalation",
    expectedActionType: "ticket_escalated",
    userRole: "attorney",
    sourceSurface: "attorney",
    sourcePage: "/dashboard-attorney.html",
    pageContext: {
      pathname: "/dashboard-attorney.html",
      viewName: "dashboard-attorney",
    },
    defaultMessage: "I need a human",
    subject: "Harness escalation issue",
    issueLabel: "support issue",
    issueSummary: "The user requested human review on an active support issue.",
    seedTicket: {
      status: "open",
      classificationCategory: "general_support",
      message: "Existing support issue already being tracked.",
      resolutionSummary: "",
      resolutionIsStable: false,
    },
    assistantReplyOverride: {
      reply: "I’m sending this to the team for review.",
      category: "general_support",
      categoryLabel: "general_support",
      confidence: "high",
      urgency: "medium",
      needsEscalation: true,
      escalationReason: "support_review_recommended",
      primaryAsk: "request_human_help",
      responseMode: "ESCALATE",
      currentIssueLabel: "support issue",
      currentIssueSummary: "The user requested human review on an active support issue.",
      grounded: true,
    },
  },
  incident_routing: {
    key: "incident_routing",
    label: "Support-to-incident routing",
    expectedActionType: "incident_routed_from_support",
    userRole: "attorney",
    sourceSurface: "attorney",
    sourcePage: "/create-case.html",
    pageContext: {
      pathname: "/create-case.html",
      viewName: "create-case",
      featureKey: "create-case-submit",
    },
    defaultMessage: "the dashboard freezes when I click submit",
    subject: "Harness submit freeze",
    issueLabel: "submit freeze",
    issueSummary: "A submit flow freeze strongly suggests an engineering issue.",
    seedTicket: {
      status: "open",
      classificationCategory: "incident_watch",
      message: "Create-case submit flow freezes and blocks progress.",
      resolutionSummary: "",
      resolutionIsStable: false,
    },
    assistantReplyOverride: {
      reply: "I’m sending this to the team for review.",
      category: "incident_watch",
      categoryLabel: "incident_watch",
      confidence: "high",
      urgency: "high",
      needsEscalation: true,
      escalationReason: "engineering_review_recommended",
      primaryAsk: "request_human_help",
      responseMode: "ESCALATE",
      currentIssueLabel: "submit freeze",
      currentIssueSummary: "A submit flow freeze strongly suggests an engineering issue.",
      grounded: true,
    },
  },
});

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    if (value._id) return String(value._id).trim();
    if (value.id) return String(value.id).trim();
  }
  return String(value).trim();
}

function resolveScenario(input = "") {
  const normalized = String(input || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("scenario is required.");
  }

  const direct = SCENARIOS[normalized];
  if (direct) return direct;

  if (normalized === "ticket_reopened") return SCENARIOS.reopen;
  if (normalized === "ticket_escalated") return SCENARIOS.escalation;
  if (normalized === "incident-routed" || normalized === "incident_routed_from_support") {
    return SCENARIOS.incident_routing;
  }

  throw new Error(`Unsupported harness scenario: ${input}.`);
}

function assertSafeHarnessMessage(message = "") {
  if (SAFE_MESSAGE_PATTERN.test(String(message || ""))) {
    const error = new Error("Harness messages must stay out of payment, billing, payout, dispute, and legal contexts.");
    error.statusCode = 400;
    throw error;
  }
}

function buildHarnessMetadata({ scenario, adminUser, user, ticketId = null } = {}) {
  return {
    support: {
      harnessScenarioKey: scenario.key,
      harnessScenarioLabel: scenario.label,
      harnessExpectedActionType: scenario.expectedActionType,
      harnessSeededAt: new Date(),
      harnessSeededByAdminId: normalizeId(adminUser?._id || adminUser?.id),
      harnessSeededByAdminEmail: adminUser?.email || "",
      harnessRecommendedMessage: scenario.defaultMessage,
      harnessSyntheticUserId: normalizeId(user?._id || user?.id),
      currentIssueLabel: scenario.issueLabel,
      currentIssueSummary: scenario.issueSummary,
      proactiveIssueLabel: scenario.issueLabel,
      ...(ticketId
        ? {
            proactiveTicketId: ticketId,
          }
        : {}),
    },
  };
}

async function createHarnessUser({ scenario } = {}) {
  const suffix = `${scenario.key}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  return User.create({
    firstName: "CCO",
    lastName: `Harness ${scenario.label}`,
    email: `cco-autonomy+${suffix}@lets-paraconnect.local`,
    password: DEFAULT_PASSWORD,
    role: scenario.userRole,
    status: "approved",
    approvedAt: new Date(),
    emailVerified: true,
    state: "CA",
    location: "CA",
  });
}

async function seedScenario({ scenario: scenarioInput, adminUser = {} } = {}) {
  assertCcoAutonomyHarnessEnabled();
  const scenario = resolveScenario(scenarioInput);
  const user = await createHarnessUser({ scenario });
  const now = new Date();

  const conversation = await SupportConversation.create({
    userId: user._id,
    role: scenario.userRole,
    status: "open",
    sourceSurface: scenario.sourceSurface,
    sourcePage: scenario.sourcePage,
    pageContext: scenario.pageContext,
    lastCategory: scenario.assistantReplyOverride.category || "general_support",
    lastMessageAt: now,
    welcomeSentAt: now,
    metadata: buildHarnessMetadata({ scenario, adminUser, user }),
  });

  await SupportMessage.create([
    {
      conversationId: conversation._id,
      sender: "assistant",
      text: `Harness seed ready for ${scenario.label}.`,
      sourcePage: scenario.sourcePage,
      pageContext: scenario.pageContext,
      metadata: {
        kind: "assistant_reply",
        source: "cco_autonomy_harness_seed",
        category: scenario.assistantReplyOverride.category || "general_support",
        categoryLabel: scenario.assistantReplyOverride.categoryLabel || scenario.assistantReplyOverride.category || "general_support",
      },
    },
  ]);

  const ticket = await SupportTicket.create({
    subject: scenario.subject,
    message: scenario.seedTicket.message,
    status: scenario.seedTicket.status,
    urgency: scenario.assistantReplyOverride.urgency || "medium",
    requesterRole: scenario.userRole,
    sourceSurface: scenario.sourceSurface,
    sourceLabel: "CCO Autonomy Harness",
    userId: user._id,
    requesterUserId: user._id,
    requesterEmail: user.email,
    conversationId: conversation._id,
    routePath: scenario.sourcePage,
    pageContext: scenario.pageContext,
    latestUserMessage: scenario.seedTicket.message,
    assistantSummary: scenario.issueSummary,
    supportFactsSnapshot: {
      harnessScenario: scenario.key,
    },
    escalationReason: "",
    classification: {
      category: scenario.seedTicket.classificationCategory,
      confidence: "high",
      patternKey: `cco-harness:${scenario.key}`,
      matchedKnowledgeKeys: [],
    },
    routingSuggestion: {
      ownerKey: "support_ops",
      priority: scenario.key === "incident_routing" ? "high" : "normal",
      queueLabel: "Harness seed",
      reason: "Seeded for CCO autonomy harness testing.",
    },
    riskFlags: [],
    resolutionSummary: scenario.seedTicket.resolutionSummary,
    resolutionIsStable: scenario.seedTicket.resolutionIsStable,
    resolvedAt: scenario.seedTicket.status === "resolved" ? now : null,
  });

  conversation.metadata = {
    ...(conversation.metadata || {}),
    ...buildHarnessMetadata({ scenario, adminUser, user, ticketId: ticket._id }),
    support: {
      ...(conversation.metadata?.support || {}),
      harnessScenarioKey: scenario.key,
      harnessScenarioLabel: scenario.label,
      harnessExpectedActionType: scenario.expectedActionType,
      harnessRecommendedMessage: scenario.defaultMessage,
      harnessSyntheticUserId: normalizeId(user._id),
      proactiveIssueLabel: scenario.issueLabel,
      proactiveIssueState: ticket.status === "resolved" ? "resolved" : "open",
      proactiveTicketId: ticket._id,
      proactiveTicketStatus: ticket.status,
      currentIssueLabel: scenario.issueLabel,
      currentIssueSummary: scenario.issueSummary,
      welcomePrompt: "",
      proactivePrompt: null,
    },
  };
  await conversation.save();

  return {
    scenarioKey: scenario.key,
    expectedActionType: scenario.expectedActionType,
    syntheticUserId: normalizeId(user._id),
    conversationId: normalizeId(conversation._id),
    ticketId: normalizeId(ticket._id),
    recommendedMessage: scenario.defaultMessage,
    sourcePage: scenario.sourcePage,
    pageContext: scenario.pageContext,
  };
}

async function inspectScenario({ conversationId = "", ticketId = "" } = {}) {
  assertCcoAutonomyHarnessEnabled();

  let resolvedConversationId = normalizeId(conversationId);
  let resolvedTicketId = normalizeId(ticketId);

  if (!resolvedConversationId && resolvedTicketId && mongoose.isValidObjectId(resolvedTicketId)) {
    const ticket = await SupportTicket.findById(resolvedTicketId).select("conversationId").lean();
    resolvedConversationId = normalizeId(ticket?.conversationId);
  }

  if (!resolvedTicketId && resolvedConversationId && mongoose.isValidObjectId(resolvedConversationId)) {
    const latestTicket = await SupportTicket.findOne({ conversationId: resolvedConversationId })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select("_id")
      .lean();
    resolvedTicketId = normalizeId(latestTicket?._id);
  }

  if (!resolvedConversationId && !resolvedTicketId) {
    const error = new Error("conversationId or ticketId is required.");
    error.statusCode = 400;
    throw error;
  }

  const conversation = resolvedConversationId && mongoose.isValidObjectId(resolvedConversationId)
    ? await SupportConversation.findById(resolvedConversationId).lean()
    : null;

  const messages = resolvedConversationId && mongoose.isValidObjectId(resolvedConversationId)
    ? await SupportMessage.find({ conversationId: resolvedConversationId })
        .sort({ createdAt: 1, _id: 1 })
        .lean()
    : [];

  const ticketQuery = resolvedConversationId && mongoose.isValidObjectId(resolvedConversationId)
    ? { conversationId: resolvedConversationId }
    : { _id: resolvedTicketId };
  const tickets = await SupportTicket.find(ticketQuery)
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  const incidentIds = [...new Set(
    tickets
      .flatMap((ticket) => (Array.isArray(ticket.linkedIncidentIds) ? ticket.linkedIncidentIds : []))
      .map((value) => normalizeId(value))
      .filter(Boolean)
  )];
  const incidents = incidentIds.length
    ? await Incident.find({ _id: { $in: incidentIds } }).sort({ updatedAt: -1, createdAt: -1 }).lean()
    : [];

  const ticketIds = tickets.map((ticket) => ticket._id).filter(Boolean);
  const actions = ticketIds.length
    ? await AutonomousAction.find({
        targetModel: "SupportTicket",
        targetId: { $in: ticketIds },
      })
        .sort({ createdAt: -1, _id: -1 })
        .lean()
    : [];

  return {
    conversation: conversation
      ? {
          id: normalizeId(conversation._id),
          userId: normalizeId(conversation.userId),
          role: conversation.role,
          status: conversation.status,
          sourceSurface: conversation.sourceSurface,
          sourcePage: conversation.sourcePage,
          pageContext: conversation.pageContext || {},
          escalation: conversation.escalation || {},
          metadata: conversation.metadata || {},
          createdAt: conversation.createdAt || null,
          updatedAt: conversation.updatedAt || null,
        }
      : null,
    messages: messages.map((message) => ({
      id: normalizeId(message._id),
      conversationId: normalizeId(message.conversationId),
      sender: message.sender,
      text: message.text,
      metadata: message.metadata || {},
      createdAt: message.createdAt || null,
    })),
    tickets: tickets.map((ticket) => ({
      id: normalizeId(ticket._id),
      conversationId: normalizeId(ticket.conversationId),
      status: ticket.status,
      urgency: ticket.urgency,
      subject: ticket.subject,
      latestUserMessage: ticket.latestUserMessage,
      escalationReason: ticket.escalationReason,
      routingSuggestion: ticket.routingSuggestion || {},
      classification: ticket.classification || {},
      linkedIncidentIds: (ticket.linkedIncidentIds || []).map((value) => normalizeId(value)),
      resolutionSummary: ticket.resolutionSummary || "",
      resolutionIsStable: ticket.resolutionIsStable === true,
      resolvedAt: ticket.resolvedAt || null,
      updatedAt: ticket.updatedAt || null,
    })),
    incidents: incidents.map((incident) => ({
      id: normalizeId(incident._id),
      publicId: incident.publicId || "",
      state: incident.state || "",
      summary: incident.summary || "",
      userVisibleStatus: incident.userVisibleStatus || "",
      adminVisibleStatus: incident.adminVisibleStatus || "",
      classification: incident.classification || {},
      context: incident.context || {},
      resolution: incident.resolution || {},
      updatedAt: incident.updatedAt || null,
    })),
    autonomousActions: actions.map((action) => ({
      id: normalizeId(action._id),
      agentRole: action.agentRole,
      actionType: action.actionType,
      confidenceScore: action.confidenceScore,
      confidenceReason: action.confidenceReason,
      targetModel: action.targetModel,
      targetId: normalizeId(action.targetId),
      changedFields: action.changedFields || {},
      previousValues: action.previousValues || {},
      actionTaken: action.actionTaken,
      status: action.status,
      createdAt: action.createdAt || null,
      undoneAt: action.undoneAt || null,
    })),
  };
}

async function triggerScenario({
  conversationId = "",
  scenario: scenarioInput = "",
  message = "",
} = {}) {
  assertCcoAutonomyHarnessEnabled();
  const resolvedConversationId = normalizeId(conversationId);
  if (!resolvedConversationId || !mongoose.isValidObjectId(resolvedConversationId)) {
    const error = new Error("conversationId is required.");
    error.statusCode = 400;
    throw error;
  }

  const conversation = await SupportConversation.findById(resolvedConversationId);
  if (!conversation) {
    const error = new Error("Support conversation not found.");
    error.statusCode = 404;
    throw error;
  }

  const scenario = scenarioInput
    ? resolveScenario(scenarioInput)
    : resolveScenario(conversation.metadata?.support?.harnessScenarioKey || "");
  const user = await User.findById(conversation.userId).select("_id role email status");
  if (!user) {
    const error = new Error("Harness synthetic user not found.");
    error.statusCode = 404;
    throw error;
  }

  const finalMessage = String(message || scenario.defaultMessage).trim();
  if (!finalMessage) {
    const error = new Error("Harness trigger message is required.");
    error.statusCode = 400;
    throw error;
  }
  assertSafeHarnessMessage(finalMessage);

  const latestTicket = await SupportTicket.findOne({ conversationId: conversation._id })
    .sort({ updatedAt: -1, createdAt: -1 })
    .select("_id status")
    .lean();

  const promptAction =
    scenario.key === "reopen" && latestTicket?._id
      ? {
          ticketId: normalizeId(latestTicket._id),
          issueLabel: scenario.issueLabel,
          issueState: latestTicket.status,
          ticketStatus: latestTicket.status,
        }
      : null;

  const payload = await createConversationMessage({
    conversationId: conversation._id,
    user,
    text: finalMessage,
    sourcePage: conversation.sourcePage || scenario.sourcePage,
    pageContext: Object.keys(conversation.pageContext || {}).length ? conversation.pageContext : scenario.pageContext,
    promptAction,
    assistantReplyOverride: {
      ...scenario.assistantReplyOverride,
      reply: scenario.assistantReplyOverride.reply,
      currentIssueLabel: scenario.issueLabel,
      currentIssueSummary: scenario.issueSummary,
    },
  });

  return {
    scenarioKey: scenario.key,
    expectedActionType: scenario.expectedActionType,
    message: finalMessage,
    payload,
    inspection: await inspectScenario({ conversationId: conversation._id }),
  };
}

module.exports = {
  inspectScenario,
  isSafeHarnessMessage: (message = "") => !SAFE_MESSAGE_PATTERN.test(String(message || "")),
  resolveScenario,
  seedScenario,
  triggerScenario,
};
