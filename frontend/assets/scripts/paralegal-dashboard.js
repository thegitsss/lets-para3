import { secureFetch } from "./auth.js";
import {
  getStripeConnectStatus,
  isStripeConnected,
  startStripeOnboarding,
  STRIPE_GATE_MESSAGE,
} from "./utils/stripe-connect.js";

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
  const target = `case-detail.html?caseId=${encodeURIComponent(caseId)}${messages ? "#case-messages" : ""}`;
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
  pluralText: document.getElementById('plural'),
  deadlineList: document.getElementById('deadlineList'),
  assignmentList: document.getElementById('assignmentList'),
  recentActivityList: document.getElementById('recentActivityList'),
  assignedCasesList: document.getElementById('assignedCasesList'),
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
  welcomeNotice: document.getElementById('paralegalWelcomeNotice'),
  welcomeNoticeDismiss: document.getElementById('dismissWelcomeNotice'),
};

const recentActivityState = {
  threads: [],
  deadlines: [],
  invites: [],
};

const appliedFilters = {
  search: document.getElementById('appliedSearch'),
  status: document.getElementById('appliedStatusFilter'),
  practice: document.getElementById('appliedPracticeFilter'),
  dateRange: document.getElementById('appliedDateFilter'),
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

let viewerProfile = null;
let latestMessageThread = null;
let unreadMessageCount = 0;
let stripeConnected = false;
let stripeGateBound = false;
let pendingApprovalReady = false;
let appliedAppsCache = [];
let appliedFiltersBound = false;
let activeApplication = null;
const APPLIED_PAGE_SIZE = 3;
let appliedPage = 1;
let appliedTotalPages = 1;
const applicationModal = document.getElementById('applicationDetailModal');
const applicationDetail = applicationModal?.querySelector('[data-application-detail]');
let applicationModalBound = false;
let appliedPreviewBound = false;
let appliedQueryHandled = false;

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function notifyStripeGate(message = STRIPE_GATE_MESSAGE) {
  const toastHelper = window.toastUtils;
  if (toastHelper?.show && selectors.toastBanner) {
    toastHelper.show(message, { targetId: selectors.toastBanner.id, type: "info" });
    return;
  }
  alert(message);
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
  viewerProfile = profile || null;
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
    message.textContent = "Secure payouts powered by Stripe. Payments activate shortly.";
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
        alert(err?.message || "Unable to start Stripe onboarding.");
        cta.disabled = false;
        cta.textContent = original;
      }
    });
  }
  applyStripeGateToApplyActions();
  return data;
}

async function fetchParalegalData() {
  return fetchJson('/api/paralegal/dashboard');
}

async function loadDeadlineEvents(limit = 5) {
  const params = new URLSearchParams({ limit: String(limit) });
  return fetchJson(`/api/events?${params.toString()}`).then((data) => (Array.isArray(data.items) ? data.items : []));
}

