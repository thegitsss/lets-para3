const SupportInsight = require("../../models/SupportInsight");
const KnowledgeInsight = require("../../models/KnowledgeInsight");
const { LpcEvent } = require("../../models/LpcEvent");

function compactText(value = "", max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function addDays(date = new Date(), days = 0) {
  const next = new Date(date);
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function inferLaneFromText(value = "") {
  const text = String(value || "").toLowerCase();
  if (
    /\b(update|milestone|progress|rolled out|release|released|launch|launched|improved|improvement|shipped|live)\b/.test(text)
  ) {
    return "updates_momentum";
  }
  if (
    /\b(standard|positioning|discipline|quality|fit|credibility|selective|premium|bar)\b/.test(text)
  ) {
    return "standards_positioning";
  }
  return "platform_explanation";
}

function uniqueBy(items = [], selector = (item) => item) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = selector(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function signalFactsFromKnowledgeInsights(insights = [], now = new Date()) {
  return insights.map((insight) => {
    const text = [insight.title, insight.summary, ...(insight.tags || [])].join(" ");
    const lane = inferLaneFromText(text);
    return {
      factKey: `knowledge-insight:${insight._id}`,
      sourceType: "knowledge_insight",
      sourceRef: String(insight._id),
      title: insight.title || "Knowledge insight",
      summary: compactText(insight.summary || "", 2000),
      statement: compactText(insight.summary || insight.title || "", 4000),
      contentLaneHints: lane === "platform_explanation" ? ["platform_explanation"] : [lane],
      safetyStatus: "approved",
      freshnessScore: 76,
      status: "active",
      lastReviewedAt: new Date(now),
      expiresAt: addDays(new Date(now), 45),
    };
  });
}

function supportSignalOpportunities(insights = [], now = new Date()) {
  return insights.slice(0, 3).map((insight) => ({
    opportunityKey: `support-signal:${insight.patternKey || insight._id}`,
    opportunityType: "fresh_explainer",
    contentLane: "platform_explanation",
    title: insight.title || "Support pattern suggests a clearer explainer",
    summary: compactText(
      insight.summary ||
        `Support is seeing a repeated ${insight.insightType || "confusion"} pattern that suggests LPC needs clearer explanation.`,
      2000
    ),
    rationale: compactText(
      `Recent support signal (${insight.repeatCount || 1} occurrences) suggests attorneys or paralegals need clearer explanation around this part of LPC.`,
      2000
    ),
    priority: Number(insight.repeatCount || 0) >= 3 ? "recommended" : "candidate",
    sourceRefs: [
      {
        type: "support_insight",
        refId: String(insight._id),
        label: insight.title || insight.patternKey || "Support insight",
      },
    ],
    expiresAt: addDays(new Date(now), 21),
  }));
}

function momentumOpportunityFromEvents(events = [], now = new Date()) {
  if ((events || []).length < 2) return [];

  return [
    {
      opportunityKey: `internal-momentum:${new Date(now).toISOString().slice(0, 10)}`,
      opportunityType: "fresh_update",
      contentLane: "updates_momentum",
      title: "Recent internal platform signals suggest real momentum",
      summary: "Recent LPC event activity suggests there may be valid progress worth evaluating for a measured update post.",
      rationale: "Internal platform events show recent movement, but the CMO should only use this lane if approved update facts also exist.",
      priority: "candidate",
      sourceRefs: events.slice(0, 4).map((event) => ({
        type: "lpc_event",
        refId: String(event._id),
        label: event.eventType || "Platform event",
      })),
      expiresAt: addDays(new Date(now), 10),
    },
  ];
}

async function collectInternalSignalInputs({ now = new Date() } = {}) {
  const since = addDays(new Date(now), -14);
  const [supportInsights, knowledgeInsights, recentEvents] = await Promise.all([
    SupportInsight.find({
      state: "active",
      updatedAt: { $gte: since },
      repeatCount: { $gte: 2 },
    })
      .sort({ repeatCount: -1, updatedAt: -1 })
      .limit(4)
      .lean(),
    KnowledgeInsight.find({
      status: { $in: ["reviewed", "promoted"] },
      audienceScopes: { $in: ["marketing_safe", "public_approved"] },
      updatedAt: { $gte: since },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(6)
      .lean(),
    LpcEvent.find({
      occurredAt: { $gte: since },
      eventType: { $in: ["support.ticket.resolved", "approval.approved", "sales.account.created"] },
      "signals.confidence": { $in: ["medium", "high"] },
    })
      .sort({ occurredAt: -1, createdAt: -1 })
      .limit(6)
      .lean(),
  ]);

  const facts = signalFactsFromKnowledgeInsights(knowledgeInsights, now);
  const opportunities = uniqueBy(
    [
      ...supportSignalOpportunities(supportInsights, now),
      ...momentumOpportunityFromEvents(recentEvents, now),
    ],
    (item) => item.opportunityKey
  );

  return {
    facts,
    opportunities,
    meta: {
      supportInsightCount: supportInsights.length,
      knowledgeInsightCount: knowledgeInsights.length,
      recentEventCount: recentEvents.length,
    },
  };
}

module.exports = {
  collectInternalSignalInputs,
  inferLaneFromText,
};
