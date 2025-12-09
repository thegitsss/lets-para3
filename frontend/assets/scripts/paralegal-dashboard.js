import { secureFetch } from "./auth.js";
import { getAvatarUrl } from "./helpers.js";

const selectors = {
  messageBox: document.getElementById('messageBox'),
  messageCount: document.getElementById('paralegalMessageCount'),
  pluralText: document.getElementById('paralegalMessagePlural'),
  notificationBell: document.getElementById('notificationBell'),
  notificationPanel: document.getElementById('notificationPanel'),
  notificationList: document.getElementById('paralegalNotificationList'),
  notificationBadge: document.getElementById('paralegalNotificationBadge'),
  deadlineList: document.getElementById('paralegalDeadlinesList'),
  assignmentList: document.getElementById('paralegalAssignmentList'),
  inviteList: document.getElementById('paralegalInviteList'),
  assignedCasesList: document.getElementById('paralegalAssignedCasesList'),
  recentActivity: document.getElementById('paralegalRecentActivity'),
  assignmentTemplate: document.getElementById('assignmentCardTemplate'),
  toastBanner: document.getElementById('toastBanner'),
  userAvatar: document.getElementById('paralegalAvatar'),
  nameHeading: document.getElementById('paralegalNameHeading'),
  welcomeCopy: document.getElementById('paralegalWelcomeCopy'),
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

function applyStoredProfile() {
  try {
    const stored = localStorage.getItem('lpc_user');
    if (!stored) return;
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') {
      updateProfile(parsed);
    }
  } catch {
    /* ignore */
  }
}

async function loadViewerProfile() {
  return fetchJson('/api/users/me');
}

async function fetchParalegalData() {
  return fetchJson('/api/paralegal/dashboard');
}

async function loadNotificationsFeed() {
  return fetchJson('/api/users/me/notifications').catch(() => ({ items: [], unread: 0 }));
}

async function loadDeadlineEvents(limit = 5) {
  const params = new URLSearchParams({ limit: String(limit) });
  return fetchJson(`/api/events?${params.toString()}`).then((data) => (Array.isArray(data.items) ? data.items : []));
}

async function loadMessageThreads(limit = 5) {
  return fetchJson(`/api/messages/threads?limit=${limit}`).then((data) => (Array.isArray(data.threads) ? data.threads : []));
}

async function loadUnreadMessageCount() {
  return fetchJson('/api/messages/unread-count').then((data) => Number(data.count) || 0);
}

function formatCurrency(value = 0) {
  const amount = Number(value) || 0;
  return amount.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function showPlaceholder(container, placeholderId) {
  if (!container) return;
  const placeholder = document.getElementById(placeholderId);
  if (!placeholder) return;
  if (placeholder.parentElement) {
    placeholder.remove();
  }
  placeholder.hidden = false;
  container.innerHTML = '';
  container.appendChild(placeholder);
}

function hidePlaceholder(placeholderId) {
  const placeholder = document.getElementById(placeholderId);
  if (!placeholder) return;
  placeholder.hidden = true;
  if (placeholder.parentElement) {
    placeholder.parentElement.removeChild(placeholder);
  }
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
    showPlaceholder(container, 'paralegalDeadlinesEmpty');
    return;
  }
  hidePlaceholder('paralegalDeadlinesEmpty');
  container.innerHTML = deadlines
    .map((deadline) => {
      const title = deadline.title || 'Deadline';
      const where = deadline.where ? ` · ${deadline.where}` : '';
      const dueText = deadline.start ? ` due ${new Date(deadline.start).toLocaleDateString()}` : '';
      return `<div class="info-line">• ${title}${where}${dueText}</div>`;
    })
    .join('');
}

