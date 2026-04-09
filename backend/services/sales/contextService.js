const SalesAccount = require("../../models/SalesAccount");
const SalesInteraction = require("../../models/SalesInteraction");
const User = require("../../models/User");
const { loadApprovedItems } = require("../knowledge/retrievalService");

async function buildSalesContext(accountId) {
  const [account, interactions] = await Promise.all([
    SalesAccount.findById(accountId).lean(),
    SalesInteraction.find({ accountId }).sort({ createdAt: -1 }).limit(12).lean(),
  ]);
  if (!account) throw new Error("Sales account not found.");

  const linkedUser = account.linkedUserId
    ? await User.findById(account.linkedUserId)
        .select("firstName lastName email role lawFirm firmWebsite state bio yearsExperience specialties")
        .lean()
    : null;

  const cards = await loadApprovedItems({
    scopes: ["sales_safe", "public_approved"],
    domains: ["platform_truth", "founder_voice", "positioning", "distinctiveness", "objection_handling", "audience_value"],
  });

  const audience = String(account.audienceType || linkedUser?.role || "general");
  const filtered = cards.filter((card) => {
    const tags = Array.isArray(card.tags) ? card.tags : [];
    const audienceTags = tags.filter((tag) => ["attorney", "paralegal", "public", "founder"].includes(tag));
    if (!audienceTags.length) return true;
    return audienceTags.includes(audience);
  });

  return {
    account,
    interactions,
    linkedUser,
    founderVoiceCards: filtered.filter((card) => card.domain === "founder_voice"),
    positioningCards: filtered.filter((card) => card.recordType === "positioning_card"),
    distinctivenessCards: filtered.filter((card) => card.recordType === "distinctiveness_card"),
    objectionCards: filtered.filter((card) => card.recordType === "objection_card"),
    valueCards: filtered.filter((card) => card.recordType === "value_card"),
    factCards: filtered.filter((card) => card.recordType === "fact_card" || card.recordType === "policy_card"),
    claimGuardrails: filtered.filter((card) => card.recordType === "claim_guardrail"),
  };
}

module.exports = {
  buildSalesContext,
};
