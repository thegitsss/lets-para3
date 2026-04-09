const Application = require("../../models/Application");
const Case = require("../../models/Case");
const Incident = require("../../models/Incident");
const Job = require("../../models/Job");
const SupportConversation = require("../../models/SupportConversation");
const SupportMessage = require("../../models/SupportMessage");
const SupportTicket = require("../../models/SupportTicket");
const User = require("../../models/User");
const {
  SUPPORT_CONFIDENCE,
  SUPPORT_OWNER_KEYS,
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_STATUSES,
} = require("./constants");
const { suggestRouting } = require("./routingService");
const { generateResponsePacket } = require("./responsePacketService");
const { buildPatternKey, compactText, countKeywordHits } = require("./shared");
const { publishConversationEvent } = require("./liveUpdateService");
const { publishEventSafe } = require("../lpcEvents/publishEventService");
const { INCIDENT_TERMINAL_STATES } = require("../../utils/incidentConstants");

const ACTIVE_WORK_STATUSES = ["open", "in_review", "waiting_on_user", "waiting_on_info"];
const RESOLVED_TICKET_STATUSES = ["resolved", "closed"];
const VALID_CATEGORY_SET = new Set(SUPPORT_TICKET_CATEGORIES);
const VALID_CONFIDENCE_SET = new Set(SUPPORT_CONFIDENCE);
const VALID_OWNER_SET = new Set(SUPPORT_OWNER_KEYS);
const VALID_STATUS_SET = new Set(SUPPORT_TICKET_STATUSES);
const SUPPORT_OWNED_FILTER = {
  $or: [{ linkedIncidentIds: { $exists: false } }, { linkedIncidentIds: { $size: 0 } }],
};
const BLOCKER_SIGNAL_FILTER = {
  $or: [
    { urgency: "high" },
    { "routingSuggestion.priority": "high" },
    { riskFlags: "active_incident" },
    { riskFlags: "account_access" },
    { riskFlags: "money_sensitive" },
  ],
};

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value._id) return String(value._id);
    if (value.id) return String(value.id);
  }
  return String(value);
}

function normalizeTicketStatus(value = "", fallback = "open") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "waiting_on_info") return "waiting_on_user";
  if (VALID_STATUS_SET.has(normalized)) return normalized;
  return fallback;
}

function normalizeUrgency(value = "", fallback = "medium") {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_CONFIDENCE_SET.has(normalized) ? normalized : fallback;
}

function buildUserLabel(user = {}) {
  const fullName = `${user.firstName || ""} ${user.lastName || ""}`.trim();
  return fullName || user.email || "User";
}

function formatSupportTicketReference(ticketId = "") {
  const id = String(ticketId || "").trim();
  if (!id) return "";
  return `SUP-${id.slice(-6).toUpperCase()}`;
}

async function resolveActorLabel(user = {}) {
  const directLabel = buildUserLabel(user);
  if (directLabel && directLabel !== user.email) return directLabel;

  const userId = normalizeId(user._id || user.id);
  if (!userId) return directLabel;

  const storedUser = await User.findById(userId).select("firstName lastName email").lean();
  return buildUserLabel(storedUser || user);
}

function toConversationStatus(ticketStatus = "", hasEscalation = true) {
  const normalized = normalizeTicketStatus(ticketStatus, "open");
  if (normalized === "resolved") return "resolved";
  if (normalized === "closed") return "closed";
  return hasEscalation ? "escalated" : "open";
}

function serializeSupportMessage(message = {}) {
  return {
    id: normalizeId(message._id || message.id),
    conversationId: normalizeId(message.conversationId),
    sender: message.sender || "assistant",
    text: message.text || "",
    sourcePage: message.sourcePage || "",
    pageContext: message.pageContext || {},
    metadata: message.metadata || {},
    createdAt: message.createdAt || null,
    updatedAt: message.updatedAt || null,
  };
}

function serializeRequester(user = null, fallback = {}) {
  const source = user || {};
  return {
    id: normalizeId(source._id || source.id || fallback.requesterUserId || fallback.userId),
    name: buildUserLabel(source),
    email: source.email || fallback.requesterEmail || "",
    role: source.role || fallback.requesterRole || "unknown",
    status: source.status || "",
  };
}

