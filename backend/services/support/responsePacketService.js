const Incident = require("../../models/Incident");
const { loadApprovedItems } = require("../knowledge/retrievalService");
const { SUPPORT_CONFIDENCE } = require("./constants");
const {
  compactText,
  countKeywordHits,
  isOpenIncident,
  isResolvedIncident,
  overlaps,
  tokenize,
  uniqueStrings,
} = require("./shared");

function knowledgeText(card = {}) {
  return [
    card.title,
    card.summary,
    card.statement,
    card.approvedResponse,
    card.objection,
    ...(card.supportingPoints || []),
    ...(card.claimsToAvoid || []),
    ...(card.rules || []),
    ...(card.tags || []),
  ]
    .filter(Boolean)
    .join(" ");
}

function preferredDomains(category = "") {
  const value = String(category || "");
  if (value === "admissions") return ["admissions_policy", "platform_truth", "objection_handling"];
  if (value === "payments_risk" || value === "fees") return ["objection_handling", "platform_truth"];
  if (value === "platform_explainer") return ["platform_truth", "positioning", "distinctiveness", "audience_value"];
  if (value === "account_access") return ["platform_truth", "objection_handling"];
  if (value === "case_workflow" || value === "job_application") return ["platform_truth", "objection_handling", "audience_value"];
  return ["platform_truth", "objection_handling", "admissions_policy", "audience_value"];
}