function renderNotifications(items = [], unreadCount = 0) {
  const list = selectors.notificationList;
  if (!list) return;
  if (!items.length) {
    showPlaceholder(list, 'paralegalNotificationsEmpty');
  } else {
    hidePlaceholder('paralegalNotificationsEmpty');
    list.innerHTML = items
      .slice(0, 5)
      .map((entry) => `<div class="notification-item"><strong>${entry.title || 'Update'}:</strong> ${entry.body || ''}</div>`)
      .join('');
  }
  if (selectors.notificationBadge) {
    if (unreadCount > 0) {
      selectors.notificationBadge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      selectors.notificationBadge.hidden = false;
    } else {
      selectors.notificationBadge.textContent = '';
      selectors.notificationBadge.hidden = true;
    }
  }
  if (selectors.recentActivity) {
    selectors.recentActivity.textContent = items[0]?.body || 'No updates yet.';
  }
}

function renderAssignments(assignments = []) {
  const container = selectors.assignmentList;
  if (!container || !selectors.assignmentTemplate) return;
  if (!assignments.length) {
    showPlaceholder(container, 'paralegalAssignmentsEmpty');
    return;
  }
  hidePlaceholder('paralegalAssignmentsEmpty');
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
    const status = assignment.status ? `Status: ${assignment.status}` : '';
    const metaParts = [attorney, due, status].filter(Boolean);

    titleEl.textContent = assignment.title || 'Case';
    metaEl.textContent = metaParts.join(' · ');
    summaryEl.textContent = assignment.summary || '';

    header.addEventListener('click', () => card.classList.toggle('open'));

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
    status: caseItem.status ? caseItem.status.replace(/_/g, ' ') : '',
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
    showPlaceholder(container, 'paralegalInvitesEmpty');
    return;
  }
  hidePlaceholder('paralegalInvitesEmpty');
  container.innerHTML = '';

  invites.forEach((invite) => {
    const card = document.createElement('div');
    card.className = 'case-card';

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
    const declineBtn = document.createElement('button');
    declineBtn.textContent = 'Decline';
    declineBtn.dataset.inviteAction = 'decline';
    declineBtn.dataset.caseId = invite.id || invite._id;
    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);
    body.appendChild(actions);
    card.appendChild(body);
    container.appendChild(card);
  });

  container.querySelectorAll('[data-invite-action]').forEach((button) => {
    button.addEventListener('click', () => respondToInvite(button.dataset.caseId, button.dataset.inviteAction, button));
  });
}

async function respondToInvite(caseId, action, button) {
  if (!caseId || !action) return;
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
    const invites = await loadInvites();
    renderInvites(invites);
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
  if (!items.length) {
    list.innerHTML = '<p>No assigned cases.</p>';
    return;
  }
  list.innerHTML = items
    .map(
      (c) => `
      <div class="case-item" data-id="${c._id}">
        <div class="case-title">${c.title || 'Untitled Case'}</div>
        <div class="case-meta">
          <span>${c.caseNumber || ''}</span>
          <span>Attorney: ${c.attorneyName || ''}</span>
          <span>Status: ${c.status || 'Active'}</span>
        </div>
        <button class="open-case-btn" data-id="${c._id}">Open Case</button>
      </div>`
    )
    .join('');
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
  if (stagedToast?.message) {
    toastHelper.show(stagedToast.message, { targetId: selectors.toastBanner.id, type: stagedToast.type });
  }

  selectors.notificationBell?.addEventListener('click', (event) => {
    event.stopPropagation();
    selectors.notificationPanel?.classList.toggle('show');
  });

  document.addEventListener('click', (event) => {
    if (!selectors.notificationBell?.contains(event.target)) {
      selectors.notificationPanel?.classList.remove('show');
    }
  });
}

