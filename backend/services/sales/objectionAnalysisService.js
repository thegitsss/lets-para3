const ApprovalTask = require("../../models/ApprovalTask");
const SalesDraftPacket = require("../../models/SalesDraftPacket");
const { buildSalesContext } = require("./contextService");
const { collectCitations, compactText, flattenClaims, summarizeBlocks, uniqueList } = require("./shared");
const { publishEventSafe } = require("../lpcEvents/publishEventService");

async function createApprovalTask({ packet, account, actor }) {
  const task = await ApprovalTask.create({
    taskType: "sales_review",
    targetType: "sales_draft_packet",
    targetId: String(packet._id),
    parentType: "SalesAccount",
    parentId: String(account._id),
    title: `Review sales packet: ${account.name}`,
    summary: `A ${packet.packetType} packet is awaiting Samantha approval before any external use.`,
    approvalState: "pending",
    requestedBy: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Sales Draft Service",
    },
    assignedOwnerLabel: "Samantha",
    metadata: {
      packetType: packet.packetType,
      packetVersion: packet.packetVersion,
    },
  });

  await publishEventSafe({
    eventType: "approval.requested",
    eventFamily: "approval",
    idempotencyKey: `approval-task:${task._id}:requested`,
    correlationId: `sales:${account._id}`,
    actor: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Sales Objection Service",
    },
    subject: {
      entityType: "approval_task",
      entityId: String(task._id),
    },
    related: {
      approvalTaskId: task._id,
      salesAccountId: account._id,
      salesDraftPacketId: packet._id,
    },
    source: {
      surface: "system",
      route: "",
      service: "sales",
      producer: "service",
    },
    facts: {
      title: task.title,
      summary: task.summary,
      approvalTargetType: task.targetType,
      approvalTargetId: task.targetId,
      ownerLabel: task.assignedOwnerLabel || "Samantha",
    },
    signals: {
      confidence: "high",
      priority: "high",
      founderVisible: true,
      approvalRequired: true,
      publicFacing: true,
    },
  });

  return task;
}

async function generateObjectionReviewPacket({ accountId, actor = {} } = {}) {
  const context = await buildSalesContext(accountId);
  const latest = await SalesDraftPacket.findOne({ accountId, packetType: "objection_review" })
    .sort({ packetVersion: -1 })
    .select("packetVersion")
    .lean();
  const packetVersion = Number(latest?.packetVersion || 0) + 1;

  const observedObjections = uniqueList(
    context.interactions.flatMap((interaction) => interaction.objections || [])
  );
  const objectionBlocks = summarizeBlocks(context.objectionCards, 6);
  const citations = collectCitations(context.objectionCards);
  const unknowns = [];
  if (!observedObjections.length) unknowns.push("Recorded objection language from this account");

  const packet = await SalesDraftPacket.create({
    accountId,
    packetType: "objection_review",
    packetVersion,
    approvalState: "pending_review",
    accountSummary: compactText(context.account.accountSummary || context.account.name, 1200),
    audienceSummary: compactText(
      observedObjections.length
        ? `Observed objections: ${observedObjections.join("; ")}`
        : "No explicit objections are recorded yet for this account.",
      1200
    ),
    approvedPositioningBlocks: objectionBlocks,
    citations,
    riskFlags: uniqueList(flattenClaims(context.claimGuardrails).slice(0, 8)),
    unknowns,
    whatStillNeedsSamantha: [
      "Approve any objection-handling language before external use.",
      "Decide whether the account needs a tailored answer packet next.",
    ],
    recommendedNextStep: observedObjections.length
      ? "Review the observed objections against approved response language and decide whether targeted outreach is appropriate."
      : "Capture an explicit objection before relying on this review packet externally.",
    channelDraft: {
      channel: "objection_review",
      objections: observedObjections,
      responseGuidance: objectionBlocks.map((block) => block.statement || block.summary).filter(Boolean),
    },
    packetSummary: compactText(`Objection review packet for ${context.account.name}.`, 220),
    generatedBy: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Sales Objection Service",
    },
    metadata: {
      observedObjections,
      interactionIds: context.interactions.map((interaction) => String(interaction._id)).slice(0, 12),
    },
  });

  await createApprovalTask({ packet, account: context.account, actor });
  return packet.toObject();
}

module.exports = {
  generateObjectionReviewPacket,
};
