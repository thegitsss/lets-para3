const ApprovalTask = require("../../models/ApprovalTask");
const FAQCandidate = require("../../models/FAQCandidate");
const { LpcAction } = require("../../models/LpcAction");
const { LpcEvent } = require("../../models/LpcEvent");
const SupportConversation = require("../../models/SupportConversation");
const SupportInsight = require("../../models/SupportInsight");
const SupportMessage = require("../../models/SupportMessage");
const SupportTicket = require("../../models/SupportTicket");
const { ensurePendingRevisionFromDrift } = require("../knowledge/syncService");
const { ensureDraftPacketForBrief } = require("../marketing/draftService");
const { openLifecycleFollowUp, resolveLifecycleFollowUps } = require("../lifecycle/followUpService");
const { ensureAccountSnapshotPacket } = require("../sales/snapshotService");
const { publishConversationEvent } = require("../support/liveUpdateService");
const { generateFAQCandidates } = require("../support/faqCandidateService");
const { refreshSupportInsights } = require("../support/patternDetectionService");
const { updateTicketStatus } = require("../support/ticketService");
const { routeSupportSubmissionEvent } = require("./supportRoutingService");

function uniqueObjectIds(values = []) {
  const seen = new Set();
  const result = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });
  return result;
}

async function openFounderAlert({
  dedupeKey,
  title,
  summary = "",
  recommendedAction = "",
  priority = "high",
  subject,
  related = {},
  sourceEventId = null,
  metadata = {},
  ownerLabel = "Samantha",
  openedBy = { actorType: "system", label: "LPC Router" },
} = {}) {
  if (!dedupeKey || !subject?.entityType || !subject?.entityId) {
    throw new Error("Founder alert requires a dedupe key and subject.");
  }

  const now = new Date();
  const existing = await LpcAction.findOne({ dedupeKey, status: "open" });
  if (existing) {
    existing.lastSeenAt = now;
    existing.title = title || existing.title;
    existing.summary = summary || existing.summary;
    existing.recommendedAction = recommendedAction || existing.recommendedAction;
    existing.priority = priority || existing.priority;
    existing.related = { ...(existing.related || {}), ...(related || {}) };
    existing.metadata = { ...(existing.metadata || {}), ...(metadata || {}) };
    existing.sourceEventIds = uniqueObjectIds([...(existing.sourceEventIds || []), sourceEventId].filter(Boolean));
    existing.latestEventId = sourceEventId || existing.latestEventId;
    await existing.save();
    return { action: existing, created: false };
  }

  const action = await LpcAction.create({
    actionType: "founder_alert",
    status: "open",
    dedupeKey,
    ownerLabel,
    title,
    summary,
    recommendedAction,
    priority,
    subject,
    related,
    sourceEventIds: sourceEventId ? [sourceEventId] : [],
    firstEventId: sourceEventId || null,
    latestEventId: sourceEventId || null,
    firstSeenAt: now,
    lastSeenAt: now,
    openedBy,
    metadata,
  });

  return { action, created: true };
}

