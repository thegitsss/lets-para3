import { secureFetch } from "./auth.js";
import {
  getStripeConnectStatus,
  isStripeConnected,
  startStripeOnboarding,
  STRIPE_GATE_MESSAGE,
} from "./utils/stripe-connect.js";
import { mountDashboardSavedViews } from "./dashboard-saved-views.js";
import { activateDialogFocus, deactivateDialogFocus } from "./utils/dialog-focus.js";
import { showAlert } from "./utils/dialogs.js";
import { normalizeHttpNavigationUrl } from "./utils/navigation-url.js";

const FUNDED_WORKSPACE_STATUSES = new Set([
  "in progress",
  "in_progress",
]);

const PLACEHOLDER_AVATAR = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220' viewBox='0 0 220 220'>
    <rect width='220' height='220' rx='110' fill='#f1f5f9'/>
    <circle cx='110' cy='90' r='46' fill='#cbd5e1'/>
    <path d='M40 188c10-40 45-68 70-68s60 28 70 68' fill='none' stroke='#cbd5e1' stroke-width='18' stroke-linecap='round'/>
  </svg>`
)}`;

function getAvatarUrl(user = {}) {
  return user.pendingProfileImage || user.profileImage || user.avatarURL || PLACEHOLDER_AVATAR;
}

function isPendingPhoto(profile = {}) {
  return (
    String(profile.profilePhotoStatus || "").toLowerCase() === "pending_review" ||
    Boolean(profile.pendingProfileImage)
  );
}

function updatePendingApprovalBanner(profile = {}) {
  const banner = document.getElementById("photoPendingBanner");
  if (!banner) return;
  if (!pendingApprovalReady) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.toggle("hidden", !isPendingPhoto(profile));
}

function normalizeIdCandidate(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return value._id || value.id || value.userId || "";
  return "";
}

function getCaseId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    return value.caseId || value.id || value._id || "";
  }
  return "";
}

function normalizeCaseStatus(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "in_progress") return "in progress";
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing", "funded_in_progress"].includes(lower)) return "in progress";
  return lower;
}

function isWorkspaceEligibleCase(caseItem) {
  if (!caseItem) return false;
  if (caseItem.archived !== false) return false;
  if (caseItem.paymentReleased !== false) return false;
  const status = normalizeCaseStatus(caseItem?.status);
  if (!status || !FUNDED_WORKSPACE_STATUSES.has(status)) return false;
  const escrowFunded =
    !!caseItem?.escrowIntentId && String(caseItem?.escrowStatus || "").toLowerCase() === "funded";
  if (!escrowFunded) return false;
  const hasParalegal = caseItem?.paralegal || caseItem?.paralegalId;
  return !!hasParalegal;
}

function navigateToCase(caseId, { messages = false } = {}) {
  if (!caseId) return;
  const target = `case-detail.html?caseId=${encodeURIComponent(caseId)}${messages ? "&tab=messages" : ""}`;
  window.location.href = target;
}

