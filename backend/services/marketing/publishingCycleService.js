const ApprovalTask = require("../../models/ApprovalTask");
const MarketingBrief = require("../../models/MarketingBrief");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const MarketingPublishingCycle = require("../../models/MarketingPublishingCycle");
const {
  MARKETING_PUBLISHING_CHANNELS,
  MARKETING_PUBLISHING_CYCLE_STATUSES,
} = require("./constants");
const { createBrief, normalizeFacts } = require("./briefService");
const { ensureDraftPacketForBrief } = require("./draftService");
const {
  chooseNextLinkedInCompanyContentLane,
  summarizeLinkedInCompanyCadence,
} = require("./linkedinCompanyStrategy");
const { buildAgenticScheduledCycleInput } = require("./cmoAgentService");
const {
  ensurePublishingSettings,
  getPublishingSettings,
  markPublishingDueSlotProcessed,
} = require("./publishingSettingsService");
const { getChannelReadinessSummary } = require("./channelConnectionService");

const OPEN_CYCLE_STATUSES = ["drafted", "awaiting_approval", "blocked", "ready_to_publish"];

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "system",
    userId: actor.userId || actor._id || actor.id || null,
    label: actor.label || actor.email || "System",
  };
}

function titleize(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function compactText(value = "", max = 240) {
  return String(value || "").trim().slice(0, max);
}

function defaultCycleLabel(date = new Date()) {
  return `Publishing cycle ${date.toISOString().slice(0, 10)}`;
}

function buildChannelPlan(channelKey, cycle = {}, triggerSource = "manual", options = {}) {
  const titleBase = compactText(cycle.cycleLabel || defaultCycleLabel(), 120);
  const targetAudience = compactText(cycle.targetAudience || "approved attorneys and paralegals", 240);
  const objective =
    compactText(
      cycle.objective ||
        "Create a restrained, governed awareness post grounded in approved LPC positioning and claims.",
      1000
    ) ||
    "Create a restrained, governed awareness post grounded in approved LPC positioning and claims.";
  const briefSummary =
    compactText(
      cycle.briefSummary ||
        "Use approved LPC knowledge to generate a premium, restrained social draft that Samantha can review before any publishing action exists.",
      8000
    ) ||
    "Use approved LPC knowledge to generate a premium, restrained social draft.";
  const updateFacts = normalizeFacts(cycle.updateFacts || []);
  const ctaPreference = compactText(cycle.ctaPreference || "", 500);

  if (channelKey === "facebook_page") {
    return {
      workflowType: "facebook_page_post",
      channelKey,
      title: `${titleBase} Facebook Page`,
      targetAudience,
      objective,
      briefSummary,
      updateFacts,
      ctaPreference,
      triggerSource,
    };
  }

  return {
    workflowType: "linkedin_company_post",
    channelKey,
    title: `${titleBase} LinkedIn Company`,
    targetAudience,
    objective,
    briefSummary,
    contentLane: options.linkedinCompanyContentLane || "",
    updateFacts,
    ctaPreference,
    triggerSource,
  };
}

async function buildChannelReadiness(channelKey = "") {
  return getChannelReadinessSummary(channelKey);
}

async function findOpenCycle(limit = 1) {
  const cycles = await MarketingPublishingCycle.find({ status: { $in: OPEN_CYCLE_STATUSES } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return limit === 1 ? cycles[0] || null : cycles;
}

async function refreshCycleLifecycle(cycleInput = {}) {
  const cycle =
    cycleInput instanceof MarketingPublishingCycle ? cycleInput : await MarketingPublishingCycle.findById(cycleInput._id || cycleInput.id);
  if (!cycle) throw new Error("Publishing cycle not found.");

  const [linkedinBrief, facebookBrief, linkedinPacket, facebookPacket] = await Promise.all([
    cycle.linkedinBriefId ? MarketingBrief.findById(cycle.linkedinBriefId).lean() : null,
    cycle.facebookBriefId ? MarketingBrief.findById(cycle.facebookBriefId).lean() : null,
    cycle.linkedinPacketId ? MarketingDraftPacket.findById(cycle.linkedinPacketId).lean() : null,
    cycle.facebookPacketId ? MarketingDraftPacket.findById(cycle.facebookPacketId).lean() : null,
  ]);

  const packetIds = [cycle.linkedinPacketId, cycle.facebookPacketId].filter(Boolean).map((value) => String(value));
  const approvalTasks = packetIds.length
    ? await ApprovalTask.find({
        taskType: "marketing_review",
        targetType: "marketing_draft_packet",
        targetId: { $in: packetIds },
      }).lean()
    : [];
  const taskByTargetId = new Map(approvalTasks.map((task) => [String(task.targetId), task]));

  const channelStates = {};
  for (const channelKey of MARKETING_PUBLISHING_CHANNELS) {
    const enabled = (cycle.settingsSnapshot?.enabledChannels || []).includes(channelKey);
    const brief = channelKey === "linkedin_company" ? linkedinBrief : facebookBrief;
    const packet = channelKey === "linkedin_company" ? linkedinPacket : facebookPacket;
    const task = packet?._id ? taskByTargetId.get(String(packet._id)) || null : null;

    const readiness = await buildChannelReadiness(channelKey);
    let status = "blocked";
    let reason = "Channel is not enabled for this cycle.";
    if (cycle.status === "skipped") {
      status = "skipped";
      reason = cycle.skipReason || "Cycle skipped.";
    } else if (!enabled) {
      status = "blocked";
      reason = "Channel disabled in publishing settings.";
    } else if (brief && !packet) {
      status = "drafted";
      reason = "Brief exists but packet generation is incomplete.";
    } else if (!brief && !packet) {
      status = "blocked";
      reason = "Channel work was not generated.";
    } else if (packet?.approvalState === "approved") {
      status = "ready_to_publish";
      reason =
        channelKey === "linkedin_company" && readiness.status === "connected_validated"
          ? "Approved and ready for explicit LinkedIn company publish."
          : "Approved and ready for explicit publish action where supported.";
    } else if (packet?.approvalState === "rejected") {
      status = "blocked";
      reason = "Packet was rejected and needs revision.";
    } else if (task?.approvalState === "pending" || packet?.approvalState === "pending_review") {
      status = "awaiting_approval";
      reason = "Awaiting Samantha approval.";
    } else {
      status = "drafted";
      reason = "Draft exists but approval state is not yet final.";
    }

    channelStates[channelKey] = {
      channelKey,
      enabled,
      briefId: brief?._id ? String(brief._id) : "",
      packetId: packet?._id ? String(packet._id) : "",
      workflowType: brief?.workflowType || "",
      contentLane: packet?.contentLane || brief?.contentLane || "",
      growthObjective: packet?.growthObjective || "",
      whyThisHelpsPageGrowth: packet?.whyThisHelpsPageGrowth || "",
      title: brief?.title || `${titleize(channelKey)} draft`,
      packetApprovalState: packet?.approvalState || "",
      approvalTaskState: task?.approvalState || "",
      status,
      reason,
      readiness,
    };
  }

  let nextStatus = "drafted";
  let statusReason = "Draft generation is in progress.";
  if (cycle.status === "skipped") {
    nextStatus = "skipped";
    statusReason = cycle.skipReason || "Cycle skipped.";
  } else {
    const enabledStates = Object.values(channelStates).filter((state) => state.enabled);
    if (!enabledStates.length) {
      nextStatus = "blocked";
      statusReason = "No publishing channels are enabled.";
    } else if (enabledStates.some((state) => state.status === "blocked")) {
      nextStatus = "blocked";
      statusReason = enabledStates.find((state) => state.status === "blocked")?.reason || "Cycle is blocked.";
    } else if (enabledStates.every((state) => state.status === "ready_to_publish")) {
      nextStatus = "ready_to_publish";
      statusReason = "All enabled channel packets are approved.";
    } else if (enabledStates.some((state) => state.status === "awaiting_approval")) {
      nextStatus = "awaiting_approval";
      statusReason = "At least one enabled channel packet is awaiting approval.";
    } else {
      nextStatus = "drafted";
      statusReason = "Cycle drafts exist but are not yet fully review-ready.";
    }
  }

  cycle.status = MARKETING_PUBLISHING_CYCLE_STATUSES.includes(nextStatus) ? nextStatus : "drafted";
  cycle.statusReason = compactText(statusReason, 500);
  cycle.lastEvaluatedAt = new Date();
  await cycle.save();

  return {
    id: String(cycle._id),
    triggerSource: cycle.triggerSource,
    dueSlotAt: cycle.dueSlotAt || null,
    cycleLabel: cycle.cycleLabel || "",
    status: cycle.status,
    statusReason: cycle.statusReason || "",
    targetAudience: cycle.targetAudience || "",
    objective: cycle.objective || "",
    briefSummary: cycle.briefSummary || "",
    updateFacts: cycle.updateFacts || [],
    ctaPreference: cycle.ctaPreference || "",
    skippedAt: cycle.skippedAt || null,
    skipReason: cycle.skipReason || "",
    settingsSnapshot: cycle.settingsSnapshot || {},
    createdAt: cycle.createdAt || null,
    updatedAt: cycle.updatedAt || null,
    channels: channelStates,
  };
}

async function createPublishingCycle({
  triggerSource = "manual",
  actor = {},
  cycleLabel = "",
  targetAudience = "",
  objective = "",
  briefSummary = "",
  updateFacts = [],
  ctaPreference = "",
  dueSlotAt = null,
  linkedinCompanyContentLane = "",
} = {}) {
  const settingsDoc = await ensurePublishingSettings();
  const openCycles = await MarketingPublishingCycle.countDocuments({ status: { $in: OPEN_CYCLE_STATUSES } });
  if (openCycles >= Number(settingsDoc.maxOpenCycles || 1)) {
    const existing = await findOpenCycle(1);
    return {
      created: false,
      reason: "open_cycle_exists",
      cycle: existing ? await refreshCycleLifecycle(existing) : null,
    };
  }

  const cycle = await MarketingPublishingCycle.create({
    triggerSource,
    dueSlotAt: dueSlotAt ? new Date(dueSlotAt) : null,
    cycleLabel: compactText(cycleLabel || defaultCycleLabel(new Date()), 240),
    status: "drafted",
    statusReason: "Draft generation is starting.",
    settingsSnapshot: {
      cadenceMode: settingsDoc.cadenceMode,
      timezone: settingsDoc.timezone,
      preferredHourLocal: settingsDoc.preferredHourLocal,
      enabledChannels: settingsDoc.enabledChannels,
      maxOpenCycles: settingsDoc.maxOpenCycles,
    },
    targetAudience: compactText(targetAudience, 240),
    objective: compactText(objective, 1000),
    briefSummary: compactText(briefSummary, 8000),
    updateFacts: normalizeFacts(updateFacts),
    ctaPreference: compactText(ctaPreference, 500),
    createdBy: toActor(actor),
  });
  const recentLinkedInPackets = await MarketingDraftPacket.find({ workflowType: "linkedin_company_post" })
    .sort({ createdAt: -1, updatedAt: -1 })
    .limit(12)
    .select("workflowType contentLane")
    .lean();
  const resolvedLinkedInCompanyContentLane =
    String(linkedinCompanyContentLane || "").trim() || chooseNextLinkedInCompanyContentLane(recentLinkedInPackets);

  try {
    for (const channelKey of settingsDoc.enabledChannels || []) {
      const channelPlan = buildChannelPlan(
        channelKey,
        {
          cycleLabel: cycle.cycleLabel,
          targetAudience: cycle.targetAudience,
          objective: cycle.objective,
          briefSummary: cycle.briefSummary,
          updateFacts: cycle.updateFacts,
          ctaPreference: cycle.ctaPreference,
        },
        triggerSource,
        {
          linkedinCompanyContentLane: resolvedLinkedInCompanyContentLane,
        }
      );
      const brief = await createBrief(
        {
          ...channelPlan,
          cycleId: cycle._id,
          channelKey,
        },
        actor
      );
      const packet = await ensureDraftPacketForBrief({
        briefId: brief._id,
        actor: toActor(actor),
      });

      if (channelKey === "linkedin_company") {
        cycle.linkedinBriefId = brief._id;
        cycle.linkedinPacketId = packet?._id || null;
      } else if (channelKey === "facebook_page") {
        cycle.facebookBriefId = brief._id;
        cycle.facebookPacketId = packet?._id || null;
      }
    }
  } catch (err) {
    cycle.status = "blocked";
    cycle.statusReason = compactText(err?.message || "Cycle generation failed.", 500);
    cycle.lastEvaluatedAt = new Date();
    await cycle.save();
    throw err;
  }

  await cycle.save();
  const hydrated = await refreshCycleLifecycle(cycle);
  return { created: true, reason: "created", cycle: hydrated };
}

async function runScheduledCycleCreation({ actor = {}, now = new Date() } = {}) {
  const settings = await getPublishingSettings();
  if (settings.isEnabled !== true) {
    return { created: false, reason: "disabled", settings, cycle: null };
  }
  if (settings.cadenceMode === "manual_only") {
    return { created: false, reason: "manual_only", settings, cycle: null };
  }
  if (settings.pauseReason) {
    return { created: false, reason: "paused", settings, cycle: null };
  }
  if (!settings.nextDueAt || new Date(settings.nextDueAt).getTime() > new Date(now).getTime()) {
    return { created: false, reason: "not_due", settings, cycle: null };
  }

  const openCycle = await findOpenCycle(1);
  if (openCycle) {
    const updatedSettings = await markPublishingDueSlotProcessed({
      dueAt: settings.nextDueAt,
      missedDueAt: settings.nextDueAt,
      now,
    });
    return {
      created: false,
      reason: "open_cycle_exists",
      settings: updatedSettings,
      cycle: await refreshCycleLifecycle(openCycle),
    };
  }

  const agenticPlan = await buildAgenticScheduledCycleInput();
  if (!agenticPlan.ok) {
    return {
      created: false,
      reason: agenticPlan.reason || "agent_not_ready",
      settings,
      cycle: null,
      agenticPlan,
    };
  }

  const result = await createPublishingCycle({
    triggerSource: "scheduled",
    actor: {
      actorType: "agent",
      userId: actor.userId || null,
      label: "Marketing CMO Agent",
    },
    dueSlotAt: settings.nextDueAt,
    cycleLabel: agenticPlan.plan.cycleLabel,
    targetAudience: agenticPlan.plan.targetAudience,
    objective: agenticPlan.plan.objective,
    briefSummary: agenticPlan.plan.briefSummary,
    updateFacts: agenticPlan.plan.updateFacts,
    ctaPreference: agenticPlan.plan.ctaPreference,
    linkedinCompanyContentLane: agenticPlan.plan.linkedinCompanyContentLane,
  });
  const updatedSettings = await markPublishingDueSlotProcessed({
    dueAt: settings.nextDueAt,
    cycleCreatedAt: now,
    now,
  });
  return {
    created: result.created,
    reason: result.reason,
    settings: updatedSettings,
    cycle: result.cycle,
    agenticPlan: agenticPlan.plan,
  };
}

async function skipPublishingCycle({ cycleId, actor = {}, reason = "" } = {}) {
  const cycle = await MarketingPublishingCycle.findById(cycleId);
  if (!cycle) throw new Error("Publishing cycle not found.");
  cycle.status = "skipped";
  cycle.statusReason = compactText(reason || "Cycle skipped.", 500);
  cycle.skippedAt = new Date();
  cycle.skippedBy = toActor(actor);
  cycle.skipReason = compactText(reason || "Cycle skipped.", 500);
  await cycle.save();
  return refreshCycleLifecycle(cycle);
}

async function listPublishingCycles({ limit = 20 } = {}) {
  const cycles = await MarketingPublishingCycle.find({})
    .sort({ createdAt: -1, updatedAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 20)))
    .lean();
  return Promise.all(cycles.map((cycle) => refreshCycleLifecycle(cycle)));
}

async function getPublishingCycleById(cycleId = "") {
  const cycle = await MarketingPublishingCycle.findById(cycleId).lean();
  if (!cycle) return null;
  return refreshCycleLifecycle(cycle);
}

async function getPublishingOverview() {
  const [settings, cycles] = await Promise.all([
    getPublishingSettings(),
    listPublishingCycles({ limit: 20 }),
  ]);
  const recentLinkedInPackets = await MarketingDraftPacket.find({ workflowType: "linkedin_company_post" })
    .sort({ createdAt: -1, updatedAt: -1 })
    .limit(12)
    .select("workflowType contentLane")
    .lean();

  const counts = cycles.reduce(
    (acc, cycle) => {
      acc.total += 1;
      acc[cycle.status] = (acc[cycle.status] || 0) + 1;
      return acc;
    },
    {
      total: 0,
      drafted: 0,
      awaiting_approval: 0,
      blocked: 0,
      skipped: 0,
      ready_to_publish: 0,
    }
  );

  return {
    settings,
    counts,
    openCycleCount: cycles.filter((cycle) => OPEN_CYCLE_STATUSES.includes(cycle.status)).length,
    latestCycles: cycles.slice(0, 12),
    linkedinCadenceGuidance: summarizeLinkedInCompanyCadence(recentLinkedInPackets),
    channelReadiness: await Promise.all(MARKETING_PUBLISHING_CHANNELS.map((channelKey) => buildChannelReadiness(channelKey))),
  };
}

module.exports = {
  OPEN_CYCLE_STATUSES,
  createPublishingCycle,
  getPublishingCycleById,
  getPublishingOverview,
  listPublishingCycles,
  refreshCycleLifecycle,
  runScheduledCycleCreation,
  skipPublishingCycle,
};
