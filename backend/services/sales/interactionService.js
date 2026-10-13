const SalesAccount = require("../../models/SalesAccount");
const SalesInteraction = require("../../models/SalesInteraction");

async function createInteraction(accountId, payload = {}) {
  const account = await SalesAccount.findById(accountId).select("_id").lean();
  if (!account) throw new Error("Sales account not found.");
  const summary = String(payload.summary || "").trim();
  if (!summary) throw new Error("Sales interaction summary is required.");

  const interaction = await SalesInteraction.create({
    accountId,
    interactionType: payload.interactionType || "manual_note",
    direction: payload.direction || "internal",
    summary,
    rawText: String(payload.rawText || "").trim(),
    objections: Array.isArray(payload.objections) ? payload.objections : [],
    metadata: payload.metadata || {},
  });

  return interaction.toObject();
}

async function listInteractions(accountId, { limit = 50 } = {}) {
  return SalesInteraction.find({ accountId })
    .sort({ createdAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 50)))
    .lean();
}

module.exports = {
  createInteraction,
  listInteractions,
};
