import { secureFetch } from "./auth.js";

const defaultParalegalData = {
  profile: {
    name: 'Taylor',
    avatar: 'https://via.placeholder.com/36',
  },
  stats: {
    activeCases: 2,
    unreadMessages: 2,
    nextDeadline: 'Nov 25',
    monthEarnings: 2050,
    payout30Days: 2050,
    nextPayout: 'Nov 30',
  },
  latestMessage: {
    name: 'Samantha S.',
    excerpt: 'Can you update the discovery log?',
  },
  deadlines: [
    { title: 'Jones LLC collaboration', detail: 'Upload exhibit review', due: 'Nov 25' },
    { title: 'Anderson merger support', detail: 'Draft summary', due: 'Nov 28' },
  ],
  notifications: [
    { title: 'New Assignment', body: 'Johnson & Co. invited you to collaborate.' },
    { title: 'Payment', body: '$820 released for “Samantha vs. Jones LLC”.' },
    { title: 'Reminder', body: 'Submit summary for the Anderson filing.' },
  ],
  recentActivity: 'Discovery Responses · Draft revisions uploaded yesterday.',
  assignments: [
    {
      title: 'Samantha vs. Jones LLC',
      attorney: 'Samantha Sider',
      due: 'Nov 30',
      status: 'Active',
      summary: 'Assist with drafting motions and reviewing exhibits. Focus on timeline summaries for court submission.',
      actions: {
        primary: { label: 'Open Workspace' },
        secondary: { label: 'Message Attorney' },
      },
    },
    {
      title: 'Anderson Merger Filing',
      attorney: 'J. Stone',
      due: 'Awaiting response',
      status: 'Invitation pending',
      summary: 'Support requested for due diligence and document prep. Confirm interest or decline the invitation.',
      actions: {
        primary: { label: 'View Posting' },
        secondary: { label: 'Respond' },
      },
    },
  ],
};

const selectors = {
  messageBox: document.getElementById('messageBox'),
  messageCount: document.getElementById('messageCount'),
  pluralText: document.getElementById('plural'),
  notificationBell: document.getElementById('notificationBell'),
  notificationPanel: document.getElementById('notificationPanel'),
  notificationList: document.getElementById('notificationList'),
  notificationBadge: document.querySelector('[data-field="notificationCount"]'),
  deadlineList: document.getElementById('deadlineList'),
  assignmentList: document.getElementById('assignmentList'),
  inviteList: document.getElementById('inviteList'),
  assignedCasesList: document.getElementById('assignedCasesList'),
  recentActivity: document.getElementById('recentActivity'),
  assignmentTemplate: document.getElementById('assignmentCardTemplate'),
  toastBanner: document.getElementById('toastBanner'),
  userAvatar: document.getElementById('user-avatar'),
};

async function fetchParalegalData() {
  try {
    const response = await secureFetch('/api/paralegals/me', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Unable to load paralegal data');
    return await response.json();
  } catch (error) {
    console.warn('[Paralegal Dashboard] Using fallback data:', error.message);
    return defaultParalegalData;
  }
}

function setField(field, value) {
  document.querySelectorAll(`[data-field="${field}"]`).forEach((el) => {
    el.textContent = value ?? '';
  });
}

function updateStats(data) {
  const stats = data.stats || {};
  setField('name', data.profile?.name || 'Paralegal');
  setField('welcomeSubheading', `You have ${stats.activeCases ?? 0} active assignment${stats.activeCases === 1 ? '' : 's'}`);
  setField('activeCases', stats.activeCases ?? 0);
  setField('unreadMessages', stats.unreadMessages ?? 0);
  if (selectors.pluralText) {
    selectors.pluralText.textContent = stats.unreadMessages === 1 ? ' waiting' : 's waiting';
  }
  setField('nextDeadline', stats.nextDeadline ?? '--');
  setField('monthEarnings', stats.monthEarnings ?? 0);
  setField('payout30Days', stats.payout30Days ?? 0);
  setField('nextPayout', stats.nextPayout ?? '—');
}

function renderDeadlines(deadlines = []) {
  const container = selectors.deadlineList;
  if (!container) return;
  container.innerHTML = '';
  if (!deadlines.length) {
    const line = document.createElement('div');
    line.className = 'info-line';
    line.textContent = '• No assigned deadlines.';
    container.appendChild(line);
    return;
  }
  deadlines.forEach((deadline) => {
    const line = document.createElement('div');
    line.className = 'info-line';
    const detail = deadline.detail ? ` – ${deadline.detail}` : '';
    const dueText = deadline.due ? ` by ${deadline.due}` : '';
    line.textContent = `• ${deadline.title}${detail}${dueText}`;
    container.appendChild(line);
  });
}

function renderNotifications(data = []) {
  const list = selectors.notificationList;
  if (!list) return;
  list.innerHTML = '';
  if (!data.length) {
    const empty = document.createElement('div');
    empty.className = 'notification-item';
    empty.textContent = "You're all caught up.";
    list.appendChild(empty);
  } else {
    data.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'notification-item';
      item.innerHTML = `<strong>${entry.title}:</strong> ${entry.body}`;
      list.appendChild(item);
    });
  }
  if (selectors.notificationBadge) {
    selectors.notificationBadge.textContent = data.length;
  }
}

