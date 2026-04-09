const ApprovalTask = require("../../models/ApprovalTask");
const MarketingBrief = require("../../models/MarketingBrief");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const { buildMarketingContext } = require("../knowledge/retrievalService");
const { publishEventSafe } = require("../lpcEvents/publishEventService");
const { buildLinkedInCompanyPacketStrategy } = require("./linkedinCompanyStrategy");

function uniqueList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function flattenCardClaims(cards = []) {
  return uniqueList(cards.flatMap((card) => card.claimsToAvoid || []));
}

function summarizeCards(cards = [], limit = 6) {
  return cards.slice(0, limit).map((card) => ({
    title: card.title,
    domain: card.domain,
    summary: card.summary || card.statement || card.approvedResponse || "",
    statement: card.statement || card.approvedResponse || "",
    citations: card.citations || [],
  }));
}

function collectCitations(cards = []) {
  return uniqueList(
    cards.flatMap((card) =>
      (card.citations || []).map((citation) =>
        JSON.stringify({
          sourceKey: citation.sourceKey,
          label: citation.label,
          filePath: citation.filePath,
          excerpt: citation.excerpt,
          locator: citation.locator,
        })
      )
    )
  ).map((serialized) => JSON.parse(serialized));
}

function buildFounderVoiceNotes(founderVoiceCards = []) {
  const rules = uniqueList(founderVoiceCards.flatMap((card) => card.rules || []));
  return rules.slice(0, 6);
}

function pickValueStatement(cards = []) {
  return cards[0]?.statement || cards[0]?.summary || "";
}

function buildLinkedInHooks(context, brief) {
  const base = [];
  const positioning = context.positioningCards[0]?.statement || context.positioningCards[0]?.summary;
  const distinctiveness = context.distinctivenessCards[0]?.statement || context.distinctivenessCards[0]?.summary;
  const audienceValue = pickValueStatement(context.valueCards);
  const summary = String(brief.briefSummary || "").trim();

  if (summary) base.push(summary);
  if (positioning) base.push(positioning);
  if (distinctiveness) base.push(distinctiveness);
  if (audienceValue) base.push(audienceValue);

  return uniqueList(
    base.map((entry) => {
      const clean = String(entry || "").trim();
      if (!clean) return "";
      return clean.endsWith(".") ? clean : `${clean}.`;
    })
  ).slice(0, 4);
}

function buildAnnouncementHooks(context, brief) {
  const hooks = [];
  if (brief.updateFacts?.length) hooks.push(`Platform update: ${brief.updateFacts[0]}.`);
  if (context.distinctivenessCards[0]?.statement) hooks.push(context.distinctivenessCards[0].statement);
  if (context.positioningCards[0]?.statement) hooks.push(context.positioningCards[0].statement);
  return uniqueList(hooks).slice(0, 4);
}

function buildCtaOptions(workflowType, brief) {
  const preferred = String(brief.ctaPreference || "").trim();
  const defaults =
    workflowType === "founder_linkedin_post" || workflowType === "linkedin_company_post"
      ? [
          "Invite the right attorneys or paralegals to take a closer look.",
          "Prompt readers to learn how LPC works before making claims about outcomes.",
          "Keep the CTA restrained and fit-focused.",
        ]
      : workflowType === "facebook_page_post"
        ? [
            "Invite readers to learn more in a measured, factual way.",
            "Keep the CTA restrained and informational.",
            "Avoid hype or urgency language.",
          ]
      : [
          "Invite readers to review the update in a measured, factual way.",
          "Keep the CTA operational, not hype-driven.",
          "If timing or scope is still changing, use a soft CTA instead of a launch claim.",
        ];
  return uniqueList([preferred, ...defaults]).slice(0, 4);
}

function buildLinkedInCompanyCtaOptions(brief, strategy = {}) {
  const preferred = String(brief.ctaPreference || "").trim();
  return uniqueList([preferred, ...(strategy.ctaOptions || [])]).slice(0, 4);
}

function buildOpenQuestions(brief = {}, context = {}) {
  const questions = [];
  if (!String(brief.targetAudience || "").trim()) {
    questions.push("Confirm the primary audience before finalizing the draft.");
  }
  if (!String(brief.objective || "").trim()) {
    questions.push("Confirm the primary objective so the CTA can stay tight.");
  }
  if (brief.workflowType === "platform_update_announcement" && !(brief.updateFacts || []).length) {
    questions.push("Add the concrete update facts Samantha wants included.");
  }
  if (!context.factCards.length) {
    questions.push("Confirm whether more approved fact cards should be seeded before expanding this workflow.");
  }
  return questions;
}

