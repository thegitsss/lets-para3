const { MARKETING_LINKEDIN_COMPANY_CONTENT_LANES } = require("./constants");

const LANE_ORDER = [...MARKETING_LINKEDIN_COMPANY_CONTENT_LANES];
const BANNED_HYPE_PATTERNS = /\b(guarantee|guaranteed|viral|dominate|best|must-read|game-changing|revolutionary)\b/i;

function uniqueList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeLinkedInCompanyContentLane(value = "") {
  const next = String(value || "").trim();
  return MARKETING_LINKEDIN_COMPANY_CONTENT_LANES.includes(next) ? next : "";
}

function laneLabel(contentLane = "") {
  if (contentLane === "standards_positioning") return "standards / positioning";
  if (contentLane === "updates_momentum") return "updates / momentum";
  return "platform explanation";
}

function growthObjectiveForLane(contentLane = "") {
  if (contentLane === "standards_positioning") {
    return "Build credibility and explain why LPC is distinct.";
  }
  if (contentLane === "updates_momentum") {
    return "Give attorneys and paralegals a reason to come back to the LPC page.";
  }
  return "Make the LPC page worth following through clear platform explanation.";
}

function compactSentence(value = "", fallback = "") {
  const text = String(value || fallback || "").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function compactAudienceLabel(targetAudience = "") {
  const audience = String(targetAudience || "").toLowerCase();
  if (audience.includes("attorney") && audience.includes("paralegal")) return "attorneys and paralegals";
  if (audience.includes("attorney")) return "attorneys";
  if (audience.includes("paralegal")) return "paralegals";
  return "attorneys and paralegals";
}

function combinedSignalText({ brief = {} } = {}) {
  return [
    brief.title,
    brief.objective,
    brief.briefSummary,
    ...(Array.isArray(brief.updateFacts) ? brief.updateFacts : []),
  ]
    .join(" ")
    .toLowerCase();
}

function deriveLinkedInCompanyContentLane({ brief = {}, fallbackLane = "" } = {}) {
  const explicit = normalizeLinkedInCompanyContentLane(brief.contentLane);
  if (explicit) return explicit;

  const signalText = combinedSignalText({ brief });
  const hasUpdates = Array.isArray(brief.updateFacts) && brief.updateFacts.length > 0;

  if (
    hasUpdates ||
    /\b(update|momentum|shipping|shipped|progress|milestone|release|rolled out|now live|new capability|tightened|improved)\b/.test(
      signalText
    )
  ) {
    return "updates_momentum";
  }

  if (
    /\b(standard|positioning|distinct|credibility|fit|discipline|disciplined|selective|premium|bar|quality|not for everyone)\b/.test(
      signalText
    )
  ) {
    return "standards_positioning";
  }

  if (
    /\b(explain|explainer|what lpc is|what lpc does|how lpc works|how the platform works|why lpc|platform|workflow|introduction)\b/.test(
      signalText
    )
  ) {
    return "platform_explanation";
  }

  return normalizeLinkedInCompanyContentLane(fallbackLane) || "platform_explanation";
}

function chooseNextLinkedInCompanyContentLane(packets = []) {
  const summary = summarizeLinkedInCompanyCadence(packets);
  return summary.suggestedNextLane;
}

function summarizeLinkedInCompanyCadence(packets = []) {
  const countsByLane = MARKETING_LINKEDIN_COMPANY_CONTENT_LANES.reduce((acc, lane) => {
    acc[lane] = 0;
    return acc;
  }, {});

  const linkedinPackets = (Array.isArray(packets) ? packets : []).filter(
    (packet) => packet && packet.workflowType === "linkedin_company_post"
  );

  for (const packet of linkedinPackets) {
    const lane = normalizeLinkedInCompanyContentLane(packet.contentLane) || "platform_explanation";
    countsByLane[lane] += 1;
  }

  const total = Object.values(countsByLane).reduce((sum, value) => sum + value, 0);
  const missingLanes = LANE_ORDER.filter((lane) => countsByLane[lane] === 0);
  const suggestedNextLane = LANE_ORDER.reduce((bestLane, lane) => {
    if (!bestLane) return lane;
    if (countsByLane[lane] < countsByLane[bestLane]) return lane;
    return bestLane;
  }, "");
  const dominantLane = LANE_ORDER.reduce((bestLane, lane) => {
    if (!bestLane) return lane;
    if (countsByLane[lane] > countsByLane[bestLane]) return lane;
    return bestLane;
  }, "");

  const recommendations = [];
  if (!total) {
    recommendations.push("Start with a platform explanation post so the LPC page immediately teaches people why it exists.");
  }
  if (missingLanes.length) {
    recommendations.push(
      `The recent queue is missing ${missingLanes.map((lane) => laneLabel(lane)).join(", ")}. The next LinkedIn company draft should close that gap.`
    );
  }
  if (total >= 3 && dominantLane && countsByLane[dominantLane] >= Math.ceil(total / 2) + 1) {
    recommendations.push(
      `${laneLabel(dominantLane)} is overrepresented. Rotate the next LPC LinkedIn draft into ${laneLabel(
        suggestedNextLane
      )} so the page earns repeat follows for different reasons.`
    );
  }
  if (!recommendations.length) {
    recommendations.push("The recent LinkedIn company queue has a healthy explanation, positioning, and momentum mix.");
  }

  return {
    countsByLane,
    total,
    suggestedNextLane: suggestedNextLane || "platform_explanation",
    suggestedNextLaneLabel: laneLabel(suggestedNextLane || "platform_explanation"),
    summary:
      total === 0
        ? "No LinkedIn company packets exist yet, so the queue has no page-growth mix."
        : `Recent LinkedIn company packets: ${LANE_ORDER.map(
            (lane) => `${laneLabel(lane)} ${countsByLane[lane]}`
          ).join(" · ")}.`,
    recommendations,
    isHealthyMix: missingLanes.length === 0 && !(total >= 3 && countsByLane[dominantLane] >= Math.ceil(total / 2) + 1),
  };
}

function approvedPositioningBlocks(context = {}) {
  const blocks = [];
  const pushCards = (cards = [], type = "") => {
    for (const card of cards) {
      if (!card) continue;
      blocks.push({
        key: card.key || "",
        title: card.title || "",
        type,
        statement: card.statement || card.summary || card.approvedResponse || "",
      });
    }
  };

  pushCards((context.positioningCards || []).slice(0, 2), "positioning");
  pushCards((context.distinctivenessCards || []).slice(0, 2), "distinctiveness");
  pushCards((context.valueCards || []).slice(0, 1), "value");

  return blocks.filter((block) => block.statement).slice(0, 4);
}

function laneClaimsToAvoid(contentLane = "") {
  if (contentLane === "updates_momentum") {
    return [
      "Avoid overstating release scope, readiness, or adoption.",
      "Avoid implying product work is complete if it is still evolving.",
    ];
  }
  if (contentLane === "standards_positioning") {
    return [
      "Avoid saying LPC is for everyone or already proven at scale.",
      "Avoid superiority claims that the approved positioning does not support.",
    ];
  }
  return [
    "Avoid vague claims that explain nothing about how LPC works.",
    "Avoid promising outcomes that the approved materials do not support.",
  ];
}

function fallbackPrimaryHook(contentLane = "") {
  if (contentLane === "standards_positioning") return "LPC is being built with standards first, not volume first.";
  if (contentLane === "updates_momentum") return "LPC is continuing to take shape, and the details matter.";
  return "What LPC is building should be clear enough to be worth following.";
}

function buildHooks({ brief = {}, context = {}, contentLane = "", positioningBlocks = [] } = {}) {
  const positioning = context.positioningCards?.[0]?.statement || positioningBlocks[0]?.statement || "";
  const distinctiveness = context.distinctivenessCards?.[0]?.statement || positioningBlocks[1]?.statement || "";
  const value = context.valueCards?.[0]?.statement || "";
  const firstUpdate = brief.updateFacts?.[0] || "";
  const summary = compactSentence(brief.briefSummary);

  const hooks = [];
  if (contentLane === "updates_momentum" && firstUpdate) {
    hooks.push(compactSentence(`Platform update: ${firstUpdate}`));
    hooks.push(compactSentence("LPC is continuing to take shape, and the recent progress is worth making explicit"));
    hooks.push(compactSentence(distinctiveness));
  } else if (contentLane === "standards_positioning") {
    hooks.push(summary);
    hooks.push(compactSentence("LPC is being built with standards first, not volume first"));
    hooks.push(compactSentence(distinctiveness));
    hooks.push(compactSentence(positioning));
  } else {
    hooks.push(summary);
    hooks.push(compactSentence("What LPC is building should be clear enough to be worth following"));
    hooks.push(compactSentence(positioning));
    hooks.push(compactSentence(value));
  }

  const uniqueHooks = uniqueList(hooks).filter(Boolean);
  return {
    primaryHook: uniqueHooks[0] || fallbackPrimaryHook(contentLane),
    alternateHooks: uniqueHooks.slice(1, 4),
  };
}

function buildCoreMessage({ brief = {}, context = {}, contentLane = "", positioningBlocks = [] } = {}) {
  const positioning = context.positioningCards?.[0]?.statement || positioningBlocks[0]?.statement || "";
  const distinctiveness = context.distinctivenessCards?.[0]?.statement || positioningBlocks[1]?.statement || "";
  const value = context.valueCards?.[0]?.statement || positioningBlocks[2]?.statement || "";
  const firstFact = context.factCards?.[0]?.statement || brief.updateFacts?.[0] || "";
  const secondFact = brief.updateFacts?.[1] || "";

  if (contentLane === "updates_momentum") {
    return uniqueList([firstFact, secondFact, distinctiveness]).join(" ");
  }
  if (contentLane === "standards_positioning") {
    return uniqueList([distinctiveness, positioning, value]).join(" ");
  }
  return uniqueList([positioning, value, firstFact]).join(" ");
}

function buildFollowOrientedCtas({ brief = {}, contentLane = "" } = {}) {
  const audience = compactAudienceLabel(brief.targetAudience);
  const options =
    contentLane === "standards_positioning"
      ? [
          "Follow the LPC page for disciplined perspective on standards, fit, and how the platform is being built.",
          "Follow this page to see how LPC defines quality, selectivity, and platform discipline over time.",
          "Follow the LPC page for credible signal on what LPC is, what it is not, and why that matters.",
        ]
      : contentLane === "updates_momentum"
        ? [
            "Follow the LPC page for measured product and workflow updates as LPC continues to take shape.",
            `Follow this page for factual momentum updates that matter to ${audience}.`,
            "Follow the LPC page if you want a restrained view of what is changing and why it matters.",
          ]
        : [
            "Follow the LPC page for clear explanations of how the platform works and who it is built for.",
            "Follow this page for measured updates on platform structure, standards, and fit as LPC develops.",
            "Follow the LPC page for grounded context instead of one-off promotion.",
          ];

  return uniqueList(options.filter((option) => !BANNED_HYPE_PATTERNS.test(option)));
}

function buildWhyThisHelpsPageGrowth({ contentLane = "" } = {}) {
  if (contentLane === "standards_positioning") {
    return "It makes the LPC page a source of credible standards and positioning, not just announcements, which gives serious readers a reason to trust and return.";
  }
  if (contentLane === "updates_momentum") {
    return "It gives the LPC page a measured momentum signal, so readers have a credible reason to come back for progress instead of seeing a one-off post.";
  }
  return "It gives the LPC page a repeatable explanatory role, so following the page promises future clarity about how LPC works.";
}

function buildPageFollowFrame({ contentLane = "" } = {}) {
  if (contentLane === "standards_positioning") {
    return "The LPC page will keep documenting the standards, fit, and operating choices shaping the platform as it develops.";
  }
  if (contentLane === "updates_momentum") {
    return "The LPC page will keep sharing measured product and workflow updates so serious readers have a grounded reason to return.";
  }
  return "The LPC page will keep sharing measured explanations of how the platform works, who it is built for, and the standards behind it.";
}

function buildLinkedInCompanyPacketStrategy({ brief = {}, context = {}, fallbackLane = "" } = {}) {
  const contentLane = deriveLinkedInCompanyContentLane({ brief, fallbackLane });
  const growthObjective = growthObjectiveForLane(contentLane);
  const positioningBlocks = approvedPositioningBlocks(context);
  const hooks = buildHooks({ brief, context, contentLane, positioningBlocks });
  const coreMessage = buildCoreMessage({ brief, context, contentLane, positioningBlocks });
  const ctaOptions = buildFollowOrientedCtas({ brief, contentLane });
  const whyThisHelpsPageGrowth = buildWhyThisHelpsPageGrowth({ contentLane });
  const pageFollowFrame = buildPageFollowFrame({ contentLane });

  return {
    contentLane,
    growthObjective,
    primaryHook: hooks.primaryHook,
    alternateHooks: hooks.alternateHooks,
    coreMessage: compactSentence(coreMessage, fallbackPrimaryHook(contentLane)),
    ctaOptions,
    whyThisHelpsPageGrowth,
    pageFollowFrame,
    approvedPositioningBlocksUsed: positioningBlocks,
    laneSpecificClaimsToAvoid: laneClaimsToAvoid(contentLane),
  };
}

module.exports = {
  buildLinkedInCompanyPacketStrategy,
  chooseNextLinkedInCompanyContentLane,
  deriveLinkedInCompanyContentLane,
  growthObjectiveForLane,
  laneLabel,
  normalizeLinkedInCompanyContentLane,
  summarizeLinkedInCompanyCadence,
};