function formatStatusLabel(value) {
  const cleaned = normalizeCaseStatus(value);
  if (!cleaned) return "";
  if (cleaned === "in progress") return "In Progress";
  if (cleaned === "open") return "Posted";
  if (cleaned === "completed") return "Completed";
  if (cleaned === "disputed") return "Disputed";
  if (cleaned === "closed") return "Closed";
  return cleaned.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveAttorneyId(invite = {}) {
  const candidates = [invite.attorney, invite.attorneyId, invite.attorney_id];
  for (const candidate of candidates) {
    const id = normalizeIdCandidate(candidate);
    if (id) return id;
  }
  const createdBy = invite.createdByUser || invite.createdBy;
  const createdByRole = String(
    (createdBy && (createdBy.role || createdBy.type)) || invite.createdByRole || invite.createdByType || ""
  ).toLowerCase();
  if (createdByRole === "attorney") {
    const createdById = normalizeIdCandidate(createdBy);
    if (createdById) return createdById;
  }
  return "";
}

const selectors = {
  messageBox: document.getElementById('messageBox'),
  messageCount: document.getElementById('messageCount'),
  messageLabel: document.getElementById('messageLabel'),
  deadlineList: document.getElementById('deadlineList'),
  assignmentList: document.getElementById('assignmentList'),
  recentActivityList: document.getElementById('recentActivityList'),
  assignmentTemplate: document.getElementById('assignmentCardTemplate'),
  toastBanner: document.getElementById('toastBanner'),
  nameHeading: document.getElementById('user-name-heading'),
  welcomeGreeting: document.getElementById('welcomeGreeting'),
  inviteOverlay: document.getElementById('inviteOverlay'),
  inviteCaseTitle: document.getElementById('inviteCaseTitle'),
  inviteJobTitle: document.getElementById('inviteJobTitle'),
  inviteLead: document.getElementById('inviteLead'),
  inviteMeta: document.getElementById('inviteMeta'),
  inviteDetails: document.getElementById('inviteDetails'),
  inviteAttorneyAvatar: document.getElementById('inviteAttorneyAvatar'),
  inviteAttorneyName: document.getElementById('inviteAttorneyName'),
  inviteAttorneyFirm: document.getElementById('inviteAttorneyFirm'),
  inviteAttorneyLink: document.getElementById('inviteAttorneyLink'),
  inviteCloseBtn: document.getElementById('inviteCloseBtn'),
  inviteAcceptBtn: document.getElementById('inviteAcceptBtn'),
  inviteDeclineBtn: document.getElementById('inviteDeclineBtn'),
  revokeConfirmModal: document.getElementById('revokeConfirmModal'),
  revokeConfirmClose: document.querySelector('[data-revoke-confirm-close]'),
  revokeConfirmCancel: document.querySelector('[data-revoke-confirm-cancel]'),
  revokeConfirmSubmit: document.querySelector('[data-revoke-confirm-submit]'),
  earningsCard: document.getElementById('earnedThisMonthCard'),
  earningsToggle: document.getElementById('earningsToggle'),
  earningsLabel: document.getElementById('earningsLabelText'),
};

const recentActivityState = {
  threads: [],
  deadlines: [],
  invites: [],
};

const appliedFilters = {
  toggle: document.getElementById('appliedFilterToggle'),
  panel: document.getElementById('appliedControlsPanel'),
  search: document.getElementById('appliedSearch'),
  status: document.getElementById('appliedStatusFilter'),
  practice: document.getElementById('appliedPracticeFilter'),
  dateRange: document.getElementById('appliedDateFilter'),
  sort: document.getElementById('appliedSort'),
  count: document.getElementById('appliedCount'),
};

const appliedPagination = {
  prev: document.getElementById('appliedPrevBtn'),
  next: document.getElementById('appliedNextBtn'),
  info: document.getElementById('appliedPageInfo'),
};

const JSON_HEADERS = { Accept: 'application/json' };

async function fetchJson(url, options = {}) {
  const res = await secureFetch(url, {
    ...options,
    headers: { ...JSON_HEADERS, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const error = new Error(`Failed to load ${url}`);
    error.status = res.status;
    throw error;
  }
  try {
    return await res.json();
  } catch {
    return {};
  }
}

let latestMessageThread = null;
let unreadMessageCount = 0;
let stripeConnected = false;
let stripeGateBound = false;
let pendingApprovalReady = false;
let appliedAppsCache = [];
let appliedFiltersBound = false;
let appliedFilterToggleBound = false;
let applicationSavedViews = null;
let paralegalPrioritySnapshot = { activeCases: [], invites: [], threads: [], deadlines: [], applications: [] };
let activeApplication = null;
let applicationPreEngagementDraft = null;
let applicationPreEngagementExpandedKey = '';
const APPLIED_PAGE_SIZE = 3;
let appliedPage = 1;
let appliedTotalPages = 1;
const applicationModal = document.getElementById('applicationDetailModal');
const applicationDetail = applicationModal?.querySelector('[data-application-detail]');
let applicationModalBound = false;
let appliedPreviewBound = false;
let appliedQueryHandled = false;
let appliedHighlightHandled = false;
let applicationReturnFocus = null;
let dashboardRefreshInFlight = false;
let lastDashboardRefreshAt = 0;
const DASHBOARD_REFRESH_COOLDOWN_MS = 4000;
let earningsMode = 'month';
let earningsSnapshot = { month: 0, total: 0 };
let clusterMenuBound = false;

function bindClusterProfileMenu() {
  if (clusterMenuBound) return;
  clusterMenuBound = true;
  document.addEventListener('click', (event) => {
    const trigger = document.getElementById('clusterProfileTrigger');
    const menu = document.getElementById('clusterProfileDropdown');
    if (!trigger || !menu) return;
    if (trigger.contains(event.target) && !menu.contains(event.target)) {
      const open = !menu.classList.contains('show');
      menu.classList.toggle('show', open);
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    if (!menu.contains(event.target) && !trigger.contains(event.target)) {
      menu.classList.remove('show');
      menu.setAttribute('aria-hidden', 'true');
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (event) => {
    const trigger = document.getElementById('clusterProfileTrigger');
    const menu = document.getElementById('clusterProfileDropdown');
    if (!trigger || !menu) return;
    if ((event.key === 'Enter' || event.key === ' ') && document.activeElement === trigger) {
      event.preventDefault();
      const open = !menu.classList.contains('show');
      menu.classList.toggle('show', open);
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    if (event.key === 'Escape' && menu.classList.contains('show')) {
      menu.classList.remove('show');
      menu.setAttribute('aria-hidden', 'true');
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
}

function updateUnreadDisplay(count = 0) {
  const unread = Number(count) || 0;
  setField('unreadMessages', unread);
  unreadMessageCount = unread;
  if (selectors.messageCount) {
    selectors.messageCount.textContent = unread;
  }
  if (selectors.messageLabel) {
    selectors.messageLabel.textContent =
      unread === 0 ? 'No unread messages' : unread === 1 ? 'Message waiting' : 'Messages waiting';
  }
  if (selectors.messageBox) {
    selectors.messageBox.disabled = unread < 1;
    selectors.messageBox.classList.toggle('has-unread', unread > 0);
    selectors.messageBox.setAttribute(
      'aria-label',
      unread > 0 ? `Open ${unread} unread message${unread === 1 ? '' : 's'}` : 'No unread messages'
    );
  }
}

function notifyCasesApplicationsRefresh(reason = '', payload = {}) {
  try {
    window.dispatchEvent(
      new CustomEvent('lpc:paralegal-dashboard-refresh', {
        detail: { reason, ...payload },
      })
    );
  } catch {}
}


function notifyStripeGate(message = STRIPE_GATE_MESSAGE) {
  const toastHelper = window.toastUtils;
  if (toastHelper?.show && selectors.toastBanner) {
    toastHelper.show(message, { targetId: selectors.toastBanner.id, type: "info" });
    return;
  }
  void showAlert(message, { title: "Action needed" });
}

function applyStripeGateToApplyActions() {
  const disabled = !stripeConnected;
  document.querySelectorAll("[data-stripe-apply]").forEach((el) => {
    if (el.tagName === "BUTTON") {
      el.disabled = disabled;
    } else {
      el.setAttribute("aria-disabled", disabled ? "true" : "false");
    }
    if (disabled) {
      el.setAttribute("title", STRIPE_GATE_MESSAGE);
    } else {
      el.removeAttribute("title");
      el.removeAttribute("aria-disabled");
    }
  });
  if (!stripeGateBound) {
    stripeGateBound = true;
    document.addEventListener("click", (event) => {
      const target = event.target?.closest?.("[data-stripe-apply]");
      if (!target || stripeConnected) return;
      event.preventDefault();
      event.stopPropagation();
      notifyStripeGate();
    });
  }
}

async function loadViewerProfile() {
  const profile = await fetchJson('/api/users/me');
  return profile;
}

async function loadStripeStatus() {
  const banner = document.getElementById("stripeGateBanner");
  const message = document.querySelector("[data-stripe-gate-message]");
  const cta = document.getElementById("stripeConnectCta");

  const data = await getStripeConnectStatus({ force: true });
  stripeConnected = isStripeConnected(data);
  if (banner) banner.classList.toggle("hidden", stripeConnected);
  if (message && !stripeConnected) {
    message.textContent = "";
  }
  if (cta) {
    cta.disabled = !stripeConnected;
    if (!stripeConnected) {
      cta.setAttribute("aria-disabled", "true");
    } else {
      cta.removeAttribute("aria-disabled");
    }
  }
  if (cta && stripeConnected && !cta.dataset.bound) {
    cta.dataset.bound = "true";
    cta.addEventListener("click", async () => {
      const original = cta.textContent || "Connect Stripe";
      cta.disabled = true;
      cta.textContent = "Connecting...";
      try {
        await startStripeOnboarding();
      } catch (err) {
        console.error("Stripe connect failed", err);
        await showAlert(err?.message || "Unable to start Stripe onboarding.", { title: "Stripe connection unavailable" });
        cta.disabled = false;
        cta.textContent = original;
      }
    });
  }
  applyStripeGateToApplyActions();
  return data;
}

async function fetchParalegalData({ fresh = false } = {}) {
  const url = fresh
    ? `/api/paralegal/dashboard?ts=${Date.now()}`
    : '/api/paralegal/dashboard';
  const headers = fresh ? { 'Cache-Control': 'no-store' } : undefined;
  const cache = fresh ? 'no-store' : undefined;
  return fetchJson(url, { headers, cache });
}

async function loadDeadlineEvents(limit = 5) {
  const params = new URLSearchParams({ limit: String(limit) });
  return fetchJson(`/api/events?${params.toString()}`).then((data) => (Array.isArray(data.items) ? data.items : []));
}

function getCaseDeadlineDate(caseItem = {}) {
  return window.LPCBusinessDate?.matterValue(caseItem) || "";
}

function buildCaseDeadlines(activeCases = []) {
  return (Array.isArray(activeCases) ? activeCases : [])
    .map((caseItem) => {
      const dateOnly = getCaseDeadlineDate(caseItem);
      if (!dateOnly) return null;
      return {
        title: caseItem.jobTitle || caseItem.title || 'Matter deadline',
        where: caseItem.practiceArea || '',
        start: dateOnly,
        caseId: getCaseId(caseItem),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

async function loadMessageThreads(limit = 50) {
  return fetchJson(`/api/messages/threads?limit=${limit}`).then((data) => (Array.isArray(data.threads) ? data.threads : []));
}

async function loadUnreadMessageCount() {
  return fetchJson('/api/messages/unread-count').then((data) => Number(data.count) || 0);
}

function formatCurrency(value = 0) {
  const amount = Number(value) || 0;
  return amount.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function formatCaseCompensation(cents = 0) {
  const value = Number(cents);
  if (!Number.isFinite(value) || value <= 0) return '';
  return formatCurrency(value / 100);
}

function deriveNextDeadline(events = []) {
  const next = Array.isArray(events) ? events[0] : null;
  if (!next) return '—';
  return next.start ? formatMatterDeadline(next.start) : '—';
}

function setField(field, value) {
  document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
    el.textContent = value ?? '';
  });
}

function readEarningsMode() {
  try {
    const saved = localStorage.getItem('lpc-earnings-mode');
    if (saved === 'total' || saved === 'month') return saved;
  } catch {}
  return 'month';
}

function writeEarningsMode(mode) {
  try {
    localStorage.setItem('lpc-earnings-mode', mode);
  } catch {}
}

function renderEarningsDisplay() {
  const amount = earningsMode === 'total' ? earningsSnapshot.total : earningsSnapshot.month;
  const label = earningsMode === 'total' ? 'total earned' : 'earned this month';
  if (selectors.earningsLabel) selectors.earningsLabel.textContent = label;
  if (selectors.earningsToggle) {
    selectors.earningsToggle.dataset.mode = earningsMode;
    selectors.earningsToggle.setAttribute('aria-pressed', earningsMode === 'total' ? 'true' : 'false');
  }
  const earningsDisplay = formatCurrency(amount).replace(/^\$/, '');
  setField('earningsValue', earningsDisplay);
}

function toggleEarningsMode(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  earningsMode = earningsMode === 'total' ? 'month' : 'total';
  writeEarningsMode(earningsMode);
  renderEarningsDisplay();
}

function updateStats(stats = {}) {
  const activeCases = Number(stats.activeCases ?? 0);
  const unread = Number(stats.unreadMessages ?? 0);
  const nextDeadline = stats.nextDeadline ?? '—';
  const monthEarnings = Number(stats.monthEarnings ?? 0);
  const totalEarnings = Number(stats.totalEarnings ?? monthEarnings ?? 0);
  const payout30Days = Number(stats.payout30Days ?? 0);
  const nextPayout = stats.nextPayout ?? '—';

  setField('welcomeSubheading', `You have ${activeCases} active assignment${activeCases === 1 ? '' : 's'}`);
  setField('activeCases', activeCases);
  updateUnreadDisplay(unread);
  setField('nextDeadline', nextDeadline);
  const payoutDisplay = formatCurrency(payout30Days).replace(/^\$/, '');
  earningsSnapshot = { month: monthEarnings, total: totalEarnings };
  renderEarningsDisplay();
  setField('payout30Days', payoutDisplay);
  setField('nextPayout', nextPayout);
}

async function refreshDashboardFromServer(reason = '') {
  if (dashboardRefreshInFlight) return;
  const now = Date.now();
  if (now - lastDashboardRefreshAt < DASHBOARD_REFRESH_COOLDOWN_MS) return;
  dashboardRefreshInFlight = true;
  lastDashboardRefreshAt = now;
  try {
    const [dashboard, invites, deadlines, threads, unreadCount] = await Promise.all([
      fetchParalegalData({ fresh: true }).catch((err) => {
        console.warn('Paralegal dashboard payload refresh failed', reason || '', err);
        return null;
      }),
      loadInvites().catch((err) => {
        console.warn('Paralegal invites refresh failed', reason || '', err);
        return recentActivityState.invites;
      }),
      loadDeadlineEvents().catch((err) => {
        console.warn('Paralegal deadlines refresh failed', reason || '', err);
        return [];
      }),
      loadMessageThreads().catch((err) => {
        console.warn('Paralegal threads refresh failed', reason || '', err);
        return recentActivityState.threads;
      }),
      loadUnreadMessageCount().catch((err) => {
        console.warn('Paralegal unread refresh failed', reason || '', err);
        return unreadMessageCount;
      }),
    ]);

    updateUnreadDisplay(unreadCount);
    initLatestMessage(Array.isArray(threads) ? threads : []);

    const activeCases = Array.isArray(dashboard?.activeCases) ? dashboard.activeCases : [];
    const caseDeadlines = buildCaseDeadlines(activeCases);
    const deadlineEvents = Array.isArray(deadlines) && deadlines.length ? deadlines : caseDeadlines;

    if (dashboard) {
      updateStats({
        activeCases: dashboard?.metrics?.activeCases,
        unreadMessages: unreadCount,
        nextDeadline: deriveNextDeadline(deadlineEvents),
        monthEarnings: dashboard?.metrics?.earnings,
        totalEarnings: dashboard?.metrics?.earningsTotal,
        payout30Days: dashboard?.metrics?.earningsLast30Days,
        nextPayout: dashboard?.metrics?.nextPayoutDate,
      });
      renderAssignments(mapActiveCasesToAssignments(activeCases));
    }

    renderDeadlines(deadlineEvents);
    renderRecentActivity({
      invites: Array.isArray(invites) ? invites : [],
      threads: Array.isArray(threads) ? threads : [],
      deadlines: deadlineEvents,
    });
    maybeOpenInviteFromQuery();
    await loadAppliedJobs({ preservePage: true });
    paralegalPrioritySnapshot = {
      activeCases,
      invites: Array.isArray(invites) ? invites : [],
      threads: Array.isArray(threads) ? threads : [],
      deadlines: deadlineEvents,
      applications: appliedAppsCache,
    };
    renderParalegalPriorityQueue();
    notifyCasesApplicationsRefresh(reason, {
      activeCases: activeCases,
    });
  } catch (err) {
    console.warn('Paralegal dashboard refresh failed', reason || '', err);
  } finally {
    dashboardRefreshInFlight = false;
  }
}

function setupDashboardAutoRefresh() {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      refreshDashboardFromServer('pageshow');
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshDashboardFromServer('visible');
    }
  });
  window.addEventListener('lpc:notifications-refreshed', () => {
    if (document.visibilityState !== 'visible') return;
    refreshDashboardFromServer('notifications');
  });
}

function renderDeadlines(deadlines = []) {
  const container = selectors.deadlineList;
  if (!container) return;
  if (!deadlines.length) {
    container.innerHTML = '<div class="info-line">No assigned deadlines.</div>';
    return;
  }
  container.innerHTML = deadlines
    .map((deadline) => {
      const title = deadline.title || 'Deadline';
      const where = deadline.where ? ` · ${deadline.where}` : '';
      const dueText = deadline.start ? ` due ${formatMatterDeadline(deadline.start)}` : '';
      return `<div class="info-line">• ${title}${where}${dueText}</div>`;
    })
    .join('');
}

function renderAssignments(assignments = []) {
  const container = selectors.assignmentList;
  if (!container || !selectors.assignmentTemplate) return;
  const usableAssignments = assignments.filter((assignment) => assignment && assignment.caseId);
  if (!usableAssignments.length) {
    container.removeAttribute("hidden");
    container.innerHTML = "";
    const emptyCard = document.createElement("div");
    emptyCard.className = "case-card empty-state";
    emptyCard.innerHTML = `
      <div class="case-header">
        <div>
          <h2>Assignments</h2>
          <div class="case-subinfo">No assignments yet.</div>
        </div>
      </div>
    `;
    container.appendChild(emptyCard);
    return;
  }
  container.removeAttribute("hidden");
  container.innerHTML = '';

  usableAssignments.forEach((assignment) => {
    const node = selectors.assignmentTemplate.content.cloneNode(true);
    const card = node.querySelector('.case-card');
    const titleEl = card.querySelector('[data-field="assignmentTitle"]');
    const metaEl = card.querySelector('[data-field="assignmentMeta"]');
    const summaryEl = card.querySelector('[data-field="assignmentSummary"]');
    const actions = card.querySelector('.case-actions');
    const primaryBtn = card.querySelector('[data-action="primary"]');
    const secondaryBtn = card.querySelector('[data-action="secondary"]');

    const attorney = assignment.attorney ? `Lead Attorney: ${assignment.attorney}` : '';
    const due = assignment.due ? `Due: ${assignment.due}` : '';
    const statusLabel = assignment.status ? formatStatusLabel(assignment.status) : '';
    const status = statusLabel ? `Status: ${statusLabel}` : '';
    const metaParts = [attorney, due, status].filter(Boolean);
    const caseId = assignment.caseId;
    const eligible = isWorkspaceEligibleCase(assignment);

    titleEl.textContent = assignment.title || 'Matter';
    metaEl.textContent = metaParts.join(' · ');
    summaryEl.textContent = assignment.summary || '';
    if (card) card.dataset.caseId = caseId;
    card.classList.add('open');

    if (actions) {
      actions.hidden = !eligible;
    }
    if (secondaryBtn) {
      secondaryBtn.hidden = !caseId;
      secondaryBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (window.LPCContextPanel?.openMatter?.(caseId, { historyMode: 'push', returnFocus: secondaryBtn })) return;
        navigateToCase(caseId);
      });
    }
    if (eligible && caseId) {
      if (primaryBtn) {
        primaryBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          navigateToCase(caseId);
        });
      }
    }

    container.appendChild(node);
  });
}

function mapActiveCasesToAssignments(activeCases = []) {
  return activeCases
    .map((caseItem) => {
      const caseId = getCaseId(caseItem);
      if (!caseId) return null;
      return {
        caseId,
        title: caseItem.jobTitle || caseItem.title || 'Matter',
        attorney: caseItem.attorneyName || '',
        due: caseItem.deadline
          ? formatMatterDeadline(caseItem.deadlineDate || caseItem.deadline)
          : caseItem.dueDate
            ? new Date(caseItem.dueDate).toLocaleDateString()
            : caseItem.createdAt
              ? new Date(caseItem.createdAt).toLocaleDateString()
              : '',
        status: caseItem.status || '',
        summary: caseItem.practiceArea ? `Practice area: ${caseItem.practiceArea}` : '',
        escrowStatus: caseItem.escrowStatus || null,
        escrowIntentId: caseItem.escrowIntentId || null,
        archived: caseItem.archived,
        paymentReleased: caseItem.paymentReleased,
        paralegalId: caseItem.paralegalId || caseItem.paralegal || null,
      };
    })
    .filter(Boolean);
}

async function loadInvites() {
  try {
    const res = await secureFetch('/api/cases/invited-to', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Unable to load invites');
    const payload = await res.json().catch(() => ({}));
    return Array.isArray(payload?.items) ? payload.items : [];
  } catch (error) {
    console.warn('Unable to load invites', error);
    return [];
  }
}


function findInviteByCaseId(caseId = '') {
  const target = String(caseId || '').trim();
  if (!target) return null;
  return (recentActivityState.invites || []).find(
    (invite) => String(invite?.id || invite?._id || '') === target
  ) || null;
}

function setInviteQuery(caseId) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('inviteCase');
    if (caseId) {
      url.searchParams.set('inviteCase', caseId);
    }
    if (!url.hash) {
      url.hash = '#home';
    }
    window.history.replaceState({}, '', url.toString());
  } catch {}
}

function clearInviteQuery() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('inviteCase');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

function buildRecentActivityEntries({ invites = [], threads = [], deadlines = [] } = {}) {
  const entries = [];

  invites.forEach((invite) => {
    const inviteId = invite?.id || invite?._id;
    if (!inviteId) return;
    const inviteStatus = String(invite?.inviteStatus || '').toLowerCase();
    if (inviteStatus && inviteStatus !== 'pending') return;
    const invitedAt = invite.inviteInvitedAt || invite.pendingParalegalInvitedAt || invite.createdAt || null;
    const timestamp = invitedAt ? new Date(invitedAt).getTime() : 0;
    const attorneyName =
      invite.attorney?.name ||
      [invite.attorney?.firstName, invite.attorney?.lastName].filter(Boolean).join(' ').trim() ||
      '';
    const title = invite.title || 'Matter invitation';
    entries.push({
      type: 'invite',
      caseId: String(inviteId),
      timestamp,
      title,
      meta: ['Invitation received', attorneyName].filter(Boolean).join(' · '),
      time: formatActivityDate(invitedAt),
      href: `dashboard-paralegal.html?inviteCase=${encodeURIComponent(inviteId)}#home`,
    });
  });

  (Array.isArray(threads) ? threads : []).forEach((thread) => {
    const caseId = thread?.caseId || thread?.case?.id || thread?.id || '';
    const timestamp = getThreadTimestamp(thread);
    entries.push({
      type: 'message',
      caseId: String(caseId),
      timestamp,
      title: thread?.title || 'Matter thread',
      meta: thread?.lastMessageSnippet || 'New message',
      time: formatActivityDate(timestamp),
      href: caseId ? `case-detail.html?caseId=${encodeURIComponent(caseId)}` : '',
    });
  });

  (Array.isArray(deadlines) ? deadlines : []).forEach((event) => {
    const start = event?.start;
    if (!start) return;
    const timestamp = new Date(start).getTime();
    const caseId = event?.caseId || '';
    const dueLabel = formatActivityDate(start);
    entries.push({
      type: 'deadline',
      caseId: String(caseId),
      timestamp,
      title: event?.title || 'Upcoming deadline',
      meta: event?.where || 'Deadline reminder',
      time: dueLabel ? `Due ${dueLabel}` : '',
      href: caseId ? `case-detail.html?caseId=${encodeURIComponent(caseId)}` : '',
    });
  });

  return entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 3);
}

function renderRecentActivity({ invites = [], threads = [], deadlines = [] } = {}) {
  const container = selectors.recentActivityList;
  if (!container) return;

  recentActivityState.invites = invites;
  recentActivityState.threads = threads;
  recentActivityState.deadlines = deadlines;

  const entries = buildRecentActivityEntries({ invites, threads, deadlines });
  const subtitle = entries.length ? 'Latest updates from your Matters.' : 'No recent activity yet.';
  const card = document.createElement('div');
  card.className = `case-card activity-card${entries.length ? '' : ' empty-state'}`;
  card.innerHTML = `
    <div class="case-header">
      <div>
        <h2>Recent activity</h2>
        <div class="case-subinfo">${escapeHtml(subtitle)}</div>
      </div>
    </div>
  `;

  if (entries.length) {
    const list = document.createElement('ul');
    list.className = 'activity-list';
    entries.forEach((entry) => {
      const item = document.createElement('li');
      item.className = 'activity-item';
      const time = entry.time ? `<div class="activity-time">${escapeHtml(entry.time)}</div>` : '';
      const title = entry.href
        ? `<a class="activity-link" href="${escapeHtml(entry.href)}"${
            entry.type === 'invite' ? ` data-invite-case-id="${escapeHtml(entry.caseId || '')}"` : ''
          }>${escapeHtml(entry.title)}</a>`
        : escapeHtml(entry.title);
      item.innerHTML = `
        <div class="activity-row">
          <div class="activity-title">${title}</div>
          ${time}
        </div>
        <div class="activity-meta">${escapeHtml(entry.meta)}</div>
      `;
      list.appendChild(item);
    });
    card.appendChild(list);
  }

  container.innerHTML = '';
  container.appendChild(card);

  container.querySelectorAll('.activity-link').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.stopPropagation();
      const caseId = String(link.getAttribute('data-invite-case-id') || '').trim();
      if (!caseId) return;
      const invite = findInviteByCaseId(caseId);
      if (!invite) return;
      event.preventDefault();
      setInviteQuery(caseId);
      openInviteOverlay(invite);
    });
  });
}

