const { buildMarketingContext } = require("../knowledge/retrievalService");
const {
  buildLinkedInCompanyPacketStrategy,
} = require("./linkedinCompanyStrategy");
const { getJrCmoBriefing } = require("./jrCmoResearchService");

const DEFAULT_TARGET_AUDIENCE = "approved attorneys and paralegals";
const OPPORTUNITY_TYPE_SCORES = Object.freeze({
  lane_gap: 70,
  fresh_explainer: 82,
  fresh_positioning: 84,
  fresh_update: 92,
  evaluation_learning: 56,
  queue_hold: -100,
  cadence_fallback: 48,
});
const OPPORTUNITY_PRIORITY_SCORES = Object.freeze({
  recommended: 20,
  candidate: 10,
  watch: 0,
  hold: -100,
});

function compactText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function uniqueList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function laneDisplayName(contentLane = "") {
  if (contentLane === "standards_positioning") return "Standards / Positioning";
  if (contentLane === "updates_momentum") return "Updates / Momentum";
  return "Platform Explanation";
}

function hoursSince(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - date.getTime()) / (1000 * 60 * 60));
}

function hasUsableMarketingContext(context = {}) {
  return Boolean(
    (context.positioningCards || []).length ||
      (context.distinctivenessCards || []).length ||
      (context.valueCards || []).length ||
      (context.factCards || []).length
  );
}

function factText(fact = {}) {
  return [fact.title, fact.summary, fact.statement].join(" ").toLowerCase();
}

function isMomentumFact(fact = {}) {
  return /\b(update|milestone|progress|rolled out|release|released|improved|improvement|shipped|launch|live|new capability|tightened)\b/.test(
    factText(fact)
  );
}

function laneForOpportunity(opportunity = {}, cadence = {}, options = {}) {
  const explicitLane = String(opportunity.contentLane || "").trim();
  if (explicitLane) return explicitLane;

  if (opportunity.opportunityType === "fresh_update") return "updates_momentum";
  if (opportunity.opportunityType === "fresh_positioning") return "standards_positioning";
  if (opportunity.opportunityType === "fresh_explainer") return "platform_explanation";

  return selectAgenticLinkedInCompanyLane(cadence, options);
}

function factsForLane(facts = [], lane = "") {
  const matching = (Array.isArray(facts) ? facts : []).filter(
    (fact) => Array.isArray(fact.contentLaneHints) && fact.contentLaneHints.includes(lane)
  );
  if (lane === "updates_momentum") {
    return matching.filter((fact) => isMomentumFact(fact));
  }
  return matching;
}

function selectAgenticLinkedInCompanyLane(cadence = {}, options = {}) {
  const allowUpdates = options.allowUpdates === true;
  const countsByLane = cadence.countsByLane || {};
  const candidates = allowUpdates
    ? ["platform_explanation", "standards_positioning", "updates_momentum"]
    : ["platform_explanation", "standards_positioning"];

  return candidates.reduce((bestLane, lane) => {
    if (!bestLane) return lane;
    if (Number(countsByLane[lane] || 0) < Number(countsByLane[bestLane] || 0)) return lane;
    return bestLane;
  }, "platform_explanation");
}

