import { secureFetch, fetchCSRF } from "./auth.js";
import {
  fetchIncidentList,
  fetchIncidentDetail,
  fetchIncidentTimeline,
  fetchIncidentClusters,
  decideIncidentApproval,
} from "./admin/incidents/api.js";
import { renderIncidentList } from "./admin/incidents/list.js";
import { renderIncidentDetail } from "./admin/incidents/detail.js";
import { renderIncidentTimeline } from "./admin/incidents/timeline.js";
import { renderIncidentClusters } from "./admin/incidents/clusters.js";
import "./admin/knowledge.js";
import "./admin/engineering.js";
import "./admin/marketing.js";
import "./admin/support.js";
import "./admin/sales.js";
import "./admin/approvals.js";

const chartCache = {
userLine: null,
combo: null,
escrow: null,
revenue: null,
expense: null,
  escrowReport: null,
};

let analyticsInFlight = false;
let latestAnalytics = null;
let lastAnalyticsRenderAt = 0;
let adminSettingsCache = null;
let settingsBound = false;
const ANALYTICS_COOLDOWN_MS = 30_000;
const removedUserIds = new Set();
let recentUsersCache = [];
const NEW_USERS_PAGE_SIZE = 5;
let newUsersPage = 1;
const newUsersPageSelect = document.getElementById("newUsersPageSelect");
const disputeCountEl = document.getElementById("disputeCount");
const disputeCardEl = document.getElementById("disputeCard");
const overviewActionRowsEl = document.getElementById("overviewActionRows");
const overviewActionStatusEl = document.getElementById("overviewActionStatus");
const disputesBody = document.getElementById("disputesBody");
const disputeSearchInput = document.getElementById("disputeSearch");
const disputeStatusFilter = document.getElementById("disputeStatusFilter");
const refreshDisputesBtn = document.getElementById("refreshDisputes");
const disputesHeaderRow = document.getElementById("disputesHeaderRow");
const disputeTabs = Array.from(document.querySelectorAll("[data-dispute-tab]"));
const AI_CONTROL_ROOM_DEFAULT_ACTIVE_KEY = "cto";
let activeAIControlRoomKey = AI_CONTROL_ROOM_DEFAULT_ACTIVE_KEY;
let overviewActionsPromise = null;
let overviewActionsQueuedForceRefresh = false;
let lastOverviewActionsAt = 0;
const OVERVIEW_ACTIONS_COOLDOWN_MS = 15_000;

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

async function loadAnalytics() {
if (analyticsInFlight) return null;
analyticsInFlight = true;
try {
const res = await fetch("/api/admin/analytics", {
credentials: "include",
headers: { Accept: "application/json" },
});
if (!res.ok) {
console.error("Failed to load analytics");
return null;
}
return await res.json();
} catch (err) {
console.error("Failed to load analytics", err);
return null;
} finally {
analyticsInFlight = false;
}
}

function cacheCharts() {
if (!window.Chart?.getChart) return;
chartCache.userLine = Chart.getChart("userChart") || chartCache.userLine;
chartCache.combo = Chart.getChart("userMgmtComboChart") || chartCache.combo;
chartCache.escrow = Chart.getChart("escrowChart") || chartCache.escrow;
chartCache.revenue = Chart.getChart("revMainChart") || chartCache.revenue;
chartCache.expense = Chart.getChart("revExpenseChart") || chartCache.expense;
  chartCache.escrowReport = Chart.getChart("escrowReportChart") || chartCache.escrowReport;
}

function updateText(selector, value) {
if (!selector) return;
const el = document.querySelector(selector);
if (el) el.textContent = value;
}

function formatCurrency(value) {
  const cents = Number(value);
  if (!Number.isFinite(cents)) return "—";
  return CURRENCY.format(cents / 100);
}

function formatNumber(value) {
if (!Number.isFinite(Number(value))) return "0";
return Number(value).toLocaleString();
}

function parseCountText(value, fallback = 0) {
  const match = String(value || "").replace(/,/g, "").match(/-?\d+/);
  return match ? Number(match[0]) : fallback;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchAdminJson(url, fallback = null) {
  try {
    const res = await secureFetch(url, { headers: { Accept: "application/json" } });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || `Unable to load ${url}.`);
    return payload;
  } catch (err) {
    console.warn(`Unable to load admin dashboard resource: ${url}`, err);
    return fallback;
  }
}

async function fetchOverviewResource(key, url, fallback = null) {
  try {
    const res = await secureFetch(url, { headers: { Accept: "application/json" } });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error || `Unable to load ${url}.`);
    }
    return { key, ok: true, payload };
  } catch (err) {
    console.warn(`Unable to load overview resource: ${url}`, err);
    return { key, ok: false, payload: fallback };
  }
}

function formatActionCount(count, noun) {
  const total = Number(count) || 0;
  return `${formatNumber(total)} ${noun}${total === 1 ? "" : "s"}`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return Number(count) === 1 ? singular : plural;
}

function flashOverviewTarget(target) {
  if (!target) return;
  target.classList.add("overview-target-flash");
  window.setTimeout(() => {
    target.classList.remove("overview-target-flash");
  }, 1600);
}

function navigateOverviewAction(sectionKey = "", anchorId = "", options = {}) {
  if (!sectionKey) return;
  window.activateAdminSection?.(sectionKey);

  const tryScroll = (attempt = 0) => {
    const target = anchorId ? document.getElementById(anchorId) : null;
    if (target) {
      if (typeof options.beforeScroll === "function") options.beforeScroll();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      flashOverviewTarget(target);
      return;
    }
    if (attempt >= 8) return;
    window.setTimeout(() => {
      tryScroll(attempt + 1);
    }, attempt < 2 ? 120 : 220);
  };

  window.setTimeout(() => {
    if (typeof options.beforeScroll === "function" && !anchorId) {
      options.beforeScroll();
    }
    if (!anchorId) return;
    tryScroll();
  }, 80);
}

function getOverviewActionNavigationOptions(behaviorKey = "") {
  if (behaviorKey === "finance") {
    return {
      beforeScroll: () => {
        document.querySelector('[data-dispute-tab="open"]')?.click();
      },
    };
  }
  return {};
}

function buildUnavailableOverviewAction({
  key,
  title,
  reason,
  buttonLabel,
  target,
  weight = 50,
}) {
  return {
    key,
    weight,
    priority: "next",
    title,
    meta: "This summary is temporarily unavailable. Open the workspace directly to verify current work.",
    reason,
    buttonLabel,
    target,
    unavailable: true,
  };
}

function buildOverviewActions(summary = {}) {
  const approvalsPending = Number.isFinite(Number(summary.approvalsPending)) ? Number(summary.approvalsPending) : null;
  const supportBlockers = Number.isFinite(Number(summary.supportBlockers)) ? Number(summary.supportBlockers) : null;
  const supportOpen = Number.isFinite(Number(summary.supportOpen)) ? Number(summary.supportOpen) : null;
  const disputesOpen = Number.isFinite(Number(summary.disputesOpen)) ? Number(summary.disputesOpen) : null;
  const pendingUsers = Number.isFinite(Number(summary.pendingUsers)) ? Number(summary.pendingUsers) : null;
  const engineeringBlocked = Number.isFinite(Number(summary.engineeringBlocked))
    ? Number(summary.engineeringBlocked)
    : null;
  const engineeringAwaitingApproval = Number.isFinite(Number(summary.engineeringAwaitingApproval))
    ? Number(summary.engineeringAwaitingApproval)
    : null;
  const marketingPending = Number.isFinite(Number(summary.marketingPending)) ? Number(summary.marketingPending) : null;
  const salesPending = Number.isFinite(Number(summary.salesPending)) ? Number(summary.salesPending) : null;

  const rows = [
    approvalsPending === null
      ? buildUnavailableOverviewAction({
          key: "approvals",
          title: "Approvals overview unavailable",
          reason: "The approvals summary could not be loaded. Open Approvals directly before assuming nothing is waiting.",
          buttonLabel: "Open Approvals",
          target: { section: "approvals-workspace", anchorId: "approvalItemList" },
          weight: 88,
        })
      : {
          key: "approvals",
          weight: approvalsPending > 0 ? 100 : 10,
          priority: approvalsPending > 0 ? "now" : "clear",
          title:
            approvalsPending > 0
              ? `Approve or reject ${formatActionCount(approvalsPending, "item")}`
              : "No approvals are waiting",
          meta: approvalsPending > 0 ? "Clear this first before moving into individual workspaces." : "Skip this for now.",
          reason:
            approvalsPending > 0
              ? "Knowledge, marketing, support FAQ, and sales content are waiting on an explicit admin decision."
              : "Nothing in Approvals needs action right now.",
          buttonLabel: "Open Approvals",
          target: {
            section: "approvals-workspace",
            anchorId: "approvalItemList",
          },
        },
    supportBlockers === null || supportOpen === null
      ? buildUnavailableOverviewAction({
          key: "support",
          title: "Support overview unavailable",
          reason: "The support queue summary could not be loaded. Open Support Ops directly to confirm blocker and ticket volume.",
          buttonLabel: "Open Support Ops",
          target: { section: "support-ops", anchorId: "supportTicketList" },
          weight: 84,
        })
      : {
          key: "support",
          weight: supportBlockers > 0 ? 95 : supportOpen > 0 ? 70 : 9,
          priority: supportBlockers > 0 ? "now" : supportOpen > 0 ? "next" : "clear",
          title:
            supportBlockers > 0
              ? `Review ${formatActionCount(supportBlockers, "support blocker")}`
              : supportOpen > 0
              ? `Review ${formatActionCount(supportOpen, "open support ticket")}`
              : "Support is clear",
          meta:
            supportBlockers > 0
              ? `${formatActionCount(supportOpen, "active ticket")} visible in Support Ops.`
              : supportOpen > 0
              ? "No blocker signal, but open support work still needs triage."
              : "No open support tickets currently require review.",
          reason:
            supportBlockers > 0
              ? "These are the highest-risk live user issues and should be reviewed before lower-priority queue work."
              : supportOpen > 0
              ? "There is live user work waiting in the support queue."
              : "Support does not appear to need admin attention right now.",
          buttonLabel: "Open Support Ops",
          target: {
            section: "support-ops",
            anchorId: "supportTicketList",
          },
        },
    disputesOpen === null
      ? buildUnavailableOverviewAction({
          key: "finance",
          title: "Finance overview unavailable",
          reason: "The disputes summary could not be loaded. Open Finance directly before assuming there is no money-risk work.",
          buttonLabel: "Open Finance",
          target: { section: "finance", anchorId: "disputesBody" },
          weight: 82,
        })
      : {
          key: "finance",
          weight: disputesOpen > 0 ? 90 : 8,
          priority: disputesOpen > 0 ? "now" : "clear",
          title:
            disputesOpen > 0
              ? `Resolve ${formatActionCount(disputesOpen, "open dispute")}`
              : "No open disputes are waiting",
          meta:
            disputesOpen > 0
              ? "Money-risk work belongs in Finance."
              : "Finance does not have a live dispute requiring action.",
          reason:
            disputesOpen > 0
              ? "Disputes are manual money-risk work and should not sit unresolved."
              : "You can skip Finance unless you are checking reporting or receipts.",
          buttonLabel: "Open Finance",
          target: {
            section: "finance",
            anchorId: "disputesBody",
          },
        },
    pendingUsers === null
      ? buildUnavailableOverviewAction({
          key: "users",
          title: "User signup review summary unavailable",
          reason: "The admissions summary could not be loaded. Open User Management directly to check new signups awaiting approval or denial.",
          buttonLabel: "Open User Management",
          target: { section: "user-management", anchorId: "pendingUsersPanel" },
          weight: 78,
        })
      : {
          key: "users",
          weight: pendingUsers > 0 ? 85 : 7,
          priority: pendingUsers > 0 ? "now" : "clear",
          title:
            pendingUsers > 0
              ? `Review ${formatActionCount(pendingUsers, "new user signup")}`
              : "No new user signups are waiting",
          meta:
            pendingUsers > 0
              ? "Admissions review lives in User Management."
              : "No new signups are waiting on approval right now.",
          reason:
            pendingUsers > 0
              ? "New signups are waiting for you to approve or deny access before they can move forward."
              : "You only need User Management for maintenance or outreach right now.",
          buttonLabel: "Open User Management",
          target: {
            section: "user-management",
            anchorId: "pendingUsersPanel",
          },
        },
    engineeringBlocked === null || engineeringAwaitingApproval === null
      ? buildUnavailableOverviewAction({
          key: "engineering",
          title: "Engineering overview unavailable",
          reason: "The engineering summary could not be loaded. Open Engineering directly if you need to verify blocked or approval-gated work.",
          buttonLabel: "Open Engineering",
          target: { section: "engineering", anchorId: "engineeringQueueList" },
          weight: 58,
        })
      : {
          key: "engineering",
          weight: engineeringBlocked + engineeringAwaitingApproval > 0 ? 80 : 6,
          priority: engineeringBlocked > 0 ? "now" : engineeringAwaitingApproval > 0 ? "next" : "clear",
          title:
            engineeringBlocked + engineeringAwaitingApproval > 0
              ? `Review ${formatActionCount(
                  engineeringBlocked + engineeringAwaitingApproval,
                  "engineering item"
                )}`
              : "No engineering review is waiting",
          meta:
            engineeringBlocked > 0
              ? `${formatActionCount(engineeringBlocked, "blocked item")} and ${formatActionCount(
                  engineeringAwaitingApproval,
                  "approval-gated item"
                )}.`
              : engineeringAwaitingApproval > 0
              ? `${formatActionCount(engineeringAwaitingApproval, "approval-gated item")} waiting in Engineering.`
              : "Engineering is clear unless you are checking incident detail.",
          reason:
            engineeringBlocked > 0
              ? "Blocked or approval-gated engineering work should be reviewed after live support and finance risk."
              : engineeringAwaitingApproval > 0
              ? "Engineering has work paused on approval-first review."
              : "No engineering item currently appears blocked or waiting on approval.",
          buttonLabel: "Open Engineering",
          target: {
            section: "engineering",
            anchorId: "engineeringQueueList",
          },
        },
    marketingPending === null
      ? buildUnavailableOverviewAction({
          key: "marketing",
          title: "Marketing overview unavailable",
          reason: "The marketing summary could not be loaded. Open Marketing directly if you need to verify review-ready drafts.",
          buttonLabel: "Open Marketing",
          target: { section: "marketing-drafts", anchorId: "marketingPacketList" },
          weight: 48,
        })
      : {
          key: "marketing",
          weight: marketingPending > 0 ? 60 : 5,
          priority: marketingPending > 0 ? "next" : "clear",
          title:
            marketingPending > 0
              ? `Review ${formatActionCount(marketingPending, "marketing draft")}`
              : "No marketing drafts are waiting",
          meta:
            marketingPending > 0
              ? "Founder/admin review is waiting in Marketing."
              : "Marketing is clear unless you are planning or configuring publishing.",
          reason:
            marketingPending > 0
              ? "Marketing drafts are waiting on approval before they can be used."
              : "There is no current marketing approval backlog.",
          buttonLabel: "Open Marketing",
          target: {
            section: "marketing-drafts",
            anchorId: "marketingPacketList",
          },
        },
    salesPending === null
      ? buildUnavailableOverviewAction({
          key: "sales",
          title: "Sales overview unavailable",
          reason: "The sales summary could not be loaded. Open Sales directly if you need to verify pending draft review.",
          buttonLabel: "Open Sales",
          target: { section: "sales-workspace", anchorId: "salesPacketList" },
          weight: 44,
        })
      : {
          key: "sales",
          weight: salesPending > 0 ? 55 : 4,
          priority: salesPending > 0 ? "next" : "clear",
          title:
            salesPending > 0
              ? `Review ${formatActionCount(salesPending, "sales draft")}`
              : "No sales drafts are waiting",
          meta:
            salesPending > 0
              ? "Outbound content review is waiting in Sales."
              : "Sales is clear unless you are doing account maintenance or creating drafts.",
          reason:
            salesPending > 0
              ? "Sales drafts are waiting on approval before they can be used."
              : "No sales draft is currently waiting on approval.",
          buttonLabel: "Open Sales",
          target: {
            section: "sales-workspace",
            anchorId: "salesPacketList",
          },
        },
  ];

  return rows.sort((left, right) => right.weight - left.weight);
}

function renderOverviewActionBoard(actions = [], { warningMessage = "" } = {}) {
  if (!overviewActionRowsEl) return;
  if (!actions.length && !warningMessage) {
    overviewActionRowsEl.innerHTML = `<tr><td colspan="4" class="overview-action-empty">No overview actions are available right now.</td></tr>`;
    return;
  }

  const warningRow = warningMessage
    ? `<tr><td colspan="4" class="overview-action-warning" role="status">${escapeHTML(warningMessage)}</td></tr>`
    : "";

  overviewActionRowsEl.innerHTML = `${warningRow}${actions
    .map(
      (action) => `
        <tr
          class="overview-action-row"
          data-overview-target-section="${escapeHTML(action.target?.section || "")}"
          data-overview-target-anchor="${escapeHTML(action.target?.anchorId || "")}"
          data-overview-target-behavior="${escapeHTML(action.key || "")}"
          tabindex="0"
          role="button"
          aria-label="${escapeHTML(`${action.title}. ${action.buttonLabel}.`)}"
        >
          <td><span class="overview-action-priority overview-action-priority--${escapeHTML(action.priority)}">${escapeHTML(
            action.priority === "now" ? "Now" : action.priority === "next" ? "Next" : "Clear"
          )}</span></td>
          <td>
            <strong class="overview-action-title">${escapeHTML(action.title)}</strong>
            <span class="overview-action-meta">${escapeHTML(action.meta)}</span>
          </td>
          <td><p class="overview-action-reason">${escapeHTML(action.reason)}</p></td>
          <td><span class="btn secondary" aria-hidden="true">${escapeHTML(action.buttonLabel)}</span></td>
        </tr>
      `
    )
    .join("")}`;
}

async function loadOverviewActionBoard(force = false) {
  if (!overviewActionRowsEl) return [];
  const now = Date.now();
  if (overviewActionsPromise) {
    if (force) overviewActionsQueuedForceRefresh = true;
    return overviewActionsPromise;
  }
  if (!force && now - lastOverviewActionsAt < OVERVIEW_ACTIONS_COOLDOWN_MS && overviewActionRowsEl.children.length) {
    return [];
  }

  if (overviewActionStatusEl) {
    overviewActionStatusEl.textContent = "Refreshing admin action board…";
  }

  overviewActionsPromise = (async () => {
    const analyticsPayload = latestAnalytics || (await hydrateAnalytics()) || {};
    const [
      approvalsResult,
      supportResult,
      marketingResult,
      salesResult,
      engineeringResult,
      disputesResult,
    ] =
      await Promise.all([
        fetchOverviewResource("Approvals", "/api/admin/approvals/overview", null),
        fetchOverviewResource("Support", "/api/admin/support/overview", null),
        fetchOverviewResource("Marketing", "/api/admin/marketing/overview", null),
        fetchOverviewResource("Sales", "/api/admin/sales/overview", null),
        fetchOverviewResource("Engineering", "/api/admin/engineering/overview", null),
        fetchOverviewResource("Finance", "/api/disputes/admin?status=open&limit=1", null),
      ]);

    const failedResources = [
      approvalsResult,
      supportResult,
      marketingResult,
      salesResult,
      engineeringResult,
      disputesResult,
    ]
      .filter((result) => !result.ok)
      .map((result) => result.key);

    const actions = buildOverviewActions({
      approvalsPending: approvalsResult.ok ? approvalsResult.payload?.counts?.pending : null,
      supportBlockers: supportResult.ok ? supportResult.payload?.counts?.blockers : null,
      supportOpen: supportResult.ok ? supportResult.payload?.counts?.open : null,
      disputesOpen: disputesResult.ok ? disputesResult.payload?.total : null,
      pendingUsers: analyticsPayload?.userMetrics?.pendingApprovals,
      engineeringBlocked: engineeringResult.ok ? engineeringResult.payload?.overview?.summary?.blockedCount : null,
      engineeringAwaitingApproval: engineeringResult.ok
        ? engineeringResult.payload?.overview?.summary?.awaitingApprovalCount
        : null,
      marketingPending: marketingResult.ok ? marketingResult.payload?.counts?.pendingReview : null,
      salesPending: salesResult.ok ? salesResult.payload?.counts?.pendingReview : null,
    });

    const warningMessage = failedResources.length
      ? `Overview is partially unavailable. Verify these workspaces directly: ${failedResources.join(", ")}.`
      : "";

    renderOverviewActionBoard(actions, { warningMessage });
    lastOverviewActionsAt = Date.now();
    if (overviewActionStatusEl) {
      const actionableCount = actions.filter((action) => action.priority !== "clear").length;
      if (warningMessage) {
        overviewActionStatusEl.textContent =
          actionableCount > 0
            ? `${formatNumber(actionableCount)} admin action${actionableCount === 1 ? "" : "s"} need attention right now. Some overview sources are unavailable.`
            : "Overview is partially unavailable. Open the listed workspaces directly before assuming everything is clear.";
      } else {
        overviewActionStatusEl.textContent =
          actionableCount > 0
            ? `${formatNumber(actionableCount)} admin action${actionableCount === 1 ? "" : "s"} need attention right now.`
            : "No urgent admin actions are waiting right now.";
      }
    }
    return actions;
  })();

  try {
    return await overviewActionsPromise;
  } finally {
    overviewActionsPromise = null;
    if (overviewActionsQueuedForceRefresh) {
      overviewActionsQueuedForceRefresh = false;
      window.setTimeout(() => {
        void loadOverviewActionBoard(true);
      }, 0);
    }
  }
}