function getCaseDeadlineDate(caseItem = {}) {
  const raw = caseItem.deadline || caseItem.dueDate || caseItem.deadlineDate || null;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildCaseDeadlines(activeCases = []) {
  return (Array.isArray(activeCases) ? activeCases : [])
    .map((caseItem) => {
      const date = getCaseDeadlineDate(caseItem);
      if (!date) return null;
      return {
        title: caseItem.jobTitle || caseItem.title || 'Case deadline',
        where: caseItem.practiceArea || '',
        start: date.toISOString(),
        caseId: getCaseId(caseItem),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
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

function deriveNextDeadline(events = []) {
  const next = Array.isArray(events) ? events[0] : null;
  if (!next) return '--';
  return next.start ? new Date(next.start).toLocaleDateString() : '--';
}

function setField(field, value) {
  document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
    el.textContent = value ?? '';
  });
}

function updateStats(stats = {}) {
  const activeCases = Number(stats.activeCases ?? 0);
  const unread = Number(stats.unreadMessages ?? 0);
  const nextDeadline = stats.nextDeadline ?? '--';
  const monthEarnings = Number(stats.monthEarnings ?? 0);
  const payout30Days = Number(stats.payout30Days ?? 0);
  const nextPayout = stats.nextPayout ?? '—';

  setField('welcomeSubheading', `You have ${activeCases} active assignment${activeCases === 1 ? '' : 's'}`);
  setField('activeCases', activeCases);
  setField('unreadMessages', unread);
  unreadMessageCount = unread;
  if (selectors.pluralText) {
    selectors.pluralText.textContent = unread === 1 ? ' waiting' : 's waiting';
  }
  setField('nextDeadline', nextDeadline);
  const earningsDisplay = formatCurrency(monthEarnings).replace(/^\$/, '');
  const payoutDisplay = formatCurrency(payout30Days).replace(/^\$/, '');
  setField('monthEarnings', earningsDisplay);
  setField('payout30Days', payoutDisplay);
  setField('nextPayout', nextPayout);
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
      const dueText = deadline.start ? ` due ${new Date(deadline.start).toLocaleDateString()}` : '';
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
    const header = card.querySelector('.case-header');
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

    titleEl.textContent = assignment.title || 'Case';
    metaEl.textContent = metaParts.join(' · ');
    summaryEl.textContent = assignment.summary || '';
    if (card) card.dataset.caseId = caseId;
    card.classList.add('open');

    if (actions) {
      actions.hidden = !eligible;
    }
    if (secondaryBtn) {
      secondaryBtn.remove();
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
        title: caseItem.jobTitle || caseItem.title || 'Case',
        attorney: caseItem.attorneyName || '',
        due: caseItem.deadline
          ? new Date(caseItem.deadline).toLocaleDateString()
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

function renderInvites(invites = []) {
  return renderRecentActivity({ invites });
}

function buildRecentActivityEntries({ invites = [], threads = [], deadlines = [] } = {}) {
  const entries = [];

  invites.forEach((invite) => {
    const inviteId = invite?.id || invite?._id;
    if (!inviteId) return;
    const invitedAt = invite.inviteInvitedAt || invite.pendingParalegalInvitedAt || invite.createdAt || null;
    const timestamp = invitedAt ? new Date(invitedAt).getTime() : 0;
    const attorneyName =
      invite.attorney?.name ||
      [invite.attorney?.firstName, invite.attorney?.lastName].filter(Boolean).join(' ').trim() ||
      '';
    const title = invite.title || 'Case invitation';
    entries.push({
      type: 'invite',
      caseId: String(inviteId),
      timestamp,
      title,
      meta: ['Invitation received', attorneyName].filter(Boolean).join(' · '),
      time: formatActivityDate(invitedAt),
      href: `case-detail.html?caseId=${encodeURIComponent(inviteId)}`,
    });
  });

  (Array.isArray(threads) ? threads : []).forEach((thread) => {
    const caseId = thread?.caseId || thread?.case?.id || thread?.id || '';
    const timestamp = getThreadTimestamp(thread);
    entries.push({
      type: 'message',
      caseId: String(caseId),
      timestamp,
      title: thread?.title || 'Case thread',
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
  const subtitle = entries.length ? 'Latest updates from your cases.' : 'No recent activity yet.';
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
        ? `<a class="activity-link" href="${escapeHtml(entry.href)}">${escapeHtml(entry.title)}</a>`
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
    link.addEventListener('click', (event) => event.stopPropagation());
  });
}

async function respondToInvite(caseId, action, button) {
  if (!caseId || !action) return;
  if (action === "accept" && !stripeConnected) {
    notifyStripeGate();
    return;
  }
  const endpoint = `/api/cases/${encodeURIComponent(caseId)}/invite/${action}`;
  const originalLabel = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = action === 'accept' ? 'Accepting…' : 'Declining…';
  }
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
      window.location.reload();
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
    if (button && !completed) {
      button.disabled = false;
      button.textContent = originalLabel || (action === 'accept' ? 'Accept' : 'Decline');
    }
  }
}

async function loadAssignedCases() {
  const list = selectors.assignedCasesList;
  if (!list) return;
  try {
    const payload = await fetchJson('/api/cases/my-assigned');
    renderAssignedCases(Array.isArray(payload?.items) ? payload.items : []);
  } catch (error) {
    renderAssignedCasesError(error.message || 'Unable to load assigned cases.');
  }
}

function renderAssignedCases(items = []) {
  const list = selectors.assignedCasesList;
  if (!list) return;
  const visibleItems = items.filter((item) => String(item?.status || '').toLowerCase() !== 'completed');
  if (!visibleItems.length) {
    list.innerHTML = `
      <div class="dashboard-card full-width" id="recommendedPostingsCard">
        <h3 class="card-title">Recommended for You</h3>
        <ul class="recommendations-list"></ul>
        <a href="browse-jobs.html" class="card-link">Refine filters →</a>
      </div>
    `;
    void loadRecommendedJobs(viewerProfile || {});
    return;
  }
  list.innerHTML = visibleItems
    .map(
      (c) => {
        const caseId = getCaseId(c);
        const safeCaseId = escapeHTML(caseId);
        const eligible = caseId ? isWorkspaceEligibleCase(c) : false;
        const buttonLabel = eligible ? 'Open Case' : 'Awaiting Attorney Funding';
        const disabledAttr = eligible ? '' : ' disabled aria-disabled="true"';
        const statusValue = String(c.status || 'Active');
        const statusLabel = formatStatusLabel(statusValue).replace(/\s+/g, ' ').trim() || 'Active';
        const statusKey = statusValue.toLowerCase().replace(/\s+/g, '_');
      return `
      <div class="case-item" data-id="${safeCaseId}">
        <div class="case-title">${escapeHTML(c.title || 'Untitled Case')}</div>
        <div class="case-meta">
          <span>${escapeHTML(c.caseNumber || '')}</span>
          <span>Attorney: ${escapeHTML(c.attorneyName || '')}</span>
          <span>Status: ${escapeHTML(statusLabel)}</span>
        </div>
        <div class="case-actions">
          <button class="open-case-btn" data-id="${safeCaseId}"${disabledAttr}>${buttonLabel}</button>
        </div>
      </div>`;
      }
    )
    .join('');
}

async function withdrawFromCase(caseId, button) {
  if (!caseId) return;
  const toastHelper = window.toastUtils;
  const originalLabel = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Withdrawing…';
  }
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/withdraw`, {
      method: 'POST',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || 'Unable to withdraw from this case.');
    toastHelper?.show?.('Application withdrawn.', { targetId: selectors.toastBanner?.id, type: 'success' });
    await loadAssignedCases();
  } catch (error) {
    toastHelper?.show?.(error.message || 'Unable to withdraw from this case.', {
      targetId: selectors.toastBanner?.id,
      type: 'error',
    });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || 'Withdraw application';
    }
  }
}

function renderAssignedCasesError(message = 'Unable to load assigned cases.') {
  const list = selectors.assignedCasesList;
  if (!list) return;
  list.innerHTML = `<p>${escapeHTML(message)}</p>`;
}

function handleCaseAction(action, title) {
  const toastHelper = window.toastUtils;
  const message = `${action} for “${title}” is coming soon.`;
  toastHelper?.show?.(message, { targetId: selectors.toastBanner?.id });
}

function attachUIHandlers() {
  const toastHelper = window.toastUtils;
  const stagedToast = toastHelper?.consume?.();
  if (stagedToast?.message && selectors.toastBanner) {
    toastHelper.show(stagedToast.message, { targetId: selectors.toastBanner.id, type: stagedToast.type });
  }

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
      respondToInvite(caseId, 'decline', selectors.inviteDeclineBtn);
    });
  }
  if (selectors.messageBox) {
    selectors.messageBox.addEventListener('click', () => {
      if (unreadMessageCount < 1) return;
      const caseId = latestMessageThread?.id || latestMessageThread?._id || '';
      if (!caseId) return;
      window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}#case-messages`;
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selectors.inviteOverlay?.classList.contains('show')) {
      closeInviteOverlay();
    }
  });
}

let activeInvite = null;
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
  if (!inviteOverlay) return;
  const title = invite?.title || 'Case Invitation';
  const attorneyName =
    invite?.attorney?.name ||
    [invite?.attorney?.firstName, invite?.attorney?.lastName].filter(Boolean).join(' ').trim() ||
    'Attorney';
  const practice = invite?.practiceArea || 'General matter';
  const status = invite?.status ? formatStatusLabel(invite.status) : '';
  const numericBudget = typeof invite?.budget === 'number' ? invite.budget : Number.NaN;
  const pay =
    (Number.isFinite(numericBudget) && `$${numericBudget.toLocaleString()} compensation`) ||
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

  if (inviteCaseTitle) inviteCaseTitle.textContent = "You've been invited to a case";
  if (inviteJobTitle) inviteJobTitle.textContent = title;
  if (inviteLead) inviteLead.textContent = `${attorneyName} has invited you to collaborate on this case.`;
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
    inviteDetails.textContent = brief || 'Full case details will be shared after you accept.';
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
    inviteAcceptBtn.disabled = !caseId || !stripeConnected;
    if (!stripeConnected) {
      inviteAcceptBtn.title = STRIPE_GATE_MESSAGE;
    } else {
      inviteAcceptBtn.removeAttribute("title");
    }
  }
  if (inviteDeclineBtn) {
    inviteDeclineBtn.dataset.caseId = caseId;
    inviteDeclineBtn.disabled = !caseId;
  }

  inviteOverlay.classList.add('show');
}

