const MarketingBrief = require("../../models/MarketingBrief");
const { MARKETING_WORKFLOW_TYPES } = require("./constants");
const { normalizeLinkedInCompanyContentLane } = require("./linkedinCompanyStrategy");
const { publishEventSafe } = require("../lpcEvents/publishEventService");

function sanitizeText(value = "", max = 8000) {
  return String(value || "").trim().slice(0, max);
}

function normalizeFacts(value = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeText(entry, 500)).filter(Boolean).slice(0, 12);
  }
  return String(value || "")
    .split(/\n+/)
    .map((entry) => sanitizeText(entry, 500))
    .filter(Boolean)
    .slice(0, 12);
}

function toActor(user = {}) {
  return {
    actorType: user.actorType || "user",
    userId: user._id || user.id || null,
    label: user.email || user.label || `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Admin",
  };
}

async function createBrief(payload = {}, user = {}) {
  const workflowType = String(payload.workflowType || "").trim();
  if (!MARKETING_WORKFLOW_TYPES.includes(workflowType)) {
    throw new Error("Unsupported marketing workflow.");
  }

  const title = sanitizeText(payload.title, 240) || workflowType.replace(/_/g, " ");
  const contentLane =
    workflowType === "linkedin_company_post" ? normalizeLinkedInCompanyContentLane(payload.contentLane) : "";
  const brief = await MarketingBrief.create({
    workflowType,
    cycleId: payload.cycleId || null,
    channelKey: payload.channelKey || null,
    title,
    briefSummary: sanitizeText(payload.briefSummary, 8000),
    targetAudience: sanitizeText(payload.targetAudience, 240),
    objective: sanitizeText(payload.objective, 1000),
    contentLane,
    updateFacts: normalizeFacts(payload.updateFacts),
    ctaPreference: sanitizeText(payload.ctaPreference, 500),
    requestedBy: toActor(user),
    approvalState: "draft",
  });

  await publishEventSafe({
    eventType: "marketing.brief.created",
    eventFamily: "marketing",
    idempotencyKey: `marketing-brief:${brief._id}:created`,
    correlationId: `marketing:${brief._id}`,
    actor: {
      actorType: user.actorType || "user",
      userId: user._id || user.id || null,
      label: user.email || user.label || `${user.firstName || ""} ${user.lastName || ""}`.trim() || "Admin",
    },
    subject: {
      entityType: "marketing_brief",
      entityId: String(brief._id),
    },
    related: {
      marketingBriefId: brief._id,
    },
    source: {
      surface: "admin",
      route: "/api/admin/marketing/briefs",
      service: "marketing",
      producer: "service",
    },
    facts: {
      title: brief.title,
      summary: brief.briefSummary || brief.objective || "",
      after: {
        workflowType: brief.workflowType,
        cycleId: brief.cycleId || null,
        channelKey: brief.channelKey || "",
        contentLane: brief.contentLane || "",
        targetAudience: brief.targetAudience || "",
        objective: brief.objective || "",
      },
    },
    signals: {
      confidence: "high",
      priority: "normal",
      founderVisible: false,
      publicFacing: true,
    },
  });

  return brief;
}

async function listBriefs() {
  return MarketingBrief.find({})
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
}

async function getBriefById(id) {
  return MarketingBrief.findById(id).lean();
}

module.exports = {
  createBrief,
  getBriefById,
  listBriefs,
  normalizeFacts,
  sanitizeText,
};