const AI_CONTROL_ROOM_FOCUS_ENDPOINTS = {
  marketing: "/api/admin/ai/control-room/marketing",
  sales: "/api/admin/ai/control-room/sales",
  founder: "/api/admin/ai/control-room/founder",
  admissions: "/api/admin/ai/control-room/admissions",
  support: "/api/admin/ai/control-room/support",
  engineering: "/api/admin/ai/control-room/engineering",
  payments: "/api/admin/ai/control-room/payments-risk",
  incidents: "/api/admin/ai/control-room/incidents",
  lifecycle: "/api/admin/ai/control-room/lifecycle",
};

const AI_CONTROL_ROOM_DECISION_LANE_ORDER = ["cto", "cco", "cmo", "cso", "cao"];

const AI_CONTROL_ROOM_BLOCKED_COPY = {
  cco: {
    title: "Support answers are blocked waiting on your decision",
    explanation: (count) => `${pluralizeAIControlRoom(count, "support answer")} cannot be used until you approve or reject it.`,
    proposedAction: "Approve or reject the top FAQ candidate in Support Ops.",
    actionHelperText: "Once you decide, Support can either use the approved wording or keep it out.",
    blockedReason: "Blocked because support wording still needs approval.",
    unblockAction: "Approve or reject the pending FAQ candidate.",
    cardBody: "Governed support wording is paused until you decide.",
    tone: "needs-review",
    urgencyLabel: "Needs attention today",
    navSection: "support-ops",
    agentRole: "CCO",
  },
  cmo: {
    title: "Marketing drafts are blocked waiting on your approval",
    explanation: (count) => `${pluralizeAIControlRoom(count, "marketing draft")} cannot move forward until you decide.`,
    proposedAction: "Approve or reject the top marketing draft.",
    actionHelperText: "Your decision determines whether the draft can move forward.",
    blockedReason: "Blocked because this content still needs approval.",
    unblockAction: "Approve or reject the pending marketing draft.",
    cardBody: "Public-facing marketing content is paused until you decide.",
    tone: "needs-review",
    urgencyLabel: "Needs attention today",
    navSection: "marketing-drafts",
    agentRole: "CMO",
  },
  cso: {
    title: "Sales drafts are blocked waiting on your approval",
    explanation: (count) => `${pluralizeAIControlRoom(count, "sales draft")} cannot move forward until you decide.`,
    proposedAction: "Approve or reject the top sales draft.",
    actionHelperText: "Your decision determines whether this outreach content can be used in the existing sales workflow.",
    blockedReason: "Blocked because outbound sales content still needs approval.",
    unblockAction: "Approve or reject the pending sales draft.",
    cardBody: "Outbound sales content is paused until you decide.",
    tone: "needs-review",
    urgencyLabel: "Needs attention today",
    navSection: "sales-workspace",
    agentRole: "CSO",
  },
  cto: {
    title: "Engineering release work is blocked waiting on your approval",
    explanation: (count) => `${pluralizeAIControlRoom(count, "incident")} are paused because the existing release path needs your decision.`,
    proposedAction: "Approve or reject the top engineering release decision.",
    actionHelperText: "Your yes or no determines whether the existing engineering release path can continue.",
    blockedReason: "Blocked because an engineering release step is approval-gated in the current workflow.",
    unblockAction: "Approve or reject the pending engineering release decision.",
    cardBody: "Engineering release work is paused until you decide.",
    tone: "priority",
    urgencyLabel: "Urgent today",
    navSection: "engineering",
    agentRole: "CTO",
  },
  cao: {
    title: "Admissions review is blocked waiting on your decision",
    explanation: (count) => `${pluralizeAIControlRoom(count, "application")} are ready for your decision and cannot move until you choose.`,
    proposedAction: "Approve or deny the top ready application.",
    actionHelperText: "Your decision will move the applicant through the existing admissions route.",
    blockedReason: "Blocked because the application is ready for review.",
    unblockAction: "Approve or deny the pending application.",
    cardBody: "Ready admissions are paused until you decide.",
    tone: "needs-review",
    urgencyLabel: "Needs attention today",
    navSection: "user-management",
    agentRole: "CAO",
  },
};

const aiControlRoomState = {
  summary: null,
  focusViews: {},
  lastLoadedAt: 0,
  pendingSummary: null,
  pendingFocus: new Map(),
  loadStatus: "idle",
  optimisticDecisionRemovals: [],
  pendingBackgroundSync: null,
  queuedBackgroundSync: false,
};

const incidentRoomState = {
  list: [],
  clusters: [],
  activeIncidentId: "",
  detail: null,
  timeline: [],
};

function getAIControlRoomDecisionCardId(item = {}) {
  return String(item.groupKey || item.id || `${item.agentRole || "lane"}:${item.title || "decision"}`).trim();
}

function captureAIControlRoomDecisionQueueSnapshot(root = null) {
  const host = root && typeof root.querySelector === "function" ? root : document;
  const list = host.querySelector(".ai-room-founder-decision-list");
  if (!list) return null;

  const cards = new Map();
  list.querySelectorAll(".ai-room-founder-decision-card[data-ai-room-decision-id]").forEach((card) => {
    const id = String(card.getAttribute("data-ai-room-decision-id") || "").trim();
    if (!id) return;
    cards.set(id, {
      rect: card.getBoundingClientRect(),
      html: card.outerHTML,
    });
  });

  return {
    cards,
  };
}

function animateAIControlRoomDecisionQueueTransition(snapshot = null, root = null) {
  if (!snapshot?.cards?.size) return;
  const host = root && typeof root.querySelector === "function" ? root : document;
  const nextCards = new Map();
  host.querySelectorAll(".ai-room-founder-decision-card[data-ai-room-decision-id]").forEach((card) => {
    const id = String(card.getAttribute("data-ai-room-decision-id") || "").trim();
    if (!id) return;
    nextCards.set(id, card);
  });

  snapshot.cards.forEach((previous, id) => {
    const nextCard = nextCards.get(id);
    if (nextCard) {
      const nextRect = nextCard.getBoundingClientRect();
      const deltaX = previous.rect.left - nextRect.left;
      const deltaY = previous.rect.top - nextRect.top;
      if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
        nextCard.animate(
          [
            { transform: `translate(${deltaX}px, ${deltaY}px)` },
            { transform: "translate(0, 0)" },
          ],
          {
            duration: 220,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          }
        );
      }
      return;
    }

    const ghostMount = document.createElement("div");
    ghostMount.innerHTML = previous.html;
    const ghost = ghostMount.firstElementChild;
    if (!ghost) return;
    ghost.classList.add("is-exiting");
    ghost.style.position = "fixed";
    ghost.style.left = `${previous.rect.left}px`;
    ghost.style.top = `${previous.rect.top}px`;
    ghost.style.width = `${previous.rect.width}px`;
    ghost.style.height = `${previous.rect.height}px`;
    ghost.style.margin = "0";
    ghost.style.pointerEvents = "none";
    ghost.style.zIndex = "50";
    document.body.appendChild(ghost);
    const animation = ghost.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-10px) scale(0.985)" },
      ],
      {
        duration: 180,
        easing: "ease-out",
        fill: "forwards",
      }
    );
    animation.finished.catch(() => {}).finally(() => {
      ghost.remove();
    });
  });
}

function buildAIControlRoomFallbackCard({
  key,
  title,
  department,
  description,
  actionLabel,
  navSection = "",
  footerNote = "",
  metric1Label = "",
  metric2Label = "",
  unavailable = false,
}) {
  return {
    key,
    title,
    department,
    description,
    status: unavailable ? "UNAVAILABLE" : "Loading",
    tone: unavailable ? "blocked" : "active",
    metric1: {
      label: metric1Label,
      value: unavailable ? null : null,
    },
    metric2: {
      label: metric2Label,
      value: unavailable ? null : null,
    },
    actionText: unavailable
      ? "This role will populate when a live source is wired into the control room."
      : "Loading live data.",
    recommendedAction: unavailable
      ? "This role will populate when a live source is wired into the control room."
      : "Loading live data.",
    footerNote,
    queues: [
      { label: metric1Label, value: null },
      { label: metric2Label, value: null },
    ],
    decisionState: {
      needsDecisionCount: 0,
      autoHandledCount: 0,
      blockedWaitingCount: 0,
      attentionStatus: unavailable ? "Live status unavailable" : "Loading live status",
      decisionSummary: unavailable ? "Live decision data is unavailable." : "Loading live decision data.",
      autoStatus: unavailable ? "Live autonomy data is unavailable." : "Loading live autonomy data.",
      blockedSummary: unavailable ? "Live blocker data is unavailable." : "Loading live blocker data.",
      nextAction: unavailable ? "Open the matching tab when data returns." : "Loading next action.",
      topDecision: null,
    },
    actionButton: {
      label: actionLabel,
      targetTab: navSection,
      disabled: unavailable && !navSection,
    },
  };
}

function buildAIControlRoomLoadingFocus(title) {
  return {
    title,
    status: "Loading",
    tone: "active",
    queueLabel: "Loading live data",
    primary: {
      title: "Status",
      body: "Loading live data.",
    },
    secondary: {
      title: "Availability",
      items: ["Live data is still loading."],
    },
    tertiary: {
      title: "Queue",
      items: ["No live queue items have loaded yet."],
    },
    quaternary: {
      title: "Records",
      items: ["No real draft or queue records are visible yet."],
    },
  };
}

function buildAIControlRoomUnavailableFocus(title, body) {
  return {
    title,
    status: "Unavailable",
    tone: "blocked",
    queueLabel: "Unavailable",
    primary: {
      title: "Status",
      body,
    },
    secondary: {
      title: "Availability",
      items: ["This view does not have a live backend source in the War Room."],
    },
    tertiary: {
      title: "Queue",
      items: ["No queue data is available."],
    },
    quaternary: {
      title: "Records",
      items: ["No real records are available."],
    },
  };
}

function buildAIControlRoomFallbackData() {
  const isUnavailable = aiControlRoomState.loadStatus === "error";
  const buildNeutralFocus = isUnavailable
    ? (title) =>
        buildAIControlRoomUnavailableFocus(title, "Live data is unavailable for this view right now.")
    : buildAIControlRoomLoadingFocus;

  return {
    summary: {
      urgent: {
        value: isUnavailable ? "Unavailable" : "—",
        note: isUnavailable ? "Live queue data is unavailable." : "Loading live incident and queue data.",
      },
      review: {
        value: isUnavailable ? "Unavailable" : "—",
        note: isUnavailable ? "Live review data is unavailable." : "Loading live review counts.",
      },
      blocked: {
        value: isUnavailable ? "Unavailable" : "—",
        note: isUnavailable ? "Live blocker data is unavailable." : "Loading live blocked counts.",
      },
      risk: {
        value: isUnavailable ? "Unavailable" : "—",
        note: isUnavailable ? "Live risk data is unavailable." : "Loading live risk signals.",
      },
      health: {
        value: isUnavailable ? "Unavailable" : "—",
        note: isUnavailable ? "Live control room health is unavailable." : "Loading live control room health.",
      },
    },
    cards: [
      buildAIControlRoomFallbackCard({
        key: "cmo",
        title: "CMO",
        department: "Marketing",
        description: "Oversees founder-reviewed marketing draft volume and outbound packet readiness on LPC.",
        actionLabel: "Open Marketing",
        navSection: "marketing-drafts",
        footerNote: isUnavailable ? "Live marketing data is unavailable." : "Loading live marketing data.",
        metric1Label: "Pending review",
        metric2Label: "Draft packets",
        unavailable: isUnavailable,
      }),
      buildAIControlRoomFallbackCard({
        key: "cto",
        title: "CTO",
        department: "Engineering",
        description: "Oversees live incident load and blocked engineering work across LPC.",
        actionLabel: "Open Engineering",
        navSection: "engineering",
        footerNote: isUnavailable ? "Live engineering data is unavailable." : "Loading live engineering data.",
        metric1Label: "Open incidents",
        metric2Label: "Blocked incidents",
        unavailable: isUnavailable,
      }),
      buildAIControlRoomFallbackCard({
        key: "cfo",
        title: "CFO",
        department: "Payments & Risk",
        description: "Oversees dispute exposure and money-sensitive incident risk.",
        actionLabel: "Open Disputes",
        navSection: "finance",
        footerNote: isUnavailable ? "Live payments data is unavailable." : "Loading live payments and risk data.",
        metric1Label: "Open disputes",
        metric2Label: "Money issues",
        unavailable: isUnavailable,
      }),
      buildAIControlRoomFallbackCard({
        key: "coo",
        title: "COO",
        department: "Operations",
        description: "Oversees stalled user operations and the current lifecycle follow-up load.",
        actionLabel: "Open Operations",
        navSection: "user-management",
        footerNote: isUnavailable ? "Live operations data is unavailable." : "Loading live lifecycle data.",
        metric1Label: "Stalled users",
        metric2Label: "Follow-ups today",
        unavailable: isUnavailable,
      }),
      buildAIControlRoomFallbackCard({
        key: "cso",
        title: "CSO",
        department: "Sales",
        description: "Oversees awareness accounts and the current sales review workload.",
        actionLabel: "Open Sales",
        navSection: "sales-workspace",
        footerNote: isUnavailable ? "Live sales data is unavailable." : "Loading live sales data.",
        metric1Label: "Pending review",
        metric2Label: "Active accounts",
        unavailable: isUnavailable,
      }),
      buildAIControlRoomFallbackCard({
        key: "cco",
        title: "CCO",
        department: "Customer Support",
        description: "Oversees open support workload and tickets that have already escalated.",
        actionLabel: "Open Support",
        navSection: "support-ops",
        footerNote: isUnavailable ? "Live support data is unavailable." : "Loading live support data.",
        metric1Label: "Open support issues",
        metric2Label: "Escalations",
        unavailable: isUnavailable,
      }),
      buildAIControlRoomFallbackCard({
        key: "cao",
        title: "CAO",
        department: "Admissions",
        description: "Oversees pending attorney and paralegal admissions review volume.",
        actionLabel: "Open Admissions",
        navSection: "user-management",
        footerNote: isUnavailable ? "Live admissions data is unavailable." : "Loading live admissions data.",
        metric1Label: "Attorney review",
        metric2Label: "Paralegal review",
        unavailable: isUnavailable,
      }),
    ],
    focusViews: {
      marketing: buildNeutralFocus("Marketing / CMO"),
      sales: buildNeutralFocus("Sales / Awareness"),
      founder: buildNeutralFocus("Decision Copilot"),
      admissions: buildNeutralFocus("Admissions / Review"),
      support: buildNeutralFocus("Support Ops"),
      engineering: buildAIControlRoomUnavailableFocus(
        "Engineering Triage",
        "Engineering triage is not available in the War Room yet."
      ),
      payments: buildNeutralFocus("Payments & Risk"),
      incidents: buildNeutralFocus("Incident Control Room"),
      lifecycle: buildNeutralFocus("Lifecycle & Follow-Up"),
    },
    urgentQueue: [],
    awaitingReview: [],
    recentEscalations: [],
    outboundMessages: [],
  };
}

function mergeAIControlRoomCards(fallbackCards = [], liveCards = []) {
  const byKey = new Map(fallbackCards.map((card) => [card.key, { ...card }]));
  (liveCards || []).forEach((card) => {
    if (!card?.key) return;
    byKey.set(card.key, { ...(byKey.get(card.key) || {}), ...card });
  });
  return fallbackCards.map((card) => byKey.get(card.key) || card);
}

function getMergedAIControlRoomData() {
  const fallback = buildAIControlRoomFallbackData();
  const liveSummary = aiControlRoomState.summary || null;
  const liveFocusViews = aiControlRoomState.focusViews || {};

  const merged = {
    ...fallback,
    summary: {
      ...fallback.summary,
      ...(liveSummary?.summary || {}),
      health: liveSummary?.summary?.health ?? fallback.summary.health,
      blocked: liveSummary?.summary?.blocked ?? fallback.summary.blocked,
    },
    cards: mergeAIControlRoomCards(fallback.cards, liveSummary?.cards || []),
    focusViews: {
      ...fallback.focusViews,
      ...liveFocusViews,
    },
    urgentQueue: Array.isArray(liveSummary?.urgentQueue) ? liveSummary.urgentQueue : fallback.urgentQueue,
    awaitingReview: Array.isArray(liveSummary?.awaitingReview) ? liveSummary.awaitingReview : fallback.awaitingReview,
    recentEscalations: Array.isArray(liveSummary?.recentEscalations) ? liveSummary.recentEscalations : fallback.recentEscalations,
    outboundMessages: Array.isArray(liveSummary?.outboundMessages) ? liveSummary.outboundMessages : fallback.outboundMessages,
  };

  return applyOptimisticDecisionRemovalsToData(merged);
}

