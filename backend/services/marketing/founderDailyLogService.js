const FounderDailyLog = require("../../models/FounderDailyLog");
const MarketingBrief = require("../../models/MarketingBrief");
const MarketingDraftPacket = require("../../models/MarketingDraftPacket");
const MarketingEvaluation = require("../../models/MarketingEvaluation");
const { getMarketingOverview } = require("./reviewService");
const { getPublishingOverview, runScheduledCycleCreation, OPEN_CYCLE_STATUSES } = require("./publishingCycleService");
const { getJrCmoBriefing } = require("./jrCmoResearchService");
const { getPacketPublishReadiness } = require("./publishReadinessService");

const FOUNDER_DAILY_LOG_TIMEZONE = "America/New_York";
const FOUNDER_DAILY_LOG_HOUR = 9;

function compactText(value = "", max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function titleize(value = "") {
  const text = String(value || "").replace(/_/g, " ").trim();
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function uniqueList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => compactText(value, 500))
        .filter(Boolean)
    )
  );
}

function getTimeZoneParts(date = new Date(), timeZone = FOUNDER_DAILY_LOG_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = Number(part.value);
    return acc;
  }, {});
  return {
    year: Number(parts.year || 0),
    month: Number(parts.month || 1),
    day: Number(parts.day || 1),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0),
  };
}

function zonedDateTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 } = {}, timeZone = FOUNDER_DAILY_LOG_TIMEZONE) {
  let guess = Date.UTC(year, Math.max(0, Number(month || 1) - 1), day, hour, minute, second);
  for (let index = 0; index < 4; index += 1) {
    const actual = getTimeZoneParts(new Date(guess), timeZone);
    const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualUtc = Date.UTC(
      actual.year,
      Math.max(0, Number(actual.month || 1) - 1),
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const diffMs = desiredUtc - actualUtc;
    if (diffMs === 0) break;
    guess += diffMs;
  }
  return new Date(guess);
}

function localDateKey(date = new Date(), timeZone = FOUNDER_DAILY_LOG_TIMEZONE) {
  const parts = getTimeZoneParts(date, timeZone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function startOfLocalDay(date = new Date(), timeZone = FOUNDER_DAILY_LOG_TIMEZONE) {
  const parts = getTimeZoneParts(date, timeZone);
  return zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone
  );
}

function founderPrepThreshold(date = new Date(), timeZone = FOUNDER_DAILY_LOG_TIMEZONE) {
  const parts = getTimeZoneParts(date, timeZone);
  return zonedDateTimeToUtc(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: FOUNDER_DAILY_LOG_HOUR,
      minute: 0,
      second: 0,
    },
    timeZone
  );
}

function overnightStart(date = new Date(), timeZone = FOUNDER_DAILY_LOG_TIMEZONE) {
  return new Date(startOfLocalDay(date, timeZone).getTime() - 12 * 60 * 60 * 1000);
}

function isLogStale(log = null, now = new Date()) {
  if (!log?.generatedAt) return true;
  return new Date(now).getTime() - new Date(log.generatedAt).getTime() > 15 * 60 * 1000;
}

function channelLabel(channelKey = "") {
  if (channelKey === "linkedin_company") return "LinkedIn company";
  if (channelKey === "facebook_page") return "Facebook page";
  return titleize(channelKey || "channel");
}

function buildAction({
  key = "",
  label = "",
  description = "",
  actionType = "",
  channelKey = "",
  packetId = null,
  cycleId = null,
  enabled = true,
  disabledReason = "",
  priority = 50,
} = {}) {
  return {
    key,
    label,
    description: compactText(description, 500),
    actionType,
    channelKey,
    packetId: packetId || null,
    cycleId: cycleId || null,
    enabled: enabled !== false,
    disabledReason: compactText(disabledReason, 500),
    priority: Number(priority || 50),
  };
}

async function loadPacketContext(packetId = null) {
  if (!packetId) return { packet: null, brief: null };
  const packet = await MarketingDraftPacket.findById(packetId).lean();
  if (!packet) return { packet: null, brief: null };
  const brief = packet.briefId ? await MarketingBrief.findById(packet.briefId).lean() : null;
  return { packet, brief };
}

async function buildLinkedInReadyPost(channel = {}, cycle = null) {
  const { packet, brief } = await loadPacketContext(channel.packetId || null);
  if (!packet) {
    return {
      channelKey: "linkedin_company",
      channelLabel: "LinkedIn company",
      packetId: null,
      cycleId: cycle?._id || cycle?.id || null,
      title: "",
      summary: "No LinkedIn company draft is available for today yet.",
      status: "Not available today",
      approvalState: "",
      publishReadiness: "not_available",
      canPostNow: false,
      blocker: "No LinkedIn company packet is available for today's founder review.",
      primaryAction: buildAction({
        key: "open-marketing-queue",
        label: "Open full marketing queue",
        description: "Open the full queue and inspect the latest marketing packets.",
        actionType: "open_marketing_queue",
        enabled: true,
        priority: 80,
      }),
      secondaryAction: null,
    };
  }

  const readiness = await getPacketPublishReadiness({ packetId: packet._id });
  const title = brief?.title || packet.packetSummary || "LinkedIn company draft";
  const summary = packet.packetSummary || brief?.briefSummary || readiness.publishText || "LinkedIn company packet is available.";

  if (readiness.isReady) {
    return {
      channelKey: "linkedin_company",
      channelLabel: "LinkedIn company",
      packetId: packet._id,
      cycleId: cycle?._id || cycle?.id || brief?.cycleId || null,
      title,
      summary: compactText(summary, 1000),
      status: "Ready to post",
      approvalState: packet.approvalState || "",
      publishReadiness: readiness.status || "ready",
      canPostNow: true,
      blocker: "",
      primaryAction: buildAction({
        key: "post-linkedin-now",
        label: "Post Now",
        description: "Publish the approved LinkedIn company post manually now.",
        actionType: "publish_packet_now",
        channelKey: "linkedin_company",
        packetId: packet._id,
        cycleId: cycle?._id || cycle?.id || null,
        enabled: true,
        priority: 10,
      }),
      secondaryAction: buildAction({
        key: "open-linkedin-packet",
        label: "Open Packet",
        description: "Open the LinkedIn packet detail before posting.",
        actionType: "open_packet",
        channelKey: "linkedin_company",
        packetId: packet._id,
        cycleId: cycle?._id || cycle?.id || null,
        enabled: true,
        priority: 20,
      }),
    };
  }

  if (packet.approvalState === "pending_review") {
    return {
      channelKey: "linkedin_company",
      channelLabel: "LinkedIn company",
      packetId: packet._id,
      cycleId: cycle?._id || cycle?.id || brief?.cycleId || null,
      title,
      summary: compactText(summary, 1000),
      status: "Ready to review",
      approvalState: packet.approvalState || "",
      publishReadiness: readiness.status || "blocked",
      canPostNow: false,
      blocker: "The LinkedIn packet still needs Samantha's approval.",
      primaryAction: buildAction({
        key: "review-linkedin-draft",
        label: "Review Draft",
        description: "Open the LinkedIn packet detail for founder review.",
        actionType: "open_packet",
        channelKey: "linkedin_company",
        packetId: packet._id,
        cycleId: cycle?._id || cycle?.id || null,
        enabled: true,
        priority: 15,
      }),
      secondaryAction: buildAction({
        key: "approve-linkedin-packet",
        label: "Approve Pending Packet",
        description: "Approve the pending LinkedIn packet directly from the founder layer.",
        actionType: "approve_packet",
        channelKey: "linkedin_company",
        packetId: packet._id,
        cycleId: cycle?._id || cycle?.id || null,
        enabled: true,
        priority: 25,
      }),
    };
  }

  return {
    channelKey: "linkedin_company",
    channelLabel: "LinkedIn company",
    packetId: packet._id,
    cycleId: cycle?._id || cycle?.id || brief?.cycleId || null,
    title,
    summary: compactText(summary, 1000),
    status: packet.approvalState === "approved" ? "Blocked" : "Awaiting approval",
    approvalState: packet.approvalState || "",
    publishReadiness: readiness.status || "blocked",
    canPostNow: false,
    blocker: compactText((readiness.blockers || [])[0] || channel.reason || "The LinkedIn company packet is not yet ready to post.", 500),
    primaryAction: buildAction({
      key: "resolve-linkedin-blocker",
      label: "Resolve Blocker",
      description: "Open the LinkedIn packet detail and resolve the blocker truthfully.",
      actionType: "open_packet",
      channelKey: "linkedin_company",
      packetId: packet._id,
      cycleId: cycle?._id || cycle?.id || null,
      enabled: true,
      priority: 30,
    }),
    secondaryAction: buildAction({
      key: "open-linkedin-packet-blocked",
      label: "Open Packet",
      description: "Open the blocked LinkedIn packet.",
      actionType: "open_packet",
      channelKey: "linkedin_company",
      packetId: packet._id,
      cycleId: cycle?._id || cycle?.id || null,
      enabled: true,
      priority: 35,
    }),
  };
}

async function buildFacebookReadyPost(channel = {}, cycle = null) {
  const { packet, brief } = await loadPacketContext(channel.packetId || null);
  if (!packet) {
    return {
      channelKey: "facebook_page",
      channelLabel: "Facebook page",
      packetId: null,
      cycleId: cycle?._id || cycle?.id || null,
      title: "",
      summary: "No Facebook page draft is available for today yet.",
      status: "Not available today",
      approvalState: "",
      publishReadiness: "not_available",
      canPostNow: false,
      blocker: "No Facebook page packet is available for today's founder review.",
      primaryAction: buildAction({
        key: "open-marketing-queue-facebook",
        label: "Open full marketing queue",
        description: "Open the queue and inspect the latest channel packets.",
        actionType: "open_marketing_queue",
        enabled: true,
        priority: 90,
      }),
      secondaryAction: null,
    };
  }

  const title = brief?.title || packet.packetSummary || "Facebook page draft";
  const summary = packet.packetSummary || brief?.briefSummary || "Facebook page packet is available.";

  if (packet.approvalState === "pending_review") {
    return {
      channelKey: "facebook_page",
      channelLabel: "Facebook page",
      packetId: packet._id,
      cycleId: cycle?._id || cycle?.id || brief?.cycleId || null,
      title,
      summary: compactText(summary, 1000),
      status: "Ready to review",
      approvalState: packet.approvalState || "",
      publishReadiness: "blocked",
      canPostNow: false,
      blocker: "The Facebook packet still needs Samantha's approval.",
      primaryAction: buildAction({
        key: "review-facebook-draft",
        label: "Review Draft",
        description: "Open the Facebook packet detail for founder review.",
        actionType: "open_packet",
        channelKey: "facebook_page",
        packetId: packet._id,
        cycleId: cycle?._id || cycle?.id || null,
        enabled: true,
        priority: 40,
      }),
      secondaryAction: buildAction({
        key: "approve-facebook-packet",
        label: "Approve Pending Packet",
        description: "Approve the pending Facebook packet directly from the founder layer.",
        actionType: "approve_packet",
        channelKey: "facebook_page",
        packetId: packet._id,
        cycleId: cycle?._id || cycle?.id || null,
        enabled: true,
        priority: 45,
      }),
    };
  }

  const blocker =
    packet.approvalState === "approved"
      ? "Facebook Page posting remains blocked because publish execution is not implemented in this phase."
      : "The Facebook page packet is not yet available for posting.";

  return {
    channelKey: "facebook_page",
    channelLabel: "Facebook page",
    packetId: packet._id,
    cycleId: cycle?._id || cycle?.id || brief?.cycleId || null,
    title,
    summary: compactText(summary, 1000),
    status: packet.approvalState === "approved" ? "Blocked" : "Awaiting approval",
    approvalState: packet.approvalState || "",
    publishReadiness: "blocked",
    canPostNow: false,
    blocker,
    primaryAction: buildAction({
      key: "post-facebook-blocked",
      label: "Post to Facebook",
      description: "Facebook Page posting is not implemented yet in this phase.",
      actionType: "noop",
      channelKey: "facebook_page",
      packetId: packet._id,
      cycleId: cycle?._id || cycle?.id || null,
      enabled: false,
      disabledReason: blocker,
      priority: 95,
    }),
    secondaryAction: buildAction({
      key: "open-facebook-packet",
      label: "Open Packet",
      description: "Open the Facebook packet detail.",
      actionType: "open_packet",
      channelKey: "facebook_page",
      packetId: packet._id,
      cycleId: cycle?._id || cycle?.id || null,
      enabled: true,
      priority: 55,
    }),
  };
}

async function buildReadyPosts({ cycles = [] } = {}) {
  const preferredCycle =
    (cycles || []).find((cycle) => localDateKey(cycle.createdAt || cycle.updatedAt || new Date()) === localDateKey(new Date())) ||
    (cycles || []).find((cycle) => OPEN_CYCLE_STATUSES.includes(cycle.status)) ||
    (cycles || [])[0] ||
    null;

  const linkedInChannel = preferredCycle?.channels?.linkedin_company || {};
  const facebookChannel = preferredCycle?.channels?.facebook_page || {};

  const [linkedIn, facebook] = await Promise.all([
    buildLinkedInReadyPost(linkedInChannel, preferredCycle),
    buildFacebookReadyPost(facebookChannel, preferredCycle),
  ]);

  return [linkedIn, facebook];
}

function buildQuickActions({ readyPosts = [], overview = {} } = {}) {
  const actions = [];
  const linkedIn = readyPosts.find((item) => item.channelKey === "linkedin_company");
  const facebook = readyPosts.find((item) => item.channelKey === "facebook_page");

  if (linkedIn?.status === "Ready to post" && linkedIn.primaryAction) {
    actions.push({ ...linkedIn.primaryAction, description: "Publish the approved LinkedIn company post manually now." });
  } else if (linkedIn?.status === "Ready to review" && linkedIn.primaryAction) {
    actions.push({ ...linkedIn.primaryAction, description: "Review the LinkedIn company packet before approving it." });
  }

  if (facebook?.status === "Ready to review" && facebook.primaryAction) {
    actions.push({ ...facebook.primaryAction, description: "Review the Facebook page packet before approving it." });
  }
  if (facebook?.primaryAction?.label === "Post to Facebook") {
    actions.push(facebook.primaryAction);
  }

  const approveCandidate = readyPosts.find((post) => post.secondaryAction?.actionType === "approve_packet");
  if (approveCandidate?.secondaryAction) {
    actions.push(approveCandidate.secondaryAction);
  }

  actions.push(
    buildAction({
      key: "open-marketing-queue-global",
      label: "Open full marketing queue",
      description: "Jump to the existing marketing queue and packet detail workflow.",
      actionType: "open_marketing_queue",
      enabled: true,
      priority: 90,
    })
  );
  actions.push(
    buildAction({
      key: "refresh-founder-daily-log",
      label: "Refresh daily log",
      description: "Regenerate the founder daily log safely without posting anything.",
      actionType: "refresh_founder_daily_log",
      enabled: true,
      priority: 100,
    })
  );

  const unique = [];
  const seen = new Set();
  for (const action of actions) {
    const key = `${action.actionType}:${String(action.packetId || "")}:${String(action.channelKey || "")}:${action.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(action);
  }

  return unique.sort((left, right) => Number(left.priority || 50) - Number(right.priority || 50)).slice(0, 8);
}

function buildSummary({ jrBriefing = {}, readyPosts = [], quickActions = [], overview = {}, publishingOverview = {} } = {}) {
  const pendingReview = Number(overview.counts?.pendingReview || 0);
  const readyToPost = readyPosts.filter((post) => post.status === "Ready to post").length;
  const blocked = readyPosts.filter((post) => post.status === "Blocked").length;
  const topOpportunity = (jrBriefing.opportunities || [])[0];
  const dayContext = jrBriefing.dayContext || {};
  const linkedInReadiness = (publishingOverview.channelReadiness || []).find((entry) => entry.channelKey === "linkedin_company");

  const lines = [
    topOpportunity?.contentLane
      ? `The Jr. CMO identified a ${String(topOpportunity.contentLane || "").replace(/_/g, "/")} priority for today's planning.`
      : "The Jr. CMO refreshed today's planning context.",
    readyToPost
      ? `${readyToPost} post${readyToPost === 1 ? " is" : "s are"} ready for Samantha to post manually today.`
      : pendingReview
        ? `${pendingReview} draft packet${pendingReview === 1 ? " is" : "s are"} ready for Samantha's review.`
        : "No review-ready post is available yet for today.",
    linkedInReadiness?.status === "connected_validated"
      ? "LinkedIn company publishing is connected and can be used when a packet is fully ready."
      : "LinkedIn company publishing remains blocked until connection and validation are complete.",
    blocked && !readyToPost ? `${blocked} channel state${blocked === 1 ? " remains" : "s remain"} blocked.` : "",
    quickActions.length ? "The founder layer has already prepared the next useful actions." : "",
    dayContext.sourceMode && dayContext.sourceMode !== "internal_only"
      ? "Today's summary includes both internal and external context."
      : "Today's summary is based on internal marketing state only.",
  ];
  return compactText(uniqueList(lines).join(" "), 1800);
}

function buildNeedsFounder({ readyPosts = [], overview = {}, publishingOverview = {} } = {}) {
  const items = [];
  const pendingReview = Number(overview.counts?.pendingReview || 0);
  if (pendingReview > 0) {
    items.push(`${pendingReview} draft packet${pendingReview === 1 ? " is" : "s are"} awaiting Samantha's approval.`);
  }
  readyPosts
    .filter((post) => post.status === "Ready to post")
    .forEach((post) => {
      items.push(`${post.channelLabel} is ready for manual posting right now.`);
    });
  const linkedIn = (publishingOverview.channelReadiness || []).find((entry) => entry.channelKey === "linkedin_company");
  if (linkedIn?.status !== "connected_validated") {
    items.push("LinkedIn connection still needs to be completed or revalidated before the company channel becomes reliable.");
  }
  return uniqueList(items);
}

function buildBlockers({ readyPosts = [], publishingOverview = {} } = {}) {
  const items = [];
  readyPosts
    .filter((post) => post.status === "Blocked" && post.blocker)
    .forEach((post) => {
      items.push(`${post.channelLabel}: ${post.blocker}`);
    });
  const facebook = readyPosts.find((post) => post.channelKey === "facebook_page");
  if (facebook && facebook.status !== "Ready to review" && facebook.status !== "Ready to post") {
    items.push("No Facebook-ready post exists yet.");
  }
  const linkedIn = (publishingOverview.channelReadiness || []).find((entry) => entry.channelKey === "linkedin_company");
  if (linkedIn?.status !== "connected_validated") {
    items.push(linkedIn?.note || "LinkedIn company publishing remains blocked until connection is completed.");
  }
  return uniqueList(items);
}

async function buildWhatChanged({ now = new Date(), jrBriefing = {}, createdCycle = null } = {}) {
  const since = overnightStart(now);
  const [recentCycles, recentOutcomes] = await Promise.all([
    require("../../models/MarketingPublishingCycle")
      .find({ createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(3)
      .select("cycleLabel createdAt")
      .lean(),
    MarketingEvaluation.find({
      evaluationType: "packet_outcome",
      windowEndAt: { $gte: since },
      status: "active",
    })
      .sort({ windowEndAt: -1 })
      .limit(4)
      .lean(),
  ]);

  const items = [];
  if (createdCycle?.created === true && createdCycle.cycle?.cycleLabel) {
    items.push(`A new publishing cycle was prepared overnight: ${createdCycle.cycle.cycleLabel}.`);
  }
  recentCycles.forEach((cycle) => {
    items.push(`Cycle update: ${cycle.cycleLabel || "Publishing cycle"} was created ${new Date(cycle.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.`);
  });
  recentOutcomes.forEach((entry) => {
    items.push(`Packet outcome: ${titleize(entry.outcome || "")} for ${titleize(entry.workflowType || "marketing draft")}.`);
  });
  if ((jrBriefing.opportunities || []).length) {
    items.push(`The Jr. CMO refreshed ${jrBriefing.opportunities.length} active opportunity signal${jrBriefing.opportunities.length === 1 ? "" : "s"} for today.`);
  }
  if (!items.length) {
    items.push("No material marketing change landed overnight.");
  }
  return uniqueList(items).slice(0, 5);
}

function buildRecommendedActions({ readyPosts = [], quickActions = [], overview = {} } = {}) {
  const items = [];
  if (readyPosts.some((post) => post.status === "Ready to post")) {
    items.push("Post the ready LinkedIn company packet manually if you are comfortable with the current approval state.");
  }
  if (Number(overview.counts?.pendingReview || 0) > 0) {
    items.push("Approve or reject the pending packets to unblock the next cycle cleanly.");
  }
  const blockedLinkedIn = readyPosts.find((post) => post.channelKey === "linkedin_company" && post.status === "Blocked");
  if (blockedLinkedIn?.blocker) {
    items.push("Resolve the LinkedIn connection or readiness blocker before expecting a manual post action.");
  }
  if (!items.length && quickActions.length) {
    items.push(`Recommended: ${quickActions[0].label}.`);
  }
  if (!items.length) {
    items.push("No urgent founder action is required right now.");
  }
  return uniqueList(items).slice(0, 5);
}

async function buildFounderDailyLogPayload({ now = new Date(), prepResult = null } = {}) {
  const [overview, publishingOverview, jrBriefing] = await Promise.all([
    getMarketingOverview(),
    getPublishingOverview(),
    getJrCmoBriefing({ forceRefresh: false }),
  ]);

  const readyPosts = await buildReadyPosts({ cycles: publishingOverview.latestCycles || [] });
  const quickActions = buildQuickActions({ readyPosts, overview, publishingOverview });
  const whatChanged = await buildWhatChanged({ now, jrBriefing, createdCycle: prepResult?.marketingPublishing || null });
  const needsFounder = buildNeedsFounder({ readyPosts, overview, publishingOverview });
  const blockers = buildBlockers({ readyPosts, publishingOverview });
  const recommendedActions = buildRecommendedActions({ readyPosts, quickActions, overview });
  const summary = buildSummary({ jrBriefing, readyPosts, quickActions, overview, publishingOverview });

  return {
    summary,
    whatChanged,
    needsFounder,
    blockers,
    recommendedActions,
    quickActions,
    readyPosts,
    compactStatus: {
      pendingReviewCount: Number(overview.counts?.pendingReview || 0),
      approvedCount: Number(overview.counts?.approved || 0),
      readyToPostCount: readyPosts.filter((post) => post.status === "Ready to post").length,
      blockedCount: readyPosts.filter((post) => post.status === "Blocked").length,
    },
    sourceMetadata: {
      jrCmoSourceMode: jrBriefing.dayContext?.sourceMode || "internal_only",
      topOpportunityKey: jrBriefing.opportunities?.[0]?.opportunityKey || "",
      latestCycleId: publishingOverview.latestCycles?.[0]?.id || "",
      generatedFromScheduler: prepResult?.generatedFromScheduler === true,
      scheduledReason: prepResult?.marketingPublishing?.reason || "",
      quickActionCount: quickActions.length,
    },
  };
}

async function prepareFounderDailyLog({ now = new Date(), force = false, allowScheduledCycleCheck = false } = {}) {
  const dateKey = localDateKey(now, FOUNDER_DAILY_LOG_TIMEZONE);
  let prepResult = null;

  if (allowScheduledCycleCheck) {
    prepResult = {
      marketingPublishing: await runScheduledCycleCreation({
        actor: { actorType: "agent", label: "Founder Daily Log Prep" },
        now,
      }),
      generatedFromScheduler: false,
    };
  }

  const payload = await buildFounderDailyLogPayload({ now, prepResult });
  const log = await FounderDailyLog.findOneAndUpdate(
    { dateKey, timezone: FOUNDER_DAILY_LOG_TIMEZONE },
    {
      $set: {
        ...payload,
        generatedAt: new Date(now),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return { log, refreshed: true, prepResult };
}

async function getFounderDailyLog({ now = new Date(), refreshIfStale = true } = {}) {
  const dateKey = localDateKey(now, FOUNDER_DAILY_LOG_TIMEZONE);
  const existing = await FounderDailyLog.findOne({ dateKey, timezone: FOUNDER_DAILY_LOG_TIMEZONE }).lean();
  if (existing && (!refreshIfStale || !isLogStale(existing, now))) {
    return { log: existing, refreshed: false };
  }
  return prepareFounderDailyLog({ now, force: true, allowScheduledCycleCheck: false });
}

async function prepareFounderDailyLogIfDue({ now = new Date(), schedulerState = {} } = {}) {
  const threshold = founderPrepThreshold(now, FOUNDER_DAILY_LOG_TIMEZONE);
  if (new Date(now).getTime() < threshold.getTime()) {
    return { prepared: false, reason: "before_9am", log: null };
  }

  const dateKey = localDateKey(now, FOUNDER_DAILY_LOG_TIMEZONE);
  const existing = await FounderDailyLog.findOne({ dateKey, timezone: FOUNDER_DAILY_LOG_TIMEZONE }).lean();
  if (existing && new Date(existing.generatedAt).getTime() >= threshold.getTime()) {
    return { prepared: false, reason: "already_prepared_today", log: existing };
  }

  const payload = await buildFounderDailyLogPayload({ now, prepResult: schedulerState });
  const log = await FounderDailyLog.findOneAndUpdate(
    { dateKey, timezone: FOUNDER_DAILY_LOG_TIMEZONE },
    {
      $set: {
        ...payload,
        generatedAt: new Date(now),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return { prepared: true, reason: "prepared", log };
}

module.exports = {
  FOUNDER_DAILY_LOG_HOUR,
  FOUNDER_DAILY_LOG_TIMEZONE,
  getFounderDailyLog,
  localDateKey,
  prepareFounderDailyLog,
  prepareFounderDailyLogIfDue,
};
