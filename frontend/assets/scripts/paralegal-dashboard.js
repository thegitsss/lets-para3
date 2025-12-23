import { secureFetch } from "./auth.js";

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

async function loadViewerProfile() {
  const profile = await fetchJson('/api/users/me');
  viewerProfile = profile || null;
  return profile;
}

async function fetchParalegalData() {
  return fetchJson('/api/paralegal/dashboard');
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
    container.innerHTML = '<p class="info-line">No invitations yet.</p>';
    return;
  }
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
    closeInviteOverlay();
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
  const status = invite?.status ? invite.status.replace(/_/g, ' ') : '';
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
    inviteAcceptBtn.disabled = !caseId;
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
  setField('name', composedName);
  if (selectors.nameHeading) {
    selectors.nameHeading.textContent = composedName;
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

async function initDashboard() {
  attachUIHandlers();
  initQuickActions();
  try {
    const [profile, dashboard, invites, deadlines, threads, unreadCount] = await Promise.all([
      loadViewerProfile().catch(() => ({})),
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

function initAvailabilityModal() {
  const modal = document.getElementById("availabilityModal");
  const openBtn = document.getElementById("updateAvailabilityLink");
  const saveBtn = document.getElementById("saveAvailabilityBtn");
  const cancelBtn = document.getElementById("cancelAvailabilityBtn");
  const statusInput = document.getElementById("availabilityStatusInput");
  const dateInput = document.getElementById("availabilityDateInput");
  const statusDisplay = document.getElementById("availabilityStatus");
  const nextDisplay = document.getElementById("availabilityNext");
  const quickActionBtn = document.querySelector('.quick-actions [data-action="availability"]');

  if (!modal) console.error("❌ availabilityModal not found");
  if (!openBtn) console.error("❌ updateAvailabilityLink not found");

  if (!modal) return;

  const showModal = (event) => {
    event?.preventDefault();
    if (!modal) return;
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

  if (saveBtn && statusInput && dateInput && statusDisplay && nextDisplay) {
    saveBtn.addEventListener("click", async () => {
      const status = statusInput.value;
      const nextDate = dateInput.value;

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
        if (friendly) {
          nextDisplay.textContent = `Available on ${friendly}`;
        } else {
          nextDisplay.textContent = "This week";
        }

        persistAvailabilityState(availabilityLabel, {
          status: details.status || status,
          nextAvailable: details.nextAvailable || (nextDate ? new Date(nextDate).toISOString() : null),
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
