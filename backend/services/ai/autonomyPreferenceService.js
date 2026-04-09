const ApprovalTask = require("../../models/ApprovalTask");
const AutonomyPreference = require("../../models/AutonomyPreference");
const FAQCandidate = require("../../models/FAQCandidate");
const Incident = require("../../models/Incident");
const IncidentApproval = require("../../models/IncidentApproval");
const IncidentRelease = require("../../models/IncidentRelease");
const MarketingBrief = require("../../models/MarketingBrief");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const SalesDraftPacket = require("../../models/SalesDraftPacket");
const { approveFAQCandidate } = require("../support/reviewService");
const { approveMarketingPacket } = require("../marketing/reviewService");
const { approveSalesPacket } = require("../sales/reviewService");
const { decideIncidentApproval } = require("../incidents/releaseService");
const { logAction } = require("./autonomousActionService");
const { scoreConfidence } = require("./confidenceScorer");
const { createLogger } = require("../../utils/logger");

const logger = createLogger("ai:autonomy-preferences");

const AUTONOMY_ACTION_TYPES = Object.freeze({
  cco: "support_governed_content_approval",
  cmo: "marketing_publish",
  cso: "sales_outreach",
  cto: "incident_approval",
});

const MAX_AUTO_ACTIONS_PER_PASS = 10;
const MONEY_KEYWORDS = /\b(payment|payments|billing|bill|refund|refunded|charge|charged|invoice|invoicing|payout|payouts|escrow|stripe|dispute|disputed|legal|lawsuit|settlement|claim)\b/i;
const SENSITIVE_MARKETING_KEYWORDS = /\b(guarantee|guaranteed|lawsuit|settlement|regulated|confidential|refund|payout|payment)\b/i;
const SENSITIVE_SALES_KEYWORDS = /\b(guarantee|guaranteed|lawsuit|settlement|refund|payout|payment)\b/i;

function compactText(value = "", max = 320) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function normalizeRole(value = "") {
  return String(value || "").trim().toUpperCase();
}

function normalizeActionType(value = "") {
  return String(value || "").trim().toLowerCase();
}

function buildPreferenceKey(agentRole = "", actionType = "") {
  return `${normalizeRole(agentRole)}:${normalizeActionType(actionType)}`;
}

function buildAutoActor() {
  return {
    actorType: "agent",
    userId: null,
    label: "Founder Autonomy",
    role: "admin",
    email: "founder.autonomy@lets-paraconnect.local",
    decisionRole: "founder_approver",
  };
}

function buildDisqualifierFlags({ text = "", involvesMoney = false, legalOrDispute = false, billingPromise = false } = {}) {
  const keywordHit = MONEY_KEYWORDS.test(String(text || ""));
  return {
    involvesPayment: involvesMoney || keywordHit,
    involvesPayout: involvesMoney || keywordHit,
    involvesBillingPromise: billingPromise || /\b(refund|credit|compensat|waive|discount|promise)\b/i.test(String(text || "")),
    legalOrDisputeContext: legalOrDispute || /\b(dispute|legal|lawsuit|claim|settlement)\b/i.test(String(text || "")),
  };
}

function hasTriggeredDisqualifier(flags = {}) {
  return Object.values(flags || {}).some((value) => value === true);
}

function normalizeStreakWeight(value) {
  const numeric = Number(value) || 0;
  if (numeric >= 5) return 1;
  if (numeric <= 0) return 0;
  return numeric / 5;
}

function buildConfidenceReason(lines = [], disqualifiers = {}) {
  const active = lines.filter(Boolean);
  if (hasTriggeredDisqualifier(disqualifiers)) {
    const blocked = Object.entries(disqualifiers)
      .filter(([, value]) => value === true)
      .map(([key]) => key.replace(/([A-Z])/g, " $1").toLowerCase())
      .join(", ");
    return compactText(`Blocked from auto-handling because the item touched ${blocked}.`, 400);
  }
  return compactText(active.join(" "), 400);
}