function renderAssignments(assignments = []) {
  const container = selectors.assignmentList;
  if (!container || !selectors.assignmentTemplate) return;
  container.innerHTML = '';
  if (!assignments.length) {
    const empty = document.createElement('div');
    empty.className = 'case-card empty-state';
    empty.innerHTML = `
      <div class="case-header">
        <div>
          <h2>No active assignments</h2>
          <div class="case-subinfo">New invitations will appear here.</div>
        </div>
      </div>`;
    container.appendChild(empty);
    return;
  }

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
  container.innerHTML = '';
  if (!invites.length) {
    const empty = document.createElement('div');
    empty.className = 'case-card empty-state';
    empty.innerHTML = `
      <div class="case-header">
        <div>
          <h2>No pending invitations</h2>
          <div class="case-subinfo">New case invites will appear here.</div>
        </div>
      </div>`;
    container.appendChild(empty);
    return;
  }

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
    const res = await secureFetch('/api/cases/my-assigned', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('Unable to load assigned cases');
    const payload = await res.json().catch(() => ({}));
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

  selectors.messageBox?.addEventListener('click', () => {
  window.location.href = 'index.html#paralegal-messages';
  });

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
  const name = profile.name || 'Paralegal';
  setField('name', name);
  const heading = document.getElementById('user-name-heading');
  if (heading) heading.textContent = name;
  if (selectors.userAvatar && profile.avatar) {
    selectors.userAvatar.src = profile.avatar;
  }
}

function initLatestMessage(message = {}) {
  setField('latestMessageName', message.name || '—');
  setField('latestMessageExcerpt', message.excerpt || 'No new messages.');
}

function initQuickActions() {
  document.querySelectorAll('.quick-actions button[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      handleCaseAction(button.textContent || 'Action', 'your assignments');
    });
  });
}

async function initDashboard() {
  attachUIHandlers();
  initQuickActions();
  const [data, invites] = await Promise.all([fetchParalegalData(), loadInvites()]);
  updateProfile(data.profile);
  updateStats(data);
  renderDeadlines(data.deadlines);
  initLatestMessage(data.latestMessage);
  renderNotifications(data.notifications);
  if (selectors.recentActivity) {
    selectors.recentActivity.textContent = data.recentActivity || 'No updates yet.';
  }
  renderAssignments(data.assignments);
  renderInvites(invites);
  await loadAssignedCases();
}

document.addEventListener('DOMContentLoaded', () => {
  void bootParalegalDashboard();
});

async function bootParalegalDashboard() {
  const user = typeof window.requireRole === 'function' ? await window.requireRole('paralegal') : null;
  if (!user) return;
  applyRoleVisibility(user);
  state.viewerRole = String(user.role || '').toLowerCase();
  await initDashboard();
  document.getElementById('assignedCasesList')?.addEventListener('click', (event) => {
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