function closeInviteOverlay() {
  selectors.inviteOverlay?.classList.remove('show');
  activeInvite = null;
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
    paralegalWelcomeDismissed: Boolean(raw?.paralegalWelcomeDismissed),
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

function hasCompletedTour(user) {
  return getCachedOnboarding(user).paralegalTourCompleted;
}

function markTourCompleted() {
  void updateOnboardingState({ paralegalTourCompleted: true }, { markFirstLoginComplete: true });
}

function updateWelcomeGreeting(user) {
  const greetingEl = selectors.welcomeGreeting;
  if (!greetingEl) return;
  greetingEl.textContent = "Welcome";
}

function hasDismissedWelcome(user) {
  return getCachedOnboarding(user).paralegalWelcomeDismissed;
}

function markWelcomeDismissed(user) {
  void updateOnboardingState({ paralegalWelcomeDismissed: true });
}

function applyParalegalWelcomeNotice(user) {
  const notice = selectors.welcomeNotice;
  const dismissBtn = selectors.welcomeNoticeDismiss;
  if (!notice || !dismissBtn) return;
  // Welcome notice is intentionally disabled.
  notice.classList.add("hidden");
  return;

  const stored = getStoredUserSnapshot();
  const role = String((user?.role || stored?.role || "")).toLowerCase();
  if (role !== "paralegal") {
    notice.classList.add("hidden");
    return;
  }
  const storedFlag = stored?.isFirstLogin;
  const userFlag = user?.isFirstLogin;
  const isFirstLogin = typeof storedFlag === "boolean" ? storedFlag : Boolean(userFlag);
  const applyState = (onboarding) => {
    const dismissed = Boolean(onboarding?.paralegalWelcomeDismissed);
    notice.classList.toggle("hidden", !isFirstLogin || dismissed);
  };
  const cached = getCachedOnboarding(user || stored);
  if (cached && (cached.paralegalWelcomeDismissed || cached.paralegalTourCompleted || cached.paralegalProfileTourCompleted)) {
    applyState(cached);
  } else {
    void loadOnboardingState(user || stored).then(applyState);
  }

  if (!dismissBtn.dataset.bound) {
    dismissBtn.dataset.bound = "true";
    dismissBtn.addEventListener("click", () => {
      notice.classList.add("hidden");
      markWelcomeDismissed(user || stored);
    });
  }
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
    tooltip.classList.remove("is-active");
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
    tooltip.classList.remove("is-active");
  };

  const showProfileStep = () => {
    showOverlay();
    ensureSidebarVisibleForTarget(profileLink);
    modal.classList.remove("is-active");
    overlay.classList.add("spotlight");
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
  };

  const completeTour = () => {
    tooltip.classList.remove("is-active");
    hideOverlay();
    updateWelcomeGreeting(user);
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
  updateWelcomeGreeting(profile);
  const avatarUrl = getAvatarUrl(profile);
  document.querySelectorAll('[data-avatar]').forEach((node) => {
    node.src = avatarUrl;
    node.alt = `${composedName}'s avatar`;
  });
  const a = document.querySelector('#user-avatar');
  if (a) a.src = avatarUrl;
  updatePendingApprovalBanner(profile);
}

function persistAvailabilityState(availabilityText, details = {}) {
  try {
    const raw = localStorage.getItem('lpc_user');
    if (!raw) return;
    const user = JSON.parse(raw);
    if (!user || typeof user !== 'object') return;
    if (availabilityText) user.availability = availabilityText;
    user.availabilityDetails = details;
    localStorage.setItem('lpc_user', JSON.stringify(user));
    window.updateSessionUser?.(user);
    window.hydrateParalegalCluster?.(user);
    try {
      window.dispatchEvent(new CustomEvent('lpc:user-updated', { detail: user }));
    } catch (_) {}
  } catch (err) {
    console.warn('Unable to persist availability', err);
  }
}

function formatAvailabilityDate(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  setField('latestMessageName', latest?.title || 'Case thread');
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
      if (action === 'availability') {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      handleCaseAction(button.textContent || 'Action', 'your assignments');
    });
  });
}

