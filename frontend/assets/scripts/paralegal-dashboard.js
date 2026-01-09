import { secureFetch } from "./auth.js";
import {
  getStripeConnectStatus,
  isStripeConnected,
  startStripeOnboarding,
  STRIPE_GATE_MESSAGE,
} from "./utils/stripe-connect.js";

const PLACEHOLDER_AVATAR = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'>
    <defs>
      <linearGradient id='grad' x1='0%' y1='0%' x2='100%' y2='100%'>
        <stop offset='0%' stop-color='#f4f6fa'/>
        <stop offset='100%' stop-color='#e6e9ef'/>
      </linearGradient>
    </defs>
    <rect width='80' height='80' rx='16' fill='url(#grad)'/>
    <circle cx='40' cy='34' r='18' fill='#d4dae6'/>
    <path d='M18 70c4-15 17-26 22-26s18 11 22 26' fill='none' stroke='#c9cfda' stroke-width='4' stroke-linecap='round'/>
    <text x='50%' y='52%' font-family='Sarabun, Arial, sans-serif' font-size='18' font-weight='600' fill='#3a4553' text-anchor='middle' dominant-baseline='middle'>LPC</text>
  </svg>`
)}`;

function getAvatarUrl(user = {}) {
  return user.profileImage || user.avatarURL || PLACEHOLDER_AVATAR;
}

function normalizeIdCandidate(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return value._id || value.id || value.userId || "";
  return "";
}

function formatStatusLabel(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  if (lower === "assigned") return "Invited";
  return cleaned.replace(/_/g, " ");
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
  inviteList: document.getElementById('inviteList'),
  assignedCasesList: document.getElementById('assignedCasesList'),
  assignmentTemplate: document.getElementById('assignmentCardTemplate'),
  toastBanner: document.getElementById('toastBanner'),
  nameHeading: document.getElementById('user-name-heading'),
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
};

const appliedFilters = {
  search: document.getElementById('appliedSearch'),
  status: document.getElementById('appliedStatusFilter'),
  practice: document.getElementById('appliedPracticeFilter'),
  dateRange: document.getElementById('appliedDateFilter'),
  toggle: document.getElementById('appliedToggleBtn'),
  count: document.getElementById('appliedCount'),
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
let appliedAppsCache = [];
let appliedShowAll = false;
let appliedFiltersBound = false;
const DEFAULT_APPLIED_LIMIT = 10;
const applicationModal = document.getElementById('applicationDetailModal');
const applicationDetail = applicationModal?.querySelector('[data-application-detail]');
let applicationModalBound = false;
let appliedPreviewBound = false;
let appliedQueryHandled = false;

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
  if (cta && !cta.dataset.bound) {
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
  if (!banner && !message) return null;

  const data = await getStripeConnectStatus({ force: true });
  stripeConnected = isStripeConnected(data);
  if (banner) banner.classList.toggle("hidden", stripeConnected);
  if (message && !stripeConnected) {
    message.textContent = data
      ? "Stripe Connect is required to receive payment for completed assignments. You can manage payouts later in Profile Settings."
      : "Stripe status unavailable. Connect Stripe to receive payment.";
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
  const next = events[0];
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
  if (!assignments.length) {
    container.innerHTML = `
      <div class="case-card empty-state">
        <div class="case-header">
          <div>
            <h2>No active assignments</h2>
            <div class="case-subinfo">New invitations will appear here.</div>
          </div>
        </div>
      </div>
    `;
    return;
  }
  container.innerHTML = '';

  assignments.forEach((assignment) => {
    const node = selectors.assignmentTemplate.content.cloneNode(true);
    const card = node.querySelector('.case-card');
    const header = card.querySelector('.case-header');
    const titleEl = card.querySelector('[data-field="assignmentTitle"]');
    const metaEl = card.querySelector('[data-field="assignmentMeta"]');
    const summaryEl = card.querySelector('[data-field="assignmentSummary"]');

    const attorney = assignment.attorney ? `Lead Attorney: ${assignment.attorney}` : '';
    const due = assignment.due ? `Due: ${assignment.due}` : '';
    const statusLabel = assignment.status ? formatStatusLabel(assignment.status) : '';
    const status = statusLabel ? `Status: ${statusLabel}` : '';
    const metaParts = [attorney, due, status].filter(Boolean);

    titleEl.textContent = assignment.title || 'Case';
    metaEl.textContent = metaParts.join(' · ');
    summaryEl.textContent = assignment.summary || '';

    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', card.classList.contains('open') ? 'true' : 'false');

    const toggleOpen = () => {
      card.classList.toggle('open');
      header.setAttribute('aria-expanded', card.classList.contains('open') ? 'true' : 'false');
    };

    header.addEventListener('click', toggleOpen);
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleOpen();
      }
    });

    card.querySelectorAll('[data-action]').forEach((button) => {
      const action = button.dataset.action;
      const label = assignment.actions?.[action]?.label;
      if (label) button.textContent = label;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        handleCaseAction(button.textContent || 'Action', assignment.title);
      });
    });

    container.appendChild(node);
  });
}