function compactText(value = "", max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWorkflowActor(actor = {}, fallbackLabel = "LPC Router") {
  const actorType = ["system", "agent"].includes(String(actor.actorType || "").trim().toLowerCase())
    ? String(actor.actorType).trim().toLowerCase()
    : "user";
  return {
    actorType,
    userId: actor.userId || null,
    label: actor.label || fallbackLabel,
  };
}

function buildResolvedSupportAssistantMessage() {
  return "Great news - the issue you reported has been fixed by our engineering team. Please try again and let me know if everything is working!";
}

function formatSupportCategoryLabel(category = "") {
  const normalized = String(category || "").trim().toLowerCase();
  const labels = {
    payment: "payout",
    stripe_onboarding: "Stripe setup",
    messaging: "messaging",
    case_posting: "case workflow",
    interaction_responsiveness_issue: "responsiveness",
    account_access: "account access",
    unknown: "support",
  };
  return labels[normalized] || normalized.replace(/_/g, " ") || "support";
}

function formatSupportRequesterRole(role = "") {
  const normalized = String(role || "").trim().toLowerCase();
  if (!normalized) return "User";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function deriveSupportEscalationLane(event = {}) {
  const after = event.facts?.after || {};
  const category = String(after.category || "").trim().toLowerCase();
  const reason = String(after.escalationReason || "").trim().toLowerCase();
  const ticketReference = String(after.ticketReference || event.subject?.publicId || "").trim();
  const requesterRoleLabel = formatSupportRequesterRole(after.requesterRole || event.actor?.role || "");
  const refSuffix = ticketReference ? `: ${ticketReference}` : "";

  if (category === "payment" || category === "stripe_onboarding") {
    return {
      lane: "payments_review",
      title: `${requesterRoleLabel} ${category === "stripe_onboarding" ? "Stripe setup" : "payout"} escalation${refSuffix}`,
      recommendedAction:
        "Review the payout and Stripe context first, confirm whether LPC has released funds or whether onboarding is incomplete, then reply from Support Ops.",
      priority: reason.includes("bank_timing") ? "urgent" : "high",
    };
  }

  if (category === "interaction_responsiveness_issue") {
    return {
      lane: "workflow_review",
      title: `${requesterRoleLabel} responsiveness issue${refSuffix}`,
      recommendedAction:
        "Review the message thread and case context, then decide whether LPC should intervene or follow up with the other party.",
      priority: "high",
    };
  }

  if (category === "messaging") {
    return {
      lane: "messaging_review",
      title: `${requesterRoleLabel} messaging issue${refSuffix}`,
      recommendedAction:
        "Review workspace access and message-send state first, then reply from Support Ops with the grounded blocker or next action.",
      priority: "high",
    };
  }

  if (category === "case_posting") {
    return {
      lane: "case_review",
      title: `${requesterRoleLabel} case workflow issue${refSuffix}`,
      recommendedAction:
        "Review the linked case workflow and current workspace state, then reply from Support Ops with the next safe step.",
      priority: "high",
    };
  }

  if (category === "account_access") {
    return {
      lane: "account_review",
      title: `${requesterRoleLabel} account access issue${refSuffix}`,
      recommendedAction:
        "Review the account-access record first because this can fully block platform use, then reply from Support Ops.",
      priority: "high",
    };
  }

  return {
    lane: "general_support_review",
    title: `${requesterRoleLabel} ${formatSupportCategoryLabel(category)} issue${refSuffix}`,
    recommendedAction: "Review the support packet in Support Ops and reply there after team review.",
    priority: "high",
  };
}

function mapSupportEventCategoryToTicketCategory(category = "") {
  const normalized = String(category || "").trim().toLowerCase();
  if (normalized === "payment" || normalized === "stripe_onboarding") return "payments_risk";
  if (normalized === "messaging" || normalized === "case_posting" || normalized === "interaction_responsiveness_issue") {
    return "case_workflow";
  }
  if (normalized === "account_access" || normalized === "login" || normalized === "password_reset") {
    return "account_access";
  }
  return normalized || "general_support";
}

async function buildSupportLearningSnapshot({ patternKey = "", category = "", latestUserMessage = "" } = {}) {
  const key = String(patternKey || "").trim();
  const normalizedMessage = normalizeText(latestUserMessage);
  const ticketCategory = mapSupportEventCategoryToTicketCategory(category);

  await refreshSupportInsights();
  const [insight, faqCandidateCount, ticketPatternCount, categoryTickets] = await Promise.all([
    key ? SupportInsight.findOne({ patternKey: key, state: "active" }).sort({ updatedAt: -1 }).lean() : null,
    key ? FAQCandidate.countDocuments({ patternKey: key }) : 0,
    key ? SupportTicket.countDocuments({ "classification.patternKey": key }) : 0,
    normalizedMessage && ticketCategory
      ? SupportTicket.find({ "classification.category": ticketCategory })
          .select("latestUserMessage")
          .lean()
      : [],
  ]);

  const messageMatchCount = normalizedMessage
    ? categoryTickets.filter((ticket) => normalizeText(ticket.latestUserMessage) === normalizedMessage).length
    : 0;
  const repeatCount = Math.max(
    Number(insight?.repeatCount || 0),
    Number(ticketPatternCount || 0),
    Number(messageMatchCount || 0)
  );

  return {
    patternKey: key,
    repeatCount: Number(repeatCount || 0),
    insightId: insight?._id ? String(insight._id) : "",
    faqCandidateCount: Number(faqCandidateCount || 0),
    summary: insight?.summary || "",
  };
}

async function resolveFounderAlerts({
  dedupeKeys = [],
  subject = null,
  resolutionReason = "",
  resolvedBy = { actorType: "system", label: "LPC Router" },
} = {}) {
  const query = { actionType: "founder_alert", status: "open" };
  const cleanKeys = (Array.isArray(dedupeKeys) ? dedupeKeys : []).map((value) => String(value || "").trim()).filter(Boolean);
  if (cleanKeys.length) {
    query.dedupeKey = { $in: cleanKeys };
  } else if (subject?.entityType && subject?.entityId) {
    query["subject.entityType"] = subject.entityType;
    query["subject.entityId"] = subject.entityId;
  } else {
    return { modifiedCount: 0, actionIds: [] };
  }

  const actions = await LpcAction.find(query).select("_id").lean();
  if (!actions.length) {
    return { modifiedCount: 0, actionIds: [] };
  }

  const update = await LpcAction.updateMany(query, {
    $set: {
      status: "resolved",
      resolvedAt: new Date(),
      resolvedBy,
      resolutionReason: resolutionReason || "Resolved.",
    },
  });

  return {
    modifiedCount: Number(update.modifiedCount || 0),
    actionIds: actions.map((action) => String(action._id)),
  };
}

async function routeSignupCreated(event) {
  const role = String(event.facts?.after?.role || event.actor?.role || "").toLowerCase();
  const status = String(event.facts?.after?.status || "pending").toLowerCase();
  if (status !== "pending") {
    return { status: "skipped", actionKeys: [] };
  }
  const result = await openLifecycleFollowUp({
    dedupeKey: `lifecycle:user-signup:${event.subject.entityId}`,
    title: `Review ${role || "user"} signup`,
    summary: compactText(
      `${event.facts?.after?.email || "A new account"} signed up and is awaiting review in the admissions queue.`,
      400
    ),
    recommendedAction: "Review the signup record and decide whether more information or an approval decision is needed.",
    priority: "normal",
    subject: event.subject,
    related: event.related,
    sourceEventId: event._id,
    dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    metadata: {
      eventType: event.eventType,
      role,
      status,
    },
  });
  return { status: "routed", actionKeys: [String(result.action._id)] };
}

async function routeApprovalDecided(event) {
  const status = String(event.facts?.after?.status || "").toLowerCase();
  if (!["approved", "denied", "rejected"].includes(status)) {
    return { status: "skipped", actionKeys: [] };
  }

  await resolveLifecycleFollowUps({
    dedupeKeys: [
      `lifecycle:user-signup:${event.subject.entityId}`,
      `lifecycle:user-profile-incomplete:${event.subject.entityId}`,
    ],
    resolutionReason: `User status changed to ${status}.`,
    resolvedBy: {
      actorType: "user",
      userId: event.actor?.userId || null,
      label: event.actor?.label || "Admin",
    },
  });

  return { status: "skipped", actionKeys: [] };
}

async function routeDisputeOpened(event) {
  const disputeId = String(event.facts?.after?.disputeId || event.facts?.disputeId || "").trim();
  const caseTitle = compactText(event.facts?.after?.caseTitle || event.facts?.caseTitle || "Case", 120);
  const result = await openFounderAlert({
    dedupeKey: `founder-alert:dispute:${event.subject.entityId}:${disputeId || "open"}`,
    title: `Open dispute: ${caseTitle}`,
    summary: compactText(
      event.facts?.summary ||
        event.facts?.after?.message ||
        "A dispute was opened and requires founder-visible review.",
      400
    ),
    recommendedAction: "Review the dispute context and keep any resolution decision inside the authoritative dispute workflow.",
    priority: "urgent",
    subject: event.subject,
    related: event.related,
    sourceEventId: event._id,
    metadata: {
      eventType: event.eventType,
      disputeId,
      caseTitle,
    },
  });
  return { status: "routed", actionKeys: [String(result.action._id)] };
}

async function routeApprovalRequested(event) {
  const targetType = String(event.facts?.approvalTargetType || event.subject.entityType || "").trim();
  const targetId = String(event.facts?.approvalTargetId || event.subject.entityId || "").trim();
  const title = compactText(event.facts?.title || `Approval requested: ${targetType}`, 160);
  const summary = compactText(
    event.facts?.summary || "A founder-visible approval request is awaiting review.",
    400
  );
  const result = await openFounderAlert({
    dedupeKey: `founder-alert:approval:${targetType}:${targetId}`,
    title,
    summary,
    recommendedAction:
      "Review the approval packet in its authoritative workspace and record the decision there.",
    priority: event.signals?.priority || "high",
    subject: event.subject,
    related: event.related,
    sourceEventId: event._id,
    metadata: {
      eventType: event.eventType,
      approvalTargetType: targetType,
      approvalTargetId: targetId,
      ownerLabel: event.facts?.ownerLabel || "",
    },
  });
  return { status: "routed", actionKeys: [String(result.action._id)] };
}

async function routePublicContactSubmitted(event) {
  const email = String(event.facts?.after?.email || "").trim().toLowerCase();
  if (!email) {
    return { status: "skipped", actionKeys: [] };
  }
  const result = await openLifecycleFollowUp({
    dedupeKey: `lifecycle:public-contact:${email}`,
    title: `Review public contact signal`,
    summary: compactText(
      `${email} submitted a public contact request${event.facts?.after?.subject ? ` about "${event.facts.after.subject}"` : ""}.`,
      400
    ),
    recommendedAction: "Review the inbound contact and decide whether it belongs in the existing sales or support workflow.",
    priority: "normal",
    subject: event.subject,
    related: event.related,
    sourceEventId: event._id,
    dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    metadata: {
      eventType: event.eventType,
      email,
      role: event.facts?.after?.role || "",
    },
  });
  return { status: "routed", actionKeys: [String(result.action._id)] };
}

async function routeIncompleteProfileWindow(event) {
  const reasons = Array.isArray(event.facts?.missingFields) ? event.facts.missingFields : [];
  const ageHours = Number(event.facts?.ageHours || 0);
  const result = await openLifecycleFollowUp({
    dedupeKey: `lifecycle:user-profile-incomplete:${event.subject.entityId}`,
    title: `Follow up on incomplete pending profile`,
    summary: compactText(
      `${event.facts?.after?.email || "A pending user"} is still missing ${reasons.slice(0, 3).join(", ") || "required profile fields"} after the follow-up window elapsed.`,
      400
    ),
    recommendedAction: "Request the missing information or close the loop through the existing admissions decision flow.",
    priority: ageHours >= 72 ? "high" : "normal",
    subject: event.subject,
    related: event.related,
    sourceEventId: event._id,
    dueAt: new Date(),
    metadata: {
      eventType: event.eventType,
      missingFields: reasons,
      ageHours,
    },
  });
  return { status: "routed", actionKeys: [String(result.action._id)] };
}

async function routeSupportSubmissionCreated(event) {
  return routeSupportSubmissionEvent(event);
}

async function routeIncidentCreated(_event) {
  return { status: "skipped", actionKeys: [] };
}

async function routeIncidentResolved(event) {
  const incidentId = String(event.subject?.entityId || event.related?.incidentId || "").trim();
  const incidentPublicId = String(event.subject?.publicId || event.facts?.after?.publicId || "").trim();
  const resolutionSummary = compactText(
    event.facts?.summary || "The linked engineering issue was fixed and verified.",
    3000
  );
  const resolvedConversationKeys = [];

  if (incidentId) {
    const linkedOpenTickets = await SupportTicket.find({
      linkedIncidentIds: incidentId,
      status: { $in: ["open", "in_review", "waiting_on_user", "waiting_on_info"] },
    })
      .select("_id conversationId routePath pageContext")
      .lean();

    for (const ticket of linkedOpenTickets) {
      await updateTicketStatus({
        ticketId: ticket._id,
        status: "resolved",
        resolutionSummary,
        resolutionIsStable: true,
      });
    }

    const seenConversationIds = new Set();
    for (const ticket of linkedOpenTickets) {
      const conversationId = String(ticket.conversationId || "").trim();
      if (!conversationId || seenConversationIds.has(conversationId)) continue;
      seenConversationIds.add(conversationId);

      const incidentResolutionDedupeKey = `incident-resolution-follow-up:${incidentId}:${conversationId}`;
      const existingMessage = await SupportMessage.findOne({
        conversationId,
        "metadata.kind": "incident_resolution_follow_up",
        "metadata.incidentResolutionDedupeKey": incidentResolutionDedupeKey,
      })
        .select("_id")
        .lean();
      if (existingMessage?._id) continue;

      const conversation = await SupportConversation.findById(conversationId);
      if (!conversation) continue;

      const message = await SupportMessage.create({
        conversationId: conversation._id,
        sender: "assistant",
        text: buildResolvedSupportAssistantMessage(),
        sourcePage: ticket.routePath || conversation.sourcePage || "",
        pageContext:
          ticket.pageContext && Object.keys(ticket.pageContext).length
            ? ticket.pageContext
            : conversation.pageContext || {},
        metadata: {
          kind: "incident_resolution_follow_up",
          source: "lpc_event_router",
          incidentId,
          incidentPublicId,
          incidentResolutionDedupeKey,
          resolutionSummary,
        },
      });

      conversation.lastMessageAt = message.createdAt || new Date();
      await conversation.save();

      publishConversationEvent(conversation._id, {
        type: "conversation.updated",
        reason: "incident.resolved_support_message",
        incidentId,
        incidentPublicId,
        supportMessageId: String(message._id || ""),
      });
      resolvedConversationKeys.push(String(conversation._id));
    }
  }

  const candidates = await generateFAQCandidates();
  return {
    status: incidentId || candidates.length ? "routed" : "skipped",
    actionKeys: [
      ...(incidentId ? [incidentId] : []),
      ...resolvedConversationKeys,
      ...candidates.map((candidate) => String(candidate._id)),
    ],
  };
}

async function routeSupportTicketResolved(event) {
  await resolveFounderAlerts({
    dedupeKeys: [`founder-alert:support-ticket:${event.subject.entityId}`],
    resolutionReason: "Support ticket was resolved.",
    resolvedBy: normalizeWorkflowActor(event.actor, "Support Ticket Service"),
  });
  if (event.facts?.after?.resolutionIsStable !== true) {
    return { status: "skipped", actionKeys: [] };
  }
  const candidates = await generateFAQCandidates();
  return {
    status: candidates.length ? "routed" : "skipped",
    actionKeys: candidates.map((candidate) => String(candidate._id)),
  };
}

async function routeSupportTicketEscalated(event) {
  const ticketReference = String(event.facts?.after?.ticketReference || event.subject?.publicId || "").trim();
  const category = String(event.facts?.after?.category || "").trim();
  const patternKey = String(event.facts?.after?.patternKey || "").trim();
  const latestUserMessage = compactText(event.facts?.after?.latestUserMessage || event.facts?.summary || "", 200);
  const requesterRole = String(event.facts?.after?.requesterRole || event.actor?.role || "").trim().toLowerCase();
  const requesterRoleLabel = formatSupportRequesterRole(requesterRole);
  const requesterName = compactText(event.facts?.after?.requesterName || event.actor?.label || "", 80);
  const sourceSurface = compactText(event.facts?.after?.sourceSurface || event.source?.surface || "", 60);
  const sourcePage = compactText(event.facts?.after?.sourcePage || event.source?.route || "", 120);
  const viewName = compactText(event.facts?.after?.viewName || "", 80);
  const caseTitle = compactText(event.facts?.after?.caseTitle || "", 120);
  const primaryAsk = compactText(String(event.facts?.after?.primaryAsk || "").replace(/_/g, " "), 80);
  const lane = deriveSupportEscalationLane(event);
  const learning = await buildSupportLearningSnapshot({
    patternKey,
    category,
    latestUserMessage,
  });
  const learningLine =
    learning.repeatCount >= 2
      ? `Recurring signal across ${learning.repeatCount} support tickets.`
      : "";
  const title = compactText(lane.title, 160);
  const contextBits = [
    requesterRoleLabel !== "User" ? `${requesterRoleLabel} support request.` : "",
    requesterName ? `Requester: ${requesterName}.` : "",
    caseTitle ? `Case: ${caseTitle}.` : "",
    primaryAsk ? `Ask: ${primaryAsk}.` : "",
    viewName ? `View: ${viewName}.` : sourceSurface ? `Surface: ${sourceSurface}.` : "",
    sourcePage ? `Route: ${sourcePage}.` : "",
  ].filter(Boolean);
  const summary = compactText(
    [
      latestUserMessage || "An in-product support escalation is waiting for founder review.",
      ...contextBits,
      learningLine,
    ]
      .filter(Boolean)
      .join(" "),
    400
  );
  const result = await openFounderAlert({
    dedupeKey: `founder-alert:support-ticket:${event.subject.entityId}`,
    title,
    summary,
    recommendedAction: lane.recommendedAction,
    priority: lane.priority || event.signals?.priority || "high",
    subject: event.subject,
    related: event.related,
    sourceEventId: event._id,
    metadata: {
      eventType: event.eventType,
      ticketReference,
      category,
      escalationReason: event.facts?.after?.escalationReason || "",
      escalationLane: lane.lane,
      requesterRole,
      requesterName,
      sourceSurface,
      sourcePage,
      viewName,
      caseTitle,
      primaryAsk,
      learning,
    },
  });
  return { status: "routed", actionKeys: [String(result.action._id)] };
}

async function routeMarketingBriefCreated(event) {
  const briefId = event.related?.marketingBriefId || event.subject.entityId;
  if (!briefId) return { status: "skipped", actionKeys: [] };

  const packet = await ensureDraftPacketForBrief({
    briefId,
    actor: normalizeWorkflowActor(event.actor, "LPC Router"),
  });
  const approvalTask = packet?._id
    ? await ApprovalTask.findOne({
        taskType: "marketing_review",
        targetType: "marketing_draft_packet",
        targetId: String(packet._id),
        approvalState: "pending",
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean()
    : null;

  return {
    status: packet ? "routed" : "skipped",
    actionKeys: [packet?._id, approvalTask?._id].filter(Boolean).map((value) => String(value)),
  };
}

async function routeSalesAccountCreated(event) {
  const accountId = event.related?.salesAccountId || event.subject.entityId;
  if (!accountId) return { status: "skipped", actionKeys: [] };

  const packet = await ensureAccountSnapshotPacket({
    accountId,
    actor: normalizeWorkflowActor(event.actor, "LPC Router"),
  });
  const approvalTask = packet?._id
    ? await ApprovalTask.findOne({
        taskType: "sales_review",
        targetType: "sales_draft_packet",
        targetId: String(packet._id),
        approvalState: "pending",
      })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean()
    : null;

  return {
    status: packet ? "routed" : "skipped",
    actionKeys: [packet?._id, approvalTask?._id].filter(Boolean).map((value) => String(value)),
  };
}

async function routeKnowledgeItemDriftDetected(event) {
  const itemId = event.related?.knowledgeItemId || event.subject.entityId;
  const itemDef = event.facts?.itemDef;
  if (!itemId || !itemDef) {
    return { status: "skipped", actionKeys: [] };
  }

  const result = await ensurePendingRevisionFromDrift({
    itemId,
    itemDef,
    sourceKey: event.facts?.sourceKey || "",
    fingerprint: event.facts?.fingerprint || "",
    actor: normalizeWorkflowActor(event.actor, "Knowledge Sync Service"),
    changeSummary:
      event.facts?.summary ||
      "Source-backed draft revision created after registry drift.",
  });

  return {
    status: "routed",
    actionKeys: [result.revision?._id, result.approvalTask?._id].filter(Boolean).map((value) => String(value)),
  };
}

async function routeKnowledgeItemStaleDue(event) {
  const itemId = event.related?.knowledgeItemId || event.subject.entityId;
  if (!itemId) return { status: "skipped", actionKeys: [] };

  const staleFacts = event.facts?.after || {};
  const audienceScopes = Array.isArray(event.facts?.audienceScopes)
    ? event.facts.audienceScopes
    : Array.isArray(staleFacts.audienceScopes)
      ? staleFacts.audienceScopes
      : [];
  const approvalState = String(event.facts?.approvalState || staleFacts.approvalState || "").trim().toLowerCase();
  const nextReviewAt = event.facts?.nextReviewAt || staleFacts.nextReviewAt || null;
  if (approvalState && approvalState !== "approved") {
    return { status: "skipped", actionKeys: [] };
  }

  const isPublicApproved = audienceScopes.includes("public_approved");
  if (isPublicApproved) {
    const result = await openFounderAlert({
      dedupeKey: `founder-alert:knowledge-stale:${itemId}`,
      title: `Stale public knowledge review: ${compactText(event.facts?.title || "Knowledge item", 140)}`,
      summary: compactText(
        event.facts?.summary ||
          "An approved public-facing knowledge item passed its review window and should be re-checked.",
        400
      ),
      recommendedAction:
        "Review the knowledge item in the governed knowledge workflow and either confirm freshness or route a revised draft through approval.",
      priority: "high",
      subject: event.subject,
      related: event.related,
      sourceEventId: event._id,
      metadata: {
        eventType: event.eventType,
        nextReviewAt,
        approvalState,
        audienceScopes,
      },
    });
    return { status: "routed", actionKeys: [String(result.action._id)] };
  }

  const result = await openLifecycleFollowUp({
    dedupeKey: `lifecycle:knowledge-stale:${itemId}`,
    title: `Review stale knowledge item`,
    summary: compactText(
      event.facts?.summary ||
        "A governed knowledge item passed its review window and should be re-checked.",
      400
    ),
    recommendedAction:
      "Review the item in the governed knowledge workflow and decide whether a refreshed revision is needed.",
    priority: "normal",
    subject: event.subject,
    related: event.related,
      sourceEventId: event._id,
      dueAt: new Date(),
      metadata: {
        eventType: event.eventType,
        nextReviewAt,
        approvalState,
        audienceScopes,
      },
  });

  return { status: "routed", actionKeys: [String(result.action._id)] };
}

async function routeApprovalDecisionCompleted(event) {
  const decision = String(event.facts?.decision || "").trim().toLowerCase();
  const targetType = String(event.facts?.approvalTargetType || "").trim();
  const targetId = String(event.facts?.approvalTargetId || "").trim();
  if (!targetType || !targetId || !["approved", "rejected"].includes(decision)) {
    return { status: "skipped", actionKeys: [] };
  }

  const resolvedBy = {
    actorType: ["system", "agent"].includes(String(event.actor?.actorType || "").trim().toLowerCase())
      ? String(event.actor.actorType).trim().toLowerCase()
      : "user",
    userId: event.actor?.userId || null,
    label: event.actor?.label || "Approval Workflow",
  };
  const outcome = await resolveFounderAlerts({
    dedupeKeys: [`founder-alert:approval:${targetType}:${targetId}`],
    resolutionReason: `Approval decision completed: ${decision}.`,
    resolvedBy,
  });

  if (decision === "approved" && targetType === "knowledge_revision") {
    const knowledgeItemId = event.related?.knowledgeItemId ? String(event.related.knowledgeItemId) : "";
    if (knowledgeItemId) {
      await resolveFounderAlerts({
        dedupeKeys: [`founder-alert:knowledge-stale:${knowledgeItemId}`],
        resolutionReason: "Knowledge review completed with approval.",
        resolvedBy,
      });
      await resolveLifecycleFollowUps({
        dedupeKeys: [`lifecycle:knowledge-stale:${knowledgeItemId}`],
        resolutionReason: "Knowledge review completed with approval.",
        resolvedBy,
      });
    }
  }

  return {
    status: outcome.modifiedCount ? "routed" : "skipped",
    actionKeys: outcome.actionIds,
  };
}

async function routeEvent(event) {
  if (!event?._id) throw new Error("Event is required for routing.");

  let outcome = { status: "skipped", actionKeys: [] };
  switch (event.eventType) {
    case "user.signup.created":
      outcome = await routeSignupCreated(event);
      break;
    case "user.approval.decided":
      outcome = await routeApprovalDecided(event);
      break;
    case "dispute.opened":
      outcome = await routeDisputeOpened(event);
      break;
    case "approval.requested":
      outcome = await routeApprovalRequested(event);
      break;
    case "public.contact.submitted":
      outcome = await routePublicContactSubmitted(event);
      break;
    case "user.profile.incomplete_window_elapsed":
      outcome = await routeIncompleteProfileWindow(event);
      break;
    case "support.submission.created":
      outcome = await routeSupportSubmissionCreated(event);
      break;
    case "incident.created":
      outcome = await routeIncidentCreated(event);
      break;
    case "incident.resolved":
      outcome = await routeIncidentResolved(event);
      break;
    case "support.ticket.resolved":
      outcome = await routeSupportTicketResolved(event);
      break;
    case "support.ticket.escalated":
      outcome = await routeSupportTicketEscalated(event);
      break;
    case "marketing.brief.created":
      outcome = await routeMarketingBriefCreated(event);
      break;
    case "sales.account.created":
      outcome = await routeSalesAccountCreated(event);
      break;
    case "knowledge.item.drift_detected":
      outcome = await routeKnowledgeItemDriftDetected(event);
      break;
    case "knowledge.item.stale_due":
      outcome = await routeKnowledgeItemStaleDue(event);
      break;
    case "approval.approved":
    case "approval.rejected":
      outcome = await routeApprovalDecisionCompleted(event);
      break;
    default:
      outcome = { status: "skipped", actionKeys: [] };
      break;
  }

  event.routing.status = outcome.status;
  event.routing.actionKeys = outcome.actionKeys || [];
  event.routing.lastRoutedAt = new Date();
  event.routing.error = "";
  await event.save();
  return outcome;
}

async function routeEventById(eventId) {
  const event = await LpcEvent.findById(eventId);
  if (!event) throw new Error("LPC event not found.");
  return routeEvent(event);
}

module.exports = {
  openFounderAlert,
  routeEvent,
  routeEventById,
};
