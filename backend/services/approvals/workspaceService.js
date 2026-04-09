const ApprovalTask = require("../../models/ApprovalTask");
const FAQCandidate = require("../../models/FAQCandidate");
const KnowledgeItem = require("../../models/KnowledgeItem");
const KnowledgeRevision = require("../../models/KnowledgeRevision");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const SalesAccount = require("../../models/SalesAccount");
const SalesDraftPacket = require("../../models/SalesDraftPacket");
const { approveKnowledgeRevision, rejectKnowledgeRevision } = require("../knowledge/reviewService");
const { approveMarketingPacket, rejectMarketingPacket } = require("../marketing/reviewService");
const { approveFAQCandidate, rejectFAQCandidate } = require("../support/reviewService");
const { approveSalesPacket, rejectSalesPacket } = require("../sales/reviewService");

function uniqueList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function compactText(value = "", max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function sentenceCase(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildWorkKey(task = {}) {
  return `${task.targetType}:${task.targetId}`;
}

function inferRiskLevel({ pillar = "", target = {} } = {}) {
  if (pillar === "knowledge") {
    return (target.audienceScopes || []).includes("public_approved") ? "medium" : "low";
  }
  if (pillar === "marketing") {
    return "medium";
  }
  if (pillar === "support") {
    return Number(target.repeatCount || 0) >= 3 ? "medium" : "low";
  }
  if (pillar === "sales") {
    if ((target.riskFlags || []).length) return "medium";
    return target.packetType === "account_snapshot" ? "low" : "medium";
  }
  return "low";
}

function normalizeKnowledge(task, revision, item) {
  const audienceScopes = item?.audienceScopes || [];
  return {
    workKey: buildWorkKey(task),
    itemType: "knowledge_revision",
    sourcePillar: "knowledge",
    currentStatus: task.approvalState || revision?.approvalState || "pending",
    title: item?.title || task.title || "Knowledge revision",
    subtitle: compactText(revision?.content?.summary || revision?.content?.statement || task.summary || "", 180),
    audienceScopes,
    riskLevel: inferRiskLevel({ pillar: "knowledge", target: item || {} }),
    createdBy: revision?.createdBy?.label || task.requestedBy?.label || "System",
    ownerLabel: task.assignedOwnerLabel || item?.ownerLabel || "Samantha",
    citations: revision?.citations || [],
    whatStillNeedsSamantha: [
      "Approve or reject the proposed revision before it becomes the active approved record.",
    ],
    actionable: { approve: true, reject: true, requestChanges: false },
    summary: revision?.changeSummary || task.summary || "",
    detail: {
      domain: item?.domain || "",
      recordType: item?.recordType || "",
      revisionNumber: revision?.revisionNumber || null,
      content: revision?.content || {},
    },
  };
}

function normalizeMarketing(task, packet) {
  return {
    workKey: buildWorkKey(task),
    itemType: "marketing_draft_packet",
    sourcePillar: "marketing",
    currentStatus: task.approvalState || packet?.approvalState || "pending",
    title: packet?.workflowType ? sentenceCase(packet.workflowType) : task.title || "Marketing packet",
    subtitle: compactText(packet?.packetSummary || task.summary || "", 180),
    audienceScopes: ["marketing_safe", "public_approved"],
    riskLevel: inferRiskLevel({ pillar: "marketing", target: packet || {} }),
    createdBy: packet?.generatedBy?.label || task.requestedBy?.label || "Marketing Draft Service",
    ownerLabel: task.assignedOwnerLabel || "Samantha",
    citations: packet?.citations || [],
    whatStillNeedsSamantha:
      packet?.whatStillNeedsSamantha?.length
        ? packet.whatStillNeedsSamantha
        : ["Approve or reject the draft before any external use."],
    actionable: { approve: true, reject: true, requestChanges: false },
    summary: packet?.briefSummary || task.summary || "",
    detail: {
      workflowType: packet?.workflowType || "",
      targetAudience: packet?.targetAudience || "",
      messageHierarchy: packet?.messageHierarchy || [],
      claimsToAvoid: packet?.claimsToAvoid || [],
      channelDraft: packet?.channelDraft || {},
    },
  };
}

function normalizeSupport(task, candidate) {
  return {
    workKey: buildWorkKey(task),
    itemType: "faq_candidate",
    sourcePillar: "support",
    currentStatus: task.approvalState || candidate?.approvalState || "pending",
    title: candidate?.title || task.title || "FAQ candidate",
    subtitle: compactText(candidate?.summary || candidate?.question || task.summary || "", 180),
    audienceScopes: candidate?.audienceScopes || ["support_safe", "public_approved"],
    riskLevel: inferRiskLevel({ pillar: "support", target: candidate || {} }),
    createdBy: task.requestedBy?.label || "FAQ Candidate Service",
    ownerLabel: task.assignedOwnerLabel || candidate?.ownerLabel || "Samantha",
    citations: candidate?.citations || [],
    whatStillNeedsSamantha: [
      "Approve or reject this FAQ candidate before it is treated as governed support/public language.",
    ],
    actionable: { approve: true, reject: true, requestChanges: false },
    summary: candidate?.draftAnswer || task.summary || "",
    detail: {
      category: candidate?.category || "",
      question: candidate?.question || "",
      draftAnswer: candidate?.draftAnswer || "",
      repeatCount: candidate?.repeatCount || 0,
    },
  };
}

function normalizeSales(task, packet, account) {
  return {
    workKey: buildWorkKey(task),
    itemType: "sales_draft_packet",
    sourcePillar: "sales",
    currentStatus: task.approvalState || packet?.approvalState || "pending",
    title: packet?.packetType ? sentenceCase(packet.packetType) : task.title || "Sales packet",
    subtitle: compactText(packet?.packetSummary || task.summary || "", 180),
    audienceScopes: ["sales_safe"],
    riskLevel: inferRiskLevel({ pillar: "sales", target: packet || {} }),
    createdBy: packet?.generatedBy?.label || task.requestedBy?.label || "Sales Draft Service",
    ownerLabel: task.assignedOwnerLabel || "Samantha",
    citations: packet?.citations || [],
    whatStillNeedsSamantha:
      packet?.whatStillNeedsSamantha?.length
        ? packet.whatStillNeedsSamantha
        : ["Approve or reject the packet before any external use."],
    actionable: { approve: true, reject: true, requestChanges: false },
    summary: packet?.accountSummary || task.summary || "",
    detail: {
      packetType: packet?.packetType || "",
      accountName: account?.name || "",
      accountSummary: packet?.accountSummary || "",
      audienceSummary: packet?.audienceSummary || "",
      approvedPositioningBlocks: packet?.approvedPositioningBlocks || [],
      riskFlags: packet?.riskFlags || [],
      unknowns: packet?.unknowns || [],
      recommendedNextStep: packet?.recommendedNextStep || "",
      channelDraft: packet?.channelDraft || {},
    },
  };
}

async function hydrateApprovalTask(task = {}) {
  if (task.targetType === "knowledge_revision") {
    const revision = await KnowledgeRevision.findById(task.targetId).lean();
    const item = revision?.knowledgeItemId ? await KnowledgeItem.findById(revision.knowledgeItemId).lean() : null;
    return normalizeKnowledge(task, revision, item);
  }
  if (task.targetType === "marketing_draft_packet") {
    const packet = await MarketingDraftPacket.findById(task.targetId).lean();
    return normalizeMarketing(task, packet);
  }
  if (task.targetType === "faq_candidate") {
    const candidate = await FAQCandidate.findById(task.targetId).lean();
    return normalizeSupport(task, candidate);
  }
  if (task.targetType === "sales_draft_packet") {
    const packet = await SalesDraftPacket.findById(task.targetId).lean();
    const account = packet?.accountId ? await SalesAccount.findById(packet.accountId).lean() : null;
    return normalizeSales(task, packet, account);
  }
  return null;
}

async function listApprovalWorkspaceItems({ pillar = "", itemType = "", status = "" } = {}) {
  const query = {};
  if (status) query.approvalState = status;
  const tasks = await ApprovalTask.find(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  const hydrated = (await Promise.all(tasks.map((task) => hydrateApprovalTask(task)))).filter(Boolean);
  return hydrated.filter((item) => {
    if (pillar && item.sourcePillar !== pillar) return false;
    if (itemType && item.itemType !== itemType) return false;
    return true;
  });
}

async function getApprovalWorkspaceOverview() {
  const items = await listApprovalWorkspaceItems({});
  const countsByPillar = items.reduce((acc, item) => {
    acc[item.sourcePillar] = (acc[item.sourcePillar] || 0) + 1;
    return acc;
  }, {});
  const countsByStatus = items.reduce((acc, item) => {
    acc[item.currentStatus] = (acc[item.currentStatus] || 0) + 1;
    return acc;
  }, {});
  return {
    counts: {
      total: items.length,
      pending: countsByStatus.pending || 0,
      approved: countsByStatus.approved || 0,
      rejected: countsByStatus.rejected || 0,
      knowledge: countsByPillar.knowledge || 0,
      marketing: countsByPillar.marketing || 0,
      support: countsByPillar.support || 0,
      sales: countsByPillar.sales || 0,
    },
    latestItems: items.slice(0, 12),
  };
}

async function getApprovalWorkspaceItem(workKey = "") {
  const [targetType, ...rest] = String(workKey || "").split(":");
  const targetId = rest.join(":");
  if (!targetType || !targetId) {
    throw new Error("Approval workspace item not found.");
  }
  const task = await ApprovalTask.findOne({ targetType, targetId }).sort({ updatedAt: -1, createdAt: -1 }).lean();
  if (!task) {
    throw new Error("Approval workspace item not found.");
  }
  const item = await hydrateApprovalTask(task);
  if (!item) {
    throw new Error("Approval workspace item not found.");
  }
  return item;
}

async function decideApprovalWorkspaceItem({ workKey = "", action = "", actor = {}, note = "" } = {}) {
  const [targetType, ...rest] = String(workKey || "").split(":");
  const targetId = rest.join(":");
  if (!targetType || !targetId) {
    throw new Error("Approval workspace item not found.");
  }

  if (targetType === "knowledge_revision") {
    if (action === "approve") return approveKnowledgeRevision({ revisionId: targetId, actor, note });
    if (action === "reject") return rejectKnowledgeRevision({ revisionId: targetId, actor, note });
  }
  if (targetType === "marketing_draft_packet") {
    if (action === "approve") return approveMarketingPacket({ packetId: targetId, actor, note });
    if (action === "reject") return rejectMarketingPacket({ packetId: targetId, actor, note });
  }
  if (targetType === "faq_candidate") {
    if (action === "approve") return approveFAQCandidate({ candidateId: targetId, actor, note });
    if (action === "reject") return rejectFAQCandidate({ candidateId: targetId, actor, note });
  }
  if (targetType === "sales_draft_packet") {
    if (action === "approve") return approveSalesPacket({ packetId: targetId, actor, note });
    if (action === "reject") return rejectSalesPacket({ packetId: targetId, actor, note });
  }

  throw new Error("This approval item is read-only in this phase.");
}

module.exports = {
  decideApprovalWorkspaceItem,
  getApprovalWorkspaceItem,
  getApprovalWorkspaceOverview,
  listApprovalWorkspaceItems,
};