function serializeAssignedUser(user = null) {
  if (!user) {
    return {
      id: "",
      name: "",
      email: "",
      role: "",
      status: "",
    };
  }
  return {
    id: normalizeId(user._id || user.id),
    name: buildUserLabel(user),
    email: user.email || "",
    role: user.role || "",
    status: user.status || "",
  };
}

function serializeNote(note = {}) {
  return {
    adminId: normalizeId(note.adminId),
    adminName: note.adminName || "",
    text: note.text || "",
    createdAt: note.createdAt || null,
  };
}

function serializeLinkedIncident(incident = {}) {
  return {
    id: normalizeId(incident._id || incident.incidentId || incident.id),
    publicId: incident.publicId || "",
    state: incident.state || "",
    summary: compactText(incident.summary || "", 160),
    userVisibleStatus: incident.userVisibleStatus || "",
  };
}

function serializeTicketForList(ticket = {}) {
  const requester = serializeRequester(ticket.requesterUserId, ticket);
  const linkedIncidents = Array.isArray(ticket.linkedIncidentIds)
    ? ticket.linkedIncidentIds.map(serializeLinkedIncident).filter((incident) => incident.id || incident.publicId)
    : [];
  const linkedIncidentIds = Array.isArray(ticket.linkedIncidentIds)
    ? ticket.linkedIncidentIds.map((value) => normalizeId(value)).filter(Boolean)
    : [];
  return {
    ...ticket,
    id: normalizeId(ticket._id || ticket.id),
    reference: formatSupportTicketReference(ticket._id || ticket.id),
    status: normalizeTicketStatus(ticket.status, "open"),
    urgency: normalizeUrgency(ticket.urgency, ticket.latestResponsePacket?.confidence || "medium"),
    requester,
    issuePreview: compactText(ticket.latestUserMessage || ticket.message || "", 180),
    linkedIncidentIds,
    linkedIncidents,
    handedOffToEngineering: linkedIncidents.length > 0,
  };
}

function serializeTicketForDetail(ticket = {}, detail = {}) {
  const requester = serializeRequester(ticket.requesterUserId, ticket);
  const assignedTo = serializeAssignedUser(ticket.assignedTo);
  const linkedIncidents = Array.isArray(ticket.linkedIncidentIds)
    ? ticket.linkedIncidentIds.map(serializeLinkedIncident).filter((incident) => incident.id || incident.publicId)
    : [];
  const linkedIncidentIds = Array.isArray(ticket.linkedIncidentIds)
    ? ticket.linkedIncidentIds.map((value) => normalizeId(value)).filter(Boolean)
    : [];
  return {
    ...ticket,
    id: normalizeId(ticket._id || ticket.id),
    reference: formatSupportTicketReference(ticket._id || ticket.id),
    status: normalizeTicketStatus(ticket.status, "open"),
    urgency: normalizeUrgency(ticket.urgency, ticket.latestResponsePacket?.confidence || "medium"),
    requester,
    assignedTo,
    internalNotes: Array.isArray(ticket.internalNotes) ? ticket.internalNotes.map(serializeNote) : [],
    conversation: detail.conversation || null,
    conversationMessages: Array.isArray(detail.conversationMessages) ? detail.conversationMessages : [],
    latestSupportFactsSnapshot: ticket.supportFactsSnapshot || {},
    latestPageContext: ticket.pageContext || {},
    latestIssuePreview: compactText(ticket.latestUserMessage || ticket.message || "", 240),
    linkedIncidentIds,
    linkedIncidents,
    handedOffToEngineering: linkedIncidents.length > 0,
  };
}

function classifyTicket(payload = {}) {
  const text = `${payload.subject || ""} ${payload.message || ""} ${payload.routePath || ""}`.toLowerCase();
  const scores = new Map(SUPPORT_TICKET_CATEGORIES.map((category) => [category, 0]));

  const addScore = (category, keywords) => {
    scores.set(category, (scores.get(category) || 0) + countKeywordHits(text, keywords));
  };

  addScore("admissions", ["approval", "approved", "denied", "application review", "admission"]);
  addScore("account_access", ["login", "log in", "password", "verify", "verification", "locked out", "access"]);
  addScore("case_workflow", ["case", "matter", "hire", "hired", "document", "message", "task"]);
  addScore("job_application", ["job", "application", "apply", "applying", "applicant"]);
  addScore("payments_risk", ["payment", "payout", "refund", "dispute", "stripe", "withdrawal"]);
  addScore("fees", ["platform fee", "fee", "fees", "22%", "18%"]);
  addScore("platform_explainer", ["what is lpc", "how it works", "platform", "attorney", "paralegal"]);
  addScore("incident_watch", ["bug", "broken", "error", "incident", "outage", "not working"]);

  if (payload.caseId) scores.set("case_workflow", (scores.get("case_workflow") || 0) + 2);
  if (payload.jobId || payload.applicationId) {
    scores.set("job_application", (scores.get("job_application") || 0) + 2);
  }

  const winner = [...scores.entries()].sort((a, b) => b[1] - a[1])[0] || ["general_support", 0];
  return {
    category: winner[1] > 0 ? winner[0] : "general_support",
    confidence: winner[1] >= 3 ? "high" : winner[1] >= 1 ? "medium" : "low",
  };
}

