const { LpcAction } = require("../../models/LpcAction");

function pluralize(count, singular, plural = `${singular}s`) {
  return `${Number(count) || 0} ${Number(count) === 1 ? singular : plural}`;
}

function compactText(value = "", max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function buildFounderAlertBody(action = {}) {
  const metadata = action.metadata || {};
  if (String(metadata.eventType || "") === "support.ticket.escalated") {
    const role = compactText(
      String(metadata.requesterRole || "")
        .trim()
        .replace(/^\w/, (char) => char.toUpperCase()),
      24
    );
    const lane = compactText(String(metadata.escalationLane || "").replace(/_/g, " "), 40);
    const surface = compactText(metadata.viewName || metadata.sourceSurface || "", 40);
    const caseTitle = compactText(metadata.caseTitle || "", 60);
    const summary = compactText(action.summary || action.recommendedAction || "", 180);
    const parts = [
      role ? `${role} escalation.` : "Support escalation.",
      lane ? `Lane: ${lane}.` : "",
      surface ? `Surface: ${surface}.` : "",
      caseTitle ? `Case: ${caseTitle}.` : "",
      summary,
    ].filter(Boolean);
    return compactText(parts.join(" "), 220);
  }
  return compactText(action.summary || action.recommendedAction || "", 180);
}

function sortWeight(action = {}) {
  const priority = String(action.priority || "normal").toLowerCase();
  if (priority === "urgent") return 4;
  if (priority === "high") return 3;
  if (priority === "normal") return 2;
  return 1;
}

function compareActions(a, b) {
  const weight = sortWeight(b) - sortWeight(a);
  if (weight) return weight;
  return new Date(b.lastSeenAt || b.createdAt || 0).getTime() - new Date(a.lastSeenAt || a.createdAt || 0).getTime();
}

async function loadOpenActions() {
  const actions = await LpcAction.find({ status: "open" }).lean();
  const founderAlerts = actions.filter((action) => action.actionType === "founder_alert").sort(compareActions);
  const lifecycleFollowUps = actions
    .filter((action) => action.actionType === "lifecycle_follow_up")
    .sort(compareActions);
  return { founderAlerts, lifecycleFollowUps };
}

function buildFounderRollup({ founderAlerts = [], lifecycleFollowUps = [] } = {}) {
  const urgentAlerts = founderAlerts.filter((action) => ["urgent", "high"].includes(String(action.priority || "")));
  const reviewCount = founderAlerts.length + lifecycleFollowUps.length;
  let recommendation = "No founder-priority items are currently visible.";
  if (urgentAlerts.length) {
    recommendation = "Review the current founder alerts first because they are already escalated and routed from live system events.";
  } else if (lifecycleFollowUps.length) {
    recommendation = "Review the open lifecycle follow-ups and clear the oldest operational nudges first.";
  }

  return {
    urgentItems: urgentAlerts.map((action) => ({
      count: 1,
      title: action.title,
      tone: action.priority === "urgent" ? "priority" : "needs-review",
      badge: action.actionType === "founder_alert" ? "Founder Alert" : "Lifecycle",
      body: buildFounderAlertBody(action),
      actionId: String(action._id),
    })),
    urgentCount: urgentAlerts.length,
    reviewCount,
    recommendation,
    latestFounderAlerts: founderAlerts.slice(0, 8),
    latestLifecycleFollowUps: lifecycleFollowUps.slice(0, 8),
  };
}

function buildLifecycleRollup({ lifecycleFollowUps = [] } = {}) {
  const overdue = lifecycleFollowUps.filter((action) => action.dueAt && new Date(action.dueAt).getTime() <= Date.now());
  let recommendation = "No lifecycle follow-ups are currently open.";
  if (overdue.length) {
    recommendation = "Review the overdue lifecycle follow-ups first because those users or signals have already crossed the action window.";
  } else if (lifecycleFollowUps.length) {
    recommendation = "Review the newest lifecycle follow-ups and clear the admissions and contact queue in order.";
  }

  const groupedCounts = lifecycleFollowUps.reduce(
    (acc, action) => {
      const key = String(action.dedupeKey || "");
      if (key.startsWith("lifecycle:user-signup:")) acc.signupReview += 1;
      else if (key.startsWith("lifecycle:user-profile-incomplete:")) acc.incompleteProfile += 1;
      else if (key.startsWith("lifecycle:public-contact:")) acc.publicContact += 1;
      else if (key.startsWith("lifecycle:knowledge-stale:")) acc.knowledgeStale += 1;
      return acc;
    },
    { signupReview: 0, incompleteProfile: 0, publicContact: 0, knowledgeStale: 0 }
  );

  return {
    totalOpen: lifecycleFollowUps.length,
    followUpTodayCount: overdue.length,
    stalledCount: lifecycleFollowUps.length,
    recommendation,
    groupedCounts,
    latestItems: lifecycleFollowUps.slice(0, 12),
  };
}

async function getFounderCopilotRollup() {
  const { founderAlerts, lifecycleFollowUps } = await loadOpenActions();
  const founder = buildFounderRollup({ founderAlerts, lifecycleFollowUps });
  const lifecycle = buildLifecycleRollup({ lifecycleFollowUps });

  return {
    generatedAt: new Date().toISOString(),
    founder,
    lifecycle,
  };
}

function buildFounderFocusView(rollup = {}) {
  const founder = rollup.founder || { urgentItems: [], urgentCount: 0, recommendation: "", latestFounderAlerts: [] };
  const reviewCount = Number(founder.reviewCount || 0);
  return {
    title: "Founder Copilot",
    status: founder.urgentCount ? "Priority" : founder.reviewCount ? "Active" : "Healthy",
    tone: founder.urgentCount ? "priority" : founder.reviewCount ? "active" : "healthy",
    primary: {
      title: "Recommended Focus",
      body: founder.recommendation,
    },
    secondary: {
      title: "Event-Backed Facts",
      items: [
        `${pluralize(founder.latestFounderAlerts.length, "open founder alert")} are visible.`,
        `${pluralize(rollup.lifecycle?.totalOpen || 0, "open lifecycle follow-up")} are visible.`,
        `${pluralize(rollup.lifecycle?.followUpTodayCount || 0, "lifecycle follow-up")} are due now.`,
      ],
    },
    tertiary: {
      title: "How To Use This View",
      items: [
        founder.urgentCount
          ? `Review the Urgent Queue below for ${pluralize(founder.urgentCount, "founder-priority item")}.`
          : "No founder-priority items are currently visible in the Urgent Queue below.",
        reviewCount
          ? `${pluralize(reviewCount, "open routed signal")} are still visible across founder alerts and lifecycle follow-up.`
          : "No additional routed review signals are currently open.",
      ],
    },
    quaternary: {
      title: "Source Records",
      items: ["Governed drafts and approvals remain in their source workflows; Founder Copilot only shows routed action signals."],
    },
  };
}

function buildLifecycleFocusView(rollup = {}) {
  const lifecycle = rollup.lifecycle || { followUpTodayCount: 0, stalledCount: 0, recommendation: "", groupedCounts: {}, latestItems: [] };
  return {
    title: "Lifecycle & Follow-Up",
    status: lifecycle.followUpTodayCount ? "Needs Review" : lifecycle.totalOpen ? "Active" : "Healthy",
    tone: lifecycle.followUpTodayCount ? "needs-review" : lifecycle.totalOpen ? "active" : "healthy",
    queueLabel: `${pluralize(lifecycle.followUpTodayCount, "follow-up")} due now`,
    primary: {
      title: "Recommended Focus",
      body: lifecycle.recommendation,
    },
    secondary: {
      title: "Event-Backed Facts",
      items: [
        `Signup reviews open: ${Number(lifecycle.groupedCounts?.signupReview || 0)}`,
        `Incomplete pending profiles open: ${Number(lifecycle.groupedCounts?.incompleteProfile || 0)}`,
        `Public contact follow-ups open: ${Number(lifecycle.groupedCounts?.publicContact || 0)}`,
        `Knowledge reviews due: ${Number(lifecycle.groupedCounts?.knowledgeStale || 0)}`,
      ],
    },
    tertiary: {
      title: "Current Lifecycle Queue",
      items: lifecycle.latestItems.length
        ? lifecycle.latestItems.map((item) => `${item.title}: ${compactText(item.summary || item.recommendedAction || "", 140)}`)
        : ["No lifecycle follow-ups are currently open."],
    },
    quaternary: {
      title: "Source Records",
      items: ["Lifecycle follow-ups link back to their source systems; no separate draft surface is generated here."],
    },
  };
}

module.exports = {
  buildFounderFocusView,
  buildLifecycleFocusView,
  getFounderCopilotRollup,
};
