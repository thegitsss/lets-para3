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
  const data = await fetchParalegalData();
  updateProfile(data.profile);
  updateStats(data);
  renderDeadlines(data.deadlines);
  initLatestMessage(data.latestMessage);
  renderNotifications(data.notifications);
  if (selectors.recentActivity) {
    selectors.recentActivity.textContent = data.recentActivity || 'No updates yet.';
  }
  renderAssignments(data.assignments);
}

initDashboard();