async function countConsecutiveApprovalsForApprovalTask({ taskType = "", targetType = "" } = {}) {
  const decisions = await ApprovalTask.find({
    taskType,
    targetType,
    approvalState: { $in: ["approved", "rejected"] },
    decidedAt: { $ne: null },
  })
    .sort({ decidedAt: -1, _id: -1 })
    .select("approvalState decidedAt")
    .lean();

  let count = 0;
  for (const item of decisions) {
    if (item.approvalState !== "approved") break;
    count += 1;
  }
  return count;
}

async function countConsecutiveApprovalsForIncidentApprovals() {
  const decisions = await IncidentApproval.find({
    approvalType: "production_deploy",
    status: { $in: ["approved", "rejected"] },
    decidedAt: { $ne: null },
  })
    .sort({ decidedAt: -1, _id: -1 })
    .select("status decidedAt")
    .lean();

  let count = 0;
  for (const item of decisions) {
    if (item.status !== "approved") break;
    count += 1;
  }
  return count;
}

const AUTONOMY_DEFINITIONS = Object.freeze([
  {
    agentRole: "CCO",
    actionType: AUTONOMY_ACTION_TYPES.cco,
    autoActionType: "support_governed_content_auto_approved",
    laneKey: "cco",
    navSection: "support-ops",
    title: "Let Support use governed answers automatically",
    nounPhrase: "support answers",
    explanation: (count) =>
      `You've approved ${count} governed support ${count === 1 ? "answer" : "answers"} in a row.`,
    preview:
      "Future safe FAQ candidates like this will skip the founder queue and use the current support approval path automatically.",
    actionHelperText:
      "Enable Auto will auto-approve future safe governed support answers. Keep Reviewing will leave this category manual and stop this suggestion.",
    computeApprovalStreak: () =>
      countConsecutiveApprovalsForApprovalTask({ taskType: "support_review", targetType: "faq_candidate" }),
    async listPendingItems() {
      const tasks = await ApprovalTask.find({
        taskType: "support_review",
        targetType: "faq_candidate",
        approvalState: "pending",
      })
        .sort({ updatedAt: 1, createdAt: 1 })
        .lean();
      const ids = tasks.map((task) => task.targetId).filter(Boolean);
      const candidates = await FAQCandidate.find({ _id: { $in: ids }, approvalState: "pending_review" }).lean();
      const candidateMap = new Map(candidates.map((candidate) => [String(candidate._id), candidate]));
      return tasks
        .map((task) => {
          const candidate = candidateMap.get(String(task.targetId));
          return candidate ? { task, candidate } : null;
        })
        .filter(Boolean);
    },
    evaluate(item, preference) {
      const text = [item.candidate.title, item.candidate.summary, item.candidate.question, item.candidate.draftAnswer].join(" ");
      const disqualifiers = buildDisqualifierFlags({
        text,
        involvesMoney: false,
        legalOrDispute: false,
      });
      const factors = [
        { value: item.candidate.repeatCount >= 3, weight: 0.28 },
        {
          value:
            Array.isArray(item.candidate.audienceScopes) &&
            item.candidate.audienceScopes.includes("support_safe") &&
            item.candidate.audienceScopes.includes("public_approved"),
          weight: 0.26,
        },
        { value: !hasTriggeredDisqualifier(disqualifiers), weight: 0.26 },
        { value: normalizeStreakWeight(preference.learnedFromCount), weight: 0.2 },
        disqualifiers,
      ];
      const confidenceScore = scoreConfidence(factors);
      const confidenceReason = buildConfidenceReason(
        [
          "Support-safe audience scopes are already present.",
          item.candidate.repeatCount >= 3 ? "The same support pattern has repeated multiple times." : "",
          preference.learnedFromCount >= 3 ? `Founder approved ${preference.learnedFromCount} similar answers in a row.` : "",
          !hasTriggeredDisqualifier(disqualifiers) ? "No billing, payout, dispute, or legal language was detected." : "",
        ],
        disqualifiers
      );
      return { confidenceScore, confidenceReason, disqualifiers };
    },
    async execute(item, evaluation) {
      const candidateId = String(item.candidate._id);
      const previousTaskStates = await ApprovalTask.find({
        taskType: "support_review",
        targetType: "faq_candidate",
        targetId: candidateId,
        approvalState: "pending",
      })
        .select("_id approvalState decidedBy decidedAt decisionNote")
        .lean();
      const previousCandidate = {
        approvalState: item.candidate.approvalState,
      };

      try {
        await approveFAQCandidate({
          candidateId,
          actor: buildAutoActor(),
          note: "Auto-approved from a founder autonomy preference.",
        });
        const action = await logAction({
          agentRole: "CCO",
          actionType: "support_governed_content_auto_approved",
          confidenceScore: evaluation.confidenceScore,
          confidenceReason: evaluation.confidenceReason,
          targetModel: "FAQCandidate",
          targetId: candidateId,
          changedFields: { approvalState: "approved" },
          previousValues: { approvalState: previousCandidate.approvalState },
          actionTaken: `Support approved the governed answer "${compactText(item.candidate.title, 120)}" automatically after repeated matching founder approvals.`,
          safetyContext: evaluation.disqualifiers,
        });
        return action;
      } catch (error) {
        await FAQCandidate.updateOne({ _id: candidateId }, { $set: previousCandidate });
        for (const task of previousTaskStates) {
          await ApprovalTask.updateOne(
            { _id: task._id },
            {
              $set: {
                approvalState: task.approvalState,
                decidedBy: task.decidedBy || null,
                decidedAt: task.decidedAt || null,
                decisionNote: task.decisionNote || "",
              },
            }
          );
        }
        throw error;
      }
    },
  },
  {
    agentRole: "CMO",
    actionType: AUTONOMY_ACTION_TYPES.cmo,
    autoActionType: "marketing_publish_auto_approved",
    laneKey: "cmo",
    navSection: "marketing-drafts",
    title: "Let Marketing publish these automatically",
    nounPhrase: "marketing posts",
    explanation: (count) =>
      `You've approved ${count} LinkedIn company ${count === 1 ? "post" : "posts"} in a row.`,
    preview:
      "Future LinkedIn company posts that match this pattern will skip the founder queue and use the current marketing approval path automatically.",
    actionHelperText:
      "Enable Auto will auto-approve future LinkedIn posts that stay within the current safety checks. Keep Reviewing will leave this category manual and stop this suggestion.",
    computeApprovalStreak: () =>
      countConsecutiveApprovalsForApprovalTask({ taskType: "marketing_review", targetType: "marketing_draft_packet" }),
    async listPendingItems() {
      const tasks = await ApprovalTask.find({
        taskType: "marketing_review",
        targetType: "marketing_draft_packet",
        approvalState: "pending",
      })
        .sort({ updatedAt: 1, createdAt: 1 })
        .lean();
      const ids = tasks.map((task) => task.targetId).filter(Boolean);
      const packets = await MarketingDraftPacket.find({ _id: { $in: ids }, approvalState: "pending_review" }).lean();
      const packetMap = new Map(packets.map((packet) => [String(packet._id), packet]));
      return tasks
        .map((task) => {
          const packet = packetMap.get(String(task.targetId));
          return packet ? { task, packet } : null;
        })
        .filter(Boolean);
    },
    evaluate(item, preference) {
      const text = [
        item.packet.packetSummary,
        item.packet.briefSummary,
        item.packet.channelDraft?.headline,
        item.packet.channelDraft?.body,
        ...(item.packet.openQuestions || []),
      ].join(" ");
      const disqualifiers = buildDisqualifierFlags({
        text,
        legalOrDispute: SENSITIVE_MARKETING_KEYWORDS.test(text),
      });
      const factors = [
        { value: item.packet.workflowType === "linkedin_company_post", weight: 0.3 },
        { value: item.packet.channelKey === "linkedin_company", weight: 0.15 },
        { value: (item.packet.openQuestions || []).length === 0, weight: 0.2 },
        { value: !hasTriggeredDisqualifier(disqualifiers), weight: 0.2 },
        { value: normalizeStreakWeight(preference.learnedFromCount), weight: 0.15 },
        disqualifiers,
      ];
      const confidenceScore = scoreConfidence(factors);
      const confidenceReason = buildConfidenceReason(
        [
          item.packet.workflowType === "linkedin_company_post" ? "This matches the founder-reviewed LinkedIn company post workflow." : "",
          (item.packet.openQuestions || []).length === 0 ? "No open edit questions are waiting on Samantha." : "",
          preference.learnedFromCount >= 3 ? `Founder approved ${preference.learnedFromCount} similar posts in a row.` : "",
          !hasTriggeredDisqualifier(disqualifiers) ? "No payment, dispute, or legal-sensitive language was detected." : "",
        ],
        disqualifiers
      );
      return { confidenceScore, confidenceReason, disqualifiers };
    },
    async execute(item, evaluation) {
      const packetId = String(item.packet._id);
      const previousPacket = { approvalState: item.packet.approvalState };
      const brief = item.packet.briefId
        ? await MarketingBrief.findById(item.packet.briefId).select("_id approvalState").lean()
        : null;
      const previousTaskStates = await ApprovalTask.find({
        taskType: "marketing_review",
        targetType: "marketing_draft_packet",
        targetId: packetId,
        approvalState: "pending",
      })
        .select("_id approvalState decidedBy decidedAt decisionNote")
        .lean();

      try {
        await approveMarketingPacket({
          packetId,
          actor: buildAutoActor(),
          note: "Auto-approved from a founder autonomy preference.",
        });
        const action = await logAction({
          agentRole: "CMO",
          actionType: "marketing_publish_auto_approved",
          confidenceScore: evaluation.confidenceScore,
          confidenceReason: evaluation.confidenceReason,
          targetModel: "MarketingDraftPacket",
          targetId: packetId,
          changedFields: { approvalState: "approved" },
          previousValues: { approvalState: previousPacket.approvalState },
          actionTaken: `Marketing approved the LinkedIn post packet "${compactText(item.packet.workflowType, 80)}" automatically after repeated matching founder approvals.`,
          safetyContext: evaluation.disqualifiers,
        });
        return action;
      } catch (error) {
        await MarketingDraftPacket.updateOne({ _id: packetId }, { $set: previousPacket });
        if (brief?._id) {
          await MarketingBrief.updateOne({ _id: brief._id }, { $set: { approvalState: brief.approvalState } });
        }
        for (const task of previousTaskStates) {
          await ApprovalTask.updateOne(
            { _id: task._id },
            {
              $set: {
                approvalState: task.approvalState,
                decidedBy: task.decidedBy || null,
                decidedAt: task.decidedAt || null,
                decisionNote: task.decisionNote || "",
              },
            }
          );
        }
        throw error;
      }
    },
  },
  {
    agentRole: "CSO",
    actionType: AUTONOMY_ACTION_TYPES.cso,
    autoActionType: "sales_outreach_auto_approved",
    laneKey: "cso",
    navSection: "sales-workspace",
    title: "Let Sales send these automatically",
    nounPhrase: "outreach messages",
    explanation: (count) =>
      `You've approved ${count} outbound ${count === 1 ? "message" : "messages"} in a row.`,
    preview:
      "Future outreach drafts with the same safe profile will skip the founder queue and use the current sales approval path automatically.",
    actionHelperText:
      "Enable Auto will auto-approve future outreach drafts that still have clear context and no risk flags. Keep Reviewing will leave this category manual and stop this suggestion.",
    computeApprovalStreak: () =>
      countConsecutiveApprovalsForApprovalTask({ taskType: "sales_review", targetType: "sales_draft_packet" }),
    async listPendingItems() {
      const tasks = await ApprovalTask.find({
        taskType: "sales_review",
        targetType: "sales_draft_packet",
        approvalState: "pending",
      })
        .sort({ updatedAt: 1, createdAt: 1 })
        .lean();
      const ids = tasks.map((task) => task.targetId).filter(Boolean);
      const packets = await SalesDraftPacket.find({ _id: { $in: ids }, approvalState: "pending_review" }).lean();
      const packetMap = new Map(packets.map((packet) => [String(packet._id), packet]));
      return tasks
        .map((task) => {
          const packet = packetMap.get(String(task.targetId));
          return packet ? { task, packet } : null;
        })
        .filter(Boolean);
    },
    evaluate(item, preference) {
      const text = [
        item.packet.packetSummary,
        item.packet.accountSummary,
        item.packet.audienceSummary,
        item.packet.recommendedNextStep,
        item.packet.channelDraft?.subject,
        item.packet.channelDraft?.body,
      ].join(" ");
      const disqualifiers = buildDisqualifierFlags({
        text,
        legalOrDispute: SENSITIVE_SALES_KEYWORDS.test(text),
      });
      const factors = [
        { value: item.packet.packetType === "outreach_draft", weight: 0.24 },
        { value: Boolean(item.packet.accountId && item.packet.accountSummary && item.packet.audienceSummary), weight: 0.26 },
        { value: Array.isArray(item.packet.riskFlags) && item.packet.riskFlags.length === 0, weight: 0.2 },
        { value: Array.isArray(item.packet.unknowns) && item.packet.unknowns.length === 0, weight: 0.15 },
        { value: !hasTriggeredDisqualifier(disqualifiers), weight: 0.15 },
        disqualifiers,
      ];
      const confidenceScore = scoreConfidence(factors);
      const confidenceReason = buildConfidenceReason(
        [
          item.packet.packetType === "outreach_draft" ? "This is the existing governed outreach workflow." : "",
          item.packet.accountSummary && item.packet.audienceSummary ? "The draft already includes account and audience context." : "",
          (item.packet.riskFlags || []).length === 0 ? "No explicit sales risk flags are attached." : "",
          (item.packet.unknowns || []).length === 0 ? "No open unknowns are waiting on Samantha." : "",
          preference.learnedFromCount >= 3 ? `Founder approved ${preference.learnedFromCount} similar outreach drafts in a row.` : "",
        ],
        disqualifiers
      );
      return { confidenceScore, confidenceReason, disqualifiers };
    },
    async execute(item, evaluation) {
      const packetId = String(item.packet._id);
      const previousPacket = { approvalState: item.packet.approvalState };
      const previousTaskStates = await ApprovalTask.find({
        taskType: "sales_review",
        targetType: "sales_draft_packet",
        targetId: packetId,
        approvalState: "pending",
      })
        .select("_id approvalState decidedBy decidedAt decisionNote")
        .lean();

      try {
        await approveSalesPacket({
          packetId,
          actor: buildAutoActor(),
          note: "Auto-approved from a founder autonomy preference.",
        });
        const action = await logAction({
          agentRole: "CSO",
          actionType: "sales_outreach_auto_approved",
          confidenceScore: evaluation.confidenceScore,
          confidenceReason: evaluation.confidenceReason,
          targetModel: "SalesDraftPacket",
          targetId: packetId,
          changedFields: { approvalState: "approved" },
          previousValues: { approvalState: previousPacket.approvalState },
          actionTaken: `Sales approved the outreach draft "${compactText(item.packet.packetType, 80)}" automatically after repeated matching founder approvals.`,
          safetyContext: evaluation.disqualifiers,
        });
        return action;
      } catch (error) {
        await SalesDraftPacket.updateOne({ _id: packetId }, { $set: previousPacket });
        for (const task of previousTaskStates) {
          await ApprovalTask.updateOne(
            { _id: task._id },
            {
              $set: {
                approvalState: task.approvalState,
                decidedBy: task.decidedBy || null,
                decidedAt: task.decidedAt || null,
                decisionNote: task.decisionNote || "",
              },
            }
          );
        }
        throw error;
      }
    },
  },
  {
    agentRole: "CTO",
    actionType: AUTONOMY_ACTION_TYPES.cto,
    autoActionType: "incident_approval_auto_approved",
    laneKey: "cto",
    navSection: "engineering",
    title: "Let Engineering move these fixes forward automatically",
    nounPhrase: "incident approvals",
    explanation: (count) =>
      `You've approved ${count} engineering ${count === 1 ? "fix" : "fixes"} in a row.`,
    preview:
      "Future low-risk incident approvals like this will skip the founder queue and use the current engineering approval path automatically.",
    actionHelperText:
      "Enable Auto will auto-approve future low-risk incident approvals that pass the existing safety checks. Keep Reviewing will leave this category manual and stop this suggestion.",
    computeApprovalStreak: () => countConsecutiveApprovalsForIncidentApprovals(),
    async listPendingItems() {
      const approvals = await IncidentApproval.find({
        approvalType: "production_deploy",
        status: "pending",
      })
        .sort({ requestedAt: 1, _id: 1 })
        .lean();
      const incidentIds = approvals.map((approval) => approval.incidentId).filter(Boolean);
      const incidents = await Incident.find({
        _id: { $in: incidentIds },
        currentApprovalId: { $in: approvals.map((approval) => approval._id) },
      }).lean();
      const incidentMap = new Map(incidents.map((incident) => [String(incident._id), incident]));
      return approvals
        .map((approval) => {
          const incident = incidentMap.get(String(approval.incidentId));
          return incident ? { approval, incident } : null;
        })
        .filter(Boolean);
    },
    evaluate(item, preference) {
      const text = [item.incident.summary, item.incident.originalReportText, item.incident.context?.featureKey].join(" ");
      const riskFlags = item.incident.classification?.riskFlags || {};
      const moneyOrAuth = riskFlags.affectsMoney === true || riskFlags.affectsAuth === true;
      const disqualifiers = buildDisqualifierFlags({
        text,
        involvesMoney: moneyOrAuth,
        legalOrDispute: /\b(dispute|legal|lawsuit|claim|settlement)\b/i.test(text),
      });
      const factors = [
        { value: item.approval.approvalType === "production_deploy", weight: 0.14 },
        { value: String(item.incident.state || "").toLowerCase() === "awaiting_founder_approval", weight: 0.16 },
        { value: String(item.incident.classification?.confidence || "").toLowerCase() === "high", weight: 0.2 },
        { value: ["low", "medium"].includes(String(item.incident.classification?.riskLevel || "").toLowerCase()), weight: 0.16 },
        { value: moneyOrAuth === false, weight: 0.2 },
        { value: normalizeStreakWeight(preference.learnedFromCount), weight: 0.14 },
        disqualifiers,
      ];
      const confidenceScore = scoreConfidence(factors);
      const confidenceReason = buildConfidenceReason(
        [
          "This is the existing founder-gated engineering approval path.",
          String(item.incident.classification?.confidence || "").toLowerCase() === "high"
            ? "Incident classification confidence is already high."
            : "",
          moneyOrAuth === false ? "No money or auth risk flags are attached." : "",
          preference.learnedFromCount >= 3 ? `Founder approved ${preference.learnedFromCount} similar incident approvals in a row.` : "",
        ],
        disqualifiers
      );
      return { confidenceScore, confidenceReason, disqualifiers };
    },
    async execute(item, evaluation) {
      const incidentId = item.incident.publicId || String(item.incident._id);
      const approvalId = String(item.approval._id);
      const previousApproval = {
        status: item.approval.status,
        decisionByUserId: item.approval.decisionByUserId || null,
        decisionByEmail: item.approval.decisionByEmail || "",
        decisionRole: item.approval.decisionRole || null,
        decisionNote: item.approval.decisionNote || "",
        decisionScope: item.approval.decisionScope || {},
        decidedAt: item.approval.decidedAt || null,
      };
      const previousIncident = {
        approvalState: item.incident.approvalState,
        state: item.incident.state,
        userVisibleStatus: item.incident.userVisibleStatus,
        adminVisibleStatus: item.incident.adminVisibleStatus,
        orchestration: item.incident.orchestration || {},
      };
      const previousRelease = item.approval.releaseId
        ? await IncidentRelease.findById(item.approval.releaseId).select("_id status").lean()
        : null;

      try {
        await decideIncidentApproval({
          incidentIdentifier: incidentId,
          approvalId,
          decision: "approve",
          actor: buildAutoActor(),
          note: "Auto-approved from a founder autonomy preference.",
        });
        const action = await logAction({
          agentRole: "CTO",
          actionType: "incident_approval_auto_approved",
          confidenceScore: evaluation.confidenceScore,
          confidenceReason: evaluation.confidenceReason,
          targetModel: "IncidentApproval",
          targetId: approvalId,
          changedFields: {
            status: "approved",
            decisionScope: {
              allowProductionDeploy: true,
              allowUserResolution: false,
              allowManualRepair: false,
            },
          },
          previousValues: previousApproval,
          actionTaken: `Engineering moved incident ${compactText(item.incident.publicId || String(item.incident._id), 80)} forward automatically after repeated matching founder approvals.`,
          safetyContext: evaluation.disqualifiers,
        });
        return action;
      } catch (error) {
        await IncidentApproval.updateOne({ _id: approvalId }, { $set: previousApproval });
        await Incident.updateOne(
          { _id: item.incident._id },
          {
            $set: {
              approvalState: previousIncident.approvalState,
              state: previousIncident.state,
              userVisibleStatus: previousIncident.userVisibleStatus,
              adminVisibleStatus: previousIncident.adminVisibleStatus,
              orchestration: previousIncident.orchestration,
            },
          }
        );
        if (previousRelease?._id) {
          await IncidentRelease.updateOne({ _id: previousRelease._id }, { $set: { status: previousRelease.status } });
        }
        throw error;
      }
    },
  },
]);