async function fetchAIControlRoomSummaryPayload() {
  const res = await secureFetch("/api/admin/ai-control-room", {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Unable to load AI Control Room summary.");
  }
  return payload;
}

async function fetchAIControlRoomFocusPayload(key) {
  const endpoint = AI_CONTROL_ROOM_FOCUS_ENDPOINTS[key];
  if (!endpoint) return null;
  const res = await secureFetch(endpoint, {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `Unable to load ${key} view.`);
  }
  return payload?.view || null;
}

async function loadAIControlRoomSummary(force = false) {
  if (aiControlRoomState.summary && !force) return aiControlRoomState.summary;
  if (aiControlRoomState.pendingSummary && !force) return aiControlRoomState.pendingSummary;

  aiControlRoomState.loadStatus = "loading";

  const pending = (async () => {
    try {
      const payload = await fetchAIControlRoomSummaryPayload();
      aiControlRoomState.summary = payload;
      aiControlRoomState.lastLoadedAt = Date.now();
      aiControlRoomState.loadStatus = "ready";
      return payload;
    } catch (err) {
      aiControlRoomState.loadStatus = "error";
      throw err;
    }
  })();

  aiControlRoomState.pendingSummary = pending;
  try {
    return await pending;
  } finally {
    aiControlRoomState.pendingSummary = null;
  }
}

async function loadAIControlRoomFocus(key, force = false) {
  const endpoint = AI_CONTROL_ROOM_FOCUS_ENDPOINTS[key];
  if (!endpoint) return null;
  if (aiControlRoomState.focusViews[key] && !force) return aiControlRoomState.focusViews[key];
  if (aiControlRoomState.pendingFocus.has(key) && !force) return aiControlRoomState.pendingFocus.get(key);

  const pending = (async () => {
    const view = await fetchAIControlRoomFocusPayload(key);
    if (view) {
      aiControlRoomState.focusViews[key] = view;
    }
    return view;
  })();

  aiControlRoomState.pendingFocus.set(key, pending);
  try {
    return await pending;
  } finally {
    aiControlRoomState.pendingFocus.delete(key);
  }
}

async function syncAIControlRoomInBackground({ refreshIncidentWorkspace = false } = {}) {
  if (aiControlRoomState.pendingBackgroundSync) {
    aiControlRoomState.queuedBackgroundSync = true;
    return aiControlRoomState.pendingBackgroundSync;
  }

  const pending = (async () => {
    try {
      do {
        aiControlRoomState.queuedBackgroundSync = false;
        const focusKeys = Array.from(
          new Set(
            ["founder", activeAIControlRoomKey]
              .map((key) => String(key || "").trim())
              .filter((key) => AI_CONTROL_ROOM_FOCUS_ENDPOINTS[key])
          )
        );
        const [summaryPayload, ...views] = await Promise.all([
          fetchAIControlRoomSummaryPayload(),
          ...focusKeys.map(async (key) => ({ key, view: await fetchAIControlRoomFocusPayload(key) })),
        ]);

        aiControlRoomState.summary = summaryPayload;
        aiControlRoomState.lastLoadedAt = Date.now();
        aiControlRoomState.loadStatus = "ready";
        views.forEach(({ key, view }) => {
          if (view) aiControlRoomState.focusViews[key] = view;
        });

        pruneAIControlRoomOptimisticDecisionRemovals({
          summary: aiControlRoomState.summary,
          focusViews: aiControlRoomState.focusViews,
        });

        repaintAIControlRoomFromState();

        if (refreshIncidentWorkspace) {
          void renderIncidentWorkspace(true).catch(() => {});
        }
      } while (aiControlRoomState.queuedBackgroundSync);
    } finally {
      aiControlRoomState.pendingBackgroundSync = null;
    }
  })();

  aiControlRoomState.pendingBackgroundSync = pending;
  return pending;
}

function getBadgeClass(tone = "active") {
  const safeTone = String(tone || "active").toLowerCase();
  return `ai-room-badge ai-room-badge--${safeTone}`;
}

function renderAIControlRoomSummary(summary = {}) {
  const urgentTile = document.getElementById("aiSummaryUrgent");
  const reviewTile = document.getElementById("aiSummaryReview");
  const blockedTile = document.getElementById("aiSummaryBlocked");
  const riskTile = document.getElementById("aiSummaryRisk");
  const healthTile = document.getElementById("aiSummaryHealth");

  const applyTile = (element, value, note) => {
    if (!element) return;
    const valueEl = element.querySelector(".ai-room-summary-value");
    const noteEl = element.querySelector(".ai-room-summary-note");
    if (valueEl) valueEl.textContent = value;
    if (noteEl) noteEl.textContent = note;
  };

  applyTile(urgentTile, summary.urgent?.value || "0", summary.urgent?.note || "");
  applyTile(reviewTile, summary.review?.value || "0", summary.review?.note || "");
  applyTile(blockedTile, summary.blocked?.value || "0", summary.blocked?.note || "");
  applyTile(riskTile, summary.risk?.value || "0", summary.risk?.note || "");
  applyTile(healthTile, summary.health?.value || "—", summary.health?.note || "");
}

function formatAIControlRoomCount(value) {
  return Number.isFinite(Number(value)) ? formatNumber(Number(value)) : "0";
}

function pluralizeAIControlRoom(count, singular, plural = `${singular}s`) {
  const safeCount = Number(count) || 0;
  return `${safeCount} ${safeCount === 1 ? singular : plural}`;
}

function formatAIControlRoomConfidence(value) {
  if (!Number.isFinite(Number(value))) return "";
  return `${Math.round(Number(value) * 100)}% confidence`;
}

function uniqueAIControlRoomTexts(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => String(value || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )
  );
}