function mapSupportConversationCategory(category = "") {
  const normalized = String(category || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "payment" || normalized === "stripe_onboarding") return "payments_risk";
  if (normalized === "messaging" || normalized === "case_posting") return "case_workflow";
  if (normalized === "login" || normalized === "password_reset") return "account_access";
  if (normalized === "dashboard_load" || normalized === "profile_save" || normalized === "profile_photo_upload") {
    return "incident_watch";
  }
  if (normalized === "account_approval") return "admissions";
  return "";
}

function sanitizeCategoryOverride(value = "") {
  const direct = String(value || "").trim();
  if (VALID_CATEGORY_SET.has(direct)) return direct;
  const mapped = mapSupportConversationCategory(direct);
  return VALID_CATEGORY_SET.has(mapped) ? mapped : "";
}

function sanitizeConfidenceOverride(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_CONFIDENCE_SET.has(normalized) ? normalized : "";
}

function applyRoutingOverride(baseRouting = {}, payload = {}) {
  const overrideOwnerKey = String(payload.routingOwner || "").trim();
  if (!overrideOwnerKey || !VALID_OWNER_SET.has(overrideOwnerKey)) {
    return baseRouting;
  }
  return {
    ownerKey: overrideOwnerKey,
    priority: payload.routingPriority || baseRouting.priority || "normal",
    queueLabel: payload.routingQueueLabel || baseRouting.queueLabel || "Founder review",
    reason: payload.routingReason || baseRouting.reason || "Routed for founder review.",
  };
}

async function loadContextSnapshot({ requesterUserId, caseId, jobId, applicationId } = {}) {
  const [user, supportCase, job, application] = await Promise.all([
    requesterUserId ? User.findById(requesterUserId).select("firstName lastName email role status").lean() : null,
    caseId ? Case.findById(caseId).select("title status attorneyId paralegalId pausedReason").lean() : null,
    jobId ? Job.findById(jobId).select("title status budget attorneyId caseId").lean() : null,
    applicationId ? Application.findById(applicationId).select("status jobId paralegalId").lean() : null,
  ]);

  if (requesterUserId && !user) throw new Error("Requester user not found.");
  if (caseId && !supportCase) throw new Error("Case not found.");
  if (jobId && !job) throw new Error("Job not found.");
  if (applicationId && !application) throw new Error("Application not found.");

  return {
    userLabel: user ? buildUserLabel(user) : "",
    userRole: user?.role || "",
    caseTitle: supportCase?.title || "",
    caseStatus: supportCase?.status || "",
    jobTitle: job?.title || "",
    jobStatus: job?.status || "",
    applicationStatus: application?.status || "",
  };
}

async function findLinkedIncidentIds(payload = {}) {
  const orClauses = [];
  if (payload.caseId) orClauses.push({ "context.caseId": payload.caseId });
  if (payload.jobId) orClauses.push({ "context.jobId": payload.jobId });
  if (payload.applicationId) orClauses.push({ "context.applicationId": payload.applicationId });
  if (payload.requesterUserId) orClauses.push({ "reporter.userId": payload.requesterUserId });
  if (payload.routePath) orClauses.push({ "context.routePath": payload.routePath });
  if (!orClauses.length) return [];
  const incidents = await Incident.find({ $or: orClauses }).select("_id").sort({ updatedAt: -1 }).limit(6).lean();
  return incidents.map((incident) => incident._id);
}

async function hydrateTicket(ticketId) {
  return SupportTicket.findById(ticketId)
    .populate("requesterUserId", "firstName lastName email role status")
    .populate("assignedTo", "firstName lastName email role status")
    .populate("linkedIncidentIds", "publicId state summary userVisibleStatus")
    .lean();
}

