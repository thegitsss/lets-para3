const { LpcEvent } = require("../../models/LpcEvent");

function compactText(value = "", max = 240) {
  return String(value || "").trim().slice(0, max);
}

function buildRelated(input = {}) {
  return {
    userId: input.userId || null,
    caseId: input.caseId || null,
    jobId: input.jobId || null,
    applicationId: input.applicationId || null,
    incidentId: input.incidentId || null,
    supportTicketId: input.supportTicketId || null,
    knowledgeItemId: input.knowledgeItemId || null,
    knowledgeRevisionId: input.knowledgeRevisionId || null,
    marketingBriefId: input.marketingBriefId || null,
    marketingDraftPacketId: input.marketingDraftPacketId || null,
    salesAccountId: input.salesAccountId || null,
    salesInteractionId: input.salesInteractionId || null,
    salesDraftPacketId: input.salesDraftPacketId || null,
    approvalTaskId: input.approvalTaskId || null,
  };
}

function normalizeEventPayload(payload = {}) {
  if (!payload.eventType) throw new Error("eventType is required.");
  if (!payload.eventFamily) throw new Error("eventFamily is required.");
  if (!payload.subject?.entityType || !payload.subject?.entityId) {
    throw new Error("subject.entityType and subject.entityId are required.");
  }

  return {
    version: 1,
    eventType: payload.eventType,
    eventFamily: payload.eventFamily,
    idempotencyKey: compactText(payload.idempotencyKey, 240),
    correlationId: compactText(payload.correlationId, 240),
    causationId: compactText(payload.causationId, 240),
    occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : new Date(),
    recordedAt: new Date(),
    actor: {
      actorType: payload.actor?.actorType || "system",
      userId: payload.actor?.userId || null,
      role: compactText(payload.actor?.role, 120),
      email: compactText(payload.actor?.email, 320).toLowerCase(),
      label: compactText(payload.actor?.label, 240),
    },
    subject: {
      entityType: compactText(payload.subject.entityType, 120),
      entityId: compactText(payload.subject.entityId, 120),
      publicId: compactText(payload.subject.publicId, 120),
    },
    related: buildRelated(payload.related || {}),
    source: {
      surface: payload.source?.surface || "system",
      route: compactText(payload.source?.route, 500),
      service: payload.source?.service || "lifecycle",
      producer: payload.source?.producer || "service",
    },
    facts: payload.facts || {},
    signals: {
      confidence: payload.signals?.confidence || "medium",
      priority: payload.signals?.priority || "normal",
      moneyRisk: payload.signals?.moneyRisk === true,
      authRisk: payload.signals?.authRisk === true,
      caseProgressRisk: payload.signals?.caseProgressRisk === true,
      publicFacing: payload.signals?.publicFacing === true,
      founderVisible: payload.signals?.founderVisible === true,
      repeatKey: compactText(payload.signals?.repeatKey, 240),
      approvalRequired: payload.signals?.approvalRequired === true,
    },
    routing: {
      status: "pending",
      actionKeys: [],
      lastRoutedAt: null,
      error: "",
    },
  };
}

async function publishEvent(payload = {}, options = {}) {
  const normalized = normalizeEventPayload(payload);
  let event = null;
  let created = false;

  if (normalized.idempotencyKey) {
    event = await LpcEvent.findOne({ idempotencyKey: normalized.idempotencyKey });
  }

  if (!event) {
    event = await LpcEvent.create(normalized);
    created = true;
  }

  if (created && options.routeNow !== false) {
    const { routeEvent } = require("./routerService");
    try {
      await routeEvent(event);
    } catch (err) {
      event.routing.status = "failed";
      event.routing.lastRoutedAt = new Date();
      event.routing.error = compactText(err?.message || err, 4000);
      await event.save();
      throw err;
    }
  }

  return { event, created };
}

async function publishEventSafe(payload = {}, options = {}) {
  try {
    return await publishEvent(payload, options);
  } catch (err) {
    console.warn("[lpc-events] publish failed", err?.message || err);
    return { event: null, created: false, error: err };
  }
}

module.exports = {
  publishEvent,
  publishEventSafe,
};