function deepCloneAIControlRoomValue(value) {
  if (typeof window !== "undefined" && typeof window.structuredClone === "function") {
    return window.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function buildAIControlRoomSummaryNotes({ needsDecisionCount = 0, autoHandledCount = 0, blockedWaitingCount = 0 } = {}) {
  return {
    urgent: {
      value: String(needsDecisionCount),
      note:
        needsDecisionCount > 0
          ? `${pluralizeAIControlRoom(needsDecisionCount, "decision")} need a yes or no right now across the live lanes.`
          : "No decision is currently required across the live lanes.",
    },
    review: {
      value: String(autoHandledCount),
      note:
        autoHandledCount > 0
          ? `${pluralizeAIControlRoom(autoHandledCount, "action")} were handled automatically today and logged for audit.`
          : "No auto-handled actions have been logged today.",
    },
    blocked: {
      value: String(blockedWaitingCount),
      note:
        blockedWaitingCount > 0
          ? `${pluralizeAIControlRoom(blockedWaitingCount, "item")} are paused until you decide.`
          : "Nothing is currently blocked waiting on your input.",
    },
  };
}

function buildAIControlRoomLocalLaneState({
  needsDecisionCount = 0,
  blockedWaitingCount = 0,
  autoHandledCount = 0,
  topDecision = null,
  autoStatus = "",
  noDecisionLabel = "No decision needed right now",
  nextAction = "",
} = {}) {
  const decisionSummary =
    needsDecisionCount > 0 ? `${pluralizeAIControlRoom(needsDecisionCount, "decision")} need your yes or no.` : noDecisionLabel;
  const blockedSummary =
    blockedWaitingCount > 0
      ? `${pluralizeAIControlRoom(blockedWaitingCount, "item")} are paused until you decide.`
      : "Nothing is blocked waiting on your input.";
  const attentionStatus =
    needsDecisionCount > 0
      ? "Attention needed now"
      : blockedWaitingCount > 0
        ? "Waiting on your input"
        : autoHandledCount > 0
          ? "Mostly autonomous today"
          : /awaiting system processing/i.test(noDecisionLabel)
            ? "Awaiting system processing"
            : /quick decision available/i.test(noDecisionLabel)
              ? "Manual lane"
              : "No attention needed";

  return {
    needsDecisionCount,
    blockedWaitingCount,
    autoHandledCount,
    topDecision,
    decisionSummary,
    blockedSummary,
    attentionStatus,
    autoStatus:
      autoStatus ||
      (autoHandledCount > 0
        ? `${pluralizeAIControlRoom(autoHandledCount, "item")} were handled automatically today.`
        : "No autonomous work is currently visible."),
    nextAction: nextAction || (topDecision ? topDecision.proposedAction : "Open the lane workspace for more detail."),
  };
}

function buildAIControlRoomDecisionDescriptor(input = {}) {
  return {
    kind: String(input.kind || "").trim(),
    decision: String(input.decision || "").trim(),
    groupKey: String(input.groupKey || "").trim(),
    workKey: String(input.workKey || "").trim(),
    incidentId: String(input.incidentId || "").trim(),
    approvalId: String(input.approvalId || "").trim(),
    userId: String(input.userId || "").trim(),
    agentRole: String(input.agentRole || "").trim(),
    actionType: String(input.actionType || "").trim(),
  };
}

function buildAIControlRoomDecisionDescriptorFromButton(button) {
  return buildAIControlRoomDecisionDescriptor({
    kind: button?.getAttribute("data-ai-room-decision-kind"),
    decision: button?.getAttribute("data-ai-room-decision"),
    groupKey: button?.getAttribute("data-ai-room-group-key"),
    workKey: button?.getAttribute("data-ai-room-work-key"),
    incidentId: button?.getAttribute("data-ai-room-incident-id"),
    approvalId: button?.getAttribute("data-ai-room-approval-id"),
    userId: button?.getAttribute("data-ai-room-user-id"),
    agentRole: button?.getAttribute("data-ai-room-agent-role"),
    actionType: button?.getAttribute("data-ai-room-action-type"),
  });
}

function aiControlRoomDecisionDescriptorKey(input = {}) {
  const descriptor = buildAIControlRoomDecisionDescriptor(input);
  if (descriptor.kind === "decision_group") return `${descriptor.kind}:${descriptor.groupKey}`;
  if (descriptor.kind === "approval_item") return `${descriptor.kind}:${descriptor.workKey}`;
  if (descriptor.kind === "incident_approval") return `${descriptor.kind}:${descriptor.incidentId}:${descriptor.approvalId}`;
  if (descriptor.kind === "user_review") return `${descriptor.kind}:${descriptor.userId}`;
  if (descriptor.kind === "autonomy_preference") return `${descriptor.kind}:${descriptor.agentRole}:${descriptor.actionType}`;
  return `${descriptor.kind}:${descriptor.decision}:${descriptor.workKey}:${descriptor.incidentId}:${descriptor.approvalId}:${descriptor.userId}`;
}

function matchesAIControlRoomActionDescriptor(action = {}, input = {}) {
  const descriptor = buildAIControlRoomDecisionDescriptor(input);
  if (!descriptor.kind || String(action?.kind || "") !== descriptor.kind) return false;
  if (descriptor.kind === "decision_group") {
    return String(action?.groupKey || "") === descriptor.groupKey;
  }
  if (descriptor.kind === "approval_item") {
    return String(action?.workKey || "") === descriptor.workKey;
  }
  if (descriptor.kind === "incident_approval") {
    return (
      String(action?.incidentId || "") === descriptor.incidentId &&
      String(action?.approvalId || "") === descriptor.approvalId
    );
  }
  if (descriptor.kind === "user_review") {
    return String(action?.userId || "") === descriptor.userId;
  }
  if (descriptor.kind === "autonomy_preference") {
    return (
      String(action?.agentRole || "") === descriptor.agentRole &&
      String(action?.actionType || "") === descriptor.actionType
    );
  }
  return false;
}

function getAIControlRoomDecisionOutcomePath(item = {}) {
  const yesKind = String(item?.actions?.yes?.kind || "").trim();
  const noKind = String(item?.actions?.no?.kind || "").trim();
  if (!yesKind || !noKind) return "";
  return `${yesKind}:${noKind}`;
}

function getAIControlRoomDecisionGroupingKey(item = {}) {
  if (String(item?.actions?.yes?.kind || "").trim() === "decision_group" && item?.groupKey) {
    return String(item.groupKey).trim();
  }
  const agentRole = String(item?.agentRole || "").trim();
  const actionType = String(item?.actionType || item?.policyType || "").trim();
  const outcomePath = getAIControlRoomDecisionOutcomePath(item);
  if (!agentRole || !actionType || !outcomePath) return "";
  return `display-group:${agentRole}:${actionType}:${outcomePath}`;
}

function serializeAIControlRoomDecisionActionForBatch(action = {}) {
  if (!action || typeof action !== "object") return null;
  return {
    kind: String(action.kind || "").trim(),
    decision: String(action.decision || "").trim(),
    workKey: String(action.workKey || "").trim(),
    incidentId: String(action.incidentId || "").trim(),
    approvalId: String(action.approvalId || "").trim(),
    userId: String(action.userId || "").trim(),
    agentRole: String(action.agentRole || "").trim(),
    actionType: String(action.actionType || "").trim(),
  };
}

function buildAIControlRoomGroupedDecisionCopy({ actionType = "", count = 0 } = {}) {
  if (actionType === "marketing_draft_packet") {
    return {
      title: `${count} LinkedIn posts ready`,
      explanation: `Approve or reject all ${count} posts together in the existing marketing workflow.`,
      proposedAction: `Apply the current publish decision path to all ${count} LinkedIn posts.`,
      actionHelperText: `Yes applies the existing approve path to all ${count} posts. No applies the existing reject path to all ${count} posts.`,
      yesLabel: "Yes, publish all",
      noLabel: "No, keep all out",
    };
  }
  if (actionType === "faq_candidate") {
    return {
      title: `${count} support answers waiting`,
      explanation: `Approve or reject all ${count} support answers together in the existing support flow.`,
      proposedAction: `Apply the current FAQ decision path to all ${count} support answers.`,
      actionHelperText: `Yes applies the existing approve path to all ${count} answers. No applies the existing reject path to all ${count} answers.`,
      yesLabel: "Yes, use all",
      noLabel: "No, keep all out",
    };
  }
  if (actionType === "admissions_review") {
    return {
      title: `${count} admissions approvals ready`,
      explanation: `Approve or deny all ${count} ready admissions decisions together in the current admissions flow.`,
      proposedAction: `Apply the current admissions decision path to all ${count} ready applications.`,
      actionHelperText: `Yes applies the existing approve path to all ${count} applications. No applies the existing deny path to all ${count} applications.`,
      yesLabel: "Yes, admit all",
      noLabel: "No, deny all",
    };
  }
  if (actionType === "sales_draft_packet") {
    return {
      title: `${count} outreach drafts ready`,
      explanation: `Approve or reject all ${count} outreach drafts together in the existing sales workflow.`,
      proposedAction: `Apply the current outreach decision path to all ${count} drafts.`,
      actionHelperText: `Yes applies the existing approve path to all ${count} drafts. No applies the existing reject path to all ${count} drafts.`,
      yesLabel: "Yes, allow all",
      noLabel: "No, hold all",
    };
  }
  if (actionType === "incident_approval") {
    return {
      title: `${count} engineering approvals ready`,
      explanation: `Approve or reject all ${count} engineering release decisions together in the current workflow.`,
      proposedAction: `Apply the current engineering approval path to all ${count} incident decisions.`,
      actionHelperText: `Yes applies the existing approve path to all ${count} incidents. No applies the existing reject path to all ${count} incidents.`,
      yesLabel: "Yes, move all forward",
      noLabel: "No, keep all paused",
    };
  }
  return {
    title: `${count} decisions ready`,
    explanation: `Apply the same decision outcome to all ${count} matching items together.`,
    proposedAction: `Apply the current decision path to all ${count} matching items.`,
    actionHelperText: `Yes applies the existing approve path to all ${count} items. No applies the existing reject path to all ${count} items.`,
    yesLabel: "Yes, approve all",
    noLabel: "No, reject all",
  };
}

function buildAIControlRoomDisplayGroupedDecisionItem(items = []) {
  if (!Array.isArray(items) || items.length < 2) return items[0] || null;
  const first = items[0] || {};
  const groupKey = getAIControlRoomDecisionGroupingKey(first);
  const actionType = String(first.actionType || first.policyType || "").trim();
  const copy = buildAIControlRoomGroupedDecisionCopy({ actionType, count: items.length });
  const yesBatchActions = items.map((item) => serializeAIControlRoomDecisionActionForBatch(item?.actions?.yes)).filter(Boolean);
  const noBatchActions = items.map((item) => serializeAIControlRoomDecisionActionForBatch(item?.actions?.no)).filter(Boolean);
  if (!groupKey || yesBatchActions.length !== items.length || noBatchActions.length !== items.length) {
    return first;
  }

  return {
    ...first,
    id: `display:${groupKey}`,
    groupKey,
    groupCount: items.length,
    title: copy.title,
    explanation: copy.explanation,
    proposedAction: copy.proposedAction,
    actionHelperText: copy.actionHelperText,
    actions: {
      yes: {
        kind: "decision_group",
        decision: "approve",
        groupKey,
        batchActions: yesBatchActions,
        label: copy.yesLabel,
        successMessage: `${items.length} item${items.length === 1 ? "" : "s"} updated.`,
      },
      no: {
        kind: "decision_group",
        decision: String(first?.actions?.no?.decision || "").trim() || "reject",
        groupKey,
        batchActions: noBatchActions,
        label: copy.noLabel,
        successMessage: `${items.length} item${items.length === 1 ? "" : "s"} updated.`,
      },
      open: first?.actions?.open || null,
      edit: null,
    },
  };
}

function groupAIControlRoomDecisionQueueItems(items = []) {
  const ordered = Array.isArray(items) ? items.slice() : [];
  const grouped = [];
  const buckets = new Map();

  for (const item of ordered) {
    if (!item || typeof item !== "object") continue;
    if (String(item?.actions?.yes?.kind || "").trim() === "decision_group") {
      grouped.push(item);
      continue;
    }
    const groupKey = getAIControlRoomDecisionGroupingKey(item);
    if (!groupKey) {
      grouped.push(item);
      continue;
    }
    const existing = buckets.get(groupKey);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const bucket = { groupKey, items: [item] };
    buckets.set(groupKey, bucket);
    grouped.push(bucket);
  }

  return grouped.flatMap((entry) => {
    if (!entry?.items) return [entry];
    if (entry.items.length < 2) return entry.items;
    return [buildAIControlRoomDisplayGroupedDecisionItem(entry.items)];
  });
}

function matchesAIControlRoomDecisionItem(item = {}, input = {}) {
  const descriptor = buildAIControlRoomDecisionDescriptor(input);
  if (descriptor.kind === "decision_group" && getAIControlRoomDecisionGroupingKey(item) === descriptor.groupKey) {
    return true;
  }
  return [item?.actions?.yes, item?.actions?.no].some((action) => matchesAIControlRoomActionDescriptor(action, input));
}

function matchesAIControlRoomUpgradeSuggestion(item = {}, input = {}) {
  return [item?.actions?.yes, item?.actions?.no].some((action) => matchesAIControlRoomActionDescriptor(action, input));
}

function buildAIControlRoomBlockedItemForLane(laneKey, count, topDecisionTitle = "") {
  const config = AI_CONTROL_ROOM_BLOCKED_COPY[laneKey];
  if (!config || count <= 0) return null;
  return {
    id: `blocked-${laneKey}`,
    laneKey,
    agentRole: config.agentRole,
    title: config.title,
    explanation: config.explanation(count),
    preview: topDecisionTitle,
    proposedAction: config.proposedAction,
    actionHelperText: config.actionHelperText,
    blockedReason: config.blockedReason,
    unblockAction: config.unblockAction,
    urgencyLabel: config.urgencyLabel,
    cardBody: config.cardBody,
    tone: config.tone,
    actions: {
      yes: null,
      no: null,
      open: { kind: "nav", label: "Open Details", navSection: config.navSection, disabled: false },
      edit: null,
    },
  };
}

function applyAIControlRoomDecisionGroupingToData(data = {}) {
  const founderView = data?.focusViews?.founder ? deepCloneAIControlRoomValue(data.focusViews.founder) : null;
  if (!founderView || founderView.surfaceMode !== "decision_hub") {
    return data;
  }

  const groupedDecisionQueue = groupAIControlRoomDecisionQueueItems(Array.isArray(founderView.decisionQueue) ? founderView.decisionQueue : []);
  const laneQueues = new Map();
  for (const laneKey of AI_CONTROL_ROOM_DECISION_LANE_ORDER) laneQueues.set(laneKey, []);
  groupedDecisionQueue.forEach((item) => {
    const laneKey = String(item?.laneKey || "").trim().toLowerCase();
    if (!laneQueues.has(laneKey)) laneQueues.set(laneKey, []);
    laneQueues.get(laneKey).push(item);
  });

  const cloned = {
    ...data,
    summary: { ...(data.summary || {}) },
    cards: Array.isArray(data.cards)
      ? data.cards.map((card) => ({
          ...card,
          decisionState: { ...(card.decisionState || {}) },
        }))
      : [],
    focusViews: { ...(data.focusViews || {}) },
  };

  founderView.decisionQueue = groupedDecisionQueue;
  founderView.blockedItems = AI_CONTROL_ROOM_DECISION_LANE_ORDER
    .map((laneKey) => buildAIControlRoomBlockedItemForLane(laneKey, laneQueues.get(laneKey)?.length || 0, laneQueues.get(laneKey)?.[0]?.title || ""))
    .filter(Boolean);

  const needsDecisionCount = groupedDecisionQueue.length;
  const autoHandledCount = Array.isArray(founderView.autoHandledItems) ? founderView.autoHandledItems.length : 0;
  const blockedWaitingCount = founderView.blockedItems.reduce((sum, item) => {
    const laneKey = String(item?.laneKey || "").trim().toLowerCase();
    return sum + (laneQueues.get(laneKey)?.length || 0);
  }, 0);

  founderView.queueLabel = `${pluralizeAIControlRoom(needsDecisionCount, "decision")} pending`;
  founderView.primary = {
    ...(founderView.primary || {}),
    title: "What Needs Your Attention Today",
    body:
      needsDecisionCount > 0
        ? `Start with the first card below. ${pluralizeAIControlRoom(needsDecisionCount, "decision")} need a clear yes or no across the live areas.`
        : blockedWaitingCount > 0
          ? `${pluralizeAIControlRoom(blockedWaitingCount, "item")} are paused waiting on your input, but no direct yes or no is surfaced here.`
          : autoHandledCount > 0
            ? `No decision is required right now. ${pluralizeAIControlRoom(autoHandledCount, "action")} were already handled automatically today.`
            : "No decision is required right now. The Control Room is acting as a watch and triage surface.",
  };
  founderView.secondary = {
    ...(founderView.secondary || {}),
    title: "Current Ops Facts",
    items: [
      `${pluralizeAIControlRoom(needsDecisionCount, "decision")} need a yes or no right now.`,
      `${pluralizeAIControlRoom(autoHandledCount, "action")} were auto-handled today.`,
      `${pluralizeAIControlRoom(blockedWaitingCount, "item")} are paused waiting on your input.`,
      ...((Array.isArray(founderView.secondary?.items) ? founderView.secondary.items.slice(3) : [])),
    ],
  };
  founderView.tertiary = {
    ...(founderView.tertiary || {}),
    title: "Decision Queue",
    items: needsDecisionCount
      ? groupedDecisionQueue.slice(0, 4).map((item) => `${item.agentRole}: ${item.title} — ${item.explanation}`)
      : ["No decisions are currently waiting in the live approval lanes."],
  };

  cloned.focusViews.founder = founderView;

  cloned.cards = cloned.cards.map((card) => {
    const laneKey = String(card?.key || "").trim().toLowerCase();
    if (!laneQueues.has(laneKey)) return card;
    const currentState = card.decisionState || {};
    const laneDecisionItems = laneQueues.get(laneKey) || [];
    const laneState = buildAIControlRoomLocalLaneState({
      needsDecisionCount: laneDecisionItems.length,
      blockedWaitingCount: laneDecisionItems.length,
      autoHandledCount: Number(currentState.autoHandledCount || 0),
      topDecision: laneDecisionItems[0] || null,
      autoStatus: currentState.autoStatus || "",
      noDecisionLabel:
        /manual lane/i.test(currentState.attentionStatus || "") || /quick decision available/i.test(currentState.decisionSummary || "")
          ? "No quick decision available"
          : "No decision needed right now",
      nextAction: laneDecisionItems[0]?.proposedAction || card.recommendation || currentState.nextAction || "",
    });
    return {
      ...card,
      decisionState: {
        ...currentState,
        ...laneState,
      },
    };
  });

  const summaryNotes = buildAIControlRoomSummaryNotes({
    needsDecisionCount,
    autoHandledCount,
    blockedWaitingCount,
  });
  cloned.summary = {
    ...(cloned.summary || {}),
    urgent: {
      ...(cloned.summary?.urgent || {}),
      ...summaryNotes.urgent,
    },
    review: {
      ...(cloned.summary?.review || {}),
      ...summaryNotes.review,
    },
    blocked: {
      ...(cloned.summary?.blocked || {}),
      ...summaryNotes.blocked,
    },
  };

  return cloned;
}

function applyOptimisticDecisionRemovalsToData(data = {}) {
  const removals = Array.isArray(aiControlRoomState.optimisticDecisionRemovals)
    ? aiControlRoomState.optimisticDecisionRemovals.filter(Boolean)
    : [];
  if (!removals.length) return applyAIControlRoomDecisionGroupingToData(data);

  const cloned = {
    ...data,
    summary: { ...(data.summary || {}) },
    cards: Array.isArray(data.cards)
      ? data.cards.map((card) => ({
          ...card,
          decisionState: { ...(card.decisionState || {}) },
        }))
      : [],
    focusViews: { ...(data.focusViews || {}) },
  };

  const founderView = data.focusViews?.founder
    ? deepCloneAIControlRoomValue(data.focusViews.founder)
    : null;
  if (!founderView || founderView.surfaceMode !== "decision_hub") {
    return cloned;
  }

  if (
    founderView.autonomyUpgradeSuggestion &&
    removals.some((descriptor) => matchesAIControlRoomUpgradeSuggestion(founderView.autonomyUpgradeSuggestion, descriptor))
  ) {
    founderView.autonomyUpgradeSuggestion = null;
  }

  const remainingDecisionQueue = (Array.isArray(founderView.decisionQueue) ? founderView.decisionQueue : []).filter(
    (item) => !removals.some((descriptor) => matchesAIControlRoomDecisionItem(item, descriptor))
  );

  founderView.decisionQueue = remainingDecisionQueue;
  cloned.focusViews.founder = founderView;
  return applyAIControlRoomDecisionGroupingToData(cloned);
}

function repaintAIControlRoomFromState() {
  if (!document.getElementById("section-ai-control-room")) return;
  const decisionSnapshot =
    captureAIControlRoomDecisionQueueSnapshot(document.getElementById("aiRoomFounderConsoleBody"));
  const data = getMergedAIControlRoomData();
  const focusKey = data.focusViews[activeAIControlRoomKey] && activeAIControlRoomKey !== "founder"
    ? activeAIControlRoomKey
    : getPreferredAIControlRoomFocusKey(data);
  activeAIControlRoomKey = focusKey;
  const refreshBadge = document.getElementById("aiRoomRefreshBadge");
  const timestamp = document.getElementById("aiRoomTimestamp");
  if (refreshBadge && aiControlRoomState.summary) {
    refreshBadge.textContent = aiControlRoomState.summary.liveLabel || "Live data";
  }
  if (timestamp) {
    const stamp = aiControlRoomState.summary?.generatedAt
      ? new Date(aiControlRoomState.summary.generatedAt)
      : new Date();
    timestamp.textContent = `Updated ${stamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  paintAIControlRoom(data, focusKey);
  requestAnimationFrame(() => animateAIControlRoomDecisionQueueTransition(decisionSnapshot, document.getElementById("aiRoomFounderConsoleBody")));
}

function pruneAIControlRoomOptimisticDecisionRemovals(data = {}) {
  const removals = Array.isArray(aiControlRoomState.optimisticDecisionRemovals)
    ? aiControlRoomState.optimisticDecisionRemovals
    : [];
  if (!removals.length) return;
  const liveDecisionQueue = Array.isArray(data?.focusViews?.founder?.decisionQueue) ? data.focusViews.founder.decisionQueue : [];
  aiControlRoomState.optimisticDecisionRemovals = removals.filter((descriptor) =>
    liveDecisionQueue.some((item) => matchesAIControlRoomDecisionItem(item, descriptor))
  );
}

function buildAIControlRoomActionButton(action = null, { className = "btn secondary", label = "" } = {}) {
  const resolvedLabel = label || action?.label || "Open";
  if (!action) {
    return `<button class="${escapeHTML(className)}" type="button" disabled>${escapeHTML(resolvedLabel)}</button>`;
  }

  const disabled = action.disabled === true;
  if (action.kind === "nav") {
    const attrs = disabled
      ? 'disabled aria-disabled="true"'
      : `data-ai-room-nav="${escapeHTML(action.navSection || "")}"`;
    return `<button class="${escapeHTML(className)}" type="button" ${attrs}>${escapeHTML(resolvedLabel)}</button>`;
  }

  const attrs = [
    `data-ai-room-decision-kind="${escapeHTML(action.kind || "")}"`,
    action.groupKey ? `data-ai-room-group-key="${escapeHTML(action.groupKey)}"` : "",
    action.workKey ? `data-ai-room-work-key="${escapeHTML(action.workKey)}"` : "",
    action.decision ? `data-ai-room-decision="${escapeHTML(action.decision)}"` : "",
    action.incidentId ? `data-ai-room-incident-id="${escapeHTML(action.incidentId)}"` : "",
    action.approvalId ? `data-ai-room-approval-id="${escapeHTML(action.approvalId)}"` : "",
    action.userId ? `data-ai-room-user-id="${escapeHTML(action.userId)}"` : "",
    action.agentRole ? `data-ai-room-agent-role="${escapeHTML(action.agentRole)}"` : "",
    action.actionType ? `data-ai-room-action-type="${escapeHTML(action.actionType)}"` : "",
    Array.isArray(action.batchActions) && action.batchActions.length
      ? `data-ai-room-batch-actions="${escapeHTML(encodeURIComponent(JSON.stringify(action.batchActions)))}"`
      : "",
    action.successMessage ? `data-ai-room-success-message="${escapeHTML(action.successMessage)}"` : "",
    disabled ? 'disabled aria-disabled="true"' : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<button class="${escapeHTML(className)}" type="button" ${attrs}>${escapeHTML(resolvedLabel)}</button>`;
}

function getAIControlRoomLaneCardStateClass(card = {}) {
  const state = card.decisionState || {};
  const topDecision = state.topDecision || null;
  const hasUrgentDecision = state.needsDecisionCount > 0 && /urgent/i.test(String(topDecision?.urgencyLabel || ""));

  if (card.key === "founder") return "ai-room-card--founder";
  if (hasUrgentDecision || String(card.tone || "").toLowerCase() === "priority") return "ai-room-card--warning";
  if (state.blockedWaitingCount > 0 && state.needsDecisionCount === 0) return "ai-room-card--blocked-state";
  if (state.needsDecisionCount > 0) return "ai-room-card--review-state";
  if (state.autoHandledCount > 0) return "ai-room-card--healthy-state";
  return "ai-room-card--neutral-state";
}

function buildAIControlRoomCardDecision(card = {}) {
  const state = card.decisionState || {};
  const topDecision = state.topDecision || null;
  const actionButtons = [
    buildAIControlRoomActionButton(topDecision?.actions?.yes, { className: "btn" }),
    buildAIControlRoomActionButton(topDecision?.actions?.no, { className: "btn secondary" }),
  ]
    .filter(Boolean)
    .join("");
  const summaryText = topDecision?.explanation || state.nextAction || state.autoStatus || "Open the lane workspace for more detail.";

  return `
    <section class="ai-room-card-decision${topDecision ? "" : " is-empty"}">
      <span class="ai-room-card-decision-label">Most Important Next Item</span>
      <h4 class="ai-room-card-decision-title">${escapeHTML(topDecision?.title || state.decisionSummary || "No decision needed.")}</h4>
      <p class="ai-room-card-decision-body">${escapeHTML(summaryText)}</p>
      ${actionButtons ? `<div class="ai-room-card-actions-row">${actionButtons}</div>` : ""}
    </section>
  `;
}

function renderAIControlRoomCards(cards = []) {
  const root = document.getElementById("aiRoomCardGrid");
  if (!root) return;

  root.innerHTML = cards
    .map((card) => {
      const queueItems = Array.isArray(card.queues) ? card.queues.slice(0, 2) : [];
      const cardClasses = ["ai-room-card", getAIControlRoomLaneCardStateClass(card), !card.navSection && !card.actionLabel ? "ai-room-card--coming-soon" : ""]
        .filter(Boolean)
        .join(" ");
      const state = card.decisionState || {};
      const footerOpenAction = card.navSection ? { kind: "nav", navSection: card.navSection, label: card.actionLabel || "Open" } : null;
      const subtitle = String(card.department || "").trim() || String(card.description || "").trim();

      return `
        <article class="${cardClasses}" data-ai-room-card-key="${escapeHTML(card.key)}">
          <div class="ai-room-card-top">
            <div class="ai-room-card-role">
              <h3 class="ai-room-card-title">${escapeHTML(card.title)}</h3>
              ${subtitle ? `<p class="ai-room-card-department">${escapeHTML(subtitle)}</p>` : ""}
            </div>
          </div>
          <div class="ai-room-card-metrics">
            ${queueItems
              .map(
                (queue) => `
                  <div class="ai-room-card-metric">
                    <strong class="ai-room-card-metric-value">${escapeHTML(formatAIControlRoomCount(queue.value))}</strong>
                    <span class="ai-room-card-metric-label">${escapeHTML(queue.label || "")}</span>
                  </div>
                `
              )
              .join("")}
          </div>
          <div class="ai-room-card-state-strip">
            <div class="ai-room-card-state-pill">
              <strong>${escapeHTML(formatAIControlRoomCount(state.needsDecisionCount || 0))}</strong>
              <span>decisions</span>
            </div>
            <div class="ai-room-card-state-pill">
              <strong>${escapeHTML(formatAIControlRoomCount(state.autoHandledCount || 0))}</strong>
              <span>auto</span>
            </div>
            <div class="ai-room-card-state-pill">
              <strong>${escapeHTML(formatAIControlRoomCount(state.blockedWaitingCount || 0))}</strong>
              <span>blocked</span>
            </div>
          </div>
          ${buildAIControlRoomCardDecision(card)}
          <div class="ai-room-card-footer">
            ${buildAIControlRoomActionButton(
              footerOpenAction || { kind: "nav", navSection: card.navSection || "", label: card.actionLabel || "Open", disabled: !card.navSection },
              { className: "btn secondary ai-room-card-action", label: card.actionLabel || "Open" }
            )}
          </div>
        </article>
      `;
    })
    .join("");
}

function setAIControlRoomActiveCard(key) {
  document.querySelectorAll("[data-ai-room-card-key]").forEach((card) => {
    card.classList.toggle("is-active", card.getAttribute("data-ai-room-card-key") === key);
  });
}

function buildFocusBlock(block = {}) {
  const title = escapeHTML(block.title || "");
  if (Array.isArray(block.items)) {
    return `
      <section class="ai-room-focus-block">
        <h3>${title}</h3>
        <ul>${block.items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>
      </section>
    `;
  }
  return `
    <section class="ai-room-focus-block">
      <h3>${title}</h3>
      <p>${escapeHTML(block.body || "")}</p>
    </section>
  `;
}

function buildAIControlRoomFounderDecisionCard(item = {}) {
  const metaText = uniqueAIControlRoomTexts([
    item.urgencyLabel || "",
    formatAIControlRoomConfidence(item.confidenceScore),
    item.confidenceReason || "",
  ]).join(" · ");
  const previewLines = uniqueAIControlRoomTexts([item.preview, item.proposedAction]);
  const detailLines = uniqueAIControlRoomTexts([
    ...previewLines,
    metaText,
    item.actionHelperText || "",
  ]);
  const hasDetailContent = detailLines.length > 0 || Boolean(item.actions?.open || item.actions?.edit);

  return `
    <article class="ai-room-founder-decision-card" data-ai-room-decision-id="${escapeHTML(getAIControlRoomDecisionCardId(item))}">
      <div class="ai-room-founder-decision-top">
        <div>
          <p class="ai-room-founder-role">${escapeHTML(item.agentRole || "Lane")}</p>
          <h3>${escapeHTML(item.title || "Pending decision")}</h3>
        </div>
      </div>
      <p class="ai-room-founder-decision-body ai-room-founder-decision-body--compact">${escapeHTML(item.explanation || "")}</p>
      <div class="ai-room-founder-decision-actions">
        ${buildAIControlRoomActionButton(item.actions?.yes, { className: "btn" })}
        ${buildAIControlRoomActionButton(item.actions?.no, { className: "btn secondary" })}
        ${
          hasDetailContent
            ? `
              <details class="ai-room-founder-decision-disclosure">
                <summary class="btn secondary">Open Details</summary>
                <div class="ai-room-founder-decision-details">
                  ${detailLines.map((line) => `<p class="ai-room-founder-decision-meta">${escapeHTML(line)}</p>`).join("")}
                  <div class="ai-room-founder-decision-detail-actions">
                    ${buildAIControlRoomActionButton(item.actions?.open, { className: "btn secondary", label: "Open Workspace" })}
                    ${item.actions?.edit ? buildAIControlRoomActionButton(item.actions.edit, { className: "btn secondary", label: "Edit" }) : ""}
                  </div>
                </div>
              </details>
            `
            : ""
        }
      </div>
    </article>
  `;
}

function buildAIControlRoomFounderUpgradeCard(item = {}) {
  if (!item) return "";
  const previewLines = uniqueAIControlRoomTexts([item.preview, item.proposedAction]);
  return `
    <article class="ai-room-founder-decision-card">
      <div class="ai-room-founder-decision-top">
        <div>
          <p class="ai-room-founder-role">Autonomy Upgrade · ${escapeHTML(item.agentRole || "Lane")}</p>
          <h3>${escapeHTML(item.title || "Enable autonomy")}</h3>
        </div>
        <span class="${getBadgeClass(item.tone || "active")}">${escapeHTML(item.urgencyLabel || "One-time upgrade")}</span>
      </div>
      <p class="ai-room-founder-decision-body">${escapeHTML(item.explanation || "")}</p>
      ${previewLines[0] ? `<p class="ai-room-founder-decision-preview">${escapeHTML(previewLines[0])}</p>` : ""}
      ${previewLines[1] ? `<p class="ai-room-founder-decision-action-preview">${escapeHTML(previewLines[1])}</p>` : ""}
      ${item.actionHelperText ? `<p class="ai-room-founder-decision-meta">${escapeHTML(item.actionHelperText)}</p>` : ""}
      <div class="ai-room-founder-decision-actions">
        ${buildAIControlRoomActionButton(item.actions?.yes, { className: "btn" })}
        ${buildAIControlRoomActionButton(item.actions?.no, { className: "btn secondary" })}
        ${buildAIControlRoomActionButton(item.actions?.open, { className: "btn secondary", label: "Open Details" })}
      </div>
    </article>
  `;
}

function buildAIControlRoomFounderFeedItem(item = {}) {
  const detailLines = uniqueAIControlRoomTexts([
    item.preview || "",
    item.blockedReason ? `Why blocked: ${item.blockedReason}` : "",
    item.unblockAction ? `To unblock: ${item.unblockAction}` : "",
    item.proposedAction || "",
    item.actionHelperText || "",
  ]);
  const metaText = uniqueAIControlRoomTexts([
    item.urgencyLabel || "",
    formatAIControlRoomConfidence(item.confidenceScore),
    item.confidenceReason || "",
  ]).join(" · ");

  return `
    <article class="ai-room-founder-feed-item">
      <div class="ai-room-founder-feed-top">
        <strong>${escapeHTML(item.agentRole || "Lane")}</strong>
        <span class="${getBadgeClass(item.tone || "active")}">${escapeHTML(item.title || "Item")}</span>
      </div>
      <p>${escapeHTML(item.explanation || item.preview || "")}</p>
      ${detailLines.map((line) => `<p class="ai-room-founder-feed-meta">${escapeHTML(line)}</p>`).join("")}
      ${metaText ? `<p class="ai-room-founder-feed-meta">${escapeHTML(metaText)}</p>` : ""}
      <div class="ai-room-founder-feed-actions">
        ${buildAIControlRoomActionButton(item.actions?.open, { className: "btn secondary", label: "Open Details" })}
      </div>
    </article>
  `;
}

function buildAIControlRoomFounderSection({ title = "", items = [], emptyMessage = "" } = {}) {
  return `
    <section class="ai-room-founder-section">
      <div class="ai-room-founder-section-top">
        <h3>${escapeHTML(title)}</h3>
        <span class="pending-count">${items.length} ${items.length === 1 ? "item" : "items"}</span>
      </div>
      ${
        items.length
          ? `<div class="ai-room-founder-feed-list">${items.map((item) => buildAIControlRoomFounderFeedItem(item)).join("")}</div>`
          : `<div class="ai-room-empty">${escapeHTML(emptyMessage)}</div>`
      }
    </section>
  `;
}

function renderAIControlRoomFocus(view) {
  if (!view) return;
  const titleEl = document.getElementById("aiRoomFocusTitle");
  const statusEl = document.getElementById("aiRoomFocusStatus");
  const bodyEl = document.getElementById("aiRoomFocusBody");

  if (titleEl) titleEl.textContent = view.title || "Focused View";
  if (statusEl) {
    statusEl.className = getBadgeClass(view.tone);
    statusEl.textContent = view.status || "Active";
  }
  if (bodyEl) {
    if (view.surfaceMode === "decision_hub") {
      bodyEl.innerHTML = `
        <div class="ai-room-focus-body">
          <div class="ai-room-focus-blocks-left">
            ${buildFocusBlock({
              title: "Lane Details",
              body: "The lane tiles above are the main summary view. Open the matching tab for detailed review and decisions.",
            })}
            ${buildFocusBlock({
              title: "Operating Model",
              body: "Use AI Control Room for summaries and jump-off points, then handle detailed work in the matching tab.",
            })}
          </div>
          <div class="ai-room-focus-grid">
            ${buildFocusBlock(view.tertiary)}
            ${buildFocusBlock(view.quaternary)}
          </div>
        </div>
      `;
      return;
    }

    bodyEl.innerHTML = `
      <div class="ai-room-focus-body">
        <div class="ai-room-focus-blocks-left">
          ${buildFocusBlock(view.primary)}
          ${buildFocusBlock(view.secondary)}
        </div>
        <div class="ai-room-focus-grid">
          ${buildFocusBlock(view.tertiary)}
          ${buildFocusBlock(view.quaternary)}
        </div>
      </div>
    `;
  }
}

function renderAIControlRoomFounderConsole(view) {
  const host = document.getElementById("aiRoomFounderConsole");
  const bodyEl = document.getElementById("aiRoomFounderConsoleBody");
  if (!host || !bodyEl) return;

  if (!view || view.surfaceMode !== "decision_hub") {
    host.hidden = true;
    bodyEl.innerHTML = "";
    return;
  }

  host.hidden = false;
  const decisionQueue = groupAIControlRoomDecisionQueueItems(Array.isArray(view.decisionQueue) ? view.decisionQueue : []);
  const autonomyUpgradeSuggestion = view.autonomyUpgradeSuggestion || null;
  const autoHandledItems = Array.isArray(view.autoHandledItems) ? view.autoHandledItems : [];
  const blockedItems = Array.isArray(view.blockedItems) ? view.blockedItems : [];
  const infoItems = Array.isArray(view.infoItems) ? view.infoItems : [];

  bodyEl.innerHTML = `
    <div class="ai-room-focus-body ai-room-focus-body--decision">
      ${
        autonomyUpgradeSuggestion
          ? `<section class="ai-room-founder-section">
              <div class="ai-room-founder-section-top">
                <div>
                  <p class="ai-room-section-label">Autonomy Upgrade</p>
                  <h3>One Upgrade Opportunity</h3>
                </div>
                <span class="pending-count">1 suggestion</span>
              </div>
              ${buildAIControlRoomFounderUpgradeCard(autonomyUpgradeSuggestion)}
            </section>`
          : ""
      }
      <section class="ai-room-founder-section ai-room-founder-section--priority">
        <div class="ai-room-founder-section-top">
          <div>
            <p class="ai-room-section-label">Decision Queue</p>
            <h3>Decision Queue</h3>
            <p class="ai-room-founder-queue-progress" aria-live="polite">${decisionQueue.length} remaining</p>
          </div>
          <span class="pending-count">${decisionQueue.length} remaining</span>
        </div>
        ${
          decisionQueue.length
            ? `<div class="ai-room-founder-decision-list">${decisionQueue.map((item) => buildAIControlRoomFounderDecisionCard(item)).join("")}</div>`
            : `<div class="ai-room-empty">No decisions are currently waiting.</div>`
        }
      </section>
      <div class="ai-room-founder-columns">
        ${buildAIControlRoomFounderSection({
          title: "Autonomous Actions Already Handled",
          items: autoHandledItems,
          emptyMessage: "No autonomous actions were logged today.",
        })}
        ${buildAIControlRoomFounderSection({
          title: "Blocked Waiting on You",
          items: blockedItems,
          emptyMessage: "No work is blocked on your input right now.",
        })}
        ${buildAIControlRoomFounderSection({
          title: "Informational Only",
          items: infoItems,
          emptyMessage: "No additional watch items are currently visible.",
        })}
      </div>
    </div>
  `;
}

function renderAIControlRoomList(containerId, countId, items = []) {
  const container = document.getElementById(containerId);
  const countEl = document.getElementById(countId);
  if (!container) return;
  if (countEl) countEl.textContent = `${items.length} ${items.length === 1 ? "item" : "items"}`;
  if (!items.length) {
    let emptyMessage = "No live items are currently visible.";
    if (aiControlRoomState.loadStatus === "error") {
      emptyMessage = "Live data is unavailable.";
      if (containerId === "aiRoomOutboundMessages") {
        emptyMessage = "Draft records are unavailable.";
      }
    } else if (!aiControlRoomState.summary) {
      emptyMessage = "Loading live data...";
    } else if (containerId === "aiRoomUrgentQueue") {
      emptyMessage = "No urgent items are currently visible.";
    } else if (containerId === "aiRoomAwaitingReview") {
      emptyMessage = "No items are currently awaiting review.";
    } else if (containerId === "aiRoomRecentEscalations") {
      emptyMessage = "No recent escalations are currently visible.";
    } else if (containerId === "aiRoomOutboundMessages") {
      emptyMessage = "No real draft records are available.";
    }
    container.innerHTML = `<div class="ai-room-empty">${escapeHTML(emptyMessage)}</div>`;
    return;
  }

  container.innerHTML = items
    .map(
      (item) => `
      <article class="ai-room-list-item ${containerId === "aiRoomOutboundMessages" ? "ai-room-message" : ""}">
        <div class="ai-room-list-item-top">
          <strong class="ai-room-list-item-title">${escapeHTML(item.title)}</strong>
          <span class="${getBadgeClass(item.tone)}">${escapeHTML(item.badge)}</span>
        </div>
        <p>${escapeHTML(item.body)}</p>
      </article>
    `
    )
    .join("");
}

function getAIControlRoomEmptyMessage(kind = "") {
  if (aiControlRoomState.loadStatus === "error") {
    return kind === "outbound" ? "Draft records are unavailable." : "Live data is unavailable.";
  }
  if (!aiControlRoomState.summary) {
    return "Loading live data...";
  }
  if (kind === "urgent") return "No urgent items are currently visible.";
  if (kind === "review") return "No items are currently awaiting review.";
  if (kind === "escalations") return "No recent escalations are currently visible.";
  if (kind === "outbound") return "No real draft records are available.";
  return "No live items are currently visible.";
}

function buildAIControlRoomFeedItem(item = {}, options = {}) {
  const isMessage = options.message === true;
  return `
    <article class="ai-room-list-item ${isMessage ? "ai-room-message" : ""}">
      <div class="ai-room-list-item-top">
        <strong class="ai-room-list-item-title">${escapeHTML(item.title)}</strong>
        <span class="${getBadgeClass(item.tone)}">${escapeHTML(item.badge)}</span>
      </div>
      <p>${escapeHTML(item.body)}</p>
    </article>
  `;
}

function renderAIControlRoomCombinedFeed(data = {}) {
  const container = document.getElementById("aiRoomCombinedFeed");
  const metaEl = document.getElementById("aiRoomCombinedFeedMeta");
  if (!container) return;

  const sections = [
    {
      key: "urgent",
      label: "Queue",
      title: "Urgent Queue",
      items: Array.isArray(data.urgentQueue) ? data.urgentQueue : [],
    },
    {
      key: "review",
      label: "Review",
      title: "Awaiting Review",
      items: Array.isArray(data.awaitingReview) ? data.awaitingReview : [],
    },
    {
      key: "escalations",
      label: "Signals",
      title: "Recent Escalations",
      items: Array.isArray(data.recentEscalations) ? data.recentEscalations : [],
    },
    {
      key: "outbound",
      label: "Drafts",
      title: "Outbound Messages",
      items: Array.isArray(data.outboundMessages) ? data.outboundMessages : [],
      message: true,
    },
  ];

  const activeSections = sections.filter((section) => section.items.length);
  const totalItems = sections.reduce((sum, section) => sum + section.items.length, 0);

  if (metaEl) {
    metaEl.textContent = `${totalItems} ${totalItems === 1 ? "item" : "items"}`;
  }

  if (!activeSections.length) {
    container.innerHTML = `<div class="ai-room-empty">${escapeHTML(getAIControlRoomEmptyMessage())}</div>`;
    return;
  }

  container.innerHTML = sections
    .filter((section) => section.items.length)
    .map(
      (section) => `
        <section class="ai-room-feed-section">
          <div class="ai-room-feed-section-top">
            <div>
              <p class="ai-room-section-label">${escapeHTML(section.label)}</p>
              <h3>${escapeHTML(section.title)}</h3>
            </div>
            <span class="pending-count">${section.items.length} ${section.items.length === 1 ? "item" : "items"}</span>
          </div>
          <div class="ai-room-list">
            ${section.items.map((item) => buildAIControlRoomFeedItem(item, { message: section.message === true })).join("")}
          </div>
        </section>
      `
    )
    .join("");
}

function paintAIControlRoom(data, focusKey) {
  renderAIControlRoomSummary(data.summary);
  renderAIControlRoomCards(data.cards);
  renderAIControlRoomFocus(data.focusViews[focusKey]);
  renderAIControlRoomFounderConsole(data.focusViews.founder);
  setAIControlRoomActiveCard(focusKey);
}

function getPreferredAIControlRoomFocusKey(data = {}) {
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const focusViews = data.focusViews || {};

  const decisionCard = cards.find((card) => {
    const key = String(card?.key || "").trim();
    if (!key || key === "founder" || !focusViews[key]) return false;
    return Number(card?.decisionState?.needsDecisionCount || 0) > 0;
  });
  if (decisionCard?.key) return decisionCard.key;

  const visibleCard = cards.find((card) => {
    const key = String(card?.key || "").trim();
    return key && key !== "founder" && !!focusViews[key];
  });
  if (visibleCard?.key) return visibleCard.key;

  return focusViews[AI_CONTROL_ROOM_DEFAULT_ACTIVE_KEY] ? AI_CONTROL_ROOM_DEFAULT_ACTIVE_KEY : Object.keys(focusViews)[0] || AI_CONTROL_ROOM_DEFAULT_ACTIVE_KEY;
}

function renderIncidentWorkspaceStatus(message = "") {
  const status = document.getElementById("incidentWorkspaceStatus");
  if (status) status.textContent = message;
}

function renderIncidentWorkspaceEmpty(message = "No incidents are visible yet.") {
  renderIncidentList("incidentAdminList", "incidentAdminListMeta", [], "");
  renderIncidentDetail("incidentAdminDetail", null);
  renderIncidentTimeline("incidentAdminTimeline", "incidentAdminTimelineMeta", []);
  renderIncidentClusters("incidentAdminClusters", "incidentAdminClustersMeta", []);
  const summary = document.getElementById("incidentWorkspaceSummary");
  if (summary) summary.textContent = message;
}

async function loadIncidentWorkspace(force = false) {
  if (!force && incidentRoomState.list.length) {
    return {
      listPayload: { items: incidentRoomState.list },
      clustersPayload: { clusters: incidentRoomState.clusters },
    };
  }

  const [listPayload, clustersPayload] = await Promise.all([
    fetchIncidentList({ limit: 8 }),
    fetchIncidentClusters({ limit: 6, windowHours: 168 }),
  ]);

  incidentRoomState.list = Array.isArray(listPayload?.items) ? listPayload.items : [];
  incidentRoomState.clusters = Array.isArray(clustersPayload?.clusters) ? clustersPayload.clusters : [];

  return { listPayload, clustersPayload };
}

async function selectIncidentForWorkspace(incidentId, force = false) {
  const selectedId = String(incidentId || "").trim();
  if (!selectedId) {
    incidentRoomState.activeIncidentId = "";
    incidentRoomState.detail = null;
    incidentRoomState.timeline = [];
    renderIncidentDetail("incidentAdminDetail", null);
    renderIncidentTimeline("incidentAdminTimeline", "incidentAdminTimelineMeta", []);
    return;
  }

  if (!force && incidentRoomState.activeIncidentId === selectedId && incidentRoomState.detail) {
    renderIncidentDetail("incidentAdminDetail", incidentRoomState.detail);
    renderIncidentTimeline("incidentAdminTimeline", "incidentAdminTimelineMeta", incidentRoomState.timeline);
    return;
  }

  const [detailPayload, timelinePayload] = await Promise.all([
    fetchIncidentDetail(selectedId),
    fetchIncidentTimeline(selectedId, { limit: 25 }),
  ]);

  incidentRoomState.activeIncidentId = selectedId;
  incidentRoomState.detail = detailPayload;
  incidentRoomState.timeline = Array.isArray(timelinePayload?.events) ? timelinePayload.events : [];

  renderIncidentDetail("incidentAdminDetail", detailPayload);
  renderIncidentTimeline("incidentAdminTimeline", "incidentAdminTimelineMeta", incidentRoomState.timeline);
}

async function renderIncidentWorkspace(force = false) {
  const root = document.getElementById("incidentWorkspace");
  if (!root) return;

  renderIncidentWorkspaceStatus("Loading incidents");

  try {
    const { listPayload, clustersPayload } = await loadIncidentWorkspace(force);
    const incidents = Array.isArray(listPayload?.items) ? listPayload.items : [];
    const clusters = Array.isArray(clustersPayload?.clusters) ? clustersPayload.clusters : [];

    renderIncidentList(
      "incidentAdminList",
      "incidentAdminListMeta",
      incidents,
      incidentRoomState.activeIncidentId
    );
    renderIncidentClusters("incidentAdminClusters", "incidentAdminClustersMeta", clusters);

    const summary = document.getElementById("incidentWorkspaceSummary");
    if (summary) {
      summary.textContent = incidents.length
        ? `${incidents.length} incident${incidents.length === 1 ? "" : "s"} loaded from the Incident collections.`
        : "No incidents are visible yet.";
    }

    if (!incidents.length) {
      renderIncidentWorkspaceStatus("Read only");
      renderIncidentDetail("incidentAdminDetail", null);
      renderIncidentTimeline("incidentAdminTimeline", "incidentAdminTimelineMeta", []);
      return;
    }

    const selectedId = incidentRoomState.activeIncidentId || incidents[0]?.id || incidents[0]?.publicId;
    await selectIncidentForWorkspace(selectedId, force);
    renderIncidentList(
      "incidentAdminList",
      "incidentAdminListMeta",
      incidents,
      incidentRoomState.activeIncidentId
    );
    renderIncidentWorkspaceStatus("Read only");
  } catch (err) {
    renderIncidentWorkspaceStatus("Unavailable");
    renderIncidentWorkspaceEmpty(err?.message || "Unable to load incident workspace.");
  }
}

async function openIncidentInAdminRoom(incidentId) {
  const selectedId = String(incidentId || "").trim();
  if (!selectedId) return;
  window.activateAdminSection?.("ai-control-room");
  await renderAIControlRoom(true);
  await selectIncidentForWorkspace(selectedId, true);
  renderIncidentList(
    "incidentAdminList",
    "incidentAdminListMeta",
    incidentRoomState.list,
    incidentRoomState.activeIncidentId
  );
  document.getElementById("incidentWorkspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

window.loadIncidentWorkspace = renderIncidentWorkspace;
window.openIncidentInAdminRoom = openIncidentInAdminRoom;

async function renderAIControlRoom(force = false) {
  if (!document.getElementById("section-ai-control-room")) return;

  const refreshBadge = document.getElementById("aiRoomRefreshBadge");
  const timestamp = document.getElementById("aiRoomTimestamp");
  let hasLoadError = false;
  if (refreshBadge) refreshBadge.textContent = "Loading live data";
  if (timestamp && !aiControlRoomState.lastLoadedAt) {
    timestamp.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  const hadLiveSummary = !!aiControlRoomState.summary;
  if (!hadLiveSummary) {
    const initialData = getMergedAIControlRoomData();
    const optimisticKey =
      initialData.focusViews[activeAIControlRoomKey] && activeAIControlRoomKey !== "founder"
        ? activeAIControlRoomKey
        : getPreferredAIControlRoomFocusKey(initialData);
    activeAIControlRoomKey = optimisticKey;
    paintAIControlRoom(initialData, optimisticKey);
  } else {
    setAIControlRoomActiveCard(activeAIControlRoomKey);
  }

  try {
    await Promise.all([
      loadAIControlRoomSummary(force),
      loadAIControlRoomFocus(activeAIControlRoomKey, force),
      loadAIControlRoomFocus("founder", force),
    ]);
  } catch (err) {
    hasLoadError = true;
    if (refreshBadge) refreshBadge.textContent = "Partial live data";
    if (timestamp) {
      timestamp.textContent = err?.message || "Some control room data is unavailable.";
    }
  }

  const data = getMergedAIControlRoomData();
  if (refreshBadge) {
    refreshBadge.textContent =
      aiControlRoomState.summary && !hasLoadError
        ? aiControlRoomState.summary.liveLabel || "Live data"
        : "Partial live data";
  }
  if (timestamp) {
    const stamp = aiControlRoomState.summary?.generatedAt
      ? new Date(aiControlRoomState.summary.generatedAt)
      : new Date();
    timestamp.textContent = `Updated ${stamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }

  const fallbackKey =
    data.focusViews[activeAIControlRoomKey] && activeAIControlRoomKey !== "founder"
      ? activeAIControlRoomKey
      : getPreferredAIControlRoomFocusKey(data);
  activeAIControlRoomKey = fallbackKey;
  paintAIControlRoom(data, fallbackKey);
  await renderIncidentWorkspace(force);
}

async function openAIControlRoomCard(key, shouldScroll = true) {
  const data = getMergedAIControlRoomData();
  const view = data.focusViews[key];
  if (!view) return;
  activeAIControlRoomKey = key;
  setAIControlRoomActiveCard(key);
  renderAIControlRoomFocus(view);
  try {
    const liveView = await loadAIControlRoomFocus(key);
    if (liveView) {
      renderAIControlRoomFocus(liveView);
    }
  } catch (_err) {
    // Keep the current focus panel state instead of repainting the whole control room.
  }
  if (shouldScroll) {
    document.querySelector(".ai-room-focus-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function applyOptimisticAIControlRoomDecision(button) {
  return applyOptimisticAIControlRoomDecisionDescriptor(buildAIControlRoomDecisionDescriptorFromButton(button));
}

function applyOptimisticAIControlRoomDecisionDescriptor(input = {}) {
  const descriptor = buildAIControlRoomDecisionDescriptor(input);
  const key = aiControlRoomDecisionDescriptorKey(descriptor);
  if (!descriptor.kind || !key) {
    return {
      rollback() {},
      commit() {},
      descriptor,
    };
  }

  const existing = Array.isArray(aiControlRoomState.optimisticDecisionRemovals)
    ? aiControlRoomState.optimisticDecisionRemovals
    : [];
  if (!existing.some((entry) => aiControlRoomDecisionDescriptorKey(entry) === key)) {
    aiControlRoomState.optimisticDecisionRemovals = [...existing, descriptor];
  }
  repaintAIControlRoomFromState();

  return {
    descriptor,
    rollback() {
      aiControlRoomState.optimisticDecisionRemovals = (aiControlRoomState.optimisticDecisionRemovals || []).filter(
        (entry) => aiControlRoomDecisionDescriptorKey(entry) !== key
      );
      repaintAIControlRoomFromState();
    },
    commit() {
      void syncAIControlRoomInBackground({
        refreshIncidentWorkspace:
          descriptor.kind === "incident_approval" ||
          activeAIControlRoomKey === "engineering" ||
          activeAIControlRoomKey === "incidents",
      }).catch(() => {});
    },
  };
}

async function runAIControlRoomDecisionAction(button) {
  const action = buildAIControlRoomDecisionDescriptorFromButton(button);
  const batchActionsRaw = button?.getAttribute("data-ai-room-batch-actions") || "";
  const kind = action.kind || "";
  const decision = action.decision || "";
  if (!kind || !decision) return;

  async function executeAIControlRoomAction(input = {}) {
    const normalized = buildAIControlRoomDecisionDescriptor(input);
    if (normalized.kind === "approval_item") {
      if (!normalized.workKey) return;
      const endpoint = normalized.decision === "approve" ? "approve" : "reject";
      const res = await secureFetch(`/api/admin/approvals/items/${encodeURIComponent(normalized.workKey)}/${endpoint}`, {
        method: "POST",
        body: {},
        headers: { Accept: "application/json" },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Unable to ${normalized.decision} item.`);
      return;
    }

    if (normalized.kind === "incident_approval") {
      if (!normalized.incidentId || !normalized.approvalId) return;
      await decideIncidentApproval(normalized.incidentId, normalized.approvalId, { decision: normalized.decision, note: "" });
      return;
    }

    if (normalized.kind === "user_review") {
      if (!normalized.userId) return;
      const endpoint = normalized.decision === "approve" ? "approve" : "deny";
      const res = await secureFetch(`/api/admin/users/${encodeURIComponent(normalized.userId)}/${endpoint}`, {
        method: "POST",
        body: {},
        headers: { Accept: "application/json" },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Unable to ${normalized.decision} user.`);
      return;
    }

    if (normalized.kind === "autonomy_preference") {
      if (!normalized.agentRole || !normalized.actionType) return;
      const endpoint = normalized.decision === "enable" ? "enable" : "manual";
      const res = await secureFetch(
        `/api/admin/ai/control-room/autonomy-preferences/${encodeURIComponent(normalized.agentRole)}/${encodeURIComponent(normalized.actionType)}/${endpoint}`,
        {
          method: "POST",
          body: {},
          headers: { Accept: "application/json" },
        }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Unable to update ${normalized.agentRole} autonomy preference.`);
    }
  }

  if (kind === "decision_group") {
    if (!batchActionsRaw) return;
    const batchActions = JSON.parse(decodeURIComponent(batchActionsRaw));
    const shouldRefreshIncidentWorkspace =
      batchActions.some((entry) => String(entry?.kind || "") === "incident_approval") ||
      activeAIControlRoomKey === "engineering" ||
      activeAIControlRoomKey === "incidents";
    let completedCount = 0;
    try {
      for (const entry of batchActions) {
        await executeAIControlRoomAction(entry);
        completedCount += 1;
      }
      return;
    } catch (error) {
      if (completedCount > 0) {
        await syncAIControlRoomInBackground({
          refreshIncidentWorkspace: shouldRefreshIncidentWorkspace,
        }).catch(() => {});
      }
      throw error;
    }
  }

  await executeAIControlRoomAction(action);
}

function showToast(message, type = "info") {
  const toast = window.toastUtils;
  if (toast?.show) {
    toast.show(message, { targetId: "toastBanner", type });
  } else if (message) {
    alert(message);
  }
}

function formatDate(value) {
if (!value) return "";
const date = new Date(value);
if (Number.isNaN(date.getTime())) return value;
return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatCurrencyValue(value) {
  const cents = Number(value);
  if (!Number.isFinite(cents)) return "—";
  return CURRENCY.format(cents / 100);
}

function buildPersonLabel(person = {}) {
  if (!person) return "—";
  const name = `${person.firstName || ""} ${person.lastName || ""}`.trim();
  return name || person.email || "—";
}

function isWithdrawalDispute(item = {}) {
  const status = String(item?.caseStatus || "").toLowerCase();
  const pausedReason = String(item?.pausedReason || "").toLowerCase();
  const hasActiveParalegal = !!item?.activeParalegalId;
  if (!item?.withdrawnParalegalId || hasActiveParalegal) return false;
  return pausedReason === "dispute" || pausedReason === "paralegal_withdrew" || status === "disputed";
}

function resolveDisputeAmounts(item = {}) {
  const withdrawal = isWithdrawalDispute(item);
  const settlement = item.disputeSettlement || null;
  const settlementAction = String(settlement?.action || "");
  const hasSettlement = settlementAction === "release_full" || settlementAction === "release_partial";
  const baseAmount = hasSettlement
    ? Number(settlement?.grossAmount)
    : Number(
        withdrawal
          ? item.remainingAmount ?? item.lockedTotalAmount ?? item.totalAmount ?? 0
          : item.lockedTotalAmount ?? item.totalAmount ?? 0
      );
  const feePct = Number(
    hasSettlement ? settlement?.feeParalegalPct : item.feeParalegalPct
  );
  const safeFeePct = Number.isFinite(feePct) ? feePct : 18;
  const rawFeeAmount = hasSettlement ? settlement?.feeParalegalAmount : item.feeParalegalAmount;
  const feeAmount = Number.isFinite(Number(rawFeeAmount))
    ? Number(rawFeeAmount)
    : Math.round(baseAmount * (safeFeePct / 100));
  const payoutAmount = hasSettlement
    ? Number.isFinite(Number(settlement?.payoutAmount))
      ? Number(settlement.payoutAmount)
      : Math.max(0, baseAmount - feeAmount)
    : Math.max(0, baseAmount - feeAmount);
  return {
    baseAmount,
    feePct: safeFeePct,
    feeAmount,
    payoutAmount,
  };
}

function resolveDisputeResolution(item = {}) {
  const withdrawal = isWithdrawalDispute(item);
  const settlement = item.disputeSettlement || {};
  const action = String(settlement.action || "");
  const disputeId = String(item.dispute?.disputeId || item.dispute?._id || "");
  if (!action && withdrawal) {
    const payoutType = String(item.payoutFinalizedType || "");
    if (!payoutType) return null;
    const payoutAmount = Number(item.partialPayoutAmount ?? 0);
    return {
      action: payoutType,
      label:
        payoutType === "expired_zero" || payoutType === "zero_auto" || payoutAmount <= 0
          ? "Zero"
          : "Payout",
      resolvedAt: item.payoutFinalizedAt || null,
    };
  }
  if (!action) return null;
  if (settlement.disputeId && disputeId && String(settlement.disputeId) !== disputeId) return null;
  const label =
    action === "refund"
      ? "Refund"
      : action === "release_partial"
      ? "Partial"
      : action === "release_full"
      ? "Full"
      : action;
  return { action, label, resolvedAt: settlement.resolvedAt || null };
}

function getDisputeColspan(status) {
  return status === "resolved" || status === "rejected" ? 5 : 6;
}

function renderDisputeHeader(status) {
  if (!disputesHeaderRow) return;
  if (status === "resolved") {
    disputesHeaderRow.innerHTML = `
      <th>Case</th>
      <th>Parties</th>
      <th>Resolution</th>
      <th>Resolved</th>
      <th>Notes</th>
    `;
    return;
  }
  if (status === "rejected") {
    disputesHeaderRow.innerHTML = `
      <th>Case</th>
      <th>Parties</th>
      <th>Dispute</th>
      <th>Status</th>
      <th>Updated</th>
    `;
    return;
  }
  disputesHeaderRow.innerHTML = `
    <th>Case</th>
    <th>Parties</th>
    <th>Dispute</th>
    <th>Status</th>
    <th>Payment</th>
    <th>Actions</th>
  `;
}

function getNewUsersTotalPages(total) {
return Math.max(1, Math.ceil(total / NEW_USERS_PAGE_SIZE));
}

function clampNewUsersPage(page, total) {
const safePage = Number(page) || 1;
const totalPages = getNewUsersTotalPages(total);
return Math.min(totalPages, Math.max(1, safePage));
}

function updateNewUsersPageSelect(total, page) {
if (!newUsersPageSelect) return;
const totalPages = getNewUsersTotalPages(total);
newUsersPageSelect.innerHTML = "";
for (let i = 1; i <= totalPages; i += 1) {
const option = document.createElement("option");
option.value = String(i);
option.textContent = `Page ${i} of ${totalPages}`;
newUsersPageSelect.appendChild(option);
}
newUsersPageSelect.value = String(page);
newUsersPageSelect.disabled = totalPages <= 1;
}

function renderNewUsersPage() {
const list = document.getElementById("newUsersList");
if (!list) return;
const users = filterActiveUsers(recentUsersCache || []);
const total = users.length;
newUsersPage = clampNewUsersPage(newUsersPage, total);
updateNewUsersPageSelect(total, newUsersPage);
const start = (newUsersPage - 1) * NEW_USERS_PAGE_SIZE;
const pageItems = users.slice(start, start + NEW_USERS_PAGE_SIZE);
if (!total) {
list.innerHTML = '<li style="color:var(--muted)">No recent users found.</li>';
return;
}
list.innerHTML = "";
pageItems.forEach((user) => {
  const li = document.createElement("li");
  const created = user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "";
  const name = user.name || user.email || "User";
  const role = (user.role || "user").toLowerCase();
  const profilePath = role === "paralegal" ? "profile-paralegal" : "profile-attorney";
  const link = document.createElement("a");
  link.href = `${profilePath}.html?id=${encodeURIComponent(user.id || user._id || "")}`;
  link.textContent = name;
  link.className = "user-link";
  const roleSpan = document.createElement("span");
  roleSpan.textContent = user.role || "—";
  const time = document.createElement("small");
  time.style.display = "block";
  time.style.color = "var(--muted)";
  time.textContent = created;
  const actions = document.createElement("div");
  actions.className = "user-actions";
  const deactivateBtn = document.createElement("button");
  deactivateBtn.type = "button";
  deactivateBtn.textContent = "Remove";
  deactivateBtn.className = "btn danger";
  deactivateBtn.dataset.userId = user.id || user._id || "";
  deactivateBtn.addEventListener("click", () => {
    const userId = deactivateBtn.dataset.userId;
    if (!userId) return;
    deactivateUser(userId, { source: "recent" });
  });
  actions.appendChild(deactivateBtn);
  li.appendChild(link);
  li.appendChild(roleSpan);
  li.appendChild(time);
  li.appendChild(actions);
  list.appendChild(li);
});
}

function clampNumber(value, min, max) {
const num = Number(value);
if (!Number.isFinite(num)) return null;
return Math.min(max, Math.max(min, num));
}

function formatTaxRatePercent(rate) {
if (!Number.isFinite(Number(rate))) return "";
const percent = Number(rate) * 100;
return percent % 1 === 0 ? String(percent) : percent.toFixed(1);
}

function setSettingsStatus(message = "") {
const status = document.getElementById("settingsStatus");
if (status) status.textContent = message;
}

let adminThemeManuallyChanged = false;

function normalizeAdminTheme(value) {
const candidate = String(value || "").toLowerCase();
return candidate === "light" || candidate === "mountain" ? candidate : "mountain";
}

function applySettingsToForm(settings = {}) {
const allowInput = document.getElementById("settingAllowSignups");
if (allowInput) allowInput.checked = settings.allowSignups !== false;
const maintenanceInput = document.getElementById("settingMaintenanceMode");
if (maintenanceInput) maintenanceInput.checked = !!settings.maintenanceMode;
const emailInput = document.getElementById("settingSupportEmail");
if (emailInput) emailInput.value = settings.supportEmail || "";
const taxInput = document.getElementById("settingTaxRate");
if (taxInput) taxInput.value = formatTaxRatePercent(settings.taxRate);
const updatedLabel = document.getElementById("settingsUpdatedAt");
if (updatedLabel) {
const updated = settings.updatedAt ? formatDate(settings.updatedAt) : "";
updatedLabel.textContent = updated ? `Last updated ${updated}` : "";
}
}

function applyAdminThemeToForm(theme) {
const themeInput = document.getElementById("settingAdminTheme");
if (themeInput) themeInput.value = normalizeAdminTheme(theme);
}

function previewAdminTheme(theme) {
const normalizedTheme = normalizeAdminTheme(theme);
applyAdminThemeToForm(normalizedTheme);
if (typeof window.applyThemePreference === "function") {
window.applyThemePreference(normalizedTheme);
}
return normalizedTheme;
}

async function loadAdminThemePreference() {
const fallbackTheme =
  typeof window.getThemePreference === "function" ? window.getThemePreference() : "mountain";
try {
  const res = await secureFetch("/api/account/preferences", {
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || data?.msg || "Unable to load theme preference.");
  }
  const resolvedTheme = normalizeAdminTheme(data?.theme || fallbackTheme);
  if (!adminThemeManuallyChanged) {
    previewAdminTheme(resolvedTheme);
  }
  return resolvedTheme;
} catch (err) {
  console.error("Failed to load admin theme preference", err);
  if (!adminThemeManuallyChanged) {
    previewAdminTheme(fallbackTheme);
  }
  return normalizeAdminTheme(fallbackTheme);
}
}

async function loadAdminSettings() {
try {
const res = await secureFetch("/api/admin/settings", {
headers: { Accept: "application/json" },
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
throw new Error(data?.error || data?.msg || "Unable to load settings.");
}
const settings = data.settings || data;
adminSettingsCache = settings;
applySettingsToForm(settings);
setSettingsStatus("");
return settings;
} catch (err) {
console.error("Failed to load admin settings", err);
showToast(err?.message || "Unable to load settings.", "err");
setSettingsStatus("Unable to load settings.");
return null;
}
}

function readSettingsFromForm() {
const allowInput = document.getElementById("settingAllowSignups");
const maintenanceInput = document.getElementById("settingMaintenanceMode");
const emailInput = document.getElementById("settingSupportEmail");
const taxInput = document.getElementById("settingTaxRate");

const payload = {
allowSignups: !!allowInput?.checked,
maintenanceMode: !!maintenanceInput?.checked,
supportEmail: emailInput ? emailInput.value.trim() : "",
};
if (taxInput) {
const normalized = clampNumber(taxInput.value, 0, 50);
if (normalized !== null) {
payload.taxRate = normalized / 100;
}
}
return payload;
}

async function saveAdminThemePreference() {
const themeInput = document.getElementById("settingAdminTheme");
const normalizedTheme = normalizeAdminTheme(themeInput?.value);
const res = await secureFetch("/api/account/preferences", {
method: "POST",
body: { theme: normalizedTheme },
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
throw new Error(data?.error || data?.msg || "Unable to save theme preference.");
}
const savedTheme = normalizeAdminTheme(data?.preferences?.theme || data?.theme || normalizedTheme);
adminThemeManuallyChanged = false;
previewAdminTheme(savedTheme);
return savedTheme;
}

async function saveAdminSettings() {
const saveBtn = document.getElementById("saveAdminSettings");
const original = saveBtn?.textContent || "Save Settings";
if (saveBtn) {
saveBtn.disabled = true;
saveBtn.textContent = "Saving...";
}
setSettingsStatus("");
try {
const payload = readSettingsFromForm();
const res = await secureFetch("/api/admin/settings", {
method: "PUT",
body: payload,
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
throw new Error(data?.error || data?.msg || "Unable to save settings.");
}
await saveAdminThemePreference();
const settings = data.settings || data;
adminSettingsCache = settings;
applySettingsToForm(settings);
showToast("Settings saved.", "ok");
setSettingsStatus("Saved.");
await hydrateAnalytics();
return settings;
} catch (err) {
console.error("Failed to save settings", err);
showToast(err?.message || "Unable to save settings.", "err");
setSettingsStatus("Save failed.");
return null;
} finally {
if (saveBtn) {
saveBtn.disabled = false;
saveBtn.textContent = original;
}
}
}

function bindSettingsActions() {
if (settingsBound) return;
const saveBtn = document.getElementById("saveAdminSettings");
const themeInput = document.getElementById("settingAdminTheme");
if (saveBtn) {
saveBtn.addEventListener("click", () => {
saveAdminSettings();
});
}
if (themeInput) {
themeInput.addEventListener("change", () => {
adminThemeManuallyChanged = true;
previewAdminTheme(themeInput.value);
setSettingsStatus("Theme preview updated. Save settings to keep it.");
});
}
settingsBound = true;
}

function formatReportDate(value = new Date()) {
const date = value instanceof Date ? value : new Date(value);
if (Number.isNaN(date.getTime())) return "";
return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function csvEscape(value) {
const normalized = String(value ?? "").replace(/\r?\n/g, " ").trim();
return `"${normalized.replace(/"/g, "\"\"")}"`;
}

function buildTaxReportRows(data) {
const { taxSummary = {}, ledger = [] } = data || {};
const reportDate = formatReportDate(new Date());
const rows = [
["Lets-ParaConnect Tax Report"],
["Generated", reportDate || formatDate(new Date())],
[],
["Tax Summary"],
["Gross Earnings", formatCurrency(taxSummary.grossEarnings)],
["Deductible Expenses", formatCurrency(taxSummary.deductibleExpenses)],
["Estimated Tax Owed (22%)", formatCurrency(taxSummary.estimatedTax)],
["Next Filing Deadline", taxSummary.nextFilingDeadline || "—"],
];

if (Array.isArray(ledger) && ledger.length) {
rows.push([]);
rows.push(["Ledger Entries"]);
rows.push(["Date", "Category", "Description", "Amount", "Type", "Status"]);
ledger.forEach((entry) => {
rows.push([
formatDate(entry.date),
entry.category || "—",
entry.description || "—",
formatCurrency(entry.amount),
toTitle(entry.type || "income"),
toTitle(entry.status || "pending"),
]);
});
}

return rows;
}

function downloadTaxReport(data) {
const rows = buildTaxReportRows(data);
const csv = rows
.map((row) => (row.length ? row.map(csvEscape).join(",") : ""))
.join("\n");
const blob = new Blob([csv], { type: "text/csv" });
const url = URL.createObjectURL(blob);
const a = document.createElement("a");
const stamp = new Date().toISOString().split("T")[0];
a.href = url;
a.download = `LetsParaConnect_TaxReport_${stamp}.csv`;
a.click();
URL.revokeObjectURL(url);
}

function formatMonthLabel(value) {
if (!value) return "";
const [year, month] = value.split("-");
if (!year || !month) return value;
const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function toTitle(value) {
if (!value) return "";
return String(value)
.toLowerCase()
.replace(/\b\w/g, (match) => match.toUpperCase());
}

function populateMetrics(data) {
const { userMetrics = {}, escrowMetrics = {}, revenueMetrics = {}, caseMetrics = {}, expenses = {} } = data || {};

updateText("#totalUsers", formatNumber(userMetrics.totalUsers));
updateText("#activeCases", formatNumber(caseMetrics.activeCases));
updateText("#pendingUsers", formatNumber(userMetrics.pendingApprovals));
updateText("#escrowTotal", formatCurrency(escrowMetrics.totalEscrowHeld));

updateText("#metricAttorneys", formatNumber(userMetrics.totalAttorneys));
updateText("#metricParalegals", formatNumber(userMetrics.totalParalegals));
updateText("#metricPending", formatNumber(userMetrics.pendingApprovals));

populateQuickStats(userMetrics, caseMetrics, escrowMetrics);
updateText("#revenueTotalValue", formatCurrency(revenueMetrics.totalRevenue));
updateText("#fundsReleasedValue", formatCurrency(escrowMetrics.totalEscrowReleased));
updateText("#pendingPayoutsValue", formatCurrency(escrowMetrics.pendingPayouts));
updateText("#platformFeesCollectedValue", formatCurrency(revenueMetrics.platformFeesCollected));

updateText("#payoutTotal", formatCurrency(expenses.payoutTotal));
const payoutCountEl = document.getElementById("payoutCount");
if (payoutCountEl) {
const payoutCount = Number(expenses.payoutCount) || 0;
payoutCountEl.textContent = `${payoutCount.toLocaleString()} payout${payoutCount === 1 ? "" : "s"} recorded`;
}

updateText("#incomeTotal", formatCurrency(revenueMetrics.platformFeesCollected));
const incomeCountEl = document.getElementById("incomeCount");
if (incomeCountEl) {
const incomeCount = Number(revenueMetrics.platformFeeCount) || 0;
incomeCountEl.textContent = `${incomeCount.toLocaleString()} income record${incomeCount === 1 ? "" : "s"}`;
}
}

function populateQuickStats(userMetrics = {}, caseMetrics = {}, escrowMetrics = {}) {
const nodes = document.querySelectorAll(".quick-stats div");
const configs = [
{ label: "Total Users", value: formatNumber(userMetrics.totalUsers) },
{ label: "Pending Approvals", value: formatNumber(userMetrics.pendingApprovals) },
{ label: "Active Cases", value: formatNumber(caseMetrics.activeCases) },
{ label: "Completed Cases", value: formatNumber(caseMetrics.completedCases) },
  { label: "Case funding in progress", value: formatCurrency(escrowMetrics.totalEscrowHeld) },
  { label: "Funds released", value: formatCurrency(escrowMetrics.totalEscrowReleased) },
];
nodes.forEach((node, index) => {
const strong = node.querySelector("strong") || node.appendChild(document.createElement("strong"));
const span = node.querySelector("span") || node.appendChild(document.createElement("span"));
const config = configs[index];
if (config) {
strong.textContent = config.value;
span.textContent = config.label;
} else {
strong.textContent = "—";
span.textContent = "";
}
});
}

function populateCharts(data) {
cacheCharts();
const { revenueMetrics = {} } = data || {};
const chart = chartCache.revenue;
if (!chart) return;
const entries = revenueMetrics.monthlyRevenue || [];
const labels = entries.map((entry) => formatMonthLabel(entry.month));
const revenueData = entries.map((entry) => Math.round((Number(entry.revenue) || 0) / 100));
const marginData = entries.map((entry) => Number(entry.margin) || 0);

chart.data.labels = labels;
if (chart.data.datasets[0]) chart.data.datasets[0].data = revenueData;
if (chart.data.datasets[1]) chart.data.datasets[1].data = marginData;
chart.update("none");
}

function populateExpenseChart(data) {
cacheCharts();
const { revenueMetrics = {}, taxSummary = {}, expenses = {} } = data || {};
const chart = chartCache.expense;
if (!chart) return;
const values = [
Math.round((Number(revenueMetrics.platformFeesCollected) || 0) / 100),
Math.round((Number(taxSummary.taxOwed ?? taxSummary.estimatedTax) || 0) / 100),
Math.round((Number(expenses.operationalCosts) || 0) / 100),
Math.round((Number(expenses.payoutTotal) || 0) / 100),
];
if (chart.data.datasets[0]) {
chart.data.datasets[0].data = values;
chart.update("none");
}
}

function populateLedger(data) {
const tbody = document.getElementById("ledgerBody");
if (!tbody) return;
const entries = data?.ledger || [];
if (!entries.length) {
tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No ledger entries found.</td></tr>';
return;
}
tbody.innerHTML = "";
entries.forEach((entry) => {
const row = document.createElement("tr");
const statusLabel = toTitle(entry.status || "Pending");
const statusSlug = statusLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
row.innerHTML = `
     <td>${formatDate(entry.date)}</td>
     <td>${entry.category || "—"}</td>
     <td>${entry.description || "—"}</td>
     <td>${formatCurrency(entry.amount)}</td>
     <td>${toTitle(entry.type || "income")}</td>
     <td><span class="status ${statusSlug}">${statusLabel}</span></td>
   `;
tbody.appendChild(row);
});
}

const receiptsBody = document.getElementById("receiptsBody");
const receiptSearchInput = document.getElementById("receiptSearch");
const receiptRefreshBtn = document.getElementById("receiptRefreshBtn");
const RECEIPTS_PAGE_SIZE = 10;
let receiptSearchTimer = null;

function renderReceipts(items = []) {
  if (!receiptsBody) return;
  if (!items.length) {
    receiptsBody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No receipts found.</td></tr>';
    return;
  }
  receiptsBody.innerHTML = items
    .slice(0, RECEIPTS_PAGE_SIZE)
    .map((item) => {
      const issuedAt = item?.issuedAt ? formatDate(item.issuedAt) : "—";
      const receiptId = escapeHTML(item.receiptId || "—");
      const caseTitle = escapeHTML(item.caseTitle || "Case");
      const party = escapeHTML(item.party || "—");
      const type = escapeHTML(item.type || "Receipt");
      const amount = formatCurrencyValue(item.amountCents);
      return `
        <tr>
          <td>${escapeHTML(issuedAt)}</td>
          <td><span class="receipt-id">${receiptId}</span></td>
          <td>${caseTitle}</td>
          <td>${party}</td>
          <td>${type}</td>
          <td>${escapeHTML(amount)}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadReceipts() {
  if (!receiptsBody) return;
  receiptsBody.innerHTML =
    '<tr><td colspan="6" style="text-align:center;color:var(--muted)">Loading receipts…</td></tr>';
  try {
    const q = String(receiptSearchInput?.value || "").trim();
    const params = new URLSearchParams({ limit: String(RECEIPTS_PAGE_SIZE) });
    if (q) params.set("q", q);
    const res = await secureFetch(`/api/payments/receipts?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || "Unable to load receipts.");
    const items = Array.isArray(payload?.items) ? payload.items : [];
    renderReceipts(items);
  } catch (err) {
    receiptsBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--muted)">${escapeHTML(
      err?.message || "Unable to load receipts."
    )}</td></tr>`;
  }
}

function populateTaxSummary(data) {
const list = document.querySelector(".tax-summary");
if (!list) return;
const { taxSummary = {} } = data || {};
const items = list.querySelectorAll("li");
const taxRateLabel = formatTaxRatePercent(taxSummary.taxRate) || "22";
if (items[0]) items[0].innerHTML = `<strong>Gross Earnings:</strong> ${formatCurrency(taxSummary.grossEarnings)}`;
if (items[1]) items[1].innerHTML = `<strong>Deductible Expenses:</strong> ${formatCurrency(taxSummary.deductibleExpenses)}`;
if (items[2]) items[2].innerHTML = `<strong>Estimated Tax Owed (${taxRateLabel}%):</strong> ${formatCurrency(taxSummary.estimatedTax)}`;
if (items[3]) items[3].innerHTML = `<strong>Next Filing Deadline:</strong> ${taxSummary.nextFilingDeadline || "—"}`;
}

function populatePayoutSchedule(data) {
const container = document.querySelector(".payout-schedule");
if (!container) return;
const payouts = data?.upcomingPayouts || [];
container.innerHTML = "";
if (!payouts.length) {
container.innerHTML = "<li>No upcoming payouts scheduled.</li>";
return;
}
payouts.forEach((payout) => {
const item = document.createElement("li");
item.textContent = `${formatDate(payout.date)} – ${formatCurrency(payout.amount)} to ${payout.recipient || "Recipient"}`;
container.appendChild(item);
});
}

function populateRegistrationChart(data) {
cacheCharts();
const entries = data?.userMetrics?.registrationsByMonth || [];
const labels = entries.map((entry) => formatMonthLabel(entry.month));
const counts = entries.map((entry) => entry.count || 0);
const growth = counts.map((count, index) => {
if (index === 0) return 0;
const prev = counts[index - 1] || 1;
return Math.round(((count - prev) / prev) * 100);
});

if (chartCache.combo) {
chartCache.combo.data.labels = labels;
if (chartCache.combo.data.datasets[0]) chartCache.combo.data.datasets[0].data = counts;
if (chartCache.combo.data.datasets[1]) chartCache.combo.data.datasets[1].data = growth;
chartCache.combo.update("none");
}

if (chartCache.userLine) {
chartCache.userLine.data.labels = labels;
if (chartCache.userLine.data.datasets[0]) chartCache.userLine.data.datasets[0].data = counts;
chartCache.userLine.update("none");
}
}

function populateEscrowChart(data) {
cacheCharts();
const chart = chartCache.escrow;
if (!chart) return;
const { escrowMetrics = {} } = data || {};
const held = Math.round((Number(escrowMetrics.totalEscrowHeld) || 0) / 100);
const released = Math.round((Number(escrowMetrics.totalEscrowReleased) || 0) / 100);
const pending = Math.round((Number(escrowMetrics.pendingPayouts) || 0) / 100);
if (chart.data.datasets[0]) {
chart.data.datasets[0].data = [held, released, pending];
chart.update("none");
}
}

function populateEscrowReportChart(data) {
  cacheCharts();
  const chart = chartCache.escrowReport;
  if (!chart) return;
  const trends = data?.escrowTrends || {};
  const months = Array.isArray(trends.months) ? trends.months : [];
  const labels = months.map((m) => formatMonthLabel(m));
  const held = (Array.isArray(trends.held) ? trends.held : []).map((v) =>
    Math.round((Number(v) || 0) / 100)
  );
  const released = (Array.isArray(trends.released) ? trends.released : []).map((v) =>
    Math.round((Number(v) || 0) / 100)
  );

  if (!chart.data.datasets[0]) {
    chart.data.datasets[0] = {
      label: "In Stripe",
      data: [],
      borderColor: "#b6a47a",
      backgroundColor: "rgba(182,164,122,0.15)",
      tension: 0.4,
      fill: true,
    };
  }
  if (!chart.data.datasets[1]) {
    chart.data.datasets[1] = {
      label: "Released",
      data: [],
      borderColor: "#1f78d1",
      backgroundColor: "rgba(31,120,209,0.15)",
      tension: 0.4,
      fill: true,
    };
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = months.map((_, idx) => held[idx] || 0);
  chart.data.datasets[1].data = months.map((_, idx) => released[idx] || 0);
  chart.update("none");
}

function populateNewUsers(data) {
const users = filterActiveUsers(data?.recentUsers || recentUsersCache);
recentUsersCache = users;
newUsersPage = 1;
renderNewUsersPage();
}

if (newUsersPageSelect) {
  newUsersPageSelect.addEventListener("change", () => {
    newUsersPage = Number(newUsersPageSelect.value) || 1;
    renderNewUsersPage();
  });
}

function applyAnalyticsPayload(data) {
latestAnalytics = data;
lastAnalyticsRenderAt = Date.now();
populateMetrics(data);
populateCharts(data);
populateExpenseChart(data);
  populateEscrowReportChart(data);
populateLedger(data);
populateTaxSummary(data);
populatePayoutSchedule(data);
populateRegistrationChart(data);
populateEscrowChart(data);
populateNewUsers(data);
}

async function hydrateAnalytics() {
const now = Date.now();
if (latestAnalytics && now - lastAnalyticsRenderAt < ANALYTICS_COOLDOWN_MS) {
return latestAnalytics;
}
const data = await loadAnalytics();
if (!data) return null;
applyAnalyticsPayload(data);
return data;
}

function destroyCharts() {
cacheCharts();
Object.keys(chartCache).forEach((key) => {
const chart = chartCache[key];
if (chart?.destroy) {
try {
chart.destroy();
} catch (err) {
console.warn("Failed to destroy chart", err);
}
}
chartCache[key] = null;
});
}

window.deactivateUser = deactivateUser;
window.filterActiveUsers = filterActiveUsers;
window.removedUserIds = removedUserIds;
function filterActiveUsers(users = []) {
  return (users || []).filter((user) => {
    const id = String(user.id || user._id || "").trim();
    if (removedUserIds.has(id)) return false;
    const status = String(user.status || "").toLowerCase();
    if (status === "denied") return false;
    return true;
  });
}

async function deactivateUser(userId, { source } = {}) {
  if (!userId) return;
  const confirmed = window.confirm("Remove/deactivate this user?");
  if (!confirmed) return;
  try {
    await fetchCSRF();
  } catch (_) {}
  try {
    const res = await secureFetch(`/api/admin/users/${encodeURIComponent(userId)}/deny`, {
      method: "POST",
      body: {},
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.msg || payload?.error || "Unable to remove user.");
    }
    showToast("User removed/deactivated.", "info");
    removedUserIds.add(String(userId));
    recentUsersCache = recentUsersCache.filter((u) => String(u.id || u._id) !== String(userId));
    if (source === "recent") {
      populateNewUsers({ recentUsers: recentUsersCache });
    }
    if (Array.isArray(window.pendingUsers)) {
      window.pendingUsers = window.pendingUsers.filter((u) => String(u.id || u._id) !== String(userId));
      window.renderPendingUsers?.();
      window.updatePendingCount?.(window.pendingUsers.length);
    }
    await hydrateAnalytics();
  } catch (err) {
    showToast(err?.message || "Unable to remove user.", "err");
  }
}

async function loadPendingParalegals() {
try {
const res = await secureFetch("/api/admin/pending-paralegals", {
headers: { Accept: "application/json" },
noRedirect: true,
});
const payload = await res.json().catch(() => ({}));
renderVerificationList(Array.isArray(payload?.items) ? payload.items : []);
} catch (err) {
console.warn("Unable to load pending paralegals", err);
renderVerificationList([]);
}
}

function escapeAttribute(value = "") {
return String(value || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function buildFileHref(value) {
const raw = String(value || "").trim();
if (!raw) return "";
if (/^https?:\/\//i.test(raw)) return raw;
if (raw.startsWith("/api/uploads/view")) return raw;
return `/api/uploads/view?key=${encodeURIComponent(raw)}`;
}

function renderVerificationList(items) {
const list = document.getElementById("paralegalVerificationList");
if (!list) return;
if (!items.length) {
list.innerHTML = "<p>No paralegals awaiting verification.</p>";
return;
}
const cards = items
.map((p) => {
const id = escapeAttribute(p._id || p.id || "");
const firstName = escapeHTML(p.firstName || "");
const lastName = escapeHTML(p.lastName || "");
const email = escapeHTML(p.email || "");
const years = Number.isFinite(Number(p.yearsExperience)) ? Number(p.yearsExperience) : null;
const yearsLabel = years === null ? "N/A" : `${years} year${years === 1 ? "" : "s"}`;
const linkedIn = p.linkedInURL
? `<p><a href="${escapeAttribute(p.linkedInURL)}" target="_blank" rel="noopener">LinkedIn Profile</a></p>`
: "<p>LinkedIn profile not provided.</p>";
const certificateHref = buildFileHref(p.certificateURL);
const certificate = certificateHref
? `<p><a href="${escapeAttribute(certificateHref)}" target="_blank" rel="noopener">Certificate</a></p>`
: "<p>Certificate not uploaded.</p>";
    return `
       <div class="verify-card" data-id="${id}">
         <strong>${lastName || "N/A"}, ${firstName || "N/A"}</strong>
         <p>Email: ${email || "N/A"}</p>
         <p>Years Experience: ${yearsLabel}</p>
         ${linkedIn}
         ${certificate}
         <button class="approveParalegalBtn" data-id="${id}">Approve</button>
         <button class="rejectParalegalBtn" data-id="${id}">Reject</button>
         <div class="user-card-actions">
           <button class="disableUserBtn" data-id="${id}">Disable</button>
           <button class="enableUserBtn" data-id="${id}">Enable</button>
         </div>
       </div>
     `;
})
.join("");
list.innerHTML = cards;
}

function renderOpenDisputes(items = []) {
  if (!disputesBody) return;
  if (!items.length) {
    disputesBody.innerHTML = '<tr><td colspan="6" class="pending-empty">No disputes found.</td></tr>';
    return;
  }
  disputesBody.innerHTML = items
    .map((item) => {
      const withdrawal = isWithdrawalDispute(item);
      const caseId = String(item.caseId || "");
      const dispute = item.dispute || {};
      const disputeId = String(dispute.disputeId || dispute._id || "");
      const status = String(dispute.status || "open").toLowerCase();
      const isResolved =
        status !== "open" || item.paymentReleased || item.payoutTransferId || item.payoutFinalizedAt;
      const messageRaw = String(dispute.message || dispute.reason || "").trim();
      const reason = messageRaw ? escapeHTML(messageRaw) : "—";
      const requestedCents = Number(dispute.amountRequestedCents);
      const requestedLabel =
        Number.isFinite(requestedCents) && requestedCents > 0 ? formatCurrencyValue(requestedCents) : "";
      const requestedLine = requestedLabel
        ? `<div class="dispute-meta">Requested: ${escapeHTML(requestedLabel)}</div>`
        : "";
      const createdAt = dispute.createdAt ? formatDate(dispute.createdAt) : "—";
      const attorneyLabel = buildPersonLabel(item.attorney);
      const paralegalLabel = buildPersonLabel(item.paralegal);
      const tasksTotal = Number.isFinite(Number(item.tasksTotal)) ? Number(item.tasksTotal) : 0;
      const tasksCompleted = Number.isFinite(Number(item.tasksCompleted))
        ? Number(item.tasksCompleted)
        : 0;
      const tasksLabel = `Tasks: ${tasksCompleted} / ${tasksTotal}`;
      const amounts = resolveDisputeAmounts(item);
      const baseAmount = Number.isFinite(amounts.baseAmount) ? amounts.baseAmount : 0;
      const grossLabel = formatCurrencyValue(baseAmount);
      const recommendedCents = baseAmount > 0 ? Math.round(baseAmount * 0.7) : 0;
      const recommendedLabel = recommendedCents ? formatCurrencyValue(recommendedCents) : "";
      const feeLabel = formatCurrencyValue(amounts.feeAmount);
      const payoutLabel = formatCurrencyValue(amounts.payoutAmount);
      const actionDisabled = isResolved ? ' disabled aria-disabled="true"' : "";
      const actionNote = isResolved ? '<div class="dispute-meta">Resolved</div>' : "";
      const withdrawalActions = `
            <div class="dispute-actions">
              <button class="btn secondary" type="button" data-dispute-action="refund" data-case-id="${escapeAttribute(
                caseId
              )}" data-dispute-id="${escapeAttribute(disputeId)}"${actionDisabled}>Zero payout</button>
              <input type="number" min="0" step="0.01" placeholder="Payout to paralegal $" data-dispute-amount${actionDisabled} />
              <button class="btn primary" type="button" data-dispute-action="release-partial" data-case-id="${escapeAttribute(
                caseId
              )}" data-dispute-id="${escapeAttribute(disputeId)}"${actionDisabled}>Finalize payout</button>
            </div>
            ${recommendedLabel ? `<div class="dispute-meta">Enter the payout amount to release to the paralegal. Recommended: no more than ${recommendedLabel} (70% of original case payout).</div>` : ""}
            ${actionNote}
      `;
      const standardActions = `
            <div class="dispute-actions">
              <button class="btn secondary" type="button" data-dispute-action="refund" data-case-id="${escapeAttribute(
                caseId
              )}" data-dispute-id="${escapeAttribute(disputeId)}"${actionDisabled}>Refund attorney</button>
              <button class="btn primary" type="button" data-dispute-action="release-full" data-case-id="${escapeAttribute(
                caseId
              )}" data-dispute-id="${escapeAttribute(disputeId)}"${actionDisabled}>Full release</button>
              <input type="number" min="0" step="0.01" placeholder="Payout to paralegal $" data-dispute-amount${actionDisabled} />
              <button class="btn secondary" type="button" data-dispute-action="release-partial" data-case-id="${escapeAttribute(
                caseId
              )}" data-dispute-id="${escapeAttribute(disputeId)}"${actionDisabled}>Partial release</button>
            </div>
            <div class="dispute-meta">Enter the payout amount to release to the paralegal. Platform fees are handled automatically.</div>
            ${actionNote}
      `;
      return `
        <tr data-case-id="${escapeAttribute(caseId)}" data-dispute-id="${escapeAttribute(disputeId)}" data-gross-max="${baseAmount}" data-payout-max="${amounts.payoutAmount}">
          <td>
            <div>
              <a class="btn-link" href="/api/cases/${escapeAttribute(caseId)}/archive/download" target="_blank" rel="noopener">
                ${escapeHTML(item.caseTitle || "Case")}
              </a>
            </div>
            <div class="dispute-meta">${escapeHTML(caseId)}</div>
          </td>
          <td>
            <div>${escapeHTML(attorneyLabel)}</div>
            <div class="dispute-meta">${escapeHTML(paralegalLabel)}</div>
          </td>
          <td>
            <div class="dispute-message">${reason}</div>
            <div class="dispute-meta">${escapeHTML(createdAt)}</div>
            <div class="dispute-meta">${escapeHTML(tasksLabel)}</div>
            ${requestedLine}
          </td>
          <td><span class="dispute-status">${escapeHTML(status)}</span></td>
          <td>
            <div>${grossLabel}</div>
            <div class="dispute-meta">Fee ${amounts.feePct}%: ${feeLabel} · Net: ${payoutLabel}</div>
          </td>
          <td>
            ${withdrawal ? withdrawalActions : standardActions}
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderResolvedDisputes(items = []) {
  if (!disputesBody) return;
  if (!items.length) {
    disputesBody.innerHTML = '<tr><td colspan="5" class="pending-empty">No resolved disputes found.</td></tr>';
    return;
  }
  disputesBody.innerHTML = items
    .map((item) => {
      const caseId = String(item.caseId || "");
      const dispute = item.dispute || {};
      const disputeId = String(dispute.disputeId || dispute._id || "");
      const resolution = resolveDisputeResolution(item);
      if (!resolution) return "";
      const attorneyLabel = buildPersonLabel(item.attorney);
      const paralegalLabel = buildPersonLabel(item.paralegal);
      const tasksTotal = Number.isFinite(Number(item.tasksTotal)) ? Number(item.tasksTotal) : 0;
      const tasksCompleted = Number.isFinite(Number(item.tasksCompleted))
        ? Number(item.tasksCompleted)
        : 0;
      const tasksLabel = `Tasks: ${tasksCompleted} / ${tasksTotal}`;
      const resolvedAt = resolution.resolvedAt ? formatDate(resolution.resolvedAt) : "—";
      const notesValue = escapeHTML(dispute.adminNotes || "");
      const detailId = `dispute-detail-${escapeAttribute(caseId)}-${escapeAttribute(disputeId)}`;
      return `
        <tr data-case-id="${escapeAttribute(caseId)}" data-dispute-id="${escapeAttribute(
        disputeId
      )}" data-dispute-row>
          <td>
            <div>
              <a class="btn-link" href="/api/cases/${escapeAttribute(caseId)}/archive/download" target="_blank" rel="noopener">
                ${escapeHTML(item.caseTitle || "Case")}
              </a>
            </div>
            <div class="dispute-meta">${escapeHTML(caseId)}</div>
            <div class="dispute-meta">${escapeHTML(tasksLabel)}</div>
          </td>
          <td>
            <div>${escapeHTML(attorneyLabel)}</div>
            <div class="dispute-meta">${escapeHTML(paralegalLabel)}</div>
          </td>
          <td><span class="dispute-status">${escapeHTML(resolution.label)}</span></td>
          <td>${escapeHTML(resolvedAt)}</td>
          <td>
            <button class="dispute-row-toggle" type="button" data-dispute-toggle="${detailId}" aria-expanded="false">
              View internal notes
            </button>
          </td>
        </tr>
        <tr class="dispute-details hidden" id="${detailId}">
          <td colspan="5">
            <div class="dispute-notes">
              <div class="dispute-notes-label">Internal Notes</div>
              <textarea data-dispute-notes placeholder="Add internal notes…">${notesValue}</textarea>
              <button class="btn secondary" type="button" data-dispute-notes-save data-case-id="${escapeAttribute(
                caseId
              )}" data-dispute-id="${escapeAttribute(disputeId)}">Save notes</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderRejectedDisputes(items = []) {
  if (!disputesBody) return;
  if (!items.length) {
    disputesBody.innerHTML = '<tr><td colspan="5" class="pending-empty">No rejected disputes found.</td></tr>';
    return;
  }
  disputesBody.innerHTML = items
    .map((item) => {
      const caseId = String(item.caseId || "");
      const dispute = item.dispute || {};
      const attorneyLabel = buildPersonLabel(item.attorney);
      const paralegalLabel = buildPersonLabel(item.paralegal);
      const messageRaw = String(dispute.message || dispute.reason || "").trim();
      const reason = messageRaw ? escapeHTML(messageRaw) : "—";
      const updatedAt = dispute.updatedAt || dispute.createdAt || null;
      return `
        <tr data-case-id="${escapeAttribute(caseId)}">
          <td>
            <div>
              <a class="btn-link" href="/api/cases/${escapeAttribute(caseId)}/archive/download" target="_blank" rel="noopener">
                ${escapeHTML(item.caseTitle || "Case")}
              </a>
            </div>
            <div class="dispute-meta">${escapeHTML(caseId)}</div>
          </td>
          <td>
            <div>${escapeHTML(attorneyLabel)}</div>
            <div class="dispute-meta">${escapeHTML(paralegalLabel)}</div>
          </td>
          <td><div class="dispute-message">${reason}</div></td>
          <td><span class="dispute-status">rejected</span></td>
          <td>${escapeHTML(updatedAt ? formatDate(updatedAt) : "—")}</td>
        </tr>
      `;
    })
    .join("");
}

function renderDisputes(items = [], status = "open") {
  renderDisputeHeader(status);
  if (!disputesBody) return;
  if (!items.length) {
    disputesBody.innerHTML = `<tr><td colspan="${getDisputeColspan(status)}" class="pending-empty">No disputes found.</td></tr>`;
    return;
  }
  if (status === "resolved") {
    renderResolvedDisputes(items.filter((item) => resolveDisputeResolution(item)));
    return;
  }
  if (status === "rejected") {
    renderRejectedDisputes(items);
    return;
  }
  renderOpenDisputes(items);
}

async function loadDisputeSummary() {
  if (!disputeCountEl) return;
  try {
    const params = new URLSearchParams({ status: "open", limit: "1" });
    const res = await secureFetch(`/api/disputes/admin?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || "Unable to load disputes.");
    const total = Number(payload.total || 0);
    disputeCountEl.textContent = total.toLocaleString();
  } catch (err) {
    disputeCountEl.textContent = "—";
  }
}

