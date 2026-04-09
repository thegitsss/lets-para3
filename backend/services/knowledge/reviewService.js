const ApprovalTask = require("../../models/ApprovalTask");
const KnowledgeItem = require("../../models/KnowledgeItem");
const KnowledgeRevision = require("../../models/KnowledgeRevision");
const { publishApprovalDecisionEvent } = require("../approvals/eventService");

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "user",
    userId: actor.userId || null,
    label: actor.label || "Admin",
  };
}

async function listKnowledgeApprovalTasks() {
  return ApprovalTask.find({
    taskType: "knowledge_review",
    approvalState: "pending",
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
}

async function approveKnowledgeRevision({ revisionId, actor, note = "" } = {}) {
  const revision = await KnowledgeRevision.findById(revisionId);
  if (!revision) {
    throw new Error("Knowledge revision not found.");
  }

  const item = await KnowledgeItem.findById(revision.knowledgeItemId);
  if (!item) {
    throw new Error("Knowledge item not found.");
  }

  revision.approvalState = "approved";
  revision.approvedBy = toActor(actor);
  revision.approvedAt = new Date();
  revision.rejectionNote = "";
  revision.rejectedAt = null;
  await revision.save();

  item.approvalState = "approved";
  item.currentRevisionId = revision._id;
  item.currentApprovedRevisionId = revision._id;
  item.lastReviewedAt = new Date();
  item.nextReviewAt = new Date(Date.now() + Math.max(1, Number(item.freshnessDays || 90)) * 24 * 60 * 60 * 1000);
  await item.save();

  const pendingTask = await ApprovalTask.findOne({
    taskType: "knowledge_review",
    targetType: "knowledge_revision",
    targetId: String(revision._id),
    approvalState: "pending",
  }).lean();

  await ApprovalTask.updateMany(
    {
      taskType: "knowledge_review",
      targetType: "knowledge_revision",
      targetId: String(revision._id),
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
    approvalRecordId: pendingTask?._id || String(revision._id),
    approvalTargetType: "knowledge_revision",
    approvalTargetId: String(revision._id),
    title: `Knowledge review approved: ${item.title}`,
    summary: note || `Knowledge revision approved for ${item.title}.`,
    actor,
    related: {
      approvalTaskId: pendingTask?._id || null,
      knowledgeItemId: item._id,
      knowledgeRevisionId: revision._id,
    },
    service: "knowledge",
    sourceSurface: "admin",
    route: `/api/admin/knowledge/revisions/${revision._id}/approve`,
    correlationId: `knowledge:${item._id}`,
    founderVisible: true,
    publicFacing: (item.audienceScopes || []).includes("public_approved"),
    priority: (item.audienceScopes || []).includes("public_approved") ? "high" : "normal",
  });

  return { item, revision };
}

async function rejectKnowledgeRevision({ revisionId, actor, note = "" } = {}) {
  const revision = await KnowledgeRevision.findById(revisionId);
  if (!revision) {
    throw new Error("Knowledge revision not found.");
  }

  const item = await KnowledgeItem.findById(revision.knowledgeItemId);
  if (!item) {
    throw new Error("Knowledge item not found.");
  }

  revision.approvalState = "rejected";
  revision.rejectedAt = new Date();
  revision.rejectionNote = note || "Rejected.";
  await revision.save();

  item.approvalState = item.currentApprovedRevisionId ? "approved" : "rejected";
  if (item.currentApprovedRevisionId) {
    item.currentRevisionId = item.currentApprovedRevisionId;
  }
  await item.save();

  const pendingTask = await ApprovalTask.findOne({
    taskType: "knowledge_review",
    targetType: "knowledge_revision",
    targetId: String(revision._id),
    approvalState: "pending",
  }).lean();

  await ApprovalTask.updateMany(
    {
      taskType: "knowledge_review",
      targetType: "knowledge_revision",
      targetId: String(revision._id),
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
    approvalRecordId: pendingTask?._id || String(revision._id),
    approvalTargetType: "knowledge_revision",
    approvalTargetId: String(revision._id),
    title: `Knowledge review rejected: ${item.title}`,
    summary: note || `Knowledge revision rejected for ${item.title}.`,
    actor,
    related: {
      approvalTaskId: pendingTask?._id || null,
      knowledgeItemId: item._id,
      knowledgeRevisionId: revision._id,
    },
    service: "knowledge",
    sourceSurface: "admin",
    route: `/api/admin/knowledge/revisions/${revision._id}/reject`,
    correlationId: `knowledge:${item._id}`,
    founderVisible: true,
    publicFacing: (item.audienceScopes || []).includes("public_approved"),
    priority: "normal",
  });

  return { item, revision };
}

module.exports = {
  approveKnowledgeRevision,
  listKnowledgeApprovalTasks,
  rejectKnowledgeRevision,
};
