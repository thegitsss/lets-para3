const KnowledgeCollection = require("../../models/KnowledgeCollection");
const KnowledgeItem = require("../../models/KnowledgeItem");
const KnowledgeRevision = require("../../models/KnowledgeRevision");
const { KNOWLEDGE_AUDIENCE_SCOPES } = require("./constants");
const { listRegistrySources } = require("./sourceRegistry");

const SUPPORT_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "do",
  "does",
  "for",
  "how",
  "i",
  "in",
  "is",
  "it",
  "lpc",
  "me",
  "my",
  "of",
  "on",
  "the",
  "to",
  "what",
  "when",
  "where",
  "why",
  "with",
  "you",
]);

function normalizeArray(value = []) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function sanitizeScopes(scopes = []) {
  const incoming = normalizeArray(scopes).map((scope) => String(scope).trim());
  const filtered = incoming.filter((scope) => KNOWLEDGE_AUDIENCE_SCOPES.includes(scope));
  return filtered.length ? filtered : ["internal_ops"];
}

function tokenizeSupportKnowledge(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9%$]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !SUPPORT_SEARCH_STOP_WORDS.has(token));
}

function getRegistrySupportCards(role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return listRegistrySources().flatMap((source) =>
    (Array.isArray(source.items) ? source.items : [])
      .filter((item) => Array.isArray(item.audienceScopes) && item.audienceScopes.includes("support_safe"))
      .filter((item) => {
        const roleTags = (item.tags || []).filter((tag) => ["attorney", "paralegal"].includes(String(tag).toLowerCase()));
        if (!roleTags.length || normalizedRole === "admin") return true;
        return roleTags.includes(normalizedRole);
      })
      .map((item) => ({
        key: String(item.key || ""),
        title: String(item.title || ""),
        domain: String(item.domain || ""),
        recordType: String(item.recordType || ""),
        audienceScopes: item.audienceScopes || [],
        tags: item.tags || [],
        summary: String(item.content?.summary || ""),
        statement: String(item.content?.statement || ""),
        objection: String(item.content?.objection || ""),
        approvedResponse: String(item.content?.approvedResponse || ""),
        supportingPoints: Array.isArray(item.content?.supportingPoints) ? item.content.supportingPoints : [],
        citations: item.citations || [],
        sourceKey: String(source.sourceKey || ""),
        freshnessDays: Number(item.freshnessDays || 0),
      }))
  );
}

function scoreSupportKnowledgeCard(card = {}, queryTokens = [], role = "", query = "") {
  if (!queryTokens.length) return 0;
  const titleTokens = new Set(tokenizeSupportKnowledge(card.title));
  const tagTokens = new Set(tokenizeSupportKnowledge((card.tags || []).join(" ")));
  const questionTokens = new Set(tokenizeSupportKnowledge(card.objection));
  const contentTokens = new Set(
    tokenizeSupportKnowledge(
      [card.summary, card.statement, card.approvedResponse, ...(card.supportingPoints || [])].join(" ")
    )
  );
  let strongMatches = 0;
  let contentMatches = 0;
  let score = queryTokens.reduce((total, token) => {
    if (tagTokens.has(token)) {
      strongMatches += 1;
      return total + 5;
    }
    if (titleTokens.has(token)) {
      strongMatches += 1;
      return total + 4;
    }
    if (questionTokens.has(token)) {
      strongMatches += 1;
      return total + 3;
    }
    if (contentTokens.has(token)) {
      contentMatches += 1;
      return total + 1;
    }
    return total;
  }, 0);
  if (strongMatches === 0 && contentMatches < 2) return 0;
  const normalizedRole = String(role || "").trim().toLowerCase();
  if ((card.tags || []).map((tag) => String(tag).toLowerCase()).includes(normalizedRole)) score += 5;
  if (/\b(how much|percentage|percent|rate|charge|cost)\b/i.test(String(query || "")) && /\d+%/.test(card.approvedResponse || card.statement)) {
    score += 6;
  }
  if (
    /\b(?:what does|what is|why).*\bfee\b.*\b(?:support|cover|for)\b/i.test(String(query || "")) &&
    card.key === "objection_platform_fee_supports_infrastructure"
  ) {
    score += 10;
  }
  return score;
}

function rankSupportKnowledge(cards = [], { query = "", role = "", limit = 3 } = {}) {
  const queryTokens = tokenizeSupportKnowledge(query);
  if (!queryTokens.length) return [];
  return cards
    .map((card) => ({
      ...card,
      answer: card.approvedResponse || card.statement,
      score: scoreSupportKnowledgeCard(card, queryTokens, role, query),
    }))
    .filter((card) => card.answer && card.score >= Math.max(5, queryTokens.length * 2))
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, Math.max(1, Math.min(Number(limit) || 3, 5)));
}

function cardMatchesSupportRole(card = {}, role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  const roleTags = (card.tags || []).filter((tag) => ["attorney", "paralegal"].includes(String(tag).toLowerCase()));
  if (!roleTags.length || normalizedRole === "admin") return true;
  return roleTags.includes(normalizedRole);
}

async function retrieveSupportKnowledge({ query = "", role = "", limit = 3 } = {}) {
  const registryCards = getRegistrySupportCards(role);
  let approvedCards = [];
  try {
    approvedCards = (await loadApprovedItems({ scopes: ["support_safe"] }))
      .filter((card) => cardMatchesSupportRole(card, role))
      .map((card) => ({
        ...card,
        sourceKey: String(card.citations?.[0]?.sourceKey || "knowledge_studio"),
      }));
  } catch (_error) {
    approvedCards = [];
  }

  const mergedByKey = new Map(registryCards.map((card) => [card.key, card]));
  approvedCards.forEach((card) => mergedByKey.set(card.key, card));
  return rankSupportKnowledge([...mergedByKey.values()], { query, role, limit });
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
  retrieveSupportKnowledge,
};