async function selectKnowledgeCards(ticket = {}) {
  const cards = await loadApprovedItems({
    scopes: ["support_safe", "public_approved"],
    domains: preferredDomains(ticket.classification?.category),
  });

  const ticketTokens = tokenize(
    [
      ticket.subject,
      ticket.message,
      ticket.routePath,
      ticket.contextSnapshot?.caseTitle,
      ticket.contextSnapshot?.jobTitle,
      ticket.contextSnapshot?.applicationStatus,
    ]
      .filter(Boolean)
      .join(" ")
  );

  return cards
    .map((card) => {
      const cardTokens = tokenize(knowledgeText(card));
      let score = overlaps(ticketTokens, cardTokens).length;
      if (ticket.classification?.category === "payments_risk" || ticket.classification?.category === "fees") {
        score += countKeywordHits(knowledgeText(card), ["fee", "payment", "stripe", "payout"]);
      }
      if (ticket.classification?.category === "admissions") {
        score += countKeywordHits(knowledgeText(card), ["approval", "approved", "admission", "review"]);
      }
      if (ticket.classification?.category === "platform_explainer") {
        score += countKeywordHits(knowledgeText(card), ["platform", "attorney", "paralegal", "project-based"]);
      }
      return { card, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.card.title).localeCompare(String(b.card.title)))
    .slice(0, 4)
    .map((entry) => entry.card);
}

async function findLinkedIncidentAdvisories(ticket = {}) {
  const orClauses = [];
  if (ticket.caseId) orClauses.push({ "context.caseId": ticket.caseId });
  if (ticket.jobId) orClauses.push({ "context.jobId": ticket.jobId });
  if (ticket.applicationId) orClauses.push({ "context.applicationId": ticket.applicationId });
  if (ticket.requesterUserId) orClauses.push({ "reporter.userId": ticket.requesterUserId });
  if (ticket.routePath) orClauses.push({ "context.routePath": ticket.routePath });

  let incidents = [];
  if (orClauses.length) {
    incidents = await Incident.find({ $or: orClauses })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(6)
      .lean();
  }

  if (!incidents.length) {
    const message = String(ticket.message || ticket.subject || "").toLowerCase();
    const keywordClauses = [];
    if (/\b(log.?in|login|access|verify|password)\b/.test(message)) keywordClauses.push({ "classification.domain": "auth" });
    if (/\b(payment|payout|refund|charge|stripe|fee)\b/.test(message)) keywordClauses.push({ "classification.domain": { $in: ["payments", "payouts", "escrow", "withdrawals", "disputes"] } });
    if (/\b(application|apply|job)\b/.test(message)) keywordClauses.push({ "context.featureKey": /apply|application|job/i });
    if (/\b(case|matter|hire)\b/.test(message)) keywordClauses.push({ "context.featureKey": /case|matter|hire/i });
    if (keywordClauses.length) {
      incidents = await Incident.find({ $or: keywordClauses })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(4)
        .lean();
    }
  }

  return incidents.map((incident) => ({
    incidentId: incident._id,
    publicId: incident.publicId,
    state: incident.state,
    summary: compactText(incident.resolution?.summary || incident.summary || incident.originalReportText, 180),
    relationType: isOpenIncident(incident) ? "active_issue" : "resolved_learning",
    userVisibleStatus: incident.userVisibleStatus || "",
  }));
}

function buildNeededFacts(ticket = {}, category = "") {
  const needed = [];
  if ((category === "case_workflow" || category === "payments_risk") && !ticket.caseId) {
    needed.push("Case or matter identifier");
  }
  if (category === "job_application" && !ticket.jobId) {
    needed.push("Related job or application identifier");
  }
  if (category === "account_access" && !ticket.requesterEmail && !ticket.requesterUserId) {
    needed.push("Account email or user record");
  }
  if (!ticket.routePath && /page|screen|button|error/i.test(String(ticket.message || ""))) {
    needed.push("Exact page or workflow step");
  }
  if (!ticket.message || String(ticket.message).trim().length < 25) {
    needed.push("More detail about what happened");
  }
  return uniqueStrings(needed);
}

function buildRiskFlags(ticket = {}, linkedIncidents = []) {
  const risks = [];
  const text = `${ticket.subject || ""} ${ticket.message || ""}`.toLowerCase();
  if (/\b(refund|chargeback|dispute)\b/.test(text)) risks.push("founder_review");
  if (/\b(payment|payout|charge|refund|stripe|fee)\b/.test(text)) risks.push("money_sensitive");
  if (/\b(login|access|verify|verification|password|locked out)\b/.test(text)) risks.push("account_access");
  if (ticket.caseId || ticket.jobId || ticket.applicationId || /\b(case|matter|hire|application|job)\b/.test(text)) {
    risks.push("case_progress");
  }
  if (linkedIncidents.some((incident) => incident.relationType === "active_issue")) risks.push("active_incident");
  return uniqueStrings(risks);
}

function buildRecommendedReply({ ticket = {}, cards = [], neededFacts = [], linkedIncidents = [] } = {}) {
  const intro =
    ticket.classification?.category === "admissions"
      ? "Thanks for reaching out about your LPC application."
      : "Thanks for reaching out to LPC support.";

  const bodyLines = [];
  const answerCard =
    cards.find((card) => card.approvedResponse) ||
    cards.find((card) => card.statement) ||
    cards.find((card) => card.summary);

  if (answerCard?.approvedResponse) {
    bodyLines.push(answerCard.approvedResponse);
  } else if (answerCard?.statement) {
    bodyLines.push(answerCard.statement);
  } else if (answerCard?.summary) {
    bodyLines.push(answerCard.summary);
  }

  const supportCard = cards.find((card) => (card.supportingPoints || []).length);
  if (supportCard?.supportingPoints?.[0]) {
    bodyLines.push(supportCard.supportingPoints[0]);
  }

  if (neededFacts.length) {
    bodyLines.push(`To review the right record, please share your ${neededFacts.slice(0, 2).join(" and ")}.`);
  }

  if (linkedIncidents.some((incident) => incident.relationType === "active_issue")) {
    bodyLines.push("This issue should be reviewed against the active internal incident queue before a final response is sent.");
  }

  return [intro, ...bodyLines].filter(Boolean).join(" ");
}

function buildConfidence(cards = [], neededFacts = [], linkedIncidents = []) {
  if (cards.length >= 2 && !neededFacts.length) return "high";
  if (cards.length && linkedIncidents.some((incident) => isResolvedIncident({ state: incident.state }))) return "medium";
  if (cards.length) return "medium";
  return SUPPORT_CONFIDENCE[0];
}

async function generateResponsePacket(ticket = {}) {
  const linkedIncidents = await findLinkedIncidentAdvisories(ticket);
  const riskFlags = buildRiskFlags(ticket, linkedIncidents);
  const cards = await selectKnowledgeCards(ticket);
  const neededFacts = buildNeededFacts(ticket, ticket.classification?.category);
  const citations = uniqueStrings(
    cards.flatMap((card) => (card.citations || []).map((citation) => JSON.stringify(citation)))
  ).map((citation) => JSON.parse(citation));

  return {
    packetVersion: Number(ticket.latestResponsePacket?.packetVersion || 0) + 1,
    generatedAt: new Date(),
    recommendedReply: buildRecommendedReply({ ticket, cards, neededFacts, linkedIncidents }),
    citations,
    confidence: buildConfidence(cards, neededFacts, linkedIncidents),
    riskFlags,
    neededFacts,
    escalationOwner: ticket.routingSuggestion?.ownerKey || "support_ops",
    linkedIncidents,
    advisories: cards
      .flatMap((card) => card.claimsToAvoid || [])
      .slice(0, 4),
    matchedKnowledgeKeys: cards.map((card) => card.key),
  };
}

module.exports = {
  generateResponsePacket,
};