async function createSupportTicket(payload = {}, actor = {}) {
  if (!String(payload.subject || "").trim()) throw new Error("Support ticket subject is required.");
  if (!String(payload.message || "").trim()) throw new Error("Support ticket message is required.");

  const classification = classifyTicket(payload);
  const categoryOverride = sanitizeCategoryOverride(
    payload.ticketCategory || payload.classification?.category || payload.supportCategory
  );
  const confidenceOverride = sanitizeConfidenceOverride(
    payload.ticketConfidence || payload.classification?.confidence
  );
  const contextSnapshot = await loadContextSnapshot(payload);
  const linkedIncidentIds = await findLinkedIncidentIds(payload);
  const urgency = normalizeUrgency(payload.urgency || payload.priority || confidenceOverride || classification.confidence);
  const normalizedStatus = normalizeTicketStatus(payload.status, "open");
  const requesterUserId = payload.requesterUserId || payload.userId || null;

  const ticket = new SupportTicket({
    subject: String(payload.subject || "").trim(),
    message: String(payload.message || "").trim(),
    status: normalizedStatus,
    urgency,
    requesterRole: payload.requesterRole || contextSnapshot.userRole || "unknown",
    sourceSurface: payload.sourceSurface || "manual",
    sourceLabel: payload.sourceLabel || "Support Ops",
    userId: requesterUserId || null,
    requesterUserId: requesterUserId || null,
    requesterEmail: payload.requesterEmail || "",
    assignedTo: payload.assignedTo || null,
    conversationId: payload.conversationId || null,
    routePath: payload.routePath || "",
    caseId: payload.caseId || null,
    jobId: payload.jobId || null,
    applicationId: payload.applicationId || null,
    pageContext: payload.pageContext || {},
    contextSnapshot: {
      ...contextSnapshot,
      ...(payload.contextSnapshot && typeof payload.contextSnapshot === "object" ? payload.contextSnapshot : {}),
    },
    latestUserMessage: payload.latestUserMessage || "",
    assistantSummary: payload.assistantSummary || "",
    supportFactsSnapshot:
      payload.supportFactsSnapshot && typeof payload.supportFactsSnapshot === "object"
        ? payload.supportFactsSnapshot
        : {},
    escalationReason: payload.escalationReason || "",
    classification: {
      category: categoryOverride || classification.category,
      confidence: confidenceOverride || classification.confidence,
      patternKey: buildPatternKey({
        category: categoryOverride || classification.category,
        subject: payload.subject,
        message: payload.message,
        routePath: payload.routePath,
        role: payload.requesterRole || contextSnapshot.userRole || "unknown",
      }),
      matchedKnowledgeKeys: [],
    },
    linkedIncidentIds,
    riskFlags: [],
    routingSuggestion: {
      ownerKey: "support_ops",
      priority: urgency === "high" ? "high" : "normal",
      queueLabel: "Pending routing",
      reason: "Routing not generated yet.",
    },
  });

  const packet = await generateResponsePacket(ticket.toObject());
  const baseRouting = suggestRouting({
    category: ticket.classification.category,
    linkedIncidents: packet.linkedIncidents,
    riskFlags: packet.riskFlags,
    requesterRole: ticket.requesterRole,
  });
  const routing = applyRoutingOverride(baseRouting, payload);

  ticket.classification.matchedKnowledgeKeys = packet.matchedKnowledgeKeys || [];
  ticket.routingSuggestion = routing;
  ticket.riskFlags = packet.riskFlags || [];
  ticket.latestResponsePacket = {
    packetVersion: packet.packetVersion,
    generatedAt: packet.generatedAt,
    recommendedReply: packet.recommendedReply,
    citations: packet.citations,
    confidence: packet.confidence,
    riskFlags: packet.riskFlags,
    neededFacts: packet.neededFacts,
    escalationOwner: routing.ownerKey,
    linkedIncidents: packet.linkedIncidents,
    advisories: packet.advisories,
  };

  await ticket.save();
  const hydrated = await hydrateTicket(ticket._id);
  return serializeTicketForList(hydrated || ticket.toObject());
}