let inviteResponseInFlight = false;

async function respondToInvite(caseId, action, button) {
  if (!caseId || !action || inviteResponseInFlight) return;
  if (action === "accept" && !stripeConnected) {
    notifyStripeGate();
    return;
  }
  const endpoint = `/api/cases/${encodeURIComponent(caseId)}/invite/${action}`;
  const originalLabel = button?.textContent;
  const siblingButton = action === "accept" ? selectors.inviteDeclineBtn : selectors.inviteAcceptBtn;
  const siblingOriginalDisabled = !!siblingButton?.disabled;
  inviteResponseInFlight = true;
  if (button) {
    button.disabled = true;
    button.textContent = action === 'accept' ? 'Accepting…' : 'Declining…';
  }
  if (siblingButton) siblingButton.disabled = true;
  const toastHelper = window.toastUtils;
  let completed = false;
  try {
    const res = await secureFetch(endpoint, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || 'Unable to update invitation');
    const message = action === 'accept' ? 'Invitation accepted.' : 'Invitation declined.';
    toastHelper?.show?.(message, { targetId: selectors.toastBanner?.id, type: 'success' });
    completed = true;
    if (action === 'accept') {
      recentActivityState.invites = recentActivityState.invites.filter(
        (invite) => String(invite?.id || invite?._id || '') !== String(caseId)
      );
      renderRecentActivity({
        invites: recentActivityState.invites,
        threads: recentActivityState.threads,
        deadlines: recentActivityState.deadlines,
      });
      if (typeof window.refreshNotificationCenters === 'function') {
        window.refreshNotificationCenters();
      }
      const nextInvite = {
        ...(activeInvite || findInviteByCaseId(caseId) || {}),
        id: caseId,
        _id: caseId,
        inviteStatus: 'accepted',
      };
      openInviteOverlay(nextInvite);
      return;
    }
    // Optimistically remove the invite card and close the overlay
    if (action === 'decline') {
      recentActivityState.invites = recentActivityState.invites.filter(
        (invite) => String(invite?.id || invite?._id || '') !== String(caseId)
      );
    }
    closeInviteOverlay();
    const invites = await loadInvites();
    renderRecentActivity({
      invites,
      threads: recentActivityState.threads,
      deadlines: recentActivityState.deadlines,
    });
    // Refresh notification bell to reflect the decline notice
    if (typeof window.refreshNotificationCenters === 'function') {
      window.refreshNotificationCenters();
    }
  } catch (error) {
    toastHelper?.show?.(error.message || 'Unable to update invitation.', {
      targetId: selectors.toastBanner?.id,
      type: 'error',
    });
  } finally {
    inviteResponseInFlight = false;
    if (button && !completed) {
      button.disabled = false;
      button.textContent = originalLabel || (action === 'accept' ? 'Accept' : 'Decline');
    }
    if (siblingButton && !completed) {
      siblingButton.disabled = siblingOriginalDisabled;
    }
  }
}

async function revokeAcceptedInvite(caseId, button) {
  if (!caseId || inviteResponseInFlight) return;
  const originalLabel = button?.textContent || 'Revoke application';
  inviteResponseInFlight = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Revoking…';
  }
  const toastHelper = window.toastUtils;
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/invite/revoke`, { method: 'POST' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || 'Unable to revoke this application.');
    recentActivityState.invites = recentActivityState.invites.filter(
      (invite) => String(invite?.id || invite?._id || '') !== String(caseId)
    );
    renderRecentActivity({
      invites: recentActivityState.invites,
      threads: recentActivityState.threads,
      deadlines: recentActivityState.deadlines,
    });
    if (typeof window.refreshNotificationCenters === 'function') {
      window.refreshNotificationCenters();
    }
    closeInviteOverlay();
    toastHelper?.show?.('Application revoked.', { targetId: selectors.toastBanner?.id, type: 'success' });
  } catch (error) {
    toastHelper?.show?.(error.message || 'Unable to revoke this application.', {
      targetId: selectors.toastBanner?.id,
      type: 'error',
    });
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  } finally {
    inviteResponseInFlight = false;
  }
}

function attachUIHandlers() {
  const toastHelper = window.toastUtils;
  const stagedToast = toastHelper?.consume?.();
  if (stagedToast?.message && selectors.toastBanner) {
    toastHelper.show(stagedToast.message, { targetId: selectors.toastBanner.id, type: stagedToast.type });
  }
  earningsMode = readEarningsMode();
  renderEarningsDisplay();

  if (selectors.inviteCloseBtn) {
    selectors.inviteCloseBtn.addEventListener('click', closeInviteOverlay);
  }
  if (selectors.inviteOverlay) {
    selectors.inviteOverlay.addEventListener('click', (event) => {
      if (event.target === selectors.inviteOverlay) closeInviteOverlay();
    });
  }
  if (selectors.inviteAcceptBtn) {
    selectors.inviteAcceptBtn.addEventListener('click', () => {
      const caseId = selectors.inviteAcceptBtn.dataset.caseId;
      respondToInvite(caseId, 'accept', selectors.inviteAcceptBtn);
    });
  }
  if (selectors.inviteDeclineBtn) {
    selectors.inviteDeclineBtn.addEventListener('click', () => {
      const caseId = selectors.inviteDeclineBtn.dataset.caseId;
      const action = String(selectors.inviteDeclineBtn.dataset.inviteAction || 'decline').toLowerCase();
      if (action === 'revoke') {
        openRevokeConfirmModal(async () => {
          closeRevokeConfirmModal();
          await revokeAcceptedInvite(caseId, selectors.inviteDeclineBtn);
        });
        return;
      }
      respondToInvite(caseId, 'decline', selectors.inviteDeclineBtn);
    });
  }
  selectors.revokeConfirmClose?.addEventListener('click', closeRevokeConfirmModal);
  selectors.revokeConfirmCancel?.addEventListener('click', closeRevokeConfirmModal);
  selectors.revokeConfirmSubmit?.addEventListener('click', async () => {
    const action = pendingRevokeAction;
    if (!action) {
      closeRevokeConfirmModal();
      return;
    }
    await action();
  });
  selectors.revokeConfirmModal?.addEventListener('click', (event) => {
    if (event.target === selectors.revokeConfirmModal) {
      closeRevokeConfirmModal();
    }
  });
  if (selectors.messageBox) {
    selectors.messageBox.addEventListener('click', () => {
      if (unreadMessageCount < 1) return;
      const caseId = latestMessageThread?.id || latestMessageThread?._id || '';
      if (!caseId) return;
      window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}&tab=messages`;
    });
  }
  if (selectors.earningsToggle) {
    selectors.earningsToggle.addEventListener('click', toggleEarningsMode);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selectors.inviteOverlay?.classList.contains('show')) {
      closeInviteOverlay();
    }
    if (event.key === 'Escape' && !selectors.revokeConfirmModal?.classList.contains('hidden')) {
      closeRevokeConfirmModal();
    }
  });
}

let activeInvite = null;
let pendingRevokeAction = null;
let inviteReturnFocus = null;

function closeRevokeConfirmModal() {
  const modal = selectors.revokeConfirmModal;
  modal?.classList.add('hidden');
  modal?.setAttribute('aria-hidden', 'true');
  modal?.setAttribute('inert', '');
  if (applicationModal && !applicationModal.classList.contains('hidden')) {
    applicationModal.removeAttribute('inert');
  }
  if (selectors.inviteOverlay?.classList.contains('show')) {
    selectors.inviteOverlay.removeAttribute('inert');
  }
  deactivateDialogFocus(modal);
  if (applicationModal && !applicationModal.classList.contains('hidden')) {
    activateDialogFocus(applicationModal, {
      initialFocus: applicationModal.querySelector('[data-application-revoke]'),
      returnFocus: applicationReturnFocus,
      onEscape: closeApplicationModal,
    });
  } else if (selectors.inviteOverlay?.classList.contains('show')) {
    activateDialogFocus(selectors.inviteOverlay, {
      initialFocus: selectors.inviteDeclineBtn,
      returnFocus: inviteReturnFocus,
      onEscape: closeInviteOverlay,
    });
  }
  pendingRevokeAction = null;
}

function openRevokeConfirmModal(onConfirm) {
  pendingRevokeAction = typeof onConfirm === 'function' ? onConfirm : null;
  const modal = selectors.revokeConfirmModal;
  if (!modal) return;
  if (applicationModal && !applicationModal.classList.contains('hidden')) {
    deactivateDialogFocus(applicationModal, { restoreFocus: false });
    applicationModal.setAttribute('inert', '');
  }
  if (selectors.inviteOverlay?.classList.contains('show')) {
    deactivateDialogFocus(selectors.inviteOverlay, { restoreFocus: false });
    selectors.inviteOverlay.setAttribute('inert', '');
  }
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  modal.removeAttribute('inert');
  activateDialogFocus(modal, {
    initialFocus: selectors.revokeConfirmCancel,
    onEscape: closeRevokeConfirmModal,
  });
}

function openInviteOverlay(invite) {
  activeInvite = invite || null;
  const {
    inviteOverlay,
    inviteCaseTitle,
    inviteJobTitle,
    inviteLead,
    inviteMeta,
    inviteDetails,
    inviteAttorneyAvatar,
    inviteAttorneyName,
    inviteAttorneyFirm,
    inviteAttorneyLink,
    inviteAcceptBtn,
    inviteDeclineBtn,
  } = selectors;
  const inviteActions = inviteOverlay?.querySelector('.actions');
  if (!inviteOverlay) return;
  const title = invite?.title || 'Matter Invitation';
  const attorneyName =
    invite?.attorney?.name ||
    [invite?.attorney?.firstName, invite?.attorney?.lastName].filter(Boolean).join(' ').trim() ||
    'Attorney';
  const practice = invite?.practiceArea || 'General matter';
  const numericBudget =
    typeof invite?.lockedTotalAmount === 'number'
      ? invite.lockedTotalAmount
      : typeof invite?.totalAmount === 'number'
      ? invite.totalAmount
      : Number.NaN;
  const pay =
    (Number.isFinite(numericBudget) && `${formatCaseCompensation(numericBudget)}`) ||
    invite?.compensationDisplay ||
    invite?.payDisplay ||
    invite?.compensation ||
    invite?.rate ||
    '';
  const postedOn = invite?.createdAt ? new Date(invite.createdAt).toLocaleDateString() : '';
  const inviteDateValue = invite?.inviteInvitedAt || invite?.pendingParalegalInvitedAt;
  const invitedAt = inviteDateValue
    ? `Invited ${new Date(inviteDateValue).toLocaleDateString()}`
    : '';
  const brief =
    invite?.briefSummary ||
    invite?.description ||
    invite?.details ||
    invite?.summary ||
    invite?.caseDescription ||
    '';
  const tasks = Array.isArray(invite?.tasks)
    ? invite.tasks
        .map((task) => escapeHtml(task?.title || '').trim())
        .filter(Boolean)
    : [];
  const inviteStatus = String(invite?.inviteStatus || '').toLowerCase();
  const isAccepted = inviteStatus === 'accepted';

  if (inviteCaseTitle) inviteCaseTitle.textContent = isAccepted ? 'Await attorney action' : "You've been invited to a Matter";
  if (inviteJobTitle) inviteJobTitle.textContent = title;
  if (inviteLead) {
    inviteLead.textContent = isAccepted
      ? 'You accepted this invitation. The attorney must confirm hire and fund the Matter next.'
      : '';
  }
  if (inviteMeta) {
    const metaPieces = [
      practice ? `<span class="pill">${escapeHtml(practice)}</span>` : '',
      invite?.state || invite?.locationState || invite?.location
        ? `<span class="pill">${escapeHtml(invite.state || invite.locationState || invite.location)}</span>`
        : '',
      pay ? `<span class="pill">${escapeHtml(pay)}</span>` : '',
      invitedAt
        ? `<span class="pill">${escapeHtml(invitedAt)}</span>`
        : postedOn
          ? `<span class="pill">${escapeHtml(postedOn)}</span>`
          : '',
    ].filter(Boolean);
    inviteMeta.innerHTML = metaPieces.join('');
  }
  if (inviteDetails) {
    const detailParts = [];
    if (brief) {
      detailParts.push(`<p>${escapeHtml(brief)}</p>`);
    }
    if (tasks.length) {
      detailParts.push(`
        <div class="invite-task-block">
          <div class="invite-task-label">Required Tasks</div>
          <ul class="invite-task-list">
            ${tasks.map((task) => `<li>${task}</li>`).join('')}
          </ul>
        </div>
      `);
    }
    inviteDetails.innerHTML = detailParts.join('') || '<p>No Matter description was provided.</p>';
  }
  if (inviteAttorneyName) inviteAttorneyName.textContent = attorneyName;
  if (inviteAttorneyFirm) inviteAttorneyFirm.textContent = invite?.attorney?.firm || invite?.attorney?.lawFirm || '';
  const attorneyId = deriveAttorneyId(invite);
  if (inviteAttorneyLink) {
    if (attorneyId) {
      inviteAttorneyLink.href = `profile-attorney.html?id=${encodeURIComponent(attorneyId)}`;
      inviteAttorneyLink.removeAttribute('aria-disabled');
    } else {
      inviteAttorneyLink.removeAttribute('href');
      inviteAttorneyLink.setAttribute('aria-disabled', 'true');
    }
  }
  if (inviteAttorneyAvatar) {
    inviteAttorneyAvatar.src = getAvatarUrl(invite?.attorney || {});
    inviteAttorneyAvatar.alt = `${attorneyName} avatar`;
    inviteAttorneyAvatar.style.display = "block";
  }
  const caseId = invite?.id || invite?._id || '';
  if (inviteAcceptBtn) {
    inviteAcceptBtn.dataset.caseId = caseId;
    inviteAcceptBtn.dataset.stripeApply = "true";
    inviteAcceptBtn.hidden = false;
    inviteAcceptBtn.textContent = isAccepted ? 'Accepted' : 'Accept Invitation';
    inviteAcceptBtn.disabled = isAccepted || !caseId || !stripeConnected;
    if (!isAccepted && !stripeConnected) {
      inviteAcceptBtn.title = STRIPE_GATE_MESSAGE;
    } else {
      inviteAcceptBtn.removeAttribute("title");
    }
  }
  if (inviteDeclineBtn) {
    inviteDeclineBtn.dataset.caseId = caseId;
    inviteDeclineBtn.dataset.inviteAction = isAccepted ? 'revoke' : 'decline';
    inviteDeclineBtn.textContent = isAccepted ? 'Revoke application' : 'Decline';
    inviteDeclineBtn.disabled = !caseId;
  }
  inviteActions?.classList.toggle('is-accepted', isAccepted);

  setInviteQuery(caseId);
  inviteReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  inviteOverlay.classList.add('show');
  inviteOverlay.setAttribute('aria-hidden', 'false');
  inviteOverlay.removeAttribute('inert');
  activateDialogFocus(inviteOverlay, {
    initialFocus: isAccepted ? inviteDeclineBtn : inviteAcceptBtn,
    returnFocus: inviteReturnFocus,
    onEscape: closeInviteOverlay,
  });
}