function buildAgenticTopicPlan({ jrBriefing = {}, context = {} } = {}) {
  const cadence = jrBriefing.cadence || {};
  const facts = Array.isArray(jrBriefing.facts) ? jrBriefing.facts : [];
  const opportunities = Array.isArray(jrBriefing.opportunities) ? jrBriefing.opportunities : [];

  const baseCandidates = opportunities
    .filter((opportunity) => String(opportunity.priority || "").trim() !== "hold")
    .map((opportunity) => {
      const selectedLane = laneForOpportunity(opportunity, cadence, {
        allowUpdates: factsForLane(facts, "updates_momentum").length >= 2,
      });
      const supportingFacts = factsForLane(facts, selectedLane).slice(0, 3);
      const updateReady = selectedLane !== "updates_momentum" || supportingFacts.length >= 2;
      const score =
        (OPPORTUNITY_TYPE_SCORES[opportunity.opportunityType] ?? 40) +
        (OPPORTUNITY_PRIORITY_SCORES[opportunity.priority] ?? 0) +
        (cadence.suggestedNextLane === selectedLane ? 12 : 0) +
        (supportingFacts.length >= 2 ? 8 : supportingFacts.length === 1 ? 3 : -12) +
        (selectedLane === "updates_momentum" && !updateReady ? -120 : 0);

      return {
        score,
        selectedLane,
        supportingFacts,
        updateReady,
        opportunity,
        planningReason: compactText(
          [
            opportunity.rationale,
            supportingFacts.length
              ? `${supportingFacts.length} approved fact${supportingFacts.length === 1 ? "" : "s"} support this lane.`
              : "Fact support is currently thin.",
            cadence.suggestedNextLane === selectedLane
              ? `This also matches the current cadence gap in ${laneDisplayName(selectedLane)}.`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
          1000
        ),
      };
    });

  const fallbackLane = selectAgenticLinkedInCompanyLane(cadence, {
    allowUpdates: factsForLane(facts, "updates_momentum").length >= 2,
  });
  const fallbackFacts = factsForLane(facts, fallbackLane).slice(0, 3);
  baseCandidates.push({
    score: (OPPORTUNITY_TYPE_SCORES.cadence_fallback || 0) + (fallbackFacts.length ? 6 : -10),
    selectedLane: fallbackLane,
    supportingFacts: fallbackFacts,
    updateReady: fallbackLane !== "updates_momentum" || fallbackFacts.length >= 2,
    opportunity: {
      opportunityKey: "",
      opportunityType: "cadence_fallback",
      priority: "watch",
      title: `${laneDisplayName(fallbackLane)} cadence fallback`,
      summary: cadence.summary || "Cadence suggests this lane should be refreshed next.",
      rationale: cadence.recommendations?.[0] || "",
    },
    planningReason: compactText(
      `${cadence.summary || "Cadence analysis selected this lane."} ${
        fallbackFacts.length ? `${fallbackFacts.length} approved facts can support the draft.` : "Fact support is currently limited."
      }`,
      1000
    ),
  });

  const candidates = baseCandidates.sort((left, right) => right.score - left.score);
  const best = candidates[0] || null;
  if (!best) {
    return {
      ok: false,
      reason: "no_topic_candidates",
      message: "The Jr. CMO has not surfaced a credible topic candidate yet.",
      decision: { cadence, candidateCount: 0 },
    };
  }

  if (best.selectedLane === "updates_momentum" && !best.updateReady) {
    return {
      ok: false,
      reason: "insufficient_update_support",
      message: "The CMO agent is holding because momentum posting is not yet supported by enough concrete update facts.",
      decision: {
        selectedLane: best.selectedLane,
        opportunityKey: best.opportunity.opportunityKey || "",
        supportingFactCount: best.supportingFacts.length,
      },
    };
  }

  if (!best.supportingFacts.length && !hasUsableMarketingContext(context)) {
    return {
      ok: false,
      reason: "insufficient_signal_quality",
      message: "The CMO agent is holding because the current topic candidates are too weakly supported.",
      decision: {
        selectedLane: best.selectedLane,
        opportunityKey: best.opportunity.opportunityKey || "",
        supportingFactCount: 0,
      },
    };
  }

  return {
    ok: true,
    selectedLane: best.selectedLane,
    selectedOpportunity: best.opportunity,
    supportingFacts: best.supportingFacts,
    planningReason: best.planningReason,
    candidateCount: candidates.length,
  };
}

function evaluateAgenticQueueReadiness({
  cadence = {},
  pendingReviewCount = 0,
  latestLinkedInPacket = null,
  selectedLane = "",
} = {}) {
  if (Number(pendingReviewCount || 0) > 0) {
    return {
      ok: false,
      reason: "pending_review_backlog",
      message: "The CMO agent is holding because Samantha still has marketing packets awaiting review.",
    };
  }

  const latestAgeHours = hoursSince(latestLinkedInPacket?.createdAt || latestLinkedInPacket?.updatedAt);
  const latestLane = String(latestLinkedInPacket?.contentLane || "").trim();

  if (latestLane && selectedLane && latestLane === selectedLane && latestAgeHours < 36) {
    return {
      ok: false,
      reason: "repeat_lane_too_soon",
      message: `The CMO agent is holding because ${laneDisplayName(selectedLane)} ran recently and repeating it now would be too thin.`,
    };
  }

  if (cadence.isHealthyMix === true && Number.isFinite(latestAgeHours) && latestAgeHours < 72) {
    return {
      ok: false,
      reason: "healthy_queue_recently_served",
      message: "The recent LinkedIn company queue is already healthy, so the CMO agent is not forcing another draft yet.",
    };
  }

  return { ok: true };
}

async function buildAgenticScheduledCycleInput() {
  const [context, jrBriefing] = await Promise.all([
    buildMarketingContext({
      workflowType: "linkedin_company_post",
      targetAudience: DEFAULT_TARGET_AUDIENCE,
    }),
    getJrCmoBriefing({ forceRefresh: true }),
  ]);

  if (!hasUsableMarketingContext(context)) {
    return {
      ok: false,
      reason: "knowledge_unavailable",
      message: "The CMO agent needs approved marketing knowledge before it can generate a brief.",
    };
  }

  const cadence = jrBriefing.cadence || {};
  const latestLinkedInPacket = jrBriefing.latestLinkedInPacket || null;
  const pendingReviewCount = Number(jrBriefing.pendingReviewCount || 0);
  const topicPlan = buildAgenticTopicPlan({ jrBriefing, context });
  if (!topicPlan.ok) {
    return topicPlan;
  }
  const selectedOpportunity = topicPlan.selectedOpportunity || null;
  const contentLane = topicPlan.selectedLane;
  const queueDecision = evaluateAgenticQueueReadiness({
    cadence,
    pendingReviewCount,
    latestLinkedInPacket,
    selectedLane: contentLane,
  });
  if (!queueDecision.ok) {
    return {
      ok: false,
      reason: queueDecision.reason,
      message: queueDecision.message,
      decision: {
        selectedLane: contentLane,
        pendingReviewCount,
        latestLinkedInPacket: latestLinkedInPacket
          ? {
              contentLane: latestLinkedInPacket.contentLane || "",
              approvalState: latestLinkedInPacket.approvalState || "",
              createdAt: latestLinkedInPacket.createdAt || null,
            }
          : null,
        cadence,
      },
    };
  }

  const strategy = buildLinkedInCompanyPacketStrategy({
    brief: {
      contentLane,
      targetAudience: DEFAULT_TARGET_AUDIENCE,
    },
    context,
    fallbackLane: contentLane,
  });
  const toneRecommendation = String(jrBriefing.dayContext?.toneRecommendation || "measured").trim() || "measured";
  const toneReasoning = compactText(jrBriefing.dayContext?.toneReasoning || "", 500);
  const dayClimateSummary = compactText(jrBriefing.dayContext?.industryClimateSummary || "", 600);
  const selectedFacts = topicPlan.supportingFacts || [];
  const factStatements = selectedFacts.map((fact) => fact.statement || fact.summary).filter(Boolean).slice(0, 2);
  const selectedFactTitles = selectedFacts.map((fact) => fact.title).filter(Boolean).slice(0, 3);
  const whyNow = compactText(
    uniqueList([
      selectedOpportunity?.summary,
      selectedOpportunity?.rationale,
      topicPlan.planningReason,
    ]).join(" "),
    1000
  );

  const briefSummary = uniqueList([
    selectedOpportunity?.title ? `Priority for today: ${selectedOpportunity.title}.` : "",
    `Use a ${toneRecommendation.replace(/_/g, " ")} tone for today's context.`,
    dayClimateSummary,
    toneReasoning,
    whyNow,
    strategy.primaryHook,
    strategy.coreMessage,
    strategy.pageFollowFrame,
    ...factStatements,
  ]).join(" ");

  return {
    ok: true,
    plan: {
      cycleLabel: compactText(
        `CMO Agent · ${laneDisplayName(strategy.contentLane)}${selectedOpportunity?.title ? ` · ${selectedOpportunity.title}` : ""}`,
        240
      ),
      targetAudience: DEFAULT_TARGET_AUDIENCE,
      objective: compactText(strategy.growthObjective, 1000),
      briefSummary: compactText(briefSummary, 8000),
      ctaPreference: compactText(strategy.ctaOptions[0] || "", 500),
      linkedinCompanyContentLane: strategy.contentLane,
      updateFacts: factStatements,
      rationale: strategy.whyThisHelpsPageGrowth,
      whyNow,
      dayClimateSummary,
      toneRecommendation,
      toneReasoning,
      researchMode: jrBriefing.dayContext?.sourceMode || "internal_only",
      opportunityKey: selectedOpportunity?.opportunityKey || "",
      opportunityType: selectedOpportunity?.opportunityType || "",
      selectedOpportunityTitle: selectedOpportunity?.title || "",
      plannerReasoning: topicPlan.planningReason,
      selectedFactTitles,
      recentLaneCounts: cadence.countsByLane,
      pendingReviewCount,
    },
  };
}

module.exports = {
  buildAgenticScheduledCycleInput,
  buildAgenticTopicPlan,
  evaluateAgenticQueueReadiness,
  selectAgenticLinkedInCompanyLane,
};