function mapActiveCasesToAssignments(activeCases = []) {
  return activeCases.map((caseItem) => ({
    title: caseItem.jobTitle || caseItem.title || 'Case',
    attorney: caseItem.attorneyName || '',
    due: caseItem.dueDate
      ? new Date(caseItem.dueDate).toLocaleDateString()
      : caseItem.createdAt
        ? new Date(caseItem.createdAt).toLocaleDateString()
        : '',
    status: caseItem.status ? formatStatusLabel(caseItem.status) : '',
    summary: caseItem.practiceArea ? `Practice area: ${caseItem.practiceArea}` : '',
  }));
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
  const container = selectors.inviteList;
  if (!container) return;
  if (!invites.length) {
    container.innerHTML = `
      <div class="case-card empty-state">
        <div class="case-header">
          <div>
            <h2>No invitations yet</h2>
            <div class="case-subinfo">Case invites will appear here.</div>
          </div>
        </div>
        <div class="case-actions">
          <a class="open-case-btn" href="browse-jobs.html">Browse new postings and apply</a>
        </div>
      </div>
    `;
    return;
  }
  container.innerHTML = '';

  invites.forEach((invite) => {
    const card = document.createElement('div');
    card.className = 'case-card';
    card.dataset.caseId = invite.id || invite._id || '';

    const header = document.createElement('div');
    header.className = 'case-header';
    const headerBody = document.createElement('div');
    const titleEl = document.createElement('h2');
    titleEl.textContent = invite.title || 'Case Invitation';
    const subInfo = document.createElement('div');
    subInfo.className = 'case-subinfo';
    const attorneyName =
      invite.attorney?.name ||
      [invite.attorney?.firstName, invite.attorney?.lastName].filter(Boolean).join(' ').trim() ||
      'Attorney';
    const invitedAt = invite.pendingParalegalInvitedAt
      ? `Invited ${new Date(invite.pendingParalegalInvitedAt).toLocaleDateString()}`
      : '';
    subInfo.textContent = [attorneyName, invitedAt].filter(Boolean).join(' · ');
    headerBody.appendChild(titleEl);
    headerBody.appendChild(subInfo);
    header.appendChild(headerBody);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'case-content';
    const summary = document.createElement('p');
    summary.textContent = invite.practiceArea || 'General matter';
    body.appendChild(summary);

    const actions = document.createElement('div');
    actions.className = 'case-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.dataset.inviteAction = 'accept';
    acceptBtn.dataset.caseId = invite.id || invite._id;
    acceptBtn.dataset.stripeApply = "true";
    if (!stripeConnected) {
      acceptBtn.disabled = true;
      acceptBtn.title = STRIPE_GATE_MESSAGE;
    }
    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Decline';
    declineBtn.dataset.inviteAction = 'decline';
    declineBtn.dataset.caseId = invite.id || invite._id;
    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);
    body.appendChild(actions);
    card.appendChild(body);
    container.appendChild(card);

    const openDetail = () => openInviteOverlay(invite);
    header.addEventListener('click', openDetail);
    card.addEventListener('click', (e) => {
      if (e.target?.closest('button')) return;
      openDetail();
    });
  });

  container.querySelectorAll('[data-invite-action]').forEach((button) => {
    button.addEventListener('click', () => respondToInvite(button.dataset.caseId, button.dataset.inviteAction, button));
  });

  const footer = document.createElement('div');
  footer.className = 'info-line';
  footer.innerHTML = '<a href="browse-jobs.html" class="card-link">Browse new postings →</a>';
  container.appendChild(footer);
  applyStripeGateToApplyActions();
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
    if (action === 'decline' && selectors.inviteList) {
      selectors.inviteList.querySelector(`[data-case-id="${caseId}"]`)?.remove();
    }
    closeInviteOverlay();
    const invites = await loadInvites();
    renderInvites(invites);
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
        <a href="browse-jobs.html" class="card-link">Browse all postings →</a>
      </div>
    `;
    void loadRecommendedJobs(viewerProfile || {});
    return;
  }
  list.innerHTML = visibleItems
    .map(
      (c) => {
        const funded = String(c.escrowStatus || '').toLowerCase() === 'funded';
        const buttonLabel = funded ? 'Open Case' : 'Awaiting Attorney Funding';
        const disabledAttr = funded ? '' : ' disabled aria-disabled="true"';
        const statusValue = String(c.status || 'Active');
        const statusLabel = formatStatusLabel(statusValue).replace(/\s+/g, ' ').trim() || 'Active';
        const statusKey = statusValue.toLowerCase().replace(/\s+/g, '_');
        const canWithdraw = !funded && statusKey === 'awaiting_funding';
        return `
      <div class="case-item" data-id="${c._id}">
        <div class="case-title">${c.title || 'Untitled Case'}</div>
        <div class="case-meta">
          <span>${c.caseNumber || ''}</span>
          <span>Attorney: ${c.attorneyName || ''}</span>
          <span>Status: ${statusLabel}</span>
        </div>
        <div class="case-actions">
          <button class="open-case-btn" data-id="${c._id}"${disabledAttr}>${buttonLabel}</button>
          ${
            canWithdraw
              ? `<button class="withdraw-application-btn" data-id="${c._id}">Withdraw application</button>`
              : ''
          }
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
  list.innerHTML = `<p>${message}</p>`;
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
      window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}#messages`;
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
  const invitedAt = invite?.pendingParalegalInvitedAt
    ? `Invited ${new Date(invite.pendingParalegalInvitedAt).toLocaleDateString()}`
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
  setField('name', composedName);
  if (selectors.nameHeading) {
    selectors.nameHeading.textContent = firstName;
  }
  const avatarUrl = getAvatarUrl(profile);
  document.querySelectorAll('[data-avatar]').forEach((node) => {
    node.src = avatarUrl;
    node.alt = `${composedName}'s avatar`;
  });
  if (profile.profileImage) {
    const a = document.querySelector('#user-avatar');
    if (a) a.src = profile.profileImage;
  }
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
  const status = formatApplicationStatus(normalizeApplicationStatus(app.status));
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
    const id = String(app._id || app.id || '');
    if (appId && id === appId) return true;
    if (!jobKey) return false;
    const appJobId = String(app.jobId?._id || app.jobId || '');
    return appJobId === jobKey;
  });
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
  applicationDetail.innerHTML = buildApplicationDetail(app);
  applicationModal.classList.remove('hidden');
}

