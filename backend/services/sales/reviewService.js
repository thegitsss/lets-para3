const ApprovalTask = require("../../models/ApprovalTask");
const SalesDraftPacket = require("../../models/SalesDraftPacket");
const { publishApprovalDecisionEvent } = require("../approvals/eventService");

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "user",
    userId: actor.userId || null,
    label: actor.label || "Admin",
  };
}

async function listSalesApprovalTasks() {
  return ApprovalTask.find({
    taskType: "sales_review",
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
}

async function approveSalesPacket({ packetId, actor, note = "" } = {}) {
  const packet = await SalesDraftPacket.findById(packetId);
  if (!packet) {
    throw new Error("Sales draft packet not found.");
  }

  const pendingTask = await ApprovalTask.findOne({
    taskType: "sales_review",
    targetType: "sales_draft_packet",
    targetId: String(packet._id),
    approvalState: "pending",
  }).lean();

  packet.approvalState = "approved";
  await packet.save();

  await ApprovalTask.updateMany(
    {
      taskType: "sales_review",
      targetType: "sales_draft_packet",
      targetId: String(packet._id),
      approvalState: "pending",
    },
    {
      $set: {
        approvalState: "approved",
        decidedBy: toActor(actor),
        decidedAt: new Date(),
        decisionNote: note || "Approved.",
      },
    }
  );

  await publishApprovalDecisionEvent({
    decision: "approved",
    approvalRecordType: "approval_task",
    approvalRecordId: pendingTask?._id || String(packet._id),
    approvalTargetType: "sales_draft_packet",
    approvalTargetId: String(packet._id),
    title: `Sales packet approved: ${packet.packetType || "draft packet"}`,
    summary: note || packet.packetSummary || "Sales packet approved.",
    actor,
    related: {
      approvalTaskId: pendingTask?._id || null,
      salesAccountId: packet.accountId || null,
      salesDraftPacketId: packet._id,
    },
    service: "sales",
    sourceSurface: "admin",
    route: `/api/admin/sales/draft-packets/${packet._id}/approve`,
    correlationId: `sales:${packet.accountId || packet._id}`,
    founderVisible: true,
    publicFacing: true,
    priority: "normal",
  });

  return packet;
}

async function rejectSalesPacket({ packetId, actor, note = "" } = {}) {
  const packet = await SalesDraftPacket.findById(packetId);
  if (!packet) {
    throw new Error("Sales draft packet not found.");
  }

  const pendingTask = await ApprovalTask.findOne({
    taskType: "sales_review",
    targetType: "sales_draft_packet",
    targetId: String(packet._id),
    approvalState: "pending",
  }).lean();

  packet.approvalState = "rejected";
  await packet.save();

  await ApprovalTask.updateMany(
    {
      taskType: "sales_review",
      targetType: "sales_draft_packet",
      targetId: String(packet._id),
      approvalState: "pending",
    },
    {
      $set: {
        approvalState: "rejected",
        decidedBy: toActor(actor),
        decidedAt: new Date(),
        decisionNote: note || "Rejected.",
      },
    }
  );

  await publishApprovalDecisionEvent({
    decision: "rejected",
    approvalRecordType: "approval_task",
    approvalRecordId: pendingTask?._id || String(packet._id),
    approvalTargetType: "sales_draft_packet",
    approvalTargetId: String(packet._id),
    title: `Sales packet rejected: ${packet.packetType || "draft packet"}`,
    summary: note || packet.packetSummary || "Sales packet rejected.",
    actor,
    related: {
      approvalTaskId: pendingTask?._id || null,
      salesAccountId: packet.accountId || null,
      salesDraftPacketId: packet._id,
    },
    service: "sales",
    sourceSurface: "admin",
    route: `/api/admin/sales/draft-packets/${packet._id}/reject`,
    correlationId: `sales:${packet.accountId || packet._id}`,
    founderVisible: true,
    publicFacing: true,
    priority: "normal",
  });

  return packet;
}

module.exports = {
  approveSalesPacket,
  listSalesApprovalTasks,
  rejectSalesPacket,
};
