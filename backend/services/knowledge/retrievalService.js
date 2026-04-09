const KnowledgeCollection = require("../../models/KnowledgeCollection");
const KnowledgeItem = require("../../models/KnowledgeItem");
const KnowledgeRevision = require("../../models/KnowledgeRevision");
const { KNOWLEDGE_AUDIENCE_SCOPES } = require("./constants");

function normalizeArray(value = []) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function sanitizeScopes(scopes = []) {
  const incoming = normalizeArray(scopes).map((scope) => String(scope).trim());
  const filtered = incoming.filter((scope) => KNOWLEDGE_AUDIENCE_SCOPES.includes(scope));
  return filtered.length ? filtered : ["internal_ops"];
}

function formatKnowledgeCard(item = {}, revision = {}) {
  return {
    id: String(item._id),
    key: item.key,
    title: item.title,
    domain: item.domain,
    recordType: item.recordType,
    audienceScopes: item.audienceScopes || [],
    ownerLabel: item.ownerLabel || "",
    freshnessDays: item.freshnessDays || 0,
    lastReviewedAt: item.lastReviewedAt || null,
    nextReviewAt: item.nextReviewAt || null,
    summary: revision?.content?.summary || "",
    statement: revision?.content?.statement || "",
    supportingPoints: normalizeArray(revision?.content?.supportingPoints),
    claimsToAvoid: normalizeArray(revision?.content?.claimsToAvoid),
    rules: normalizeArray(revision?.content?.rules),
    approvedResponse: revision?.content?.approvedResponse || "",
    objection: revision?.content?.objection || "",
    audience: revision?.content?.audience || "",
    citations: normalizeArray(revision?.citations),
    tags: item.tags || [],
  };
}

async function loadApprovedItems({ scopes = [], domains = [], collectionKeys = [], recordTypes = [] } = {}) {
  const audienceScopes = sanitizeScopes(scopes);
  const query = {
    approvalState: "approved",
    isActive: true,
    audienceScopes: { $in: audienceScopes },
  };

  if (domains.length) query.domain = { $in: domains };
  if (recordTypes.length) query.recordType = { $in: recordTypes };
  if (collectionKeys.length) {
    const collections = await KnowledgeCollection.find({ key: { $in: collectionKeys }, isActive: true })
      .select("_id")
      .lean();
    query.collectionId = { $in: collections.map((collection) => collection._id) };
  }

  const items = await KnowledgeItem.find(query)
    .sort({ domain: 1, title: 1 })
    .lean();
  const revisionIds = items
    .map((item) => item.currentApprovedRevisionId)
    .filter(Boolean);
  const revisions = await KnowledgeRevision.find({ _id: { $in: revisionIds } }).lean();
  const revisionById = new Map(revisions.map((revision) => [String(revision._id), revision]));

  return items.map((item) => formatKnowledgeCard(item, revisionById.get(String(item.currentApprovedRevisionId))));
}

function pickAudienceCards(cards = [], targetAudience = "") {
  const target = String(targetAudience || "").toLowerCase();
  if (!target) return cards;
  return cards.filter((card) => {
    if (!Array.isArray(card.tags) || !card.tags.length) return true;
    const audienceTags = card.tags.filter((tag) => ["attorney", "paralegal", "public", "founder"].includes(tag));
    if (!audienceTags.length) return true;
    return audienceTags.some((tag) => target.includes(tag));
  });
}

async function buildMarketingContext({ workflowType = "", targetAudience = "" } = {}) {
  const cards = await loadApprovedItems({
    scopes: ["marketing_safe", "public_approved"],
  });

  const audienceCards = pickAudienceCards(cards, targetAudience);
  const founderVoiceCards = audienceCards.filter((card) => card.domain === "founder_voice");
  const factCards = audienceCards.filter((card) => card.recordType === "fact_card" || card.recordType === "policy_card");
  const positioningCards = audienceCards.filter((card) => card.recordType === "positioning_card");
  const distinctivenessCards = audienceCards.filter((card) => card.recordType === "distinctiveness_card");
  const objectionCards = audienceCards.filter((card) => card.recordType === "objection_card");
  const valueCards = audienceCards.filter((card) => card.recordType === "value_card");
  const claimGuardrails = audienceCards.filter((card) => card.recordType === "claim_guardrail");

  return {
    workflowType,
    targetAudience,
    founderVoiceCards,
    factCards,
    positioningCards,
    distinctivenessCards,
    objectionCards,
    valueCards,
    claimGuardrails,
    allCards: audienceCards,
  };
}

async function getKnowledgeOverview() {
  const [sources, collections, items, pendingApprovals, latestItems] = await Promise.all([
    require("../../models/KnowledgeSource").countDocuments({}),
    KnowledgeCollection.countDocuments({ isActive: true }),
    KnowledgeItem.countDocuments({ isActive: true }),
    require("../../models/ApprovalTask").countDocuments({
      taskType: "knowledge_review",
      approvalState: "pending",
    }),
    KnowledgeItem.find({ isActive: true })
      .sort({ updatedAt: -1 })
      .limit(8)
      .lean(),
  ]);

  const revisionIds = latestItems
    .map((item) => item.currentApprovedRevisionId || item.currentRevisionId)
    .filter(Boolean);
  const revisions = await KnowledgeRevision.find({ _id: { $in: revisionIds } }).lean();
  const revisionById = new Map(revisions.map((revision) => [String(revision._id), revision]));

  return {
    counts: {
      sources,
      collections,
      items,
      pendingApprovals,
    },
    latestItems: latestItems.map((item) => formatKnowledgeCard(item, revisionById.get(String(item.currentApprovedRevisionId || item.currentRevisionId)))),
  };
}

module.exports = {
  buildMarketingContext,
  formatKnowledgeCard,
  getKnowledgeOverview,
  loadApprovedItems,
};
