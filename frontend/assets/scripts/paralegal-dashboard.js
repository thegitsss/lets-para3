import { loadReceivedInvitations } from "./utils/received-invitations.mjs";
import { createEarlierApplicationWithdrawal } from "./utils/earlier-application-withdrawal.mjs";
import { secureFetch, getStoredSession, publishLifecycleRefresh } from "./auth.js";
import { readEarningsReport, readExpectedCompensation, renderEarningsReport } from "./utils/paralegal-financials.mjs";
import { loadHomeDeadlines } from "./paralegal-v2/home-deadlines.mjs";
import { calendarRange, calendarRows, renderCalendar } from "./legacy-paralegal-calendar.mjs";
import { availabilitySnapshot, saveAvailability } from "./utils/availability-save.mjs";

let financialOwnerId = "";
let financialGeneration = 0;
let homeAccountLost = false;
const homeReadControllers = new Map();
const currentFinancialOwner = () => {
  if (homeAccountLost) return '';
  const { user, role, status } = getStoredSession();
  const id = String(user?.id || user?._id || "");
  return role === "paralegal" && status === "approved" && id === financialOwnerId ? id : "";
};
async function earlierWithdrawalRequest(url, body) {
  const response = await secureFetch(url, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), suppressToast: true });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || 'The application could not be checked.');
  return payload;
}
const earlierWithdrawal = createEarlierApplicationWithdrawal({ getOwner: currentFinancialOwner, get: earlierWithdrawalRequest, post: earlierWithdrawalRequest });
function renderFinancialSummary(metrics) {
  const root = document.getElementById("paralegalFinancialSummary");
  if (!root) return;
  const ownerId = currentFinancialOwner();
  let report = null, expected = null;
  try { report = readEarningsReport(metrics?.earningsReport, ownerId); } catch {}
  try { expected = readExpectedCompensation(metrics?.expectedCompensation, ownerId); } catch {}
  root.replaceChildren(renderEarningsReport(report, { expected, onRetry: () => refreshDashboardFromServer("payouts", { force: true }) }));
}
function clearFinancialSummary() { financialGeneration++; renderFinancialSummary(null); }

import {
  getRecommendationIdentityIds,
  shouldHandleRecommendationHistoryChange,
  subscribeRecommendationHistoryChanges,
} from "./recommendation-state.mjs";
import {
  getStripeConnectStatus,
  isStripeConnected,
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

const PLACEHOLDER_AVATAR = "/assets/avatar-placeholder.svg";
const PARALEGAL_DASHBOARD_ENDPOINT = "/api/paralegal/dashboard";

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
  deadlineList: document.getElementById('deadlineList'),
  assignmentList: document.getElementById('assignmentList'),
  toastBanner: document.getElementById('toastBanner'),
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
  homeWorkSection: document.getElementById('homeWorkSection'),
  homeApplicationsList: document.getElementById('homeApplicationsList'),
  recommendedMattersSection: document.getElementById('recommendedMattersSection'),
  recommendedMattersList: document.getElementById('recommendedMattersList'),
  homeProfileStates: document.getElementById('homeProfileStates'),
  homeProfilePractices: document.getElementById('homeProfilePractices'),
  homeProfileExperience: document.getElementById('homeProfileExperience'),
  homeReturningOverview: document.getElementById('homeReturningOverview'),
  homeApplicationsSection: document.getElementById('homeApplicationsSection'),
  homeApplicationPipeline: document.getElementById('homeApplicationPipeline'),
  privateOfficeSummary: document.getElementById('privateOfficeSummary'),
  deskMatterSwitcher: document.getElementById('deskMatterSwitcher'),
  deskMatterPosition: document.getElementById('deskMatterPosition'),
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
  if (dashboardDeparting) throw new DOMException("View changed", "AbortError");
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
const applicationPreEngagementDrafts = new Map();
let applicationDraftGeneration = 0;
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
let dashboardDeparting = false;
let dashboardRefreshInFlight = false;
let dashboardRefreshGeneration = 0;
let dashboardRefreshQueuedReason = '';
let lastDashboardRefreshAt = 0;
const DASHBOARD_REFRESH_COOLDOWN_MS = 4000;
let applicationRefreshGeneration = 0;
let clusterMenuBound = false;
let recommendationProfile = {};
let recommendedJobsCache = [];
let recommendationViewerId = '';
let recommendationHistorySubscription = null;
let recommendationRefreshGeneration = 0;
let recommendationHasMatchingProfile = false;
let availabilityRefreshGeneration = 0;
let stripeStatusKnown = false;
let profileStatusKnown = false;
let dashboardStatus = 'loading';
let calendarController = null;
let calendarSnapshot = { rows: [], unavailable: [], loading: true };
let homeMessagesPhase = 'loading';
let homeApplicationsPhase = 'loading';
let pendingAppliedFilters = null;
let homeDetailsPhase = 'loading';
let recommendationStatus = 'loading';
let deskAssignments = [];
let deskMatterIndex = 0;
let deskSwitcherBound = false;
let deskEnrichmentGeneration = 0;
let initialDashboardHydrating = true;
let rankedRecommendationsCache = [];
let officeMetrics = { activeCases: 0, unread: 0, nextDeadline: '—' };
let dashboardPayloadFingerprint = '';
let recommendationPayloadFingerprint = '';
let applicationPayloadFingerprint = '';
let assignmentsSourceFingerprint = '';
const homeSectionRenderStates = new WeakMap();

function dataFingerprint(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    console.warn('Unable to compare refreshed dashboard data', error);
    return '';
  }
}

function renderHomeSectionWhenChanged(container, source, render) {
  const fingerprint = dataFingerprint({ ownerId: currentFinancialOwner(), source });
  const previous = homeSectionRenderStates.get(container);
  if (fingerprint && previous?.fingerprint === fingerprint &&
      previous.first === container.firstElementChild && previous.last === container.lastElementChild) return;
  render();
  homeSectionRenderStates.set(container, {
    fingerprint,
    first: container.firstElementChild,
    last: container.lastElementChild,
  });
}

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

function clearHomeAccount() {
  if (homeAccountLost) return;
  homeAccountLost = true; ++dashboardRefreshGeneration; ++deskEnrichmentGeneration; ++applicationRefreshGeneration;
  for (const controller of homeReadControllers.values()) controller.abort(); homeReadControllers.clear(); calendarController?.abort();
  deskAssignments = []; appliedAppsCache = []; clearFinancialSummary();
  paralegalPrioritySnapshot = { activeCases: [], invites: [], threads: [], deadlines: [], applications: [] };
  clearApplicationDraftsOnAccountChange();
  const root = document.getElementById('paralegalHomeView'); if (!root) return;
  const notice = document.createElement('p'); notice.className = 'private-office-secondary-state'; notice.textContent = 'Your account changed. Reload to continue.';
  const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'office-calendar-control'; reload.textContent = 'Reload'; reload.addEventListener('click', () => window.location.reload());
  root.classList.remove('is-hydrating'); root.dataset.state = 'account-changed'; root.replaceChildren(notice, reload);
  window.dispatchEvent(new CustomEvent('lpc:home-account-changed'));
}

async function readOwnedHome(key, read) {
  const ownerId = currentFinancialOwner(); if (dashboardDeparting) throw new DOMException('View changed', 'AbortError'); if (!ownerId) throw new Error('Workspace account needs verification.');
  homeReadControllers.get(key)?.abort(); const controller = new AbortController(); homeReadControllers.set(key, controller);
  const options = { signal: controller.signal, cache: 'no-store' }, timer = setTimeout(() => controller.abort(), 30000);
  const current = () => { if (dashboardDeparting || controller.signal.aborted || currentFinancialOwner() !== ownerId) throw new DOMException('View changed', 'AbortError'); };
  const verify = async () => {
    current(); const session = await fetchJson('/api/auth/me', options); current();
    const user = session?.user;
    if (String(user?._id || user?.id || '') !== ownerId || user?.role !== 'paralegal' || user?.status !== 'approved') { clearHomeAccount(); throw new Error('Workspace account changed.'); }
  };
  try { await verify(); const value = await read(options, ownerId); await verify(); return value; }
  finally { clearTimeout(timer); if (homeReadControllers.get(key) === controller) homeReadControllers.delete(key); }
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
  return readOwnedHome('profile', async (options, ownerId) => {
    const profile = await fetchJson('/api/users/me', options);
    if (String(profile?._id || profile?.id || '') !== ownerId) throw new Error('Profile could not be verified.');
    return profile;
  });
}

async function loadStripeStatus() {
  const data = await getStripeConnectStatus({ force: true });
  stripeConnected = isStripeConnected(data);
  stripeStatusKnown = data !== null && typeof data === 'object';
  applyStripeGateToApplyActions();
  renderPrivateOfficeDesk();
  renderParalegalPriorityQueue();
  return data;
}

async function fetchParalegalData({ fresh = false } = {}) {
  const ownerId = currentFinancialOwner(), generation = financialGeneration;
  if (!ownerId) throw new Error("Workspace account needs verification.");
  const query = new URLSearchParams({ expectedOwnerId: ownerId });
  if (fresh) query.set("ts", String(Date.now()));
  const value = await fetchJson(`${PARALEGAL_DASHBOARD_ENDPOINT}?${query}`, { cache: "no-store" });
  if (generation !== financialGeneration || ownerId !== currentFinancialOwner()) throw new Error("Workspace account changed.");
  return value;
}

async function loadDeadlineEvents() {
  const ownerId = currentFinancialOwner(), generation = financialGeneration;
  calendarController?.abort(); const controller = new AbortController(); calendarController = controller;
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const value = await loadHomeDeadlines({ get: fetchJson }, ownerId, calendarRange(), { signal: controller.signal, isCurrent: () => currentFinancialOwner() === ownerId && financialGeneration === generation });
    return value.items;
  } finally { clearTimeout(timeout); }
}

