const MarketingDayContext = require("../../models/MarketingDayContext");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const MarketingEvaluation = require("../../models/MarketingEvaluation");
const MarketingFact = require("../../models/MarketingFact");
const MarketingOpportunity = require("../../models/MarketingOpportunity");
const { buildMarketingContext } = require("../knowledge/retrievalService");
const { buildExternalDayResearch } = require("./jrCmoExternalResearchService");
const { collectInternalSignalInputs } = require("./jrCmoSignalIngestionService");
const { MARKETING_LINKEDIN_COMPANY_CONTENT_LANES } = require("./constants");
const { buildWeeklyEvaluation } = require("./evaluationService");
const {
  laneLabel,
  summarizeLinkedInCompanyCadence,
} = require("./linkedinCompanyStrategy");

function uniqueList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

const OPPORTUNITY_PRIORITY_ORDER = Object.freeze({
  hold: 0,
  recommended: 1,
  candidate: 2,
  watch: 3,
});

function startOfDay(date = new Date()) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date = new Date(), days = 0) {
  const next = new Date(date);
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function dayKey(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

function weekKey(date = new Date()) {
  const next = startOfDay(date);
  const weekday = next.getUTCDay() || 7;
  next.setUTCDate(next.getUTCDate() - (weekday - 1));
  return next.toISOString().slice(0, 10);
}

function weekdayLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(date));
}

function hoursSince(value, now = new Date()) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.max(0, (new Date(now).getTime() - date.getTime()) / (1000 * 60 * 60));
}

function toneForDay({ now = new Date(), cadence = {}, pendingReviewCount = 0 } = {}) {
  const weekday = new Date(now).getUTCDay();
  const missingStandards = Number(cadence.countsByLane?.standards_positioning || 0) === 0;
  const missingExplainer = Number(cadence.countsByLane?.platform_explanation || 0) === 0;

  if (pendingReviewCount > 0) {
    return {
      toneRecommendation: "focused",
      toneReasoning: "Pending review work exists, so today's tone should stay disciplined and queue-aware rather than expansive.",
    };
  }
  if (missingStandards) {
    return {
      toneRecommendation: "credible",
      toneReasoning: "The queue needs stronger standards and positioning signal, so today's tone should emphasize credibility and discipline.",
    };
  }
  if (weekday === 5 || weekday === 6) {
    return {
      toneRecommendation: "quiet_momentum",
      toneReasoning: "Late-week scheduling favors measured momentum over heavy declarative positioning.",
    };
  }
  if (missingExplainer) {
    return {
      toneRecommendation: "measured",
      toneReasoning: "The queue needs more explanation, so today's tone should stay clear and measured.",
    };
  }
  return {
    toneRecommendation: "focused",
    toneReasoning: "A focused, restrained tone is appropriate for the current queue and calendar context.",
  };
}

function laneHintsForCard(card = {}) {
  const recordType = String(card.recordType || "").trim();
  if (recordType === "distinctiveness_card" || recordType === "positioning_card") {
    return ["standards_positioning"];
  }
  if (recordType === "value_card") {
    return ["platform_explanation", "standards_positioning"];
  }
  return ["platform_explanation"];
}

function factText(fact = {}) {
  return [fact.title, fact.summary, fact.statement].join(" ").toLowerCase();
}

function isMomentumFact(fact = {}) {
  return /\b(update|milestone|progress|rolled out|release|released|improved|improvement|shipped|launch|live|new capability|tightened)\b/.test(
    factText(fact)
  );
}

