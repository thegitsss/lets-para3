const ApprovalTask = require("../../models/ApprovalTask");
const MarketingBrief = require("../../models/MarketingBrief");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const MarketingPublishAttempt = require("../../models/MarketingPublishAttempt");
const { publishApprovalDecisionEvent } = require("../approvals/eventService");
const { createLogger } = require("../../utils/logger");
const { recordPacketOutcomeEvaluation } = require("./evaluationService");

const logger = createLogger("marketing:review");

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "user",
    userId: actor.userId || null,
    label: actor.label || "Admin",
  };
}

function normalizeMongoConnectionState(connection = {}) {
  const readyStateMap = {
    0: "disconnected",
    1: "connected",
    2: "connecting",
    3: "disconnecting",
  };
  return {
    readyState: Number(connection?.readyState ?? 0),
    state: readyStateMap[Number(connection?.readyState ?? 0)] || "unknown",
    host: connection?.host || "",
    name: connection?.name || "",
  };
}

function classifyMongoDiagnostics(error = {}) {
  const message = String(error?.message || "");
  const mongoReadyState = Number(require("mongoose").connection?.readyState ?? 0);
  if (!process.env.MONGO_URI && mongoReadyState !== 1) return "env_missing";
  if (/timed out/i.test(message) || /buffering timed out/i.test(message)) return "query_timeout";
  if (/ECONNREFUSED|ENOTFOUND|querySrv/i.test(message)) return "network";
  if (/auth/i.test(message)) return "auth";
  if (/topology was destroyed|not connected|disconnected/i.test(message)) return "connection";
  return "unknown";
}

function logMarketingDiagnosticsFailure(step = "", error = null, extra = {}) {
  logger.error(`Marketing diagnostics failure during ${step}.`, {
    step,
    reason: classifyMongoDiagnostics(error),
    mongoUriConfigured: Boolean(process.env.MONGO_URI),
    mongo: normalizeMongoConnectionState(require("mongoose").connection),
    error: error
      ? {
          name: error.name || "Error",
          message: error.message || String(error),
        }
      : null,
    ...extra,
  });
}

async function countDocumentsWithDiagnostics(Model, filter, label) {
  try {
    return await Model.countDocuments(filter);
  } catch (error) {
    logMarketingDiagnosticsFailure(`${label}.countDocuments`, error, {
      model: Model?.modelName || label,
      filter,
    });
    throw error;
  }
}