async function regenerateResponsePacket({ ticketId } = {}) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new Error("Support ticket not found.");
  const packet = await generateResponsePacket(ticket.toObject());
  const baseRouting = suggestRouting({
    category: ticket.classification?.category,
    linkedIncidents: packet.linkedIncidents,
    riskFlags: packet.riskFlags,
    requesterRole: ticket.requesterRole,
  });
  const routing = applyRoutingOverride(baseRouting, {
    routingOwner: ticket.routingSuggestion?.ownerKey,
    routingPriority: ticket.routingSuggestion?.priority,
    routingQueueLabel: ticket.routingSuggestion?.queueLabel,
    routingReason: ticket.routingSuggestion?.reason,
  });

  ticket.classification.matchedKnowledgeKeys = packet.matchedKnowledgeKeys || [];
  ticket.routingSuggestion = routing;
  ticket.riskFlags = packet.riskFlags || [];
  ticket.latestResponsePacket = {
    packetVersion: packet.packetVersion,
    generatedAt: packet.generatedAt,
    recommendedReply: packet.recommendedReply,
    citations: packet.citations,
    confidence: packet.confidence,
    riskFlags: packet.riskFlags,
    neededFacts: packet.neededFacts,
    escalationOwner: routing.ownerKey,
    linkedIncidents: packet.linkedIncidents,
    advisories: packet.advisories,
  };

  await ticket.save();
  const hydrated = await hydrateTicket(ticket._id);
  return serializeTicketForList(hydrated || ticket.toObject());
}

async function syncConversationStatus(conversationId, ticket = {}, { lastMessageAt = null } = {}) {
  const normalizedConversationId = normalizeId(conversationId);
  if (!normalizedConversationId) return null;

  const update = {
    status: toConversationStatus(ticket.status, true),
  };
  if (lastMessageAt) update.lastMessageAt = lastMessageAt;

  if (normalizedConversationId && SupportConversation.collection) {
    return SupportConversation.findByIdAndUpdate(normalizedConversationId, { $set: update }, { new: true });
  }
  return null;
}

async function updateTicketStatus({
  ticketId,
  status,
  resolutionSummary = "",
  resolutionIsStable = false,
} = {}) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new Error("Support ticket not found.");

  const previousStatus = normalizeTicketStatus(ticket.status, "open");
  ticket.status = normalizeTicketStatus(status, previousStatus);
  if (ticket.status === "resolved" || ticket.status === "closed") {
    ticket.resolvedAt = new Date();
    ticket.resolutionSummary = compactText(resolutionSummary || ticket.resolutionSummary, 3000);
    ticket.resolutionIsStable = Boolean(resolutionIsStable);
  } else {
    ticket.resolvedAt = null;
    ticket.resolutionIsStable = false;
    if (resolutionSummary) ticket.resolutionSummary = compactText(resolutionSummary, 3000);
  }
  await ticket.save();
  await syncConversationStatus(ticket.conversationId, ticket);
  publishConversationEvent(ticket.conversationId, {
    type: "conversation.updated",
    reason: "ticket.status_updated",
    ticketStatus: ticket.status,
    ticketId: normalizeId(ticket._id),
    ticketReference: formatSupportTicketReference(ticket._id),
  });

  if (
    RESOLVED_TICKET_STATUSES.includes(ticket.status) &&
    !RESOLVED_TICKET_STATUSES.includes(previousStatus) &&
    ticket.resolutionIsStable
  ) {
    await publishEventSafe({
      eventType: "support.ticket.resolved",
      eventFamily: "support",
      idempotencyKey: `support-ticket:${ticket._id}:resolved`,
      correlationId: `support-ticket:${ticket._id}`,
      actor: {
        actorType: "system",
        label: "Support Ticket Service",
      },
      subject: {
        entityType: "support_ticket",
        entityId: String(ticket._id),
      },
      related: {
        userId: ticket.requesterUserId || null,
        caseId: ticket.caseId || null,
        jobId: ticket.jobId || null,
        applicationId: ticket.applicationId || null,
        supportTicketId: ticket._id,
      },
      source: {
        surface: ticket.sourceSurface || "manual",
        route: ticket.routePath || "",
        service: "support",
        producer: "service",
      },
      facts: {
        summary: ticket.resolutionSummary || ticket.subject,
        after: {
          status: ticket.status || "",
          category: ticket.classification?.category || "",
          patternKey: ticket.classification?.patternKey || "",
          resolutionIsStable: ticket.resolutionIsStable === true,
        },
      },
      signals: {
        confidence: ticket.latestResponsePacket?.confidence || ticket.classification?.confidence || "medium",
        priority: ticket.routingSuggestion?.priority === "high" ? "high" : "normal",
        moneyRisk: (ticket.riskFlags || []).includes("money_sensitive"),
        authRisk: (ticket.riskFlags || []).includes("account_access"),
        caseProgressRisk: (ticket.riskFlags || []).includes("case_progress"),
        publicFacing: true,
      },
    });
  }

  const hydrated = await hydrateTicket(ticket._id);
  return serializeTicketForList(hydrated || ticket.toObject());
}