function closeInviteOverlay() {
  selectors.inviteOverlay?.classList.remove('show');
  selectors.inviteOverlay?.setAttribute('aria-hidden', 'true');
  selectors.inviteOverlay?.setAttribute('inert', '');
  deactivateDialogFocus(selectors.inviteOverlay);
  inviteReturnFocus = null;
  activeInvite = null;
  clearInviteQuery();
}

let inviteQueryHandled = false;
function maybeOpenInviteFromQuery() {
  if (inviteQueryHandled) return;
  const currentHash = String(window.location.hash || '').trim();
  if (currentHash && currentHash !== '#home') return;
  let caseId = '';
  try {
    const params = new URLSearchParams(window.location.search);
    caseId = (params.get('inviteCase') || '').trim();
  } catch {
    caseId = '';
  }
  if (!caseId) return;
  const invite = findInviteByCaseId(caseId);
  if (!invite) return;
  inviteQueryHandled = true;
  openInviteOverlay(invite);
}

function getStoredUserSnapshot() {
  if (typeof window.getStoredUser === "function") {
    const stored = window.getStoredUser();
    if (stored && typeof stored.isFirstLogin === "boolean") return stored;
  }
  try {
    const raw = localStorage.getItem("lpc_user");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let onboardingState = null;
let onboardingPromise = null;

function normalizeOnboarding(raw = {}) {
  return {
    paralegalTourCompleted: Boolean(raw?.paralegalTourCompleted),
    paralegalProfileTourCompleted: Boolean(raw?.paralegalProfileTourCompleted),
  };
}

function getCachedOnboarding(user) {
  if (user?.onboarding && typeof user.onboarding === "object") {
    onboardingState = normalizeOnboarding(user.onboarding);
    return onboardingState;
  }
  return onboardingState || normalizeOnboarding({});
}

async function loadOnboardingState(user) {
  if (user?.onboarding && typeof user.onboarding === "object") {
    onboardingState = normalizeOnboarding(user.onboarding);
    return onboardingState;
  }
  if (onboardingState) return onboardingState;
  if (onboardingPromise) return onboardingPromise;
  onboardingPromise = (async () => {
    try {
      const res = await secureFetch("/api/users/me/onboarding", {
        headers: { Accept: "application/json" },
        suppressToast: true,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || "Unable to load onboarding state.");
      onboardingState = normalizeOnboarding(payload.onboarding || {});
      return onboardingState;
    } catch (err) {
      console.warn("Unable to load onboarding state", err);
      onboardingState = normalizeOnboarding({});
      return onboardingState;
    } finally {
      onboardingPromise = null;
    }
  })();
  return onboardingPromise;
}

async function updateOnboardingState(updates = {}, { markFirstLoginComplete = false } = {}) {
  try {
    const res = await secureFetch("/api/users/me/onboarding", {
      method: "PATCH",
      headers: { Accept: "application/json" },
      body: updates,
      suppressToast: true,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || "Unable to update onboarding state.");
    onboardingState = normalizeOnboarding(payload.onboarding || {});
    if (typeof window.updateSessionUser === "function") {
      const nextUser = { onboarding: onboardingState };
      if (markFirstLoginComplete) nextUser.isFirstLogin = false;
      window.updateSessionUser(nextUser);
    }
    return onboardingState;
  } catch (err) {
    console.warn("Unable to update onboarding state", err);
    return getCachedOnboarding({});
  }
}


function markTourCompleted() {
  void updateOnboardingState({ paralegalTourCompleted: true }, { markFirstLoginComplete: true });
}

function updateWelcomeGreeting() {
  const greetingEl = selectors.welcomeGreeting;
  if (!greetingEl) return;
  greetingEl.textContent = "Welcome";
}

let tourInitialized = false;
let paralegalTourApi = null;

function consumeReplayFlag() {
  let replay = false;
  try {
    if (sessionStorage.getItem("lpc_paralegal_replay_tour") === "1") {
      replay = true;
      sessionStorage.removeItem("lpc_paralegal_replay_tour");
    }
  } catch (_) {}
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("replayTour") === "1") {
      replay = true;
      params.delete("replayTour");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", next);
    }
  } catch (_) {}
  return replay;
}

async function initParalegalTour(user, options = {}) {
  const force = Boolean(options.force);
  if (paralegalTourApi) {
    if (force) paralegalTourApi.start();
    return;
  }
  if (tourInitialized) return;
  tourInitialized = true;

  const overlay = document.getElementById("paralegalTourOverlay");
  const modal = document.getElementById("paralegalTourModal");
  const tooltip = document.getElementById("profileTourTooltip");
  const startBtn = document.getElementById("startTourBtn");
  const closeBtn = document.getElementById("tourCloseBtn");
  const tooltipCloseBtn = document.getElementById("tourTooltipCloseBtn");
  const backBtn = document.getElementById("tourBackBtn");
  const nextBtn = document.getElementById("tourNextBtn");
  const profileLink = document.getElementById("profileSettingsLink");
  const sidebarToggle = document.getElementById("sidebarToggle");
  const sidebarNav = document.getElementById("sidebarNav");
  let sidebarOpenedByTour = false;

  if (!overlay || !modal || !tooltip || !profileLink) return;

  const stored = getStoredUserSnapshot();
  const effectiveUser = user || stored || {};
  const role = String(effectiveUser?.role || "").toLowerCase();
  const status = String(effectiveUser?.status || "").toLowerCase();
  const storedFlag = stored?.isFirstLogin;
  const userFlag = effectiveUser?.isFirstLogin;
  const isFirstLogin = typeof storedFlag === "boolean" ? storedFlag : Boolean(userFlag);
  const onboarding = await loadOnboardingState(effectiveUser);
  const shouldShow =
    role === "paralegal" &&
    (!status || status === "approved") &&
    (force || isFirstLogin) &&
    (force || !onboarding?.paralegalTourCompleted);
  if (!shouldShow) return;
  if (!force) markTourCompleted();

  const showOverlay = () => {
    overlay.classList.add("is-active");
    overlay.setAttribute("aria-hidden", "false");
    profileLink.classList.add("tour-highlight");
  };

  const setSidebarOpen = (open) => {
    document.body.classList.toggle("nav-open", Boolean(open));
    if (sidebarToggle) sidebarToggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const isMobileSidebarMode = () => window.matchMedia("(max-width: 1024px)").matches;

  const ensureSidebarVisibleForTarget = (target) => {
    if (!target || !sidebarNav) {
      if (sidebarOpenedByTour) {
        setSidebarOpen(false);
        sidebarOpenedByTour = false;
      }
      return;
    }
    const isSidebarTarget = sidebarNav.contains(target);
    if (isMobileSidebarMode() && isSidebarTarget) {
      const alreadyOpen = document.body.classList.contains("nav-open");
      if (!alreadyOpen) sidebarOpenedByTour = true;
      setSidebarOpen(true);
      return;
    }
    if (sidebarOpenedByTour) {
      setSidebarOpen(false);
      sidebarOpenedByTour = false;
    }
  };

  const hideOverlay = () => {
    ensureSidebarVisibleForTarget(null);
    overlay.classList.remove("is-active", "spotlight");
    overlay.setAttribute("aria-hidden", "true");
    modal.classList.remove("is-active");
    modal.setAttribute("aria-hidden", "true");
    modal.setAttribute("inert", "");
    tooltip.classList.remove("is-active");
    tooltip.setAttribute("aria-hidden", "true");
    tooltip.setAttribute("inert", "");
    deactivateDialogFocus(modal, { restoreFocus: false });
    deactivateDialogFocus(tooltip, { restoreFocus: false });
    profileLink.classList.remove("tour-highlight");
  };

  const positionTooltip = () => {
    const rect = profileLink.getBoundingClientRect();
    tooltip.classList.add("is-active");
    const tipRect = tooltip.getBoundingClientRect();
    const top = Math.max(12, Math.min(window.innerHeight - tipRect.height - 12, rect.top + rect.height / 2 - tipRect.height / 2));
    const left = Math.min(window.innerWidth - tipRect.width - 12, rect.right + 16);
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    const arrowTop = Math.max(16, Math.min(tipRect.height - 20, rect.top + rect.height / 2 - top - 8));
    tooltip.style.setProperty("--arrow-top", `${arrowTop}px`);
  };

  const showIntro = () => {
    showOverlay();
    ensureSidebarVisibleForTarget(null);
    overlay.classList.remove("spotlight");
    modal.classList.add("is-active");
    modal.setAttribute("aria-hidden", "false");
    modal.removeAttribute("inert");
    tooltip.classList.remove("is-active");
    tooltip.setAttribute("aria-hidden", "true");
    tooltip.setAttribute("inert", "");
    deactivateDialogFocus(tooltip, { restoreFocus: false });
    activateDialogFocus(modal, {
      initialFocus: startBtn || closeBtn,
      onEscape: completeTour,
    });
  };

  const showProfileStep = () => {
    showOverlay();
    ensureSidebarVisibleForTarget(profileLink);
    modal.classList.remove("is-active");
    modal.setAttribute("aria-hidden", "true");
    modal.setAttribute("inert", "");
    deactivateDialogFocus(modal, { restoreFocus: false });
    overlay.classList.add("spotlight");
    tooltip.setAttribute("aria-hidden", "false");
    tooltip.removeAttribute("inert");
    const positionProfileStep = () => {
      const rect = profileLink.getBoundingClientRect();
      const padding = 10;
      overlay.style.setProperty("--spot-x", `${rect.left - padding}px`);
      overlay.style.setProperty("--spot-y", `${rect.top - padding}px`);
      overlay.style.setProperty("--spot-w", `${rect.width + padding * 2}px`);
      overlay.style.setProperty("--spot-h", `${rect.height + padding * 2}px`);
      positionTooltip();
    };
    // Keep spotlight aligned while the mobile sidebar animates into view.
    const start = performance.now();
    const sync = () => {
      if (!overlay.classList.contains("is-active") || !overlay.classList.contains("spotlight")) return;
      positionProfileStep();
      if (performance.now() - start < 380) {
        requestAnimationFrame(sync);
      }
    };
    requestAnimationFrame(sync);
    activateDialogFocus(tooltip, {
      initialFocus: nextBtn || tooltipCloseBtn,
      onEscape: completeTour,
    });
  };

  const completeTour = () => {
    tooltip.classList.remove("is-active");
    hideOverlay();
    profileLink.focus();
    updateWelcomeGreeting();
  };

  const buildProfileTourUrl = (href = "profile-settings.html") => {
    try {
      const url = new URL(href, window.location.href);
      url.searchParams.set("tour", "1");
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return "profile-settings.html?tour=1";
    }
  };

  startBtn?.addEventListener("click", showProfileStep);
  closeBtn?.addEventListener("click", completeTour);
  tooltipCloseBtn?.addEventListener("click", completeTour);
  backBtn?.addEventListener("click", showIntro);
  nextBtn?.addEventListener("click", () => {
    completeTour();
    window.location.href = buildProfileTourUrl(profileLink.getAttribute("href") || "profile-settings.html");
  });
  profileLink.addEventListener("click", (event) => {
    if (overlay.classList.contains("is-active")) {
      event.preventDefault();
      completeTour();
      window.location.href = buildProfileTourUrl(profileLink.getAttribute("href") || "profile-settings.html");
    }
  });
  window.addEventListener("resize", () => {
    if (overlay.classList.contains("is-active") && tooltip.classList.contains("is-active")) {
      showProfileStep();
    }
  });

  paralegalTourApi = {
    start: showIntro,
    showProfile: showProfileStep,
    complete: completeTour,
  };

  showIntro();
}

function updateProfile(profile = {}) {
  const composedName =
    [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || profile.name || 'Paralegal';
  const firstName =
    String(profile.firstName || '')
      .trim() ||
    String(profile.name || composedName)
      .trim()
      .split(/\s+/)[0] ||
    'Paralegal';
  setField('name', firstName);
  updateWelcomeGreeting();
  const avatarUrl = getAvatarUrl(profile);
  document.querySelectorAll('[data-avatar]').forEach((node) => {
    node.src = avatarUrl;
    node.alt = `${composedName}'s avatar`;
  });
  const a = document.querySelector('#user-avatar');
  if (a) a.src = avatarUrl;
  updatePendingApprovalBanner(profile);
  syncAvailabilityProfile(profile);
}

function availabilityDateOnly(value) {
  if (!value) return "";
  const direct = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(direct)) return "";
  const parsed = new Date(`${direct}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === direct ? direct : "";
}

function syncAvailabilityProfile(profile = {}) {
  const details = profile?.availabilityDetails || {};
  const status =
    String(details.status || "").toLowerCase() === "unavailable" ||
    /unavailable/i.test(String(profile?.availability || ""))
      ? "unavailable"
      : "available";
  const nextAvailableDate = status === "unavailable" ? availabilityDateOnly(details.nextAvailable) : "";
  const statusDisplay = document.getElementById("availabilityStatus");
  const nextDisplay = document.getElementById("availabilityNext");
  if (statusDisplay) {
    statusDisplay.dataset.value = status;
    statusDisplay.textContent = status === "available" ? "Available now" : "Not available";
  }
  if (nextDisplay) {
    nextDisplay.dataset.date = nextAvailableDate;
    const friendly = formatAvailabilityDate(nextAvailableDate);
    nextDisplay.textContent = friendly ? `Available on ${friendly}` : status === "unavailable" ? "No return date set" : "";
  }
}

function persistAvailabilityState(availabilityText, details = {}) {
  try {
    const user = window.getStoredUser?.();
    if (!user || typeof user !== 'object') return;
    const updatedUser = {
      ...user,
      ...(availabilityText ? { availability: availabilityText } : {}),
      availabilityDetails: details,
    };
    window.updateSessionUser?.(updatedUser);
    window.hydrateParalegalCluster?.(updatedUser);
  } catch (err) {
    console.warn('Unable to persist availability', err);
  }
}

function formatAvailabilityDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function handleStoredUserUpdate(event) {
  if (event.key !== 'lpc_user') return;
  if (!event.newValue) return updateProfile({});
  try {
    const profile = JSON.parse(event.newValue);
    updateProfile(profile || {});
  } catch {
    updateProfile({});
  }
}

window.addEventListener('storage', handleStoredUserUpdate);
window.addEventListener('lpc:user-updated', (event) => {
  if (event?.detail) {
    updateProfile(event.detail);
  }
});

function getThreadTimestamp(thread = {}) {
  const raw = thread.updatedAt || thread.lastMessageAt || thread.createdAt || null;
  if (!raw) return 0;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function selectLatestThread(threads = []) {
  return threads.reduce((latest, current) => {
    if (!latest) return current;
    return getThreadTimestamp(current) > getThreadTimestamp(latest) ? current : latest;
  }, null);
}

function initLatestMessage(threads = []) {
  if (!threads.length) {
    latestMessageThread = null;
    setField('latestMessageName', 'Inbox');
    setField('latestMessageExcerpt', 'No new messages.');
    return;
  }
  const latest = selectLatestThread(threads);
  latestMessageThread = latest || null;
  setField('latestMessageName', latest?.title || 'Matter thread');
  setField('latestMessageExcerpt', latest?.lastMessageSnippet || 'No new messages.');
}

function initQuickActions() {
  document.querySelectorAll('.quick-actions [data-action]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const action = button.dataset.action;
      if (action === 'browse') {
        if (button.tagName !== 'A') {
          event.preventDefault();
          window.location.href = 'browse-jobs.html';
        }
        return;
      }
    });
  });
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatMatterDeadline(value) {
  return window.LPCBusinessDate?.format(value) || formatDate(value);
}

function formatActivityDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const isSameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (isSameDay) return 'Today';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMultiline(value) {
  if (!value) return '';
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function getApplicationPreEngagement(app) {
  const pre = app?.preEngagement;
  if (!pre || typeof pre !== 'object') return null;
  const status = String(pre.status || '').trim().toLowerCase();
  if (!['requested', 'submitted', 'changes_requested'].includes(status)) return null;
  return {
    status,
    requestedParalegalId: String(pre.requestedParalegalId || ''),
    confidentialityAgreementRequired: !!pre.confidentialityAgreementRequired,
    conflictsCheckRequired: !!pre.conflictsCheckRequired,
    conflictsDetails: String(pre.conflictsDetails || ''),
    confidentialityDocument: pre.confidentialityDocument || null,
    paralegalConfidentialityDocument: pre.paralegalConfidentialityDocument || null,
    requestedAt: pre.requestedAt || null,
    requestedBy: String(pre.requestedBy || ''),
    requestedByName: String(pre.requestedByName || ''),
    confidentialityAcknowledged: !!pre.confidentialityAcknowledged,
    confidentialityAcknowledgedAt: pre.confidentialityAcknowledgedAt || null,
    conflictsResponseType: String(pre.conflictsResponseType || '').trim().toLowerCase(),
    conflictsDisclosureText: String(pre.conflictsDisclosureText || ''),
    submittedAt: pre.submittedAt || null,
    submittedBy: String(pre.submittedBy || ''),
    reviewedAt: pre.reviewedAt || null,
    reviewedBy: String(pre.reviewedBy || ''),
  };
}

function getApplicationPreEngagementAttorneyName(app, pre) {
  return (
    String(pre?.requestedByName || '').trim() ||
    String(app?.jobId?.attorneyId?.name || app?.job?.attorneyId?.name || '').trim() ||
    [app?.jobId?.attorneyId?.firstName, app?.jobId?.attorneyId?.lastName].filter(Boolean).join(' ').trim() ||
    [app?.job?.attorneyId?.firstName, app?.job?.attorneyId?.lastName].filter(Boolean).join(' ').trim()
  );
}

function createApplicationPreEngagementDraft(app) {
  const pre = getApplicationPreEngagement(app);
  if (!pre || pre.status === 'submitted') return null;
  return {
    confidentialityAcknowledged: !!pre.confidentialityAcknowledged,
    signedConfidentialityFile: null,
    signedConfidentialityFileName: String(pre.paralegalConfidentialityDocument?.name || ''),
    conflictsResponseType: pre.conflictsCheckRequired ? pre.conflictsResponseType || '' : '',
    conflictsDisclosureText: pre.conflictsDisclosureText || '',
  };
}

function isApplicationPreEngagementValid(pre, draft) {
  if (!pre) return true;
  if (pre.status === 'submitted') return true;
  if (pre.confidentialityAgreementRequired && !draft?.confidentialityAcknowledged) return false;
  if (pre.conflictsCheckRequired) {
    if (!['none_known', 'disclosure'].includes(String(draft?.conflictsResponseType || ''))) return false;
    if (
      String(draft?.conflictsResponseType || '') === 'disclosure' &&
      !String(draft?.conflictsDisclosureText || '').trim()
    ) {
      return false;
    }
  }
  return true;
}

function getApplicationPreEngagementCompletion(pre, draft = {}) {
  const confidentialityComplete =
    !pre?.confidentialityAgreementRequired ||
    (pre.status === 'submitted'
      ? !!pre.confidentialityAcknowledged
      : !!draft?.confidentialityAcknowledged);
  const conflictsResponseType =
    pre?.status === 'submitted'
      ? String(pre.conflictsResponseType || '')
      : String(draft?.conflictsResponseType || '');
  const conflictsDisclosureText =
    pre?.status === 'submitted'
      ? String(pre.conflictsDisclosureText || '')
      : String(draft?.conflictsDisclosureText || '');
  const conflictsComplete =
    !pre?.conflictsCheckRequired ||
    (['none_known', 'disclosure'].includes(conflictsResponseType) &&
      (conflictsResponseType !== 'disclosure' || Boolean(conflictsDisclosureText.trim())));
  return {
    confidentiality: confidentialityComplete,
    conflicts: conflictsComplete,
  };
}

function getApplicationPreEngagementCards(pre, draft = {}) {
  if (!pre) return [];
  const completion = getApplicationPreEngagementCompletion(pre, draft);
  const cards = [];
  if (pre.confidentialityAgreementRequired) {
    cards.push({
      key: 'confidentiality',
      title: 'Confidentiality Agreement',
      stepLabel: 'Step 1',
      complete: completion.confidentiality,
    });
  }
  if (pre.conflictsCheckRequired) {
    cards.push({
      key: 'conflicts',
      title: 'Conflicts Check',
      stepLabel: pre.confidentialityAgreementRequired ? 'Step 2' : 'Step 1',
      complete: completion.conflicts,
    });
  }
  return cards;
}

function resolveDefaultPreEngagementExpandedKey(pre, draft = {}) {
  const cards = getApplicationPreEngagementCards(pre, draft);
  if (!cards.length) return '';
  const firstIncomplete = cards.find((card) => !card.complete);
  return firstIncomplete?.key || cards[0].key;
}

function resolveApplicationPreEngagementExpandedKey(pre, draft = {}) {
  const cards = getApplicationPreEngagementCards(pre, draft);
  if (!cards.length) return '';
  if (cards.some((card) => card.key === applicationPreEngagementExpandedKey)) {
    return applicationPreEngagementExpandedKey;
  }
  return resolveDefaultPreEngagementExpandedKey(pre, draft);
}

function buildApplicationPreEngagementSection(app) {
  const pre = getApplicationPreEngagement(app);
  if (!pre) return '';
  const requestedAt = pre.requestedAt ? formatDate(pre.requestedAt) : 'Recently';
  const requestedByName = getApplicationPreEngagementAttorneyName(app, pre);
  const isSubmitted = pre.status === 'submitted';
  const isChangesRequested = pre.status === 'changes_requested';
  const draft = applicationPreEngagementDraft || createApplicationPreEngagementDraft(app) || {};
  const submitDisabled = !isApplicationPreEngagementValid(pre, draft);
  const showDisclosure = pre.conflictsCheckRequired && draft.conflictsResponseType === 'disclosure';
  const doc = pre.confidentialityDocument || null;
  const docName = escapeHtml(doc?.name || 'Confidentiality agreement');
  const signedDoc = pre.paralegalConfidentialityDocument || null;
  const signedDocName = escapeHtml(
    draft.signedConfidentialityFileName || signedDoc?.name || 'No file selected'
  );
  const cards = getApplicationPreEngagementCards(pre, draft);
  const expandedKey = resolveApplicationPreEngagementExpandedKey(pre, draft);

  const confidentialityCard = pre.confidentialityAgreementRequired
    ? `
      <article class="application-preengagement-card ${
        cards.find((card) => card.key === 'confidentiality')?.complete ? 'is-complete' : ''
      } ${expandedKey === 'confidentiality' ? 'is-expanded' : ''}">
        <button
          type="button"
          class="application-preengagement-card-toggle"
          data-preengagement-card-toggle="confidentiality"
          aria-expanded="${expandedKey === 'confidentiality' ? 'true' : 'false'}"
        >
          <div class="application-preengagement-card-main">
            <div class="application-preengagement-card-copy">
              <div class="application-preengagement-item-title">Confidentiality Agreement</div>
            </div>
          </div>
          <div class="application-preengagement-card-status ${
            cards.find((card) => card.key === 'confidentiality')?.complete ? 'is-complete' : ''
          }">
            <span class="application-preengagement-card-check" aria-hidden="true">${
              cards.find((card) => card.key === 'confidentiality')?.complete ? '&#10003;' : ''
            }</span>
            <span>${
              cards.find((card) => card.key === 'confidentiality')?.complete ? 'Complete' : 'Required'
            }</span>
          </div>
        </button>
        <div class="application-preengagement-card-body" ${expandedKey === 'confidentiality' ? '' : 'hidden'}>
          ${isSubmitted ? `
            <div class="application-preengagement-summary">
              Acknowledged${pre.confidentialityAcknowledgedAt ? ` on ${escapeHtml(formatDate(pre.confidentialityAcknowledgedAt))}` : ''}.
              ${signedDoc?.name ? `<div style="margin-top:8px;"><strong>Signed agreement uploaded:</strong> ${escapeHtml(signedDoc.name)}</div>` : ''}
            </div>
          ` : `
            <div class="application-preengagement-doc">
              <div class="application-preengagement-doc-copy">
                <strong>${docName}</strong>
              </div>
              ${doc?.key && app?.caseId ? `
                <button type="button" class="btn secondary application-preengagement-action-btn" data-preengagement-review-document>Review document</button>
              ` : ''}
            </div>
            <label class="application-preengagement-check">
              <input type="checkbox" data-preengagement-acknowledge ${draft.confidentialityAcknowledged ? 'checked' : ''} />
              <span>I reviewed and acknowledge this confidentiality agreement.</span>
            </label>
            <div class="application-preengagement-optional">
              <div class="application-preengagement-doc application-preengagement-doc-upload">
                <div class="application-preengagement-doc-copy">
                  <strong>${signedDocName}</strong>
                  <div class="application-preengagement-doc-sub">Only upload a signed version if the attorney needs a returned copy.</div>
                </div>
                <label class="btn secondary application-preengagement-action-btn application-preengagement-upload-trigger">
                  <input type="file" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg" data-preengagement-signed-file hidden />
                  Upload signed file
                </label>
              </div>
            </div>
          `}
        </div>
      </article>
    `
    : '';

  const conflictsCard = pre.conflictsCheckRequired
    ? `
      <article class="application-preengagement-card ${
        cards.find((card) => card.key === 'conflicts')?.complete ? 'is-complete' : ''
      } ${expandedKey === 'conflicts' ? 'is-expanded' : ''}">
        <button
          type="button"
          class="application-preengagement-card-toggle"
          data-preengagement-card-toggle="conflicts"
          aria-expanded="${expandedKey === 'conflicts' ? 'true' : 'false'}"
        >
          <div class="application-preengagement-card-main">
            <div class="application-preengagement-card-copy">
              <div class="application-preengagement-item-title">Conflicts Check</div>
            </div>
          </div>
          <div class="application-preengagement-card-status ${
            cards.find((card) => card.key === 'conflicts')?.complete ? 'is-complete' : ''
          }">
            <span class="application-preengagement-card-check" aria-hidden="true">${
              cards.find((card) => card.key === 'conflicts')?.complete ? '&#10003;' : ''
            }</span>
            <span>${
              cards.find((card) => card.key === 'conflicts')?.complete ? 'Complete' : 'Required'
            }</span>
          </div>
        </button>
        <div class="application-preengagement-card-body" ${expandedKey === 'conflicts' ? '' : 'hidden'}>
          ${isSubmitted ? `
            <div class="application-preengagement-summary">
              <strong>Response:</strong>
              ${pre.conflictsResponseType === 'disclosure' ? 'Disclosed a possible conflict' : 'No known conflict'}
              ${pre.conflictsResponseType === 'disclosure' && pre.conflictsDisclosureText
                ? `<div style="margin-top:8px;">${formatMultiline(pre.conflictsDisclosureText)}</div>`
                : ''}
            </div>
          ` : `
            <div class="application-preengagement-instructions">${formatMultiline(pre.conflictsDetails) || 'No conflicts details provided.'}</div>
            <div class="application-preengagement-response">
              <div class="application-preengagement-response-label">Your response</div>
              <div class="application-preengagement-choices">
                <label class="application-preengagement-choice">
                  <input type="radio" name="preengagement-conflicts" value="none_known" data-preengagement-conflicts ${draft.conflictsResponseType === 'none_known' ? 'checked' : ''} />
                  <span>No known conflict</span>
                </label>
                <label class="application-preengagement-choice">
                  <input type="radio" name="preengagement-conflicts" value="disclosure" data-preengagement-conflicts ${draft.conflictsResponseType === 'disclosure' ? 'checked' : ''} />
                  <span>Disclose a possible conflict</span>
                </label>
              </div>
              <div ${showDisclosure ? '' : 'hidden'}>
                <textarea
                  rows="4"
                  placeholder="Describe the possible conflict for the attorney to review."
                  data-preengagement-disclosure
                >${escapeHtml(draft.conflictsDisclosureText || '')}</textarea>
                ${showDisclosure && !String(draft.conflictsDisclosureText || '').trim()
                  ? '<div class="application-preengagement-help">Enter disclosure details to continue.</div>'
                  : ''}
              </div>
            </div>
          `}
        </div>
      </article>
    `
    : '';

  return `
    <section class="application-preengagement">
      <h4>Pre-Engagement</h4>
      <div class="application-preengagement-meta">
        <span class="application-preengagement-status">${
          isChangesRequested && pre.reviewedAt
            ? `Changes requested ${escapeHtml(formatDate(pre.reviewedAt))}${requestedByName ? ` by ${escapeHtml(requestedByName)}` : ''}`
            : `Requested ${escapeHtml(requestedAt)}${requestedByName ? ` by ${escapeHtml(requestedByName)}` : ''}`
        }</span>
      </div>
      <div class="application-preengagement-card-list">
        ${confidentialityCard}
        ${conflictsCard}
      </div>
      ${isSubmitted ? `
        <div class="application-preengagement-actions">
          <span class="application-preengagement-status">Submitted${pre.submittedAt ? ` on ${escapeHtml(formatDate(pre.submittedAt))}` : ''}.</span>
        </div>
      ` : `
        <div class="application-preengagement-actions">
          <button type="button" class="btn primary application-preengagement-submit-btn" data-preengagement-submit ${submitDisabled ? 'disabled' : ''}>Submit to attorney</button>
        </div>
      `}
    </section>
  `;
}

function buildApplicationDetail(app) {
  if (!app) {
    return '<p class="muted">Application not found.</p>';
  }
  const job = app.jobId || app.job || {};
  const browseMatterId = getCaseId(app) || getCaseId(job);
  const browseMatterHref = browseMatterId
    ? `browse-jobs.html?caseId=${encodeURIComponent(browseMatterId)}`
    : '';
  const title = escapeHtml(job.title || app.caseTitle || 'Matter');
  const practice = escapeHtml(job.practiceArea || 'General practice');
  const description = escapeHtml(job.description || '');
  const budgetValue = Number(job.budget);
  const budget = job.compensationDisplay || job.payDisplay || (Number.isFinite(budgetValue) ? formatCurrency(budgetValue) : '');
  const status = formatApplicationStatus(getApplicationStatusKey(app));
  const appliedAt = app.createdAt ? formatDate(app.createdAt) : 'Recently';
  const cover = formatMultiline(app.coverLetter || '');

  return `
    <div class="detail-row">
      <span class="detail-label">Matter</span>
      <span class="detail-value">${title}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Practice area</span>
      <span class="detail-value">${practice}</span>
    </div>
    ${description ? `
      <div class="detail-row">
        <span class="detail-label">Summary</span>
        <span class="detail-value">${description}</span>
      </div>
    ` : ''}
    ${budget ? `
      <div class="detail-row">
        <span class="detail-label">Budget</span>
        <span class="detail-value">${budget}</span>
      </div>
    ` : ''}
    <div class="detail-row">
      <span class="detail-label">Status</span>
      <span class="detail-value">${escapeHtml(status)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Applied on</span>
      <span class="detail-value">${escapeHtml(appliedAt)}</span>
    </div>
    <div class="application-cover">
      <strong>Cover message</strong>
      <p>${cover || 'No cover message available.'}</p>
    </div>
    ${browseMatterHref ? `
      <div class="application-detail-actions">
        <a class="card-link" href="${escapeHtml(browseMatterHref)}">View Matter posting</a>
      </div>
    ` : ''}
    ${buildApplicationPreEngagementSection(app)}
  `;
}

function renderActiveApplicationModal() {
  if (!applicationDetail) return;
  applicationDetail.innerHTML = buildApplicationDetail(activeApplication);
  bindApplicationPreEngagementActions();
}

function updateActiveApplicationInCache(updatedApp = {}) {
  const activeId = String(updatedApp?._id || updatedApp?.id || '');
  if (!activeId) return;
  appliedAppsCache = appliedAppsCache.map((entry) => {
    const entryId = String(entry?._id || entry?.id || '');
    return entryId === activeId ? { ...entry, ...updatedApp } : entry;
  });
}

async function reviewApplicationPreEngagementDocument(app) {
  const pre = getApplicationPreEngagement(app);
  const caseId = String(app?.caseId || '');
  const key = String(pre?.confidentialityDocument?.key || '');
  if (!caseId || !key) return;
  const toastHelper = window.toastUtils;
  try {
    const params = new URLSearchParams({ caseId, key });
    const res = await secureFetch(`/api/uploads/signed-get?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      noRedirect: true,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.url) {
      throw new Error(payload?.error || 'Unable to open this document.');
    }
    const documentUrl = normalizeHttpNavigationUrl(payload.url);
    if (!documentUrl) throw new Error('The document destination is invalid.');
    window.open(documentUrl, '_blank', 'noopener');
  } catch (error) {
    toastHelper?.show?.(error.message || 'Unable to open this document.', {
      targetId: selectors.toastBanner?.id,
      type: 'error',
    });
  }
}