function normalizeState(value = '') {
  return String(value || '').trim().toLowerCase();
}

function parseStateFromLocation(value = '') {
  const parts = String(value || '').split(',');
  if (parts.length < 2) return '';
  return parts[parts.length - 1].trim();
}

function deriveProfileState(profile = {}) {
  return (
    profile.locationState ||
    profile.state ||
    profile.jurisdiction ||
    parseStateFromLocation(profile.location || profile.address || '')
  );
}

function parseExperience(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function deriveExperience(profile = {}) {
  return (
    parseExperience(profile.yearsExperience) ||
    parseExperience(profile.experienceYears) ||
    parseExperience(profile.paralegalProfile?.yearsExperience)
  );
}

function extractJobState(job = {}) {
  return (
    job.state ||
    job.locationState ||
    job.location?.state ||
    job.location ||
    job.jurisdiction ||
    job.region ||
    ''
  );
}

function extractJobExperience(job = {}) {
  return (
    parseExperience(job.minimumExperienceRequired) ||
    parseExperience(job.minExperience) ||
    parseExperience(job.yearsExperience) ||
    parseExperience(job.experienceRequired)
  );
}

function formatExperienceLabel(years = 0) {
  if (!years) return '';
  return years === 1 ? '1 year experience' : `${years} years experience`;
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

function buildApplicationDetail(app) {
  if (!app) {
    return '<p class="muted">Application not found.</p>';
  }
  const job = app.jobId || app.job || {};
  const title = escapeHtml(job.title || app.caseTitle || 'Job');
  const practice = escapeHtml(job.practiceArea || 'General practice');
  const description = escapeHtml(job.description || '');
  const budgetValue = Number(job.budget);
  const budget = job.compensationDisplay || job.payDisplay || (Number.isFinite(budgetValue) ? formatCurrency(budgetValue) : '');
  const status = formatApplicationStatus(getApplicationStatusKey(app));
  const appliedAt = app.createdAt ? formatDate(app.createdAt) : 'Recently';
  const cover = formatMultiline(app.coverLetter || '');

  return `
    <div class="detail-row">
      <span class="detail-label">Job</span>
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
  `;
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

function openApplicationModal(app) {
  if (!applicationModal || !applicationDetail) return;
  if (window.location.hash !== '#cases') return;
  if (isRejectedApplication(app)) {
    closeApplicationModal();
    return;
  }
  activeApplication = app || null;
  const revokeBtn = applicationModal.querySelector('[data-application-revoke]');
  if (revokeBtn) {
    const statusKey = getApplicationStatusKey(app);
    const hasId = Boolean(app?._id || app?.id);
    const disabled = !hasId || statusKey === 'accepted';
    revokeBtn.disabled = disabled;
    revokeBtn.textContent = disabled ? 'Revoke unavailable' : 'Revoke application';
  }
  applicationDetail.innerHTML = buildApplicationDetail(app);
  applicationModal.classList.remove('hidden');
}

function closeApplicationModal() {
  if (!applicationModal) return;
  applicationModal.classList.add('hidden');
  activeApplication = null;
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
      await revokeApplication(activeApplication, revokeBtn);
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

async function loadRecommendedJobs(profile = {}) {
  const list = document.querySelector('#recommendedPostingsCard .recommendations-list');
  if (!list) return;
  list.innerHTML =
    '<li class="recommended-item"><span class="rec-title">Finding postings for you…</span></li>';

  try {
    const res = await secureFetch('/api/jobs/open', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const jobs = await res.json().catch(() => []);
    if (!Array.isArray(jobs) || !jobs.length) {
      list.innerHTML =
        '<li class="recommended-item"><span class="rec-title">No open postings yet.</span></li>';
      return;
    }

    const desiredState = normalizeState(deriveProfileState(profile));
    const yearsExperience = deriveExperience(profile);

    const matched = jobs.filter((job) => {
      const jobState = normalizeState(extractJobState(job));
      const jobExp = extractJobExperience(job);
      const stateOk = desiredState ? jobState === desiredState : true;
      const expOk = yearsExperience ? jobExp === yearsExperience : true;
      return stateOk && expOk;
    });

    const shortlist = (matched.length ? matched : jobs).slice(0, 2);

    list.innerHTML = shortlist
      .map((job) => {
        const id = job._id || job.id || '';
        const title = escapeHtml(job.title || 'Untitled posting');
        const jobState = escapeHtml(extractJobState(job) || 'Multi-state');
        const jobExpLabel = formatExperienceLabel(extractJobExperience(job));
        const payDisplay =
          job.compensationDisplay ||
          job.payDisplay ||
          (typeof job.budget === 'number' ? `$${job.budget.toLocaleString()}` : '');
        const meta = [jobState, jobExpLabel, payDisplay].filter(Boolean).join(' • ');

        const href = id ? `browse-jobs.html?id=${encodeURIComponent(id)}` : 'browse-jobs.html';
        return `
          <li class="recommended-item">
            <div>
              <span class="rec-title">${title}</span>
              <div class="rec-status">${escapeHtml(meta)}</div>
            </div>
            <a class="rec-open-link" href="${href}">View</a>
          </li>
        `;
      })
      .join('');
  } catch (err) {
    console.error('Failed to load recommended jobs', err);
    list.innerHTML =
      '<li class="recommended-item"><span class="rec-title">Unable to load recommendations.</span></li>';
  }
}

async function loadAppliedJobs() {
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
    const visibleApps = apps.filter((app) => {
      if (!hasApplicationJob(app)) return false;
      const status = getApplicationStatusKey(app);
      return status !== 'accepted' && status !== 'rejected';
    });
    appliedAppsCache = visibleApps;
    appliedPage = 1;
    bindAppliedFilters();
    populateAppliedFilterOptions(visibleApps);
    applyAppliedFilters({ resetPage: false });
    maybeOpenApplicationFromQuery();
  } catch (err) {
    console.error('Failed to load applied jobs', err);
    container.innerHTML = `
      <div class="case-card empty-state">
        <div class="case-header">
          <div>
            <h2>Unable to load applications</h2>
            <div class="case-subinfo">Please refresh to try again.</div>
          </div>
        </div>
      </div>`;
    updateAppliedPagination({ total: 0 });
    maybeOpenApplicationFromQuery();
  }
}

function bindAppliedFilters() {
  if (appliedFiltersBound) return;
  const { search, status, practice, dateRange } = appliedFilters;
  if (!search || !practice || !dateRange) return;
  appliedFiltersBound = true;
  search.addEventListener('input', () => applyAppliedFilters({ resetPage: true }));
  if (status) {
    status.addEventListener('change', () => applyAppliedFilters({ resetPage: true }));
  }
  practice.addEventListener('change', () => applyAppliedFilters({ resetPage: true }));
  dateRange.addEventListener('change', () => applyAppliedFilters({ resetPage: true }));
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

  const { search, status, practice, dateRange } = appliedFilters;
  const query = String(search?.value || '').trim().toLowerCase();
  const statusFilter = String(status?.value || 'all');
  const practiceFilter = String(practice?.value || 'all');
  const rangeFilter = String(dateRange ? dateRange.value : 'all');

  let filtered = appliedAppsCache.filter((app) => hasApplicationJob(app));
  filtered = filtered.filter((app) => !isRejectedApplication(app));

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

  filtered.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

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
            <div class="case-subinfo">Jobs you apply to will appear here.</div>
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

  container.innerHTML = apps
    .map((app) => {
      const job = app.jobId || {};
      const title = escapeHtml(job.title || 'Untitled job');
      const practice = escapeHtml(job.practiceArea || 'General practice');
      const when = app.createdAt
        ? new Date(app.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
        : 'Recently';
      const applicationId = app._id || app.id || '';
      const jobId = job._id || job.id || app.jobId || '';
      const href = applicationId
        ? `dashboard-paralegal.html?applicationId=${encodeURIComponent(applicationId)}#cases`
        : jobId
          ? `dashboard-paralegal.html?jobId=${encodeURIComponent(jobId)}#cases`
          : 'dashboard-paralegal.html#cases';
      return `
        <div class="case-card applied-card">
          <div class="case-header">
            <div>
              <h2>${title}</h2>
              <div class="case-subinfo">${practice}</div>
              <div class="case-subinfo">Applied on ${when}</div>
            </div>
            <div class="case-actions">
              <a class="card-link" href="${href}" data-application-view data-application-id="${escapeHtml(applicationId)}" data-job-id="${escapeHtml(jobId)}">View →</a>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

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

function formatApplicationStatus(value) {
  const cleaned = String(value || 'submitted').replace(/_/g, ' ').toLowerCase();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Submitted';
}

async function initDashboard() {
  attachUIHandlers();
  initQuickActions();
  try {
    const [profile, _stripeStatus, dashboard, invites, deadlines, threads, unreadCount] = await Promise.all([
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
    applyParalegalWelcomeNotice(viewer);
    const caseDeadlines = buildCaseDeadlines(dashboard?.activeCases || []);
    const deadlineEvents = deadlines.length ? deadlines : caseDeadlines;
    updateStats({
      activeCases: dashboard?.metrics?.activeCases,
      unreadMessages: unreadCount,
      nextDeadline: deriveNextDeadline(deadlineEvents),
      monthEarnings: dashboard?.metrics?.earnings,
      payout30Days: dashboard?.metrics?.earningsLast30Days,
      nextPayout: dashboard?.metrics?.nextPayoutDate,
    });
    loadRecommendedJobs(viewer);
    loadAppliedJobs();
    renderDeadlines(deadlineEvents);
    initLatestMessage(threads);
    renderAssignments(mapActiveCasesToAssignments(dashboard?.activeCases || []));
    renderRecentActivity({ invites, threads, deadlines: deadlineEvents });
  } catch (err) {
    console.warn('Paralegal dashboard init failed', err);
    renderAssignments([]);
    renderRecentActivity({ invites: [], threads: [], deadlines: [] });
    renderDeadlines([]);
    initLatestMessage([]);
    loadRecommendedJobs({});
    loadAppliedJobs();
  }
  await loadAssignedCases();
}

document.addEventListener('DOMContentLoaded', () => {
  void bootParalegalDashboard();
});

async function bootParalegalDashboard() {
  const user = typeof window.requireRole === 'function' ? await window.requireRole('paralegal') : null;
  if (!user) return;
  applyRoleVisibility(user);
  updateProfile(user || {});
  applyParalegalWelcomeNotice(user || {});
  initParalegalTour(user || {}, { force: consumeReplayFlag() });
  window.hydrateParalegalCluster?.(user || {});
  window.initNotificationCenters?.();
  if (window.state) {
    window.state.viewerRole = String(user.role || '').toLowerCase();
  }
  await initDashboard();
  selectors.assignedCasesList?.addEventListener('click', (event) => {
    const withdrawBtn = event.target.closest('.withdraw-application-btn');
    if (withdrawBtn) {
      event.preventDefault();
      withdrawFromCase(withdrawBtn.dataset.id, withdrawBtn);
      return;
    }
    const btn = event.target.closest('.open-case-btn');
    if (!btn) return;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      return;
    }
    const caseId = btn.dataset.id;
    if (!caseId) return;
    window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
  });
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
  const quickActionBtn = document.querySelector('.quick-actions [data-action="availability"]');

  if (!modal) console.error("❌ availabilityModal not found");
  if (!openBtn) console.error("❌ updateAvailabilityLink not found");

  if (!modal) return;

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
    const displayValue = statusDisplay?.textContent || "";
    statusInput.value = resolveStatusValue(displayValue);
    syncAvailabilityUI(statusInput.value);
  };

  const showModal = (event) => {
    event?.preventDefault();
    if (!modal) return;
    syncFromDisplay();
    modal.style.display = "flex";
    modal.classList.add("show");
  };

  const hideModal = () => {
    if (!modal) return;
    modal.classList.remove("show");
    modal.style.display = "none";
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
          alert(data.msg || "Failed to update availability.");
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
            nextDisplay.textContent = "This week";
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

        hideModal();
      } catch (err) {
        console.error(err);
        alert("Server error updating availability.");
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAvailabilityModal);
} else {
  initAvailabilityModal();
}