async function addSupportTicketNote({ ticketId, adminUser = {}, text = "" } = {}) {
  const noteText = compactText(text, 8000);
  if (!noteText) throw new Error("Support note text is required.");

  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new Error("Support ticket not found.");

  const adminName = await resolveActorLabel(adminUser);

  const note = {
    adminId: adminUser._id || adminUser.id || null,
    adminName,
    text: noteText,
    createdAt: new Date(),
  };

  ticket.internalNotes = [...(ticket.internalNotes || []), note];
  await ticket.save();
  publishConversationEvent(ticket.conversationId, {
    type: "conversation.updated",
    reason: "ticket.note_added",
    ticketStatus: ticket.status,
    ticketId: normalizeId(ticket._id),
    ticketReference: formatSupportTicketReference(ticket._id),
  });

  const hydrated = await hydrateTicket(ticket._id);
  return {
    ticket: serializeTicketForList(hydrated || ticket.toObject()),
    note: serializeNote(note),
  };
}

async function replyToSupportTicket({ ticketId, adminUser = {}, text = "", status } = {}) {
  const replyText = compactText(text, 12000);
  if (!replyText) throw new Error("Support reply text is required.");

  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new Error("Support ticket not found.");
  if (!ticket.conversationId) throw new Error("This ticket is not linked to a support conversation.");

  const conversation = await SupportConversation.findById(ticket.conversationId);
  if (!conversation) throw new Error("Support conversation not found.");

  const createdAt = new Date();
  const nextStatus = normalizeTicketStatus(status, "waiting_on_user");
  const adminName = await resolveActorLabel(adminUser);
  const message = await SupportMessage.create({
    conversationId: conversation._id,
    sender: "system",
    text: replyText,
    sourcePage: ticket.routePath || conversation.sourcePage || "",
    pageContext: ticket.pageContext || conversation.pageContext || {},
    metadata: {
      kind: "team_reply",
      source: "admin_support",
      teamLabel: "LPC Team",
      adminId: normalizeId(adminUser._id || adminUser.id),
      adminName,
      ticketId: normalizeId(ticket._id),
      ticketReference: formatSupportTicketReference(ticket._id),
      ticketStatus: nextStatus,
    },
  });

  ticket.status = nextStatus;
  ticket.lastAdminReplyAt = createdAt;
  if (nextStatus === "resolved" || nextStatus === "closed") {
    ticket.resolvedAt = createdAt;
  }
  await ticket.save();

  conversation.status = toConversationStatus(nextStatus, true);
  conversation.lastMessageAt = createdAt;
  if (conversation.escalation) {
    conversation.escalation.requested = true;
    conversation.escalation.note = "Team responded in support.";
  }
  await conversation.save();
  publishConversationEvent(conversation._id, {
    type: "conversation.updated",
    reason: "ticket.reply_created",
    ticketStatus: nextStatus,
    ticketId: normalizeId(ticket._id),
    ticketReference: formatSupportTicketReference(ticket._id),
  });

  const hydrated = await hydrateTicket(ticket._id);
  return {
    ticket: serializeTicketForList(hydrated || ticket.toObject()),
    replyMessage: serializeSupportMessage(message.toObject ? message.toObject() : message),
  };
}

async function linkTicketToIncident({ ticketId, incidentId } = {}) {
  const ticket = await SupportTicket.findById(ticketId);
  if (!ticket) throw new Error("Support ticket not found.");
  if (!incidentId) throw new Error("Incident id is required.");

  const incidentKey = String(incidentId);
  const existingIds = new Set((ticket.linkedIncidentIds || []).map((value) => String(value)));
  if (!existingIds.has(incidentKey)) {
    ticket.linkedIncidentIds = [...(ticket.linkedIncidentIds || []), incidentId];
    await ticket.save();
  }

  return regenerateResponsePacket({ ticketId: ticket._id });
}

