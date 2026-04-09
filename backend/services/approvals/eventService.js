const { publishEventSafe } = require("../lpcEvents/publishEventService");

function compactText(value = "", max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function publishApprovalDecisionEvent({
  decision = "",
  approvalRecordType = "approval_task",
  approvalRecordId = "",
  approvalTargetType = "",
  approvalTargetId = "",
  title = "",
  summary = "",
  actor = {},
  related = {},
  service = "approvals",
  sourceSurface = "system",
  route = "",
  correlationId = "",
  founderVisible = true,
  publicFacing = true,
  priority = "normal",
  metadata = {},
} = {}) {
  const normalizedDecision = String(decision || "").trim().toLowerCase();
  if (!["approved", "rejected"].includes(normalizedDecision)) return null;
  if (!approvalRecordId || !approvalTargetType || !approvalTargetId) return null;

  const eventType = normalizedDecision === "approved" ? "approval.approved" : "approval.rejected";
  return publishEventSafe({
    eventType,
    eventFamily: "approval",
    idempotencyKey: `${approvalRecordType}:${approvalRecordId}:${normalizedDecision}`,
    correlationId: compactText(correlationId || `${approvalRecordType}:${approvalRecordId}`, 240),
    actor: {
      actorType: actor.actorType || "user",
      userId: actor.userId || null,
      role: actor.role || "",
      email: actor.email || "",
      label: actor.label || "Admin",
    },
    subject: {
      entityType: approvalRecordType,
      entityId: String(approvalRecordId),
    },
    related,
    source: {
      surface: sourceSurface,
      route,
      service,
      producer: "service",
    },
    facts: {
      title,
      summary,
      approvalTargetType,
      approvalTargetId,
      decision: normalizedDecision,
      ...metadata,
    },
    signals: {
      confidence: "high",
      priority,
      founderVisible,
      publicFacing,
    },
  });
}

module.exports = {
  publishApprovalDecisionEvent,
};