function closeApplicationModal() {
  if (!applicationModal) return;
  applicationModal.classList.add('hidden');
  clearApplicationQuery();
}

function bindApplicationModal() {
  if (!applicationModal || applicationModalBound) return;
  applicationModalBound = true;
  applicationModal.querySelectorAll('[data-application-close]').forEach((btn) => {
    btn.addEventListener('click', closeApplicationModal);
  });
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
    const visibleApps = apps.filter((app) => normalizeApplicationStatus(app.status) !== 'accepted');
    appliedAppsCache = visibleApps;
    appliedShowAll = false;
    bindAppliedFilters();
    populateAppliedFilterOptions(visibleApps);
    applyAppliedFilters();
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
    updateAppliedCount(0, 0, true);
    maybeOpenApplicationFromQuery();
  }
}

function bindAppliedFilters() {
  if (appliedFiltersBound) return;
  const { search, status, practice, dateRange, toggle } = appliedFilters;
  if (!search || !status || !practice || !dateRange || !toggle) return;
  appliedFiltersBound = true;
  search.addEventListener('input', () => applyAppliedFilters());
  status.addEventListener('change', () => applyAppliedFilters());
  practice.addEventListener('change', () => applyAppliedFilters());
  dateRange.addEventListener('change', () => applyAppliedFilters());
  toggle.addEventListener('click', () => {
    appliedShowAll = !appliedShowAll;
    applyAppliedFilters();
  });
}