async function submitApplicationPreEngagement(app, button) {
  const pre = getApplicationPreEngagement(app);
  const caseId = String(app?.caseId || '');
  if (!pre || pre.status === 'submitted' || !caseId) return;
  const draft = applicationPreEngagementDraft || createApplicationPreEngagementDraft(app) || {};
  if (!isApplicationPreEngagementValid(pre, draft)) {
    renderActiveApplicationModal();
    return;
  }
  const toastHelper = window.toastUtils;
  const originalLabel = button?.textContent || 'Submit pre-engagement';
  if (button) {
    button.disabled = true;
    button.textContent = 'Submitting...';
  }
  try {
    const formData = new FormData();
    formData.set('confidentialityAcknowledged', draft.confidentialityAcknowledged ? 'true' : 'false');
    formData.set('conflictsResponseType', draft.conflictsResponseType || '');
    formData.set('conflictsDisclosureText', draft.conflictsDisclosureText || '');
    if (draft.signedConfidentialityFile) {
      formData.set(
        'paralegalConfidentialityFile',
        draft.signedConfidentialityFile,
        draft.signedConfidentialityFileName || draft.signedConfidentialityFile.name || 'signed-confidentiality'
      );
    }
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/pre-engagement/respond`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: formData,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || 'Unable to submit pre-engagement.');
    const updatedApp = {
      ...app,
      preEngagement: payload?.preEngagement || pre,
    };
    activeApplication = updatedApp;
    applicationPreEngagementDraft = createApplicationPreEngagementDraft(updatedApp);
    updateActiveApplicationInCache(updatedApp);
    renderActiveApplicationModal();
    applyAppliedFilters({ resetPage: false });
    toastHelper?.show?.(pre?.status === 'changes_requested' ? 'Pre-engagement resubmitted.' : 'Pre-engagement submitted.', {
      targetId: selectors.toastBanner?.id,
      type: 'success',
    });
  } catch (error) {
    toastHelper?.show?.(error.message || 'Unable to submit pre-engagement.', {
      targetId: selectors.toastBanner?.id,
      type: 'error',
    });
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

function bindApplicationPreEngagementActions() {
  if (!applicationDetail || !activeApplication) return;
  const pre = getApplicationPreEngagement(activeApplication);
  if (!pre) return;

  applicationDetail.querySelectorAll('[data-preengagement-card-toggle]').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const key = String(toggle.dataset.preengagementCardToggle || '');
      if (!key) return;
      applicationPreEngagementExpandedKey =
        applicationPreEngagementExpandedKey === key ? '' : key;
      renderActiveApplicationModal();
    });
  });

  const reviewBtn = applicationDetail.querySelector('[data-preengagement-review-document]');
  reviewBtn?.addEventListener('click', () => {
    reviewApplicationPreEngagementDocument(activeApplication);
  });

  const acknowledge = applicationDetail.querySelector('[data-preengagement-acknowledge]');
  acknowledge?.addEventListener('change', (event) => {
    applicationPreEngagementDraft = {
      ...(applicationPreEngagementDraft || createApplicationPreEngagementDraft(activeApplication) || {}),
      confidentialityAcknowledged: !!event.target.checked,
    };
    renderActiveApplicationModal();
  });

  const signedFileInput = applicationDetail.querySelector('[data-preengagement-signed-file]');
  signedFileInput?.addEventListener('change', (event) => {
    const file = event.target?.files?.[0] || null;
    applicationPreEngagementDraft = {
      ...(applicationPreEngagementDraft || createApplicationPreEngagementDraft(activeApplication) || {}),
      signedConfidentialityFile: file,
      signedConfidentialityFileName: file?.name || '',
    };
    renderActiveApplicationModal();
  });

  applicationDetail.querySelectorAll('[data-preengagement-conflicts]').forEach((input) => {
    input.addEventListener('change', (event) => {
      const value = String(event.target.value || '');
      applicationPreEngagementDraft = {
        ...(applicationPreEngagementDraft || createApplicationPreEngagementDraft(activeApplication) || {}),
        conflictsResponseType: value,
        conflictsDisclosureText:
          value === 'disclosure'
            ? String(applicationPreEngagementDraft?.conflictsDisclosureText || '')
            : '',
      };
      renderActiveApplicationModal();
    });
  });

  const disclosure = applicationDetail.querySelector('[data-preengagement-disclosure]');
  disclosure?.addEventListener('input', (event) => {
    applicationPreEngagementDraft = {
      ...(applicationPreEngagementDraft || createApplicationPreEngagementDraft(activeApplication) || {}),
      conflictsDisclosureText: String(event.target.value || ''),
    };
    const submitButton = applicationDetail.querySelector('[data-preengagement-submit]');
    if (submitButton) {
      submitButton.disabled = !isApplicationPreEngagementValid(pre, applicationPreEngagementDraft);
    }
  });

  const submitBtn = applicationDetail.querySelector('[data-preengagement-submit]');
  submitBtn?.addEventListener('click', async () => {
    await submitApplicationPreEngagement(activeApplication, submitBtn);
  });
}

function findAppliedApplication(applicationId, jobId) {
  const appId = String(applicationId || '');
  const jobKey = String(jobId || '');
  return appliedAppsCache.find((app) => {
    if (isRejectedApplication(app)) return false;
    const id = String(app._id || app.id || '');
    if (appId && id === appId) return true;
    if (!jobKey) return false;
    const appJobId = String(app.jobId?._id || app.jobId || '');
    return appJobId === jobKey;
  });
}

async function revokeApplication(app, button) {
  const appId = app?._id || app?.id || '';
  if (!appId) return;
  const toastHelper = window.toastUtils;
  const originalLabel = button?.textContent || 'Revoke application';
  if (button) {
    button.disabled = true;
    button.textContent = 'Revoking…';
  }
  try {
    const res = await secureFetch(`/api/applications/${encodeURIComponent(appId)}/revoke`, {
      method: 'POST',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || 'Unable to revoke this application.');
    appliedAppsCache = appliedAppsCache.filter((entry) => String(entry?._id || entry?.id || '') !== String(appId));
    populateAppliedFilterOptions(appliedAppsCache);
    applyAppliedFilters();
    closeApplicationModal();
    toastHelper?.show?.('Application revoked.', { targetId: selectors.toastBanner?.id, type: 'success' });
  } catch (error) {
    toastHelper?.show?.(error.message || 'Unable to revoke this application.', {
      targetId: selectors.toastBanner?.id,
      type: 'error',
    });
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

function isApplicationFunded(app) {
  const job = app?.jobId || app?.job || {};
  if (app?.casePaymentReleased === true || job?.paymentReleased === true) return true;
  return String(app?.caseEscrowStatus || job?.escrowStatus || '').toLowerCase() === 'funded';
}

function isApplicationRevocable(app) {
  const hasId = Boolean(app?._id || app?.id);
  const isInviteAcceptedEntry = String(app?.applicationSource || '').toLowerCase() === 'invite_accept' && !!app?.caseId;
  const jobStatus = String(app?.jobId?.status || '').toLowerCase();
  if (isApplicationFunded(app)) return false;
  if (jobStatus && jobStatus !== 'open' && !isInviteAcceptedEntry) return false;
  return hasId || isInviteAcceptedEntry;
}

function setApplicationQuery(appId, jobId) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('applicationId');
    url.searchParams.delete('appId');
    url.searchParams.delete('jobId');
    if (appId) {
      url.searchParams.set('applicationId', appId);
    } else if (jobId) {
      url.searchParams.set('jobId', jobId);
    }
    if (url.hash !== '#cases') {
      url.hash = '#cases';
    }
    window.history.replaceState({}, '', url.toString());
  } catch {}
}

function clearApplicationQuery() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('applicationId');
    url.searchParams.delete('appId');
    url.searchParams.delete('jobId');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}

function getAppliedHighlightTarget() {
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      applicationId: (params.get('highlightApplicationId') || params.get('applicationId') || params.get('appId') || '').trim(),
      jobId: (params.get('highlightJobId') || params.get('jobId') || '').trim(),
    };
  } catch {
    return { applicationId: '', jobId: '' };
  }
}

function openApplicationModal(app) {
  if (!applicationModal || !applicationDetail) return;
  if (window.location.hash !== '#cases') return;
  if (!isActiveApplication(app)) {
    closeApplicationModal();
    return;
  }
  activeApplication = app || null;
  applicationPreEngagementDraft = createApplicationPreEngagementDraft(app);
  applicationPreEngagementExpandedKey = resolveDefaultPreEngagementExpandedKey(
    getApplicationPreEngagement(app),
    applicationPreEngagementDraft || {}
  );
  const revokeBtn = applicationModal.querySelector('[data-application-revoke]');
  if (revokeBtn) {
    const disabled = !isApplicationRevocable(app);
    revokeBtn.disabled = disabled;
    revokeBtn.textContent = disabled ? 'Revoke unavailable' : 'Revoke application';
  }
  renderActiveApplicationModal();
  applicationReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  applicationModal.classList.remove('hidden');
  applicationModal.setAttribute('aria-hidden', 'false');
  applicationModal.removeAttribute('inert');
  activateDialogFocus(applicationModal, {
    initialFocus: applicationModal.querySelector('[data-application-close]'),
    returnFocus: applicationReturnFocus,
    onEscape: closeApplicationModal,
  });
}

function closeApplicationModal() {
  if (!applicationModal) return;
  applicationModal.classList.add('hidden');
  applicationModal.setAttribute('aria-hidden', 'true');
  applicationModal.setAttribute('inert', '');
  deactivateDialogFocus(applicationModal);
  applicationReturnFocus = null;
  activeApplication = null;
  applicationPreEngagementDraft = null;
  applicationPreEngagementExpandedKey = '';
  clearApplicationQuery();
}

function bindApplicationModal() {
  if (!applicationModal || applicationModalBound) return;
  applicationModalBound = true;
  applicationModal.querySelectorAll('[data-application-close]').forEach((btn) => {
    btn.addEventListener('click', closeApplicationModal);
  });
  const revokeBtn = applicationModal.querySelector('[data-application-revoke]');
  if (revokeBtn) {
    revokeBtn.addEventListener('click', async () => {
      if (!activeApplication) return;
      openRevokeConfirmModal(async () => {
        if (String(activeApplication?.applicationSource || '').toLowerCase() === 'invite_accept' && activeApplication?.caseId) {
          const caseId = String(activeApplication.caseId || '');
          closeRevokeConfirmModal();
          await revokeAcceptedInvite(activeApplication.caseId, revokeBtn);
          closeApplicationModal();
          appliedAppsCache = appliedAppsCache.filter((entry) => String(entry?.caseId || '') !== caseId);
          populateAppliedFilterOptions(appliedAppsCache);
          applyAppliedFilters();
          return;
        }
        closeRevokeConfirmModal();
        await revokeApplication(activeApplication, revokeBtn);
      });
    });
  }
  applicationModal.addEventListener('click', (event) => {
    if (event.target === applicationModal) {
      closeApplicationModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !applicationModal.classList.contains('hidden')) {
      closeApplicationModal();
    }
  });
  window.addEventListener('hashchange', () => {
    if (window.location.hash !== '#cases') {
      closeApplicationModal();
    }
  });
}

function bindAppliedPreviewActions() {
  if (appliedPreviewBound) return;
  const container = document.getElementById('appliedJobsList');
  if (!container) return;
  appliedPreviewBound = true;
  container.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-application-view]');
    if (!trigger || !applicationModal || !applicationDetail) return;
    event.preventDefault();
    const appId = trigger.dataset.applicationId || '';
    const jobId = trigger.dataset.jobId || '';
    const match = findAppliedApplication(appId, jobId);
    setApplicationQuery(appId, jobId);
    openApplicationModal(match);
  });
}

function maybeOpenApplicationFromQuery() {
  if (appliedQueryHandled) return;
  if (window.location.hash !== '#cases') return;
  if (!applicationModal || !applicationDetail) return;
  const params = new URLSearchParams(window.location.search);
  const applicationId = (params.get('applicationId') || params.get('appId') || '').trim();
  const jobId = (params.get('jobId') || '').trim();
  if (!applicationId && !jobId) return;
  appliedQueryHandled = true;
  const match = findAppliedApplication(applicationId, jobId);
  openApplicationModal(match);
}

async function loadAppliedJobs({ preservePage = false } = {}) {
  const container = document.getElementById('appliedJobsList');
  if (!container) return;
  container.innerHTML = '';
  bindApplicationModal();
  bindAppliedPreviewActions();
  const loading = document.createElement('div');
  loading.className = 'case-card';
  loading.innerHTML = '<div class="case-header"><div><h2>Loading applications…</h2></div></div>';
  container.appendChild(loading);

  try {
    const res = await secureFetch('/api/applications/my', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => []);
    const apps = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : [];
    const visibleApps = apps.filter((app) => isActiveApplication(app));
    appliedAppsCache = visibleApps;
    paralegalPrioritySnapshot.applications = visibleApps;
    appliedPage = preservePage ? appliedPage : 1;
    bindAppliedFilters();
    populateAppliedFilterOptions(visibleApps);
    applyAppliedFilters({ resetPage: false });
    renderParalegalPriorityQueue();
    maybeOpenApplicationFromQuery();
  } catch (err) {
    console.error('Failed to load applied jobs', err);
    container.innerHTML = `
      <div class="case-card empty-state">
        <div class="case-header">
          <div>
            <h2>Unable to load applications</h2>
            <div class="case-subinfo">Your current view is preserved. Try loading the applications again.</div>
            <button type="button" class="completed-page-btn" data-applications-retry>Retry</button>
          </div>
        </div>
      </div>`;
    container.querySelector('[data-applications-retry]')?.addEventListener('click', () => {
      void loadAppliedJobs({ preservePage: true });
    });
    updateAppliedPagination({ total: 0 });
    maybeOpenApplicationFromQuery();
  }
}

function bindAppliedFilters() {
  if (appliedFiltersBound) return;
  const { toggle, panel, search, status, practice, dateRange, sort } = appliedFilters;
  if (!search || !practice || !dateRange) return;
  appliedFiltersBound = true;

  if (toggle && panel && !appliedFilterToggleBound) {
    appliedFilterToggleBound = true;

    const setOpen = (open) => {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Hide application filters' : 'Show application filters');
    };

    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      setOpen(open);
    });

    document.addEventListener('click', (event) => {
      if (panel.hidden) return;
      if (panel.contains(event.target) || toggle.contains(event.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  search.addEventListener('input', () => {
    applicationSavedViews?.markCustom();
    applyAppliedFilters({ resetPage: true });
  });
  if (status) {
    status.addEventListener('change', () => {
      applicationSavedViews?.markCustom();
      applyAppliedFilters({ resetPage: true });
    });
  }
  practice.addEventListener('change', () => {
    applicationSavedViews?.markCustom();
    applyAppliedFilters({ resetPage: true });
  });
  dateRange.addEventListener('change', () => {
    applicationSavedViews?.markCustom();
    applyAppliedFilters({ resetPage: true });
  });
  sort?.addEventListener('change', () => {
    applicationSavedViews?.markCustom();
    applyAppliedFilters({ resetPage: true });
  });
  if (appliedPagination.prev) {
    appliedPagination.prev.addEventListener('click', () => {
      if (appliedPage > 1) {
        appliedPage -= 1;
        applyAppliedFilters({ resetPage: false });
      }
    });
  }
  if (appliedPagination.next) {
    appliedPagination.next.addEventListener('click', () => {
      if (appliedPage < appliedTotalPages) {
        appliedPage += 1;
        applyAppliedFilters({ resetPage: false });
      }
    });
  }

  applicationSavedViews = mountDashboardSavedViews({
    scope: 'paralegal_applications',
    picker: '[data-application-saved-view]',
    saveButton: '[data-application-save-view]',
    deleteButton: '[data-application-delete-view]',
    status: '[data-application-saved-view-status]',
    builtIns: [
      { id: 'recent', name: 'Recent applications', filters: { search: '', status: 'all', practice: 'all', dateRange: '30', sort: 'newest' } },
      { id: 'all', name: 'All applications', filters: { search: '', status: 'all', practice: 'all', dateRange: 'all', sort: 'newest' } },
      { id: 'oldest', name: 'Waiting longest', filters: { search: '', status: 'all', practice: 'all', dateRange: 'all', sort: 'oldest' } },
    ],
    getState: () => ({
      search: String(search.value || ''),
      status: String(status?.value || 'all'),
      practice: String(practice.value || 'all'),
      dateRange: String(dateRange.value || 'all'),
      sort: String(sort?.value || 'newest'),
    }),
    applyState: (filters = {}) => {
      search.value = String(filters.search || '');
      if (status) status.value = String(filters.status || 'all');
      practice.value = String(filters.practice || 'all');
      dateRange.value = String(filters.dateRange || 'all');
      if (sort) sort.value = String(filters.sort || 'newest');
      applyAppliedFilters({ resetPage: true });
    },
  });
}

function populateAppliedFilterOptions(apps = []) {
  const { status, practice } = appliedFilters;
  if (!status && !practice) return;

  const currentStatus = status?.value || 'all';
  const currentPractice = practice?.value || 'all';

  const statusValues = new Set();
  const practiceValues = new Set();
  apps.forEach((app) => {
    const normalizedStatus = getApplicationStatusKey(app);
    if (normalizedStatus && normalizedStatus !== 'rejected') {
      statusValues.add(normalizedStatus);
    }
    const job = app.jobId || {};
    const area = String(job.practiceArea || '').trim();
    if (area) practiceValues.add(area);
  });

  const statusOptions = Array.from(statusValues).filter(Boolean).sort();
  const practiceOptions = Array.from(practiceValues).sort((a, b) => a.localeCompare(b));

  if (status) {
    status.innerHTML = `<option value="all">All statuses</option>` +
      statusOptions.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(formatApplicationStatus(value))}</option>`).join('');
    if (statusOptions.includes(currentStatus)) status.value = currentStatus;
  }
  if (practice) {
    practice.innerHTML = `<option value="all">All practice areas</option>` +
      practiceOptions.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    if (practiceOptions.includes(currentPractice)) practice.value = currentPractice;
  }
}