function updateProfile(profile = {}) {
  const composedName =
    [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || profile.name || 'Paralegal';
  setField('name', composedName);
  if (selectors.nameHeading) {
    selectors.nameHeading.textContent = composedName;
  }
  if (selectors.userAvatar) {
    selectors.userAvatar.src = getAvatarUrl(profile);
    selectors.userAvatar.alt = `${composedName}'s avatar`;
  }
  if (profile.profileImage) {
    const a = document.querySelector('#user-avatar');
    if (a) a.src = profile.profileImage;
  }
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

function initLatestMessage(threads = []) {
  if (!threads.length) {
    setField('latestMessageName', 'Inbox');
    setField('latestMessageExcerpt', 'No new messages.');
    return;
  }
  const latest = threads[0];
  setField('latestMessageName', latest.title || 'Case thread');
  setField('latestMessageExcerpt', latest.lastMessageSnippet || 'No new messages.');
}

function initQuickActions() {
  document.querySelectorAll('.quick-actions button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      handleCaseAction(button.textContent || 'Action', 'your assignments');
    });
  });
}

async function loadRecommendedCases() {
  try {
    const res = await fetch('/api/cases/recommended', { credentials: 'include' });
    const data = await res.json().catch(() => []);
    const list = document.querySelector('#recommendedPostingsCard .recommendations-list');
    if (!list) return;
    list.innerHTML = '';
    if (!Array.isArray(data) || !data.length) {
      const empty = document.createElement('li');
      empty.className = 'recommended-item';
      const title = document.createElement('span');
      title.classList.add('rec-title');
      title.textContent = 'No recommended postings yet.';
      empty.appendChild(title);
      list.appendChild(empty);
      return;
    }
    data.forEach((caseObj = {}) => {
      const li = document.createElement('li');
      li.classList.add('recommended-item');
      const title = document.createElement('span');
      title.classList.add('rec-title');
      title.textContent = caseObj.title || 'Untitled posting';
      const link = document.createElement('a');
      link.classList.add('rec-open-link');
      link.textContent = 'Open';
      const id = caseObj._id || caseObj.id || '';
      link.href = id ? `/case-detail.html?id=${encodeURIComponent(id)}` : '#';
      link.target = '_self';
      li.appendChild(title);
      li.appendChild(link);
      list.appendChild(li);
    });
  } catch (err) {
    console.error('Failed to load recommended cases', err);
  }
}

async function initDashboard() {
  attachUIHandlers();
  initQuickActions();
  loadRecommendedCases();
  try {
    const [profile, dashboard, invites, deadlines, threads, notifications, unreadCount] = await Promise.all([
      loadViewerProfile().catch(() => ({})),
      fetchParalegalData().catch(() => ({})),
      loadInvites().catch(() => []),
      loadDeadlineEvents().catch(() => []),
      loadMessageThreads().catch(() => []),
      loadNotificationsFeed().catch(() => ({ items: [], unread: 0 })),
      loadUnreadMessageCount().catch(() => 0),
    ]);
    updateProfile(profile || {});
    const paralegalAvatarEl = document.getElementById('paralegalAvatar');
    if (paralegalAvatarEl) {
      paralegalAvatarEl.src = getAvatarUrl(profile || {});
    }
    updateStats({
      activeCases: dashboard?.metrics?.activeCases,
      unreadMessages: unreadCount,
      nextDeadline: deriveNextDeadline(deadlines),
      monthEarnings: dashboard?.metrics?.earnings,
      payout30Days: dashboard?.metrics?.earningsLast30Days,
      nextPayout: dashboard?.metrics?.nextPayoutDate,
    });
    renderDeadlines(deadlines);
    initLatestMessage(threads);
    renderNotifications(notifications.items || [], notifications.unread || 0);
    renderAssignments(mapActiveCasesToAssignments(dashboard?.activeCases || []));
    renderInvites(invites);
  } catch (err) {
    console.warn('Paralegal dashboard init failed', err);
    renderAssignments([]);
    renderInvites([]);
    renderDeadlines([]);
    initLatestMessage([]);
    renderNotifications([], 0);
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
  if (window.state) {
    window.state.viewerRole = String(user.role || '').toLowerCase();
  }
  applyStoredProfile();
  await initDashboard();
  const assignedCasesEl = document.getElementById('paralegalAssignedCasesList');
  assignedCasesEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('.open-case-btn');
    if (!btn) return;
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