function buildWhatNeedsSamantha(brief = {}) {
  const items = [
    "Approve the final claim set before any external use.",
    "Select the final hook and CTA.",
    "Approve the final founder-voice framing.",
  ];
  if (brief.workflowType === "linkedin_company_post" || brief.workflowType === "facebook_page_post") {
    items.push("Confirm the final company/page-safe framing before any publish action is taken.");
  }
  if (brief.workflowType === "platform_update_announcement") {
    items.push("Confirm whether the update is ready for external announcement and whether any timing language should be softened.");
  }
  return items;
}

function buildLinkedInCompanyNeedsSamantha(brief = {}, strategy = {}) {
  return uniqueList([
    ...buildWhatNeedsSamantha(brief),
    "Confirm that the post earns a follow from the LPC page audience instead of reading like one-off promotion.",
    `Confirm the ${String(strategy.contentLane || "platform_explanation").replace(/_/g, " ")} lane is the right fit for this draft.`,
  ]);
}

function buildMessageHierarchy(context, brief) {
  const firstFact = context.factCards[0]?.statement || context.positioningCards[0]?.statement || "";
  const distinctiveness = context.distinctivenessCards[0]?.statement || "";
  const value = pickValueStatement(context.valueCards);
  return uniqueList([
    firstFact,
    distinctiveness,
    value,
    String(brief.objective || "").trim(),
  ]).slice(0, 4);
}

function buildAlternateAngles(context) {
  return uniqueList([
    ...context.distinctivenessCards.map((card) => card.statement || card.summary),
    ...context.valueCards.map((card) => card.statement || card.summary),
    ...context.objectionCards.map((card) => card.approvedResponse || card.summary),
  ]).slice(0, 6);
}

function buildLinkedInDraft({ brief, context, hooks, ctas }) {
  const opening = hooks[0] || "LPC is built for a specific kind of professional work.";
  const detail = context.distinctivenessCards[0]?.statement || context.positioningCards[0]?.statement || "";
  const value = pickValueStatement(context.valueCards);
  const fact = context.factCards[0]?.statement || "";
  const updateFacts = (brief.updateFacts || []).slice(0, 2).join(" ");

  return {
    channel: brief.workflowType === "linkedin_company_post" ? "linkedin_company" : "linkedin",
    format: brief.workflowType === "linkedin_company_post" ? "company_page_post_packet" : "founder_post_packet",
    openingHook: opening,
    body: uniqueList([opening, detail, value, fact, updateFacts])
      .filter(Boolean)
      .join("\n\n"),
    closingCta: ctas[0] || "",
  };
}

function buildLinkedInCompanyDraft({ brief, strategy }) {
  const body = uniqueList([
    strategy.primaryHook,
    strategy.coreMessage,
    strategy.pageFollowFrame,
  ])
    .filter(Boolean)
    .join("\n\n");

  return {
    channel: "linkedin_company",
    format: "company_page_post_packet",
    contentLane: strategy.contentLane,
    growthObjective: strategy.growthObjective,
    primaryHook: strategy.primaryHook,
    alternateHooks: strategy.alternateHooks,
    coreMessage: strategy.coreMessage,
    openingHook: strategy.primaryHook,
    body,
    followOrientedCtaOptions: strategy.ctaOptions,
    closingCta: strategy.ctaOptions[0] || "",
    approvedPositioningBlocksUsed: strategy.approvedPositioningBlocksUsed,
    whyThisHelpsPageGrowth: strategy.whyThisHelpsPageGrowth,
  };
}

function buildFacebookDraft({ brief, context, hooks, ctas }) {
  const opening = hooks[0] || "LPC is built for a specific kind of professional work.";
  const detail = context.distinctivenessCards[0]?.statement || context.positioningCards[0]?.statement || "";
  const value = pickValueStatement(context.valueCards);
  const fact = context.factCards[0]?.statement || "";

  return {
    channel: "facebook_page",
    format: "page_post_packet",
    openingHook: opening,
    body: uniqueList([opening, detail, value, fact])
      .filter(Boolean)
      .join("\n\n"),
    closingCta: ctas[0] || "",
  };
}