const AUTONOMY_DEFINITION_MAP = new Map(
  AUTONOMY_DEFINITIONS.map((definition) => [buildPreferenceKey(definition.agentRole, definition.actionType), definition])
);

function getDefinition(agentRole = "", actionType = "") {
  return AUTONOMY_DEFINITION_MAP.get(buildPreferenceKey(agentRole, actionType)) || null;
}

async function refreshPreferenceLearning(agentRole = "", actionType = "") {
  const definition = getDefinition(agentRole, actionType);
  if (!definition) return null;
  const learnedFromCount = await definition.computeApprovalStreak();
  return AutonomyPreference.findOneAndUpdate(
    { agentRole: definition.agentRole, actionType: definition.actionType },
    {
      $setOnInsert: {
        mode: "manual",
        createdAt: new Date(),
      },
      $set: {
        learnedFromCount,
      },
    },
    {
      new: true,
      upsert: true,
    }
  );
}

async function recordDecisionOutcome(agentRole = "", actionType = "", decision = "") {
  const normalizedDecision = String(decision || "").trim().toLowerCase();
  if (!["approve", "reject"].includes(normalizedDecision)) return null;
  return refreshPreferenceLearning(agentRole, actionType);
}

async function refreshAllPreferenceLearning() {
  return Promise.all(AUTONOMY_DEFINITIONS.map((definition) => refreshPreferenceLearning(definition.agentRole, definition.actionType)));
}