function getActiveDisputeStatus() {
  const activeTab = disputeTabs.find((btn) => btn.classList.contains("active"));
  return activeTab?.dataset?.disputeTab || disputeStatusFilter?.value || "open";
}

function setActiveDisputeStatus(status) {
  const value = status || "open";
  if (disputeStatusFilter) {
    disputeStatusFilter.value = value;
  }
  disputeTabs.forEach((btn) => {
    const isActive = btn.dataset.disputeTab === value;
    btn.classList.toggle("active", isActive);
  });
}

async function loadDisputes() {
  if (!disputesBody) return;
  const status = getActiveDisputeStatus();
  renderDisputeHeader(status);
  disputesBody.innerHTML = `<tr><td colspan="${getDisputeColspan(status)}" class="pending-empty">Loading disputes…</td></tr>`;
  try {
    const q = String(disputeSearchInput?.value || "").trim();
    const params = new URLSearchParams({ status, limit: "50" });
    if (status === "resolved") params.set("finalized", "true");
    if (q) params.set("q", q);
    const res = await secureFetch(`/api/disputes/admin?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || "Unable to load disputes.");
    const items = Array.isArray(payload?.items) ? payload.items : [];
    renderDisputes(items, status);
  } catch (err) {
    disputesBody.innerHTML = `<tr><td colspan="${getDisputeColspan(getActiveDisputeStatus())}" class="pending-empty">${escapeHTML(
      err?.message || "Unable to load disputes."
    )}</td></tr>`;
  }
}

async function settleDispute({ action, caseId, disputeId, payoutAmountCents, grossAmountCents }) {
  if (!caseId || !disputeId) return;
  try {
    await fetchCSRF();
  } catch (_) {}
  const body = { action, disputeId };
  if (Number.isFinite(payoutAmountCents)) {
    body.payoutAmountCents = payoutAmountCents;
  } else if (Number.isFinite(grossAmountCents)) {
    body.grossAmountCents = grossAmountCents;
  }
  const res = await secureFetch(`/api/payments/dispute/settle/${encodeURIComponent(caseId)}`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || payload?.msg || "Unable to settle dispute.");
  }
  return payload;
}

async function saveDisputeNotes({ caseId, disputeId, notes }) {
  if (!caseId || !disputeId) return;
  try {
    await fetchCSRF();
  } catch (_) {}
  const res = await secureFetch(
    `/api/disputes/${encodeURIComponent(caseId)}/${encodeURIComponent(disputeId)}/admin-notes`,
    {
      method: "PATCH",
      headers: { Accept: "application/json" },
      body: { notes },
    }
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Unable to save notes.");
  }
  return payload;
}

if (disputeCardEl) {
  const openDisputes = () => window.activateAdminSection?.("finance");
  disputeCardEl.addEventListener("click", openDisputes);
  disputeCardEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDisputes();
    }
  });
}

if (overviewActionRowsEl) {
  const openOverviewActionRow = (target) => {
    const row = target.closest("[data-overview-target-section]");
    if (!row) return;
    const sectionKey = row.getAttribute("data-overview-target-section") || "";
    const anchorId = row.getAttribute("data-overview-target-anchor") || "";
    const behaviorKey = row.getAttribute("data-overview-target-behavior") || "";
    navigateOverviewAction(sectionKey, anchorId, getOverviewActionNavigationOptions(behaviorKey));
  };

  overviewActionRowsEl.addEventListener("click", (event) => {
    openOverviewActionRow(event.target);
  });

  overviewActionRowsEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openOverviewActionRow(event.target);
  });
}

if (refreshDisputesBtn) {
  refreshDisputesBtn.addEventListener("click", () => {
    loadDisputes();
  });
}

if (disputeTabs.length) {
  disputeTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const status = tab.dataset.disputeTab || "open";
      setActiveDisputeStatus(status);
      loadDisputes();
    });
  });
}

if (disputeStatusFilter) {
  disputeStatusFilter.addEventListener("change", () => {
    setActiveDisputeStatus(disputeStatusFilter.value || "open");
    loadDisputes();
  });
}

if (disputeSearchInput) {
  disputeSearchInput.addEventListener("input", () => {
    loadDisputes();
  });
}

if (disputesBody) {
  disputesBody.addEventListener("click", async (event) => {
    const toggleBtn = event.target?.closest?.("[data-dispute-toggle]");
    if (toggleBtn) {
      const targetId = toggleBtn.dataset.disputeToggle;
      const detailRow = targetId ? document.getElementById(targetId) : null;
      if (detailRow) {
        const isHidden = detailRow.classList.contains("hidden");
        detailRow.classList.toggle("hidden", !isHidden);
        toggleBtn.setAttribute("aria-expanded", String(isHidden));
        toggleBtn.textContent = isHidden ? "Hide internal notes" : "View internal notes";
      }
      return;
    }

    const notesButton = event.target?.closest?.("[data-dispute-notes-save]");
    if (notesButton) {
      const caseId = notesButton.dataset.caseId;
      const disputeId = notesButton.dataset.disputeId;
      const row = notesButton.closest("tr");
      const notesInput = row?.querySelector("[data-dispute-notes]");
      const notes = String(notesInput?.value || "").trim();
      if (!caseId || !disputeId) return;
      try {
        notesButton.disabled = true;
        await saveDisputeNotes({ caseId, disputeId, notes });
        showToast("Notes saved.", "success");
      } catch (err) {
        showToast(err?.message || "Unable to save notes.", "err");
      } finally {
        notesButton.disabled = false;
      }
      return;
    }

    const button = event.target?.closest?.("[data-dispute-action]");
    if (!button) return;
    const actionKey = button.dataset.disputeAction;
    const caseId = button.dataset.caseId;
    const disputeId = button.dataset.disputeId;
    if (!actionKey || !caseId || !disputeId) return;

    const row = button.closest("tr");
    let payoutAmountCents;
    if (actionKey === "release-partial") {
      const input = row?.querySelector("[data-dispute-amount]");
      const amountUsd = Number(input?.value || 0);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        showToast("Enter a valid partial amount.", "info");
        return;
      }
      payoutAmountCents = Math.round(amountUsd * 100);
      const max = Number(row?.dataset?.payoutMax || 0);
      if (Number.isFinite(max) && max > 0 && payoutAmountCents > max) {
        showToast("Payout amount exceeds the maximum available payout for this case.", "info");
        return;
      }
    }

    const confirmText =
      actionKey === "refund"
        ? "Refund the attorney and close this dispute?"
        : actionKey === "release-full"
        ? "Release full payout to the paralegal and close this dispute?"
        : "Release the partial payout to the paralegal and close this dispute?";
    if (!window.confirm(confirmText)) return;

    const action =
      actionKey === "refund"
        ? "refund"
        : actionKey === "release-full"
        ? "release_full"
        : "release_partial";

    try {
      button.disabled = true;
      const payload = await settleDispute({ action, caseId, disputeId, payoutAmountCents });
      if (payload?.refundId) {
        showToast("Dispute settled. Refund issued.", "success");
      } else {
        showToast("Dispute settled. Payout released.", "success");
      }
      await Promise.all([loadDisputes(), loadDisputeSummary(), hydrateAnalytics()]);
      await renderAIControlRoom(true);
    } catch (err) {
      showToast(err?.message || "Unable to settle dispute.", "err");
    } finally {
      button.disabled = false;
    }
  });
}

window.loadDisputes = loadDisputes;

function applyRoleVisibility(user) {
const role = String(user?.role || "").toLowerCase();
if (role === "paralegal") {
document.querySelectorAll("[data-attorney-only]").forEach((el) => {
el.style.display = "none";
});
}
if (role === "attorney") {
document.querySelectorAll("[data-paralegal-only]").forEach((el) => {
el.style.display = "none";
});
}
}

async function bootAdminDashboard() {
const user = typeof window.requireRole === "function" ? await window.requireRole("admin") : null;
if (!user) return null;
applyRoleVisibility(user);
await loadPendingParalegals();
return user;
}

async function loadUsers() {
await Promise.allSettled([loadPendingParalegals(), hydrateAnalytics()]);
await renderAIControlRoom(true);
}

window.loadOverviewActionBoard = loadOverviewActionBoard;

document.addEventListener("DOMContentLoaded", async () => {
const user = await bootAdminDashboard();
if (!user) return;

bindSettingsActions();
await loadAdminSettings();
await loadAdminThemePreference();
await hydrateAnalytics();
await loadDisputeSummary();
await loadOverviewActionBoard(true);
	await loadReceipts();
	await renderAIControlRoom();

if (receiptRefreshBtn) {
receiptRefreshBtn.addEventListener("click", () => {
loadReceipts();
});
}
if (receiptSearchInput) {
receiptSearchInput.addEventListener("input", () => {
if (receiptSearchTimer) window.clearTimeout(receiptSearchTimer);
receiptSearchTimer = window.setTimeout(() => {
loadReceipts();
}, 250);
});
}

const taxReportBtn = document.getElementById("taxReportBtn");
if (taxReportBtn) {
taxReportBtn.addEventListener("click", async () => {
const originalLabel = taxReportBtn.textContent || "Generate Tax Report";
taxReportBtn.disabled = true;
taxReportBtn.textContent = "Generating...";
try {
const payload = latestAnalytics || (await hydrateAnalytics());
if (!payload) throw new Error("Unable to load tax summary.");
downloadTaxReport(payload);
showToast("Tax report generated.", "ok");
} catch (err) {
showToast(err?.message || "Unable to generate tax report.", "err");
} finally {
taxReportBtn.disabled = false;
taxReportBtn.textContent = originalLabel;
}
});
}
});

document.addEventListener("visibilitychange", () => {
if (document.hidden) {
destroyCharts();
}
});

document.addEventListener("click", async (evt) => {
	const aiRoomTab = evt.target.closest('a[data-section="ai-control-room"]');
	if (aiRoomTab) {
	await renderAIControlRoom();
	}

	const aiRoomRefreshBtn = evt.target.closest("#aiRoomRefreshButton");
	if (aiRoomRefreshBtn) {
	await renderAIControlRoom(true);
	return;
	}

	const aiRoomDecisionBtn = evt.target.closest("[data-ai-room-decision-kind]");
	if (aiRoomDecisionBtn) {
	const successMessage =
		aiRoomDecisionBtn.getAttribute("data-ai-room-success-message") ||
		(aiRoomDecisionBtn.getAttribute("data-ai-room-decision") === "approve"
			? "Decision recorded."
			: "Rejection recorded.");
  const optimisticUpdate = applyOptimisticAIControlRoomDecision(aiRoomDecisionBtn);
	try {
	aiRoomDecisionBtn.disabled = true;
	await runAIControlRoomDecisionAction(aiRoomDecisionBtn);
	showToast(successMessage, "success");
	optimisticUpdate.commit();
	} catch (err) {
	optimisticUpdate.rollback();
	showToast(err?.message || `Unable to complete "${aiRoomDecisionBtn.textContent.trim() || "that action"}".`, "err");
	} finally {
	aiRoomDecisionBtn.disabled = false;
	}
	return;
	}

	const aiRoomNavBtn = evt.target.closest("[data-ai-room-nav]");
	if (aiRoomNavBtn) {
	const sectionKey = aiRoomNavBtn.getAttribute("data-ai-room-nav");
	if (sectionKey) window.activateAdminSection?.(sectionKey);
	return;
	}

	const aiRoomOpenBtn = evt.target.closest("[data-ai-room-open]");
	if (aiRoomOpenBtn) {
	const key = aiRoomOpenBtn.getAttribute("data-ai-room-open");
	if (key) await openAIControlRoomCard(key);
	return;
	}

	const incidentApprovalBtn = evt.target.closest("[data-incident-approval-decision]");
	if (incidentApprovalBtn) {
	const decision = incidentApprovalBtn.getAttribute("data-incident-approval-decision");
	const incidentId = incidentApprovalBtn.getAttribute("data-incident-id");
	const approvalId = incidentApprovalBtn.getAttribute("data-approval-id");
	const note = document.getElementById("incidentApprovalDecisionNote")?.value?.trim() || "";
	if (!decision || !incidentId || !approvalId) return;
	if (decision === "reject" && !window.confirm("Reject this release candidate?")) return;
  const optimisticUpdate = applyOptimisticAIControlRoomDecisionDescriptor({
    kind: "incident_approval",
    decision,
    incidentId,
    approvalId,
  });
	try {
	incidentApprovalBtn.disabled = true;
	await decideIncidentApproval(incidentId, approvalId, { decision, note });
	showToast(decision === "approve" ? "Release approval recorded." : "Release rejection recorded.", "success");
	optimisticUpdate.commit();
	} catch (err) {
	optimisticUpdate.rollback();
	showToast(err?.message || "Unable to record the approval decision.", "err");
	} finally {
	incidentApprovalBtn.disabled = false;
	}
	return;
	}

	const incidentSelectBtn = evt.target.closest("[data-incident-select]");
	if (incidentSelectBtn) {
	const incidentId = incidentSelectBtn.getAttribute("data-incident-select");
	if (incidentId) {
	await selectIncidentForWorkspace(incidentId, true);
	renderIncidentList(
	"incidentAdminList",
	"incidentAdminListMeta",
	incidentRoomState.list,
	incidentRoomState.activeIncidentId
	);
	}
	return;
	}

	const disableBtn = evt.target.closest(".disableUserBtn");
	if (disableBtn) {
const id = disableBtn.dataset.id;
if (!id) return;
try {
await secureFetch(`/api/admin/disable/${encodeURIComponent(id)}`, { method: "POST" });
await loadUsers();
} catch (err) {
console.error("Failed to disable user", err);
}
return;
}

const enableBtn = evt.target.closest(".enableUserBtn");
if (enableBtn) {
const id = enableBtn.dataset.id;
if (!id) return;
try {
await secureFetch(`/api/admin/enable/${encodeURIComponent(id)}`, { method: "POST" });
await loadUsers();
} catch (err) {
console.error("Failed to enable user", err);
}
return;
}

const approveBtn = evt.target.closest(".approveParalegalBtn");
const rejectBtn = evt.target.closest(".rejectParalegalBtn");
if (approveBtn) {
const id = approveBtn.dataset.id;
if (!id) return;
try {
	await secureFetch(`/api/admin/approve/${encodeURIComponent(id)}`, { method: "POST" });
	await loadPendingParalegals();
	await hydrateAnalytics();
	await renderAIControlRoom(true);
if (typeof window.loadPendingUsers === "function") {
await window.loadPendingUsers();
}
} catch (err) {
console.error("Failed to approve paralegal", err);
}
return;
}
if (rejectBtn) {
const id = rejectBtn.dataset.id;
if (!id) return;
try {
	await secureFetch(`/api/admin/reject/${encodeURIComponent(id)}`, { method: "POST" });
	await loadPendingParalegals();
	await hydrateAnalytics();
	await renderAIControlRoom(true);
if (typeof window.loadPendingUsers === "function") {
await window.loadPendingUsers();
}
} catch (err) {
console.error("Failed to reject paralegal", err);
}
}
});