function applyAppliedFilters({ resetPage = false } = {}) {
  const container = document.getElementById('appliedJobsList');
  if (!container) return;
  if (resetPage) appliedPage = 1;

  const { search, status, practice, dateRange, sort } = appliedFilters;
  const query = String(search?.value || '').trim().toLowerCase();
  const statusFilter = String(status?.value || 'all');
  const practiceFilter = String(practice?.value || 'all');
  const rangeFilter = String(dateRange ? dateRange.value : 'all');

  let filtered = appliedAppsCache.filter((app) => isActiveApplication(app));

  if (query) {
    filtered = filtered.filter((app) => {
      const job = app.jobId || {};
      const title = String(job.title || '').toLowerCase();
      const area = String(job.practiceArea || '').toLowerCase();
      return title.includes(query) || area.includes(query);
    });
  }

  if (statusFilter !== 'all') {
    filtered = filtered.filter((app) => getApplicationStatusKey(app) === statusFilter);
  }

  if (practiceFilter !== 'all') {
    filtered = filtered.filter((app) => {
      const job = app.jobId || {};
      return String(job.practiceArea || '') === practiceFilter;
    });
  }

  if (rangeFilter !== 'all') {
    const days = Number(rangeFilter);
    if (Number.isFinite(days)) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      filtered = filtered.filter((app) => {
        const createdAt = new Date(app.createdAt || 0).getTime();
        return Number.isFinite(createdAt) && createdAt >= cutoff;
      });
    }
  }

  const sortMode = String(sort?.value || 'newest');
  filtered.sort((a, b) => {
    if (sortMode === 'oldest') return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    if (sortMode === 'matter') {
      return String(a?.jobId?.title || '').localeCompare(String(b?.jobId?.title || ''));
    }
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });

  const highlightTarget = getAppliedHighlightTarget();
  if (!appliedHighlightHandled && (highlightTarget.applicationId || highlightTarget.jobId)) {
    const matchIndex = filtered.findIndex((app) => {
      const appId = String(app?._id || app?.id || '');
      const jobId = String(app?.jobId?._id || app?.jobId || '');
      if (highlightTarget.applicationId && appId) {
        return appId === highlightTarget.applicationId;
      }
      if (highlightTarget.jobId && jobId) {
        return jobId === highlightTarget.jobId;
      }
      return false;
    });
    if (matchIndex >= 0) {
      appliedPage = Math.floor(matchIndex / APPLIED_PAGE_SIZE) + 1;
      appliedHighlightHandled = true;
    }
  }

  const total = filtered.length;
  appliedTotalPages = total ? Math.ceil(total / APPLIED_PAGE_SIZE) : 1;
  if (appliedPage > appliedTotalPages) appliedPage = appliedTotalPages;
  if (appliedPage < 1) appliedPage = 1;
  const startIndex = total ? (appliedPage - 1) * APPLIED_PAGE_SIZE : 0;
  const endIndex = total ? Math.min(startIndex + APPLIED_PAGE_SIZE, total) : 0;
  const limited = filtered.slice(startIndex, endIndex);
  renderAppliedJobs(container, limited, total, { startIndex, endIndex });
}