function buildSuggestionActions(definition, preference) {
  return {
    yes: {
      kind: "autonomy_preference",
      label: "Enable Auto",
      decision: "enable",
      agentRole: definition.agentRole,
      actionType: definition.actionType,
      successMessage: `${definition.agentRole} auto-mode is now enabled for this action type.`,
      disabled: false,
    },
    no: {
      kind: "autonomy_preference",
      label: "Keep Reviewing",
      decision: "manual",
      agentRole: definition.agentRole,
      actionType: definition.actionType,
      successMessage: `This action type will stay manual and this upgrade prompt will not show again.`,
      disabled: false,
    },
    open: {
      kind: "nav",
      label: "Open Details",
      navSection: definition.navSection,
      disabled: false,
    },
    edit: null,
  };
}

function buildUpgradeSuggestion(definition, preference) {
  if (!definition || !preference) return null;
  const count = Number(preference.learnedFromCount || 0);
  return {
    id: `${definition.agentRole}:${definition.actionType}:upgrade`,
    laneKey: definition.laneKey,
    agentRole: definition.agentRole,
    actionType: definition.actionType,
    title: definition.title,
    explanation: definition.explanation(count),
    preview: definition.preview,
    proposedAction: `Enable Auto will let ${definition.agentRole} handle future eligible ${definition.nounPhrase} through the current workflow.`,
    actionHelperText: definition.actionHelperText,
    urgencyLabel: "One-time upgrade",
    tone: "active",
    confidenceScore: null,
    confidenceReason: "",
    createdAt: preference.createdAt || null,
    updatedAt: preference.lastPromptedAt || null,
    actions: buildSuggestionActions(definition, preference),
  };
}