function buildAnnouncementDraft({ brief, context, hooks, ctas }) {
  const headline = hooks[0] || "Platform update";
  const value = pickValueStatement(context.valueCards);
  const facts = (brief.updateFacts || []).slice(0, 4);
  return {
    channel: "platform_update_announcement",
    format: "announcement_packet",
    headline,
    body: uniqueList([
      headline,
      value,
      ...facts,
      context.factCards[0]?.statement || "",
    ])
      .filter(Boolean)
      .join("\n\n"),
    closingCta: ctas[0] || "",
  };
}

async function createMarketingApprovalTask({ packet, brief, actor }) {
  const existing = await ApprovalTask.findOne({
    taskType: "marketing_review",
    targetType: "marketing_draft_packet",
    targetId: String(packet._id),
    approvalState: "pending",
  }).lean();
  if (existing) return existing;

  const task = await ApprovalTask.create({
    taskType: "marketing_review",
    targetType: "marketing_draft_packet",
    targetId: String(packet._id),
    parentType: "MarketingBrief",
    parentId: String(brief._id),
    title: `Review marketing draft packet: ${brief.title}`,
    summary: `A ${brief.workflowType} packet is awaiting Samantha approval.`,
    approvalState: "pending",
    requestedBy: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Marketing Draft Service",
    },
    assignedOwnerLabel: "Samantha",
    metadata: {
      workflowType: brief.workflowType,
      packetVersion: packet.packetVersion,
    },
  });

  await publishEventSafe({
    eventType: "approval.requested",
    eventFamily: "approval",
    idempotencyKey: `approval-task:${task._id}:requested`,
    correlationId: `marketing:${brief._id}`,
    actor: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Marketing Draft Service",
    },
    subject: {
      entityType: "approval_task",
      entityId: String(task._id),
    },
    related: {
      approvalTaskId: task._id,
      marketingBriefId: brief._id,
      marketingDraftPacketId: packet._id,
    },
    source: {
      surface: "system",
      route: "",
      service: "marketing",
      producer: "service",
    },
    facts: {
      title: task.title,
      summary: task.summary,
      approvalTargetType: task.targetType,
      approvalTargetId: task.targetId,
      ownerLabel: task.assignedOwnerLabel || "Samantha",
    },
    signals: {
      confidence: "high",
      priority: "high",
      founderVisible: true,
      approvalRequired: true,
      publicFacing: true,
    },
  });

  return task;
}

