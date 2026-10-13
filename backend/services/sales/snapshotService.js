const ApprovalTask = require("../../models/ApprovalTask");
const SalesAccount = require("../../models/SalesAccount");
const SalesDraftPacket = require("../../models/SalesDraftPacket");
const { buildSalesContext } = require("./contextService");
const { collectCitations, compactText, flattenClaims, summarizeBlocks, uniqueList } = require("./shared");
const { publishEventSafe } = require("../lpcEvents/publishEventService");

async function createApprovalTask({ packet, account, actor }) {
  const existing = await ApprovalTask.findOne({
    taskType: "sales_review",
    targetType: "sales_draft_packet",
    targetId: String(packet._id),
    approvalState: "pending",
  }).lean();
  if (existing) return existing;

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
      label: actor.label || "Sales Snapshot Service",
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

async function generateAccountSnapshotPacket({ accountId, actor = {} } = {}) {
  const context = await buildSalesContext(accountId);
  const latest = await SalesDraftPacket.findOne({ accountId, packetType: "account_snapshot" })
    .sort({ packetVersion: -1 })
    .select("packetVersion")
    .lean();
  const packetVersion = Number(latest?.packetVersion || 0) + 1;

  const blocks = summarizeBlocks(
    [
      ...context.positioningCards,
      ...context.distinctivenessCards,
      ...context.valueCards,
      ...context.factCards,
    ],
    6
  );
  const citations = collectCitations([
    ...context.positioningCards,
    ...context.distinctivenessCards,
    ...context.valueCards,
    ...context.factCards,
  ]);
  const interactionSummary = context.interactions.slice(0, 4).map((interaction) => interaction.summary);
  const unknowns = [];
  if (!context.account.primaryEmail) unknowns.push("Primary email");
  if (!context.account.companyName && !context.linkedUser?.lawFirm) unknowns.push("Firm or company name");
  if (!context.interactions.length) unknowns.push("Recorded interaction history");

  const packet = await SalesDraftPacket.create({
    accountId,
    packetType: "account_snapshot",
    packetVersion,
    approvalState: "pending_review",
    accountSummary: compactText(
      context.account.accountSummary ||
        `Sales account for ${context.account.name}${context.account.companyName ? ` at ${context.account.companyName}` : ""}.`,
      1200
    ),
    audienceSummary: compactText(
      `Audience fit is currently ${context.account.audienceType || context.linkedUser?.role || "general"} with ${context.interactions.length} recorded interaction${context.interactions.length === 1 ? "" : "s"}.`,
      1200
    ),
    approvedPositioningBlocks: blocks,
    citations,
    riskFlags: uniqueList(flattenClaims(context.claimGuardrails).slice(0, 6)),
    unknowns,
    whatStillNeedsSamantha: [
      "Approve any external framing before outreach is used.",
      "Confirm the strongest angle for this account before sending anything.",
    ],
    recommendedNextStep: unknowns.length
      ? `Gather ${unknowns[0]} before using this account snapshot externally.`
      : "Review the account summary and decide whether an outreach packet should be drafted.",
    packetSummary: compactText(
      `${context.account.name} snapshot with ${context.interactions.length} interaction${context.interactions.length === 1 ? "" : "s"} and approved positioning blocks.`,
      200
    ),
    generatedBy: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Sales Snapshot Service",
    },
    metadata: {
      interactionSummary,
      linkedUserId: context.account.linkedUserId ? String(context.account.linkedUserId) : "",
    },
  });

  await createApprovalTask({ packet, account: context.account, actor });
  return packet.toObject();
}

async function ensureAccountSnapshotPacket({ accountId, actor = {} } = {}) {
  const existing = await SalesDraftPacket.findOne({
    accountId,
    packetType: "account_snapshot",
  })
    .sort({ packetVersion: -1, createdAt: -1 })
    .lean();
  if (existing) {
    const account = await SalesAccount.findById(accountId).lean();
    if (account) {
      await createApprovalTask({ packet: existing, account, actor });
    }
    return existing;
  }

  return generateAccountSnapshotPacket({ accountId, actor });
}

module.exports = {
  ensureAccountSnapshotPacket,
  generateAccountSnapshotPacket,
};