async function getTopUpgradeSuggestion() {
  await refreshAllPreferenceLearning();
  const preferences = await AutonomyPreference.find({
    agentRole: { $in: ["CCO", "CMO", "CSO", "CTO"] },
    mode: "manual",
    lastPromptedAt: null,
    learnedFromCount: { $gte: 3 },
  })
    .sort({ learnedFromCount: -1, createdAt: 1, _id: 1 })
    .lean();

  for (const preference of preferences) {
    const definition = getDefinition(preference.agentRole, preference.actionType);
    if (!definition) continue;
    return buildUpgradeSuggestion(definition, preference);
  }
  return null;
}

async function setAutonomyPreferenceMode(agentRole = "", actionType = "", mode = "manual") {
  const definition = getDefinition(agentRole, actionType);
  const nextMode = String(mode || "").trim().toLowerCase();
  if (!definition) {
    const error = new Error("Autonomy preference type is not supported.");
    error.statusCode = 404;
    throw error;
  }
  if (!["manual", "auto"].includes(nextMode)) {
    const error = new Error("A valid autonomy preference mode is required.");
    error.statusCode = 400;
    throw error;
  }

  await refreshPreferenceLearning(definition.agentRole, definition.actionType);

  return AutonomyPreference.findOneAndUpdate(
    { agentRole: definition.agentRole, actionType: definition.actionType },
    {
      $setOnInsert: { createdAt: new Date() },
      $set: {
        mode: nextMode,
        lastPromptedAt: new Date(),
      },
    },
    {
      new: true,
      upsert: true,
    }
  );
}