async function listMarketingApprovalTasks() {
  return ApprovalTask.find({
    taskType: "marketing_review",
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
}

async function approveMarketingPacket({ packetId, actor, note = "" } = {}) {
  const packet = await MarketingDraftPacket.findById(packetId);
  if (!packet) {
    throw new Error("Marketing draft packet not found.");
  }

  const pendingTask = await ApprovalTask.findOne({
    taskType: "marketing_review",
    targetType: "marketing_draft_packet",
    targetId: String(packet._id),
    approvalState: "pending",
  }).lean();

  packet.approvalState = "approved";
  await packet.save();

  await MarketingBrief.updateOne({ _id: packet.briefId }, { $set: { approvalState: "in_queue" } });
  const brief = await MarketingBrief.findById(packet.briefId).lean();

  await ApprovalTask.updateMany(
    {
      taskType: "marketing_review",
      targetType: "marketing_draft_packet",
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
    approvalTargetType: "marketing_draft_packet",
    approvalTargetId: String(packet._id),
    title: `Marketing packet approved: ${packet.workflowType || "draft packet"}`,
    summary: note || packet.packetSummary || "Marketing packet approved.",
    actor,
    related: {
      approvalTaskId: pendingTask?._id || null,
      marketingBriefId: packet.briefId || null,
      marketingDraftPacketId: packet._id,
    },
    service: "marketing",
    sourceSurface: "admin",
    route: `/api/admin/marketing/draft-packets/${packet._id}/approve`,
    correlationId: `marketing:${packet.briefId || packet._id}`,
    founderVisible: true,
    publicFacing: true,
    priority: "normal",
  });

  await recordPacketOutcomeEvaluation({
    packet: packet.toObject ? packet.toObject() : packet,
    brief,
    decision: "approved",
    note,
    actor,
    decidedAt: new Date(),
  });

  return packet;
}

async function rejectMarketingPacket({ packetId, actor, note = "" } = {}) {
  const packet = await MarketingDraftPacket.findById(packetId);
  if (!packet) {
    throw new Error("Marketing draft packet not found.");
  }

  const pendingTask = await ApprovalTask.findOne({
    taskType: "marketing_review",
    targetType: "marketing_draft_packet",
    targetId: String(packet._id),
    approvalState: "pending",
  }).lean();

  packet.approvalState = "rejected";
  await packet.save();
  const brief = await MarketingBrief.findById(packet.briefId).lean();

  await ApprovalTask.updateMany(
    {
      taskType: "marketing_review",
      targetType: "marketing_draft_packet",
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
    approvalTargetType: "marketing_draft_packet",
    approvalTargetId: String(packet._id),
    title: `Marketing packet rejected: ${packet.workflowType || "draft packet"}`,
    summary: note || packet.packetSummary || "Marketing packet rejected.",
    actor,
    related: {
      approvalTaskId: pendingTask?._id || null,
      marketingBriefId: packet.briefId || null,
      marketingDraftPacketId: packet._id,
    },
    service: "marketing",
    sourceSurface: "admin",
    route: `/api/admin/marketing/draft-packets/${packet._id}/reject`,
    correlationId: `marketing:${packet.briefId || packet._id}`,
    founderVisible: true,
    publicFacing: true,
    priority: "normal",
  });

  await recordPacketOutcomeEvaluation({
    packet: packet.toObject ? packet.toObject() : packet,
    brief,
    decision: "rejected",
    note,
    actor,
    decidedAt: new Date(),
  });

  return packet;
}

async function getMarketingOverview() {
  const [briefsCount, packetsCount, pendingReviewCount, approvedCount, latestPackets] = await Promise.all([
    countDocumentsWithDiagnostics(MarketingBrief, {}, "marketing_briefs"),
    countDocumentsWithDiagnostics(MarketingDraftPacket, {}, "marketing_draft_packets"),
    countDocumentsWithDiagnostics(
      MarketingDraftPacket,
      { approvalState: "pending_review" },
      "marketing_draft_packets.pending_review"
    ),
    countDocumentsWithDiagnostics(
      MarketingDraftPacket,
      { approvalState: "approved" },
      "marketing_draft_packets.approved"
    ),
    MarketingDraftPacket.find({})
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(8)
      .lean(),
  ]);

  return {
    counts: {
      briefs: briefsCount,
      packets: packetsCount,
      pendingReview: pendingReviewCount,
      approved: approvedCount,
    },
    latestPackets: latestPackets.map((packet) => ({
      id: String(packet._id),
      briefId: String(packet.briefId),
      workflowType: packet.workflowType,
      channelKey: packet.channelKey || "",
      packetVersion: packet.packetVersion,
      approvalState: packet.approvalState,
      targetAudience: packet.targetAudience,
      contentLane: packet.contentLane || "",
      growthObjective: packet.growthObjective || "",
      whyThisHelpsPageGrowth: packet.whyThisHelpsPageGrowth || "",
      packetSummary: packet.packetSummary,
      updatedAt: packet.updatedAt,
      channel: packet.channelDraft?.channel || "",
    })),
  };
}

async function getMarketingDiagnostics() {
  const mongoose = require("mongoose");
  const mongo = normalizeMongoConnectionState(mongoose.connection);
  const diagnostics = {
    mongo,
    counts: {
      marketingBriefs: null,
      pendingReview: null,
    },
    cmoStatus: null,
    latestBriefAt: null,
    latestSuccessfulAgentRunAt: null,
  };

  if (!process.env.MONGO_URI && mongo.readyState !== 1) {
    logMarketingDiagnosticsFailure("marketing_diagnostics.bootstrap", new Error("MONGO_URI is not configured."));
    return diagnostics;
  }

  if (mongo.readyState !== 1) {
    logger.warn("Marketing diagnostics requested while Mongo is not connected.", {
      mongoUriConfigured: true,
      mongo,
    });
  }

  try {
    const [briefsCount, packetsCount, pendingReviewCount, latestBrief, latestSuccessfulAttempt] = await Promise.all([
      countDocumentsWithDiagnostics(MarketingBrief, {}, "marketing_briefs"),
      countDocumentsWithDiagnostics(MarketingDraftPacket, {}, "marketing_draft_packets"),
      countDocumentsWithDiagnostics(
        MarketingDraftPacket,
        { approvalState: "pending_review" },
        "marketing_draft_packets.pending_review"
      ),
      MarketingBrief.findOne({})
        .sort({ createdAt: -1, updatedAt: -1 })
        .select("createdAt updatedAt")
        .lean(),
      MarketingPublishAttempt.findOne({ status: "succeeded", completedAt: { $ne: null } })
        .sort({ completedAt: -1, createdAt: -1 })
        .select("completedAt")
        .lean(),
    ]);

    diagnostics.counts.marketingBriefs = briefsCount;
    diagnostics.counts.pendingReview = pendingReviewCount;
    diagnostics.cmoStatus = pendingReviewCount ? "Needs Review" : packetsCount ? "Active" : "Healthy";
    diagnostics.latestBriefAt = latestBrief?.createdAt || latestBrief?.updatedAt || null;
    diagnostics.latestSuccessfulAgentRunAt = latestSuccessfulAttempt?.completedAt || null;
    return diagnostics;
  } catch (error) {
    logMarketingDiagnosticsFailure("marketing_diagnostics.query", error);
    throw error;
  }
}

async function getMarketingControlRoomView() {
  const overview = await getMarketingOverview();
  const pendingItems = overview.latestPackets.filter((packet) => packet.approvalState === "pending_review");

  return {
    generatedAt: new Date().toISOString(),
    card: {
      key: "marketing",
      title: "Marketing / CMO",
      description: "Founder-grade draft packet workflow for approved messaging and platform updates.",
      status: overview.counts.pendingReview ? "Needs Review" : overview.counts.packets ? "Active" : "Healthy",
      tone: overview.counts.pendingReview ? "needs-review" : overview.counts.packets ? "active" : "healthy",
      queues: [
        { label: "Pending review", value: overview.counts.pendingReview },
        { label: "Draft packets", value: overview.counts.packets },
      ],
      recommendation: overview.counts.pendingReview
        ? "Review the newest founder-facing marketing packets before drafting more."
        : "No marketing packets are currently awaiting Samantha review.",
      actionLabel: "Open Marketing View",
      meta: "Approval-first. LinkedIn company publish exists only for approved packets with a configured connection.",
    },
    focusView: {
      title: "Marketing / CMO",
      status: overview.counts.pendingReview ? "Needs Review" : overview.counts.packets ? "Active" : "Healthy",
      tone: overview.counts.pendingReview ? "needs-review" : overview.counts.packets ? "active" : "healthy",
      queueLabel: `${overview.counts.pendingReview} pending review`,
      primary: {
        title: "Recommended Focus",
        body: overview.counts.pendingReview
          ? "Review the newest marketing draft packets awaiting Samantha review and confirm the claim set before any external use."
          : "No marketing draft packets are currently awaiting Samantha review.",
      },
      secondary: {
        title: "Visible Facts",
        items: [
          `${overview.counts.briefs} briefs have been created in the governed marketing workspace.`,
          `${overview.counts.packets} draft packets exist.`,
          `${overview.counts.approved} packets have been approved internally, but LinkedIn company publish still requires explicit operator action.`,
        ],
      },
      tertiary: {
        title: "Pending Drafts",
        items: pendingItems.length
          ? pendingItems.map((packet) => `${packet.workflowType}: ${packet.packetSummary}`)
          : ["No marketing packets are currently awaiting Samantha review."],
      },
      quaternary: {
        title: "Workflow Guardrails",
        items: [
          "Draft-only and approval-based.",
          "LinkedIn company publish exists only for approved packets with an active configured connection.",
          "Facebook Page, founder LinkedIn, and platform update drafts remain non-publishing workflows here.",
        ],
      },
    },
    latestPackets: overview.latestPackets,
  };
}

module.exports = {
  approveMarketingPacket,
  getMarketingDiagnostics,
  getMarketingControlRoomView,
  getMarketingOverview,
  listMarketingApprovalTasks,
  rejectMarketingPacket,
};