function renderAppliedJobs(container, apps, total, { startIndex = 0, endIndex = 0 } = {}) {
  if (!appliedAppsCache.length) {
    container.innerHTML = `
      <div class="case-card empty-state">
        <div class="case-header">
          <div>
            <h2>No applications yet</h2>
            <div class="case-subinfo">Matters you apply to will appear here.</div>
          </div>
        </div>
      </div>`;
    updateAppliedPagination({ total: 0 });
    return;
  }

  if (!total) {
    container.innerHTML = `
      <div class="case-card empty-state">
        <div class="case-header">
          <div>
            <h2>No matching applications</h2>
            <div class="case-subinfo">Try adjusting your search or filters.</div>
          </div>
        </div>
      </div>`;
    updateAppliedPagination({ total: 0 });
    return;
  }

  const highlightTarget = getAppliedHighlightTarget();
  const highlightAppId = highlightTarget.applicationId;
  const highlightJobId = highlightTarget.jobId;
  let shouldScroll = false;

  container.innerHTML = apps
    .map((app) => {
      const job = app.jobId || {};
      const title = escapeHtml(job.title || 'Untitled Matter');
      const practice = escapeHtml(job.practiceArea || 'General practice');
      const when = app.createdAt
        ? new Date(app.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
        : 'Recently';
      const pre = getApplicationPreEngagement(app);
      const applicationId = app._id || app.id || '';
      const jobId = job._id || job.id || app.jobId || '';
      const appIdValue = String(applicationId || '');
      const jobIdValue = String(jobId || '');
      const isHighlighted =
        (highlightAppId && appIdValue && highlightAppId === appIdValue) ||
        (!highlightAppId && highlightJobId && jobIdValue && highlightJobId === jobIdValue);
      if (isHighlighted) shouldScroll = true;
      const href = applicationId
        ? `dashboard-paralegal.html?applicationId=${encodeURIComponent(applicationId)}#cases`
        : jobId
          ? `dashboard-paralegal.html?jobId=${encodeURIComponent(jobId)}#cases`
          : 'dashboard-paralegal.html#cases';
      return `
        <div class="case-card applied-card${isHighlighted ? ' is-highlighted' : ''}">
          <div class="case-header">
            <div>
              <h2>${title}</h2>
              <div class="case-subinfo">${practice}</div>
              <div class="case-subinfo">Applied on ${when}</div>
            </div>
            <div class="case-actions">
              <a class="card-link" href="${href}" data-application-view data-application-id="${escapeHtml(applicationId)}" data-job-id="${escapeHtml(jobId)}">${escapeHtml(['requested', 'changes_requested'].includes(pre?.status) ? 'Complete pre-engagement →' : 'View →')}</a>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  if (shouldScroll) {
    requestAnimationFrame(() => {
      const highlighted = container.querySelector('.applied-card.is-highlighted');
      if (highlighted) {
        highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  updateAppliedPagination({ total, startIndex, endIndex });
}

function updateAppliedPagination({ total = 0, startIndex = 0, endIndex = 0 } = {}) {
  const { count } = appliedFilters;
  if (count) {
    if (!total) {
      count.textContent = '';
    } else {
      const displayEnd = Math.max(startIndex + 1, endIndex);
      count.textContent = `Showing ${startIndex + 1}-${displayEnd} of ${total}`;
    }
  }

  const hidePagination = total <= APPLIED_PAGE_SIZE;
  if (appliedPagination.info) {
    appliedPagination.info.hidden = hidePagination;
    appliedPagination.info.textContent = total ? `Page ${appliedPage} of ${appliedTotalPages}` : '';
  }
  if (appliedPagination.prev) {
    appliedPagination.prev.hidden = hidePagination;
    appliedPagination.prev.disabled = appliedPage <= 1;
  }
  if (appliedPagination.next) {
    appliedPagination.next.hidden = hidePagination;
    appliedPagination.next.disabled = appliedPage >= appliedTotalPages;
  }
}

function normalizeApplicationStatus(value) {
  const raw = String(value || 'submitted').trim().toLowerCase();
  return raw.replace(/\s+/g, '_');
}

function getApplicationStatusKey(app) {
  return normalizeApplicationStatus(
    app?.status ||
      app?.applicationStatus ||
      app?.application_status ||
      app?.state ||
      app?.applicationState ||
      ''
  );
}

function hasApplicationJob(app) {
  const job = app?.jobId || app?.job || null;
  if (!job || typeof job !== 'object') return false;
  return Boolean(job._id || job.id || job.title);
}

function isRejectedApplication(app) {
  return getApplicationStatusKey(app) === 'rejected';
}

function isActiveApplication(app) {
  if (!hasApplicationJob(app)) return false;
  const statusKey = getApplicationStatusKey(app);
  if (statusKey === 'accepted' || statusKey === 'rejected' || statusKey === 'withdrawn') return false;
  const jobStatus = String(app?.jobId?.status || '').toLowerCase();
  if (jobStatus && jobStatus !== 'open') return false;
  return true;
}

function formatApplicationStatus(value) {
  const cleaned = String(value || 'submitted').replace(/_/g, ' ').toLowerCase();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Submitted';
}

function renderParalegalPriorityQueue() {
  const list = document.querySelector('[data-paralegal-priority-list]');
  const count = document.querySelector('[data-paralegal-priority-count]');
  if (!list) return;
  const { activeCases = [], invites = [], deadlines = [], applications = [] } = paralegalPrioritySnapshot;
  const priorities = [];
  const pendingInvites = invites.filter((invite) => String(invite?.inviteStatus || invite?.status || 'pending').toLowerCase() === 'pending');
  if (pendingInvites.length) {
    const first = pendingInvites[0];
    const caseId = getCaseId(first);
    priorities.push({
      title: `${pendingInvites.length} Matter invitation${pendingInvites.length === 1 ? '' : 's'} waiting`,
      detail: 'Review the scope and respond so the attorney knows whether you are available.',
      label: 'Review invitation',
      href: caseId ? `dashboard-paralegal.html?inviteCase=${encodeURIComponent(caseId)}#home` : 'dashboard-paralegal.html#home',
    });
  }
  if (unreadMessageCount > 0) {
    const caseId = getCaseId(latestMessageThread);
    priorities.push({
      title: `${unreadMessageCount} unread message${unreadMessageCount === 1 ? '' : 's'}`,
      detail: 'Continue the conversation inside the related Matter workspace.',
      label: 'Open messages',
      href: caseId ? `case-detail.html?caseId=${encodeURIComponent(caseId)}&tab=messages` : 'dashboard-paralegal.html#home',
    });
  }
  const applicationNeedingResponse = applications.find((application) => {
    const pre = getApplicationPreEngagement(application);
    return ['requested', 'changes_requested'].includes(String(pre?.status || '').toLowerCase());
  });
  if (applicationNeedingResponse) {
    const appId = String(applicationNeedingResponse?._id || applicationNeedingResponse?.id || '');
    priorities.push({
      title: 'Pre-engagement information required',
      detail: 'Complete the requested confidentiality or conflicts information before the Matter can advance.',
      label: 'Complete request',
      href: appId ? `dashboard-paralegal.html?applicationId=${encodeURIComponent(appId)}#cases` : 'dashboard-paralegal.html#cases',
    });
  }
  if (!stripeConnected) {
    priorities.push({
      title: 'Complete payout setup',
      detail: 'Finish payout verification before a completed Matter reaches payout.',
      label: 'Open payout settings',
      href: 'profile-settings.html?onboardingStep=payment',
    });
  }
  const today = window.LPCBusinessDate?.today() || "";
  const sevenDaysFromToday = window.LPCBusinessDate?.addDays(today, 7) || "";
  const dated = deadlines
    .map((deadline) => ({
      ...deadline,
      dateOnly: window.LPCBusinessDate?.normalize(deadline?.start || deadline?.deadline) || "",
    }))
    .filter((deadline) => deadline.dateOnly)
    .sort((left, right) => left.dateOnly.localeCompare(right.dateOnly));
  const upcoming = dated.find((deadline) => deadline.dateOnly <= sevenDaysFromToday);
  if (upcoming) {
    const caseId = getCaseId(upcoming);
    const overdue = upcoming.dateOnly < today;
    priorities.push({
      title: overdue ? 'A Matter deadline is overdue' : 'A Matter deadline is approaching',
      detail: `${upcoming.title || 'Matter'} · ${formatMatterDeadline(upcoming.dateOnly)}`,
      label: 'Open Matter',
      href: caseId ? `case-detail.html?caseId=${encodeURIComponent(caseId)}&tab=work` : 'dashboard-paralegal.html#cases',
    });
  }
  if (!priorities.length) {
    priorities.push({
      title: 'All clear',
      detail: activeCases.length ? 'No invitations, messages, payout blockers, or near-term deadlines need action.' : 'Browse open Matters when you are ready for another opportunity.',
      label: activeCases.length ? 'View Matters' : 'Browse Matters',
      href: activeCases.length ? 'dashboard-paralegal.html#cases' : 'browse-jobs.html',
    });
  }
  const visible = priorities.slice(0, 5);
  if (count) {
    count.textContent = priorities[0]?.title === 'All clear'
      ? 'All clear'
      : `${visible.length} action${visible.length === 1 ? '' : 's'}`;
  }
  list.innerHTML = visible.map((item) => `
    <div class="lpc-priority-item">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </div>
      <a class="lpc-priority-action" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>
    </div>
  `).join('');
}