async function reconcileResolvedLinkedIncidentTickets({ ticketId = "" } = {}) {
  const query = {
    linkedIncidentIds: { $exists: true, $not: { $size: 0 } },
    status: { $in: ACTIVE_WORK_STATUSES },
  };
  const normalizedTicketId = normalizeId(ticketId);
  if (normalizedTicketId) query._id = normalizedTicketId;

  const tickets = await SupportTicket.find(query)
    .select("_id linkedIncidentIds resolutionSummary")
    .lean();
  if (!tickets.length) return [];

  const incidentIds = [...new Set(
    tickets.flatMap((ticket) => (Array.isArray(ticket.linkedIncidentIds) ? ticket.linkedIncidentIds : []).map((id) => normalizeId(id)))
      .filter(Boolean)
  )];
  if (!incidentIds.length) return [];

  const incidents = await Incident.find({ _id: { $in: incidentIds } })
    .select("_id state resolution")
    .lean();
  const incidentById = new Map(incidents.map((incident) => [normalizeId(incident._id), incident]));
  const resolvedTicketIds = [];

  for (const ticket of tickets) {
    const linkedIncidents = (Array.isArray(ticket.linkedIncidentIds) ? ticket.linkedIncidentIds : [])
      .map((incidentId) => incidentById.get(normalizeId(incidentId)))
      .filter(Boolean);
    if (!linkedIncidents.length) continue;
    if (!linkedIncidents.every((incident) => INCIDENT_TERMINAL_STATES.includes(String(incident.state || "")))) continue;

    const resolutionSummary = compactText(
      linkedIncidents.find((incident) => incident?.resolution?.summary)?.resolution?.summary ||
        ticket.resolutionSummary ||
        "The linked engineering issue was fixed and verified.",
      3000
    );

    await updateTicketStatus({
      ticketId: ticket._id,
      status: "resolved",
      resolutionSummary,
      resolutionIsStable: true,
    });
    resolvedTicketIds.push(normalizeId(ticket._id));
  }

  return resolvedTicketIds;
}

function buildListQuery({ status, urgency, role, dateFrom, dateTo, includeHandedOff = false } = {}) {
  const query = {};
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus && normalizedStatus !== "all") {
    if (normalizedStatus === "waiting_on_user") {
      query.status = { $in: ["waiting_on_user", "waiting_on_info"] };
    } else {
      query.status = normalizeTicketStatus(normalizedStatus, normalizedStatus);
    }
  }

  const normalizedUrgency = String(urgency || "").trim().toLowerCase();
  if (normalizedUrgency && normalizedUrgency !== "all") {
    query.urgency = normalizeUrgency(normalizedUrgency, normalizedUrgency);
  }

  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole && normalizedRole !== "all") {
    query.requesterRole = normalizedRole;
  }

  if (dateFrom || dateTo) {
    query.createdAt = {};
    if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
    if (dateTo) query.createdAt.$lte = new Date(dateTo);
  }

  if (includeHandedOff !== true) {
    query.$and = [...(query.$and || []), SUPPORT_OWNED_FILTER];
  }

  return query;
}

function buildSort(sort = "") {
  const normalized = String(sort || "").trim().toLowerCase();
  if (normalized === "oldest") return { createdAt: 1, _id: 1 };
  if (normalized === "updated") return { updatedAt: -1, createdAt: -1 };
  if (normalized === "urgency") return { urgency: -1, updatedAt: -1, createdAt: -1 };
  return { createdAt: -1, _id: -1 };
}

async function listSupportTickets({
  status,
  urgency,
  role,
  dateFrom,
  dateTo,
  sort = "newest",
  limit = 50,
  includeHandedOff = false,
} = {}) {
  await reconcileResolvedLinkedIncidentTickets();
  const query = buildListQuery({ status, urgency, role, dateFrom, dateTo, includeHandedOff });
  const docs = await SupportTicket.find(query)
    .populate("requesterUserId", "firstName lastName email role status")
    .populate("assignedTo", "firstName lastName email role status")
    .populate("linkedIncidentIds", "publicId state summary userVisibleStatus")
    .sort(buildSort(sort))
    .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
    .lean();

  return docs.map(serializeTicketForList);
}

