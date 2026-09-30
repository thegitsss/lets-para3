const ApprovalTask = require("../../models/ApprovalTask");
const FAQCandidate = require("../../models/FAQCandidate");
const { publishApprovalDecisionEvent } = require("../approvals/eventService");
const { publishEventSafe } = require("../lpcEvents/publishEventService");

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "user",
    userId: actor.userId || null,
    label: actor.label || "Admin",
  };
}

async function ensureFAQCandidateApprovalTask(candidate = {}, actor = {}) {
  if (!candidate?._id) return null;
  const filter = {
    taskType: "support_review",
    targetType: "faq_candidate",
    targetId: String(candidate._id),
    approvalState: "pending",
  };
  let task = null, created = false;
  const session = await FAQCandidate.startSession();
  try {
    await session.withTransaction(async () => {
      task = null; created = false;
      const current = await FAQCandidate.findOne({ _id: candidate._id, approvalState: 'pending_review' }).session(session).lean();
      if (!current) return;
      task = await ApprovalTask.findOne(filter).session(session).lean();
      if (task) return;
      // Serialize competing generators and an owner decision on the same record.
      const claim = await FAQCandidate.updateOne({ _id: current._id, approvalState: 'pending_review' }, { $inc: { approvalTaskClaimVersion: 1 } }, { session, timestamps: false });
      if (claim.modifiedCount !== 1) return;
      [task] = await ApprovalTask.create([{
        taskType: "support_review",
        targetType: "faq_candidate",
        targetId: String(candidate._id),
        parentType: "FAQCandidate",
        parentId: String(candidate._id),
        title: `Review FAQ candidate: ${current.title}`,
        summary: current.summary || "A support FAQ candidate is awaiting Samantha review.",
        approvalState: "pending",
        requestedBy: toActor(actor),
        assignedOwnerLabel: current.ownerLabel || "Samantha",
        metadata: {
          category: current.category || "",
          repeatCount: Number(current.repeatCount || 0),
        },
      }], { session });
      created = true;
    });
  } finally { await session.endSession(); }
  if (!created) return task;

  await publishEventSafe({
    eventType: "approval.requested",
    eventFamily: "approval",
    idempotencyKey: `approval-task:${task._id}:requested`,
    correlationId: `approval-task:${task._id}`,
    actor: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "FAQ Candidate Service",
    },
    subject: {
      entityType: "approval_task",
      entityId: String(task._id),
    },
    related: {
      approvalTaskId: task._id,
    },
    source: {
      surface: "system",
      route: "",
      service: "support",
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
      founderVisible: String(task.assignedOwnerLabel || "").toLowerCase() === "samantha",
      approvalRequired: true,
      publicFacing: true,
    },
  });

  return task;
}

async function listSupportApprovalTasks() {
  return ApprovalTask.find({
    taskType: "support_review",
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
}

async function approveFAQCandidate({ candidateId, actor, note = "", session = null, afterCommit = null } = {}) {
  const candidate = await FAQCandidate.findById(candidateId).session(session);
  if (!candidate) {
    throw new Error("FAQ candidate not found.");
  }

  const pendingTask = await ApprovalTask.findOne({
    taskType: "support_review",
    targetType: "faq_candidate",
    targetId: String(candidate._id),
    approvalState: "pending",
  }).session(session).lean();

  candidate.approvalState = "approved";
  await candidate.save({ session });

  await ApprovalTask.updateMany(
    {
      taskType: "support_review",
      targetType: "faq_candidate",
      targetId: String(candidate._id),
      approvalState: "pending",
    },
    {
      $set: {
        approvalState: "approved",
        decidedBy: toActor(actor),
        decidedAt: new Date(),
        decisionNote: note || "Approved.",
      },
    },
    { session }
  );

  const publishDecision = async () => {
    await publishApprovalDecisionEvent({
      decision: "approved",
      approvalRecordType: "approval_task",
      approvalRecordId: pendingTask?._id || String(candidate._id),
      approvalTargetType: "faq_candidate",
      approvalTargetId: String(candidate._id),
      title: `FAQ candidate approved: ${candidate.title}`,
      summary: note || candidate.summary || "FAQ candidate approved.",
      actor,
      related: {
        approvalTaskId: pendingTask?._id || null,
      },
      service: "support",
      sourceSurface: "admin",
      route: `/api/admin/support/faq-candidates/${candidate._id}/approve`,
      correlationId: `support:${candidate._id}`,
      founderVisible: true,
      publicFacing: true,
      priority: "normal",
    });
  };
  if (afterCommit) afterCommit.push(publishDecision);
  else await publishDecision();

  return candidate;
}

async function rejectFAQCandidate({ candidateId, actor, note = "" } = {}) {
  const candidate = await FAQCandidate.findById(candidateId);
  if (!candidate) {
    throw new Error("FAQ candidate not found.");
  }

  const pendingTask = await ApprovalTask.findOne({
    taskType: "support_review",
    targetType: "faq_candidate",
    targetId: String(candidate._id),
    approvalState: "pending",
  }).lean();

  candidate.approvalState = "rejected";
  await candidate.save();

  await ApprovalTask.updateMany(
    {
      taskType: "support_review",
      targetType: "faq_candidate",
      targetId: String(candidate._id),
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
    approvalRecordId: pendingTask?._id || String(candidate._id),
    approvalTargetType: "faq_candidate",
    approvalTargetId: String(candidate._id),
    title: `FAQ candidate rejected: ${candidate.title}`,
    summary: note || candidate.summary || "FAQ candidate rejected.",
    actor,
    related: {
      approvalTaskId: pendingTask?._id || null,
    },
    service: "support",
    sourceSurface: "admin",
    route: `/api/admin/support/faq-candidates/${candidate._id}/reject`,
    correlationId: `support:${candidate._id}`,
    founderVisible: true,
    publicFacing: true,
    priority: "normal",
  });

  return candidate;
}

module.exports = {
  approveFAQCandidate,
  ensureFAQCandidateApprovalTask,
  listSupportApprovalTasks,
  rejectFAQCandidate,
};