async function getAutoModePreferences() {
  return AutonomyPreference.find({
    mode: "auto",
    agentRole: { $in: ["CCO", "CMO", "CSO", "CTO"] },
  }).lean();
}

async function processAutoModeActions() {
  const preferences = await getAutoModePreferences();
  if (!preferences.length) return { executedCount: 0 };

  const recentActionIds = [];
  let executedCount = 0;

  for (const preference of preferences) {
    if (executedCount >= MAX_AUTO_ACTIONS_PER_PASS) break;
    const definition = getDefinition(preference.agentRole, preference.actionType);
    if (!definition) continue;
    const pendingItems = await definition.listPendingItems();
    for (const item of pendingItems) {
      if (executedCount >= MAX_AUTO_ACTIONS_PER_PASS) break;
      const evaluation = definition.evaluate(item, preference);
      if (!Number.isFinite(Number(evaluation.confidenceScore)) || Number(evaluation.confidenceScore) <= 0) {
        continue;
      }
      try {
        const action = await definition.execute(item, evaluation);
        if (action?._id) recentActionIds.push(String(action._id));
        executedCount += 1;
      } catch (error) {
        logger.error("Failed to auto-handle founder-approved action type.", {
          agentRole: definition.agentRole,
          actionType: definition.actionType,
          error: error?.message || String(error),
        });
      }
    }
  }

  return {
    executedCount,
    recentActionIds,
  };
}

async function getAutonomyPreferencesSnapshot() {
  const suggestion = await getTopUpgradeSuggestion();
  const preferences = await AutonomyPreference.find({
    agentRole: { $in: ["CCO", "CMO", "CSO", "CTO"] },
  })
    .sort({ agentRole: 1, actionType: 1 })
    .lean();
  return {
    suggestion,
    preferences,
  };
}

module.exports = {
  AUTONOMY_ACTION_TYPES,
  getAutonomyPreferencesSnapshot,
  getTopUpgradeSuggestion,
  processAutoModeActions,
  recordDecisionOutcome,
  refreshPreferenceLearning,
  setAutonomyPreferenceMode,
};