function buildFactDrivenOpportunityDefinitions({ cadence = {}, facts = [] } = {}) {
  const defs = [];
  const lanes = [
    {
      lane: "platform_explanation",
      opportunityType: "fresh_explainer",
      title: "Fresh explainer support is available",
      summary: "Approved facts are available to support a clear platform explainer post.",
    },
    {
      lane: "standards_positioning",
      opportunityType: "fresh_positioning",
      title: "Fresh positioning support is available",
      summary: "Approved facts are available to support a standards and positioning post.",
    },
    {
      lane: "updates_momentum",
      opportunityType: "fresh_update",
      title: "Fresh momentum support is available",
      summary: "Approved facts are available to support a measured momentum update.",
    },
  ];

  for (const definition of lanes) {
    const matchingFacts = facts.filter((fact) => Array.isArray(fact.contentLaneHints) && fact.contentLaneHints.includes(definition.lane));
    const usableFacts =
      definition.lane === "updates_momentum" ? matchingFacts.filter((fact) => isMomentumFact(fact)) : matchingFacts;
    if (usableFacts.length < 2) continue;

    const priority = cadence.suggestedNextLane === definition.lane ? "recommended" : "candidate";
    defs.push({
      opportunityKey: `fresh-signal:${definition.lane}`,
      opportunityType: definition.opportunityType,
      contentLane: definition.lane,
      title: definition.title,
      summary: definition.summary,
      rationale:
        definition.lane === "updates_momentum"
          ? "The Jr. CMO has at least two update-grade facts, so a measured momentum post is now supportable."
          : `The Jr. CMO has enough approved facts to support a stronger ${laneLabel(definition.lane)} post right now.`,
      priority,
      sourceRefs: usableFacts.slice(0, 3).map((fact) => ({
        type: "marketing_fact",
        refId: fact.factKey,
        label: fact.title,
      })),
      expiresAt: addDays(new Date(), definition.lane === "updates_momentum" ? 14 : 21),
    });
  }

  return defs;
}

function buildOpportunityDefinitions({ cadence = {}, pendingReviewCount = 0, weeklyEvaluation = null, facts = [] } = {}) {
  const defs = [];

  if (pendingReviewCount > 0) {
    defs.push({
      opportunityKey: "queue-hold:pending-review",
      opportunityType: "queue_hold",
      contentLane: "",
      title: "Hold new CMO drafting until review backlog clears",
      summary: `${pendingReviewCount} marketing packet${pendingReviewCount === 1 ? " is" : "s are"} still awaiting Samantha review.`,
      rationale: "The CMO should not generate new work while internal review is backlogged.",
      priority: "hold",
      sourceRefs: [{ type: "marketing_queue", refId: "pending_review", label: "Pending review count" }],
      expiresAt: addDays(new Date(), 7),
    });
  }

  for (const lane of MARKETING_LINKEDIN_COMPANY_CONTENT_LANES) {
    const count = Number(cadence.countsByLane?.[lane] || 0);
    if (count > 0) continue;
    const isRecommended = cadence.suggestedNextLane === lane;
    defs.push({
      opportunityKey: `lane-gap:${lane}`,
      opportunityType: "lane_gap",
      contentLane: lane,
      title: `${laneLabel(lane)} gap`,
      summary: `Recent LinkedIn company drafts are missing ${laneLabel(lane)}.`,
      rationale: isRecommended
        ? `The next LinkedIn company draft should likely fill the ${laneLabel(lane)} gap.`
        : `This lane is missing from the recent queue and should return soon.`,
      priority: isRecommended ? "recommended" : "candidate",
      sourceRefs: [{ type: "cadence_summary", refId: lane, label: "Lane mix" }],
      expiresAt: addDays(new Date(), 21),
    });
  }

  if (weeklyEvaluation?.recommendations?.length) {
    defs.push({
      opportunityKey: `weekly-learning:${weeklyEvaluation.evaluationKey}`,
      opportunityType: "evaluation_learning",
      contentLane: "",
      title: "Apply current weekly marketing learning",
      summary: weeklyEvaluation.summary || "Recent weekly evaluation produced a recommendation worth applying.",
      rationale: weeklyEvaluation.recommendations[0] || "",
      priority: "candidate",
      sourceRefs: [{ type: "weekly_evaluation", refId: weeklyEvaluation.evaluationKey, label: weeklyEvaluation.title }],
      expiresAt: addDays(new Date(), 14),
    });
  }

  return [...defs, ...buildFactDrivenOpportunityDefinitions({ cadence, facts })];
}