async function generateDraftPacket({ briefId, actor = {} } = {}) {
  const brief = await MarketingBrief.findById(briefId);
  if (!brief) {
    throw new Error("Marketing brief not found.");
  }

  const context = await buildMarketingContext({
    workflowType: brief.workflowType,
    targetAudience: brief.targetAudience,
  });
  const latestPacket = await MarketingDraftPacket.findOne({ briefId: brief._id })
    .sort({ packetVersion: -1 })
    .select("packetVersion")
    .lean();
  const packetVersion = Number(latestPacket?.packetVersion || 0) + 1;
  const linkedinCompanyStrategy =
    brief.workflowType === "linkedin_company_post"
      ? buildLinkedInCompanyPacketStrategy({
          brief,
          context,
          fallbackLane: brief.contentLane,
        })
      : null;

  if (brief.workflowType === "linkedin_company_post" && brief.contentLane !== linkedinCompanyStrategy.contentLane) {
    brief.contentLane = linkedinCompanyStrategy.contentLane;
  }

  const hooks =
    brief.workflowType === "platform_update_announcement"
      ? buildAnnouncementHooks(context, brief)
      : brief.workflowType === "linkedin_company_post"
        ? [linkedinCompanyStrategy.primaryHook, ...(linkedinCompanyStrategy.alternateHooks || [])]
      : buildLinkedInHooks(context, brief);
  const ctas =
    brief.workflowType === "linkedin_company_post"
      ? buildLinkedInCompanyCtaOptions(brief, linkedinCompanyStrategy)
      : buildCtaOptions(brief.workflowType, brief);
  const founderVoiceNotes = buildFounderVoiceNotes(context.founderVoiceCards);
  const factCards = summarizeCards(
    [
      ...context.factCards,
      ...context.positioningCards,
      ...context.distinctivenessCards,
      ...context.valueCards,
    ],
    6
  );
  const channelDraft =
    brief.workflowType === "platform_update_announcement"
      ? buildAnnouncementDraft({ brief, context, hooks, ctas })
      : brief.workflowType === "facebook_page_post"
        ? buildFacebookDraft({ brief, context, hooks, ctas })
      : brief.workflowType === "linkedin_company_post"
        ? buildLinkedInCompanyDraft({ brief, strategy: linkedinCompanyStrategy })
      : buildLinkedInDraft({ brief, context, hooks, ctas });
  const claimsToAvoid = uniqueList([
    ...flattenCardClaims(context.claimGuardrails),
    ...flattenCardClaims(context.founderVoiceCards),
    ...(linkedinCompanyStrategy?.laneSpecificClaimsToAvoid || []),
  ]).slice(0, 12);

  const packet = await MarketingDraftPacket.create({
    briefId: brief._id,
    workflowType: brief.workflowType,
    channelKey: brief.channelKey || (brief.workflowType === "facebook_page_post" ? "facebook_page" : "linkedin_company"),
    packetVersion,
    approvalState: "pending_review",
    briefSummary: brief.briefSummary,
    targetAudience: brief.targetAudience,
    contentLane: linkedinCompanyStrategy?.contentLane || "",
    growthObjective: linkedinCompanyStrategy?.growthObjective || "",
    whyThisHelpsPageGrowth: linkedinCompanyStrategy?.whyThisHelpsPageGrowth || "",
    approvedPositioningBlocksUsed: linkedinCompanyStrategy?.approvedPositioningBlocksUsed || [],
    messageHierarchy: buildMessageHierarchy(context, brief),
    approvedFactCards: factCards,
    claimsToAvoid,
    channelDraft,
    alternateAngles: uniqueList([
      ...buildAlternateAngles(context),
      ...(linkedinCompanyStrategy?.approvedPositioningBlocksUsed || []).map((block) => block.statement || ""),
    ]).slice(0, 6),
    hookOptions: hooks,
    ctaOptions: ctas,
    founderVoiceNotes,
    openQuestions: buildOpenQuestions(brief, context),
    citations: collectCitations([
      ...context.factCards,
      ...context.positioningCards,
      ...context.distinctivenessCards,
      ...context.valueCards,
      ...context.founderVoiceCards,
      ...context.claimGuardrails,
    ]),
    whatStillNeedsSamantha:
      brief.workflowType === "linkedin_company_post"
        ? buildLinkedInCompanyNeedsSamantha(brief, linkedinCompanyStrategy)
        : buildWhatNeedsSamantha(brief),
    generatedBy: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Marketing Draft Service",
    },
    packetSummary:
      brief.workflowType === "platform_update_announcement"
        ? "Draft platform update announcement packet awaiting Samantha review."
        : brief.workflowType === "facebook_page_post"
          ? "Draft Facebook Page post packet awaiting Samantha review."
          : brief.workflowType === "linkedin_company_post"
            ? "Draft LinkedIn company post packet awaiting Samantha review."
        : "Draft founder LinkedIn packet awaiting Samantha review.",
    metadata: {
      publishReadiness: {
        status: brief.workflowType === "linkedin_company_post" ? "pending_check" : "not_configured",
        note:
          brief.workflowType === "linkedin_company_post"
            ? "Run publish readiness before any LinkedIn company publish."
            : "Facebook Page publishing is not implemented yet.",
      },
    },
  });

  brief.approvalState = "in_queue";
  await brief.save();

  await createMarketingApprovalTask({
    packet,
    brief,
    actor: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Marketing Draft Service",
    },
  });

  return packet.toObject ? packet.toObject() : packet;
}

async function ensureDraftPacketForBrief({ briefId, actor = {} } = {}) {
  const existing = await MarketingDraftPacket.findOne({ briefId })
    .sort({ packetVersion: -1, createdAt: -1 })
    .lean();
  if (existing) {
    const brief = await MarketingBrief.findById(briefId).lean();
    if (brief) {
      await createMarketingApprovalTask({
        packet: existing,
        brief,
        actor: {
          actorType: actor.actorType || "system",
          userId: actor.userId || null,
          label: actor.label || "Marketing Draft Service",
        },
      });
    }
    return existing;
  }

  return generateDraftPacket({ briefId, actor });
}

module.exports = {
  ensureDraftPacketForBrief,
  generateDraftPacket,
};