async function loadHomeMessages() {
  homeMessagesPhase = 'loading';
  try {
    const value = await readOwnedHome('messages', async options => {
      const [summary, count] = await Promise.all([fetchJson('/api/messages/summary', options), fetchJson('/api/messages/unread-count', options)]);
      if (!Array.isArray(summary?.items) || !Number.isSafeInteger(count?.count) || count.count < 0) throw new Error('Message counts could not be verified.');
      const ids = new Set(); let total = 0;
      for (const item of summary.items) {
        if (!/^[a-f0-9]{24}$/i.test(item?.caseId || '') || ids.has(item.caseId) || !Number.isSafeInteger(item.unread) || item.unread < 0) throw new Error('Message counts could not be verified.');
        ids.add(item.caseId); total += item.unread;
      }
      if (!Number.isSafeInteger(total) || total !== count.count) throw new Error('Message counts changed. Refresh to check the current conversations.');
      return { threads: summary.items, unreadCount: total };
    });
    homeMessagesPhase = 'ready'; return value;
  } catch (error) { homeMessagesPhase = 'error'; throw error; }
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

function getRecommendationId(job = {}) {
  return normalizeIdCandidate(
    job.caseId || job.case_id || job.case || job.id || job._id || job.jobId || job.job_id || ''
  );
}

function getRecommendationPay(job = {}) {
  if (Number(job.remainingAmount) > 0) return Number(job.remainingAmount) / 100;
  if (Number(job.lockedTotalAmount) > 0) return Number(job.lockedTotalAmount) / 100;
  if (Number(job.totalAmount) > 0) return Number(job.totalAmount) / 100;
  if (Number(job.payAmount) > 0) return Number(job.payAmount);
  if (Number(job.budget) > 0) return Number(job.budget);
  return 0;
}

function getApplicationJobId(application = {}) {
  const job = application.jobId || application.job || {};
  return normalizeIdCandidate(
    job?._id || job?.id || application.jobId || application.job_id || application.caseId || ''
  );
}

function describeHomeApplicationStatus(application = {}) {
  const preEngagement = getApplicationPreEngagement(application);
  if (['requested', 'changes_requested'].includes(String(preEngagement?.status || '').toLowerCase())) {
    return { label: 'Information requested', tone: 'action' };
  }
  const status = getApplicationStatusKey(application);
  const labels = {
    submitted: 'Submitted',
    viewed: 'Viewed by attorney',
    shortlisted: 'Shortlisted',
    accepted: 'Accepted',
    rejected: 'Not selected',
  };
  return {
    label: labels[status] || formatApplicationStatus(status),
    tone: ['viewed', 'shortlisted'].includes(status) ? 'progress' : status,
  };
}

function renderHomeApplications(applications = []) {
  const container = selectors.homeApplicationPipeline;
  const otherContainer = selectors.homeApplicationsList;
  if (!container) return;
  const visible = (Array.isArray(applications) ? applications : [])
    .filter(isActiveApplication)
    .sort((left, right) => (
      new Date(right?.updatedAt || right?.createdAt || 0) - new Date(left?.updatedAt || left?.createdAt || 0)
    ));
  if (!visible.length) {
    selectors.homeApplicationsSection?.classList.add('is-empty');
    container.innerHTML = `
      <p class="private-office-secondary-state">No applications in progress</p>`;
    if (otherContainer) otherContainer.innerHTML = '';
    return;
  }

  selectors.homeApplicationsSection?.classList.remove('is-empty');

  const application = visible[0];
  const job = application.jobId || application.job || {};
  const applicationId = normalizeIdCandidate(application._id || application.id || '');
  const jobId = getApplicationJobId(application);
  const href = applicationId
    ? `dashboard-paralegal.html?applicationId=${encodeURIComponent(applicationId)}#cases`
    : jobId
      ? `dashboard-paralegal.html?jobId=${encodeURIComponent(jobId)}#cases`
      : 'dashboard-paralegal.html#cases';
  const appliedDate = application.createdAt
    ? new Date(application.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '';
  container.innerHTML = `
    <article class="application-motion">
      <div class="application-motion__matter">
        <strong>${escapeHtml(job.title || 'Untitled Matter')}</strong>
        <span>${escapeHtml([job.practiceArea, appliedDate ? `Applied ${appliedDate}` : ''].filter(Boolean).join(' · '))}</span>
      </div>
      <p class="application-current-status">${escapeHtml(describeHomeApplicationStatus(application).label)}</p>
      <a class="application-motion__action" href="${escapeHtml(href)}">View application</a>
    </article>`;
  if (otherContainer) {
    const others = visible.length - 1;
    otherContainer.innerHTML = others > 0
      ? `<a class="application-other-link" href="dashboard-paralegal.html#cases">${others} other active application${others === 1 ? '' : 's'}</a>`
      : '';
  }
}

function renderRecommendedMatters(jobs = [], { hasMatchingProfile = recommendationHasMatchingProfile } = {}) {
  const container = selectors.recommendedMattersList;
  if (!container) return;
  recommendedJobsCache = Array.isArray(jobs) ? jobs : [];
  recommendationHasMatchingProfile = Boolean(hasMatchingProfile);
  const visible = recommendedJobsCache.slice(0, 3);
  rankedRecommendationsCache = recommendedJobsCache;
  recommendationStatus = 'ready';
  renderPrivateOfficeDesk();

  renderHomeSectionWhenChanged(container, { visible, hasMatchingProfile }, () => {
    renderRecommendedMatterRows(container, visible, hasMatchingProfile);
  });
}

function renderRecommendedMatterRows(container, visible, hasMatchingProfile) {
  if (!visible.length) {
    container.innerHTML = `
      <div class="private-office-secondary-state">
        <strong>${hasMatchingProfile ? 'No matters to show right now.' : 'Complete your profile to explore matters.'}</strong>
        ${hasMatchingProfile ? '' : '<a href="profile-settings.html">Update profile</a>'}
      </div>`;
    return;
  }

  container.innerHTML = visible.map((job) => {
    const id = getRecommendationId(job);
    const pay = getRecommendationPay(job);
    const location = job.state || job.locationState || job.location?.state || job.jurisdiction || '';
    const compensation = pay > 0 ? formatCurrency(pay) : 'Not listed';
    const deadlineValue = job.deadlineDate || job.deadline || '';
    const deadline = deadlineValue ? formatMatterDeadline(deadlineValue) : '';
    return `
      <article class="matter-folio">
        <div>
          <h3>${escapeHtml(job.title || 'Untitled Matter')}</h3>
        </div>
        <dl>
          ${job.practiceArea ? `<div><dt>Practice</dt><dd>${escapeHtml(job.practiceArea)}</dd></div>` : ''}
          ${location ? `<div><dt>State</dt><dd>${escapeHtml(location)}</dd></div>` : ''}
          ${deadline ? `<div><dt>Deadline</dt><dd>${escapeHtml(deadline)}</dd></div>` : ''}
          <div><dt>Compensation</dt><dd>${escapeHtml(compensation)}</dd></div>
        </dl>
        <footer><a href="browse-jobs.html?id=${encodeURIComponent(id)}">Details</a></footer>
      </article>`;
  }).join('');
}

function renderRecommendationLoading() {
  recommendationStatus = 'loading';
  renderPrivateOfficeDesk();
  selectors.recommendedMattersSection?.setAttribute('aria-busy', 'true');
  if (!selectors.recommendedMattersList) return;
  selectors.recommendedMattersList.innerHTML = `
    <div class="private-office-secondary-state">
      <strong>Loading open matters…</strong>
    </div>`;
}

function renderRecommendationUnavailable(error) {
  recommendationStatus = 'error';
  rankedRecommendationsCache = [];
  renderPrivateOfficeDesk();
  console.warn('Unable to load recommended matters', error);
  selectors.recommendedMattersSection?.removeAttribute('aria-busy');
  if (!selectors.recommendedMattersList) return;
  selectors.recommendedMattersList.innerHTML = `
    <div class="private-office-secondary-state">
      <strong>Matter listings are unavailable</strong>
      <p>You can still view every open opportunity on the Matter board.</p>
    </div>`;
}

async function loadRecommendedMatters(options = {}) {
  const generation = ++recommendationRefreshGeneration;
  if (!options.silent) renderRecommendationLoading();
  try {
    const projection = await readOwnedHome('recommendations', options => fetchJson('/api/jobs/recommended', options));
    if (generation !== recommendationRefreshGeneration) return { stale: true };
    if (!Array.isArray(projection?.items) || typeof projection.hasMatchingProfile !== 'boolean') throw new Error('Matter listings could not be verified.');
    const listings = projection.items;
    const nextFingerprint = dataFingerprint(projection);
    if (options.silent && recommendationStatus === 'ready' && nextFingerprint && nextFingerprint === recommendationPayloadFingerprint) {
      selectors.recommendedMattersSection?.removeAttribute('aria-busy');
      return { stale: false, projection };
    }
    recommendationPayloadFingerprint = nextFingerprint;
    selectors.recommendedMattersSection?.removeAttribute('aria-busy');
    renderRecommendedMatters(listings, { hasMatchingProfile: projection?.hasMatchingProfile });
    return { stale: false, projection };
  } catch (error) {
    if (generation !== recommendationRefreshGeneration) return { stale: true, error };
    renderRecommendationUnavailable(error);
    return { stale: false, error };
  }
}

function handleRecommendationHistoryChange(payload = {}) {
  if (!shouldHandleRecommendationHistoryChange(payload, recommendationViewerId)) return;
  const changedIds = new Set([
    ...(payload.caseIds || []), ...(payload.jobIds || []), ...(payload.matterIds || []),
  ].map((value) => String(value || '')).filter(Boolean));
  recommendedJobsCache = recommendedJobsCache.filter(
    (job) => !getRecommendationIdentityIds(job).some((id) => changedIds.has(id))
  );
  renderRecommendedMatters(recommendedJobsCache);
  void loadRecommendedMatters();
}

function setupRecommendationHistorySync() {
  if (recommendationHistorySubscription) return;
  recommendationHistorySubscription = subscribeRecommendationHistoryChanges(
    handleRecommendationHistoryChange
  );
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

function updateStats(stats = {}) {
  const activeCases = Number(stats.activeCases ?? 0);
  const unread = Number.isSafeInteger(stats.unreadMessages) ? stats.unreadMessages : null;
  const nextDeadline = stats.nextDeadline ?? '—';

  setField('homeActiveMatters', activeCases);
  setField('homeNextDeadline', nextDeadline);
  setField('homeUnreadMessages', unread);
  officeMetrics = { activeCases, unread, nextDeadline };
  updatePrivateOfficeSummary();
  if (selectors.homeReturningOverview) selectors.homeReturningOverview.hidden = true;
}

function updatePrivateOfficeSummary() {
  const node = selectors.privateOfficeSummary;
  if (!node) return;
  const parts = [];
  if (officeMetrics.activeCases > 0) {
    parts.push(`${officeMetrics.activeCases} active Matter${officeMetrics.activeCases === 1 ? '' : 's'}`);
  }
  if (officeMetrics.unread > 0) {
    parts.push(`${officeMetrics.unread} unread message${officeMetrics.unread === 1 ? '' : 's'}`);
  }
  if (officeMetrics.nextDeadline && officeMetrics.nextDeadline !== '—') {
    parts.push(`next deadline ${officeMetrics.nextDeadline}`);
  }
  node.textContent = parts.join(' · ');
  node.hidden = parts.length === 0;
}

function buildDashboardSnapshot({ dashboard = null, invites = [], deadlines = null, messages = null } = {}) {
  const activeCases = Array.isArray(dashboard?.activeCases) ? dashboard.activeCases : [];
  const normalizedInvites = Array.isArray(invites) ? invites : [];
  const normalizedThreads = messages?.threads || [];
  const normalizedDeadlines = calendarRows({ matters: activeCases, reminders: Array.isArray(deadlines) ? deadlines : [], ownerId: currentFinancialOwner() });
  return {
    dashboard,
    activeCases,
    invites: normalizedInvites,
    deadlines: normalizedDeadlines,
    deadlineUnavailable: [...(!dashboard ? ['Matter deadlines'] : []), ...(!Array.isArray(deadlines) ? ['Private reminders'] : [])],
    threads: normalizedThreads,
    unreadCount: messages?.unreadCount ?? null,
  };
}

function renderDashboardSnapshot(snapshot, { preserveDashboardOnFailure = false, deferAssignments = false } = {}) {
  renderFinancialSummary(snapshot.dashboard?.metrics);
  if (snapshot.dashboard || !preserveDashboardOnFailure) {
    updateStats({
      activeCases: snapshot.dashboard?.metrics?.activeCases,
      unreadMessages: snapshot.unreadCount,
      nextDeadline: deriveNextDeadline(snapshot.deadlines),
    });
    if (!deferAssignments) {
      renderAssignments(mapActiveCasesToAssignments(snapshot.activeCases, snapshot.threads));
    }
  }
  renderDeadlines(snapshot.deadlines, snapshot.deadlineUnavailable);
  syncRecentActivityState({
    invites: snapshot.invites,
    threads: snapshot.threads,
    deadlines: snapshot.deadlines,
  });
  maybeOpenInviteFromQuery();
}

async function refreshDashboardFromServer(reason = '', { force = false } = {}) {
  if (dashboardDeparting || !currentFinancialOwner()) return;
  if (dashboardRefreshInFlight) {
    dashboardRefreshQueuedReason = reason || 'queued';
    return;
  }
  const now = Date.now();
  if (!force && now - lastDashboardRefreshAt < DASHBOARD_REFRESH_COOLDOWN_MS) return;
  const generation = ++dashboardRefreshGeneration;
  dashboardRefreshInFlight = true;
  if (force) assignmentsSourceFingerprint = '';
  clearFinancialSummary();
  lastDashboardRefreshAt = now;
  try {
    const [dashboard, invites, deadlines, messages, profileRead] = await Promise.all([
      fetchParalegalData({ fresh: true }).catch((err) => {
        console.warn('Paralegal dashboard payload refresh failed', reason || '', err);
        return null;
      }),
      loadInvites().catch((err) => {
        console.warn('Paralegal invites refresh failed', reason || '', err);
        return [];
      }),
      loadDeadlineEvents().catch((err) => {
        console.warn('Paralegal deadlines refresh failed', reason || '', err);
        return null;
      }),
      loadHomeMessages().catch((err) => {
        console.warn('Paralegal messages refresh failed', reason || '', err);
        return null;
      }),
      loadViewerProfile().then(value => ({ value })).catch(error => ({ error })),
    ]);

    // A newer refresh was requested while this snapshot was in flight. The
    // queued read will commit current work; do not briefly paint this result.
    if (generation !== dashboardRefreshGeneration || dashboardRefreshQueuedReason) return;
    if (profileRead.value) updateProfile(profileRead.value);
    else if (profileRead.error?.name !== 'AbortError') updateProfile({});

    const snapshot = buildDashboardSnapshot({ dashboard, invites, deadlines, messages });
    renderFinancialSummary(dashboard?.metrics);
    const nextDashboardFingerprint = dataFingerprint(snapshot);
    const dashboardChanged = !nextDashboardFingerprint || nextDashboardFingerprint !== dashboardPayloadFingerprint;
    if (dashboardChanged) {
      dashboardPayloadFingerprint = nextDashboardFingerprint;
      dashboardStatus = dashboard ? 'ready' : 'error';
      renderDashboardSnapshot(snapshot);
    } else if (dashboard && force) { renderAssignments(mapActiveCasesToAssignments(snapshot.activeCases, snapshot.threads)); }
    await loadAppliedJobs({ preservePage: true, silent: true });
    if (generation !== dashboardRefreshGeneration) return;
    await loadRecommendedMatters({ silent: true });
    if (generation !== dashboardRefreshGeneration) return;
    if (dashboardChanged || force) {
      paralegalPrioritySnapshot = {
        activeCases: snapshot.activeCases,
        invites: snapshot.invites,
        threads: snapshot.threads,
        deadlines: snapshot.deadlines,
        applications: appliedAppsCache,
      };
      renderParalegalPriorityQueue();
      notifyCasesApplicationsRefresh(reason, {
        activeCases: snapshot.activeCases,
        dashboardAvailable: Boolean(dashboard),
      });
    }
  } catch (err) {
    console.warn('Paralegal dashboard refresh failed', reason || '', err);
  } finally {
    dashboardRefreshInFlight = false;
    if (!dashboardDeparting && dashboardRefreshQueuedReason) {
      const queuedReason = dashboardRefreshQueuedReason;
      dashboardRefreshQueuedReason = '';
      queueMicrotask(() => refreshDashboardFromServer(queuedReason, { force: true }));
    }
  }
}

function setupDashboardAutoRefresh() {
  // A cancelled in-flight read can finish before pagehide. Stop its queued
  // refresh as soon as navigation starts, and reauthorize when this view returns.
  const stop = () => {
    dashboardDeparting = true; dashboardRefreshQueuedReason = '';
    ++dashboardRefreshGeneration; ++deskEnrichmentGeneration;
  };
  const resume = reason => {
    dashboardDeparting = false;
    refreshDashboardFromServer(reason, { force: true });
  };
  window.addEventListener('beforeunload', stop);
  window.addEventListener('pagehide', () => {
    stop();
    calendarController?.abort(); ++dashboardRefreshGeneration; ++deskEnrichmentGeneration;
    dashboardPayloadFingerprint = ''; assignmentsSourceFingerprint = '';
    for (const controller of homeReadControllers.values()) controller.abort(); homeReadControllers.clear();
    clearFinancialSummary(); calendarSnapshot = { rows: [], unavailable: [], loading: true }; renderDeadlines();
  });
  window.addEventListener('pageshow', (event) => {
    dashboardDeparting = false;
    if (event.persisted) resume('pageshow');
  });
  // Cancelling a native leave-page prompt can return focus without pageshow.
  window.addEventListener('focus', () => { if (dashboardDeparting && document.visibilityState === 'visible') resume('focus'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume('visible');
  });
  window.addEventListener('lpc:notifications-refreshed', () => {
    if (document.visibilityState !== 'visible') return;
    refreshDashboardFromServer('notifications', { force: true });
  });
  window.addEventListener('lpc:lifecycle-refresh', () => {
    if (document.visibilityState !== 'visible') return;
    refreshDashboardFromServer('lifecycle', { force: true });
  });
  window.addEventListener('lpc:paralegal-dashboard-request-refresh', (event) => {
    const reason = String(event?.detail?.reason || 'surface-request');
    refreshDashboardFromServer(reason, { force: true });
  });
}

function renderDeadlines(rows, unavailable) {
  if (rows) calendarSnapshot = { rows, unavailable: unavailable || [], loading: false };
  const root = selectors.deadlineList;
  const query = new URL(window.location.href).searchParams;
  const page = /^[1-9]\d*$/.test(query.get('calendarPage') || '') ? Number(query.get('calendarPage')) : 1;
  const snapshot = currentFinancialOwner() ? calendarSnapshot : { rows: [], unavailable: ['Calendar'], loading: false };
  renderCalendar(root, { ...snapshot, page,
    onPage: next => {
      const url = new URL(window.location.href); if (next === 1) url.searchParams.delete('calendarPage'); else url.searchParams.set('calendarPage', String(next));
      window.history.replaceState(window.history.state, '', url); renderDeadlines();
    },
    onRetry: () => { void refreshDashboardFromServer('calendar', { force: true }); },
  });
}

function getMissingProfileActions() {
  if (!profileStatusKnown) return [];
  const profileStates = [
    ...(Array.isArray(recommendationProfile.stateExperience) ? recommendationProfile.stateExperience : []),
    recommendationProfile.state,
    recommendationProfile.location,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const practiceAreas = Array.isArray(recommendationProfile.practiceAreas)
    ? recommendationProfile.practiceAreas.filter((value) => String(value || '').trim())
    : [];
  const missing = [];
  if (!profileStates.length) missing.push('Add state experience');
  if (!practiceAreas.length) missing.push('Add practice areas');
  const years = recommendationProfile.yearsExperience;
  if (years === null || years === undefined || years === '' || !Number.isFinite(Number(years))) {
    missing.push('Add years of experience');
  }
  return missing;
}

function assignmentReviewState(assignment = {}) {
  const files = Array.isArray(assignment.detail?.files) ? assignment.detail.files.filter((file) => file.uploadedByRole === 'paralegal') : [];
  if (assignment.detail?.submissionSummary?.revisions > 0) return 'revision';
  if (assignment.detail?.submissionSummary?.awaitingReview > 0) return 'review';
  if (files.some((file) => String(file?.status || '').toLowerCase() === 'attorney_revision')) return 'revision';
  if (files.some((file) => String(file?.status || '').toLowerCase() === 'pending_review')) return 'review';
  return 'active';
}

function sortDeskAssignments(assignments = []) {
  const priority = { revision: 0, review: 1, active: 2 };
  return assignments.slice().sort((left, right) => {
    const stateDifference = priority[assignmentReviewState(left)] - priority[assignmentReviewState(right)];
    if (stateDifference) return stateDifference;
    const leftDeadline = left.deadlineDate ? new Date(left.deadlineDate).getTime() : Number.POSITIVE_INFINITY;
    const rightDeadline = right.deadlineDate ? new Date(right.deadlineDate).getTime() : Number.POSITIVE_INFINITY;
    if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
    return new Date(right.updatedAt || right.createdAt || 0) - new Date(left.updatedAt || left.createdAt || 0);
  });
}

function renderDeskState({ eyebrow, title, detail, actionLabel, actionHref, tone = 'open' }) {
  return `
    <article class="desk-matter desk-matter--${escapeHtml(tone)}">
      <div class="desk-matter__meta"><span class="desk-matter__status">${escapeHtml(eyebrow)}</span></div>
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p class="desk-matter__scope">${escapeHtml(detail)}</p>
      </div>
      <div></div>
      <div class="desk-matter__footer">
        <a class="desk-matter__action" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>
      </div>
    </article>`;
}

function renderPrivateOfficeDesk() {
  const container = selectors.assignmentList;
  if (!container) return;
  if (initialDashboardHydrating) return;
  const missingProfile = getMissingProfileActions();
  renderHomeSectionWhenChanged(container, {
    dashboardStatus,
    profileStatusKnown,
    stripeStatusKnown,
    stripeConnected,
    missingProfile,
    assignments: deskAssignments,
    selectedIndex: deskMatterIndex,
    recommendationStatus,
    hasRecommendations: rankedRecommendationsCache.length > 0,
  }, () => renderPrivateOfficeDeskContent(container, missingProfile));
}

function renderPrivateOfficeDeskContent(container, missingProfile) {
  if (dashboardStatus === 'error') {
    container.innerHTML = renderDeskState({
      eyebrow: 'Office unavailable',
      title: 'Your work could not be loaded',
      detail: 'Reload Home to check your current assignments.',
      actionLabel: 'Reload dashboard',
      actionHref: 'dashboard-paralegal.html',
      tone: 'error',
    });
    selectors.homeWorkSection?.removeAttribute('aria-busy');
    return;
  }
  if (selectors.recommendedMattersSection) selectors.recommendedMattersSection.hidden = missingProfile.length > 0;
  if (!deskAssignments.length && (!profileStatusKnown || !stripeStatusKnown)) {
    container.innerHTML = renderDeskState({ eyebrow: 'Account unavailable', title: 'Account details couldn’t load', detail: 'Reload Home to check your profile and payout setup.', actionLabel: 'Reload Home', actionHref: 'dashboard-paralegal.html#home', tone: 'error' });
    selectors.deskMatterSwitcher.hidden = true; selectors.homeWorkSection?.removeAttribute('aria-busy'); return;
  }
  if (!deskAssignments.length && stripeStatusKnown && !stripeConnected) {
    container.innerHTML = renderDeskState({
      eyebrow: 'Office setup',
      title: 'Complete payout setup',
      detail: 'Required before applying to Matters or receiving payment.',
      actionLabel: 'Complete setup',
      actionHref: 'profile-settings.html?onboardingStep=payment',
      tone: 'setup',
    });
    selectors.homeWorkSection?.removeAttribute('aria-busy');
    selectors.deskMatterSwitcher.hidden = true;
    return;
  }
  if (!deskAssignments.length && missingProfile.length) {
    container.innerHTML = renderDeskState({
      eyebrow: 'Office setup',
      title: 'Complete your professional profile',
      detail: missingProfile.join(' · '),
      actionLabel: 'Complete profile',
      actionHref: 'profile-settings.html',
      tone: 'setup',
    });
    selectors.homeWorkSection?.removeAttribute('aria-busy');
    selectors.deskMatterSwitcher.hidden = true;
    return;
  }
  if (deskAssignments.length) {
    deskMatterIndex = Math.min(Math.max(0, deskMatterIndex), deskAssignments.length - 1);
    const assignment = deskAssignments[deskMatterIndex];
    const detail = assignment.detail || {};
    const experience = detail.matterExperience || {};
    const header = experience.header || {};
    const reviewState = assignmentReviewState(assignment);
    const files = Array.isArray(detail.files) ? detail.files : null;
    const revisionCount = detail.submissionSummary?.revisions ?? (files?.filter((file) => file.uploadedByRole === 'paralegal' && String(file?.status || '').toLowerCase() === 'attorney_revision').length || 0);
    const reviewCount = detail.submissionSummary?.awaitingReview ?? (files?.filter((file) => file.uploadedByRole === 'paralegal' && String(file?.status || '').toLowerCase() === 'pending_review').length || 0);
    const tasks = experience.overview?.taskProgress;
    const taskTotal = Number.isFinite(Number(tasks?.total)) ? Number(tasks.total) : assignment.tasksTotal;
    const taskCompleted = Number.isFinite(Number(tasks?.completed)) ? Number(tasks.completed) : Math.max(0, taskTotal - assignment.tasksRemaining);
    const tone = reviewState;
    const statusText = reviewState === 'revision'
      ? `${revisionCount} revision${revisionCount === 1 ? '' : 's'} requested`
      : reviewState === 'review'
        ? `${reviewCount} file${reviewCount === 1 ? '' : 's'} awaiting attorney review`
        : header.status?.label || formatStatusLabel(assignment.status) || 'Active Matter';
    const primaryAction = header.primaryAction || {};
    const workspaceEligible = isWorkspaceEligibleCase(assignment);
    const actionTab = ['revision', 'review'].includes(reviewState) ? 'files' : primaryAction.tab || 'work';
    const actionHref = `case-detail.html?caseId=${encodeURIComponent(assignment.caseId)}&tab=${encodeURIComponent(actionTab)}`;
    const actionLabel = reviewState === 'revision' ? 'Review requested changes' : reviewState === 'review' ? 'View submitted work' : primaryAction.label || 'Continue work';
    const work = taskTotal > 0 ? `${taskCompleted} of ${taskTotal} complete` : 'No work items';
    const detailNotice = assignment.detailState === 'error' ? '<p class="desk-matter__read-state">Work details couldn’t load. <button type="button" data-desk-retry>Retry details</button></p>'
      : !assignment.detail ? '<p class="desk-matter__read-state">Checking work details…</p>' : '';
    container.innerHTML = `
      <article class="desk-matter desk-matter--${escapeHtml(tone)}" data-case-id="${escapeHtml(assignment.caseId)}">
        <div class="desk-matter__meta">
          <span class="desk-matter__status">${escapeHtml(statusText)}</span>
          ${assignment.practiceArea ? `<span>${escapeHtml(assignment.practiceArea)}</span>` : ''}
          ${assignment.attorney ? `<span>With ${escapeHtml(assignment.attorney)}</span>` : ''}
        </div>
        <div>
          <h3>${escapeHtml(header.title || assignment.title || 'Matter')}</h3>
          ${experience.overview?.summary ? `<p class="desk-matter__scope">${escapeHtml(experience.overview.summary)}</p>` : ''}
        </div>
        <div>
          <div class="desk-matter__slips">
            <div class="desk-slip"><span>Deadline</span><strong>${escapeHtml(assignment.due || 'Not set')}</strong></div>
            <div class="desk-slip"><span>Work items</span><strong>${escapeHtml(work)}</strong></div>
            ${files ? `<div class="desk-slip"><span>Shared files</span><strong>${files.length}</strong></div>` : ''}
          </div>
          ${detailNotice}
        </div>
        <div class="desk-matter__footer">
          <div class="desk-matter__actions">
            <button type="button" class="desk-matter__preview" data-desk-preview>Details</button>
            ${workspaceEligible ? `<a class="desk-matter__action" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>` : ''}
          </div>
        </div>
      </article>`;
    container.querySelector('[data-desk-retry]')?.addEventListener('click', () => { void refreshDashboardFromServer('details', { force: true }); });
    container.querySelector('[data-desk-preview]')?.addEventListener('click', (event) => {
      const trigger = event.currentTarget;
      if (window.LPCContextPanel?.openMatter?.(assignment.caseId, { historyMode: 'push', returnFocus: trigger })) return;
      navigateToCase(assignment.caseId);
    });
    const multiple = deskAssignments.length > 1;
    selectors.deskMatterSwitcher.hidden = !multiple;
    if (selectors.deskMatterPosition) selectors.deskMatterPosition.textContent = `${deskMatterIndex + 1} / ${deskAssignments.length}`;
    selectors.homeWorkSection?.removeAttribute('aria-busy');
    return;
  }
  selectors.deskMatterSwitcher.hidden = true;
  if (dashboardStatus === 'loading') {
    container.innerHTML = '<div class="private-office-desk__loading">Preparing your desk…</div>';
    return;
  }
  const detail = recommendationStatus === 'loading'
    ? 'Loading open Matters for you to review.'
    : recommendationStatus === 'error'
      ? 'These listings are temporarily unavailable. You can still review the complete Matter board.'
      : rankedRecommendationsCache.length
        ? 'Explore the Matters below and decide whether they fit your experience.'
        : 'Your next assignment will appear here.';
  container.innerHTML = renderDeskState({
    eyebrow: 'Your desk is open',
    title: 'Ready for the next Matter',
    detail,
    actionLabel: 'Browse Matters',
    actionHref: 'browse-jobs.html',
    tone: 'open',
  });
  selectors.homeWorkSection?.removeAttribute('aria-busy');
}

async function enrichDeskAssignments(assignments = [], generation = deskEnrichmentGeneration) {
  const ownerId = currentFinancialOwner();
  const enriched = new Array(assignments.length); let index = 0, restricted = false;
  const current = () => generation === deskEnrichmentGeneration && currentFinancialOwner() === ownerId;
  async function worker() {
    while (index < assignments.length && current()) {
      const position = index++, assignment = assignments[position];
      try {
        const detail = await readOwnedHome(`matter:${assignment.caseId}`, options => fetchJson(`/api/cases/${encodeURIComponent(assignment.caseId)}`, options));
        if (getCaseId(detail) !== assignment.caseId) throw new Error('Matter details could not be verified.');
        enriched[position] = { ...assignment, detail, detailState: 'ready' };
      } catch (error) {
        if (!current()) return;
        if ([403, 404].includes(error.status)) { restricted = true; enriched[position] = null; }
        else enriched[position] = { ...assignment, detailState: 'error' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, assignments.length) }, worker));
  if (!current()) return;
  const selectedId = deskAssignments[deskMatterIndex]?.caseId;
  deskAssignments = sortDeskAssignments(enriched.filter(Boolean));
  homeDetailsPhase = restricted || deskAssignments.some(assignment => assignment.detailState !== 'ready') ? 'error' : 'ready';
  deskMatterIndex = Math.max(0, deskAssignments.findIndex(assignment => assignment.caseId === selectedId));
  if (restricted) renderDeadlines([], ['Matter access']);
  renderPrivateOfficeDesk(); renderParalegalPriorityQueue();
  document.getElementById('paralegalHomeView')?.classList.remove('is-hydrating');
}

function renderAssignments(assignments = []) {
  const usableAssignments = (Array.isArray(assignments) ? assignments : []).filter(assignment => assignment && assignment.caseId);
  const nextFingerprint = dataFingerprint({ assignments: usableAssignments, status: dashboardStatus });
  if (nextFingerprint && nextFingerprint === assignmentsSourceFingerprint) return;
  assignmentsSourceFingerprint = nextFingerprint;
  for (const [key, controller] of homeReadControllers) if (key.startsWith('matter:')) { controller.abort(); homeReadControllers.delete(key); }
  const selectedId = deskAssignments[deskMatterIndex]?.caseId, generation = ++deskEnrichmentGeneration;
  // Retain verified details only for assignments still present in the fresh
  // owned summary. Commit the new detail batch together so refresh cannot
  // temporarily drop revisions, reorder work or shorten the Inbox.
  const priorDetails = new Map(deskAssignments.filter(assignment => assignment.detailState === 'ready').map(assignment => [assignment.caseId, assignment.detail]));
  deskAssignments = sortDeskAssignments(usableAssignments.map(assignment => priorDetails.has(assignment.caseId)
    ? { ...assignment, detail: priorDetails.get(assignment.caseId), detailState: 'ready' }
    : assignment));
  homeDetailsPhase = usableAssignments.length ? 'loading' : 'ready';
  deskMatterIndex = Math.max(0, deskAssignments.findIndex(assignment => assignment.caseId === selectedId));
  renderPrivateOfficeDesk();
  if (usableAssignments.length) void enrichDeskAssignments(usableAssignments, generation);
  else document.getElementById('paralegalHomeView')?.classList.remove('is-hydrating');
}

function bindDeskMatterSwitcher() {
  if (deskSwitcherBound) return;
  deskSwitcherBound = true;
  document.querySelector('[data-desk-previous]')?.addEventListener('click', () => {
    if (deskAssignments.length < 2) return;
    deskMatterIndex = (deskMatterIndex - 1 + deskAssignments.length) % deskAssignments.length;
    renderPrivateOfficeDesk();
  });
  document.querySelector('[data-desk-next]')?.addEventListener('click', () => {
    if (deskAssignments.length < 2) return;
    deskMatterIndex = (deskMatterIndex + 1) % deskAssignments.length;
    renderPrivateOfficeDesk();
  });
}

function mapActiveCasesToAssignments(activeCases = [], threads = []) {
  const threadByCase = new Map(
    (Array.isArray(threads) ? threads : [])
      .map((thread) => [String(getCaseId(thread) || ''), thread])
      .filter(([caseId]) => caseId)
  );
  return activeCases
    .map((caseItem) => {
      const caseId = getCaseId(caseItem);
      if (!caseId) return null;
      const thread = threadByCase.get(String(caseId)) || null;
      const latestActivity = caseItem.latestUpdate
        ? `Latest update: ${caseItem.latestUpdate}`
        : caseItem.latestFileName
          ? `Latest file: ${caseItem.latestFileName}`
          : thread?.lastMessageSnippet
            ? `Latest message: ${thread.lastMessageSnippet}`
            : '';
      return {
        caseId,
        title: caseItem.jobTitle || caseItem.title || 'Matter',
        attorney: caseItem.attorneyName || '',
        practiceArea: caseItem.practiceArea || '',
        due: caseItem.deadline || caseItem.deadlineDate || caseItem.dueDate
          ? formatMatterDeadline(caseItem.deadlineDate || caseItem.deadline || caseItem.dueDate)
          : '',
        deadlineDate: caseItem.deadlineDate || caseItem.deadline || caseItem.dueDate || '',
        updatedAt: caseItem.latestUpdateAt || caseItem.updatedAt || '',
        createdAt: caseItem.createdAt || '',
        status: caseItem.status || '',
        tasksTotal: Math.max(0, Number(caseItem.tasksTotal) || 0),
        tasksRemaining: Math.max(0, Number(caseItem.tasksRemaining) || 0),
        unreadMessages: Math.max(0, Number(thread?.unread) || 0),
        latestActivity,
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
  const ownerId = currentFinancialOwner();
  const api = { get: async (path, options) => {
    if (dashboardDeparting) throw new DOMException('View changed', 'AbortError');
    const response = await secureFetch(path, { ...options, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Invitations couldn’t load.');
    return response.json();
  } };
  try {
    const value = await loadReceivedInvitations(api, ownerId, { isCurrent: () => !dashboardDeparting && currentFinancialOwner() === ownerId });
    renderInvitationLoadState(false); return value.items;
  } catch (error) { if (!dashboardDeparting && error?.name !== 'AbortError') renderInvitationLoadState(true); throw error; }
}
let invitationQueueUnavailable = false;
function renderInvitationLoadState(unavailable) {
  invitationQueueUnavailable = unavailable;
  let notice = document.querySelector('[data-invitation-load-state]');
  if (!notice) {
    const queue = document.querySelector('[data-paralegal-priority-list]');
    if (!queue) return;
    notice = document.createElement('div'); notice.dataset.invitationLoadState = '';
    const message = document.createElement('p'); message.setAttribute('role', 'status'); message.textContent = 'Invitations couldn’t load.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry invitations';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      try { await refreshDashboardFromServer('invitation-retry', { force: true }); }
      finally { retry.disabled = false; }
    });
    notice.append(message, retry); queue.before(notice);
  }
  notice.hidden = !unavailable;
  if (unavailable && activeInvite) closeInviteOverlay();
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

function syncRecentActivityState({ invites = [], threads = [], deadlines = [] } = {}) {
  recentActivityState.invites = Array.isArray(invites) ? invites : [];
  recentActivityState.threads = Array.isArray(threads) ? threads : [];
  recentActivityState.deadlines = Array.isArray(deadlines) ? deadlines : [];
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
      syncRecentActivityState({
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
    syncRecentActivityState({
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
  const originalLabel = button?.textContent || 'Withdraw application';
  inviteResponseInFlight = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Withdrawing…';
  }
  const toastHelper = window.toastUtils;
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/invite/revoke`, { method: 'POST' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || 'Unable to withdraw this application.');
    recentActivityState.invites = recentActivityState.invites.filter(
      (invite) => String(invite?.id || invite?._id || '') !== String(caseId)
    );
    syncRecentActivityState({
      invites: recentActivityState.invites,
      threads: recentActivityState.threads,
      deadlines: recentActivityState.deadlines,
    });
    if (typeof window.refreshNotificationCenters === 'function') {
      window.refreshNotificationCenters();
    }
    closeInviteOverlay();
    toastHelper?.show?.('Application withdrawn.', { targetId: selectors.toastBanner?.id, type: 'success' });
  } catch (error) {
    toastHelper?.show?.(error.message || 'Unable to withdraw this application.', {
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
let stopEarlierWithdrawalObservation = null;
let inviteReturnFocus = null;

function closeRevokeConfirmModal() {
  stopEarlierWithdrawalObservation?.();
  stopEarlierWithdrawalObservation = null;
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
  stopEarlierWithdrawalObservation?.();
  stopEarlierWithdrawalObservation = null;
  pendingRevokeAction = typeof onConfirm === 'function' ? onConfirm : null;
  const modal = selectors.revokeConfirmModal;
  if (!modal) return;
  modal.querySelector('[data-earlier-withdrawal-status]')?.remove();
  if (selectors.revokeConfirmSubmit) { selectors.revokeConfirmSubmit.disabled = false; selectors.revokeConfirmSubmit.textContent = 'Withdraw application'; }
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
    invite?.details ||
    invite?.description ||
    invite?.briefSummary ||
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

  if (inviteCaseTitle) inviteCaseTitle.textContent = isAccepted ? 'Await attorney action' : 'Invitation';
  if (inviteJobTitle) inviteJobTitle.textContent = title;
  if (inviteLead) {
    inviteLead.textContent = isAccepted
      ? 'You accepted this invitation. The attorney must confirm hire and fund the Matter next.'
      : 'Accepting confirms interest. Work starts after any requested checks, hiring, and funding.';
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
    const deadline = invite?.deadlineDate || invite?.deadline;
    if (deadline) detailParts.push(`<p>Deadline: ${escapeHtml(formatMatterDeadline(deadline))}</p>`);
    if (Number(invite?.minimumYearsExperience) > 0) detailParts.push(`<p>${escapeHtml(String(invite.minimumYearsExperience))}+ years required</p>`);
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
    inviteDeclineBtn.textContent = isAccepted ? 'Withdraw application' : 'Decline';
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
    if (Object.entries(updates).some(([key, value]) => payload.onboarding?.[key] !== value)) throw new Error("Onboarding update was not confirmed.");
    onboardingState = normalizeOnboarding(payload.onboarding || {});
    if (typeof window.updateSessionUser === "function") {
      const nextUser = { onboarding: onboardingState };
      if (markFirstLoginComplete) nextUser.isFirstLogin = false;
      window.updateSessionUser(nextUser);
    }
    return onboardingState;
  } catch (err) {
    console.warn("Unable to update onboarding state", err);
    return null;
  }
}


async function markTourCompleted() {
  const saved = await updateOnboardingState({ paralegalTourCompleted: true }, { markFirstLoginComplete: true });
  return saved?.paralegalTourCompleted === true;
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
  const completionError = document.createElement("p");
  completionError.setAttribute("role", "alert");
  completionError.className = "tour-completion-error";
  completionError.hidden = true;
  tooltip.append(completionError);
  let savingCompletion = false;
  const finishAndOpenProfile = async () => {
    if (savingCompletion) return;
    savingCompletion = true; completionError.hidden = true;
    if (nextBtn) nextBtn.disabled = true;
    if (backBtn) backBtn.disabled = true;
    const saved = await markTourCompleted();
    savingCompletion = false;
    if (nextBtn) nextBtn.disabled = false;
    if (backBtn) backBtn.disabled = false;
    if (!overlay.classList.contains("is-active")) return;
    if (!saved) { completionError.textContent = "Couldn’t save tour completion. Try again."; completionError.hidden = false; nextBtn?.focus(); return; }
    completeTour();
    window.location.href = buildProfileTourUrl(profileLink.getAttribute("href") || "profile-settings.html");
  };
  nextBtn?.addEventListener("click", () => void finishAndOpenProfile());
  profileLink.addEventListener("click", (event) => {
    if (overlay.classList.contains("is-active")) { event.preventDefault(); void finishAndOpenProfile(); }
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
  profileStatusKnown = Boolean(currentFinancialOwner()) && String(profile?._id || profile?.id || '') === currentFinancialOwner();
  const availabilityButton = document.querySelector('[data-action="availability"]');
  let availabilityKnown = false;
  try { availabilitySnapshot(profile); availabilityKnown = profileStatusKnown; } catch { availabilityKnown = false; }
  if (availabilityButton) availabilityButton.disabled = !availabilityKnown;
  if (!profileStatusKnown) {
    const availability = document.getElementById('availabilityStatus'); if (availability) availability.textContent = 'Not loaded';
    renderPrivateOfficeDesk(); return;
  }
  recommendationProfile = { ...recommendationProfile, ...profile };
  const stateExperience = Array.isArray(profile.stateExperience)
    ? profile.stateExperience.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const fallbackState = String(profile.state || profile.location || '').trim();
  const practices = Array.isArray(profile.practiceAreas)
    ? profile.practiceAreas.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const years = Number(profile.yearsExperience);
  if (selectors.homeProfileStates) {
    selectors.homeProfileStates.textContent = stateExperience.length
      ? stateExperience.slice(0, 3).join(', ')
      : fallbackState || 'Add your states';
    selectors.homeProfileStates.title = stateExperience.join(', ') || fallbackState;
  }
  if (selectors.homeProfilePractices) {
    const summary = practices.length > 2
      ? `${practices.slice(0, 2).join(', ')} +${practices.length - 2}`
      : practices.join(', ');
    selectors.homeProfilePractices.textContent = summary || 'Add practice areas';
    selectors.homeProfilePractices.title = practices.join(', ');
  }
  if (selectors.homeProfileExperience) {
    selectors.homeProfileExperience.textContent = Number.isFinite(years) && years >= 0
      ? `${years} year${years === 1 ? '' : 's'}`
      : 'Add experience';
  }
  if (recommendationStatus === 'ready') {
    renderRecommendedMatters(recommendedJobsCache);
  }
  const composedName =
    [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim() || profile.name || 'Paralegal';
  const avatarUrl = getAvatarUrl(profile);
  document.querySelectorAll('[data-avatar]').forEach((node) => {
    node.src = avatarUrl;
    node.alt = `${composedName}'s avatar`;
  });
  const a = document.querySelector('#user-avatar');
  if (a) a.src = avatarUrl;
  updatePendingApprovalBanner(profile);
  if (availabilityKnown) syncAvailabilityProfile(profile);
  else { const availability = document.getElementById('availabilityStatus'); if (availability) availability.textContent = 'Not loaded'; }
  renderPrivateOfficeDesk();
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
    const label = status === "available" ? "Available now" : "Not available";
    // A same-value refresh must retain the pointer's text node. Replacing it
    // between pointer-down and pointer-up can cancel WebKit's native click.
    if (statusDisplay.textContent !== label) statusDisplay.textContent = label;
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
  if (event.key !== 'lpc_user' && event.key !== null) return;
  if (!financialOwnerId) return;
  clearApplicationDraftsOnAccountChange();
  clearFinancialSummary();
  if (!currentFinancialOwner()) { clearHomeAccount(); return; }
  const generation = ++availabilityRefreshGeneration;
  void loadViewerProfile()
    .then((profile) => {
      if (generation === availabilityRefreshGeneration) updateProfile(profile || {});
    })
    .catch(() => {
      // Preserve the last verified server projection when a cross-tab refresh fails.
    });
}

window.addEventListener('storage', handleStoredUserUpdate);
window.addEventListener('lpc:user-updated', () => {
  // Session events can contain only identity fields. Re-read the owned profile
  // instead of treating that partial payload as missing availability/setup.
  handleStoredUserUpdate({ key: 'lpc_user' });
});

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
    revision: Number(pre.revision || 0),
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
    requestRevision: pre.revision,
    confidentialityAcknowledged: !!pre.confidentialityAcknowledged,
    signedConfidentialityFile: null,
    signedConfidentialityFileName: String(pre.paralegalConfidentialityDocument?.name || ''),
    conflictsResponseType: pre.conflictsCheckRequired ? pre.conflictsResponseType || '' : '',
    conflictsDisclosureText: pre.conflictsDisclosureText || '',
  };
}

function applicationDraftKey(app) {
  const ownerId = currentFinancialOwner(), caseId = getCaseId(app?.caseId);
  return ownerId && caseId ? `${ownerId}:${caseId}:${String(app?._id || app?.id || '')}` : '';
}

function rememberApplicationDraft() {
  const key = applicationDraftKey(activeApplication);
  if (!key) return;
  if (applicationPreEngagementDraft) applicationPreEngagementDrafts.set(key, { draft: applicationPreEngagementDraft, expandedKey: applicationPreEngagementExpandedKey });
  else applicationPreEngagementDrafts.delete(key);
}

function clearApplicationDraftsOnAccountChange() {
  if (currentFinancialOwner()) return;
  applicationDraftGeneration++;
  earlierWithdrawal.clear();
  closeRevokeConfirmModal();
  applicationPreEngagementDrafts.clear();
  closeApplicationModal();
  applicationDetail?.replaceChildren();
}

function restoreApplicationDraft(app, saved) {
  const fresh = createApplicationPreEngagementDraft(app);
  if (!fresh || !saved) return fresh;
  if (fresh.requestRevision === saved.requestRevision) return saved;
  return { ...fresh, conflictsDisclosureText: saved.conflictsDisclosureText || fresh.conflictsDisclosureText,
    pending: !!saved.pending, sending: !!saved.sending, refreshing: !!saved.refreshing, pendingMessage: saved.pendingMessage || '' };
}

function isApplicationPreEngagementValid(pre, draft) {
  if (draft?.pending) return false;
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
  const expandedKey = resolveApplicationPreEngagementExpandedKey(pre, draft);

  const confidentialityCard = pre.confidentialityAgreementRequired
    ? `
      <article class="application-preengagement-card ${expandedKey === 'confidentiality' ? 'is-expanded' : ''}">
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
      <article class="application-preengagement-card ${expandedKey === 'conflicts' ? 'is-expanded' : ''}">
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
                  aria-label="Possible conflict details"
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
        ${draft.pendingMessage ? `<p role="alert">${escapeHtml(draft.pendingMessage)}</p>` : ''}
        <div class="application-preengagement-actions">
          <button type="button" class="btn primary application-preengagement-submit-btn" data-preengagement-submit ${submitDisabled ? 'disabled' : ''}>${draft.sending ? 'Submitting…' : 'Submit to attorney'}</button>
          ${draft.pending && !draft.sending ? `<button type="button" class="btn secondary application-preengagement-action-btn" data-preengagement-refresh ${draft.refreshing ? 'disabled' : ''}>Review saved requirements</button>` : ''}
        </div>
      `}
    </section>
  `;
}

function buildApplicationDetail(app) {
  if (!app) {
    return '<p class="muted">Application not found.</p>';
  }
  const job = { ...(app.jobId || app.job || {}), ...(app.scopeSnapshot || {}) };
  const practice = escapeHtml(job.practiceArea || 'General practice');
  const description = escapeHtml(job.description || '');
  const budgetValue = Number.isFinite(job.totalAmount) ? job.totalAmount / 100 : Number(job.budget);
  const budget = job.compensationDisplay || job.payDisplay || (Number.isFinite(budgetValue) ? formatCurrency(budgetValue) : '');
  const status = formatApplicationStatus(getApplicationStatusKey(app));
  const appliedAt = app.createdAt ? formatDate(app.createdAt) : 'Recently';
  const cover = formatMultiline(app.coverLetter || '');
  return `
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
    <details class="application-detail-actions">
      <summary>Matter details</summary>
      <p>${app.scopeSnapshot?.capturedAt ? 'Scope saved when you applied.' : 'Latest retained listing details. A snapshot was not saved for this older application.'}</p>
      ${job.state ? `<p>State: ${escapeHtml(job.state)}</p>` : ''}
      ${job.deadlineDate ? `<p>Deadline: ${escapeHtml(formatMatterDeadline(job.deadlineDate))}</p>` : ''}
      <ul>${(job.tasks || []).map((task) => `<li>${escapeHtml(typeof task === 'string' ? task : task.title)}</li>`).join('')}</ul>
    </details>
    ${buildApplicationPreEngagementSection(app)}
  `;
}

function renderActiveApplicationModal() {
  if (!applicationDetail) return;
  rememberApplicationDraft();
  const heading = document.getElementById('applicationDetailTitle');
  const job = { ...(activeApplication?.jobId || activeApplication?.job || {}), ...(activeApplication?.scopeSnapshot || {}) };
  if (heading) heading.textContent = job.title || activeApplication?.caseTitle || 'Matter application';
  applicationDetail.innerHTML = buildApplicationDetail(activeApplication);
  const revokeButton = applicationModal?.querySelector('[data-application-revoke]');
  if (revokeButton) {
    revokeButton.hidden = !isApplicationRevocable(activeApplication);
    revokeButton.disabled = !!applicationPreEngagementDraft?.pending || !isApplicationRevocable(activeApplication);
    revokeButton.textContent = 'Withdraw application';
    revokeButton.closest('.note-modal-actions').hidden = revokeButton.hidden;
  }
  if (applicationPreEngagementDraft?.pending) {
    applicationDetail.querySelectorAll('.application-preengagement input, .application-preengagement textarea').forEach(input => { input.disabled = true; });
  }
  bindApplicationPreEngagementActions();
}

function updateActiveApplicationInCache(updatedApp = {}) {
  const key = applicationDraftKey(updatedApp);
  if (!key || appliedAppsCache.filter(entry => applicationDraftKey(entry) === key).length !== 1) return;
  appliedAppsCache = appliedAppsCache.map((entry) => {
    return applicationDraftKey(entry) === key ? { ...entry, ...updatedApp } : entry;
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

async function submitApplicationPreEngagement(app) {
  const pre = getApplicationPreEngagement(app);
  const caseId = String(app?.caseId || '');
  if (!pre || pre.status === 'submitted' || !caseId) return;
  const draft = applicationPreEngagementDraft || createApplicationPreEngagementDraft(app) || {};
  const key = applicationDraftKey(app), ownerId = currentFinancialOwner(), generation = applicationDraftGeneration;
  if (!key || !ownerId) return;
  const isCurrentOwner = () => currentFinancialOwner() === ownerId && generation === applicationDraftGeneration;
  const isSelected = () => isCurrentOwner() && applicationDraftKey(activeApplication) === key;
  const saveDraft = next => {
    if (!isCurrentOwner()) return;
    const expandedKey = applicationPreEngagementDrafts.get(key)?.expandedKey || '';
    if (next) applicationPreEngagementDrafts.set(key, { draft: next, expandedKey });
    else applicationPreEngagementDrafts.delete(key);
    if (isSelected()) applicationPreEngagementDraft = next;
  };
  if (!isApplicationPreEngagementValid(pre, draft)) {
    renderActiveApplicationModal();
    return;
  }
  const toastHelper = window.toastUtils;
  saveDraft({ ...draft, pending: true, sending: true, pendingMessage: '' });
  renderActiveApplicationModal();
  try {
    const formData = new FormData();
    formData.set('expectedPreEngagementRevision', String(draft.requestRevision));
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
      suppressToast: true,
      headers: { Accept: 'application/json' },
      body: formData,
    });
    const payload = await res.json().catch(() => ({}));
    if (!isCurrentOwner()) return;
    if (!res.ok) throw Object.assign(new Error(payload?.error || 'Unable to submit pre-engagement.'), { status: res.status, code: payload?.code });
    if (payload?.success !== true || payload.preEngagement?.status !== 'submitted' || payload.preEngagement.revision !== draft.requestRevision + 1 || String(payload.preEngagement.requestedParalegalId || '') !== pre.requestedParalegalId) throw new Error('Submission could not be confirmed.');
    const updatedApp = {
      ...app,
      preEngagement: payload.preEngagement,
    };
    saveDraft(null);
    updateActiveApplicationInCache(updatedApp);
    if (isSelected()) {
      activeApplication = updatedApp;
      renderActiveApplicationModal();
    }
    applyAppliedFilters({ resetPage: false });
    if (isSelected()) toastHelper?.show?.(pre?.status === 'changes_requested' ? 'Pre-engagement resubmitted.' : 'Pre-engagement submitted.', {
      targetId: selectors.toastBanner?.id,
      type: 'success',
    });
  } catch (error) {
    if (!isCurrentOwner()) return;
    const changed = error?.status === 409 && error?.code === 'PRE_ENGAGEMENT_CONFLICT';
    const uncertain = !error?.status || error.status >= 500;
    if (changed || uncertain) {
      saveDraft({ ...draft, pending: true, sending: false, pendingMessage: uncertain ? 'Submission could not be confirmed. Review the saved requirements before trying again.' : error.message });
      if (isSelected()) renderActiveApplicationModal();
      return;
    }
    saveDraft({ ...draft, pending: false, sending: false, pendingMessage: error.message || 'Unable to submit pre-engagement.' });
    if (isSelected()) renderActiveApplicationModal();
  }
}

function bindApplicationPreEngagementActions() {
  if (!applicationDetail || !activeApplication) return;
  const pre = getApplicationPreEngagement(activeApplication);
  if (!pre) return;

  applicationDetail.querySelector('[data-preengagement-refresh]')?.addEventListener('click', async (event) => {
    const key = applicationDraftKey(activeApplication), ownerId = currentFinancialOwner(), generation = applicationDraftGeneration, draft = applicationPreEngagementDraft;
    if (!key || !ownerId || draft?.sending || draft?.refreshing) return;
    const isSelected = item => !!item && applicationDraftKey(item) === key;
    event.currentTarget.disabled = true;
    applicationPreEngagementDraft = { ...draft, refreshing: true };
    rememberApplicationDraft();
    try {
      // This explicit recovery read must not be discarded by a background list refresh.
      const response = await secureFetch('/api/applications/my', { headers: { Accept: 'application/json' }, suppressToast: true });
      const payload = await response.json().catch(() => null);
      if (ownerId !== currentFinancialOwner() || generation !== applicationDraftGeneration) return;
      const applications = response.ok && (Array.isArray(payload) ? payload : payload?.items);
      if (!Array.isArray(applications)) throw new Error('Saved requirements could not load. Try again.');
      const matches = applications.filter(isSelected);
      if (matches.length !== 1) throw new Error('This application is no longer available. Close these details and review your applications.');
      const updated = matches[0];
      const restored = restoreApplicationDraft(updated, draft);
      const fresh = restored && { ...restored, pending: false, sending: false, refreshing: false, pendingMessage: '' };
      const expandedKey = applicationPreEngagementDrafts.get(key)?.expandedKey || '';
      if (fresh) applicationPreEngagementDrafts.set(key, { draft: fresh, expandedKey });
      else applicationPreEngagementDrafts.delete(key);
      updateActiveApplicationInCache(updated);
      applyAppliedFilters({ resetPage: false });
      if (!isSelected(activeApplication)) return;
      activeApplication = updated;
      applicationPreEngagementDraft = fresh;
      renderActiveApplicationModal();
      applicationDetail.querySelector('[data-preengagement-card-toggle]')?.focus();
    } catch (error) {
      if (ownerId !== currentFinancialOwner() || generation !== applicationDraftGeneration) return;
      const failed = { ...draft, pending: true, refreshing: false, pendingMessage: error?.message || 'Saved requirements could not load. Try again.' };
      const expandedKey = applicationPreEngagementDrafts.get(key)?.expandedKey || '';
      applicationPreEngagementDrafts.set(key, { draft: failed, expandedKey });
      if (!isSelected(activeApplication)) return;
      applicationPreEngagementDraft = failed;
      renderActiveApplicationModal();
    }
  });

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
    await submitApplicationPreEngagement(activeApplication);
  });
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

async function revokeApplication(app, button) {
  const appId = app?._id || app?.id || '';
  if (!appId) return;
  const toastHelper = window.toastUtils;
  const originalLabel = button?.textContent || 'Withdraw application';
  if (button) {
    button.disabled = true;
    button.textContent = 'Withdrawing…';
  }
  try {
    const res = await secureFetch(`/api/applications/${encodeURIComponent(appId)}/revoke`, {
      method: 'POST',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || 'Unable to withdraw this application.');
    appliedAppsCache = appliedAppsCache.map((entry) => String(entry?._id || entry?.id || '') === String(appId)
      ? { ...entry, status: 'withdrawn', preEngagement: null, withdrawnAt: new Date().toISOString() } : entry);
    populateAppliedFilterOptions(appliedAppsCache);
    applyAppliedFilters();
    closeApplicationModal();
    toastHelper?.show?.('Application withdrawn.', { targetId: selectors.toastBanner?.id, type: 'success' });
  } catch (error) {
    toastHelper?.show?.(error.message || 'Unable to withdraw this application.', {
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
  if (['withdrawn', 'rejected', 'hired'].includes(String(app?.status || '').toLowerCase())) return false;
  if (app?.applicationSource === 'case_applicant') return app.withdrawal?.available === true;
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

function openApplicationModal(app, trigger = null) {
  if (!applicationModal || !applicationDetail) return;
  if (window.location.hash !== '#cases') return;
  if (!currentFinancialOwner() || !hasApplicationJob(app)) {
    closeApplicationModal();
    return;
  }
  rememberApplicationDraft();
  activeApplication = app || null;
  const saved = applicationPreEngagementDrafts.get(applicationDraftKey(app));
  applicationPreEngagementDraft = restoreApplicationDraft(app, saved?.draft);
  applicationPreEngagementExpandedKey = saved?.expandedKey || resolveDefaultPreEngagementExpandedKey(
    getApplicationPreEngagement(app),
    applicationPreEngagementDraft || {}
  );
  const revokeBtn = applicationModal.querySelector('[data-application-revoke]');
  if (revokeBtn) {
    const disabled = !isApplicationRevocable(app);
    revokeBtn.disabled = disabled;
    revokeBtn.textContent = 'Withdraw application';
  }
  renderActiveApplicationModal();
  applicationReturnFocus = trigger instanceof HTMLElement && trigger.isConnected
    ? trigger
    : document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  rememberApplicationDraft();
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
      if (activeApplication.applicationSource === 'case_applicant') {
        const selected = activeApplication, selectedKey = applicationDraftKey(selected);
        const action = async () => {
          const reviewing = earlierWithdrawal.state(selected).review;
          const result = await earlierWithdrawal.act(selected);
          if (!result) return;
          if (result.saved) {
            updateActiveApplicationInCache({ ...selected, status: 'withdrawn', pending: false, preEngagement: null, withdrawal: { available: false, revision: null } });
            applyAppliedFilters({ resetPage: false });
            if (pendingRevokeAction === action) closeRevokeConfirmModal();
            if (applicationDraftKey(activeApplication) === selectedKey) closeApplicationModal();
            window.toastUtils?.show?.('Application withdrawn.', { targetId: selectors.toastBanner?.id, type: 'success' });
            await loadAppliedJobs();
          } else if (reviewing && !result.review && pendingRevokeAction === action) {
            closeRevokeConfirmModal();
            appliedAppsCache = appliedAppsCache.map(entry => getCaseId(entry.caseId) === getCaseId(selected.caseId) ? result.application : entry);
            applyAppliedFilters({ resetPage: false });
            openApplicationModal(result.application);
            window.toastUtils?.show?.('Review the updated application before withdrawing.', { targetId: selectors.toastBanner?.id, type: 'info' });
          }
        };
        openRevokeConfirmModal(action);
        const message = document.createElement('p'); message.dataset.earlierWithdrawalStatus = ''; message.setAttribute('role', 'status');
        selectors.revokeConfirmModal.querySelector('.application-detail').append(message);
        stopEarlierWithdrawalObservation = earlierWithdrawal.observe(selected, state => {
          selectors.revokeConfirmSubmit.disabled = state.pending || state.saved || !state.review && state.application.withdrawal?.available !== true;
          selectors.revokeConfirmSubmit.textContent = state.pending ? 'Checking…' : state.review ? 'Review saved application' : 'Withdraw application';
          message.textContent = state.message;
          if (state.saved) queueMicrotask(() => { if (pendingRevokeAction === action) closeRevokeConfirmModal(); });
        });
        return;
      }
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
    openApplicationModal(match, trigger);
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

async function loadAppliedJobs({ preservePage = false, silent = false } = {}) {
  const generation = ++applicationRefreshGeneration;
  const previousPhase = homeApplicationsPhase;
  homeApplicationsPhase = 'loading';
  const container = document.getElementById('appliedJobsList');
  if (!container) return;
  bindApplicationModal();
  bindAppliedPreviewActions();
  if (!silent) {
    container.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'case-card';
    loading.innerHTML = '<div class="case-header"><div><h2>Loading applications…</h2></div></div>';
    container.appendChild(loading);
  }

  try {
    const payload = await readOwnedHome('applications', options => fetchJson('/api/applications/my', options));
    if (generation !== applicationRefreshGeneration) return;
    const apps = Array.isArray(payload) ? payload : payload?.items;
    if (!Array.isArray(apps) || apps.some(app => !app || typeof app !== 'object' || app.paralegalId && normalizeIdCandidate(app.paralegalId) !== currentFinancialOwner())) throw new Error('Applications could not be verified.');
    homeApplicationsPhase = 'ready';
    const nextFingerprint = dataFingerprint(apps);
    if (silent && previousPhase === 'ready' && nextFingerprint && nextFingerprint === applicationPayloadFingerprint) {
      if (pendingAppliedFilters) applyAppliedFilters();
      renderParalegalPriorityQueue();
      return appliedAppsCache;
    }
    applicationPayloadFingerprint = nextFingerprint;
    const visibleApps = apps.filter((app) => hasApplicationJob(app));
    appliedAppsCache = visibleApps;
    paralegalPrioritySnapshot.applications = visibleApps.filter(isActiveApplication);
    renderHomeApplications(visibleApps);
    appliedPage = preservePage ? appliedPage : 1;
    bindAppliedFilters();
    populateAppliedFilterOptions(visibleApps);
    applyAppliedFilters({ resetPage: false });
    renderParalegalPriorityQueue();
    maybeOpenApplicationFromQuery();
    return visibleApps;
  } catch (err) {
    if (generation !== applicationRefreshGeneration) return;
    homeApplicationsPhase = 'error';
    console.error('Failed to load applied jobs', err);
    appliedAppsCache = [];
    paralegalPrioritySnapshot.applications = [];
    if (selectors.homeApplicationPipeline) {
      selectors.homeApplicationPipeline.innerHTML = '<p class="private-office-secondary-state">Applications couldn’t load.</p><button type="button" class="office-calendar-control" data-home-applications-retry>Retry applications</button>';
      selectors.homeApplicationPipeline.querySelector('[data-home-applications-retry]')?.addEventListener('click', () => { void loadAppliedJobs({ preservePage: true }); });
    }
    if (selectors.homeApplicationsList) selectors.homeApplicationsList.replaceChildren();
    renderParalegalPriorityQueue();
    container.innerHTML = `
      <div class="case-card empty-state">
        <div class="case-header">
          <div>
            <h2>Unable to load applications</h2>
            <div class="case-subinfo">Reload your application history to continue.</div>
            <button type="button" class="completed-page-btn" data-applications-retry>Retry</button>
          </div>
        </div>
      </div>`;
    container.querySelector('[data-applications-retry]')?.addEventListener('click', () => {
      void loadAppliedJobs({ preservePage: true });
    });
    updateAppliedPagination({ total: 0 });
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
    getOwner: currentFinancialOwner,
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
    if (normalizedStatus) {
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
  if (homeApplicationsPhase !== 'ready') {
    if (homeApplicationsPhase === 'loading') {
      pendingAppliedFilters = { resetPage: resetPage || Boolean(pendingAppliedFilters?.resetPage) };
    }
    return;
  }
  const container = document.getElementById('appliedJobsList');
  if (!container) return;
  if (resetPage || pendingAppliedFilters?.resetPage) appliedPage = 1;
  pendingAppliedFilters = null;

  const { search, status, practice, dateRange, sort } = appliedFilters;
  const query = String(search?.value || '').trim().toLowerCase();
  const statusFilter = String(status?.value || 'all');
  const practiceFilter = String(practice?.value || 'all');
  const rangeFilter = String(dateRange ? dateRange.value : 'all');

  let filtered = appliedAppsCache.filter((app) => hasApplicationJob(app));

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
              <div class="case-subinfo">${escapeHtml(formatApplicationStatus(getApplicationStatusKey(app)))} · Applied on ${when}</div>
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
  if (cleaned === 'rejected') return 'Not selected';
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Submitted';
}

function renderParalegalPriorityQueue() {
  const list = document.querySelector('[data-paralegal-priority-list]');
  const count = document.querySelector('[data-paralegal-priority-count]');
  if (!list || homeAccountLost) return;
  const { invites = [], threads = [] } = paralegalPrioritySnapshot;
  const applications = homeApplicationsPhase === 'ready' ? (paralegalPrioritySnapshot.applications || []).filter(isActiveApplication) : [];
  const priorities = [];
  if (!invitationQueueUnavailable) for (const invite of invites) {
    if (String(invite.inviteStatus || invite.status || 'pending').toLowerCase() !== 'pending') continue;
    const caseId = getCaseId(invite); if (!caseId) continue;
    priorities.push({ title: 'Matter invitation', detail: invite.title || 'New invitation', label: 'Review invitation', href: `dashboard-paralegal.html?inviteCase=${encodeURIComponent(caseId)}#home`, unread: true });
  }
  for (const application of applications) {
    const pre = getApplicationPreEngagement(application);
    if (!['requested', 'changes_requested'].includes(pre?.status)) continue;
    const appId = String(application._id || application.id || ''); if (!appId) continue;
    priorities.push({ title: pre.status === 'changes_requested' ? 'Information changes requested' : 'Pre-engagement information requested', detail: application.jobId?.title || application.job?.title || 'Application', label: 'Complete request', href: `dashboard-paralegal.html?applicationId=${encodeURIComponent(appId)}#cases`, unread: true });
  }
  for (const assignment of deskAssignments) {
    if (assignmentReviewState(assignment) !== 'revision') continue;
    priorities.push({ title: 'Revisions requested', detail: assignment.title || 'Matter', label: 'Review requested changes', href: `case-detail.html?caseId=${encodeURIComponent(assignment.caseId)}&tab=files`, unread: true });
  }
  if (homeMessagesPhase === 'ready') for (const thread of threads) {
    if (!thread.unread) continue;
    priorities.push({ title: `${thread.unread} unread message${thread.unread === 1 ? '' : 's'}`, detail: thread.title || 'Matter conversation', label: 'Open messages', href: `case-detail.html?caseId=${encodeURIComponent(thread.caseId)}&tab=messages`, unread: true });
  }
  const sources = [[homeMessagesPhase, 'Messages'], [homeApplicationsPhase, 'Applications'], [homeDetailsPhase, 'Work details'], [dashboardStatus, 'Assignments']];
  const unavailable = sources.filter(([phase]) => phase === 'error').map(([, label]) => label);
  const loading = sources.some(([phase]) => phase === 'loading');
  const notice = unavailable.length ? `<div class="office-inbox-notice"><p>${escapeHtml(unavailable.join(', '))} couldn’t load.</p><button type="button" class="office-calendar-control" data-inbox-retry>Retry updates</button></div>` : loading ? '<p class="private-office-secondary-state">Checking updates…</p>' : '';
  const pages = Math.max(1, Math.ceil(priorities.length / 4));
  const requestedPage = new URL(window.location.href).searchParams.get('inboxPage') || '1';
  const inboxPage = Math.max(1, Math.min(pages, /^[1-9]\d*$/.test(requestedPage) ? Number(requestedPage) : 1));
  const visible = priorities.slice((inboxPage - 1) * 4, inboxPage * 4);
  if (count) count.textContent = loading ? 'Checking…' : priorities.length ? `${priorities.length} item${priorities.length === 1 ? '' : 's'}` : '';
  list.dataset.state = unavailable.length || invitationQueueUnavailable ? 'unavailable' : loading ? 'loading' : 'ready';
  list.innerHTML = notice + visible.map(item => `
    <div class="office-inbox-item${item.unread ? ' is-unread' : ''}">
      <div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div>
      <a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>
    </div>`).join('') + (!priorities.length && !notice && !invitationQueueUnavailable ? '<p class="private-office-secondary-state">No requests or unread messages.</p>' : '') + (pages > 1 ? `
      <nav class="office-inbox-pagination" aria-label="Inbox pages">
        <button type="button" class="office-calendar-control" data-inbox-page="${inboxPage - 1}" aria-label="Previous inbox page"${inboxPage === 1 ? ' disabled' : ''}>Previous</button>
        <span>Page ${inboxPage} of ${pages}</span>
        <button type="button" class="office-calendar-control" data-inbox-page="${inboxPage + 1}" aria-label="Next inbox page"${inboxPage === pages ? ' disabled' : ''}>Next</button>
      </nav>` : '');
  list.querySelector('[data-inbox-retry]')?.addEventListener('click', () => { void refreshDashboardFromServer('inbox', { force: true }); });
  list.querySelectorAll('[data-inbox-page]').forEach(button => button.addEventListener('click', () => {
    const url = new URL(window.location.href), page = Number(button.dataset.inboxPage);
    if (page === 1) url.searchParams.delete('inboxPage'); else url.searchParams.set('inboxPage', String(page));
    window.history.replaceState(window.history.state, '', url); renderParalegalPriorityQueue(); list.tabIndex = -1; list.focus({ preventScroll: true });
  }));
}

async function initDashboard() {
  const generation = dashboardRefreshGeneration, ownerId = currentFinancialOwner();
  dashboardRefreshInFlight = true;
  attachUIHandlers();
  bindDeskMatterSwitcher();
  try {
    const profilePromise = loadViewerProfile();
    const recommendationRequest = loadRecommendedMatters();
    const [profile, , dashboard, invites, deadlines, messages] = await Promise.all([
      profilePromise.catch(() => ({})),
      loadStripeStatus().catch(() => null),
      fetchParalegalData().catch((error) => {
        console.warn('Paralegal dashboard payload failed', error);
        return null;
      }),
      loadInvites().catch(() => []),
      loadDeadlineEvents().catch(() => null),
      loadHomeMessages().catch(() => null),
    ]);
    if (generation !== dashboardRefreshGeneration || ownerId !== currentFinancialOwner()) return;
    const viewer = profile || {};
    dashboardStatus = dashboard ? 'ready' : 'error';
    pendingApprovalReady = true;
    updateProfile(viewer);
    const snapshot = buildDashboardSnapshot({ dashboard, invites, deadlines, messages });
    dashboardPayloadFingerprint = dataFingerprint(snapshot);
    renderDashboardSnapshot(snapshot, { deferAssignments: true });
    await loadAppliedJobs();
    await recommendationRequest;
    if (generation !== dashboardRefreshGeneration || ownerId !== currentFinancialOwner()) return;
    initialDashboardHydrating = false;
    renderAssignments(mapActiveCasesToAssignments(snapshot.activeCases, snapshot.threads));
    paralegalPrioritySnapshot = {
      activeCases: snapshot.activeCases,
      invites: snapshot.invites,
      threads: snapshot.threads,
      deadlines: snapshot.deadlines,
      applications: appliedAppsCache,
    };
    renderParalegalPriorityQueue();
    maybeOpenInviteFromQuery();
    notifyCasesApplicationsRefresh('initial', {
      activeCases: snapshot.activeCases,
      dashboardAvailable: Boolean(dashboard),
    });
  } catch (err) {
    console.warn('Paralegal dashboard init failed', err);
    dashboardStatus = 'error';
    initialDashboardHydrating = false;
    renderAssignments([]);
    syncRecentActivityState({ invites: [], threads: [], deadlines: [] });
    renderDeadlines([], ['Calendar']);
    loadAppliedJobs();
    paralegalPrioritySnapshot = { activeCases: [], invites: [], threads: [], deadlines: [], applications: appliedAppsCache };
    renderParalegalPriorityQueue();
    notifyCasesApplicationsRefresh('initial', { activeCases: [], dashboardAvailable: false });
  } finally {
    dashboardRefreshInFlight = false;
    if (!dashboardDeparting && dashboardRefreshQueuedReason) {
      const reason = dashboardRefreshQueuedReason; dashboardRefreshQueuedReason = '';
      queueMicrotask(() => refreshDashboardFromServer(reason, { force: true }));
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void bootParalegalDashboard();
});

async function bootParalegalDashboard() {
  const user = typeof window.requireRole === 'function' ? await window.requireRole('paralegal') : null;
  if (!user) return;
  financialOwnerId = String(user._id || user.id || '');
  recommendationViewerId = normalizeIdCandidate(user._id || user.id || '');
  setupRecommendationHistorySync();
  bindClusterProfileMenu();
  applyRoleVisibility(user);
  initParalegalTour(user || {}, { force: consumeReplayFlag() });
  window.hydrateParalegalCluster?.(user || {});
  if (window.state) {
    window.state.viewerRole = String(user.role || '').toLowerCase();
  }
  setupDashboardAutoRefresh();
  await initDashboard();
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
  const modal = document.getElementById('availabilityModal');
  const openBtn = document.getElementById('updateAvailabilityLink');
  const quickAction = document.querySelector('[data-action="availability"]');
  const save = document.getElementById('saveAvailabilityBtn');
  const cancel = document.getElementById('cancelAvailabilityBtn');
  const status = document.getElementById('availabilityStatusInput');
  const date = document.getElementById('availabilityDateInput');
  const dateRow = document.getElementById('availabilityDateRow');
  const error = document.getElementById('availabilityError');
  if (!modal || !save || !cancel || !status || !date || !error) return;
  let pending = false, ownerId = '', baseline = null;
  const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'office-calendar-control'; reload.textContent = 'Reload Home'; reload.hidden = true;
  reload.addEventListener('click', () => window.location.reload()); error.after(reload);
  const api = {
    get: fetchJson,
    async post(path, body) {
      const response = await secureFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), suppressToast: true });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(data?.error || data?.msg || 'Availability could not be updated.'), { code: data?.code, status: response.status });
      return data;
    },
  };
  const syncDate = () => { dateRow.hidden = status.value !== 'unavailable'; };
  const close = (force = false) => {
    if (pending && !force) return;
    modal.classList.remove('show'); modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); modal.setAttribute('inert', ''); deactivateDialogFocus(modal);
    if (force) { ownerId = ''; baseline = null; status.value = ''; date.value = ''; error.textContent = ''; error.hidden = true; reload.hidden = true; }
  };
  const open = event => {
    event.preventDefault();
    if (pending || !profileStatusKnown || !currentFinancialOwner()) return;
    try { baseline = availabilitySnapshot(recommendationProfile); } catch { return; }
    ownerId = currentFinancialOwner(); status.value = baseline.availabilityDetails.status; date.value = availabilityDateOnly(baseline.availabilityDetails.nextAvailable); date.min = calendarRange().start;
    syncDate(); error.hidden = true; reload.hidden = true;
    modal.style.display = 'flex'; modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false'); modal.removeAttribute('inert');
    activateDialogFocus(modal, { initialFocus: status, returnFocus: event.currentTarget, onEscape: () => close() });
  };
  openBtn?.addEventListener('click', open); quickAction?.addEventListener('click', open);
  cancel.addEventListener('click', () => close()); status.addEventListener('change', syncDate);
  modal.addEventListener('click', event => { if (event.target === modal) close(); });
  window.addEventListener('lpc:home-account-changed', () => close(true));
  window.addEventListener('pagehide', () => close(true));
  save.addEventListener('click', async () => {
    if (pending || !ownerId || currentFinancialOwner() !== ownerId || !baseline) return;
    if (status.value === 'unavailable' && !date.checkValidity()) { date.reportValidity(); return; }
    const requested = { status: status.value, nextAvailable: status.value === 'unavailable' ? date.value : null };
    const savingOwner = ownerId;
    pending = true; save.disabled = true; cancel.disabled = true; status.disabled = true; date.disabled = true; save.textContent = 'Saving…'; error.hidden = true; reload.hidden = true;
    try {
      const saved = await saveAvailability(api, { ownerId: savingOwner, profile: baseline, ...requested, isCurrent: () => ownerId === savingOwner && currentFinancialOwner() === savingOwner });
      recommendationProfile = { ...recommendationProfile, ...saved };
      syncAvailabilityProfile(saved); persistAvailabilityState(saved.availability, saved.availabilityDetails);
      pending = false; close();
      publishLifecycleRefresh({ url: '/api/paralegals/update-availability', method: 'POST' });
    } catch (failure) {
      if (failure.code === 'ACCOUNT_CHANGED') { clearHomeAccount(); close(true); }
      else if (ownerId === savingOwner && currentFinancialOwner() === savingOwner) {
        error.textContent = failure.message || 'Availability could not be updated.'; error.hidden = false;
        reload.hidden = !['ACCOUNT_CONFLICT', 'AVAILABILITY_UNCONFIRMED'].includes(failure.code);
      }
    } finally {
      pending = false; save.disabled = false; cancel.disabled = false; status.disabled = false; date.disabled = false; save.textContent = 'Save';
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAvailabilityModal);
} else {
  initAvailabilityModal();
}