function populateAppliedFilterOptions(apps = []) {
  const { status, practice } = appliedFilters;
  if (!status || !practice) return;

  const currentStatus = status.value || 'all';
  const currentPractice = practice.value || 'all';

  const statusValues = new Set();
  const practiceValues = new Set();
  apps.forEach((app) => {
    statusValues.add(normalizeApplicationStatus(app.status));
    const job = app.jobId || {};
    const area = String(job.practiceArea || '').trim();
    if (area) practiceValues.add(area);
  });

  const statusOptions = Array.from(statusValues).filter(Boolean).sort();
  const practiceOptions = Array.from(practiceValues).sort((a, b) => a.localeCompare(b));

  status.innerHTML = `<option value="all">All statuses</option>` +
    statusOptions.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(formatApplicationStatus(value))}</option>`).join('');
  practice.innerHTML = `<option value="all">All practice areas</option>` +
    practiceOptions.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');

  if (statusOptions.includes(currentStatus)) status.value = currentStatus;
  if (practiceOptions.includes(currentPractice)) practice.value = currentPractice;
}

function applyAppliedFilters() {
  const container = document.getElementById('appliedJobsList');
  if (!container) return;

  const { search, status, practice, dateRange } = appliedFilters;
  const query = String(search?.value || '').trim().toLowerCase();
  const statusFilter = String(status?.value || 'all');
  const practiceFilter = String(practice?.value || 'all');
  const rangeFilter = String(dateRange ? dateRange.value : 'all');

  let filtered = [...appliedAppsCache];

  if (query) {
    filtered = filtered.filter((app) => {
      const job = app.jobId || {};
      const title = String(job.title || '').toLowerCase();
      const area = String(job.practiceArea || '').toLowerCase();
      return title.includes(query) || area.includes(query);
    });
  }

  if (statusFilter !== 'all') {
    filtered = filtered.filter((app) => normalizeApplicationStatus(app.status) === statusFilter);
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
  const limited = appliedShowAll ? filtered : filtered.slice(0, DEFAULT_APPLIED_LIMIT);
  renderAppliedJobs(container, limited, total);
}

function renderAppliedJobs(container, apps, total) {
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
    updateAppliedCount(0, 0, true);
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
    updateAppliedCount(0, 0, false);
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

  updateAppliedCount(apps.length, total, false);
}

function updateAppliedCount(shown, total, hideToggle) {
  const { count, toggle } = appliedFilters;
  if (count) {
    count.textContent = total ? `Showing ${shown} of ${total}` : '';
  }
  if (toggle) {
    if (hideToggle || total <= DEFAULT_APPLIED_LIMIT) {
      toggle.hidden = true;
    } else {
      toggle.hidden = false;
      toggle.textContent = appliedShowAll ? 'Show recent' : 'View all';
    }
  }
}

function normalizeApplicationStatus(value) {
  const raw = String(value || 'submitted').trim().toLowerCase();
  return raw.replace(/\s+/g, '_');
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
    updateProfile(viewer);
    updateStats({
      activeCases: dashboard?.metrics?.activeCases,
      unreadMessages: unreadCount,
      nextDeadline: deriveNextDeadline(deadlines),
      monthEarnings: dashboard?.metrics?.earnings,
      payout30Days: dashboard?.metrics?.earningsLast30Days,
      nextPayout: dashboard?.metrics?.nextPayoutDate,
    });
    loadRecommendedJobs(viewer);
    loadAppliedJobs();
    renderDeadlines(deadlines);
    initLatestMessage(threads);
    renderAssignments(mapActiveCasesToAssignments(dashboard?.activeCases || []));
    renderInvites(invites);
  } catch (err) {
    console.warn('Paralegal dashboard init failed', err);
    renderAssignments([]);
    renderInvites([]);
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