async function getSupportTicketById(ticketId) {
  await reconcileResolvedLinkedIncidentTickets({ ticketId });
  const ticket = await SupportTicket.findById(ticketId)
    .populate("requesterUserId", "firstName lastName email role status")
    .populate("assignedTo", "firstName lastName email role status")
    .populate("linkedIncidentIds", "publicId state summary userVisibleStatus")
    .lean();
  if (!ticket) return null;

  let conversation = null;
  let conversationMessages = [];

  if (ticket.conversationId) {
    const [conversationDoc, messageDocs] = await Promise.all([
      SupportConversation.findById(ticket.conversationId).lean(),
      SupportMessage.find({ conversationId: ticket.conversationId })
        .sort({ createdAt: 1, _id: 1 })
        .lean(),
    ]);
    if (conversationDoc) {
      conversation = {
        id: normalizeId(conversationDoc._id),
        status: conversationDoc.status || "open",
        sourceSurface: conversationDoc.sourceSurface || "manual",
        sourcePage: conversationDoc.sourcePage || "",
        pageContext: conversationDoc.pageContext || {},
        escalation: conversationDoc.escalation || {},
        createdAt: conversationDoc.createdAt || null,
        updatedAt: conversationDoc.updatedAt || null,
        lastMessageAt: conversationDoc.lastMessageAt || null,
      };
    }
    conversationMessages = messageDocs.map(serializeSupportMessage);
  }

  return serializeTicketForDetail(ticket, {
    conversation,
    conversationMessages,
  });
}

async function getSupportOverview() {
  await reconcileResolvedLinkedIncidentTickets();
  const [openCount, blockerCount, resolvedCount, waitingOnUserCount, handedOffCount, faqPendingCount, insightCount, latestTickets] =
    await Promise.all([
      SupportTicket.countDocuments({ $and: [SUPPORT_OWNED_FILTER, { status: { $in: ACTIVE_WORK_STATUSES } }] }),
      SupportTicket.countDocuments({
        $and: [SUPPORT_OWNED_FILTER, { status: { $in: ACTIVE_WORK_STATUSES } }, BLOCKER_SIGNAL_FILTER],
      }),
      SupportTicket.countDocuments({ $and: [SUPPORT_OWNED_FILTER, { status: { $in: RESOLVED_TICKET_STATUSES } }] }),
      SupportTicket.countDocuments({
        $and: [SUPPORT_OWNED_FILTER, { status: { $in: ["waiting_on_user", "waiting_on_info"] } }],
      }),
      SupportTicket.countDocuments({ linkedIncidentIds: { $exists: true, $not: { $size: 0 } }, status: { $in: ACTIVE_WORK_STATUSES } }),
      require("../../models/FAQCandidate").countDocuments({ approvalState: "pending_review" }),
      require("../../models/SupportInsight").countDocuments({ state: "active" }),
      SupportTicket.find(SUPPORT_OWNED_FILTER)
        .populate("requesterUserId", "firstName lastName email role status")
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(8)
        .lean(),
    ]);

  return {
    counts: {
      open: openCount,
      blockers: blockerCount,
      resolved: resolvedCount,
      waitingOnUser: waitingOnUserCount,
      handedOffToEngineering: handedOffCount,
      faqPending: faqPendingCount,
      insights: insightCount,
    },
    latestTickets: latestTickets.map((ticket) => ({
      id: normalizeId(ticket._id),
      subject: ticket.subject,
      status: normalizeTicketStatus(ticket.status, "open"),
      urgency: normalizeUrgency(ticket.urgency, ticket.latestResponsePacket?.confidence || "medium"),
      requesterRole: ticket.requesterRole,
      requester: serializeRequester(ticket.requesterUserId, ticket),
      category: ticket.classification?.category || "general_support",
      routingOwner: ticket.routingSuggestion?.ownerKey || "support_ops",
      priority: ticket.routingSuggestion?.priority || "normal",
      summary: compactText(ticket.latestResponsePacket?.recommendedReply || ticket.latestUserMessage || ticket.message, 160),
      updatedAt: ticket.updatedAt,
    })),
  };
}

module.exports = {
  addSupportTicketNote,
  createSupportTicket,
  getSupportOverview,
  getSupportTicketById,
  linkTicketToIncident,
  listSupportTickets,
  regenerateResponsePacket,
  replyToSupportTicket,
  updateTicketStatus,
};