async function initDashboard() {
  attachUIHandlers();
  initQuickActions();
  try {
    const [profile, , dashboard, invites, deadlines, threads, unreadCount] = await Promise.all([
      loadViewerProfile().catch(() => ({})),
      loadStripeStatus().catch(() => null),
      fetchParalegalData().catch(() => ({})),
      loadInvites().catch(() => []),
      loadDeadlineEvents().catch(() => []),
      loadMessageThreads().catch(() => []),
      loadUnreadMessageCount().catch(() => 0),
    ]);
    const viewer = profile || {};
    pendingApprovalReady = true;
    updateProfile(viewer);
    const caseDeadlines = buildCaseDeadlines(dashboard?.activeCases || []);
    const deadlineEvents = deadlines.length ? deadlines : caseDeadlines;
    updateStats({
      activeCases: dashboard?.metrics?.activeCases,
      unreadMessages: unreadCount,
      nextDeadline: deriveNextDeadline(deadlineEvents),
      monthEarnings: dashboard?.metrics?.earnings,
      totalEarnings: dashboard?.metrics?.earningsTotal,
      payout30Days: dashboard?.metrics?.earningsLast30Days,
      nextPayout: dashboard?.metrics?.nextPayoutDate,
    });
    await loadAppliedJobs();
    renderDeadlines(deadlineEvents);
    initLatestMessage(threads);
    renderAssignments(mapActiveCasesToAssignments(dashboard?.activeCases || []));
    renderRecentActivity({ invites, threads, deadlines: deadlineEvents });
    paralegalPrioritySnapshot = {
      activeCases: dashboard?.activeCases || [],
      invites,
      threads,
      deadlines: deadlineEvents,
      applications: appliedAppsCache,
    };
    renderParalegalPriorityQueue();
    maybeOpenInviteFromQuery();
  } catch (err) {
    console.warn('Paralegal dashboard init failed', err);
    renderAssignments([]);
    renderRecentActivity({ invites: [], threads: [], deadlines: [] });
    renderDeadlines([]);
    initLatestMessage([]);
    loadAppliedJobs();
    paralegalPrioritySnapshot = { activeCases: [], invites: [], threads: [], deadlines: [], applications: appliedAppsCache };
    renderParalegalPriorityQueue();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void bootParalegalDashboard();
});

async function bootParalegalDashboard() {
  const user = typeof window.requireRole === 'function' ? await window.requireRole('paralegal') : null;
  if (!user) return;
  bindClusterProfileMenu();
  applyRoleVisibility(user);
  updateProfile(user || {});
  initParalegalTour(user || {}, { force: consumeReplayFlag() });
  window.hydrateParalegalCluster?.(user || {});
  if (window.state) {
    window.state.viewerRole = String(user.role || '').toLowerCase();
  }
  await initDashboard();
  setupDashboardAutoRefresh();
}

function applyRoleVisibility(user) {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'paralegal') {
    document.querySelectorAll('[data-attorney-only]').forEach((el) => {
      el.style.display = 'none';
    });
  }
  if (role === 'attorney') {
    document.querySelectorAll('[data-paralegal-only]').forEach((el) => {
      el.style.display = 'none';
    });
  }
}

function initAvailabilityModal() {
  const modal = document.getElementById("availabilityModal");
  const openBtn = document.getElementById("updateAvailabilityLink");
  const saveBtn = document.getElementById("saveAvailabilityBtn");
  const cancelBtn = document.getElementById("cancelAvailabilityBtn");
  const statusInput = document.getElementById("availabilityStatusInput");
  const dateInput = document.getElementById("availabilityDateInput");
  const statusDisplay = document.getElementById("availabilityStatus");
  const nextDisplay = document.getElementById("availabilityNext");
  const nextRow = document.getElementById("availabilityNextRow");
  const dateRow = document.getElementById("availabilityDateRow");
  const currentSummary = document.getElementById("availabilityCurrentSummary");
  const quickActionBtn = document.querySelector('.quick-actions [data-action="availability"]');

  if (!modal) return;

  if (dateInput) {
    const now = new Date();
    dateInput.min = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  const resolveStatusValue = (value) => {
    const lowered = String(value || "").toLowerCase();
    if (lowered.includes("unavail")) return "unavailable";
    return "available";
  };

  const syncAvailabilityUI = (value) => {
    const isUnavailable = resolveStatusValue(value) === "unavailable";
    if (dateRow) dateRow.style.display = isUnavailable ? "" : "none";
    if (nextRow) nextRow.style.display = isUnavailable ? "" : "none";
    if (!isUnavailable && dateInput) dateInput.value = "";
    if (!isUnavailable && nextDisplay) nextDisplay.textContent = "";
  };

  const syncFromDisplay = () => {
    if (!statusInput) return;
    const displayValue = statusDisplay?.dataset.value || statusDisplay?.textContent || "";
    statusInput.value = resolveStatusValue(displayValue);
    if (dateInput) dateInput.value = statusInput.value === "unavailable" ? nextDisplay?.dataset.date || "" : "";
    if (currentSummary) {
      currentSummary.textContent =
        statusInput.value === "available"
          ? "Current status: Available now"
          : `Current status: ${nextDisplay?.textContent || "Not available — no return date set"}`;
    }
    syncAvailabilityUI(statusInput.value);
  };

  const showModal = (event) => {
    event?.preventDefault();
    if (!modal) return;
    syncFromDisplay();
    modal.style.display = "flex";
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    modal.removeAttribute("inert");
    activateDialogFocus(modal, {
      initialFocus: statusInput,
      returnFocus: event?.currentTarget instanceof HTMLElement ? event.currentTarget : quickActionBtn || openBtn,
      onEscape: hideModal,
    });
  };

  const hideModal = () => {
    if (!modal) return;
    modal.classList.remove("show");
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    modal.setAttribute("inert", "");
    deactivateDialogFocus(modal);
  };

  if (openBtn) {
    openBtn.addEventListener("click", showModal);
  }

  if (quickActionBtn) {
    quickActionBtn.addEventListener("click", showModal);
  }

  if (cancelBtn) {
    cancelBtn.addEventListener("click", hideModal);
  }

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      hideModal();
    }
  });
  if (statusInput) {
    statusInput.addEventListener("change", () => {
      syncAvailabilityUI(statusInput.value);
    });
  }

  syncFromDisplay();

  if (saveBtn && statusInput && dateInput && statusDisplay && nextDisplay) {
    saveBtn.addEventListener("click", async () => {
      const status = statusInput.value;
      const nextDate = status === "unavailable" ? dateInput.value : "";
      if (nextDate && !dateInput.checkValidity()) {
        dateInput.reportValidity();
        return;
      }

      const payload = {
        status,
        nextAvailable: nextDate || null
      };

      try {
        const res = await secureFetch("/api/paralegals/update-availability", {
          method: "POST",
          body: payload
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          await showAlert(data.msg || "Failed to update availability.", { title: "Availability not updated" });
          return;
        }

        const fallbackAvailability = status === "available" ? "Available now" : "Unavailable";
        const details = data.availabilityDetails || {};
        const availabilityLabel = data.availability || fallbackAvailability;
        const nextSource = nextDate || details.nextAvailable || null;
        const friendly = formatAvailabilityDate(nextSource);

        statusDisplay.textContent = fallbackAvailability;
        if (status === "unavailable") {
          if (friendly) {
            nextDisplay.textContent = `Available on ${friendly}`;
          } else {
            nextDisplay.textContent = "No return date set";
          }
        } else {
          nextDisplay.textContent = "";
        }

        syncAvailabilityUI(status);

        const nextAvailable =
          status === "unavailable"
            ? details.nextAvailable || (nextDate ? new Date(nextDate).toISOString() : null)
            : null;
        persistAvailabilityState(availabilityLabel, {
          status: details.status || status,
          nextAvailable,
          updatedAt: details.updatedAt || new Date().toISOString()
        });
        syncAvailabilityProfile({
          availability: availabilityLabel,
          availabilityDetails: {
            status: details.status || status,
            nextAvailable,
          },
        });

        hideModal();
      } catch (err) {
        console.error(err);
        await showAlert("Server error updating availability.", { title: "Availability not updated" });
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAvailabilityModal);
} else {
  initAvailabilityModal();
}