function sortOpportunities(opportunities = []) {
  return [...(Array.isArray(opportunities) ? opportunities : [])].sort((left, right) => {
    const leftRank = OPPORTUNITY_PRIORITY_ORDER[left?.priority] ?? 99;
    const rightRank = OPPORTUNITY_PRIORITY_ORDER[right?.priority] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;

    const leftUpdated = new Date(left?.updatedAt || left?.createdAt || 0).getTime();
    const rightUpdated = new Date(right?.updatedAt || right?.createdAt || 0).getTime();
    return rightUpdated - leftUpdated;
  });
}

async function refreshJrCmoLibrary({ now = new Date() } = {}) {
  const currentDayKey = dayKey(now);
  const [marketingContext, recentLinkedInPackets, latestLinkedInPacket, weeklyPackets, weeklyOutcomeEvaluations, pendingReviewCount, existingDayContext, signalInputs] = await Promise.all([
    buildMarketingContext({
      workflowType: "linkedin_company_post",
      targetAudience: "approved attorneys and paralegals",
    }),
    MarketingDraftPacket.find({ workflowType: "linkedin_company_post" })
      .sort({ createdAt: -1, updatedAt: -1 })
      .limit(12)
      .select("workflowType contentLane approvalState createdAt updatedAt")
      .lean(),
    MarketingDraftPacket.findOne({ workflowType: "linkedin_company_post" })
      .sort({ createdAt: -1, updatedAt: -1 })
      .select("workflowType contentLane approvalState createdAt updatedAt")
      .lean(),
    MarketingDraftPacket.find({
      createdAt: { $gte: addDays(startOfDay(now), -7) },
    })
      .sort({ createdAt: -1 })
      .select("approvalState contentLane createdAt updatedAt")
      .lean(),
    MarketingEvaluation.find({
      evaluationType: "packet_outcome",
      windowEndAt: { $gte: addDays(startOfDay(now), -7) },
      status: "active",
    })
      .sort({ windowEndAt: -1, updatedAt: -1 })
      .lean(),
    MarketingDraftPacket.countDocuments({ approvalState: "pending_review" }),
    MarketingDayContext.findOne({ dayKey: currentDayKey, status: "active" }).lean(),
    collectInternalSignalInputs({ now }),
  ]);

  const cadence = summarizeLinkedInCompanyCadence(recentLinkedInPackets);
  const internalTone = toneForDay({ now, cadence, pendingReviewCount });
  const contextDate = startOfDay(now);
  const weekly = buildWeeklyEvaluation({ packets: weeklyPackets, outcomeEvaluations: weeklyOutcomeEvaluations });
  const evaluationKey = `weekly:${weekKey(now)}`;
  const internalSignals = uniqueList([
    ...((cadence.recommendations || []).slice(0, 2)),
    pendingReviewCount ? `${pendingReviewCount} marketing packet(s) are awaiting review.` : "No marketing review backlog is visible.",
  ]);

  let externalResearch = null;
  const canReuseExternalResearch =
    existingDayContext &&
    existingDayContext.dayKey === currentDayKey &&
    ["hybrid", "external_research"].includes(String(existingDayContext.sourceMode || "")) &&
    hoursSince(existingDayContext.refreshedAt, now) < 6 &&
    String(existingDayContext.industryClimateSummary || "").trim();

  if (canReuseExternalResearch) {
    externalResearch = {
      ok: true,
      sourceMode: String(existingDayContext.sourceMode || "hybrid"),
      toneRecommendation: existingDayContext.toneRecommendation,
      toneReasoning: existingDayContext.toneReasoning,
      industryClimateSummary: existingDayContext.industryClimateSummary,
      activeSignals: existingDayContext.activeSignals || [],
      sourceRefs: existingDayContext.sourceRefs || [],
    };
  } else {
    externalResearch = await buildExternalDayResearch({ now });
  }

  const mergedSourceMode = externalResearch?.ok ? "hybrid" : "internal_only";
  const mergedToneRecommendation = externalResearch?.ok
    ? String(externalResearch.toneRecommendation || internalTone.toneRecommendation)
    : internalTone.toneRecommendation;
  const mergedToneReasoning = uniqueList([
    externalResearch?.ok ? externalResearch.toneReasoning : "",
    internalTone.toneReasoning,
  ]).join(" ");
  const industryClimateSummary =
    externalResearch?.ok && externalResearch.industryClimateSummary
      ? externalResearch.industryClimateSummary
      : "External industry research is not available right now. Today's context is based on calendar timing and internal LPC queue state.";
  const activeSignals = uniqueList([...(externalResearch?.activeSignals || []), ...internalSignals]).slice(0, 6);
  const sourceRefs = externalResearch?.ok ? externalResearch.sourceRefs || [] : [];

  const dayContext = await MarketingDayContext.findOneAndUpdate(
    { dayKey: currentDayKey },
    {
      $set: {
        calendarDate: contextDate,
        weekday: weekdayLabel(now),
        sourceMode: mergedSourceMode,
        toneRecommendation: mergedToneRecommendation,
        toneReasoning: mergedToneReasoning,
        industryClimateSummary,
        internalContextSummary: cadence.summary,
        activeSignals,
        sourceRefs,
        status: "active",
        refreshedAt: new Date(now),
        expiresAt: addDays(contextDate, 7),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  const evaluation = await MarketingEvaluation.findOneAndUpdate(
    { evaluationKey },
    {
      $set: {
        evaluationType: "weekly",
        windowStartAt: addDays(startOfDay(now), -7),
        windowEndAt: startOfDay(now),
        title: weekly.title,
        summary: weekly.summary,
        findings: weekly.findings,
        recommendations: weekly.recommendations,
        status: "active",
        expiresAt: addDays(startOfDay(now), 90),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  const cards = uniqueList([
    ...(marketingContext.positioningCards || []),
    ...(marketingContext.distinctivenessCards || []),
    ...(marketingContext.valueCards || []),
    ...(marketingContext.factCards || []),
  ].map((card) => JSON.stringify(card))).map((value) => JSON.parse(value));

  const facts = [];
  for (const card of cards.slice(0, 10)) {
    const fact = await MarketingFact.findOneAndUpdate(
      { factKey: `knowledge:${card.key}` },
      {
        $set: {
          sourceType: "knowledge_card",
          sourceRef: card.key || "",
          title: card.title || card.key || "Marketing fact",
          summary: card.summary || card.statement || "",
          statement: card.statement || card.summary || "",
          contentLaneHints: laneHintsForCard(card),
          safetyStatus: "approved",
          freshnessScore: 82,
          status: "active",
          lastReviewedAt: new Date(now),
          expiresAt: addDays(startOfDay(now), 60),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    facts.push(fact);
  }

  for (const signalFact of signalInputs.facts || []) {
    const fact = await MarketingFact.findOneAndUpdate(
      { factKey: signalFact.factKey },
      { $set: signalFact },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    facts.push(fact);
  }

  const opportunityDefinitions = buildOpportunityDefinitions({
    cadence,
    pendingReviewCount,
    weeklyEvaluation: evaluation,
    facts,
  });
  const mergedOpportunityDefinitions = [...opportunityDefinitions, ...(signalInputs.opportunities || [])];
  const opportunities = [];
  for (const def of mergedOpportunityDefinitions) {
    const opportunity = await MarketingOpportunity.findOneAndUpdate(
      { opportunityKey: def.opportunityKey },
      {
        $set: {
          opportunityType: def.opportunityType,
          contentLane: def.contentLane || "",
          title: def.title,
          summary: def.summary,
          rationale: def.rationale,
          priority: def.priority,
          sourceMode: "internal_only",
          sourceRefs: def.sourceRefs || [],
          status: "active",
          lastSeenAt: new Date(now),
          expiresAt: def.expiresAt || addDays(startOfDay(now), 21),
        },
        $setOnInsert: {
          surfacedAt: new Date(now),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    opportunities.push(opportunity);
  }

  return {
    dayContext,
    evaluation,
    facts,
    opportunities,
    cadence,
    latestLinkedInPacket,
    pendingReviewCount,
    signalMeta: signalInputs.meta || {},
  };
}

async function cleanupJrCmoLibrary({ now = new Date() } = {}) {
  const cutoff = new Date(now);
  const [dayContexts, opportunities, facts, evaluations] = await Promise.all([
    MarketingDayContext.updateMany(
      {
        status: "active",
        $or: [{ expiresAt: { $lte: cutoff } }, { refreshedAt: { $lt: addDays(cutoff, -7) } }],
      },
      { $set: { status: "archived" } }
    ),
    MarketingOpportunity.updateMany(
      {
        status: "active",
        $or: [{ expiresAt: { $lte: cutoff } }, { lastSeenAt: { $lt: addDays(cutoff, -45) } }],
      },
      { $set: { status: "archived" } }
    ),
    MarketingFact.updateMany(
      {
        status: "active",
        $or: [{ expiresAt: { $lte: cutoff } }, { lastReviewedAt: { $lt: addDays(cutoff, -75) } }],
      },
      { $set: { status: "archived", safetyStatus: "expired" } }
    ),
    MarketingEvaluation.updateMany(
      {
        status: "active",
        $or: [{ expiresAt: { $lte: cutoff } }, { updatedAt: { $lt: addDays(cutoff, -180) } }],
      },
      { $set: { status: "archived" } }
    ),
  ]);

  return {
    archivedDayContexts: Number(dayContexts.modifiedCount || 0),
    archivedOpportunities: Number(opportunities.modifiedCount || 0),
    archivedFacts: Number(facts.modifiedCount || 0),
    archivedEvaluations: Number(evaluations.modifiedCount || 0),
  };
}

async function getJrCmoBriefing({ now = new Date(), forceRefresh = true } = {}) {
  const currentDayKey = dayKey(now);
  const refresh = forceRefresh
    ? await refreshJrCmoLibrary({ now })
    : null;

  const [dayContext, opportunities, facts, evaluation, latestLinkedInPacket, recentLinkedInPackets, pendingReviewCount] = await Promise.all([
    refresh?.dayContext
      ? Promise.resolve(refresh.dayContext)
      : MarketingDayContext.findOne({ dayKey: currentDayKey, status: "active" }).lean(),
    MarketingOpportunity.find({ status: "active" })
      .limit(12)
      .lean(),
    MarketingFact.find({ status: "active", safetyStatus: "approved" })
      .sort({ freshnessScore: -1, updatedAt: -1 })
      .limit(12)
      .lean(),
    MarketingEvaluation.findOne({ status: "active", evaluationType: "weekly" })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean(),
    refresh?.latestLinkedInPacket
      ? Promise.resolve(refresh.latestLinkedInPacket)
      : MarketingDraftPacket.findOne({ workflowType: "linkedin_company_post" })
          .sort({ createdAt: -1, updatedAt: -1 })
          .select("workflowType contentLane approvalState createdAt updatedAt")
          .lean(),
    refresh?.cadence
      ? Promise.resolve([])
      : MarketingDraftPacket.find({ workflowType: "linkedin_company_post" })
          .sort({ createdAt: -1, updatedAt: -1 })
          .limit(12)
          .select("workflowType contentLane approvalState createdAt updatedAt")
          .lean(),
    typeof refresh?.pendingReviewCount === "number"
      ? Promise.resolve(refresh.pendingReviewCount)
      : MarketingDraftPacket.countDocuments({ approvalState: "pending_review" }),
  ]);

  return {
    dayContext,
    opportunities: sortOpportunities(opportunities),
    facts,
    evaluation,
    cadence: refresh?.cadence || summarizeLinkedInCompanyCadence(recentLinkedInPackets),
    latestLinkedInPacket,
    pendingReviewCount: typeof refresh?.pendingReviewCount === "number" ? refresh.pendingReviewCount : pendingReviewCount,
    signalMeta: refresh?.signalMeta || {},
  };
}

module.exports = {
  cleanupJrCmoLibrary,
  getJrCmoBriefing,
  refreshJrCmoLibrary,
  toneForDay,
};
