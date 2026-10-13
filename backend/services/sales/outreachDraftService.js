const ApprovalTask = require("../../models/ApprovalTask");
const SalesDraftPacket = require("../../models/SalesDraftPacket");
const { buildSalesContext } = require("./contextService");
const { collectCitations, compactText, flattenClaims, summarizeBlocks, uniqueList } = require("./shared");
const { publishEventSafe } = require("../lpcEvents/publishEventService");

function founderVoiceNotes(cards = []) {
  return uniqueList(cards.flatMap((card) => card.rules || [])).slice(0, 5);
}

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
      label: actor.label || "Sales Outreach Service",
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

async function generateOutreachDraftPacket({ accountId, actor = {}, outreachGoal = "" } = {}) {
  const context = await buildSalesContext(accountId);
  const latest = await SalesDraftPacket.findOne({ accountId, packetType: "outreach_draft" })
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
  const notes = founderVoiceNotes(context.founderVoiceCards);
  const interactionHints = context.interactions.slice(0, 3).map((interaction) => interaction.summary);
  const riskFlags = uniqueList([
    ...flattenClaims(context.claimGuardrails),
    ...flattenClaims(context.founderVoiceCards),
  ]).slice(0, 8);
  const unknowns = [];
  if (!context.account.primaryEmail) unknowns.push("Best outreach destination");
  if (!context.interactions.length) unknowns.push("Account-specific context beyond the initial record");

  const goal = String(outreachGoal || "").trim() || "Introduce LPC through fit, standards, and practical workflow value.";
  const opening = context.positioningCards[0]?.statement || context.positioningCards[0]?.summary || "";
  const differentiator = context.distinctivenessCards[0]?.statement || context.distinctivenessCards[0]?.summary || "";
  const value = context.valueCards[0]?.statement || context.valueCards[0]?.summary || "";

  const packet = await SalesDraftPacket.create({
    accountId,
    packetType: "outreach_draft",
    packetVersion,
    approvalState: "pending_review",
    accountSummary: compactText(context.account.accountSummary || context.account.notes || context.account.name, 1200),
    audienceSummary: compactText(goal, 1200),
    approvedPositioningBlocks: blocks,
    citations,
    riskFlags,
    unknowns,
    whatStillNeedsSamantha: [
      "Approve the final outreach framing before sending anything.",
      "Confirm the CTA and whether this account should receive outbound contact now.",
    ],
    recommendedNextStep: unknowns.length
      ? `Fill the remaining unknowns before approving outreach for ${context.account.name}.`
      : `Review and approve the outreach draft before any external use for ${context.account.name}.`,
    channelDraft: {
      channel: "email",
      subject: compactText(`LPC fit for ${context.account.name}`, 120),
      body: uniqueList([opening, differentiator, value, ...interactionHints]).filter(Boolean).join("\n\n"),
      founderVoiceNotes: notes,
    },
    packetSummary: compactText(
      `Outreach draft for ${context.account.name} using approved positioning and distinctiveness language.`,
      220
    ),
    generatedBy: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Sales Outreach Service",
    },
    metadata: {
      outreachGoal: goal,
    },
  });

  await createApprovalTask({ packet, account: context.account, actor });
  return packet.toObject();
}

async function generateProspectAnswerPacket({ accountId, actor = {}, incomingQuestion = "" } = {}) {
  const context = await buildSalesContext(accountId);
  const latest = await SalesDraftPacket.findOne({ accountId, packetType: "prospect_answer" })
    .sort({ packetVersion: -1 })
    .select("packetVersion")
    .lean();
  const packetVersion = Number(latest?.packetVersion || 0) + 1;
  const blocks = summarizeBlocks(
    [
      ...context.factCards,
      ...context.positioningCards,
      ...context.distinctivenessCards,
      ...context.valueCards,
      ...context.objectionCards,
    ],
    6
  );
  const citations = collectCitations([
    ...context.factCards,
    ...context.positioningCards,
    ...context.distinctivenessCards,
    ...context.valueCards,
    ...context.objectionCards,
  ]);

  const question = String(incomingQuestion || "").trim();
  const unknowns = [];
  if (!question) unknowns.push("Prospect question text");
  const answerLines = uniqueList([
    question ? `Prospect question: ${question}` : "",
    context.factCards[0]?.statement || context.factCards[0]?.summary || "",
    context.distinctivenessCards[0]?.statement || context.distinctivenessCards[0]?.summary || "",
    context.objectionCards[0]?.approvedResponse || context.objectionCards[0]?.summary || "",
  ]).filter(Boolean);

  const packet = await SalesDraftPacket.create({
    accountId,
    packetType: "prospect_answer",
    packetVersion,
    approvalState: "pending_review",
    accountSummary: compactText(context.account.accountSummary || context.account.name, 1200),
    audienceSummary: compactText(question || "Prospect answer packet drafted from approved knowledge.", 1200),
    approvedPositioningBlocks: blocks,
    citations,
    riskFlags: uniqueList(flattenClaims(context.claimGuardrails).slice(0, 8)),
    unknowns,
    whatStillNeedsSamantha: [
      "Approve the final answer framing before sending anything externally.",
      "Confirm whether any answer needs more account-specific context first.",
    ],
    recommendedNextStep: question
      ? "Review the answer packet and approve only the portions that are fully supported by approved knowledge."
      : "Add the actual prospect question before external use.",
    channelDraft: {
      channel: "prospect_answer",
      body: answerLines.join("\n\n"),
    },
    packetSummary: compactText(`Prospect answer packet for ${context.account.name}.`, 220),
    generatedBy: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Sales Outreach Service",
    },
    metadata: {
      incomingQuestion: question,
    },
  });

  await createApprovalTask({ packet, account: context.account, actor });
  return packet.toObject();
}

async function listSalesDraftPackets({ limit = 50 } = {}) {
  return SalesDraftPacket.find({})
    .sort({ updatedAt: -1, createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
    .lean();
}

async function getSalesDraftPacketById(packetId) {
  return SalesDraftPacket.findById(packetId).lean();
}

module.exports = {
  generateOutreachDraftPacket,
  generateProspectAnswerPacket,
  getSalesDraftPacketById,
  listSalesDraftPackets,
};
