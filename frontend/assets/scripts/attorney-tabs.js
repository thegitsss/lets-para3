import { createLegacyAttorneyHome } from "./legacy-attorney-home.mjs";
import { createHiring } from "./attorney-v2/hiring.mjs";
import { createPreEngagement } from "./attorney-v2/pre-engagement.mjs";
import { createMatterApplications } from "./attorney-v2/matter-applications.mjs";
import { createMatterExport, createMatterExportBatch } from "./attorney-v2/matter-exports.mjs";
import { createMatterArchive } from "./attorney-v2/matter-archive.mjs";
import { createMatterDownloads } from "./attorney-v2/matter-downloads.mjs";
import { createMatterReceipt } from "./attorney-v2/matter-receipts.mjs";
import { createMatterInvitations } from "./attorney-v2/matter-invitations.mjs";
import { createMatterModeration } from "./attorney-v2/matter-moderation.mjs";
import { createMatterNotes } from "./attorney-v2/matter-notes.mjs";
import { createApiClient } from "./attorney-v2/api-client.mjs";
import { createPrivateState } from "./attorney-v2/private-state.mjs";
import { classifySession } from "./attorney-v2/session-boundary.mjs";
import { secureFetch, loadUserHeaderInfo } from "./auth.js";
import { scanNotificationCenters } from "./utils/notifications.js";
import { mountAttorneySavedViews } from "./attorney-v2/saved-views.mjs";
import { activateDialogFocus, deactivateDialogFocus } from "./utils/dialog-focus.js";
import { confirmAction, showAlert } from "./utils/dialogs.js";
import { normalizeHttpNavigationUrl } from "./utils/navigation-url.js";
import { createCurrentDraftInventory } from "./utils/current-draft-inventory.mjs";
import { safeCurrentMatterReturn } from "./attorney-v2/matter-return.mjs";

const PAGE_ID = window.__ATTORNEY_PAGE__ || "overview";
const ROLE_SPEC = window.__TAB_ROLE__;
const REQUIRED_ROLES = Array.isArray(ROLE_SPEC)
  ? ROLE_SPEC.map((role) => String(role || "").toLowerCase()).filter(Boolean)
  : typeof ROLE_SPEC === "string" && ROLE_SPEC.includes(",")
  ? ROLE_SPEC.split(",").map((role) => role.trim().toLowerCase()).filter(Boolean)
  : ROLE_SPEC
  ? [String(ROLE_SPEC).toLowerCase()]
  : ["attorney"];
const HEADER_ONLY_ROUTES = {
  paralegal: new Set(["overview", "case-files", "profile-settings"]),
  attorney: new Set(["create-case", "profile-settings"]),
};
const MISSING_DOCUMENT_MESSAGE = "This document is no longer available for download.";
const CASE_VIEW_FILTERS = ["active", "draft", "archived", "inquiries"];
const CASE_PAGE_SIZE = 15;
const ESCROW_PAGE_SIZE = 5;
const CASE_POSTED_STORAGE_KEY = "lpc_case_posted_notice";
const AUTO_RELIST_TYPES = new Set(["zero_auto", "partial_attorney", "expired_zero", "admin"]);
const FUNDED_WORKSPACE_STATUSES = new Set([
  "in progress",
  "in_progress",
]);
const TERMINAL_CASE_STATUSES = new Set(["completed", "closed"]);
const PARALEGAL_AVATAR_FALLBACK = "/assets/avatar-placeholder.svg";
const ATTORNEY_AVATAR_FALLBACK = PARALEGAL_AVATAR_FALLBACK;
function getProfileImageUrl(user = {}) {
  const role = String(user.role || "").toLowerCase();
  const pending = role === "paralegal" ? user.pendingProfileImage : "";
  const stored = user.profileImage || user.avatarURL;
  if (pending) return pending;
  if (stored) return stored;
  if (role === "attorney") return ATTORNEY_AVATAR_FALLBACK;
  return PARALEGAL_AVATAR_FALLBACK;
}

const INVITE_AVATAR_FALLBACK = PARALEGAL_AVATAR_FALLBACK;

const overviewSignals = {
  casesCreatedCount: null,
  overdueCount: null,
};

const state = {
  user: null,
  notifications: [],
  cases: [],
  caseLookup: new Map(),
  casesPromise: null,
  casesArchived: [],
  casesArchivedPromise: null,
  casesViewFilter: "active",
  casesSearchTerm: "",
  tasks: [],
  tasksError: "",
  tasksPage: 1,
  tasksPages: 1,
  tasksTotal: 0,
  latestThreadId: null,
  latestThreadCaseId: null,
  threadOverview: new Map(),
  billing: {
    escrows: [],
    escrowsLoaded: false,
    escrowPage: 0,
    escrowSort: "funded_desc",
    hasPaymentMethod: null,
  },
  draftSelection: new Set(),
  archivedSelection: new Set(),
  archivedStatusFilter: "all",
  matterPracticeFilter: "",
  matterDeadlineFilter: "",
  matterUpdatedFilter: "",
  matterSort: "recent",
  casesPage: {
    active: 0,
    draft: 0,
    archived: 0,
    inquiries: 0,
  },
  archiveHighlightCaseId: null,
  archiveHighlightApplied: false,
  overview: {
    cases: [],
    eligibleCaseIds: new Set(),
    pollTimer: null,
  },
  localDrafts: [],
};
let legacyHome = null;
let homeAttentionRefreshDeferred = false;
let currentDraftInventory = null;
let currentMatterInventory = null;

const ATTORNEY_ONBOARDING_STEP_KEY = "lpc_attorney_onboarding_step";
const ATTORNEY_ONBOARDING_MODAL_SEEN_KEY = "lpc_attorney_onboarding_modal_seen_case";
const ATTORNEY_ONBOARDING_MODAL_SEEN_PREFIX = "lpc_attorney_onboarding_modal_seen";
const ATTORNEY_ONBOARDING_COMPLETE_NOTICE_KEY = "lpc_attorney_onboarding_complete_notice_seen";
const ATTORNEY_ONBOARDING_DISMISSED_KEY = "lpc_attorney_onboarding_dismissed";
let onboardingChecklistApi = null;
let caseOnboardingPrompted = false;
let caseOnboardingModalBound = false;
let caseOnboardingScrollY = 0;
let caseOnboardingBodyOverflow = "";
let onboardingAttentionCompleteTimer = null;
let onboardingAttentionHydrated = false;
let onboardingAttentionInitialized = false;
let onboardingAttentionWasComplete = false;

function getAttorneyOnboardingStep() {
  try {
    return sessionStorage.getItem(ATTORNEY_ONBOARDING_STEP_KEY);
  } catch {
    return null;
  }
}

function setAttorneyOnboardingStep(step) {
  try {
    if (!step) {
      sessionStorage.removeItem(ATTORNEY_ONBOARDING_STEP_KEY);
      return;
    }
    sessionStorage.setItem(ATTORNEY_ONBOARDING_STEP_KEY, step);
  } catch {}
}

function clearAttorneyOnboardingStep() {
  try {
    sessionStorage.removeItem(ATTORNEY_ONBOARDING_STEP_KEY);
  } catch {}
}

function getCaseOnboardingModalSeen() {
  try {
    return sessionStorage.getItem(ATTORNEY_ONBOARDING_MODAL_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function setCaseOnboardingModalSeen() {
  try {
    sessionStorage.setItem(ATTORNEY_ONBOARDING_MODAL_SEEN_KEY, "1");
  } catch {}
}

let openCaseMenu = null;
let openCaseMenuTrigger = null;
let caseMenuKeydownBound = false;
let matterSavedViews = null;
let homeTabsBound = false;
let headerDocListenersBound = false;
const applicantDrawerCache = new Map();
let applicantReturnHandled = false;
let applicantReturnContext = null;
let applicantsCaseHandled = false;
let applicantReturnResolved = false;
let applicantReturnOpening = false;
const caseApplicationCounts = new Map();
let applicationsCache = [];
let applicationsPromise = null;
let applicationsReadEpoch = 0;
let applicationParentController = null;
let applicationParentPromise = null;
let notificationAutoRefreshBound = false;
let applicantAutoRefreshTimer = null;
let applicantAutoRefreshEpoch = 0;
const applicationRefreshInputs = new Set();
let pendingApplicationParentStatus = null;
let overviewPollingBound = false;
const applicantDrawerRequests = new Map();

function repositionOpenCaseMenu() {
  if (!openCaseMenu) return;
  positionCaseMenu(openCaseMenu);
}

const dashboardViewState = {
  routerAttached: false,
  viewMap: new Map(),
  navLinks: [],
  currentView: "",
  casesInitialized: false,
  casesInitPromise: null,
  tasksInitialized: false,
  tasksInitPromise: null,
  billingInitialized: false,
  billingInitPromise: null,
};

document.addEventListener("DOMContentLoaded", () => {
  void bootAttorneyExperience();
});

async function bootAttorneyExperience() {
  let sessionUser = null;
  if (typeof window.checkSession === "function") {
    try {
      const session = await window.checkSession(undefined, { redirectOnFail: true });
      sessionUser = session?.user || session;
    } catch {
      sessionUser = null;
    }
  }
  if (!sessionUser && typeof window.requireRole === "function") {
    const fallbackRole = REQUIRED_ROLES[0] || "attorney";
    sessionUser = await window.requireRole(fallbackRole);
  }
  if (!sessionUser) return;

  const normalizedRole = String(sessionUser.role || "").toLowerCase();
  if (REQUIRED_ROLES.length && !REQUIRED_ROLES.includes(normalizedRole)) {
    if (typeof window.redirectUserDashboard === "function") {
      window.redirectUserDashboard(normalizedRole || "attorney");
    } else {
      window.location.href = "login.html";
    }
    return;
  }

  const user = sessionUser;
  weeklyNoteOwnerId = String(user.id || user._id || "");
  await loadUserHeaderInfo();
  applyRoleVisibility(user);
  if (!state.user) {
    state.user = user;
  }
  await bootstrap();
}

function applyRoleVisibility(user) {
  const role = String(user?.role || "").toLowerCase();
  document.querySelectorAll("[data-force-visible]").forEach((el) => {
    el.style.display = "";
    el.hidden = false;
  });
  if (role === "paralegal") {
    document.querySelectorAll("[data-attorney-only]").forEach((el) => {
      el.style.display = "none";
    });
  }
  if (role === "attorney") {
    document.querySelectorAll("[data-paralegal-only]").forEach((el) => {
      if (el.dataset.forceVisible !== undefined) {
        el.style.display = "";
        el.hidden = false;
      } else {
        el.style.display = "none";
      }
    });
  }
}

function bindImmediateCreateCaseActions() {
  document.querySelectorAll('[data-case-quick="create"]').forEach((btn) => {
    if (btn.dataset.boundCreateCase === "true") return;
    btn.dataset.boundCreateCase = "true";
    btn.addEventListener("click", () => {
      window.location.href = "create-case.html";
    });
  });
}

async function bootstrap() {

  if (!state.archiveHighlightCaseId) {
    state.archiveHighlightCaseId = getArchiveHighlightCaseId();
  }
  ensureHeaderStyles();
  const pageKey = (PAGE_ID || "").toLowerCase();
  const role = String(state.user?.role || "").toLowerCase();
  const headerOnly = HEADER_ONLY_ROUTES[role]?.has(pageKey);
  const skipNotifications = role !== "paralegal" && headerOnly && pageKey !== "profile-settings";
  await initHeader({ skipNotifications });
  bindImmediateCreateCaseActions();
  bindNotificationAutoRefresh();
  if (headerOnly) {
    return;
  }

  await initOverviewPage();
}

function bindNotificationAutoRefresh() {
  if (notificationAutoRefreshBound) return;
  notificationAutoRefreshBound = true;
  // A background response can arrive after the pointer moves onto a menu button,
  // before its press or click. Keep that target in place through activation.
  const finishInput = key => window.setTimeout(() => {
    applicationRefreshInputs.delete(key);
    flushApplicationParentStatus();
  }, 0);
  const menuTrigger = target => target?.closest?.('[data-cases-wrapper] [data-case-menu-trigger]');
  document.addEventListener('pointermove', event => {
    if (menuTrigger(event.target)) applicationRefreshInputs.add(`hover:${event.pointerId}`);
  }, true);
  document.addEventListener('pointerout', event => {
    const trigger = menuTrigger(event.target);
    if (trigger && trigger !== menuTrigger(event.relatedTarget)) {
      applicationRefreshInputs.delete(`hover:${event.pointerId}`);
      flushApplicationParentStatus();
    }
  }, true);
  document.addEventListener('pointercancel', event => {
    applicationRefreshInputs.delete(`hover:${event.pointerId}`);
  }, true);
  // Run after the table's delegated click handler has opened the menu. A
  // pointer-up timer alone can run before that click reaches the document.
  document.addEventListener('click', () => {
    for (const key of applicationRefreshInputs) {
      if (key.startsWith('hover:')) applicationRefreshInputs.delete(key);
    }
    flushApplicationParentStatus();
  });
  document.addEventListener('pointerdown', event => {
    if (event.target.closest('[data-cases-wrapper]')) applicationRefreshInputs.add(`pointer:${event.pointerId}`);
  }, true);
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, event => finishInput(`pointer:${event.pointerId}`), true);
  document.addEventListener('keydown', event => {
    if (['Enter', ' '].includes(event.key) && event.target.closest('[data-cases-wrapper]')) applicationRefreshInputs.add(`key:${event.key}`);
  }, true);
  document.addEventListener('keyup', event => finishInput(`key:${event.key}`), true);
  window.addEventListener('blur', () => { applicationRefreshInputs.clear(); flushApplicationParentStatus(); });
  window.addEventListener("lpc:notifications-refreshed", (event) => {
    const types = event?.detail?.types;
    if (!Array.isArray(types) || !types.length) return;
    const lowerTypes = new Set(types.map((type) => String(type || "").toLowerCase()));
    if (!lowerTypes.has("application_submitted") && !lowerTypes.has("pre_engagement_submitted")) return;
    if (applicantAutoRefreshTimer) return;
    const ticket = ++applicantAutoRefreshEpoch;
    const refresh = async () => {
      if (ticket !== applicantAutoRefreshEpoch) return;
      let deferred = deferApplicationAutoRefresh();
      try {
        if (!deferred) deferred = await refreshApplicationsOverview({ force: true }) === false;
      } catch (err) {
        console.warn("Auto-refresh applications failed", err);
      } finally {
        if (ticket === applicantAutoRefreshEpoch) applicantAutoRefreshTimer = deferred ? window.setTimeout(refresh, 400) : null;
      }
    };
    applicantAutoRefreshTimer = window.setTimeout(refresh, 400);
  });
}

function deferApplicationAutoRefresh() {
  if (applicantReturnOpening || applicationRefreshInputs.size) return true;
  return Array.from(document.querySelectorAll('[data-applicants-row]:not(.hidden), .case-actions.open, [role="dialog"], [aria-modal="true"]'))
    .some(element => element.getClientRects().length && !element.closest('[hidden], [inert]'));
}

// -------------------------
// Header + Notifications
// -------------------------
function ensureHeaderStyles() {
  if (document.getElementById("attorney-shared-header")) return;
  const style = document.createElement("style");
  style.id = "attorney-shared-header";
  style.textContent = `
  .lpc-shared-header{display:flex;justify-content:flex-end;align-items:flex-start;position:relative;z-index:2000;margin-bottom:32px;font-family:'Sarabun',sans-serif;overflow:visible}
  .lpc-shared-header .header-controls{display:flex;align-items:center;gap:20px;position:relative;z-index:2001;overflow:visible}
  .lpc-shared-header .btn{border-radius:999px;padding:10px 18px;font-weight:600;border:1px solid transparent;background:#b6a47a;color:#fff;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;transition:background .2s ease,transform .2s ease}
  .lpc-shared-header .btn:hover{transform:translateY(-1px);background:#9c8a63}
  .lpc-shared-header .btn.btn-outline{background:transparent;border-color:rgba(0,0,0,0.08);color:#1a1a1a}
  .lpc-shared-header .btn.btn-outline:hover{border-color:#b6a47a;color:#b6a47a;background:rgba(182,164,122,0.06)}
  .lpc-shared-header .user-chip{display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,0.6);border:none;cursor:pointer;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);transition:border-color .2s ease, box-shadow .2s ease}
  .lpc-shared-header .user-chip img{width:44px;height:44px;border-radius:50%;border:2px solid #fff;box-shadow:none;object-fit:cover}
  .lpc-shared-header .user-chip strong{display:block;font-family:var(--font-serif);font-weight: 600;letter-spacing:.02em;color:#1a1a1a;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lpc-shared-header .user-chip span{font-size:.85rem;color:#6b6b6b;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  body.theme-dark .lpc-shared-header .user-chip{background:rgba(15,23,42,0.4);border-color:transparent;box-shadow:none}
  body.theme-dark .lpc-shared-header .user-chip strong{color:#fff}
  body.theme-dark .lpc-shared-header .user-chip span{color:rgba(255,255,255,0.8)}
  .lpc-shared-header .profile-dropdown{position:absolute;right:0;top:calc(100% + 10px);background:var(--panel,#fff);border:1px solid var(--line,rgba(0,0,0,0.08));border-radius:16px;box-shadow:0 18px 30px rgba(0,0,0,0.12);display:none;flex-direction:column;min-width:200px;z-index:9999;pointer-events:auto;overflow:visible;color:var(--ink,#1a1a1a)}
  .lpc-shared-header .profile-dropdown.show{display:flex;pointer-events:auto;overflow:visible}
  .lpc-shared-header .profile-dropdown button,
  .lpc-shared-header .profile-dropdown a{background:none;border:none;padding:.85rem 1.1rem;text-align:left;font-size:.92rem;cursor:pointer;color:inherit;text-decoration:none;display:block;font-weight:200;border-radius:12px;margin:4px 6px;width:calc(100% - 12px)}
  .lpc-shared-header .profile-dropdown button:hover,
  .lpc-shared-header .profile-dropdown a:hover{background:rgba(0,0,0,0.04)}
  .lpc-shared-header .profile-dropdown .logout-btn{color:#b91c1c;background:rgba(185,28,28,0.08);border:1px solid rgba(185,28,28,0.2)}
  .lpc-shared-header .profile-dropdown .logout-btn:hover{background:rgba(185,28,28,0.15);color:#991b1b}
  body.theme-dark .lpc-shared-header .profile-dropdown button:hover,
  body.theme-dark .lpc-shared-header .profile-dropdown a:hover{background:rgba(255,255,255,0.06)}
  body.theme-dark .lpc-shared-header .profile-dropdown .logout-btn{border-top-color:rgba(255,255,255,0.08)}
  `;
  document.head.appendChild(style);
}

const SHARED_NOTIF_ENHANCE_KEY = "sharedNotifEnhanced";
const SHARED_NOTIF_ITEM_KEY = "sharedNotifItemBound";

function enhanceSharedHeaderNotificationScroll() {
  const initList = (list) => {
    if (!list || list.dataset[SHARED_NOTIF_ENHANCE_KEY] === "true") return;
    list.dataset[SHARED_NOTIF_ENHANCE_KEY] = "true";

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const item = entry.target;
          if (!(item instanceof HTMLElement)) return;
          if (!entry.isIntersecting) return;
          item.classList.add("notif-fade-in");
          observer.unobserve(item);
        });
      },
      { root: list, threshold: 0.2, rootMargin: "0px 0px -4% 0px" }
    );

    const bindItems = () => {
      const items = list.querySelectorAll(".notif-item");
      items.forEach((item) => {
        if (!(item instanceof HTMLElement)) return;
        if (item.dataset[SHARED_NOTIF_ITEM_KEY] === "true") return;
        item.dataset[SHARED_NOTIF_ITEM_KEY] = "true";
        item.classList.add("notif-fade-ready");
        observer.observe(item);
      });
    };

    const itemObserver = new MutationObserver(() => bindItems());
    itemObserver.observe(list, { childList: true, subtree: true });
    bindItems();
  };

  document
    .querySelectorAll(".lpc-shared-header [data-notification-list]")
    .forEach((list) => initList(list));
}

async function initHeader(options = {}) {
  const { skipNotifications = false } = options;
  const target = document.querySelector("[data-attorney-header]");
  if (!target) return;
  target.innerHTML = `
    <div class="lpc-shared-header">
      <div class="header-controls" data-notification-center>
        <div class="notification-wrapper">
          <button class="notification-icon" type="button" aria-label="View notifications" data-notification-toggle>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            <span class="notification-badge" data-notification-badge>0</span>
          </button>
          <div class="notifications-panel notif-panel hidden" role="region" aria-live="polite" data-notification-panel>
            <div class="notif-header" aria-label="Notifications"></div>
            <div class="notif-scroll" data-notification-list></div>
            <div class="notif-empty" data-notification-empty>Loading…</div>
            <button type="button" class="notif-markall" data-notification-mark>Mark All Read</button>
          </div>
        </div>
        <div class="user-chip" id="headerUser" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-controls="profileDropdown" aria-label="Open profile menu">
          <img id="headerAvatar" src="${ATTORNEY_AVATAR_FALLBACK}" alt="Attorney avatar" />
          <div>
            <strong id="headerName">Attorney</strong>
          </div>
          <div class="profile-dropdown" id="profileDropdown" aria-hidden="true">
            <a href="profile-settings.html" data-account-settings>Account Settings</a>
            <button type="button" class="logout-btn" data-logout>Log Out</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const cachedUser = getStoredUserSnapshot();
  if (cachedUser) {
    applyUserToHeader(cachedUser);
  }
  await loadUser();
  bindHeaderEvents();
  if (!skipNotifications) {
    scanNotificationCenters();
  }
  enhanceSharedHeaderNotificationScroll();
}

function bindHeaderEvents() {
  const profileTrigger = document.getElementById("headerUser");
  const profileMenu = document.getElementById("profileDropdown");
  const settingsBtn = profileMenu?.querySelector("[data-account-settings]");

  if (profileTrigger && profileMenu) {
    const setProfileMenuOpen = (open) => {
      profileMenu.classList.toggle("show", open);
      profileMenu.setAttribute("aria-hidden", open ? "false" : "true");
      profileTrigger.setAttribute("aria-expanded", open ? "true" : "false");
    };
    setProfileMenuOpen(false);

    profileTrigger.addEventListener("click", (evt) => {
      if (profileMenu.contains(evt.target)) return;
      const shouldShow = !profileMenu.classList.contains("show");
      document.querySelectorAll(".profile-dropdown.show").forEach((el) => {
        el.classList.remove("show");
        el.setAttribute("aria-hidden", "true");
      });
      setProfileMenuOpen(shouldShow);
    });
    profileTrigger.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        const shouldShow = !profileMenu.classList.contains("show");
        setProfileMenuOpen(shouldShow);
      } else if (evt.key === "Escape") {
        setProfileMenuOpen(false);
      }
    });
  }

  settingsBtn?.addEventListener("click", () => {
    window.location.href = "profile-settings.html";
  });

  if (!headerDocListenersBound) {
    headerDocListenersBound = true;
    document.addEventListener("click", (evt) => {
      const menu = document.getElementById("profileDropdown");
      const trigger = document.getElementById("headerUser");
      if (menu && trigger && !menu.contains(evt.target) && !trigger.contains(evt.target)) {
        menu.classList.remove("show");
        menu.setAttribute("aria-hidden", "true");
        trigger.setAttribute("aria-expanded", "false");
      }
    });

    document.addEventListener("keydown", (evt) => {
      if (evt.key !== "Escape") return;
      const menu = document.getElementById("profileDropdown");
      const trigger = document.getElementById("headerUser");
      if (!menu || !trigger) return;
      if (!menu.classList.contains("show")) return;
      menu.classList.remove("show");
      menu.setAttribute("aria-hidden", "true");
      trigger.setAttribute("aria-expanded", "false");
    });
  }
}

async function loadUser() {
  try {
    const res = await secureFetch("/api/users/me", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Failed user fetch");
    const user = await res.json();
    applyUserToHeader(user);
  } catch (err) {
    console.warn("Unable to load user profile", err);
  }
}

function applyUserToHeader(user = {}) {
  if (!user || typeof user !== "object") return;
  state.user = { ...(state.user || {}), ...user };
  const current = state.user;
  const name = [current.firstName, current.lastName].filter(Boolean).join(" ") || current.name || "Attorney";
  const avatar = getProfileImageUrl(current);
  const nameEl = document.getElementById("headerName");
  const avatarEl = document.getElementById("headerAvatar");
  const heading = document.getElementById("user-name-heading");
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) avatarEl.src = avatar;
  if (heading) heading.textContent = current.firstName || heading.textContent;
  updateWelcomeGreeting();
  updateOnboardingChecklist();
  if (current.profileImage) {
    const avatarNode = document.querySelector("#user-avatar");
    if (avatarNode) avatarNode.src = current.profileImage;
  }
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

function updateWelcomeGreeting() {
  const greetingEl = document.getElementById("welcomeGreeting");
  if (!greetingEl) return;
  greetingEl.textContent = "Welcome";
}

function handleStoredUserUpdate(event) {
  if (event.key !== "lpc_user") return;
  if (!event.newValue) return;
  try {
    const user = JSON.parse(event.newValue);
    applyUserToHeader(user || {});
  } catch (_) {}
}

function handleLocalUserUpdate(event) {
  if (!event?.detail) return;
  applyUserToHeader(event.detail);
}

window.addEventListener("storage", handleStoredUserUpdate);
window.addEventListener("lpc:user-updated", handleLocalUserUpdate);

function isAttorneyProfileComplete(user = {}) {
  if (!user || typeof user !== "object") return false;
  if (user.onboarding && typeof user.onboarding === "object" && user.onboarding.attorneyProfileCompleted === true) {
    return true;
  }
  const practiceAreas = Array.isArray(user.practiceAreas)
    ? user.practiceAreas.filter((item) => String(item || "").trim())
    : [];
  const publications = Array.isArray(user.publications)
    ? user.publications.filter((item) => String(item || "").trim())
    : [];
  const description = String(user.practiceDescription || user.bio || "").trim();
  const lawFirm = String(user.lawFirm || "").trim();
  const linkedInURL = String(user.linkedInURL || "").trim();
  const firmWebsite = String(user.firmWebsite || "").trim();
  return Boolean(
    practiceAreas.length ||
      publications.length ||
      description ||
      lawFirm ||
      linkedInURL ||
      firmWebsite
  );
}

function getAttorneyOnboardingProgress() {
  const profileDone = isAttorneyProfileComplete(state.user || {});
  const paymentDone = state.billing.hasPaymentMethod === true;
  const caseDone = legacyHome?.state.inventory.phase === "ready" && legacyHome.state.inventory.value.postedCount > 0;
  return { profileDone, paymentDone, caseDone };
}

function getNextOnboardingStep(progress = getAttorneyOnboardingProgress()) {
  if (!progress.profileDone) return "profile";
  if (!progress.paymentDone) return "payment";
  if (!progress.caseDone) return "case";
  return "";
}

function getOnboardingAttentionCopy(step) {
  if (step === "profile") {
    return {
      title: "Finish your profile",
      text: "Add your profile details so everything is ready before you post your first Matter.",
      cta: "Open profile",
    };
  }
  if (step === "payment") {
    return {
      title: "Add a payment method",
      text: "Add your payment method now so you can fund a Matter when you're ready.",
      cta: "Open payments",
    };
  }
  if (step === "case") {
    return {
      title: "Post your first Matter",
      text: "Create your first Matter to start receiving paralegal interest and move work forward.",
      cta: "Create Matter",
    };
  }
  return { title: "", text: "", cta: "Open step" };
}

function clearOnboardingModalSeen(step) {
  try {
    if (step === "case") {
      sessionStorage.removeItem(ATTORNEY_ONBOARDING_MODAL_SEEN_KEY);
      return;
    }
    if (step === "profile" || step === "payment") {
      sessionStorage.removeItem(`${ATTORNEY_ONBOARDING_MODAL_SEEN_PREFIX}_${step}`);
    }
  } catch {}
}

function getOnboardingCompleteNoticeSeen() {
  try {
    return sessionStorage.getItem(ATTORNEY_ONBOARDING_COMPLETE_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

function setOnboardingCompleteNoticeSeen() {
  try {
    sessionStorage.setItem(ATTORNEY_ONBOARDING_COMPLETE_NOTICE_KEY, "1");
  } catch {}
}

function clearOnboardingCompleteNoticeSeen() {
  try {
    sessionStorage.removeItem(ATTORNEY_ONBOARDING_COMPLETE_NOTICE_KEY);
  } catch {}
}

function isAttorneyOnboardingDismissed() {
  try {
    return sessionStorage.getItem(ATTORNEY_ONBOARDING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setAttorneyOnboardingDismissed(value) {
  try {
    if (value) {
      sessionStorage.setItem(ATTORNEY_ONBOARDING_DISMISSED_KEY, "1");
    } else {
      sessionStorage.removeItem(ATTORNEY_ONBOARDING_DISMISSED_KEY);
    }
  } catch {}
}

function clearOnboardingAttentionCompleteTimer() {
  if (!onboardingAttentionCompleteTimer) return;
  clearTimeout(onboardingAttentionCompleteTimer);
  onboardingAttentionCompleteTimer = null;
}

function updateCaseOnboardingSkipButton() {
  const btn = document.getElementById("caseOnboardingSkipBtn");
  if (!btn) return;
  const shouldShow = getAttorneyOnboardingStep() === "case";
  btn.hidden = !shouldShow;
  btn.setAttribute("aria-hidden", shouldShow ? "false" : "true");
}

function skipAttorneyOnboardingFlow() {
  clearAttorneyOnboardingStep();
  setAttorneyOnboardingDismissed(true);
  clearOnboardingModalSeen("profile");
  clearOnboardingModalSeen("payment");
  clearOnboardingModalSeen("case");
  caseOnboardingPrompted = true;
  document.querySelectorAll(".onboarding-pulse").forEach((el) => el.classList.remove("onboarding-pulse"));
  try {
    hideCaseOnboardingModal();
  } catch {}
  updateCaseOnboardingSkipButton();
  updateOnboardingChecklist();
  renderNeedsAttentionQueue();
}

function openOnboardingStepWithPopup(step) {
  if (!step) return;
  setAttorneyOnboardingDismissed(false);
  if (step === "profile") {
    setAttorneyOnboardingStep("profile");
    clearOnboardingModalSeen("profile");
    window.location.href = "profile-settings.html?onboardingStep=profile&profilePrompt=1";
    return;
  }
  if (step === "payment") {
    setAttorneyOnboardingStep("payment");
    clearOnboardingModalSeen("payment");
    window.location.href = "profile-settings.html?onboardingStep=payment";
    return;
  }
  if (step === "case") {
    setAttorneyOnboardingStep("case");
    clearOnboardingModalSeen("case");
    caseOnboardingPrompted = false;
    if (typeof showDashboardView === "function") {
      showDashboardView("cases");
    } else {
      window.location.hash = "cases";
    }
    setTimeout(() => {
      maybePromptCaseOnboarding();
    }, 280);
  }
}

function updateOnboardingAttentionCard(progress = getAttorneyOnboardingProgress()) {
  const card = document.getElementById("attorneyOnboardingAttentionCard");
  if (!card) return;
  const titleEl = card.querySelector("[data-onboarding-attention-title]");
  const textEl = card.querySelector("[data-onboarding-attention-text]");
  const ctaEl = card.querySelector("[data-onboarding-attention-action]");
  const progressCopyEl = card.querySelector("[data-onboarding-progress-copy]");
  const progressEl = card.querySelector(".onboarding-attention-progress");
  const progressBarEl = card.querySelector("[data-onboarding-progress-bar]");
  const doneByStep = {
    profile: Boolean(progress.profileDone),
    payment: Boolean(progress.paymentDone),
    case: Boolean(progress.caseDone),
  };
  const completedCount = Object.values(doneByStep).filter(Boolean).length;
  if (progressCopyEl) progressCopyEl.textContent = `${completedCount} of 3 complete`;
  if (progressEl) progressEl.setAttribute("aria-valuenow", String(completedCount));
  if (progressBarEl) progressBarEl.style.width = `${(completedCount / 3) * 100}%`;

  if (!onboardingAttentionHydrated) {
    clearOnboardingAttentionCompleteTimer();
    card.hidden = true;
    card.setAttribute("aria-hidden", "true");
    return;
  }

  const step = getNextOnboardingStep(progress);
  const isComplete = !step;
  const hadSnapshot = onboardingAttentionInitialized;
  const transitionedToComplete = hadSnapshot && !onboardingAttentionWasComplete && isComplete;
  onboardingAttentionInitialized = true;
  onboardingAttentionWasComplete = isComplete;

  if (!isComplete) {
    if (isAttorneyOnboardingDismissed()) {
      clearOnboardingAttentionCompleteTimer();
      card.hidden = true;
      card.setAttribute("aria-hidden", "true");
      return;
    }
    clearOnboardingAttentionCompleteTimer();
    clearOnboardingCompleteNoticeSeen();
    card.classList.remove("is-static", "is-complete");
    const copy = getOnboardingAttentionCopy(step);
    if (ctaEl) {
      ctaEl.hidden = false;
      ctaEl.textContent = copy.cta;
      ctaEl.setAttribute("aria-label", `${copy.cta}: ${copy.title}`);
    }
    if (titleEl) titleEl.textContent = copy.title;
    if (textEl) {
      textEl.hidden = false;
      textEl.textContent = copy.text;
    }
    card.dataset.step = step;
    card.hidden = false;
    card.setAttribute("aria-hidden", "false");
    return;
  }

  card.dataset.step = "";
  setAttorneyOnboardingDismissed(false);
  card.classList.add("is-static", "is-complete");
  if (titleEl) titleEl.textContent = "Onboarding Complete";
  if (textEl) {
    textEl.hidden = false;
    textEl.textContent = "Everything is set. You're ready to work with confidence.";
  }
  if (ctaEl) ctaEl.hidden = true;

  if (!transitionedToComplete || getOnboardingCompleteNoticeSeen()) {
    card.hidden = true;
    card.setAttribute("aria-hidden", "true");
    return;
  }

  card.hidden = false;
  card.setAttribute("aria-hidden", "false");
  setOnboardingCompleteNoticeSeen();
  clearOnboardingAttentionCompleteTimer();
  onboardingAttentionCompleteTimer = window.setTimeout(() => {
    card.hidden = true;
    card.setAttribute("aria-hidden", "true");
    onboardingAttentionCompleteTimer = null;
  }, 4200);
}

function setupOnboardingChecklist() {
  if (onboardingChecklistApi) return onboardingChecklistApi;
  const root = document.getElementById("attorneyOnboardingChecklist");
  if (!root) return null;

  const lookup = (key) => root.querySelector(`[data-onboarding-step="${key}"]`);
  const stepRefs = {
    profile: {
      wrapper: lookup("profile"),
      status: root.querySelector('[data-step-status="profile"]'),
      action: root.querySelector('[data-onboarding-action="profile"]'),
    },
    payment: {
      wrapper: lookup("payment"),
      status: root.querySelector('[data-step-status="payment"]'),
      action: root.querySelector('[data-onboarding-action="payment"]'),
    },
    case: {
      wrapper: lookup("case"),
      status: root.querySelector('[data-step-status="case"]'),
      action: root.querySelector('[data-onboarding-action="case"]'),
    },
  };

  const setStep = (key, completed, { statusText, actionText, onClick } = {}) => {
    const ref = stepRefs[key];
    if (!ref || !ref.wrapper) return;
    ref.wrapper.classList.toggle("is-complete", completed);
    if (ref.status) {
      ref.status.textContent = statusText || (completed ? "Complete" : "Next");
    }
    if (ref.action && actionText) {
      ref.action.textContent = actionText;
    }
    if (ref.action && onClick) {
      if (ref.action.__lpcStepClickHandler) {
        ref.action.removeEventListener("click", ref.action.__lpcStepClickHandler);
      }
      ref.action.__lpcStepClickHandler = onClick;
      ref.action.addEventListener("click", onClick);
    }
  };

  const goToProfile = () => {
    window.location.href = "profile-settings.html";
  };
  const goToBilling = () => {
    if (typeof showDashboardView === "function") {
      showDashboardView("funds");
    } else {
      window.location.hash = "funds";
    }
    setTimeout(() => {
      const target = document.getElementById("addPaymentMethodBtn") || document.getElementById("replacePaymentMethodBtn");
      if (target && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.focus?.();
      }
    }, 250);
  };
  const goToCases = () => {
    window.location.href = "create-case.html";
  };
  const goToCaseList = () => {
    if (typeof showDashboardView === "function") {
      showDashboardView("cases");
    } else {
      window.location.hash = "cases";
    }
  };

  const update = () => {
    const progress = getAttorneyOnboardingProgress();
    const { profileDone, paymentDone, caseDone } = progress;

    setStep("profile", profileDone, {
      statusText: profileDone ? "Complete" : "Next",
      actionText: profileDone ? "View" : "Complete",
      onClick: goToProfile,
    });
    setStep("payment", paymentDone, {
      statusText: paymentDone ? "Complete" : "Next",
      actionText: paymentDone ? "Manage" : "Add card",
      onClick: goToBilling,
    });
    setStep("case", caseDone, {
      statusText: caseDone ? "Complete" : "Next",
      actionText: caseDone ? "View" : "New Matter",
      onClick: caseDone ? goToCaseList : goToCases,
    });
    updateOnboardingAttentionCard(progress);
  };

  onboardingChecklistApi = { update };
  update();
  return onboardingChecklistApi;
}

function updateOnboardingChecklist() {
  onboardingChecklistApi?.update?.();
  updateOnboardingAttentionCard();
  updateCaseOnboardingSkipButton();
}

function bindCaseOnboardingModal() {
  if (caseOnboardingModalBound) return;
  const modal = document.getElementById("attorneyCaseOnboardingModal");
  const overlay = document.getElementById("attorneyCaseOnboardingOverlay");
  if (!modal || !overlay) return;
  caseOnboardingModalBound = true;
  const closeBtn = modal.querySelector("[data-case-onboarding-close]");
  const continueBtn = modal.querySelector("[data-case-onboarding-continue]");
  const skipBtn = modal.querySelector("[data-case-onboarding-skip]");

  const handleClose = () => {
    hideCaseOnboardingModal();
    highlightNewCaseButton();
  };

  const handleSkip = () => {
    hideCaseOnboardingModal();
    clearAttorneyOnboardingStep();
    caseOnboardingPrompted = true;
    document.querySelectorAll(".onboarding-pulse").forEach((el) => el.classList.remove("onboarding-pulse"));
    updateOnboardingChecklist();
  };

  closeBtn?.addEventListener("click", handleClose);
  continueBtn?.addEventListener("click", handleClose);
  skipBtn?.addEventListener("click", handleSkip);
  overlay.addEventListener("click", handleClose);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("is-active")) {
      handleClose();
    }
  });
}

function showCaseOnboardingModal() {
  const modal = document.getElementById("attorneyCaseOnboardingModal");
  const overlay = document.getElementById("attorneyCaseOnboardingOverlay");
  if (!modal || !overlay) return;
  caseOnboardingScrollY = window.scrollY || 0;
  caseOnboardingBodyOverflow = document.body.style.overflow || "";
  document.body.style.overflow = "hidden";
  overlay.classList.add("is-active");
  overlay.setAttribute("aria-hidden", "false");
  modal.classList.add("is-active");
  modal.setAttribute("aria-hidden", "false");
  modal.removeAttribute("inert");
  activateDialogFocus(modal, {
    initialFocus: modal.querySelector("[data-case-onboarding-continue]"),
    onEscape: hideCaseOnboardingModal,
  });
  setCaseOnboardingModalSeen();
}

function hideCaseOnboardingModal() {
  const modal = document.getElementById("attorneyCaseOnboardingModal");
  const overlay = document.getElementById("attorneyCaseOnboardingOverlay");
  if (!modal || !overlay) return;
  overlay.classList.remove("is-active");
  overlay.setAttribute("aria-hidden", "true");
  modal.classList.remove("is-active");
  modal.setAttribute("aria-hidden", "true");
  modal.setAttribute("inert", "");
  deactivateDialogFocus(modal);
  document.body.style.overflow = caseOnboardingBodyOverflow;
  window.scrollTo({ top: caseOnboardingScrollY, left: 0, behavior: "instant" });
}

function highlightNewCaseButton() {
  const btn = document.querySelector('[data-case-quick="create"]') || document.querySelector('[data-quick-link="create-case"]');
  if (!btn) return;
  btn.classList.add("onboarding-pulse");
  btn.addEventListener(
    "click",
    () => {
      btn.classList.remove("onboarding-pulse");
      clearAttorneyOnboardingStep();
    },
    { once: true }
  );
}

function maybePromptCaseOnboarding() {
  if (caseOnboardingPrompted) return;
  if (getAttorneyOnboardingStep() !== "case") return;
  caseOnboardingPrompted = true;
  bindCaseOnboardingModal();
  if (!getCaseOnboardingModalSeen()) {
    showCaseOnboardingModal();
    return;
  }
  highlightNewCaseButton();
}

// -------------------------
// Overview Page
// -------------------------
async function initOverviewPage() {
  let lifecycleRefreshTimer = null;
  const messageBox = document.getElementById("messageBox");
  const messageSnippet = document.getElementById("messageSnippet");
  const messagePreviewSender = document.getElementById("messagePreviewSender");
  const messagePreviewText = document.getElementById("messagePreviewText");
  const messagePreviewLink = document.getElementById("messagePreviewLink");
  const escrowDetails = document.getElementById("escrowDetails");
  const homeView = document.querySelector(".view-home");
  const quickButtons = document.querySelectorAll("[data-quick-link]");
  const weeklyNotesGrid = document.getElementById("weeklyNotesGrid");
  const weeklyNotesRange = document.getElementById("weeklyNotesRange");
  const onboardingAttentionCard = document.getElementById("attorneyOnboardingAttentionCard");
  const onboardingAttentionAction = onboardingAttentionCard?.querySelector("[data-onboarding-attention-action]");
  const caseOnboardingSkipBtn = document.getElementById("caseOnboardingSkipBtn");
  const attentionList = document.getElementById("attorneyNeedsAttentionList");
  setupOnboardingChecklist();
  updateOnboardingAttentionCard();
  renderNeedsAttentionQueue();
  updateCaseOnboardingSkipButton();

  const handleOnboardingStepOpen = (stepValue) => {
    const step = String(stepValue || "").toLowerCase();
    if (!step) return;
    openOnboardingStepWithPopup(step);
  };
  const handleSkipOnboarding = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    skipAttorneyOnboardingFlow();
  };
  onboardingAttentionAction?.addEventListener("click", () => {
    handleOnboardingStepOpen(onboardingAttentionCard?.dataset.step);
  });
  caseOnboardingSkipBtn?.addEventListener("click", handleSkipOnboarding);
  attentionList?.addEventListener("click", (event) => {
    const action = event.target?.closest?.("[data-attention-action]");
    if (!action) return;
    const actionKey = String(action.dataset.attentionAction || "").toLowerCase();
    if (actionKey === "refresh") {
      event.preventDefault(); void hydrateOverview();
    } else if (actionKey === "messages") {
      event.preventDefault();
      goToMessages(state.latestThreadCaseId);
    }
  });

  const toastHelper = window.toastUtils;
  const stagedToast = toastHelper?.consume();
  if (stagedToast?.message) {
    toastHelper.show(stagedToast.message, { targetId: "toastBanner", type: stagedToast.type });
  }

  if (messageBox) {
    messageBox.addEventListener("click", () => {
      goToMessages(state.latestThreadCaseId);
    });
  }

  const homeApi = createApiClient({ onAuthenticationLost: () => { legacyHome?.clear(); clearCaseNoteAccess(); } });
  legacyHome = createLegacyAttorneyHome({
    api: homeApi, ownerId: String(state.user?.id || state.user?._id || ""),
    onReviewMatter: caseId => openCaseNoteModal(caseId, "review"),
    onChange(sources) {
      const value = key => sources[key].phase === "ready" ? sources[key].value : null;
      const inventory = value("inventory"), messages = value("messages");
      state.billing.hasPaymentMethod = value("payment")?.hasPaymentMethod ?? null;
      onboardingAttentionHydrated = sources.inventory.phase === "ready" && sources.payment.phase === "ready";
      overviewSignals.casesCreatedCount = inventory?.postedCount ?? null;
      overviewSignals.overdueCount = value("overdue");
      updateOnboardingChecklist();
      updateMessagePreviewUI({ threads: messages?.threads || [], messageSnippet, messagePreviewSender, messagePreviewText });
      renderNeedsAttentionQueue();
    },
  });
  document.querySelector('[data-home-refresh]')?.addEventListener('click', () => void hydrateOverview());
  // Start the requested view before independent Home and weekly-note reads.
  setupDashboardViewRouter();
  initHomeTabs();
  void hydrateOverview();
  setupWeeklyNoteModal();
  void initWeeklyNotes(weeklyNotesGrid, weeklyNotesRange);
  startOverviewPolling();

  quickButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.quickLink;
      if (action === "create-case") window.location.href = "create-case.html";
      else if (action === "browse-paralegals") window.location.href = "browse-paralegals.html";
    });
  });

  messagePreviewLink?.addEventListener("click", (evt) => {
    evt.preventDefault();
    goToMessages(state.latestThreadCaseId);
  });

  function shouldPollOverview() {
    return document.visibilityState === "visible" && (!homeView || !homeView.hasAttribute("hidden"));
  }

  async function refreshOverviewMessages({ force = false } = {}) {
    if (!force && !shouldPollOverview()) return;
    await legacyHome.refresh(["messages"]);
  }

  function startOverviewPolling() {
    if (state.overview.pollTimer) return;
    if (!overviewPollingBound) {
      document.addEventListener("visibilitychange", () => {
        if (shouldPollOverview()) void refreshOverviewMessages({ force: true });
      });
      overviewPollingBound = true;
    }
    state.overview.pollTimer = window.setInterval(() => {
      void refreshOverviewMessages();
    }, 120_000);
  }

  async function hydrateOverview() {
    await legacyHome.refresh();
    renderEscrowPanel(escrowDetails);
  }

  const scheduleLifecycleOverviewRefresh = () => {
    if (document.visibilityState !== "visible" || lifecycleRefreshTimer) return;
    lifecycleRefreshTimer = window.setTimeout(() => {
      lifecycleRefreshTimer = null;
      void hydrateOverview();
    }, 0);
  };
  window.addEventListener("lpc:lifecycle-refresh", scheduleLifecycleOverviewRefresh);

}

async function initWeeklyNotes(grid, rangeEl) {
  if (!grid) return;
  setupWeeklyNoteModal();
  const modalReady = Boolean(weeklyNoteModalRef && weeklyNoteTextarea);
  const prevBtn = document.getElementById("weeklyNotesPrev");
  const nextBtn = document.getElementById("weeklyNotesNext");
  const toggleBtn = document.getElementById("weeklyNotesToggle");
  const monthHeader = document.getElementById("weeklyNotesMonthHeader");
  const cache = new Map();
  let renderGeneration = 0;
  const state = {
    mode: "week",
    weekStart: getWeekStart(new Date()),
    monthDate: getMonthStart(new Date()),
  };

  const updateRangeLabel = (label) => {
    if (rangeEl) rangeEl.textContent = label;
  };

  const saveDay = async (weekKey, notes, index, value) => {
    const next = [...notes]; next[index] = value;
    const saved = await persistWeeklyNotes(weekKey, next);
    notes.splice(0, 7, ...saved);
    render();
    return saved[index];
  };
  const reviewDay = async (weekKey, notes, index) => {
    const saved = await fetchWeeklyNoteSnapshot(weekKey);
    return { note: saved.notes[index], accept: () => {
      weeklyNoteSnapshots.set(weekKey, saved);
      notes.splice(0, 7, ...saved.notes);
    } };
  };

  const loadWeekNotes = async (weekStart) => {
    const weekKey = formatDateKey(weekStart);
    if (cache.has(weekKey)) return cache.get(weekKey);
    const notes = await fetchWeeklyNotes(weekKey);
    cache.set(weekKey, notes);
    return notes;
  };

  const updateControls = () => {
    if (toggleBtn) {
      const monthViewOpen = state.mode === "month";
      toggleBtn.classList.toggle("is-active", monthViewOpen);
      toggleBtn.setAttribute("aria-expanded", String(monthViewOpen));
      toggleBtn.setAttribute("aria-label", monthViewOpen ? "Return to weekly view" : "Show month view");
    }
    const prevLabel = state.mode === "week" ? "Previous week" : "Previous month";
    const nextLabel = state.mode === "week" ? "Next week" : "Next month";
    prevBtn?.setAttribute("aria-label", prevLabel);
    nextBtn?.setAttribute("aria-label", nextLabel);
    if (monthHeader && state.mode !== "month") {
      monthHeader.classList.remove("is-visible");
      monthHeader.setAttribute("aria-hidden", "true");
    }
  };

  const renderDayCard = ({ date, note, isOutsideMonth, onSave, onReview, showWeekday = true, dateFormat = {} }) => {
    const day = document.createElement("div");
    day.className = "weekly-note-day";
    if (isSameDay(date, new Date())) day.classList.add("is-today");
    if (isOutsideMonth) day.classList.add("is-outside");

    const header = document.createElement("div");
    header.className = "weekly-note-header";

    if (showWeekday) {
      const name = document.createElement("div");
      name.className = "weekly-note-name";
      name.textContent = date.toLocaleDateString(undefined, { weekday: "short" });
      header.appendChild(name);
    }

    const dateLabel = document.createElement("div");
    dateLabel.className = "weekly-note-date";
    dateLabel.textContent = date.toLocaleDateString(undefined, dateFormat);
    header.append(dateLabel);

    let currentNote = note || "";

    if (!modalReady) {
      const text = document.createElement("p");
      text.textContent = "The note editor is unavailable. Reload this page to try again.";
      day.append(header, text);
      return day;
    }

    day.tabIndex = 0;
    day.setAttribute("role", "button");
    day.setAttribute(
      "aria-label",
      `Weekly note for ${date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}`
    );

    const body = document.createElement("div");
    body.className = "weekly-note-body";
    const updateBody = (value) => {
      body.textContent = value || "";
    };
    updateBody(currentNote);

    const openModal = () => {
      openWeeklyNoteModal({
        date,
        note: currentNote,
        onReview,
        onSave: async (value) => {
          currentNote = await onSave(value);
          updateBody(currentNote);
        },
      });
    };

    day.addEventListener("click", openModal);
    day.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openModal();
      }
    });

    day.append(header, body);
    return day;
  };

  const renderWeek = async (ticket) => {
    const start = getWeekStart(state.weekStart);
    state.weekStart = start;
    const weekKey = formatDateKey(start);
    const notes = await loadWeekNotes(start);
    if (ticket !== renderGeneration) return;

    const visibleDayCount = window.matchMedia("(max-width: 900px)").matches ? 5 : 7;
    const end = addDays(start, visibleDayCount - 1);
    const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    updateRangeLabel(`${startLabel}–${endLabel}`);

    grid.classList.remove("month-view");
    grid.innerHTML = "";
    if (monthHeader) {
      monthHeader.classList.remove("is-visible");
      monthHeader.setAttribute("aria-hidden", "true");
    }

    for (let i = 0; i < visibleDayCount; i += 1) {
      const date = addDays(start, i);
      const day = renderDayCard({
        date,
        note: notes[i] || "",
        isOutsideMonth: false,
        showWeekday: true,
        dateFormat: { month: "short", day: "numeric" },
        onSave: (value) => saveDay(weekKey, notes, i, value),
        onReview: () => reviewDay(weekKey, notes, i),
      });
      grid.appendChild(day);
    }
  };

  const renderMonth = async (ticket) => {
    const compactMonth = window.matchMedia("(max-width: 900px)").matches;
    const monthStart = getMonthStart(state.monthDate);
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    const calendarStart = getWeekStart(monthStart);
    const lastWeekStart = getWeekStart(monthEnd);
    const calendarEnd = addDays(lastWeekStart, 6);

    updateRangeLabel(monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" }));

    grid.classList.add("month-view");
    grid.innerHTML = "";
    if (monthHeader) {
      monthHeader.innerHTML = "";
      if (!compactMonth) {
        const headerStart = getWeekStart(new Date());
        for (let i = 0; i < 7; i += 1) {
          const labelDate = addDays(headerStart, i);
          const label = document.createElement("div");
          label.className = "weekday";
          label.textContent = labelDate.toLocaleDateString(undefined, { weekday: "short" });
          monthHeader.appendChild(label);
        }
        monthHeader.classList.add("is-visible");
        monthHeader.setAttribute("aria-hidden", "false");
      } else {
        monthHeader.classList.remove("is-visible");
        monthHeader.setAttribute("aria-hidden", "true");
      }
    }

    const weeks = [];
    for (let cursor = new Date(calendarStart); cursor <= calendarEnd; cursor = addDays(cursor, 7)) {
      weeks.push(new Date(cursor));
    }
    await Promise.all(weeks.map((weekStart) => loadWeekNotes(weekStart)));
    if (ticket !== renderGeneration) return;

    for (let cursor = new Date(calendarStart); cursor <= calendarEnd; cursor = addDays(cursor, 1)) {
      const weekStart = getWeekStart(cursor);
      const weekKey = formatDateKey(weekStart);
      const notes = cache.get(weekKey) || Array(7).fill("");
      const idx = diffDays(cursor, weekStart);
      const day = renderDayCard({
        date: cursor,
        note: notes[idx] || "",
        isOutsideMonth: cursor.getMonth() !== monthStart.getMonth(),
        showWeekday: compactMonth,
        dateFormat: compactMonth ? { month: "short", day: "numeric" } : { day: "numeric" },
        onSave: (value) => saveDay(weekKey, notes, idx, value),
        onReview: () => reviewDay(weekKey, notes, idx),
      });
      grid.appendChild(day);
    }
  };

  const render = () => {
    const ticket = ++renderGeneration;
    void (state.mode === "month" ? renderMonth(ticket) : renderWeek(ticket)).catch(() => {
      if (ticket !== renderGeneration) return;
      const message = document.createElement("p"); message.setAttribute("role", "alert");
      message.textContent = "Weekly notes couldn’t be loaded. Retry to load the saved notes.";
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "btn secondary"; retry.textContent = "Retry weekly notes";
      retry.addEventListener("click", render);
      grid.replaceChildren(message, retry);
    });
  };
  window.addEventListener("pagehide", () => { renderGeneration += 1; cache.clear(); grid.replaceChildren(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted) render(); });
  window.addEventListener("lpc:weekly-notes-access-lost", () => { renderGeneration += 1; cache.clear(); });

  let lastCompact = window.matchMedia("(max-width: 900px)").matches;
  window.addEventListener("resize", () => {
    const isCompact = window.matchMedia("(max-width: 900px)").matches;
    if (isCompact !== lastCompact) {
      lastCompact = isCompact;
      render();
    }
  });

  prevBtn?.addEventListener("click", () => {
    if (state.mode === "week") {
      state.weekStart = addDays(state.weekStart, -7);
    } else {
      state.monthDate = addMonths(state.monthDate, -1);
    }
    render();
  });

  nextBtn?.addEventListener("click", () => {
    if (state.mode === "week") {
      state.weekStart = addDays(state.weekStart, 7);
    } else {
      state.monthDate = addMonths(state.monthDate, 1);
    }
    render();
  });

  toggleBtn?.addEventListener("click", () => {
    if (state.mode === "week") {
      state.mode = "month";
      state.monthDate = getMonthStart(state.weekStart);
    } else {
      state.mode = "week";
      state.weekStart = getWeekStart(getMonthStart(state.monthDate));
    }
    updateControls();
    render();
  });

  updateControls();
  render();
}

let weeklyNoteModalRef = null;
let weeklyNoteModalTitle = null;
let weeklyNoteModalDate = null;
let weeklyNoteTextarea = null;
let weeklyNoteSaveBtn = null;
let weeklyNoteCancelBtn = null;
let weeklyNoteModalBound = false;
let weeklyNoteModalOnSave = null;
let weeklyNoteModalOnReview = null;
let weeklyNoteModalBusy = false;
let weeklyNoteModalOriginal = "";
let weeklyNoteModalFeedback = null;
const weeklyNoteSnapshots = new Map();
let weeklyNoteEpoch = 0;
let weeklyNoteOwnerId = "";
let weeklyNoteOwnerCheck = null;

let statusHistoryModalRef = null;
let statusHistoryBodyRef = null;

function ensureWeeklyNoteModal() {
  if (document.getElementById("weeklyNoteModal")) {
    return;
  }
  const modal = document.createElement("div");
  modal.id = "weeklyNoteModal";
  modal.className = "note-modal hidden";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "weeklyNoteModalTitle");
  modal.setAttribute("aria-hidden", "true");
  modal.setAttribute("inert", "");
  modal.innerHTML = `
    <div class="note-modal-card">
      <h3 id="weeklyNoteModalTitle" style="font-family:var(--font-serif);font-weight:300;">Weekly Note</h3>
      <div class="weekly-note-modal-date" id="weeklyNoteModalDate"></div>
      <textarea id="weeklyNoteModalTextarea" aria-labelledby="weeklyNoteModalTitle weeklyNoteModalDate"></textarea>
      <div class="note-modal-actions">
        <button type="button" class="btn secondary" data-weekly-note-cancel>Cancel</button>
        <button type="button" class="btn primary" data-weekly-note-save>Save Note</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function setupWeeklyNoteModal() {
  if (weeklyNoteModalBound) return;
  ensureWeeklyNoteModal();
  weeklyNoteModalRef = document.getElementById("weeklyNoteModal");
  if (!weeklyNoteModalRef) return;
  if (weeklyNoteModalRef.parentElement !== document.body) {
    document.body.appendChild(weeklyNoteModalRef);
  }
  weeklyNoteModalBound = true;
  weeklyNoteModalTitle = document.getElementById("weeklyNoteModalTitle");
  weeklyNoteModalDate = document.getElementById("weeklyNoteModalDate");
  weeklyNoteTextarea = document.getElementById("weeklyNoteModalTextarea") || weeklyNoteModalRef.querySelector("textarea");
  weeklyNoteSaveBtn = weeklyNoteModalRef.querySelector("[data-weekly-note-save]");
  weeklyNoteCancelBtn = weeklyNoteModalRef.querySelector("[data-weekly-note-cancel]");

  weeklyNoteTextarea?.setAttribute("maxlength", "2000");
  weeklyNoteTextarea?.setAttribute("aria-labelledby", "weeklyNoteModalTitle weeklyNoteModalDate");
  weeklyNoteModalFeedback = document.createElement("div");
  weeklyNoteModalFeedback.setAttribute("role", "status");
  weeklyNoteTextarea?.after(weeklyNoteModalFeedback);
  const checkStoredOwner = (value) => {
    let owner;
    try { const user = typeof value === "string" ? JSON.parse(value) : value; owner = String(user?.id || user?._id || ""); } catch { owner = ""; }
    if (!owner || owner !== weeklyNoteOwnerId) clearWeeklyNoteAccess();
  };
  window.addEventListener("storage", (event) => { if (event.key === "lpc_user") checkStoredOwner(event.newValue); });
  window.addEventListener("lpc:user-updated", (event) => checkStoredOwner(event.detail));
  window.addEventListener("focus", () => { if (document.visibilityState === "visible") void verifyWeeklyNoteOwner().catch(() => { /* Verification already cleared private notes. */ }); });
  window.addEventListener("beforeunload", (event) => {
    if (weeklyNoteModalRef?.classList.contains("hidden")) return;
    if (weeklyNoteModalBusy || weeklyNoteTextarea?.value !== weeklyNoteModalOriginal) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", () => {
    weeklyNoteModalBusy = false; weeklyNoteSnapshots.clear(); weeklyNoteEpoch += 1; weeklyNoteOwnerCheck = null;
    if (weeklyNoteTextarea) weeklyNoteTextarea.value = "";
    weeklyNoteModalOriginal = ""; weeklyNoteModalFeedback?.replaceChildren(); closeWeeklyNoteModal();
  });
  weeklyNoteCancelBtn?.addEventListener("click", closeWeeklyNoteModal);
  weeklyNoteModalRef.addEventListener("click", (event) => {
    if (event.target === weeklyNoteModalRef) {
      closeWeeklyNoteModal();
    }
  });
  weeklyNoteSaveBtn?.addEventListener("click", async () => {
    if (!weeklyNoteModalOnSave || weeklyNoteModalBusy) return;
    const value = weeklyNoteTextarea?.value || "";
    weeklyNoteModalBusy = true; weeklyNoteSaveBtn.disabled = true; weeklyNoteCancelBtn.disabled = true; weeklyNoteTextarea.disabled = true;
    weeklyNoteModalFeedback.textContent = "Saving note…";
    try {
      await weeklyNoteModalOnSave(value);
      weeklyNoteModalBusy = false; closeWeeklyNoteModal();
    } catch (error) {
      if (weeklyNoteModalRef.classList.contains("hidden")) return;
      weeklyNoteModalFeedback.textContent = error.status === 409 ? "These notes changed elsewhere. Your edit is still here. Review the saved note before trying again." : "Saving wasn’t confirmed. Your edit is still here. Review the saved note before trying again.";
      const review = document.createElement("button"); review.type = "button"; review.className = "btn secondary"; review.style.minHeight = "44px"; review.textContent = "Review saved note";
      review.addEventListener("click", async () => {
        if (!weeklyNoteModalOnReview || weeklyNoteModalBusy) return;
        review.disabled = true; weeklyNoteModalBusy = true;
        try {
          const saved = await weeklyNoteModalOnReview();
          if (weeklyNoteModalRef.classList.contains("hidden")) return;
          const label = document.createElement("p"); label.textContent = "Saved note for this day (other days will keep their latest saved notes):";
          const text = document.createElement("p"); Object.assign(text.style, { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "180px", overflowY: "auto" }); text.tabIndex = 0; text.setAttribute("aria-label", "Saved note"); text.textContent = saved.note || "No saved note.";
          const choose = (title, replace) => {
            const control = document.createElement("button"); control.type = "button"; control.className = "btn secondary"; control.style.minHeight = "44px"; control.textContent = title;
            control.addEventListener("click", () => {
              saved.accept(); if (replace) weeklyNoteTextarea.value = saved.note;
              weeklyNoteModalFeedback.textContent = "Review your note above, then select Save Note.";
              weeklyNoteSaveBtn.disabled = false; weeklyNoteTextarea.focus();
            }); return control;
          };
          const choices = document.createElement("div"); choices.className = "note-modal-actions"; choices.append(choose("Use saved note", true), choose("Keep my edit", false));
          weeklyNoteModalFeedback.replaceChildren(label, text, choices); text.focus();
        } catch { if (!weeklyNoteModalRef.classList.contains("hidden")) { review.disabled = false; review.textContent = "Retry reviewing saved note"; } }
        finally { weeklyNoteModalBusy = false; }
      });
      weeklyNoteModalFeedback.append(review);
    } finally {
      weeklyNoteModalBusy = false; weeklyNoteCancelBtn.disabled = false; weeklyNoteTextarea.disabled = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && weeklyNoteModalRef && !weeklyNoteModalRef.classList.contains("hidden")) {
      closeWeeklyNoteModal();
    }
  });
}

function openWeeklyNoteModal({ date, note, onSave, onReview }) {
  setupWeeklyNoteModal();
  if (!weeklyNoteModalRef) return;
  weeklyNoteModalOnSave = onSave; weeklyNoteModalOnReview = onReview;
  weeklyNoteModalOriginal = note || ""; weeklyNoteModalFeedback.replaceChildren(); weeklyNoteSaveBtn.disabled = false;
  if (weeklyNoteModalTitle) {
    weeklyNoteModalTitle.textContent = "Weekly Note";
  }
  if (weeklyNoteModalDate && date) {
    weeklyNoteModalDate.textContent = date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  }
  if (weeklyNoteTextarea) {
    weeklyNoteTextarea.value = note || "";
  }
  weeklyNoteModalRef.classList.remove("hidden");
  weeklyNoteModalRef.setAttribute("aria-hidden", "false");
  weeklyNoteModalRef.removeAttribute("inert");
  activateDialogFocus(weeklyNoteModalRef, {
    initialFocus: weeklyNoteTextarea,
    onEscape: closeWeeklyNoteModal,
  });
}

function closeWeeklyNoteModal() {
  if (!weeklyNoteModalRef || weeklyNoteModalBusy) return;
  weeklyNoteModalRef.classList.add("hidden");
  weeklyNoteModalRef.setAttribute("aria-hidden", "true");
  weeklyNoteModalRef.setAttribute("inert", "");
  deactivateDialogFocus(weeklyNoteModalRef);
  weeklyNoteModalRef.removeAttribute("aria-busy");
  weeklyNoteModalOnSave = null; weeklyNoteModalOnReview = null;
}

function initStatusHistoryModal() {
  if (statusHistoryModalRef) return;
  statusHistoryModalRef = document.getElementById("statusHistoryModal");
  if (!statusHistoryModalRef) return;
  statusHistoryBodyRef = document.getElementById("statusHistoryBody");
  statusHistoryModalRef.querySelectorAll("[data-status-history-close]").forEach((btn) => {
    btn.addEventListener("click", () => closeStatusHistoryModal());
  });
  statusHistoryModalRef.addEventListener("click", (event) => {
    if (event.target === statusHistoryModalRef) closeStatusHistoryModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && statusHistoryModalRef && !statusHistoryModalRef.classList.contains("hidden")) {
      closeStatusHistoryModal();
    }
  });
}

function closeStatusHistoryModal() {
  if (!statusHistoryModalRef) return;
  statusHistoryModalRef.classList.add("hidden");
  statusHistoryModalRef.setAttribute("aria-hidden", "true");
  statusHistoryModalRef.setAttribute("inert", "");
  deactivateDialogFocus(statusHistoryModalRef);
  statusHistoryModalRef.removeAttribute("aria-busy");
}

function formatHistoryTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function getStatusHistoryClass(statusKey) {
  const normalized = normalizeCaseStatus(statusKey);
  if (!normalized) return "public";
  if (normalized === "withdrawn") return "withdrawn";
  if (normalized === "relisted") return "relisted";
  if (normalized === "hold") return "pending";
  if (normalized === "payout_finalized") return "accepted";
  if (normalized === "paused") return "pending";
  return CASE_STATUS_CLASSES[normalized] || "public";
}

async function openStatusHistoryModal(caseId) {
  if (!caseId) return;
  initStatusHistoryModal();
  if (!statusHistoryModalRef || !statusHistoryBodyRef) return;
  statusHistoryBodyRef.innerHTML = `<div class="info-line">Loading status history…</div>`;
  statusHistoryModalRef.classList.remove("hidden");
  statusHistoryModalRef.setAttribute("aria-hidden", "false");
  statusHistoryModalRef.removeAttribute("inert");
  activateDialogFocus(statusHistoryModalRef, {
    initialFocus: statusHistoryModalRef.querySelector("[data-status-history-close]"),
    onEscape: closeStatusHistoryModal,
  });
  statusHistoryModalRef.setAttribute("aria-busy", "true");
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/status-history`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || "Unable to load status history.");
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) {
      statusHistoryBodyRef.innerHTML = `<div class="info-line">No status history recorded yet.</div>`;
    } else {
      statusHistoryBodyRef.innerHTML = `
        <ul class="status-history-list">
          ${items
            .map(
              (entry) => {
                const statusClass = getStatusHistoryClass(entry?.statusKey || entry?.label);
                return `
                <li class="status-history-item">
                  <span class="status status-history-status ${statusClass}">${sanitize(entry.label || "Status")}</span>
                  <span class="status-history-time">${sanitize(formatHistoryTimestamp(entry.at))}</span>
                </li>`;
              }
            )
            .join("")}
        </ul>
      `;
    }
    if (payload.complete === false) statusHistoryBodyRef.insertAdjacentHTML("afterbegin", `<p class="info-line">Some history could not be loaded. The events below are incomplete. Close and reopen to try again.</p>`);
  } catch (err) {
    statusHistoryBodyRef.innerHTML = `<div class="info-line">${sanitize(
      err?.message || "Unable to load status history."
    )}</div>`;
  } finally {
    statusHistoryModalRef.removeAttribute("aria-busy");
  }
}

function getWeekStart(date) {
  const start = new Date(date);
  const day = start.getDay();
  const diff = (day + 6) % 7;
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

function getMonthStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function diffDays(a, b) {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcA - utcB) / 86400000);
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

async function fetchWeeklyNoteSnapshot(weekStart) {
  await verifyWeeklyNoteOwner();
  const epoch = weeklyNoteEpoch;
  const res = await secureFetch(`/api/users/me/weekly-notes?weekStart=${encodeURIComponent(weekStart)}`, {
    headers: { Accept: "application/json" }, noRedirect: true, cache: "no-store",
  });
  if (!res.ok) {
    if ([401, 403].includes(res.status)) clearWeeklyNoteAccess();
    throw Object.assign(new Error("Unable to load weekly notes."), { status: res.status });
  }
  const payload = await res.json();
  if (epoch !== weeklyNoteEpoch) throw new Error("Weekly notes session changed.");
  return validateWeeklyNoteSnapshot(payload, weekStart);
}
function validateWeeklyNoteSnapshot(payload, weekStart) {
  if (payload?.weekStart !== weekStart || typeof payload.revision !== "string" || !payload.revision || !Array.isArray(payload.notes) || payload.notes.length !== 7 || payload.notes.some((note) => typeof note !== "string" || note.length > 2000)) throw new Error("Unable to verify weekly notes.");
  return { notes: [...payload.notes], revision: payload.revision };
}
async function fetchWeeklyNotes(weekStart) {
  const snapshot = await fetchWeeklyNoteSnapshot(weekStart);
  weeklyNoteSnapshots.set(weekStart, snapshot);
  return [...snapshot.notes];
}
async function persistWeeklyNotes(weekStart, notes = []) {
  await verifyWeeklyNoteOwner();
  const epoch = weeklyNoteEpoch;
  const snapshot = weeklyNoteSnapshots.get(weekStart);
  if (!snapshot) throw new Error("Load the saved notes before saving.");
  const res = await secureFetch("/api/users/me/weekly-notes", {
    method: "PUT", headers: { Accept: "application/json" }, noRedirect: true,
    body: { weekStart, notes, revision: snapshot.revision },
  });
  if (!res.ok) {
    if ([401, 403].includes(res.status)) clearWeeklyNoteAccess();
    throw Object.assign(new Error("Unable to save weekly notes."), { status: res.status });
  }
  const payload = await res.json();
  if (epoch !== weeklyNoteEpoch) throw new Error("Weekly notes session changed.");
  const saved = validateWeeklyNoteSnapshot(payload, weekStart);
  weeklyNoteSnapshots.set(weekStart, saved);
  return [...saved.notes];
}

async function verifyWeeklyNoteOwner() {
  if (weeklyNoteOwnerCheck) return weeklyNoteOwnerCheck;
  const epoch = weeklyNoteEpoch;
  weeklyNoteOwnerCheck = (async () => {
    try {
      const res = await secureFetch("/api/auth/me", { noRedirect: true, cache: "no-store" });
      if (!res.ok) throw new Error("Unable to verify the notes account.");
      const payload = await res.json(); const user = payload?.user || payload;
      if (epoch !== weeklyNoteEpoch || !weeklyNoteOwnerId || String(user?.id || user?._id || "") !== weeklyNoteOwnerId || user?.status !== "approved" || user?.disabled || user?.deleted) throw new Error("The notes account changed.");
    } catch (error) { if (epoch === weeklyNoteEpoch) clearWeeklyNoteAccess(); throw error; }
    finally { if (epoch === weeklyNoteEpoch) weeklyNoteOwnerCheck = null; }
  })();
  return weeklyNoteOwnerCheck;
}

function clearWeeklyNoteAccess() {
  weeklyNoteEpoch += 1; weeklyNoteSnapshots.clear(); weeklyNoteModalBusy = false; weeklyNoteOwnerCheck = null;
  if (weeklyNoteTextarea) weeklyNoteTextarea.value = "";
  weeklyNoteModalOriginal = ""; weeklyNoteModalFeedback?.replaceChildren(); closeWeeklyNoteModal();
  const message = document.createElement("p"); message.setAttribute("role", "alert");
  message.textContent = "Private notes are no longer available to this account.";
  document.getElementById("weeklyNotesGrid")?.replaceChildren(message);
  window.dispatchEvent(new Event("lpc:weekly-notes-access-lost"));
}

function setupDashboardViewRouter() {
  if (dashboardViewState.routerAttached) return;
  const panels = Array.from(document.querySelectorAll(".view-panel[data-view]"));
  if (!panels.length) return;
  dashboardViewState.routerAttached = true;
  dashboardViewState.viewMap = new Map(panels.map((panel) => [panel.dataset.view, panel]));
  dashboardViewState.navLinks = Array.from(document.querySelectorAll("[data-view-target]"));

  dashboardViewState.navLinks.forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (!href.startsWith("#")) return;
    link.addEventListener("click", (event) => {
      const targetView = link.dataset.viewTarget;
      if (!targetView) return;
      event.preventDefault();
      const currentHash = String(window.location.hash || "").replace("#", "");
      if (currentHash === targetView) {
        showDashboardView(targetView, { skipHash: true });
      } else {
        window.location.hash = targetView;
      }
    });
  });

  const parseDashboardHash = () => {
    const raw = String(window.location.hash || "").replace("#", "").trim();
    if (!raw) return { view: "home", caseFilter: null };
    const [viewPart, filterPart] = raw.split(":");
    const view = (viewPart || "").toLowerCase();
    const caseFilter = view === "cases" && CASE_VIEW_FILTERS.includes((filterPart || "").toLowerCase())
      ? (filterPart || "").toLowerCase()
      : null;
    return { view, caseFilter };
  };

  const syncFromHash = () => {
    const { view, caseFilter } = parseDashboardHash();
    const target = dashboardViewState.viewMap.has(view) ? view : "home";
    showDashboardView(target, { skipHash: true, caseFilter });
  };

  window.addEventListener("hashchange", syncFromHash);
  syncFromHash();
}

function showDashboardView(target, { skipHash = false, caseFilter = null } = {}) {
  if (!dashboardViewState.viewMap.has(target)) target = "home";
  const normalizedFilter = (caseFilter || "").toLowerCase();
  const wantsFilter = normalizedFilter && CASE_VIEW_FILTERS.includes(normalizedFilter);
  const targetCaseFilter = target === "cases" ? (wantsFilter ? normalizedFilter : "active") : "";
  if (dashboardViewState.currentView === target) {
    if (target === "cases" && state.casesViewFilter !== targetCaseFilter) {
      void ensureCasesViewReady().then(() => {
        if (state.casesViewFilter !== targetCaseFilter) {
          setCaseFilter(targetCaseFilter, { syncHash: false });
        }
      });
    }
    if (target === "funds") {
      void ensureBillingViewReady();
    }
    if (target === "tasks") {
      void ensureTasksViewReady();
    }
    return;
  }

  dashboardViewState.viewMap.forEach((panel, key) => {
    if (!panel) return;
    panel.hidden = key !== target;
  });
  dashboardViewState.navLinks.forEach((link) => {
    const view = link.dataset.viewTarget;
    if (!view) return;
    link.classList.toggle("active", view === target);
  });
  dashboardViewState.currentView = target;
  document.documentElement.classList.remove("prefers-cases", "prefers-billing");

  if (!skipHash && target) {
    const normalized = `#${target}`;
    if (window.location.hash !== normalized) {
      window.location.hash = target;
      return;
    }
  }

  if (target === "cases") {
    if (!dashboardViewState.casesInitialized) {
      setCaseFilter(targetCaseFilter, { render: false, syncHash: false });
    }
    void ensureCasesViewReady().then(() => {
      if (state.casesViewFilter !== targetCaseFilter) {
        setCaseFilter(targetCaseFilter, { syncHash: false });
      }
      maybeOpenCasePreviewFromQuery();
      maybeOpenApplicantFromQuery();
      maybeOpenApplicantsCaseFromQuery();
      maybePromptCaseOnboarding();
    });
  } else if (target === "funds") {
    void ensureBillingViewReady();
  } else if (target === "tasks") {
    void ensureTasksViewReady();
  }
}

function ensureTasksViewReady() {
  if (dashboardViewState.tasksInitialized) return Promise.resolve();
  if (dashboardViewState.tasksInitPromise) return dashboardViewState.tasksInitPromise;
  dashboardViewState.tasksInitPromise = initTasksPage()
    .then(() => {
      dashboardViewState.tasksInitialized = true;
    })
    .catch((err) => {
      console.warn("Tasks view init failed", err);
      state.tasksError = "Tasks could not be loaded. Try again.";
      renderTasks();
    })
    .finally(() => {
      dashboardViewState.tasksInitPromise = null;
    });
  return dashboardViewState.tasksInitPromise;
}

function ensureCasesViewReady() {
  if (dashboardViewState.casesInitialized) return Promise.resolve();
  if (dashboardViewState.casesInitPromise) return dashboardViewState.casesInitPromise;
  dashboardViewState.casesInitPromise = (async () => {
    await initCasesPage();
    dashboardViewState.casesInitialized = true;
  })()
    .catch((err) => {
      console.warn("Cases view init failed", err);
    })
    .finally(() => {
      dashboardViewState.casesInitPromise = null;
    });
  return dashboardViewState.casesInitPromise;
}

function ensureBillingViewReady() {
  if (dashboardViewState.billingInitialized) return Promise.resolve();
  if (dashboardViewState.billingInitPromise) return dashboardViewState.billingInitPromise;
  dashboardViewState.billingInitPromise = (async () => {
    await initBillingPage();
    dashboardViewState.billingInitialized = true;
  })()
    .catch((err) => {
      console.warn("Payments view init failed", err);
    })
    .finally(() => {
      dashboardViewState.billingInitPromise = null;
    });
  return dashboardViewState.billingInitPromise;
}

function setCaseFilter(filterKey, { render = true, syncHash = true, markSavedView = true } = {}) {
  const key = (filterKey || "").toLowerCase();
  if (!CASE_VIEW_FILTERS.includes(key)) return;
  const tabs = document.querySelectorAll("[data-case-filter]");
  const tables = document.querySelectorAll("[data-case-table]");
  if (!tabs.length || !tables.length) return;
  state.casesViewFilter = key;
  if (markSavedView) matterSavedViews?.markCustom();
  tabs.forEach((btn) => {
    const active = btn.dataset.caseFilter === key;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.tabIndex = active ? 0 : -1;
  });
  tables.forEach((table) => {
    table.classList.toggle("hidden", table.dataset.caseTable !== key);
  });
  if (syncHash && dashboardViewState.currentView === "cases") {
    const nextHash = `#cases:${key}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
    }
  }
  if (render) {
    renderCasesView();
  }
}

function goToMessages(caseId) {
  if (!caseId) {
    window.location.hash = "cases";
    return;
  }
  const target = `case-detail.html?caseId=${encodeURIComponent(caseId)}&tab=messages`;
  window.location.href = target;
}
// -------------------------
// Payments view
// -------------------------
async function initBillingPage() {
  const activeBody = document.getElementById("activeEscrowsBody");
  const toastHelper = window.toastUtils;
  const stagedToast = toastHelper?.consume?.();
  if (stagedToast?.message) {
    toastHelper.show(stagedToast.message, { targetId: "toastBanner", type: stagedToast.type });
  }

  activeBody?.addEventListener("click", onActiveEscrowAction);
  document.querySelector(".escrow-table thead")?.addEventListener("click", onEscrowSortHeaderClick);
  document.querySelector("[data-escrow-pagination]")?.addEventListener("click", onEscrowPaginationClick);
  document.querySelector('[data-escrow-refresh]')?.addEventListener('click', () => loadActiveEscrows(true));
  const scroll = document.querySelector('[data-escrow-scroll]');
  scroll?.addEventListener('keydown', event => {
    if (event.target !== scroll || event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || scroll.scrollWidth <= scroll.clientWidth) return;
    event.preventDefault();
    const left = event.key === 'Home' ? 0 : event.key === 'End' ? scroll.scrollWidth : scroll.scrollLeft + (event.key === 'ArrowLeft' ? -120 : 120);
    scroll.scrollTo({ left, behavior: 'instant' });
  });
  scroll?.addEventListener('focusin', event => {
    if (event.target !== scroll && scroll.scrollWidth > scroll.clientWidth) event.target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  });

  await loadActiveEscrows();
}

async function loadActiveEscrows(force = false) {
  const body = document.getElementById("activeEscrowsBody");
  if (!body) return;
  const ownerId = String(state.user?.id || state.user?._id || ''), generation = (state.billing.generation || 0) + 1;
  state.billing.generation = generation; state.billing.controller?.abort();
  const controller = new AbortController(); state.billing.controller = controller;
  const refresh = document.querySelector('[data-escrow-refresh]');
  if (refresh) refresh.disabled = true;
  const abort = () => controller.abort(), timer = setTimeout(abort, 30000);
  window.addEventListener('pagehide', abort, { once: true });
  state.billing.escrows = []; state.billing.escrowsLoaded = false;
  body.innerHTML = `<tr><td colspan="6" class="empty-state">${force ? 'Refreshing activity…' : 'Loading activity…'}</td></tr>`;
  try {
    if (!/^[a-f0-9]{24}$/i.test(ownerId)) throw Error('Missing payment owner');
    const api = createApiClient({ onAuthenticationLost: () => { state.billing.escrows = []; state.billing.escrowsLoaded = false; body.replaceChildren(); } });
    const items = [], seen = new Set(); let cursor = null, revision, count;
    do {
      const payload = await api.readPaymentActivity({ ownerId, signal: controller.signal, limit: 500, ...(cursor !== null ? { cursor, revision } : {}) });
      if (controller.signal.aborted || generation !== state.billing.generation) return;
      if (payload?.ownerId !== ownerId || !/^[a-f0-9]{64}$/.test(payload.revision || '') || revision && payload.revision !== revision || !Number.isSafeInteger(payload.count) || payload.count < 0 || payload.count > 10000 || count !== undefined && payload.count !== count || !Array.isArray(payload.items) || payload.items.length > 500) throw Error('Unverified payment page');
      revision = payload.revision; count = payload.count;
      for (const item of payload.items) {
        if (!item || !/^[a-f0-9]{24}$/i.test(item.caseId) || seen.has(item.caseId) || typeof item.caseName !== 'string' || !['active', 'needs_review'].includes(item.status) || item.amountHeld !== null && (!Number.isSafeInteger(item.amountHeld) || item.amountHeld < 0) || item.currency !== null && !/^[A-Z]{3}$/.test(item.currency) || item.fundedAt !== null && (!item.fundedAt || !Number.isFinite(new Date(item.fundedAt).getTime()))) throw Error('Unverified payment record');
        const knownCurrency = item.currency && Intl.supportedValuesOf('currency').includes(item.currency) && new Intl.NumberFormat('en-US', { style: 'currency', currency: item.currency }).resolvedOptions().maximumFractionDigits === 2;
        if (item.currency !== null && !knownCurrency || item.status === 'active' && (!knownCurrency || !Number.isSafeInteger(item.amountHeld) || item.amountHeld <= 0 || !item.fundedAt) || item.status === 'needs_review' && item.amountHeld !== null) throw Error('Contradictory payment record');
        seen.add(item.caseId); items.push(item);
      }
      if (payload.nextCursor !== null && (payload.nextCursor !== String(items.length) || !payload.items.length || items.length >= count) || payload.nextCursor === null && items.length !== count) throw Error('Incomplete payment pages');
      cursor = payload.nextCursor;
    } while (cursor !== null);
    state.billing.escrows = items;
    state.billing.escrowsLoaded = true;
    state.billing.escrowPage = 0;
    renderActiveEscrows(body, items);
  } catch (err) {
    if (generation !== state.billing.generation) return;
    state.billing.escrows = []; state.billing.escrowsLoaded = false;
    renderActiveEscrows(body, [], { errorMessage: 'Payment activity could not be verified. Refresh to try again.' });
  } finally { clearTimeout(timer); window.removeEventListener('pagehide', abort); if (refresh && generation === state.billing.generation) refresh.disabled = false; }
}

function renderActiveEscrows(body, escrows = [], options = {}) {
  const errorMessage = options.errorMessage || "";
  if (errorMessage) {
    body.innerHTML = `<tr><td colspan="6" class="history-empty error">${sanitize(errorMessage)}</td></tr>`;
    updateEscrowSortHeaders();
    updateEscrowPagination(0);
    return;
  }
  if (!escrows.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty-state">No active funded Matters.</td></tr>`;
    updateEscrowSortHeaders();
    updateEscrowPagination(0);
    return;
  }
  const sortedEscrows = sortActiveEscrows(escrows);
  const totalCount = sortedEscrows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / ESCROW_PAGE_SIZE));
  const pageIndex = Math.max(0, state.billing?.escrowPage ?? 0);
  const safeIndex = Math.min(pageIndex, totalPages - 1);
  if (safeIndex !== pageIndex) state.billing.escrowPage = safeIndex;
  const start = safeIndex * ESCROW_PAGE_SIZE;
  const pageItems = sortedEscrows.slice(start, start + ESCROW_PAGE_SIZE);
  body.innerHTML = pageItems
    .map((record) => {
      const caseId = parseCaseId(record);
      const title = sanitize(record.caseTitle || record.caseName || record.title || "Matter");
      const caseHref = caseId ? `/attorney-v2.html#/matters/${caseId}/financials` : "";
      const paralegalName = sanitize(
        record.paralegalName ||
          (record.paralegal && [record.paralegal.firstName, record.paralegal.lastName].filter(Boolean).join(" ")) ||
          "Assigned Paralegal"
      );
      const paralegalId = parseParalegalId(record);
      const paralegalHref = paralegalId
        ? buildParalegalProfileUrl(paralegalId, { returnTo: buildBillingReturnUrl() })
        : "";
      const fundedDate = formatDisplayDate(record.fundedAt);
      const caseStatus = sanitize(formatActiveEscrowCaseStatus(record));
      const status = sanitize(formatActiveEscrowPaymentStatus(record));
      let amount = 'Not confirmed';
      if (Number.isSafeInteger(record.amountHeld) && record.amountHeld >= 0 && record.currency) {
        try { amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: record.currency }).format(record.amountHeld / 100); } catch { /* Preserve the unconfirmed amount. */ }
      }
      return `
        <tr data-case-id="${caseId || ""}">
          <td>${
            caseHref
              ? `<a class="escrow-link" href="${sanitize(caseHref)}">${title}</a>`
              : title
          }</td>
          <td>${
            paralegalHref
              ? `<a class="escrow-link" href="${sanitize(paralegalHref)}">${paralegalName}</a>`
              : paralegalName
          }</td>
          <td>${amount}</td>
          <td>${fundedDate}</td>
          <td><span class="pill">${caseStatus}</span></td>
          <td><span class="pill">${status}</span></td>
        </tr>
      `;
    })
    .join("");
  updateEscrowSortHeaders();
  updateEscrowPagination(totalCount);
}

function updateEscrowPagination(totalCount) {
  const pagination = document.querySelector("[data-escrow-pagination]");
  if (!pagination) return;
  const info = pagination.querySelector("[data-escrow-page-info]");
  const prev = pagination.querySelector('[data-escrow-page-action="prev"]');
  const next = pagination.querySelector('[data-escrow-page-action="next"]');
  const totalPages = Math.max(1, Math.ceil(totalCount / ESCROW_PAGE_SIZE));
  const pageIndex = Math.max(0, state.billing?.escrowPage ?? 0);
  const safeIndex = Math.min(pageIndex, totalPages - 1);
  if (totalCount === 0) {
    if (info) info.textContent = "0 of 0";
    pagination.style.display = "flex";
    pagination.style.visibility = "hidden";
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    return;
  }
  const start = safeIndex * ESCROW_PAGE_SIZE + 1;
  const end = Math.min(totalCount, (safeIndex + 1) * ESCROW_PAGE_SIZE);
  if (info) info.textContent = `${start}–${end} of ${totalCount}`;
  if (prev) prev.disabled = safeIndex <= 0;
  if (next) next.disabled = safeIndex >= totalPages - 1;
  pagination.style.display = "flex";
  pagination.style.visibility = totalCount > ESCROW_PAGE_SIZE ? "visible" : "hidden";
}

function onEscrowSortHeaderClick(event) {
  const button = event.target.closest("[data-escrow-sort-key]");
  if (!button) return;
  const sortKey = button.getAttribute("data-escrow-sort-key");
  if (!sortKey) return;
  const current = getEscrowSortConfig();
  const nextDirection =
    current.key === sortKey ? (current.direction === "asc" ? "desc" : "asc") : getDefaultEscrowSortDirection(sortKey);
  state.billing.escrowSort = `${sortKey}_${nextDirection}`;
  state.billing.escrowPage = 0;
  const body = document.getElementById("activeEscrowsBody");
  if (body) renderActiveEscrows(body, state.billing.escrows || []);
}

function onEscrowPaginationClick(event) {
  const button = event.target.closest("[data-escrow-page-action]");
  if (!button) return;
  const action = button.dataset.escrowPageAction;
  const total = state.billing?.escrows?.length || 0;
  const totalPages = Math.max(1, Math.ceil(total / ESCROW_PAGE_SIZE));
  const current = Math.max(0, state.billing?.escrowPage ?? 0);
  let nextIndex = current;
  if (action === "prev") nextIndex = Math.max(0, current - 1);
  if (action === "next") nextIndex = Math.min(totalPages - 1, current + 1);
  if (nextIndex === current) return;
  state.billing.escrowPage = nextIndex;
  const body = document.getElementById("activeEscrowsBody");
  if (body) renderActiveEscrows(body, state.billing.escrows || []);
}

function sortActiveEscrows(escrows = []) {
  const sortKey = state.billing?.escrowSort || "funded_desc";
  const items = Array.isArray(escrows) ? [...escrows] : [];
  items.sort((left, right) => compareActiveEscrowRecords(left, right, sortKey));
  return items;
}

function compareActiveEscrowRecords(left = {}, right = {}, sortKey = "funded_desc") {
  const { key, direction } = parseEscrowSort(sortKey);
  const leftCase = getActiveEscrowSortCaseName(left);
  const rightCase = getActiveEscrowSortCaseName(right);
  const leftParalegal = getActiveEscrowSortParalegal(left);
  const rightParalegal = getActiveEscrowSortParalegal(right);
  const leftAmount = getActiveEscrowSortAmount(left);
  const rightAmount = getActiveEscrowSortAmount(right);
  const leftDate = getActiveEscrowSortDate(left);
  const rightDate = getActiveEscrowSortDate(right);

  let result = 0;
  if (key === "case") {
    result = compareStrings(leftCase, rightCase) || compareStrings(leftParalegal, rightParalegal);
  } else if (key === "paralegal") {
    result = compareStrings(leftParalegal, rightParalegal) || compareStrings(leftCase, rightCase);
  } else if (key === "amount") {
    result = compareNumbers(leftAmount, rightAmount) || compareStrings(leftCase, rightCase);
  } else if (key === "funded") {
    result = compareNumbers(leftDate, rightDate) || compareStrings(leftCase, rightCase);
  } else if (key === "case_status") {
    result =
      compareStrings(formatActiveEscrowCaseStatus(left), formatActiveEscrowCaseStatus(right)) ||
      compareStrings(leftCase, rightCase);
  } else if (key === "payment_status") {
    result = compareStrings(formatActiveEscrowPaymentStatus(left), formatActiveEscrowPaymentStatus(right)) || compareStrings(leftCase, rightCase);
  } else {
    result = compareNumbers(leftDate, rightDate) || compareStrings(leftCase, rightCase);
  }

  if (direction === "desc") result *= -1;
  return result;
}

function getActiveEscrowSortCaseName(record = {}) {
  return String(record.caseTitle || record.caseName || record.title || record.paralegalName || "").trim().toLowerCase();
}

function getActiveEscrowSortParalegal(record = {}) {
  return String(
    record.paralegalName ||
      (record.paralegal && [record.paralegal.firstName, record.paralegal.lastName].filter(Boolean).join(" ")) ||
      ""
  )
    .trim()
    .toLowerCase();
}

function getActiveEscrowSortAmount(record = {}) {
  return normalizeAmountToCents(
    record.amountHeld ??
      record.amount ??
      record.lockedTotalAmount ??
      record.totalAmount ??
      record.budget
  );
}

function getActiveEscrowSortDate(record = {}) {
  const raw = record.fundedAt || record.createdAt || record.updatedAt;
  const timestamp = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareNumbers(left, right) {
  return left - right;
}

function compareStrings(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base" });
}

function formatActiveEscrowCaseStatus(record = {}) {
  if (record.archived === true) return "Archived";
  const normalized = normalizeCaseStatus(record.caseStatus || "");
  return ({ paused: 'Paused', archived: 'Archived', open: 'Posted', completed: 'Completed', closed: 'Closed', disputed: 'Disputed', 'in progress': 'In progress' })[normalized] || 'Status unavailable';
}

function formatActiveEscrowPaymentStatus(record = {}) {
  const statusRaw = String(record.status || record.escrowStatus || "").toLowerCase();
  const confirmed = { active: 'Funds recorded', needs_review: 'Needs review', pending: 'Funding pending', funding_needed: 'Funding needed', settled: 'Settled' };
  if (confirmed[statusRaw]) return confirmed[statusRaw];
  if (statusRaw) {
    return statusRaw.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }
  return "Status unavailable";
}

function parseEscrowSort(sortValue = "") {
  const normalized = String(sortValue || "").trim().toLowerCase();
  const match = normalized.match(/^(case|paralegal|amount|funded|case_status|payment_status)_(asc|desc)$/);
  if (match) {
    return { key: match[1], direction: match[2] };
  }
  return { key: "funded", direction: "desc" };
}

function getEscrowSortConfig() {
  return parseEscrowSort(state.billing?.escrowSort || "funded_desc");
}

function getDefaultEscrowSortDirection(sortKey = "") {
  return sortKey === "amount" || sortKey === "funded" ? "desc" : "asc";
}

function updateEscrowSortHeaders() {
  const { key, direction } = getEscrowSortConfig();
  document.querySelectorAll("[data-escrow-sort-th]").forEach((header) => {
    const headerKey = header.getAttribute("data-escrow-sort-th");
    const indicator = header.querySelector(".sort-indicator");
    const active = headerKey === key;
    header.classList.toggle("is-sorted", active);
    header.setAttribute("aria-sort", active ? (direction === "asc" ? "ascending" : "descending") : "none");
    if (indicator) {
      indicator.textContent = active ? (direction === "asc" ? "↑" : "↓") : "↕";
    }
  });
}

function onActiveEscrowAction(event) {
  const btn = event.target.closest("[data-escrow-action]");
  if (!btn) return;
  const action = btn.dataset.escrowAction;
  const caseId = btn.getAttribute("data-case-id");
  if (!caseId) return;
  if (action === "view") {
    window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
  } else if (action === "messages") {
    goToMessages(caseId);
  }
}


function parseCaseId(entry = {}) {
  return entry.caseId || entry.id || entry._id || entry.case || entry.caseID;
}

function parseParalegalId(entry = {}) {
  if (entry.paralegalId) return entry.paralegalId;
  if (entry.paralegal?._id) return entry.paralegal._id;
  if (entry.paralegal?.id) return entry.paralegal.id;
  if (typeof entry.paralegal === "string") return entry.paralegal;
  return "";
}

function buildBillingReturnUrl() {
  return "dashboard-attorney.html#funds";
}



function getCaseEntryById(caseId) {
  const key = String(caseId || "");
  if (!key) return null;
  return (
    currentMatterInventory?.state.result?.items.find((item) => String(parseCaseId(item)) === key) ||
    currentDraftInventory?.state.result?.items.find((item) => !item.localDraft && String(parseCaseId(item)) === key) ||
    state.caseLookup.get(key) ||
    state.cases.find((item) => String(parseCaseId(item)) === key) ||
    state.casesArchived.find((item) => String(parseCaseId(item)) === key) ||
    null
  );
}

function normalizeAmountToCents(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 1 && value > -1 && value !== Math.trunc(value)) {
      return Math.round(value * 100);
    }
    return Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(parsed)) {
      return Math.round(parsed * 100);
    }
  }
  return 0;
}

function formatDisplayDate(raw) {
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// -------------------------
// Case Files Page
// -------------------------
function getArchiveHighlightCaseId() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    return params.get("highlightCase");
  } catch {
    return null;
  }
}

function clearArchiveHighlightCaseId() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("highlightCase")) return;
    url.searchParams.delete("highlightCase");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, "", next);
  } catch {
    // Ignore URL cleanup failures
  }
}

function escapeSelector(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(String(value));
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

function maybeHighlightArchivedCase() {
  const caseId = state.archiveHighlightCaseId;
  if (!caseId || state.archiveHighlightApplied) return;
  if (state.casesViewFilter !== "archived") return;
  const row = document.querySelector(
    `[data-table-body="archived"] tr[data-case-id="${escapeSelector(caseId)}"]`
  );
  if (!row) return;
  state.archiveHighlightApplied = true;
  row.classList.add("case-highlight");
  window.setTimeout(() => {
    row.classList.remove("case-highlight");
  }, 3500);
  clearArchiveHighlightCaseId();
}

// Tasks Page
// -------------------------
async function initTasksPage() {
  setupTaskCreation();
  await Promise.all([loadCasesWithFiles(), loadTasks()]);
  renderTasks();
  bindTaskEvents();
}

async function loadTasks({ append = false } = {}) {
  const container = document.getElementById("taskColumns");
  container?.setAttribute("aria-busy", "true");
  let loaded = false;
  try {
    const page = append ? state.tasksPage + 1 : 1;
    const res = await secureFetch(`/api/checklist?status=all&limit=100&page=${page}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Tasks could not be loaded. Try again.");
    const payload = await res.json();
    const items = Array.isArray(payload.items) ? payload.items : [];
    state.tasks = append ? [...state.tasks, ...items] : items;
    state.tasksPage = Number(payload.page) || page;
    state.tasksPages = Math.max(1, Number(payload.pages) || 1);
    state.tasksTotal = Math.max(state.tasks.length, Number(payload.total) || 0);
    state.tasksError = "";
    loaded = true;
  } catch (err) {
    console.warn("Unable to load tasks", err);
    if (append) {
      notifyTasks("More tasks could not be loaded. Try again.", "error");
    } else {
      state.tasks = [];
      state.tasksPage = 1;
      state.tasksPages = 1;
      state.tasksTotal = 0;
      state.tasksError = err?.message || "Tasks could not be loaded. Try again.";
    }
  } finally {
    container?.setAttribute("aria-busy", "false");
  }
  return loaded;
}

function renderTasks() {
  const container = document.getElementById("taskColumns");
  if (!container) return;
  if (state.tasksError) {
    container.innerHTML = `<section class="task-column"><h2>Tasks unavailable</h2><p class="task-empty">${sanitize(state.tasksError)}</p><button type="button" class="task-button" data-retry-tasks>Try again</button></section>`;
    return;
  }
  if (!state.tasks.length) {
    container.innerHTML = `<section class="task-column"><h2>To do</h2><p class="task-empty">No tasks yet. Create one when you need a private reminder.</p></section>`;
    return;
  }
  const now = new Date();
  const soon = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
  const todo = [];
  const inProgress = [];
  const done = [];
  state.tasks.forEach((task) => {
    if (task.done) done.push(task);
    else if (task.due && new Date(task.due) <= soon) inProgress.push(task);
    else todo.push(task);
  });
  container.innerHTML = `
    ${renderTaskColumn("To do", todo)}
    ${renderTaskColumn("Due soon", inProgress)}
    ${renderTaskColumn("Completed", done)}
    ${state.tasksPage < state.tasksPages
      ? `<div class="task-load-more"><button type="button" class="task-button" data-load-more-tasks>Show more tasks (${state.tasksTotal - state.tasks.length} remaining)</button></div>`
      : ""}
  `;
}

function renderTaskColumn(title, tasks) {
  if (!tasks.length) {
    return `<section class="task-column"><h2>${title}</h2><p class="task-empty">No tasks.</p></section>`;
  }
  const map = state.caseLookup;
  const rows = tasks
    .map((task) => {
      const caseTitle = map.get(String(task.caseId))?.title || "";
      const dueDate = task.due ? new Date(task.due) : null;
      const due = dueDate && Number.isFinite(dueDate.getTime()) ? dueDate.toLocaleDateString() : "No due date";
      const notes = task.notes ? `<span class="task-card-notes">${sanitize(task.notes)}</span>` : "";
      return `
        <button type="button" class="task-card" data-task-id="${task.id}" aria-label="Open task: ${sanitize(task.title || "Task")}">
          <span class="task-card-title">${sanitize(task.title)}</span>
          ${notes}
          <span class="task-meta">
            <span>Due: ${due}</span>
            <span>${sanitize(caseTitle || "Private task")}</span>
          </span>
        </button>
      `;
    })
    .join("");
  return `<section class="task-column"><h2>${title}</h2>${rows}</section>`;
}

function bindTaskEvents() {
  const container = document.getElementById("taskColumns");
  const modal = document.getElementById("taskDetailModal");
  container?.addEventListener("click", async (event) => {
    const retry = event.target.closest("[data-retry-tasks]");
    if (retry) {
      retry.disabled = true;
      await loadTasks();
      renderTasks();
      return;
    }
    const loadMore = event.target.closest("[data-load-more-tasks]");
    if (loadMore) {
      loadMore.disabled = true;
      const loaded = await loadTasks({ append: true });
      if (loaded) renderTasks();
      else loadMore.disabled = false;
      return;
    }
    const card = event.target.closest(".task-card");
    if (!card) return;
    const id = card.getAttribute("data-task-id");
    const task = state.tasks.find((t) => String(t.id) === String(id));
    if (!task) return;
    openTaskModal(task);
  });

  modal?.querySelectorAll("[data-close-task-modal]").forEach((button) => {
    button.addEventListener("click", () => toggleModal(modal, false));
  });
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) toggleModal(modal, false);
  });
  modal?.querySelector("[data-toggle-task]")?.addEventListener("click", async () => {
    const taskId = modal?.getAttribute("data-task-id");
    if (!taskId) return;
    const button = modal.querySelector("[data-toggle-task]");
    button.disabled = true;
    try {
      const res = await secureFetch(`/api/checklist/${taskId}/toggle`, { method: "POST" });
      if (!res.ok) throw new Error(await readTaskApiError(res, "Unable to update task."));
      await loadTasks();
      renderTasks();
      toggleModal(modal, false);
      notifyTasks("Task updated.", "success");
    } catch (err) {
      console.error(err);
      notifyTasks(err?.message || "Unable to update task.", "error");
    } finally {
      button.disabled = false;
    }
  });
  modal?.querySelector("[data-delete-task]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const taskId = modal?.getAttribute("data-task-id");
    if (!taskId) return;
    if (button.dataset.confirming !== "true") {
      button.dataset.confirming = "true";
      button.textContent = "Confirm delete";
      notifyTasks("Select Confirm delete to remove this task.", "info");
      button.focus();
      return;
    }
    button.disabled = true;
    try {
      const res = await secureFetch(`/api/checklist/${taskId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readTaskApiError(res, "Unable to delete task."));
      await loadTasks();
      renderTasks();
      toggleModal(modal, false);
      notifyTasks("Task deleted.", "success");
    } catch (err) {
      console.error(err);
      notifyTasks(err?.message || "Unable to delete task.", "error");
    } finally {
      button.disabled = false;
      button.dataset.confirming = "false";
      button.textContent = "Delete task";
    }
  });
}

async function readTaskApiError(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  return String(payload?.error || payload?.message || fallback).slice(0, 240);
}

function openTaskModal(task) {
  const modal = document.getElementById("taskDetailModal");
  if (!modal) return;
  modal.setAttribute("data-task-id", task.id);
  const caseTitle = state.caseLookup.get(String(task.caseId))?.title || "Unassigned Matter";
  const notesEl = document.getElementById("taskDetailNotes");
  const metaEl = document.getElementById("taskDetailMeta");
  const toggleBtn = modal.querySelector("[data-toggle-task]");
  const deleteBtn = modal.querySelector("[data-delete-task]");
  document.getElementById("taskDetailTitle").textContent = task.title || "Task";
  if (notesEl) notesEl.textContent = task.notes || "No additional notes.";
  if (metaEl) {
    const due = task.due ? new Date(task.due).toLocaleString() : "No due date";
    metaEl.innerHTML = `<strong>Matter:</strong> ${sanitize(caseTitle)}<br/><strong>Due:</strong> ${due}`;
  }
  if (toggleBtn) {
    toggleBtn.textContent = task.done ? "Mark Incomplete" : "Mark Complete";
  }
  if (deleteBtn) {
    deleteBtn.dataset.confirming = "false";
    deleteBtn.textContent = "Delete task";
  }
  toggleModal(modal, true);
}

function setupTaskCreation() {
  const modal = document.getElementById("taskCreateModal");
  const trigger = document.querySelector("[data-create-task]");
  if (!modal || !trigger) return;
  const form = modal.querySelector("[data-task-create-form]");
  trigger.addEventListener("click", () => {
    populateTaskCaseOptions();
    form.reset();
    toggleModal(modal, true);
  });
  modal.querySelectorAll("[data-close-task-create]").forEach((button) => {
    button.addEventListener("click", () => toggleModal(modal, false));
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) toggleModal(modal, false);
  });
  form?.addEventListener("submit", submitTaskCreate);
}

function populateTaskCaseOptions() {
  const select = document.querySelector("[data-task-case]");
  if (!select) return;
  const combinedCases = [...state.cases, ...state.casesArchived];
  const options = [
    `<option value="">Select a matter (optional)</option>`,
    ...combinedCases.map(
      (caseItem) => `<option value="${sanitize(caseItem.id)}">${sanitize(caseItem.title || "Matter")}</option>`
    ),
  ];
  select.innerHTML = options.join("");
}

async function submitTaskCreate(event) {
  event.preventDefault();
  const form = event.target;
  const modal = document.getElementById("taskCreateModal");
  const submitBtn = form.querySelector('button[type="submit"]');
  const titleInput = form.elements.namedItem("title");
  const caseInput = form.elements.namedItem("caseId");
  const dueInput = form.elements.namedItem("due");
  const notesInput = form.elements.namedItem("notes");
  const title = String(titleInput?.value || "").trim();
  const caseId = String(caseInput?.value || "");
  const due = String(dueInput?.value || "");
  const notes = String(notesInput?.value || "").trim();
  if (!title) {
    notifyTasks("Task title is required.", "error");
    titleInput?.focus();
    return;
  }
  const defaultText = submitBtn?.textContent || "Create Task";
  let restoreButton = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
  }
  try {
    const payload = { title };
    if (notes) payload.notes = notes;
    if (due) payload.due = new Date(due).toISOString();
    if (caseId) payload.caseId = caseId;
    const res = await secureFetch("/api/checklist", {
      method: "POST",
      body: payload,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(await readTaskApiError(res, "Unable to create task."));
    form.reset();
    toggleModal(modal, false);
    await loadTasks();
    renderTasks();
    notifyTasks("Task created.", "success");
    enableButtonOnFormInput(form, submitBtn, defaultText);
    restoreButton = false;
  } catch (err) {
    console.warn(err);
    notifyTasks(err.message || "Unable to create task.", "error");
  } finally {
    if (restoreButton && submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = defaultText;
    }
  }
}

function enableButtonOnFormInput(form, button, defaultText) {
  if (!form || !button) return;
  const handler = () => {
    button.disabled = false;
    button.textContent = defaultText;
    form.removeEventListener("input", handler);
  };
  form.addEventListener("input", handler, { once: true });
}

// -------------------------
// Cases Page
// -------------------------
const CASE_STATUS_LABELS = {
  open: "Posted",
  "in progress": "In Progress",
  in_progress: "In Progress",
  completed: "Completed",
  disputed: "Disputed",
  archived: "Archived",
  closed: "Closed",
};
const CASE_STATUS_CLASSES = {
  open: "public",
  "in progress": "private",
  in_progress: "private",
  completed: "accepted",
  disputed: "declined",
  paused: "pending",
  archived: "archived",
  closed: "declined",
};

async function initCasesPage() {
  const wrapper = document.querySelector("[data-cases-wrapper]");
  if (!wrapper) return;

  const searchInput = document.querySelector("[data-cases-search]");
  const tabs = document.querySelectorAll("[data-case-filter]");

  // Drawer compatibility caches are independent of the complete Home and Matter
  // inventories. A pending cache must not block list rows or controls.
  void Promise.all([loadCasesWithFiles(), loadArchivedCases(), loadApplicationsForMyJobs()])
    .catch((err) => console.warn("Unable to load Matter summaries", err));
  setupMatterProductivityFilters();
  setupMatterSavedViews();
  void loadCaseDrafts();
  renderCasesView();

  searchInput?.addEventListener("input", (event) => {
    matterSavedViews?.markCustom();
    state.casesSearchTerm = event.target.value.trim().toLowerCase();
    resetMatterPages();
    writeMatterFilterStateToUrl();
    renderCasesView();
  });

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.caseFilter;
      if (!target || target === state.casesViewFilter) return;
      setCaseFilter(target);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = Array.from(tabs).indexOf(tab);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
        (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      setCaseFilter(next.dataset.caseFilter);
      next.focus();
    });
  });

  wrapper.addEventListener("click", onCasesTableClick);
  wrapper.addEventListener("click", onCasesPaginationClick);
  wrapper.addEventListener("click", (event) => {
    const matterRefresh = event.target.closest('[data-matters-retry], [data-matters-refresh], [data-matters-last-page]');
    if (matterRefresh) {
      if (matterRefresh.hasAttribute('data-matters-last-page')) {
        state.casesPage[state.casesViewFilter] = Math.max(0, (currentMatterInventory?.state.result?.pages || 1) - 1);
        writeMatterFilterStateToUrl();
      }
      void refreshCurrentMattersFrom(matterRefresh);
    }
    const retry = event.target.closest('[data-drafts-retry], [data-drafts-refresh]');
    if (retry) void refreshDraftInventoryFrom(retry);
    const last = event.target.closest('[data-drafts-last-page]');
    if (last) {
      state.casesPage.draft = Math.max(0, (currentDraftInventory?.state.result?.pages || 1) - 1);
      writeMatterFilterStateToUrl();
      void refreshDraftInventoryFrom(last);
    }
  });
  wrapper.addEventListener("change", onDraftSelectionChange);
  wrapper.addEventListener("change", onArchivedSelectionChange);
  document.addEventListener("click", (evt) => {
    if (openCaseMenu && !openCaseMenu.contains(evt.target)) {
      toggleCaseMenu(openCaseMenu, false);
    }
  });
  if (!caseMenuKeydownBound) {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && openCaseMenu) {
        const trigger = openCaseMenuTrigger || openCaseMenu.querySelector(".menu-trigger");
        toggleCaseMenu(openCaseMenu, false);
        trigger?.focus();
      }
    });
    caseMenuKeydownBound = true;
  }
  window.addEventListener("resize", repositionOpenCaseMenu);
  window.addEventListener("scroll", repositionOpenCaseMenu, true);

  document.querySelectorAll("[data-archived-bulk]").forEach((btn) => {
    btn.addEventListener("click", onArchivedBulkAction);
  });
  document.querySelectorAll("[data-draft-bulk]").forEach((btn) => {
    btn.addEventListener("click", onDraftBulkAction);
  });

  const archivedStatusFilter = document.querySelector("[data-archived-status-filter]");
  if (archivedStatusFilter) {
    archivedStatusFilter.value = state.archivedStatusFilter || "all";
    archivedStatusFilter.addEventListener("change", (event) => {
      state.archivedStatusFilter = event.target.value || "all";
      matterSavedViews?.markCustom();
      if (state.casesPage) state.casesPage.archived = 0;
      writeMatterFilterStateToUrl();
      renderCasesView();
    });
  }
  setupCaseNoteModal();

  showCasePostedPopup();
}

function readMatterFilterStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const deadline = String(params.get("matterDeadline") || "");
  const updated = String(params.get("matterUpdated") || "");
  const sort = String(params.get("matterSort") || "recent");
  state.archivedStatusFilter = ["completed", "paused", "archived"].includes(params.get("archiveStatus")) ? params.get("archiveStatus") : "all";
  const search = document.querySelector("[data-cases-search]");
  if (search) search.value = String(params.get("q") || "").slice(0, 200);
  state.casesSearchTerm = String(search?.value || "").trim().toLowerCase();
  state.matterPracticeFilter = String(params.get("matterPractice") || "").slice(0, 120);
  state.matterDeadlineFilter = ["overdue", "7_days", "none"].includes(deadline) ? deadline : "";
  state.matterUpdatedFilter = ["7_days", "30_days"].includes(updated) ? updated : "";
  state.matterSort = ["recent", "deadline", "status", "alphabetical"].includes(sort) ? sort : "recent";
  for (const view of CASE_VIEW_FILTERS) {
    const page = params.get(`${view}Page`);
    state.casesPage[view] = /^[1-9]\d{0,6}$/.test(page || '') && Number(page) <= 1000000 ? Number(page) - 1 : 0;
  }
}

function writeMatterFilterStateToUrl() {
  const url = new URL(window.location.href);
  const values = {
    q: String(document.querySelector("[data-cases-search]")?.value || ""),
    archiveStatus: state.archivedStatusFilter === "all" ? "" : state.archivedStatusFilter,
    matterPractice: state.matterPracticeFilter,
    matterDeadline: state.matterDeadlineFilter,
    matterUpdated: state.matterUpdatedFilter,
    matterSort: state.matterSort === "recent" ? "" : state.matterSort,
    ...Object.fromEntries(CASE_VIEW_FILTERS.map(view => [`${view}Page`, state.casesPage[view] ? state.casesPage[view] + 1 : ''])),
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  });
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function populateMatterPracticeFilter(select) {
  if (!select) return;
  const areas = [...new Set([
    ...(state.cases || []),
    ...(state.casesArchived || []),
    ...(state.localDrafts || []),
  ].map((item) => String(item?.practiceArea || "").trim()).filter(Boolean).concat(currentDraftInventory?.state.result?.practices || [], currentMatterInventory?.state.result?.practices || []))].sort((left, right) => left.localeCompare(right));
  if (state.matterPracticeFilter && !areas.includes(state.matterPracticeFilter)) areas.push(state.matterPracticeFilter);
  select.replaceChildren(new Option("All practice areas", ""));
  areas.forEach((area) => select.add(new Option(area, area)));
  select.value = areas.includes(state.matterPracticeFilter) ? state.matterPracticeFilter : "";
  if (state.matterPracticeFilter && !select.value) state.matterPracticeFilter = "";
}

function resetMatterPages() {
  Object.keys(state.casesPage || {}).forEach((key) => { state.casesPage[key] = 0; });
}

function setupMatterProductivityFilters() {
  readMatterFilterStateFromUrl();
  const practice = document.querySelector("[data-matter-practice-filter]");
  const deadline = document.querySelector("[data-matter-deadline-filter]");
  const updated = document.querySelector("[data-matter-updated-filter]");
  const sort = document.querySelector("[data-matter-sort]");
  const reset = document.querySelector("[data-matter-filter-reset]");
  const menu = document.querySelector("[data-matter-filter-menu]");
  populateMatterPracticeFilter(practice);
  if (deadline) deadline.value = state.matterDeadlineFilter;
  if (updated) updated.value = state.matterUpdatedFilter;
  if (sort) sort.value = state.matterSort;
  const apply = () => {
    matterSavedViews?.markCustom();
    state.matterPracticeFilter = String(practice?.value || "");
    state.matterDeadlineFilter = String(deadline?.value || "");
    state.matterUpdatedFilter = String(updated?.value || "");
    state.matterSort = String(sort?.value || "recent");
    resetMatterPages();
    writeMatterFilterStateToUrl();
    renderCasesView();
  };
  [practice, deadline, updated, sort].forEach((control) => control?.addEventListener("change", apply));
  reset?.addEventListener("click", () => {
    if (practice) practice.value = "";
    if (deadline) deadline.value = "";
    if (updated) updated.value = "";
    if (sort) sort.value = "recent";
    apply();
  });
  document.addEventListener("click", (event) => {
    if (menu?.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu?.open) return;
    menu.open = false;
    menu.querySelector("summary")?.focus();
  });

}

function setupMatterSavedViews() {
  const search = document.querySelector("[data-cases-search]");
  const practice = document.querySelector("[data-matter-practice-filter]");
  const deadline = document.querySelector("[data-matter-deadline-filter]");
  const updated = document.querySelector("[data-matter-updated-filter]");
  const sort = document.querySelector("[data-matter-sort]");

  matterSavedViews = mountAttorneySavedViews({
    api: caseNoteApi, privateState: caseNoteState, ownerId: String(state.user?.id || state.user?._id || ""), signal: new AbortController().signal,
    host: document.querySelector("[data-attorney-saved-view-host]"),
    picker: document.querySelector("[data-matter-saved-view]"),
    saveButton: document.querySelector("[data-matter-save-view]"),
    deleteButton: document.querySelector("[data-matter-delete-view]"),
    status: document.querySelector("[data-matter-saved-view-status]"),
    builtIns: [
      { id: "active", name: "Active matters", filters: { view: "active", sort: "recent" } },
      { id: "deadlines", name: "Upcoming deadlines", filters: { view: "active", deadline: "7_days", sort: "deadline" } },
      { id: "applicants", name: "Applicant review", filters: { view: "inquiries", sort: "recent" } },
    ],
    getState: () => ({
      view: state.casesViewFilter,
      archiveStatus: state.archivedStatusFilter,
      search: String(search?.value || ""),
      practice: state.matterPracticeFilter,
      deadline: state.matterDeadlineFilter,
      updated: state.matterUpdatedFilter,
      sort: state.matterSort,
    }),
    applyState: (filters = {}) => {
      state.archivedStatusFilter = filters.archiveStatus || "all";
      const archive = document.querySelector("[data-archived-status-filter]");
      if (archive) archive.value = state.archivedStatusFilter;
      if (search) search.value = String(filters.search || "");
      state.casesSearchTerm = String(filters.search || "").trim().toLowerCase();
      state.matterPracticeFilter = String(filters.practice || "");
      state.matterDeadlineFilter = String(filters.deadline || "");
      state.matterUpdatedFilter = String(filters.updated || "");
      state.matterSort = String(filters.sort || "recent");
      populateMatterPracticeFilter(practice);
      if (deadline) deadline.value = state.matterDeadlineFilter;
      if (updated) updated.value = state.matterUpdatedFilter;
      if (sort) sort.value = state.matterSort;
      setCaseFilter(String(filters.view || "active"), { render: false, markSavedView: false });
      resetMatterPages();
      writeMatterFilterStateToUrl();
      renderCasesView();
    },
  });
}

function showCasePostedPopup() {
  const overlay = document.getElementById("casePostedOverlay");
  const modal = document.getElementById("casePostedModal");
  if (!overlay || !modal) return;
  const raw = sessionStorage.getItem(CASE_POSTED_STORAGE_KEY);
  if (!raw) return;
  sessionStorage.removeItem(CASE_POSTED_STORAGE_KEY);
  let payload = {};
  try {
    payload = JSON.parse(raw) || {};
  } catch {
    payload = {};
  }
  const title = String(payload?.title || "").trim();
  const titleEl = document.getElementById("casePostedTitle");
  const textEl = document.getElementById("casePostedText");
  if (titleEl) titleEl.textContent = "Matter Posted";
  if (textEl) {
    textEl.textContent = title
      ? `“${title}” is now live and open to applications.`
      : "Your matter is now live and open to applications.";
  }

  const close = () => {
    overlay.classList.remove("is-active");
    modal.classList.remove("is-active");
    modal.setAttribute("aria-hidden", "true");
    modal.setAttribute("inert", "");
    deactivateDialogFocus(modal);
    overlay.setAttribute("aria-hidden", "true");
  };
  if (!modal.dataset.bound) {
    modal.dataset.bound = "true";
    modal.querySelector("#casePostedCloseBtn")?.addEventListener("click", close);
    modal.querySelector("#casePostedConfirmBtn")?.addEventListener("click", close);
    overlay.addEventListener("click", close);
  }

  overlay.classList.add("is-active");
  modal.classList.add("is-active");
  modal.setAttribute("aria-hidden", "false");
  modal.removeAttribute("inert");
  overlay.setAttribute("aria-hidden", "false");
  activateDialogFocus(modal, {
    initialFocus: modal.querySelector("#casePostedConfirmBtn"),
    onEscape: close,
  });
}

async function loadArchivedCases(force = false) {
  if (state.casesArchivedPromise && !force) {
    await state.casesArchivedPromise;
    return state.casesArchived;
  }
  const url = "/api/cases/my?archived=true&withFiles=true&limit=100";
  state.casesArchivedPromise = (async () => {
    try {
      const res = await secureFetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("Archived Matter fetch failed");
      const data = await res.json();
      state.casesArchived = Array.isArray(data) ? data : [];
      buildCaseLookup();
    } catch (err) {
      console.error(err);
      state.casesArchived = [];
    } finally {
      if (force && currentMatterInventory) await loadCurrentMatters({ force: true });
      state.casesArchivedPromise = null;
    }
    return state.casesArchived;
  })();
  return state.casesArchivedPromise;
}

function renderCasesView() {
  if (currentDraftInventory) void loadCaseDrafts();
  if (state.casesViewFilter !== 'draft') void loadCurrentMatters();
  const focused = document.activeElement, focusedCase = focused?.closest?.('[data-case-id]')?.dataset.caseId;
  if (state.casesViewFilter !== "draft" && state.draftSelection.size) {
    state.draftSelection.clear();
  }
  if (state.casesViewFilter !== "archived" && state.archivedSelection.size) {
    state.archivedSelection.clear();
  }
  pruneDraftSelection();
  pruneArchivedSelection();
  state.localDrafts = readLocalDrafts();
  updateCurrentMatterCounts();
  CASE_VIEW_FILTERS.forEach((key) => {
    const body = document.querySelector(`[data-table-body="${key}"]`);
    if (!body) return;
    if (key === 'draft') renderDraftInventory(body);
    else if (key === state.casesViewFilter) renderCurrentMatterInventory(body, key);
    else { body.replaceChildren(); updateCasesPagination(key, 0); }
  });
  updateMatterFilterSummary();
  maybeHighlightArchivedCase();
  if (focusedCase && !focused.isConnected) focusApplicationParent(focusedCase);
}

function updateCurrentMatterCounts() {
  const result = state.casesViewFilter === 'draft' ? currentDraftInventory?.state.result : currentMatterInventory?.state.result;
  for (const view of CASE_VIEW_FILTERS) {
    const count = result?.counts[view === 'inquiries' ? 'applications' : view];
    const target = document.querySelector(`[data-case-count="${view}"]`);
    if (!target) continue;
    target.textContent = count == null ? '—' : String(count);
    if (count == null) target.setAttribute('aria-label', 'Count unavailable');
    else target.removeAttribute('aria-label');
  }
}

function getCasesByFilter(view) {
  if (view === 'draft') return currentDraftInventory?.state.result?.items || [];
  return view === state.casesViewFilter ? currentMatterInventory?.state.result?.items || [] : [];
}

function updateMatterFilterSummary() {
  const count = [state.matterPracticeFilter, state.matterDeadlineFilter, state.matterUpdatedFilter, state.matterSort !== "recent" ? state.matterSort : ""].filter(Boolean).length;
  const badge = document.querySelector("[data-matter-filter-count]");
  const summary = document.querySelector("[data-matter-filter-summary]");
  if (badge) badge.textContent = count ? `(${count})` : "";
  if (summary) summary.textContent = count ? `${count} active filter${count === 1 ? "" : "s"}` : "No active filters";
}

function updateCasesPagination(filterKey, totalCount) {
  const pagination = document.querySelector(`[data-case-pagination="${filterKey}"]`);
  if (!pagination) return;
  const info = pagination.querySelector(`[data-page-info="${filterKey}"]`);
  const prev = pagination.querySelector('[data-page-action="prev"]');
  const next = pagination.querySelector('[data-page-action="next"]');
  const totalPages = Math.max(1, Math.ceil(totalCount / CASE_PAGE_SIZE));
  const pageIndex = Math.max(0, state.casesPage?.[filterKey] ?? 0);
  const safeIndex = Math.min(pageIndex, totalPages - 1);
  if (totalCount === 0) {
    if (info) info.textContent = "0 of 0";
    pagination.style.display = "none";
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    return;
  }
  const start = safeIndex * CASE_PAGE_SIZE + 1;
  const end = Math.min(totalCount, (safeIndex + 1) * CASE_PAGE_SIZE);
  if (info) info.textContent = `${start}–${end} of ${totalCount}`;
  if (prev) prev.disabled = safeIndex <= 0;
  if (next) next.disabled = safeIndex >= totalPages - 1;
  pagination.style.display = totalCount > CASE_PAGE_SIZE ? "flex" : "none";
}

function onCasesPaginationClick(event) {
  const button = event.target.closest("[data-page-action]");
  if (!button) return;
  const action = button.dataset.pageAction;
  const target = button.dataset.pageTarget;
  if (!target || !state.casesPage) return;
  const total = (target === 'draft' ? currentDraftInventory : currentMatterInventory)?.state.result?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / CASE_PAGE_SIZE));
  const current = Math.max(0, state.casesPage[target] ?? 0);
  let nextIndex = current;
  if (action === "prev") nextIndex = Math.max(0, current - 1);
  if (action === "next") nextIndex = Math.min(totalPages - 1, current + 1);
  if (nextIndex === current) return;
  state.casesPage[target] = nextIndex;
  writeMatterFilterStateToUrl();
  if (target === 'draft') renderCasesView();
  else void refreshCurrentMattersFrom(button);
}

function extractApplicantState(rawLocation = "") {
  if (!rawLocation) return "";
  const parts = String(rawLocation)
    .split(/[,|-]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  return parts[parts.length - 1];
}

function formatApplicantExperience(value) {
  const years = Number(value);
  if (!Number.isFinite(years) || years <= 0) return "—";
  if (years >= 10) return "10+ yrs";
  if (years === 1) return "1 yr";
  return `${Math.round(years)} yrs`;
}

function formatApplicantDate(value) {
  if (!value) return "Applied recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Applied recently";
  return `Applied ${date.toLocaleDateString()}`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function normalizeDocKey(value) {
  if (!value) return "";
  return String(value).replace(/^\/+/, "");
}

function normalizeApplicantData(applicant = {}) {
  const profile =
    applicant?.paralegal && typeof applicant.paralegal === "object"
      ? applicant.paralegal
      : applicant?.paralegalId && typeof applicant.paralegalId === "object"
      ? applicant.paralegalId
      : {};
  const snapshot =
    applicant?.profileSnapshot && typeof applicant.profileSnapshot === "object"
      ? applicant.profileSnapshot
      : {};
  const normalizeListEntries = (entries = []) => {
    if (Array.isArray(entries)) {
      return entries
        .map((entry) => {
          if (!entry) return "";
          if (typeof entry === "string") return entry.trim();
          return String(entry.name || entry.language || "").trim();
        })
        .filter(Boolean);
    }
    if (typeof entries === "string") {
      return entries
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    return [];
  };
  const paralegalId =
    profile?.id || profile?._id || applicant?.paralegalId || "";
  const name = getApplicantDisplayName(profile, snapshot);
  const avatar =
    snapshot.profileImage || profile.profileImage || profile.avatarURL || INVITE_AVATAR_FALLBACK;
  const appliedAt = applicant?.appliedAt || applicant?.createdAt || "";
  const locationRaw = snapshot.location || snapshot.state || profile.location || profile.state || "";
  const state = extractApplicantState(locationRaw) || "—";
  const yearsExperience =
    typeof snapshot.yearsExperience === "number" ? snapshot.yearsExperience : profile.yearsExperience;
  const availability = snapshot.availability || profile.availability || "";
  const specialties = normalizeListEntries(snapshot.specialties || profile.specialties);
  const languages = normalizeListEntries(snapshot.languages || profile.languages);
  const bio = snapshot.bio || profile.bio || "";
  const coverLetter = applicant?.coverLetter || applicant?.note || "";
  const acceptedInvitation = String(coverLetter || "").trim().toLowerCase() === "accepted invitation";
  const resumeURL = applicant?.resumeURL || "";
  const linkedInURL = applicant?.linkedInURL || "";
  const status = String(applicant?.status || "pending").toLowerCase();
  const preEngagementRaw = applicant?.preEngagement && typeof applicant.preEngagement === "object"
    ? applicant.preEngagement
    : null;
  const preEngagement = preEngagementRaw
    ? {
        status: String(preEngagementRaw.status || "").toLowerCase(),
        confidentialityAgreementRequired: !!preEngagementRaw.confidentialityAgreementRequired,
        conflictsCheckRequired: !!preEngagementRaw.conflictsCheckRequired,
        conflictsDetails: String(preEngagementRaw.conflictsDetails || ""),
        confidentialityDocument: preEngagementRaw.confidentialityDocument || null,
        paralegalConfidentialityDocument: preEngagementRaw.paralegalConfidentialityDocument || null,
        confidentialityAcknowledged: !!preEngagementRaw.confidentialityAcknowledged,
        confidentialityAcknowledgedAt: preEngagementRaw.confidentialityAcknowledgedAt || null,
        conflictsResponseType: String(preEngagementRaw.conflictsResponseType || "").toLowerCase(),
        conflictsDisclosureText: String(preEngagementRaw.conflictsDisclosureText || ""),
        submittedAt: preEngagementRaw.submittedAt || null,
        reviewedAt: preEngagementRaw.reviewedAt || null,
        reviewedBy: String(preEngagementRaw.reviewedBy || ""),
      }
    : null;
  return {
    applicationId: applicant?.applicationId || "",
    paralegalId,
    name,
    avatar,
    appliedAt,
    location: locationRaw || "",
    state,
    yearsExperience,
    availability,
    specialties,
    languages,
    bio,
    coverLetter,
    acceptedInvitation,
    resumeURL,
    linkedInURL,
    status,
    preEngagement,
  };
}

function formatApplicantPreEngagementStatus(preEngagement = null) {
  const status = String(preEngagement?.status || "").toLowerCase();
  if (status === "submitted") return "Pre-engagement submitted";
  if (status === "approved") return "Pre-engagement approved";
  if (status === "changes_requested") return "Changes requested";
  return "";
}

function formatApplicantConflictsResponse(type = "") {
  if (String(type || "").toLowerCase() === "disclosure") return "Possible conflict disclosed";
  if (String(type || "").toLowerCase() === "none_known") return "No known conflict";
  return "No response";
}

function buildApplicantDrawerRow(applicant, index, caseId) {
  const avatar = applicant.avatar
    ? `<img src="${sanitize(applicant.avatar)}" alt="" />`
    : `<span>${sanitize((applicant.name || "P")[0] || "P")}</span>`;
  const appliedText = formatApplicantDate(applicant.appliedAt);
  const metaParts = [appliedText].filter(Boolean);
  const metaHtml = metaParts.map((part) => `<span>${sanitize(part)}</span>`).join('<span class="dot">•</span>');
  const preEngagementLabel = formatApplicantPreEngagementStatus(applicant.preEngagement);
  return `
    <button type="button" class="applicant-card" data-applicant-row data-case-id="${sanitize(caseId)}" data-applicant-index="${index}" aria-pressed="false">
      <span class="applicant-card-top">
        <span class="applicant-avatar">${avatar}</span>
        <span class="applicant-card-info">
          <span class="applicant-card-name">
            <span class="applicant-name applicant-name--serif">${sanitize(applicant.name)}</span>
          </span>
          <span class="applicant-card-meta">${metaHtml}</span>
          ${preEngagementLabel ? `<span class="applicant-preengagement-flag">${sanitize(preEngagementLabel)}</span>` : ""}
        </span>
      </span>
    </button>
  `;
}

function buildApplicantDetail(applicant, { caseId } = {}) {
  const caseItem = caseId ? state.caseLookup.get(String(caseId)) : null;
  const canHire = !!caseId && !!applicant.paralegalId && canHireForCase(caseItem);
  const returnTo = caseId && applicant.paralegalId ? buildApplicantReturnUrl(caseId, applicant.paralegalId) : "";
  const profileLink = applicant.paralegalId
    ? buildParalegalProfileUrl(applicant.paralegalId, { returnTo })
    : "";
  const resumeURL = applicant.resumeURL || "";
  const resumeIsHttp = isHttpUrl(resumeURL);
  const resumeKey = resumeIsHttp ? "" : normalizeDocKey(resumeURL);
  const linkedInURL = applicant.linkedInURL || "";
  const locationLabel = applicant.state || extractApplicantState(applicant.location) || "—";
  const experienceShort = formatApplicantExperience(applicant.yearsExperience);
  const experienceLong =
    experienceShort && experienceShort !== "—"
      ? `${experienceShort.replace("yrs", "years").replace("yr", "year")} experience`
      : "Experience unavailable";
  const availabilityLabel = applicant.availability || "Availability unavailable";
  const iconAvailable = `<svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="12" r="6" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
  const iconBriefcase = `<svg viewBox="0 0 24 24" focusable="false"><path d="M9 7V6a3 3 0 0 1 6 0v1" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/><rect x="4" y="7" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M4 12h16" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
  const iconPin = `<svg viewBox="0 0 24 24" focusable="false"><path d="M12 22s6-6.4 6-11a6 6 0 1 0-12 0c0 4.6 6 11 6 11Z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="11" r="2.5" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>`;
  const profileDetails = [];
  if (applicant.specialties?.length) {
    profileDetails.push(`Specialties: ${applicant.specialties.join(", ")}`);
  }
  if (applicant.languages?.length) {
    profileDetails.push(`Languages: ${applicant.languages.join(", ")}`);
  }
  const profileDetailsMarkup = profileDetails.length
    ? `<ul class="applicant-detail-list">${profileDetails.map((item) => `<li>${sanitize(item)}</li>`).join("")}</ul>`
    : `<div class="applicant-detail-empty">Profile details not provided.</div>`;
  const cover = (applicant.coverLetter || "").trim();
  const acceptedInvitation = !!applicant.acceptedInvitation;
  const coverMarkup = acceptedInvitation
    ? `<div class="applicant-cover-box">Accepted invitation</div>`
    : cover
    ? `<div class="applicant-cover-box">${sanitize(cover).replace(/\n/g, "<br>")}</div>`
    : `<div class="applicant-cover-box muted">No cover note provided.</div>`;
  const coverLabel = acceptedInvitation ? "Accepted invitation" : "Cover note";
  const safeProfileLink = sanitizeUrl(profileLink);
  const safeResumeUrl = sanitizeUrl(resumeURL);
  const safeLinkedInUrl = sanitizeUrl(linkedInURL, { requiredHost: "linkedin.com" });
  const profileMarkup = safeProfileLink
    ? `<a href="${sanitize(safeProfileLink)}" class="applicant-side-btn">View full profile</a>`
    : `<span class="applicant-side-btn muted" aria-disabled="true">Profile unavailable</span>`;
  const resumeMarkup = resumeURL
    ? resumeIsHttp && safeResumeUrl
      ? `<a href="${sanitize(safeResumeUrl)}" target="_blank" rel="noopener" class="applicant-side-btn">Résumé</a>`
      : `<button type="button" data-applicant-doc data-doc-key="${sanitize(resumeKey)}" class="applicant-side-btn">Résumé</button>`
    : `<span class="applicant-side-btn muted" aria-disabled="true">No résumé</span>`;
  const linkedInMarkup = safeLinkedInUrl
    ? `<a href="${sanitize(safeLinkedInUrl)}" target="_blank" rel="noopener" class="applicant-side-btn">LinkedIn</a>`
    : "";
  const preEngagement = applicant.preEngagement || null;
  const preEngagementStatus = formatApplicantPreEngagementStatus(preEngagement);
  const firstName = String(applicant.name || "Paralegal").split(" ")[0] || "Paralegal";
  const hireMarkup = canHire
    ? `<button type="button" class="applicant-side-hire" data-hire-paralegal data-case-id="${sanitize(
        caseId
      )}" data-paralegal-id="${sanitize(applicant.paralegalId)}" data-paralegal-name="${sanitize(
        applicant.name || "Paralegal"
      )}">Hire ${sanitize(firstName)}</button>`
    : "";
  const removeMarkup =
    caseId && applicant.paralegalId
      ? `<button type="button" class="applicant-side-btn danger" data-remove-applicant data-case-id="${sanitize(
          caseId
        )}" data-paralegal-id="${sanitize(applicant.paralegalId)}">Remove applicant</button>`
      : "";
  const blockMarkup =
    caseId && applicant.paralegalId
      ? `<button type="button" class="applicant-side-btn danger" data-block-applicant data-case-id="${sanitize(
          caseId
        )}" data-paralegal-id="${sanitize(applicant.paralegalId)}" data-paralegal-name="${sanitize(
          applicant.name || "Applicant"
        )}">Block applicant</button>`
      : "";
  const confidentialityDoc = preEngagement?.confidentialityDocument || null;
  const signedDoc = preEngagement?.paralegalConfidentialityDocument || null;
  const preEngagementMarkup = preEngagement
    ? `
        <div class="applicant-detail-section">
          <div class="applicant-detail-section-title">Pre-Engagement</div>
          <div class="applicant-preengagement-box">
            ${preEngagementStatus ? `<div class="applicant-preengagement-status">${sanitize(preEngagementStatus)}</div>` : ""}
            <div class="applicant-preengagement-grid">
              ${preEngagement.confidentialityAgreementRequired ? `
                <div class="applicant-preengagement-item">
                  <span>Confidentiality</span>
                  <strong>${preEngagement.confidentialityAcknowledged ? "Acknowledged" : "Pending"}</strong>
                  ${preEngagement.confidentialityAcknowledgedAt ? `<div class="applicant-preengagement-sub">Acknowledged ${sanitize(formatApplicantDate(preEngagement.confidentialityAcknowledgedAt))}</div>` : ""}
                </div>
              ` : ""}
              ${preEngagement.conflictsCheckRequired ? `
                <div class="applicant-preengagement-item">
                  <span>Conflicts response</span>
                  <strong>${sanitize(formatApplicantConflictsResponse(preEngagement.conflictsResponseType))}</strong>
                  ${preEngagement.submittedAt ? `<div class="applicant-preengagement-sub">Submitted ${sanitize(formatApplicantDate(preEngagement.submittedAt))}</div>` : ""}
                </div>
              ` : ""}
            </div>
            ${confidentialityDoc || signedDoc ? `
              <div class="applicant-detail-actions">
                ${confidentialityDoc?.key ? `<button type="button" class="applicant-detail-chip" data-applicant-doc data-doc-key="${sanitize(confidentialityDoc.key)}">Attorney confidentiality document</button>` : ""}
                ${signedDoc?.key ? `<button type="button" class="applicant-detail-chip" data-applicant-doc data-doc-key="${sanitize(signedDoc.key)}">Signed confidentiality upload</button>` : ""}
              </div>
            ` : ""}
            ${preEngagement.conflictsCheckRequired && preEngagement.conflictsDetails ? `
              <div class="applicant-cover-box">
                <strong>Conflicts check details</strong>
                <div>${sanitize(preEngagement.conflictsDetails).replace(/\n/g, "<br>")}</div>
              </div>
            ` : ""}
            ${preEngagement.conflictsResponseType === "disclosure" && preEngagement.conflictsDisclosureText ? `
              <div class="applicant-cover-box">
                <strong>Disclosure</strong>
                <div>${sanitize(preEngagement.conflictsDisclosureText).replace(/\n/g, "<br>")}</div>
              </div>
            ` : ""}
            ${preEngagement.status === "submitted" ? `
              <div class="applicant-preengagement-actions">
                <button type="button" class="applicant-detail-chip hire-primary" data-preengagement-review-action="approve" data-case-id="${sanitize(caseId)}" data-paralegal-id="${sanitize(applicant.paralegalId)}">Review response</button>
              </div>
            ` : ""}
          </div>
        </div>
      `
    : "";
  return `
    <div class="applicant-detail-grid">
      <div class="applicant-detail-main">
        <div class="applicant-detail-name">${sanitize(coverLabel)}</div>
        <div class="applicant-detail-divider"></div>
        <div class="applicant-detail-section">
          ${coverMarkup}
        </div>
        <div class="applicant-detail-section">
          <div class="applicant-detail-section-title">Profile details</div>
          ${profileDetailsMarkup}
        </div>
        ${preEngagementMarkup}
      </div>
      <aside class="applicant-detail-side">
        <div class="applicant-side-card">

          <div class="applicant-side-meta">
            <div><span class="icon" aria-hidden="true">${iconAvailable}</span>${sanitize(availabilityLabel)}</div>
            <div><span class="icon" aria-hidden="true">${iconBriefcase}</span>${sanitize(experienceLong)}</div>
            <div><span class="icon" aria-hidden="true">${iconPin}</span>${sanitize(
              locationLabel || "Location unavailable"
            )}</div>
          </div>
          <div class="applicant-side-actions">
            ${profileMarkup}
            ${resumeMarkup}
            ${linkedInMarkup}
            ${hireMarkup}
            ${removeMarkup}
            ${blockMarkup}
          </div>
          ${
            hireMarkup
              ? `<div class="applicant-side-note">You’ll review terms and confirm payment before work begins.</div>`
              : ""
          }
        </div>
      </aside>
    </div>
  `;
}

function renderCaseRow(item, filterKey = "active") {
  let client = item.paralegal?.name || item.paralegalNameSnapshot || "";
  const pendingInvites = Array.isArray(item.invites)
    ? item.invites.filter((invite) => String(invite?.status || "pending").toLowerCase() === "pending")
    : [];
  if (!item.paralegal && pendingInvites.length) {
    if (pendingInvites.length === 1 && item.pendingParalegal) {
      const pendingName =
        item.pendingParalegal.name ||
        [item.pendingParalegal.firstName, item.pendingParalegal.lastName].filter(Boolean).join(" ").trim();
      client = `${pendingName || "Invitation"} (Invitation Sent)`;
    } else {
      client = `Invitations Sent (${pendingInvites.length})`;
    }
  } else if (!item.paralegal && item.pendingParalegalId) {
    client = "Invitation Sent";
  }
  const practice = titleCaseWords(item.practiceArea || item.field || "General");
  const displayedDate = formatCaseDate(item.updatedAt || item.completedAt || item.createdAt);
  const normalizedStatus = normalizeCaseStatus(item.status);
  const isCompletedStatus = normalizedStatus === "completed" || normalizedStatus === "closed";
  const isManualArchived =
    item.archived &&
    !isCompletedStatus &&
    normalizedStatus !== "paused" &&
    normalizedStatus !== "disputed";
  const statusKey = item.localDraft ? "draft" : isManualArchived ? "archived" : normalizedStatus;
  const moderationStatus = String(item?.moderationStatus || "none").toLowerCase();
  let statusText = statusKey === "draft" ? "Draft" : formatCaseStatus(statusKey);
  let statusClass = statusKey === "draft" ? "pending" : getStatusClass(statusKey);
  if (
    normalizedStatus === "paused" &&
    String(item?.pausedReason || "") === "paralegal_withdrew" &&
    !item?.payoutFinalizedAt &&
    isDisputeWindowActiveCase(item)
  ) {
    statusText = "24 Hour Hold";
    statusClass = "pending";
  }
  const payoutFinalized = !!item?.payoutFinalizedAt;
  const relisted =
    !!item?.relistRequestedAt ||
    (payoutFinalized && AUTO_RELIST_TYPES.has(String(item?.payoutFinalizedType || "")));
  const hasWithdrawal =
    String(item?.pausedReason || "") === "paralegal_withdrew" || Boolean(item?.withdrawnParalegalId);
  const amountDisplay = formatCaseAmount(item);
  const canViewWorkspace = isWorkspaceEligibleCase(item);
  const canOpenDetail = canOpenCaseDetail(item);
  const previewOnly = shouldOpenCasePreviewOnly(item, { filterKey });
  const caseId = item.id || item.caseId || item._id || "";
  const returnContext = getApplicantReturnContext();
  const shouldOpenDrawer =
    filterKey === "inquiries" && returnContext && String(returnContext.caseId) === String(caseId);
  const applicantCount = Number(
    item.applicantsCount ?? (Array.isArray(item.applicants) ? item.applicants.length : item.applicants) ?? 0
  );
  const hasInvites =
    pendingInvites.length > 0 || !!item.pendingParalegal || !!item.pendingParalegalId;
  const showStatusBadge =
    !hasInvites &&
    applicantCount === 0 &&
    (statusKey === "archived" || normalizedStatus === "paused") &&
    hasWithdrawal;
  let withdrawalBadge = "";
  if (showStatusBadge && !payoutFinalized) {
    withdrawalBadge = `<span class="status withdrawn">Withdrawn</span>`;
  } else if (showStatusBadge && relisted) {
    withdrawalBadge = `<span class="status relisted">Relisted</span>`;
  }
  const moderationBadge =
    moderationStatus === "flagged" || moderationStatus === "resolution_requested"
      ? `<span class="status pending">Flagged</span>`
      : "";
  const applicantsToggle =
    filterKey === "inquiries"
      ? `<button type="button" class="matter-primary-action applicant-toggle" data-applicants-toggle data-case-id="${sanitize(
          caseId
        )}" aria-expanded="${shouldOpenDrawer ? "true" : "false"}"${
          caseId ? "" : ' disabled aria-disabled="true"'
        }>Review ${applicantCount || 0} applicant${applicantCount === 1 ? "" : "s"}</button>`
      : "";
  const retainedDraft = !item.localDraft && normalizedStatus === "draft" && !item.archived;
  const titleMarkup = item.localDraft || retainedDraft
    ? `<a href="${sanitize(currentDraftEditorHref(caseId, retainedDraft))}">${sanitize(item.title || "Untitled Matter")}</a>`
    : canOpenDetail || previewOnly
    ? `<button type="button" class="case-title-trigger" data-case-action="details" data-case-id="${sanitize(caseId)}">${sanitize(
        item.title || "Untitled Matter"
      )}</button>`
    : `<span>${sanitize(item.title || "Untitled Matter")}</span>`;
  const primaryAction = item.localDraft || retainedDraft
    ? `<a class="matter-primary-action" href="${sanitize(currentDraftEditorHref(caseId, retainedDraft))}">Continue draft</a>`
    : applicantsToggle ||
      `<button type="button" class="matter-primary-action" data-case-action="${
        canViewWorkspace ? "workspace" : "details"
      }" data-case-id="${sanitize(caseId)}">${
        canViewWorkspace ? "Continue work" : filterKey === "archived" || normalizedStatus === "draft" ? "View record" : "Open matter"
      }</button>`;
  const nextAction = ["flagged", "resolution_requested"].includes(moderationStatus)
    ? "Review the requested changes"
    : "";
  const dateLabel = filterKey === "draft" ? "Edited" : "Updated";
  const dateMeta = displayedDate === "—" ? "" : `<span class="matter-meta-item">${dateLabel} ${sanitize(displayedDate)}</span>`;
  const statusMarkup = filterKey === "draft" && statusKey === "draft" ? "" : `<span class="status ${statusClass}">${statusText}</span>`;
  const rowStatus = statusMarkup + moderationBadge + withdrawalBadge;
  const deadlineMeta = item.deadline
    ? `<span class="matter-meta-item matter-meta-deadline">Due ${sanitize(formatCaseDate(item.deadline))}</span>`
    : "";
  const paralegalMeta = filterKey === "draft" || !client ? "" : `<span class="matter-meta-item">${sanitize(client)}</span>`;
  const amountMeta = amountDisplay === "—" ? "" : `<span class="matter-meta-item">${sanitize(amountDisplay)}</span>`;
  const drawerRow =
    filterKey === "inquiries"
      ? `
    <tr class="applicant-drawer-row${shouldOpenDrawer ? "" : " hidden"}" data-applicants-row data-case-id="${sanitize(
          caseId
        )}">
      <td colspan="3">
        <div class="applicant-drawer" data-applicants-drawer data-case-id="${sanitize(caseId)}">
          <div class="applicant-drawer-header">
            <div class="applicant-drawer-title">Applicants</div>
            <button type="button" class="applicant-drawer-close" data-applicants-close aria-label="Close applicants">Close</button>
          </div>
          <div class="applicant-drawer-body">
            <div class="applicant-layout">
              <div class="applicant-list-panel">
                <div class="applicant-list" data-applicants-body>
                  <div class="applicant-card empty-card">Loading applicants…</div>
                </div>
              </div>
              <div class="applicant-detail hidden" data-applicant-detail></div>
            </div>
          </div>
        </div>
      </td>
    </tr>`
      : "";
  return `
    <tr class="matter-queue-row" data-case-id="${sanitize(caseId)}">
      <td class="matter-identity"${rowStatus || nextAction ? "" : ' colspan="2"'}>
        <div class="matter-title-line">${titleMarkup}</div>
        <div class="matter-meta" aria-label="Matter details">
          <span class="matter-meta-item">${sanitize(practice)}</span>
          ${paralegalMeta}
          ${amountMeta}
          ${deadlineMeta}
          ${dateMeta}
        </div>
      </td>
      ${rowStatus || nextAction ? `<td class="matter-next-step">
        <div class="matter-status-line">${rowStatus}</div>
        ${nextAction ? `<span class="matter-next-copy">${sanitize(nextAction)}</span>` : ""}
      </td>` : ""}
      <td class="actions matter-row-actions">
        <div class="matter-action-controls">
          ${primaryAction}
          ${renderCaseMenu(item)}
        </div>
      </td>
    </tr>
    ${drawerRow}
  `;
}

function renderCaseMenu(item) {
  const baseCaseId = item.id || item.caseId || item._id || "case";
  const safeId = String(baseCaseId || "case").replace(/[^a-z0-9_-]/gi, "");
  const menuId = `case-menu-${safeId || "case"}`;
  const isFinal = isFinalCase(item);
  const canViewWorkspace = isWorkspaceEligibleCase(item);
  const canOpenDetail = canOpenCaseDetail(item);
  const previewOnly = shouldOpenCasePreviewOnly(item);
  const hasAssigned = hasAssignedParalegal(item);
  const canDelete = canDeleteCase(item);
  const statusKey = normalizeCaseStatus(item.status);
  const hasInvites =
    (Array.isArray(item.invites) && item.invites.length > 0) ||
    !!(item.pendingParalegal || item.pendingParalegalId);
  const applicantsCount = Number(
    item.applicantsCount ?? (Array.isArray(item.applicants) ? item.applicants.length : item.applicants) ?? 0
  );
  const canEditCase =
    !item.archived &&
    !hasAssigned &&
    !hasInvites &&
    !applicantsCount &&
    statusKey === "open";
  const moderationStatus = String(item?.moderationStatus || "none").toLowerCase();
  if (item.localDraft) {
    return `
    <div class="case-actions" data-case-id="${baseCaseId}">
      <button class="menu-trigger" type="button" aria-label="More actions for ${sanitize(item.title || "Untitled Matter")}" aria-expanded="false" aria-controls="${menuId}" data-case-menu-trigger>⋯</button>
      <div class="case-menu" id="${menuId}" role="group" aria-label="Matter actions">
        <button type="button" class="menu-item danger" data-case-action="discard-draft" data-case-id="${baseCaseId}">Delete draft</button>
      </div>
    </div>
    `;
  }
  const parts = [];
  if (canEditCase) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="edit-case" data-case-id="${baseCaseId}">Edit Matter</button>`
    );
  }
  if (previewOnly || !item.archived) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="details" data-case-id="${baseCaseId}">View Details</button>`
    );
  }
  if (["flagged", "resolution_requested"].includes(moderationStatus)) {
    parts.push(`<button type="button" class="menu-item" data-case-action="flag-resolved" data-case-id="${baseCaseId}">Review admin edit request</button>`);
  }
  parts.push(
    `<button type="button" class="menu-item" data-case-action="status-history" data-case-id="${baseCaseId}">View Status History</button>`,
    `<button type="button" class="menu-item" data-case-action="edit-note" data-case-id="${baseCaseId}">Edit Matter note</button>`
  );
  if (!previewOnly && canOpenDetail && !canViewWorkspace) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="open-case-detail" data-case-id="${baseCaseId}">Open Matter</button>`
    );
  }
  if (!previewOnly && canViewWorkspace) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="workspace" data-case-id="${baseCaseId}">Open Workspace</button>`,
      `<button type="button" class="menu-item" data-case-action="messages" data-case-id="${baseCaseId}">Open Messages</button>`
    );
  }
  if (hasInvites) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="view-invited" data-case-id="${baseCaseId}">View Invited Paralegals</button>`
    );
  }
  parts.push(`<button type="button" class="menu-item" data-case-action="application-review" data-case-id="${baseCaseId}">Review applications</button>`);
  parts.push(`<button type="button" class="menu-item" data-case-action="download" data-case-id="${baseCaseId}">Download Files</button>`);
  parts.push(`<button type="button" class="menu-item" data-case-action="download-receipt" data-case-id="${baseCaseId}">View receipt</button>`);
  if (item.archived) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="download-archive" data-case-id="${baseCaseId}">Review archive download</button>`
    );
    if (!isFinal) {
      parts.push(
        `<button type="button" class="menu-item" data-case-action="restore" data-case-id="${baseCaseId}">Restore Matter</button>`
      );
    }
  } else if (!hasAssigned) {
    parts.push(
      `<button type="button" class="menu-item danger" data-case-action="archive" data-case-id="${baseCaseId}">Archive Matter</button>`
    );
  }
  if (isFinal || (!item.archived && hasAssigned)) parts.push(`<button type="button" class="menu-item" data-case-action="archive-status" data-case-id="${baseCaseId}">View archive status</button>`);
  if (canDelete) {
    parts.push(
      `<button type="button" class="menu-item danger" data-case-action="delete-case" data-case-id="${baseCaseId}">Delete Matter</button>`
    );
  }
  if (!parts.length) {
    return "";
  }
  return `
    <div class="case-actions" data-case-id="${baseCaseId}">
      <button class="menu-trigger" type="button" aria-label="More actions for ${sanitize(item.title || "Untitled Matter")}" aria-expanded="false" aria-controls="${menuId}" data-case-menu-trigger>⋯</button>
      <div class="case-menu" id="${menuId}" role="group" aria-label="Matter actions">
        ${parts.join("")}
      </div>
    </div>
  `;
}

function closeApplicantsDrawer(drawerRow, toggleBtn) {
  const caseId = drawerRow?.getAttribute("data-case-id") || toggleBtn?.dataset?.caseId || "";
  if (drawerRow) drawerRow.classList.add("hidden");
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
  if (applicantReturnContext && caseId && String(applicantReturnContext.caseId) === String(caseId)) {
    applicantReturnResolved = false;
    applicantReturnContext = null;
    clearApplicantReturnQuery();
  }
}

function openApplicantsDrawer(drawerRow, toggleBtn, { skipAnimation = false } = {}) {
  if (drawerRow) {
    const drawer = drawerRow.querySelector(".applicant-drawer");
    if (skipAnimation && drawer) {
      drawer.classList.add("no-transition");
      window.requestAnimationFrame(() => drawer.classList.remove("no-transition"));
    }
    drawerRow.classList.remove("hidden");
  }
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "true");
}

function getDrawerRow(caseId, contextEl) {
  if (!caseId) return null;
  const scope = contextEl?.closest("tbody") || document;
  return scope.querySelector(`[data-applicants-row][data-case-id="${caseId}"]`);
}

function getDrawerElement(caseId, contextEl) {
  const drawerRow = getDrawerRow(caseId, contextEl);
  return drawerRow?.querySelector("[data-applicants-drawer]") || null;
}

function closeOtherApplicantsDrawers(activeCaseId, contextEl) {
  const scope = contextEl?.closest("tbody") || document;
  scope.querySelectorAll("[data-applicants-row]").forEach((row) => {
    const caseId = row.getAttribute("data-case-id") || "";
    if (!caseId || caseId === activeCaseId) return;
    if (!row.classList.contains("hidden")) {
      row.classList.add("hidden");
    }
    const toggle = scope.querySelector(`[data-applicants-toggle][data-case-id="${caseId}"]`);
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  });
}

function renderApplicantsInDrawer(caseId, applicants = [], drawerEl) {
  const body = drawerEl?.querySelector("[data-applicants-body]");
  if (!body) return;
  const visible = applicants.filter((applicant) => !["accepted", "rejected", "withdrawn"].includes(applicant.status));
  if (!visible.length) {
    body.innerHTML = `<div class="applicant-card empty-card">No applications yet.</div>`;
    const detail = drawerEl.querySelector("[data-applicant-detail]");
    if (detail) {
      detail.innerHTML = "";
      detail.classList.add("hidden");
    }
    return;
  }
  body.innerHTML = visible.map((applicant, index) => buildApplicantDrawerRow(applicant, index, caseId)).join("");
  body.querySelectorAll(".applicant-avatar img").forEach((img) => {
    const fallback = () => {
      const initial = document.createElement("span");
      initial.textContent = visible[Number(img.closest("[data-applicant-index]")?.dataset.applicantIndex)]?.name?.[0] || "P";
      img.parentElement?.replaceChildren(initial);
    };
    img.addEventListener("error", fallback, { once: true });
    if (img.complete && !img.naturalWidth) fallback();
  });
  drawerEl.querySelectorAll("[data-applicant-row]").forEach((row) => { row.classList.remove("is-active"); row.setAttribute("aria-pressed", "false"); });
  showApplicantDetail(caseId, 0, drawerEl);
}

function updateCaseApplicantCount(caseId, count) {
  if (!caseId) return;
  const normalized = Number.isFinite(count) ? Math.max(0, count) : 0;
  caseApplicationCounts.set(String(caseId), normalized);
  const updateItem = (item) => {
    const itemId = String(item?.id || item?._id || item?.caseId || "");
    if (!itemId || itemId !== String(caseId)) return;
    item.applicantsCount = normalized;
    item.applicants = normalized;
  };
  state.cases.forEach(updateItem);
  state.casesArchived.forEach(updateItem);
}

async function loadApplicantsForDrawer(caseId, drawerEl) {
  if (!caseId || !drawerEl) return;
  const body = drawerEl.querySelector("[data-applicants-body]");
  if (body) {
    body.innerHTML = `<div class="applicant-card empty-card">Loading applicants…</div>`;
  }
  const existingRequest = applicantDrawerRequests.get(caseId);
  if (existingRequest) {
    existingRequest.abort();
  }
  const controller = new AbortController();
  applicantDrawerRequests.set(caseId, controller);
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/applicants`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error || "Unable to load applicants.");
    }
    const caseKey = parseCaseId(payload) || payload?._id || payload?.id || caseId;
    if (caseKey) {
      state.caseLookup.set(String(caseKey), payload);
    }
    const applicantsRaw = Array.isArray(payload?.applicants) ? payload.applicants : [];
    const applicants = applicantsRaw.map((applicant) => normalizeApplicantData(applicant));
    applicantDrawerCache.set(caseId, applicants);
    renderApplicantsInDrawer(caseId, applicants, drawerEl);
    drawerEl.dataset.loaded = "true";
  } catch (err) {
    if (err?.name === "AbortError") return;
    console.warn("Applicants drawer load failed", err);
    if (body) {
      body.innerHTML = `<div class="applicant-card empty-card">Unable to load applicants.</div>`;
    }
    const detail = drawerEl.querySelector("[data-applicant-detail]");
    if (detail) {
      detail.innerHTML = "";
      detail.classList.add("hidden");
    }
  } finally {
    if (applicantDrawerRequests.get(caseId) === controller) {
      applicantDrawerRequests.delete(caseId);
    }
  }
}

function showApplicantDetail(caseId, index, drawerEl) {
  if (!drawerEl || !caseId) return;
  const applicants = (applicantDrawerCache.get(caseId) || []).filter(
    (entry) => !["accepted", "rejected", "withdrawn"].includes(entry.status)
  );
  const applicant = applicants[index];
  if (!applicant) return;
  drawerEl.querySelectorAll("[data-applicant-row]").forEach((row) => { row.classList.remove("is-active"); row.setAttribute("aria-pressed", "false"); });
  const activeRow = drawerEl.querySelector(`[data-applicant-row][data-applicant-index="${index}"]`);
  if (activeRow) { activeRow.classList.add("is-active"); activeRow.setAttribute("aria-pressed", "true"); }
  const detail = drawerEl.querySelector("[data-applicant-detail]");
  if (!detail) return;
  detail.innerHTML = buildApplicantDetail(applicant, { caseId });
  detail.classList.remove("hidden");
}

function showApplicantDetailById(caseId, applicantId, drawerEl) {
  if (!drawerEl || !caseId || !applicantId) return;
  const applicants = (applicantDrawerCache.get(caseId) || []).filter(
    (entry) => !["accepted", "rejected", "withdrawn"].includes(entry.status)
  );
  const index = applicants.findIndex((applicant) => String(applicant.paralegalId) === String(applicantId));
  if (index < 0) return;
  showApplicantDetail(caseId, index, drawerEl);
  const activeRow = drawerEl.querySelector(`[data-applicant-row][data-applicant-index="${index}"]`);
  activeRow?.scrollIntoView({ block: "nearest" });
}

async function openApplicantDocument(key) {
  if (!key) return;
  try {
    const params = new URLSearchParams({ key });
    const res = await secureFetch(`/api/uploads/signed-get?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) {
      notifyCases(MISSING_DOCUMENT_MESSAGE, "info");
      return;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload?.url) {
      throw new Error(payload?.msg || payload?.error || "Document unavailable.");
    }
    const documentUrl = normalizeHttpNavigationUrl(payload.url);
    if (!documentUrl) throw new Error("The document destination is invalid.");
    window.open(documentUrl, "_blank", "noopener");
  } catch (err) {
    notifyCases(err?.message || "Unable to open document.", "error");
  }
}

async function reviewApplicantPreEngagement(caseId, paralegalId) {
  await openCaseNoteModal(caseId, "preengagement", null, paralegalId);
}

function pruneArchivedSelection() {
  if (!state.archivedSelection) state.archivedSelection = new Set();
  if (!state.archivedSelection.size) return;
  const valid = new Set(
    getCasesByFilter('archived')
      .filter((item) => canDeleteCase(item))
      .map((item) => String(parseCaseId(item)))
      .filter(Boolean)
  );
  state.archivedSelection.forEach((id) => {
    if (!valid.has(id)) state.archivedSelection.delete(id);
  });
}

function currentMatterTargetId() {
  const target = state.casesViewFilter === 'archived' && !state.archiveHighlightApplied ? state.archiveHighlightCaseId :
    state.casesViewFilter === 'inquiries' ? getApplicantContextFromQuery()?.caseId || getApplicantsCaseContextFromQuery()?.caseId : '';
  return /^[a-f0-9]{24}$/i.test(target || '') ? target.toLowerCase() : '';
}

function currentMatterFilters() {
  return {
    ...currentDraftFilters(),
    view: state.casesViewFilter === 'inquiries' ? 'applications' : state.casesViewFilter,
    archiveStatus: state.casesViewFilter === 'archived' ? state.archivedStatusFilter : 'all',
    page: (state.casesPage[state.casesViewFilter] || 0) + 1,
    targetId: currentMatterTargetId(),
  };
}

function loadCurrentMatters(options, control = document.activeElement?.closest('[data-matters-refresh], [data-page-action]')) {
  if (state.casesViewFilter === 'draft') return Promise.resolve();
  if (!currentMatterInventory) currentMatterInventory = createCurrentDraftInventory({
    ownerId: String(state.user?.id || state.user?._id || ''),
    read: (filters, options) => caseNoteApi.readMatterInventory(filters, options),
    verifyOwner: verifyCaseNoteOwner,
    onChange: () => {
      buildCaseLookup();
      queueMicrotask(() => {
        if (state.casesViewFilter === 'draft') return;
        const view = state.casesViewFilter, body = document.querySelector(`[data-table-body="${view}"]`);
        const focused = document.activeElement, focusedCase = body?.contains(focused) ? focused.closest('[data-case-id]')?.dataset.caseId : '';
        updateCurrentMatterCounts();
        populateMatterPracticeFilter(document.querySelector('[data-matter-practice-filter]'));
        if (body) renderCurrentMatterInventory(body, view);
        if (dashboardViewState.currentView === 'cases') { maybeOpenApplicantFromQuery(); maybeOpenApplicantsCaseFromQuery(); }
        pruneArchivedSelection();
        if (focusedCase && !focused.isConnected && dashboardViewState.currentView === 'cases') focusApplicationParent(focusedCase);
      });
    },
  });
  const read = () => currentMatterInventory.load(currentMatterFilters(), options);
  // Background reads temporarily disable the persistent refresh and pager
  // controls. Preserve their focus with the same departure guards as an explicit read.
  return control ? readCurrentMattersFrom(control, read) : read();
}

function refreshCurrentMattersFrom(control) {
  return loadCurrentMatters({ force: true }, control);
}

async function readCurrentMattersFrom(control, read) {
  const view = state.casesViewFilter;
  let departed = false;
  const track = event => { if (event.target !== control && event.target !== document.body) departed = true; };
  document.addEventListener('focusin', track); document.addEventListener('pointerdown', track);
  try {
    await read();
    if (!departed && state.casesViewFilter === view && dashboardViewState.currentView === 'cases') {
      const pagination = control.matches('[data-page-action]') && currentMatterInventory?.state.result;
      const target = pagination && !control.disabled ? control : pagination && document.querySelector(`[data-case-pagination="${view}"] [data-page-action]:not(:disabled)`) || document.querySelector(currentMatterInventory?.state.result ? `[data-matters-refresh="${view}"]` : '[data-matters-retry]');
      if (target?.getClientRects().length) target.focus();
    }
  } finally { document.removeEventListener('focusin', track); document.removeEventListener('pointerdown', track); }
}

function renderCurrentMatterInventory(body, view) {
  const inventory = currentMatterInventory?.state;
  const loading = !inventory || ['idle', 'loading'].includes(inventory.phase);
  body.setAttribute('aria-busy', String(loading));
  const refresh = document.querySelector(`[data-matters-refresh="${view}"]`);
  if (refresh) { refresh.disabled = loading; refresh.hidden = !inventory?.result; }
  if (!inventory?.result) {
    body.innerHTML = `<tr><td colspan="3" class="empty-row"><div role="status">${loading ? 'Loading matters…' : 'Matters couldn’t be loaded.'}</div>${loading ? '' : '<button type="button" class="matter-primary-action" data-matters-retry>Retry matters</button>'}</td></tr>`;
    updateCasesPagination(view, 0); return;
  }
  const {items, total, page, pages} = inventory.result;
  if (page > pages) {
    body.innerHTML = '<tr><td colspan="3" class="empty-row"><div role="status">This page is no longer available. Your matters may have changed.</div><button type="button" class="matter-primary-action" data-matters-last-page>Go to the last page</button></td></tr>';
    updateCasesPagination(view, 0); return;
  }
  if (state.casesPage[view] !== page - 1) { state.casesPage[view] = page - 1; writeMatterFilterStateToUrl(); }
  const filtered = Boolean(state.casesSearchTerm || state.matterPracticeFilter || state.matterDeadlineFilter || state.matterUpdatedFilter || (view === 'archived' && state.archivedStatusFilter !== 'all'));
  const message = filtered ? 'No matters match these filters. Reset filters to see more.' : view === 'inquiries' ? 'No applications to review.' : 'No matters in this category yet.';
  body.innerHTML = items.length ? items.map(item => renderCaseRow(item, view)).join('') : `<tr><td colspan="3" class="empty-row"><div role="status">${message}</div></td></tr>`;
  const target = currentMatterTargetId();
  if (target && !items.some(item => String(parseCaseId(item)) === target)) body.insertAdjacentHTML('afterbegin', '<tr><td colspan="3" class="empty-row"><div role="status">The linked Matter isn’t in this view.</div></td></tr>');
  updateCasesPagination(view, total);
  maybeHighlightArchivedCase();
}

function currentDraftFilters() {
  return {
    view: 'draft', search: state.casesSearchTerm, practice: state.matterPracticeFilter,
    deadline: state.matterDeadlineFilter, updated: state.matterUpdatedFilter,
    sort: state.matterSort, archiveStatus: 'all', page: (state.casesPage.draft || 0) + 1, targetId: '',
  };
}

function currentDraftEditorHref(draftId, retained = false) {
  const returnTo = safeCurrentMatterReturn(`/dashboard-attorney.html${window.location.search}#cases:draft`) || '/dashboard-attorney.html#cases:draft';
  return `create-case.html?${new URLSearchParams({ [retained ? 'caseDraftId' : 'draftId']: draftId, returnTo })}#description`;
}

async function refreshDraftInventoryFrom(control) {
  let departed = false;
  const track = event => { if (event.target !== control && event.target !== document.body) departed = true; };
  document.addEventListener('focusin', track);
  document.addEventListener('pointerdown', track);
  try {
    await loadCaseDrafts({ force: true });
    if (!departed && state.casesViewFilter === 'draft' && dashboardViewState.currentView === 'cases') {
      const target = document.querySelector(currentDraftInventory?.state.result ? '[data-drafts-refresh]' : '[data-drafts-retry]');
      if (target?.getClientRects().length) target.focus();
    }
  } finally {
    document.removeEventListener('focusin', track);
    document.removeEventListener('pointerdown', track);
  }
}

function loadCaseDrafts(options) {
  if (!currentDraftInventory) currentDraftInventory = createCurrentDraftInventory({
    ownerId: String(state.user?.id || state.user?._id || ''),
    read: (filters, options) => caseNoteApi.readMatterInventory(filters, options),
    verifyOwner: verifyCaseNoteOwner,
    onChange: (value) => {
      state.localDrafts = value.result?.items.filter(item => item.localDraft) || [];
      buildCaseLookup();
      queueMicrotask(() => {
        populateMatterPracticeFilter(document.querySelector('[data-matter-practice-filter]'));
        updateCurrentMatterCounts();
        const body = document.querySelector('[data-table-body="draft"]');
        const focused = document.activeElement;
        const focusedCase = body?.contains(focused) ? focused?.closest?.('[data-case-id]')?.dataset.caseId : '';
        if (body) renderDraftInventory(body);
        if (focusedCase && !focused.isConnected && state.casesViewFilter === 'draft' && dashboardViewState.currentView === 'cases') focusApplicationParent(focusedCase);
        pruneDraftSelection();
      });
    },
  });
  return currentDraftInventory.load(currentDraftFilters(), options);
}

function renderDraftInventory(body) {
  const inventory = currentDraftInventory?.state;
  const loading = !inventory || inventory.phase === 'loading' || inventory.phase === 'idle';
  body.setAttribute('aria-busy', String(loading));
  const refresh = document.querySelector('[data-drafts-refresh]');
  if (refresh) { refresh.disabled = loading; refresh.hidden = !inventory?.result; }
  if (!inventory?.result) {
    body.innerHTML = `<tr><td colspan="3" class="empty-row"><div role="status">${loading ? 'Loading drafts…' : 'Drafts couldn’t be loaded.'}</div>${loading ? '' : '<button type="button" class="matter-primary-action" data-drafts-retry>Retry drafts</button>'}</td></tr>`;
    updateCasesPagination('draft', 0);
    return;
  }
  const { items, total, page, pages } = inventory.result;
  if (page > pages) {
    body.innerHTML = '<tr><td colspan="3" class="empty-row"><div role="status">This page is no longer available. Your drafts may have changed.</div><button type="button" class="matter-primary-action" data-drafts-last-page>Go to the last page</button></td></tr>';
    updateCasesPagination('draft', 0);
    return;
  }
  const filtered = Boolean(state.casesSearchTerm || state.matterPracticeFilter || state.matterDeadlineFilter || state.matterUpdatedFilter);
  body.innerHTML = items.length ? items.map(item => renderCaseRow(item, 'draft')).join('') : `<tr><td colspan="3" class="empty-row"><div role="status">${filtered ? 'No drafts match these filters. Reset filters to see more.' : 'No unfinished drafts.'}</div></td></tr>`;
  updateCasesPagination('draft', total);
}

function readLocalDrafts() {
  return Array.isArray(state.localDrafts) ? state.localDrafts : [];
}

const pendingDraftDeletions = new Set();
async function removeLocalDraft(draftId, { skipConfirm = false } = {}) {
  if (!draftId) return;
  const key = String(draftId), ownerId = String(state.user?.id || state.user?._id || "");
  if (pendingDraftDeletions.has(key)) throw new Error("Deletion is already being checked for this draft.");
  pendingDraftDeletions.add(key);
  try {
    const draft = readLocalDrafts().find((item) => String(item.id) === key);
    if (!skipConfirm && !await confirmAction(`Permanently remove “${draft?.title || "Untitled draft"}”? This cannot be undone.`, {
      title: "Delete this draft?", confirmLabel: "Delete draft", tone: "danger",
    })) return;
    const revision = draft?.revision;
    if (!/^[a-f0-9]{64}$/.test(revision || "")) throw new Error("Refresh your drafts before deleting this draft.");
    if (!ownerId || await verifyCaseNoteOwner() !== ownerId) throw new Error("Your account changed. Reload Matters before continuing.");
    let res, payload;
    try {
      res = await secureFetch(`/api/case-drafts/${encodeURIComponent(draftId)}`, {
        method: "DELETE", body: { revision, expectedOwnerId: ownerId }, headers: { Accept: "application/json" }, noRedirect: true,
      });
      payload = await res.json().catch(() => null);
    } catch { throw new Error("Draft deletion was not confirmed. Reload Matters to check before trying again."); }
    if (!res.ok || payload?.success !== true) throw new Error(!res.ok && typeof payload?.error === "string" ? payload.error : "Draft deletion was not confirmed. Reload Matters to check before trying again.");
    if (await verifyCaseNoteOwner() !== ownerId) throw new Error("Your account changed. Reload Matters before continuing.");
    await loadCaseDrafts({ force: true });
  } catch (error) {
    if (error?.message === "account_changed") throw new Error("Your account changed. Reload Matters before continuing.");
    throw error;
  } finally { pendingDraftDeletions.delete(key); }
}

function pruneDraftSelection() {
  if (!state.draftSelection) state.draftSelection = new Set();
  if (!state.draftSelection.size) return;
  const valid = new Set(readLocalDrafts().map((item) => String(parseCaseId(item))).filter(Boolean));
  state.draftSelection.forEach((id) => {
    if (!valid.has(id)) state.draftSelection.delete(id);
  });
}

function syncDraftBulkUI() {
  const bar = document.querySelector("[data-draft-bulk-bar]");
  if (!bar) return;
  pruneDraftSelection();
  const isDraftView = state.casesViewFilter === "draft";
  bar.hidden = !isDraftView;
  const selectAll = bar.querySelector("[data-draft-select-all]");
  const bulkButtons = bar.querySelectorAll("[data-draft-bulk]");
  const checkboxes = Array.from(document.querySelectorAll('[data-table-body="draft"] [data-draft-select]'));

  if (!isDraftView) {
    if (selectAll) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    }
    bulkButtons.forEach((btn) => (btn.disabled = true));
    return;
  }

  checkboxes.forEach((cb) => {
    cb.checked = state.draftSelection.has(cb.value);
  });

  const selectedCount = state.draftSelection.size;
  bulkButtons.forEach((btn) => (btn.disabled = selectedCount === 0));

  if (selectAll) {
    const totalVisible = checkboxes.length;
    const selectedVisible = checkboxes.filter((cb) => cb.checked).length;
    selectAll.checked = totalVisible > 0 && selectedVisible === totalVisible;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < totalVisible;
  }
}

function syncArchivedBulkUI() {
  const bar = document.querySelector("[data-archived-bulk-bar]");
  if (!bar) return;
  pruneArchivedSelection();
  const isArchivedView = state.casesViewFilter === "archived";
  bar.hidden = !isArchivedView;
  const selectAll = bar.querySelector("[data-archived-select-all]");
  const bulkButtons = bar.querySelectorAll("[data-archived-bulk]");
  const checkboxes = Array.from(document.querySelectorAll('[data-table-body="archived"] [data-archived-select]'));

  if (!isArchivedView) {
    if (selectAll) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    }
    bulkButtons.forEach((btn) => (btn.disabled = true));
    return;
  }

  checkboxes.forEach((cb) => {
    cb.checked = state.archivedSelection.has(cb.value);
  });

  const selectedCount = state.archivedSelection.size;
  const selectedIds = Array.from(state.archivedSelection);
  const deleteEnabled =
    selectedCount > 0 && selectedIds.every((id) => canDeleteCase(getCaseEntryById(id)));
  bulkButtons.forEach((btn) => {
    if (btn.dataset.archivedBulk === "delete") {
      btn.hidden = checkboxes.length === 0;
      btn.disabled = !deleteEnabled;
      return;
    }
    btn.hidden = false;
    btn.disabled = selectedCount === 0;
  });

  if (selectAll) {
    const totalVisible = checkboxes.length;
    const selectedVisible = checkboxes.filter((cb) => cb.checked).length;
    selectAll.checked = totalVisible > 0 && selectedVisible === totalVisible;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < totalVisible;
  }
}

let caseNoteModalRef = null;
let caseNoteHost = null;
let caseNoteController = null;
let caseNoteOwnerId = "";
let caseNoteEpoch = 0;
let caseNoteApplicationId = "";
let caseNoteEngagementReturn = null;
const caseNoteState = createPrivateState();
const caseNoteApi = createApiClient({ onAuthenticationLost: () => clearCaseNoteAccess() });

function clearCaseNoteAccess() {
  legacyHome?.clear();
  applicationsCache = [];
  applicationRefreshInputs.clear();
  applicantAutoRefreshEpoch++; window.clearTimeout(applicantAutoRefreshTimer); applicantAutoRefreshTimer = null;
  currentDraftInventory?.clear();
  currentMatterInventory?.clear();
  applicationsReadEpoch += 1; applicationParentController?.abort(); applicationParentController = null; applicationParentPromise = null;
  document.querySelector("[data-cases-wrapper]")?.removeAttribute("aria-busy"); setApplicationParentStatus();
  matterSavedViews?.clear();
  caseNoteState.clear(); caseNoteApi.clear(); caseNoteOwnerId = ""; closeCaseNoteModal(false); closeCaseInvitesModal();
  [state.cases, state.casesArchived, [...state.caseLookup.values()]].forEach((items) => items.forEach((item) => { delete item.internalNotes; }));
}
async function verifyCaseNoteOwner() {
  const expected = String(state.user?.id || state.user?._id || "");
  try {
    const session = classifySession(await caseNoteApi.get("/api/auth/me"));
    if (session.state !== "ready" || session.identity.id !== expected || (caseNoteOwnerId && caseNoteOwnerId !== expected)) throw new Error("account_changed");
    caseNoteOwnerId = expected;
    return expected;
  } catch (error) { clearCaseNoteAccess(); throw error; }
}
function setupCaseNoteModal() {
  if (caseNoteHost) return;
  caseNoteModalRef = document.getElementById("caseNoteModal");
  if (!caseNoteModalRef) return;
  caseNoteHost = caseNoteModalRef.querySelector("[data-case-note-host]");
  caseNoteModalRef.querySelector("[data-note-cancel]")?.addEventListener("click", closeCaseNoteModal);
  caseNoteModalRef.addEventListener("click", (event) => { if (event.target === caseNoteModalRef) closeCaseNoteModal(); });
  const checkIdentity = (value) => {
    if (!caseNoteOwnerId) return;
    try { const user = typeof value === "string" ? JSON.parse(value) : value; if (String(user?.id || user?._id || "") !== caseNoteOwnerId || user?.role !== "attorney") clearCaseNoteAccess(); }
    catch { clearCaseNoteAccess(); }
  };
  window.addEventListener("storage", (event) => { if (event.key === "lpc_user") checkIdentity(event.newValue); });
  window.addEventListener("lpc:user-updated", (event) => checkIdentity(event.detail));
  const verify = () => { if (caseNoteOwnerId && document.visibilityState === "visible") void verifyCaseNoteOwner().catch(() => { /* Verification already cleared confidential notes and closed the editor. */ }); };
  window.addEventListener("focus", verify);
  document.addEventListener("visibilitychange", verify);
  window.setInterval(verify, 60000);
  window.addEventListener("beforeunload", (event) => { if (caseNoteState.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("pagehide", clearCaseNoteAccess);
}
function focusApplicationParent(caseId) {
  const candidates = [
    ...(caseId ? document.querySelectorAll(`.case-actions[data-case-id="${caseId}"] [data-case-menu-trigger]`) : []),
    document.querySelector(`[data-case-filter="${state.casesViewFilter}"]`),
    document.querySelector('[data-cases-search]'),
  ];
  candidates.find(control => control?.isConnected && control.getClientRects().length && !control.closest('[inert]'))?.focus();
}
function closeCaseNoteModal(restoreFocus = true) {
  const engagementReturn = caseNoteEngagementReturn; caseNoteEngagementReturn = null;
  const returnCaseId = caseNoteApplicationId, wasOpen = caseNoteModalRef && !caseNoteModalRef.classList.contains("hidden");
  caseNoteApplicationId = "";
  caseNoteEpoch += 1; caseNoteController?.abort(); caseNoteController = null;
  caseNoteHost?.replaceChildren();
  if (caseNoteModalRef) {
    caseNoteModalRef.classList.add("hidden"); caseNoteModalRef.setAttribute("aria-hidden", "true"); caseNoteModalRef.setAttribute("inert", "");
    deactivateDialogFocus(caseNoteModalRef, { restoreFocus: restoreFocus !== false && !returnCaseId }); caseNoteModalRef.removeAttribute("aria-busy");
    if (wasOpen && returnCaseId && restoreFocus !== false) {
      const selector = engagementReturn?.mode === "preengagement" ? '[data-preengagement-review-action]' : '[data-hire-paralegal]';
      const control = engagementReturn && document.querySelector(`[data-applicants-drawer][data-case-id="${returnCaseId}"] ${selector}[data-paralegal-id="${engagementReturn.applicantId}"]`);
      if (control?.isConnected && control.getClientRects().length && !control.closest('[inert]')) control.focus(); else focusApplicationParent(returnCaseId);
    }
  }
  if (homeAttentionRefreshDeferred) { homeAttentionRefreshDeferred = false; renderNeedsAttentionQueue(); }
}
function flushApplicationParentStatus() {
  if (applicationRefreshInputs.size || !pendingApplicationParentStatus) return;
  const { message, retryOwnerId, caseId } = pendingApplicationParentStatus;
  setApplicationParentStatus(message, retryOwnerId, caseId);
  repositionOpenCaseMenu();
}
function setApplicationParentStatus(message = "", retryOwnerId = "", caseId = "") {
  // This status sits above the Matter rows. Changing its height while targeting
  // a menu or pressing a control moves it before the native click finishes.
  if (applicationRefreshInputs.size) {
    pendingApplicationParentStatus = { message, retryOwnerId, caseId };
    return;
  }
  pendingApplicationParentStatus = null;
  const summary = document.querySelector('[data-application-parent-status]');
  if (!summary) return;
  summary.hidden = !message;
  if (!message) { summary.replaceChildren(); return; }
  let label = summary.querySelector('[data-application-parent-message]');
  if (!label) { label = document.createElement('span'); label.dataset.applicationParentMessage = ''; summary.append(label); }
  label.textContent = message;
  let retry = summary.querySelector('button');
  if (retryOwnerId) {
    if (!retry) {
      retry = document.createElement('button'); retry.type = 'button'; retry.className = 'matter-filter-reset'; retry.textContent = 'Retry';
      retry.addEventListener('click', () => { retry.focus(); void refreshApplicationParent(retry.dataset.ownerId, retry.dataset.caseId); });
      summary.append(document.createTextNode(' '), retry);
    }
    retry.dataset.ownerId = retryOwnerId; retry.dataset.caseId = caseId; retry.disabled = false;
  } else if (retry) retry.disabled = true;
}
function refreshApplicationParent(ownerId, caseId = "", { refreshInventory = true } = {}) {
  applicationParentController?.abort();
  const controller = new AbortController(), ticket = ++applicationsReadEpoch;
  applicationParentController = controller; applicationsPromise = null;
  const retryFocused = !!document.activeElement?.closest?.("[data-application-parent-status]");
  const wrapper = document.querySelector("[data-cases-wrapper]"); wrapper?.setAttribute("aria-busy", "true");
  setApplicationParentStatus("Updating applications…");
  const pending = (async () => {
  try {
    const options = { ownerId, signal: controller.signal };
    const [apps, updatedMatter] = await Promise.all([caseNoteApi.readReceivedApplications(options), caseId ? caseNoteApi.readWorkspaceMatter(caseId, options) : null]);
    if (controller.signal.aborted || ticket !== applicationsReadEpoch || caseNoteOwnerId !== ownerId) return;
    if (!Array.isArray(apps) || apps.some(app => !app || typeof app !== 'object' || !['submitted', 'viewed', 'shortlisted'].includes(app.status))) throw new Error('invalid_applications');
    if (caseId) {
      if (String(updatedMatter?._id || updatedMatter?.id || "") !== caseId || ![updatedMatter.attorney, updatedMatter.attorneyId].some(value => String(value?._id || value?.id || value || "") === ownerId) || typeof updatedMatter.status !== 'string') throw new Error('invalid_matter');
      for (const collection of [state.cases, state.casesArchived]) {
        const index = collection.findIndex(item => String(item._id || item.id) === caseId);
        if (index >= 0) collection[index] = updatedMatter;
      }
      buildCaseLookup(); applicantDrawerCache.delete(caseId);
    }
    applicationsCache = apps;
    if (refreshInventory) await loadCurrentMatters({ force: true });
    if (controller.signal.aborted || ticket !== applicationsReadEpoch || caseNoteOwnerId !== ownerId) return;
    applyApplicationsToCases(apps);
    if (caseId) renderCasesView();
    void legacyHome?.refresh(["applications", "inventory"]);
    setApplicationParentStatus();
    if (retryFocused && document.activeElement === document.body) focusApplicationParent();
    return apps;
  } catch (error) {
    if (!controller.signal.aborted && ticket === applicationsReadEpoch && caseNoteOwnerId === ownerId) {
      setApplicationParentStatus(caseId ? 'Matter and applications could not be refreshed.' : 'Applications could not be refreshed.', ownerId, caseId);
      if (retryFocused && document.activeElement === document.body) document.querySelector('[data-application-parent-status] button')?.focus();
    }
  } finally {
    if (applicationParentController === controller) {
      applicationParentController = null; applicationParentPromise = null; wrapper?.removeAttribute("aria-busy");
      if ((pendingApplicationParentStatus?.message ?? document.querySelector("[data-application-parent-status]")?.textContent) === "Updating applications…") setApplicationParentStatus();
    }
  }
  return null;
  })();
  applicationParentPromise = pending;
  return pending;
}

async function openCaseNoteModal(caseId, mode = "notes", exportIds = null, applicantId = "") {
  if (!caseNoteHost) setupCaseNoteModal();
  if (!/^[a-f0-9]{24}$/i.test(caseId || "") || !caseNoteHost) return;
  closeCaseNoteModal(false); const ticket = caseNoteEpoch;
  const engagement = ["hiring", "preengagement"].includes(mode);
  if (engagement && !/^[a-f0-9]{24}$/i.test(applicantId)) return;
  caseNoteApplicationId = mode === "applications" || engagement ? caseId : "";
  if (engagement) caseNoteEngagementReturn = { mode, applicantId };
  caseNoteModalRef.classList.remove("hidden"); caseNoteModalRef.setAttribute("aria-hidden", "false"); caseNoteModalRef.removeAttribute("inert");
  caseNoteModalRef.querySelector("#caseNoteModalTitle").textContent = mode === "hiring" ? "Review hire" : mode === "preengagement" ? "Review pre-engagement" : mode === "applications" ? "Review applications" : mode === "export" ? "Download Matter archive" : mode === "receipt" ? "Receipt" : mode === "downloads" ? "Files for download" : mode === "archive" ? "Archive and restore" : mode === "review" ? "Review admin edit request" : "Edit Matter Note";
  caseNoteModalRef.querySelector("#caseNoteModalTitle").setAttribute("aria-level", mode === "export" ? "1" : "3");
  caseNoteHost.textContent = "Checking access to your Matter…";
  activateDialogFocus(caseNoteModalRef, { initialFocus: caseNoteModalRef.querySelector("[data-note-cancel]"), onEscape: closeCaseNoteModal });
  try {
    const ownerId = await verifyCaseNoteOwner(); if (ticket !== caseNoteEpoch) return;
    caseNoteController = new AbortController();
    const options = { api: caseNoteApi, signal: caseNoteController.signal, ownerId, privateState: caseNoteState, current: true, autoReview: true };
    let assignmentRefreshed = false;
    const editor = mode === "hiring" ? createHiring(caseId, { applicantId }, { ...options, onRequirements: () => void openCaseNoteModal(caseId, "preengagement", null, applicantId), onReviewed: value => {
      if (value.assigned && !assignmentRefreshed) { assignmentRefreshed = true; void refreshApplicationParent(ownerId, caseId); }
    } }) : mode === "preengagement" ? createPreEngagement(caseId, { applicantId }, { ...options, onContinue: () => void openCaseNoteModal(caseId, "hiring", null, applicantId), onRecorded: () => { void refreshApplicationParent(ownerId, caseId); } }) : mode === "applications" ? createMatterApplications(caseId, { api: caseNoteApi, signal: caseNoteController.signal, ownerId, applicantId, current: true, privateState: caseNoteState, onDecisionRecorded: () => { void refreshApplicationParent(ownerId); } }) : mode === "export" ? (exportIds ? createMatterExportBatch(exportIds, { api: caseNoteApi, signal: caseNoteController.signal, ownerId }) : createMatterExport(caseId, { api: caseNoteApi, signal: caseNoteController.signal, ownerId })) : mode === "receipt" ? createMatterReceipt(caseId, { api: caseNoteApi, signal: caseNoteController.signal, ownerId, current: true, onTitleChange: title => { caseNoteModalRef.querySelector("#caseNoteModalTitle").textContent = title; } }) : mode === "downloads" ? createMatterDownloads(caseId, { api: caseNoteApi, signal: caseNoteController.signal, ownerId }) : mode === "archive" ? createMatterArchive(caseId, { api: caseNoteApi, signal: caseNoteController.signal, ownerId, privateState: caseNoteState, current: true, onNavigate: closeCaseNoteModal, onRecorded: async () => {
      await Promise.all([loadCasesWithFiles(true), loadArchivedCases(true)]); renderCasesView();
    } }) : mode === "review" ? createMatterModeration(caseId, { api: caseNoteApi, signal: caseNoteController.signal, ownerId, privateState: caseNoteState, current: true, openNotes: () => void openCaseNoteModal(caseId), onRecorded: () => {
      void Promise.all([loadCasesWithFiles(true), loadArchivedCases(true)]).then(() => renderCasesView()).catch(error => console.warn("Matter refresh after review failed", error));
    } }) : createMatterNotes(caseId, { api: caseNoteApi, signal: caseNoteController.signal, ownerId, privateState: caseNoteState, onSaved: (payload) => applyNoteToState(caseId, payload) });
    caseNoteHost.replaceChildren(editor);
    await editor.readiness;
    if (ticket === caseNoteEpoch && !engagement) editor.querySelector("textarea:not(:disabled)")?.focus();
  } catch { notifyCases("Matter controls are unavailable until your sign-in is verified.", "error"); }
}

function applyNoteToState(caseId, payload) {
  if (!caseId) return;
  const normalized = {
    note: payload?.note || "",
    updatedAt: payload?.updatedAt || null,
    updatedBy: payload?.updatedBy || null,
  };
  const caseIdStr = String(caseId);
  const syncCollection = (collection = []) => {
    const entry = collection.find((c) => String(c.id) === caseIdStr);
    if (entry) entry.internalNotes = normalized;
  };
  syncCollection(state.cases);
  syncCollection(state.casesArchived);
  if (state.caseLookup.has(caseIdStr)) {
    const target = state.caseLookup.get(caseIdStr);
    if (target) target.internalNotes = normalized;
  }
}

let casePreviewModalRef = null;
let casePreviewFields = null;
let casePreviewTargetId = null;
let casePreviewSetup = false;
let casePreviewFromQueryHandled = false;

function canEditCaseEntry(entry) {
  if (!entry) return false;
  if (entry.archived) return false;
  if (isTerminalCase(entry)) return false;
  const hasAssigned = !!(entry.paralegal || entry.paralegalId);
  const hasInvites =
    (Array.isArray(entry.invites) && entry.invites.some((invite) => String(invite?.status || "pending").toLowerCase() === "pending")) ||
    Boolean(entry.pendingParalegal || entry.pendingParalegalId);
  const applicantsCount = Number(
    entry.applicantsCount ?? (Array.isArray(entry.applicants) ? entry.applicants.length : entry.applicants) ?? 0
  );
  const escrowFunded =
    !!entry.escrowIntentId && String(entry.escrowStatus || "").toLowerCase() === "funded";
  if (hasAssigned || hasInvites || applicantsCount || escrowFunded || entry.paymentReleased) return false;
  return true;
}

function setupCasePreviewModal() {
  if (casePreviewSetup) return;
  casePreviewSetup = true;
  casePreviewModalRef = document.getElementById("casePreviewModal");
  if (!casePreviewModalRef) return;
  casePreviewFields = {
    title: casePreviewModalRef.querySelector("#casePreviewTitle"),
    field: casePreviewModalRef.querySelector("[data-case-preview-field]"),
    location: casePreviewModalRef.querySelector("[data-case-preview-location]"),
    comp: casePreviewModalRef.querySelector("[data-case-preview-comp]"),
    experience: casePreviewModalRef.querySelector("[data-case-preview-experience]"),
    description: casePreviewModalRef.querySelector("[data-case-preview-description]"),
    tasks: casePreviewModalRef.querySelector("[data-case-preview-tasks]"),
    receipt: casePreviewModalRef.querySelector("[data-case-preview-receipt]"),
  };
  casePreviewModalRef.querySelectorAll("[data-case-preview-close]").forEach((btn) => {
    btn.addEventListener("click", closeCasePreviewModal);
  });
  casePreviewModalRef.querySelectorAll("[data-case-preview-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const caseId = casePreviewTargetId || casePreviewModalRef?.dataset?.caseId;
      if (!caseId) return;
      window.location.href = `create-case.html?caseId=${encodeURIComponent(caseId)}#details`;
    });
  });
  casePreviewModalRef.addEventListener("click", (event) => {
    if (event.target === casePreviewModalRef) {
      closeCasePreviewModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && casePreviewModalRef && !casePreviewModalRef.classList.contains("hidden")) {
      closeCasePreviewModal();
    }
  });
}

function closeCasePreviewModal() {
  if (casePreviewModalRef) {
    casePreviewModalRef.classList.add("hidden");
    casePreviewModalRef.setAttribute("aria-hidden", "true");
    casePreviewModalRef.setAttribute("inert", "");
    deactivateDialogFocus(casePreviewModalRef);
    casePreviewModalRef.removeAttribute("aria-busy");
  }
  if (casePreviewFields?.receipt) {
    casePreviewFields.receipt.hidden = true;
    casePreviewFields.receipt.removeAttribute("href");
  }
  casePreviewTargetId = null;
  if (casePreviewModalRef) {
    delete casePreviewModalRef.dataset.caseId;
  }
}

function getCasePreviewQueryId() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const queryId = params.get("previewCaseId");
    if (queryId) return queryId;
  } catch {
    /* ignore */
  }
  return null;
}

function clearCasePreviewQuery() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("previewCaseId")) {
      url.searchParams.delete("previewCaseId");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {}
  casePreviewFromQueryHandled = false;
}

function extractSummaryValue(summary, label) {
  const parts = String(summary || "")
    .split("•")
    .map((part) => part.trim())
    .filter(Boolean);
  const match = parts.find((part) => part.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  if (!match) return "";
  return match.split(":").slice(1).join(":").trim();
}

function titleCaseWords(value) {
  return String(value || "")
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ""))
    .join(" ")
    .trim();
}

let caseInvitesModalRef = null;
let caseInvitesListRef = null;
let caseInvitesSetup = false;
let caseInvitesController = null;
let caseInvitesEpoch = 0;

function setupCaseInvitesModal() {
  if (caseInvitesSetup) return;
  caseInvitesSetup = true;
  caseInvitesModalRef = document.getElementById("caseInvitesModal");
  if (!caseInvitesModalRef) return;
  caseInvitesListRef = caseInvitesModalRef.querySelector("[data-case-invites-list]");
  caseInvitesModalRef.querySelectorAll("[data-case-invites-close]").forEach((btn) => {
    btn.addEventListener("click", closeCaseInvitesModal);
  });
  caseInvitesModalRef.addEventListener("click", (event) => {
    if (event.target === caseInvitesModalRef) {
      closeCaseInvitesModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && caseInvitesModalRef && !caseInvitesModalRef.classList.contains("hidden")) {
      closeCaseInvitesModal();
    }
  });
}

function closeCaseInvitesModal() {
  caseInvitesEpoch += 1; caseInvitesController?.abort(); caseInvitesController = null;
  caseInvitesListRef?.replaceChildren();
  if (caseInvitesModalRef) {
    caseInvitesModalRef.classList.add("hidden");
    caseInvitesModalRef.setAttribute("aria-hidden", "true");
    caseInvitesModalRef.setAttribute("inert", "");
    deactivateDialogFocus(caseInvitesModalRef);
    caseInvitesModalRef.removeAttribute("aria-busy");
  }
}

function buildParalegalProfileUrl(paralegalId, { returnTo = "" } = {}) {
  const safeId = String(paralegalId || "").trim();
  if (!safeId) return "";
  const params = new URLSearchParams({ paralegalId: safeId });
  if (returnTo) params.set("returnTo", returnTo);
  return `profile-paralegal.html?${params.toString()}`;
}

function buildApplicantReturnUrl(caseId, applicantId) {
  const params = new URLSearchParams();
  if (caseId) params.set("caseId", caseId);
  if (applicantId) params.set("applicantId", applicantId);
  params.set("returnFromProfile", "1");
  const query = params.toString();
  return `dashboard-attorney.html${query ? `?${query}` : ""}#cases:inquiries`;
}

function getApplicantContextFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const caseId = params.get("caseId") || "";
  const applicantId = params.get("applicantId") || "";
  const returnFromProfile = params.get("returnFromProfile") === "1";
  const openApplicant = params.get("openApplicant") === "1";
  const continueHire = params.get("continueHire") === "1";
  if (!returnFromProfile && !openApplicant) return null;
  if (!/^[a-f0-9]{24}$/i.test(caseId) || !/^[a-f0-9]{24}$/i.test(applicantId)) return null;
  return { caseId, applicantId, continueHire, applicationHistory: params.get("applicationHistory") === "1" };
}

function getApplicantReturnContext() {
  if (applicantReturnContext) return applicantReturnContext;
  const context = getApplicantContextFromQuery();
  if (context) applicantReturnContext = context;
  return context;
}

function clearApplicantReturnQuery() {
  try {
    const url = new URL(window.location.href);
    if (
      !url.searchParams.has("caseId") &&
      !url.searchParams.has("applicantId") &&
      !url.searchParams.has("returnFromProfile") &&
      !url.searchParams.has("openApplicant") &&
      !url.searchParams.has("continueHire")
    )
      return;
    url.searchParams.delete("caseId");
    url.searchParams.delete("applicantId");
    url.searchParams.delete("returnFromProfile");
    url.searchParams.delete("openApplicant");
    url.searchParams.delete("continueHire");
    url.searchParams.delete("applicationHistory");
    const nextQuery = url.searchParams.toString();
    const nextUrl = `${url.pathname}${nextQuery ? `?${nextQuery}` : ""}${url.hash}`;
    window.history.replaceState({}, "", nextUrl);
  } catch {}
}

async function openApplicantFromQuery({ setFilter = true } = {}) {
  if (applicantReturnOpening) return;
  const context = getApplicantReturnContext();
  if (!context) return;
  const { caseId, applicantId, continueHire, applicationHistory } = context;
  applicantReturnContext = context;
  if (applicationHistory) {
    applicantReturnOpening = true;
    try {
      await openCaseNoteModal(caseId, "applications", null, applicantId);
      applicantReturnResolved = true;
      clearApplicantReturnQuery();
    } finally { applicantReturnOpening = false; }
    return;
  }
  if (setFilter) {
    setCaseFilter("inquiries", { render: false });
  }
  const toggleBtn = document.querySelector(`[data-applicants-toggle][data-case-id="${caseId}"]`);
  if (!toggleBtn) {
    if (continueHire) {
      clearApplicantReturnQuery(); applicantReturnContext = { caseId, applicantId, continueHire: false }; applicantReturnResolved = true;
      await handleHireFromApplications({ caseId, paralegalId: applicantId });
    }
    return;
  }
  const drawerRow = getDrawerRow(caseId, toggleBtn);
  const drawerEl = getDrawerElement(caseId, toggleBtn);
  if (!drawerEl) return;
  let applicants = (applicantDrawerCache.get(caseId) || []).filter(
    (entry) => !["accepted", "rejected", "withdrawn"].includes(entry.status)
  );
  let targetIndex = applicants.findIndex((applicant) => String(applicant.paralegalId) === String(applicantId));
  const activeRow =
    targetIndex >= 0
      ? drawerEl.querySelector(`[data-applicant-row][data-applicant-index="${targetIndex}"].is-active`)
      : null;
  const detail = drawerEl.querySelector("[data-applicant-detail]");
  if (
    drawerEl.dataset.loaded === "true" &&
    drawerRow &&
    !drawerRow.classList.contains("hidden") &&
    activeRow &&
    detail &&
    !detail.classList.contains("hidden") && !continueHire
  ) {
    return;
  }
  applicantReturnOpening = true;
  try {
    if (drawerEl.dataset.loaded !== "true") {
      await loadApplicantsForDrawer(caseId, drawerEl);
    } else if (!drawerEl.querySelector("[data-applicant-row]") && !drawerEl.querySelector(".empty-card")) {
      renderApplicantsInDrawer(caseId, applicantDrawerCache.get(caseId) || [], drawerEl);
    }
    applicants = (applicantDrawerCache.get(caseId) || []).filter(entry => !["accepted", "rejected", "withdrawn"].includes(entry.status));
    targetIndex = applicants.findIndex(entry => String(entry.paralegalId) === String(applicantId));
    if (drawerRow) {
      openApplicantsDrawer(drawerRow, toggleBtn, { skipAnimation: true });
    }
    showApplicantDetailById(caseId, applicantId, drawerEl);
    const targetIsActive =
      targetIndex >= 0 &&
      drawerEl.querySelector(`[data-applicant-row][data-applicant-index="${targetIndex}"].is-active`);
    if (targetIsActive && detail && !detail.classList.contains("hidden")) {
      applicantReturnResolved = true;
    }
    if (setFilter) {
      clearApplicantReturnQuery();
    }
    if (continueHire) {
      clearApplicantReturnQuery();
      applicantReturnContext = { caseId, applicantId, continueHire: false };
      const applicant = applicants[targetIndex] || null;
      await handleHireFromApplications({
        caseId,
        paralegalId: applicantId,
        paralegalName: applicant?.name || "Paralegal",
        button: null,
        skipPreEngagementStep: true,
      });
    }
  } finally {
    applicantReturnOpening = false;
  }
}

function restoreApplicantDrawerFromQuery() {
  if (applicantReturnResolved) return;
  if (!applicantReturnContext) return;
  void openApplicantFromQuery({ setFilter: false });
}

function maybeOpenApplicantFromQuery() {
  if (currentMatterInventory?.state.phase !== 'ready') return;
  if (applicantReturnResolved) return;
  if (applicantReturnHandled) return;
  const context = getApplicantContextFromQuery();
  if (!context) return;
  applicantReturnHandled = true;
  applicantReturnContext = context;
  void openApplicantFromQuery();
}

function getApplicantsCaseContextFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const openApplicants = params.get("openApplicants") === "1";
  const caseId = params.get("caseId") || "";
  if (!openApplicants || !/^[a-f0-9]{24}$/i.test(caseId)) return null;
  return { caseId };
}

function clearApplicantsCaseQuery() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("openApplicants")) return;
    url.searchParams.delete("openApplicants");
    if (url.searchParams.get("caseId")) {
      url.searchParams.delete("caseId");
    }
    const nextQuery = url.searchParams.toString();
    const nextUrl = `${url.pathname}${nextQuery ? `?${nextQuery}` : ""}${url.hash}`;
    window.history.replaceState({}, "", nextUrl);
  } catch {}
}

async function openApplicantsForCase(caseId) {
  if (!caseId) return;
  const toggleBtn = document.querySelector(`[data-applicants-toggle][data-case-id="${caseId}"]`);
  if (!toggleBtn) return;
  const drawerRow = getDrawerRow(caseId, toggleBtn);
  const drawerEl = getDrawerElement(caseId, toggleBtn);
  if (!drawerEl) return;
  closeOtherApplicantsDrawers(caseId, toggleBtn);
  if (drawerEl.dataset.loaded !== "true") {
    await loadApplicantsForDrawer(caseId, drawerEl);
  } else {
    renderApplicantsInDrawer(caseId, applicantDrawerCache.get(caseId) || [], drawerEl);
  }
  if (drawerRow) {
    window.requestAnimationFrame(() => openApplicantsDrawer(drawerRow, toggleBtn, { skipAnimation: true }));
  }
}

function maybeOpenApplicantsCaseFromQuery() {
  if (currentMatterInventory?.state.phase !== 'ready') return;
  if (applicantsCaseHandled) return;
  const context = getApplicantsCaseContextFromQuery();
  if (!context) return;
  applicantsCaseHandled = true;
  void openApplicantsForCase(context.caseId).finally(() => {
    clearApplicantsCaseQuery();
  });
}

function getApplicantDisplayName(profile = {}, snapshot = {}) {
  const name =
    profile.name ||
    [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  return name || snapshot.name || "Paralegal";
}

async function openCaseInvites(caseId) {
  if (!/^[a-f0-9]{24}$/i.test(caseId || "")) return;
  if (dashboardViewState.currentView !== "cases") {
    window.location.hash = "cases";
    showDashboardView("cases", { skipHash: true });
  }
  setupCaseInvitesModal();
  if (!caseInvitesModalRef || !caseInvitesListRef) return;
  closeCaseInvitesModal();
  const ticket = ++caseInvitesEpoch;
  const controller = new AbortController(); caseInvitesController = controller;
  caseInvitesModalRef.classList.remove("hidden");
  caseInvitesModalRef.setAttribute("aria-hidden", "false");
  caseInvitesModalRef.removeAttribute("inert");
  activateDialogFocus(caseInvitesModalRef, {
    initialFocus: caseInvitesModalRef.querySelector("[data-case-invites-close]"),
    onEscape: closeCaseInvitesModal,
  });
  caseInvitesListRef.textContent = "Loading invited paralegals…";
  try {
    const ownerId = await verifyCaseNoteOwner();
    if (controller.signal.aborted || ticket !== caseInvitesEpoch) return;
    const panel = createMatterInvitations(caseId, { api: caseNoteApi, signal: controller.signal, ownerId, current: true });
    caseInvitesListRef.replaceChildren(panel);
    await panel.readiness;
  } catch (error) {
    if (!controller.signal.aborted && ticket === caseInvitesEpoch) caseInvitesListRef.textContent = "Invitations could not be loaded. Close this dialog and try again.";
  }
}



async function openCasePreview(caseId, options = {}) {
  if (!caseId) return;
  const keepView = Boolean(options.keepView);
  const receiptUrl = normalizeHttpNavigationUrl(options.receiptUrl || "");
  if (!keepView && dashboardViewState.currentView !== "cases") {
    try {
      window.location.hash = "cases";
    } catch {}
    showDashboardView("cases", { skipHash: true });
  }
  setupCasePreviewModal();
  if (!casePreviewModalRef || !casePreviewFields) return;
  casePreviewTargetId = String(caseId);
  if (casePreviewModalRef) casePreviewModalRef.dataset.caseId = casePreviewTargetId;
  casePreviewModalRef.classList.remove("hidden");
  casePreviewModalRef.setAttribute("aria-hidden", "false");
  casePreviewModalRef.removeAttribute("inert");
  activateDialogFocus(casePreviewModalRef, {
    initialFocus: casePreviewModalRef.querySelector("[data-case-preview-close]"),
    onEscape: closeCasePreviewModal,
  });
  casePreviewModalRef.setAttribute("aria-busy", "true");

  let entry = state.caseLookup.get(casePreviewTargetId);
  if (!entry) {
    await loadCasesWithFiles();
    entry = state.caseLookup.get(casePreviewTargetId);
  }
  if (!entry) {
    await loadArchivedCases();
    entry = state.caseLookup.get(casePreviewTargetId);
  }
  if (!entry) {
    try {
      const res = await secureFetch(`/api/cases/${encodeURIComponent(casePreviewTargetId)}`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data && (data.id || data._id)) {
          entry = data;
          const key = parseCaseId(entry) || entry._id || entry.id;
          if (key) state.caseLookup.set(String(key), entry);
        }
      }
    } catch (error) {
      console.warn("[attorney] Matter preview fallback request rejected", error);
    }
  }
  if (!entry) {
    if (casePreviewFields.title) casePreviewFields.title.textContent = "Matter Details";
    if (casePreviewFields.field) casePreviewFields.field.textContent = "—";
    if (casePreviewFields.location) casePreviewFields.location.textContent = "—";
    if (casePreviewFields.comp) casePreviewFields.comp.textContent = "—";
    if (casePreviewFields.experience) casePreviewFields.experience.textContent = "—";
    if (casePreviewFields.description) {
      casePreviewFields.description.textContent = "Unable to load matter details right now.";
    }
    if (casePreviewFields.tasks) {
      casePreviewFields.tasks.innerHTML = `<p class="case-preview-empty">No tasks listed.</p>`;
    }
    if (casePreviewFields.receipt) {
      casePreviewFields.receipt.hidden = true;
      casePreviewFields.receipt.removeAttribute("href");
    }
    casePreviewModalRef.removeAttribute("aria-busy");
    notifyCases("Unable to load matter details.", "error");
    return;
  }

  const summary = String(entry.briefSummary || "");
  const experience = extractSummaryValue(summary, "Experience") || "Not specified";
  const location =
    entry.locationState || entry.state || extractSummaryValue(summary, "State") || "—";
  const compensation = formatCaseAmount(entry);
  const rawDetails = String(entry.details || "").trim();
  const description = rawDetails || "No description provided.";
  const practiceArea = titleCaseWords(entry.practiceArea || "");
  const tasks = Array.isArray(entry.tasks) ? entry.tasks : [];
  const taskTitles = tasks
    .map((task) => (typeof task === "string" ? task : task?.title))
    .map((title) => String(title || "").trim())
    .filter(Boolean);

  if (casePreviewFields.title) casePreviewFields.title.textContent = entry.title || "Matter Preview";
  if (casePreviewFields.field) casePreviewFields.field.textContent = practiceArea || "—";
  if (casePreviewFields.location) casePreviewFields.location.textContent = location || "—";
  if (casePreviewFields.comp) casePreviewFields.comp.textContent = compensation || "—";
  if (casePreviewFields.experience) casePreviewFields.experience.textContent = experience || "—";
  if (casePreviewFields.description) casePreviewFields.description.textContent = description;
  if (casePreviewFields.tasks) {
    casePreviewFields.tasks.innerHTML = taskTitles.length
      ? `<ul class="case-preview-task-list">${taskTitles
          .map((title) => `<li>${sanitize(title)}</li>`)
          .join("")}</ul>`
      : `<p class="case-preview-empty">No tasks listed.</p>`;
  }
  if (casePreviewFields.receipt) {
    if (receiptUrl) {
      casePreviewFields.receipt.href = receiptUrl;
      casePreviewFields.receipt.hidden = false;
    } else {
      casePreviewFields.receipt.hidden = true;
      casePreviewFields.receipt.removeAttribute("href");
    }
  }

  const editBtn = casePreviewModalRef?.querySelector("[data-case-preview-edit]");
  if (editBtn) {
    editBtn.disabled = !canEditCaseEntry(entry);
  }

  casePreviewModalRef.removeAttribute("aria-busy");
}

window.openCasePreview = openCasePreview;

function maybeOpenCasePreviewFromQuery() {
  if (casePreviewFromQueryHandled) return;
  const previewId = getCasePreviewQueryId();
  if (!previewId) return;
  casePreviewFromQueryHandled = true;
  void openCasePreview(previewId).finally(() => {
    clearCasePreviewQuery();
  });
}

function onCasesTableClick(event) {
  if (
    event.target.closest("[data-draft-select]") ||
    event.target.closest("[data-draft-select-all]") ||
    event.target.closest("[data-archived-select]") ||
    event.target.closest("[data-archived-select-all]")
  ) {
    return;
  }
  const applicantsToggle = event.target.closest("[data-applicants-toggle]");
  if (applicantsToggle) {
    const caseId = applicantsToggle.dataset.caseId || "";
    if (!caseId) return;
    const drawerRow = getDrawerRow(caseId, applicantsToggle);
    if (!drawerRow) return;
    const drawerEl = getDrawerElement(caseId, applicantsToggle);
    const isOpen = !drawerRow.classList.contains("hidden");
    closeOtherApplicantsDrawers(caseId, applicantsToggle);
    if (isOpen) {
      closeApplicantsDrawer(drawerRow, applicantsToggle);
      return;
    }
    openApplicantsDrawer(drawerRow, applicantsToggle);
    const cached = applicantDrawerCache.get(caseId);
    if (cached && drawerEl) {
      renderApplicantsInDrawer(caseId, cached, drawerEl);
      drawerEl.dataset.loaded = "true";
      return;
    }
    if (drawerEl && drawerEl.dataset.loaded !== "true") {
      void loadApplicantsForDrawer(caseId, drawerEl);
    }
    return;
  }
  const drawerClose = event.target.closest("[data-applicants-close]");
  if (drawerClose) {
    const drawerRow = drawerClose.closest("[data-applicants-row]");
    if (drawerRow) {
      const caseId = drawerRow.getAttribute("data-case-id") || "";
      const toggleBtn = drawerRow
        .closest("tbody")
        ?.querySelector(`[data-applicants-toggle][data-case-id="${caseId}"]`);
      closeApplicantsDrawer(drawerRow, toggleBtn);
      toggleBtn?.focus();
    }
    return;
  }
  const docLink = event.target.closest("[data-applicant-doc]");
  if (docLink) {
    event.preventDefault();
    const key = docLink.dataset.docKey || "";
    if (key) void openApplicantDocument(key);
    return;
  }
  const hireBtn = event.target.closest("[data-hire-paralegal]");
  if (hireBtn) {
    if (hireBtn.hasAttribute("disabled") || hireBtn.getAttribute("aria-disabled") === "true") {
      return;
    }
    event.preventDefault();
    const caseId = hireBtn.dataset.caseId || "";
    const paralegalId = hireBtn.dataset.paralegalId || "";
    const paralegalName = hireBtn.dataset.paralegalName || "Paralegal";
    if (!caseId || !paralegalId) return;
    handleHireFromApplications({ caseId, paralegalId, paralegalName, button: hireBtn });
    return;
  }
  const removeBtn = event.target.closest("[data-remove-applicant]");
  if (removeBtn) {
    event.preventDefault();
    const caseId = removeBtn.dataset.caseId || "";
    const paralegalId = removeBtn.dataset.paralegalId || "";
    if (!caseId || !paralegalId) return;
    const drawerEl = removeBtn.closest("[data-applicants-drawer]");
    void removeApplicantFromCase(caseId, paralegalId, drawerEl);
    return;
  }
  const blockBtn = event.target.closest("[data-block-applicant]");
  if (blockBtn) {
    event.preventDefault();
    const caseId = blockBtn.dataset.caseId || "";
    const paralegalId = blockBtn.dataset.paralegalId || "";
    const paralegalName = blockBtn.dataset.paralegalName || "Applicant";
    if (!caseId || !paralegalId) return;
    const drawerEl = blockBtn.closest("[data-applicants-drawer]");
    void blockApplicantFromCase(caseId, paralegalId, paralegalName, drawerEl);
    return;
  }
  const preEngagementActionBtn = event.target.closest("[data-preengagement-review-action]");
  if (preEngagementActionBtn) {
    event.preventDefault();
    const caseId = preEngagementActionBtn.dataset.caseId || "";
    const paralegalId = preEngagementActionBtn.dataset.paralegalId || "";
    const action = preEngagementActionBtn.dataset.preengagementReviewAction || "";
    if (!caseId || !paralegalId || !action) return;
    void reviewApplicantPreEngagement(caseId, paralegalId, action, preEngagementActionBtn);
    return;
  }
  const applicantRow = event.target.closest("[data-applicant-row]");
  if (applicantRow && !event.target.closest("a")) {
    const caseId = applicantRow.dataset.caseId || "";
    const index = Number(applicantRow.dataset.applicantIndex || 0);
    const drawerEl = applicantRow.closest("[data-applicants-drawer]");
    showApplicantDetail(caseId, index, drawerEl);
    return;
  }
  const trigger = event.target.closest("[data-case-menu-trigger]");
  if (trigger) {
    const parent = trigger.closest(".case-actions");
    if (parent) {
      const show = !parent.classList.contains("open");
      toggleCaseMenu(parent, show);
    }
    return;
  }
  const actionBtn = event.target.closest("[data-case-action]");
  if (actionBtn) {
    const caseId = actionBtn.dataset.caseId;
    toggleCaseMenu(actionBtn.closest(".case-actions"), false);
    handleCaseAction(actionBtn.dataset.caseAction, caseId);
  }
}

function onArchivedSelectionChange(event) {
  const toggleAll = event.target.closest("[data-archived-select-all]");
  if (toggleAll) {
    const checked = toggleAll.checked;
    document.querySelectorAll('[data-table-body="archived"] [data-archived-select]').forEach((box) => {
      box.checked = checked;
      const id = box.value;
      if (!id) return;
      if (checked) state.archivedSelection.add(String(id));
      else state.archivedSelection.delete(String(id));
    });
    syncArchivedBulkUI();
    return;
  }

  const checkbox = event.target.closest("[data-archived-select]");
  if (!checkbox) return;
  const caseId = checkbox.value;
  if (!caseId) return;
  if (checkbox.checked) state.archivedSelection.add(String(caseId));
  else state.archivedSelection.delete(String(caseId));
  syncArchivedBulkUI();
}

function onDraftSelectionChange(event) {
  const toggleAll = event.target.closest("[data-draft-select-all]");
  if (toggleAll) {
    const checked = toggleAll.checked;
    document.querySelectorAll('[data-table-body="draft"] [data-draft-select]').forEach((box) => {
      box.checked = checked;
      const id = box.value;
      if (!id) return;
      if (checked) state.draftSelection.add(String(id));
      else state.draftSelection.delete(String(id));
    });
    syncDraftBulkUI();
    return;
  }

  const checkbox = event.target.closest("[data-draft-select]");
  if (!checkbox) return;
  const caseId = checkbox.value;
  if (!caseId) return;
  if (checkbox.checked) state.draftSelection.add(String(caseId));
  else state.draftSelection.delete(String(caseId));
  syncDraftBulkUI();
}

async function onDraftBulkAction(event) {
  const btn = event.target.closest("[data-draft-bulk]");
  if (!btn) return;
  const action = btn.dataset.draftBulk;
  const ids = Array.from(state.draftSelection);
  if (!ids.length) return;
  try {
    if (action === "delete") {
      const confirmed = await confirmAction("This cannot be undone.", {
        title: `Delete ${ids.length} draft${ids.length === 1 ? "" : "s"}?`,
        confirmLabel: ids.length === 1 ? "Delete draft" : "Delete drafts",
        tone: "danger",
      });
      if (!confirmed) return;
      for (const id of ids) {
        await removeLocalDraft(id, { skipConfirm: true });
      }
      notifyCases("Drafts deleted.", "success");
    }
    state.draftSelection.clear();
    renderCasesView();
  } catch (err) {
    console.error(err);
    notifyCases(err.message || "Bulk action failed.", "error");
  }
}

async function onArchivedBulkAction(event) {
  const btn = event.target.closest("[data-archived-bulk]");
  if (!btn) return;
  const action = btn.dataset.archivedBulk;
  const ids = Array.from(state.archivedSelection);
  if (!ids.length) return;
  try {
    if (action === "download") {
      await openCaseNoteModal(ids[0], "export", ids);
    } else if (action === "delete") {
      const deletableIds = ids.filter((id) => canDeleteCase(getCaseEntryById(id)));
      if (deletableIds.length !== ids.length) {
        syncArchivedBulkUI();
        notifyCases("Some selected Matters can no longer be deleted.", "error");
        return;
      }
      const confirmed = await confirmAction("This permanently removes the selected Matter records and cannot be undone.", {
        title: `Delete ${deletableIds.length} Matter${deletableIds.length === 1 ? "" : "s"}?`,
        confirmLabel: deletableIds.length === 1 ? "Delete Matter" : "Delete Matters",
        tone: "danger",
      });
      if (!confirmed) return;
      for (const id of deletableIds) {
        await deleteArchivedCase(id, { skipConfirm: true, silent: true });
      }
      notifyCases("Matters deleted.", "success");
    }
    state.archivedSelection.clear();
    await loadArchivedCases(true);
    renderCasesView();
  } catch (err) {
    console.error(err);
    notifyCases(err.message || "Bulk action failed.", "error");
  }
}

function positionCaseMenu(wrapper) {
  const trigger = wrapper?.querySelector("[data-case-menu-trigger]");
  const menu = wrapper?.querySelector(".case-menu");
  if (!trigger || !menu) return;

  const rect = trigger.getBoundingClientRect();
  menu.style.minWidth = "0";
  menu.style.width = "min(18rem, calc(100vw - 16px))";
  menu.style.visibility = "hidden";
  menu.style.display = "block";
  menu.style.position = "fixed";
  menu.style.zIndex = "10000";

  const menuRect = menu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const gutter = 8;
  const gap = 6;

  let left = rect.right - menuRect.width;
  left = Math.max(gutter, Math.min(left, viewportWidth - menuRect.width - gutter));

  let top = rect.bottom + gap;
  if (top + menuRect.height > viewportHeight - gutter) {
    top = rect.top - menuRect.height - gap;
    if (top < gutter) {
      top = Math.max(gutter, viewportHeight - menuRect.height - gutter);
    }
  }

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "visible";
}

function toggleCaseMenu(wrapper, show) {
  if (!wrapper) return;
  if (show) {
    if (openCaseMenu && openCaseMenu !== wrapper) {
      openCaseMenu.classList.remove("open");
      openCaseMenu.querySelector(".menu-trigger")?.setAttribute("aria-expanded", "false");
      resetCaseMenuStyles(openCaseMenu);
    }
    wrapper.classList.add("open");
    const trigger = wrapper.querySelector(".menu-trigger");
    trigger?.setAttribute("aria-expanded", "true");
    openCaseMenuTrigger = trigger || null;
    positionCaseMenu(wrapper);
    openCaseMenu = wrapper;
  } else {
    wrapper.classList.remove("open");
    wrapper.querySelector(".menu-trigger")?.setAttribute("aria-expanded", "false");
    resetCaseMenuStyles(wrapper);
    if (openCaseMenu === wrapper) openCaseMenu = null;
    if (!openCaseMenu) openCaseMenuTrigger = null;
  }
}

function resetCaseMenuStyles(wrapper) {
  const menu = wrapper?.querySelector(".case-menu");
  if (!menu) return;
  menu.style.top = "";
  menu.style.left = "";
  menu.style.position = "";
  menu.style.zIndex = "";
  menu.style.display = "";
  menu.style.visibility = "";
}

async function handleCaseAction(action, caseId) {
  if (action === "application-review") { await openCaseNoteModal(caseId, "applications"); return; }
  if (!caseId) return;
  try {
    if (action === "resume-draft") {
      window.location.href = currentDraftEditorHref(caseId);
      return;
    } else if (action === "discard-draft") {
      await removeLocalDraft(caseId);
      renderCasesView();
      return;
    } else if (action === "view") {
      await openCasePreview(caseId);
      return;
    } else if (action === "details") {
      if (window.LPCContextPanel?.openMatter?.(caseId, { historyMode: "push" })) return;
      await openCasePreview(caseId);
    } else if (action === "open-case-detail") {
      const entry = state.caseLookup.get(String(caseId));
      if (shouldOpenCasePreviewOnly(entry)) {
        await openCasePreview(caseId);
        return;
      }
      window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
    } else if (action === "workspace") {
      const entry = state.caseLookup.get(String(caseId));
      if (shouldOpenCasePreviewOnly(entry)) {
        await openCasePreview(caseId);
        return;
      }
      if (!isWorkspaceEligibleCase(entry)) {
        notifyCases("Workspace unlocks after a paralegal is hired and the Matter is funded.", "info");
        return;
      }
      window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
    } else if (action === "view-invited") {
      await openCaseInvites(caseId);
    } else if (action === "messages") {
      const entry = state.caseLookup.get(String(caseId));
      if (!isWorkspaceEligibleCase(entry)) {
        notifyCases("Messaging unlocks after a paralegal is hired and Stripe is funded.", "info");
        return;
      }
      goToMessages(caseId);
    } else if (action === "edit-case") {
      window.location.href = `create-case.html?caseId=${encodeURIComponent(caseId)}#details`;
      return;
    } else if (action === "status-history") {
      await openStatusHistoryModal(caseId);
      return;
    } else if (action === "edit-note") {
      openCaseNoteModal(caseId);
      return;
    } else if (action === "flag-resolved") {
      await openCaseNoteModal(caseId, "review");
      return;
    } else if (action === "download") {
      await openCaseNoteModal(caseId, "downloads");
      return;
    } else if (action === "download-receipt") {
      await openCaseNoteModal(caseId, "receipt");
      return;
    } else if (action === "download-archive") {
      await openCaseNoteModal(caseId, "export");
    } else if (action === "archive" || action === "restore" || action === "archive-status") {
      await openCaseNoteModal(caseId, "archive");
      return;
    } else if (action === "delete-case") {
      const entry = getCaseEntryById(caseId);
      if (!canDeleteCase(entry)) {
        notifyCases("This matter can no longer be deleted.", "info");
        return;
      }
      await deleteArchivedCase(caseId);
      renderCasesView();
    }
  } catch (err) {
    console.error(err);
    notifyCases(err.message || "Unable to complete that action.", "error");
  }
}

const pendingMatterDeletions = new Set();
async function deleteArchivedCase(caseId, { skipConfirm = false, silent = false } = {}) {
  if (!caseId) return;
  const key = String(caseId), ownerId = String(state.user?.id || state.user?._id || "");
  if (pendingMatterDeletions.has(key)) throw new Error("Deletion is already being checked for this Matter.");
  pendingMatterDeletions.add(key);
  try {
    if (!skipConfirm) {
      const title = getCaseEntryById(key)?.title || "Untitled Matter";
      const confirmed = await confirmAction(`Permanently remove “${title}”? This cannot be undone.`, {
        title: "Delete this Matter?", confirmLabel: "Delete Matter", tone: "danger",
      });
      if (!confirmed) return;
    }
    if (!ownerId || await verifyCaseNoteOwner() !== ownerId) throw new Error("Your account changed. Reload Matters before continuing.");
    let response, payload;
    try {
      response = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: "DELETE", body: { expectedOwnerId: ownerId }, headers: { Accept: "application/json" },
      });
      payload = response.status === 204 ? null : await response.json().catch(() => null);
    } catch {
      throw new Error("Deletion was not confirmed. Reload Matters to check before trying again.");
    }
    // A failed or unreadable acknowledgement may follow a committed deletion.
    // Never retry the mutation, or infer success from absence in a partial list.
    if (!response.ok || (response.status !== 204 && payload?.ok !== true)) {
      throw new Error(!response.ok && typeof payload?.error === "string" ? payload.error : "Deletion was not confirmed. Reload Matters to check before trying again.");
    }
    if (await verifyCaseNoteOwner() !== ownerId) throw new Error("Your account changed. Reload Matters before continuing.");
    removeCaseFromState(caseId);
    // A confirmed deletion belongs to this account. Follow-up list reads must
    // not delay its acknowledgement.
    if (!silent) notifyCases("Matter deleted.", "success");
    if (currentMatterInventory) await loadCurrentMatters({ force: true });
    if (currentDraftInventory) await loadCaseDrafts({ force: true });
  } catch (error) {
    if (error?.message === "account_changed") throw new Error("Your account changed. Reload Matters before continuing.");
    throw error;
  } finally { pendingMatterDeletions.delete(key); }
}

function removeCaseFromState(caseId) {
  const id = String(caseId);
  const prune = (list) => {
    const idx = list.findIndex((item) => String(item.id) === id);
    if (idx >= 0) list.splice(idx, 1);
  };
  prune(state.cases);
  prune(state.casesArchived);
  state.caseLookup.delete(id);
  state.archivedSelection?.delete(id);
  buildCaseLookup();
}

function formatCaseStatus(status) {
  if (!status) return "Posted";
  const key = normalizeCaseStatus(status);
  return CASE_STATUS_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getStatusClass(status) {
  if (!status) return "public";
  const key = normalizeCaseStatus(status);
  return CASE_STATUS_CLASSES[key] || "public";
}

function formatCaseDate(value) {
  if (!value) return "—";
  const businessDate = window.LPCBusinessDate?.format(value);
  if (businessDate) return businessDate;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function resolveCaseBudgetCents(item) {
  return Number(
    item?.remainingAmount ??
      item?.lockedTotalAmount ??
      item?.totalAmount ??
      item?.paymentAmount ??
      item?.budget ??
      0
  );
}

function isDisputeWindowActiveCase(item) {
  if (!item?.disputeDeadlineAt) return false;
  const deadline = new Date(item.disputeDeadlineAt).getTime();
  if (Number.isNaN(deadline)) return false;
  return Date.now() < deadline;
}

function isRelistedCase(item) {
  const statusKey = normalizeCaseStatus(item?.status);
  return statusKey === "paused" && !!item?.relistRequestedAt;
}

function isRelistHireLocked(item) {
  if (!isRelistedCase(item)) return false;
  if (!item?.payoutFinalizedAt) return true;
  return !!item?.relistPending || isDisputeWindowActiveCase(item);
}

function canHireForCase(item) {
  if (!item || item.readOnly) return false;
  if (hasAssignedParalegal(item)) return false;
  const statusKey = normalizeCaseStatus(item?.status);
  const isOpen = statusKey === "open";
  const relisted = isRelistedCase(item);
  if (!isOpen && !relisted) return false;
  if (relisted && isRelistHireLocked(item)) return false;
  const amountCents = resolveCaseBudgetCents(item);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return false;
  return true;
}

function formatCaseAmount(item) {
  const cents = resolveCaseBudgetCents(item);
  if (!Number.isFinite(cents) || cents <= 0) return "—";
  return formatCurrency(cents);
}

function notifyCases(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  } else {
    void showAlert(message, { title: type === "error" ? "Action unavailable" : "Notice" });
  }
}



function notifyTasks(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  } else {
    void showAlert(message, { title: type === "error" ? "Action unavailable" : "Notice" });
  }
}

// -------------------------
// Shared Helpers
// -------------------------
function normalizeCaseStatus(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "in_progress") return "in progress";
  if (["cancelled", "canceled"].includes(lower)) return "closed";
  if (["assigned", "awaiting_funding"].includes(lower)) return "open";
  if (["active", "awaiting_documents", "reviewing"].includes(lower)) return "in progress";
  return lower;
}

function isFinalCase(caseItem) {
  if (!caseItem) return false;
  if (caseItem.paymentReleased === true) return true;
  const status = normalizeCaseStatus(caseItem?.status);
  return status === "completed";
}



function hasAssignedParalegal(caseItem) {
  if (!caseItem) return false;
  return !!(caseItem?.paralegal || caseItem?.paralegalId);
}

function canDeleteCase(caseItem) {
  if (!caseItem) return false;
  const statusKey = normalizeCaseStatus(caseItem?.status);
  if (statusKey !== "open") return false;
  if (hasAssignedParalegal(caseItem) || caseItem?.hiredAt) return false;
  const escrowStatus = String(caseItem?.escrowStatus || "").toLowerCase();
  const hasFinancialHistory = Boolean(
    escrowStatus === "funded" ||
    caseItem?.escrowIntentId ||
    caseItem?.paymentIntentId ||
    caseItem?.paymentReleased ||
    caseItem?.payoutTransferId ||
    caseItem?.payoutFinalizedAt
  );
  if (hasFinancialHistory) return false;
  if (Array.isArray(caseItem?.disputes) && caseItem.disputes.length) return false;
  return true;
}

function isTerminalCase(caseItem) {
  if (!caseItem) return false;
  if (caseItem.paymentReleased === true) return true;
  const status = normalizeCaseStatus(caseItem?.status);
  return TERMINAL_CASE_STATUSES.has(status);
}

function isArchivedBucketCase(caseItem) {
  if (!caseItem || caseItem.localDraft) return false;
  if (caseItem.archived === true) return true;
  const status = normalizeCaseStatus(caseItem?.status);
  if (status === "paused") {
    const relisted =
      !!caseItem?.relistRequestedAt ||
      (!!caseItem?.payoutFinalizedAt && AUTO_RELIST_TYPES.has(String(caseItem?.payoutFinalizedType || "")));
    if (relisted) return false;
    return true;
  }
  return isTerminalCase(caseItem);
}

function shouldOpenCasePreviewOnly(caseItem, { filterKey = state.casesViewFilter || "" } = {}) {
  if (!caseItem || caseItem.localDraft) return false;
  if (filterKey === "archived") return true;
  return isArchivedBucketCase(caseItem) || caseItem.archived === true;
}



function isWorkspaceEligibleCase(caseItem) {
  if (!caseItem) return false;
  if (caseItem.archived !== false) return false;
  if (caseItem.paymentReleased !== false) return false;
  const status = normalizeCaseStatus(caseItem?.status);
  if (status === "open" || status === "draft") return false;
  if (!status || !FUNDED_WORKSPACE_STATUSES.has(status)) return false;
  const escrowFunded =
    !!caseItem?.escrowIntentId && String(caseItem?.escrowStatus || "").toLowerCase() === "funded";
  if (!escrowFunded) return false;
  return hasAssignedParalegal(caseItem);
}

function canOpenCaseDetail(caseItem) {
  if (!caseItem) return false;
  const status = normalizeCaseStatus(caseItem?.status);
  if (status === "paused" || status === "disputed") {
    return String(caseItem?.pausedReason || "") === "paralegal_withdrew";
  }
  return isWorkspaceEligibleCase(caseItem);
}



async function loadCasesWithFiles(force = false, { refreshInventories = true } = {}) {
  if (force) state.casesPromise = null;
  if (state.casesPromise) {
    await state.casesPromise;
    return state.cases;
  }
  const url = "/api/cases/my?withFiles=true&limit=100&archived=false";
  state.casesPromise = (async () => {
    try {
      const res = await secureFetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("Matter fetch failed");
      const data = await res.json();
      state.cases = Array.isArray(data) ? data : [];
      buildCaseLookup();
      if (force && refreshInventories && currentDraftInventory) await loadCaseDrafts({ force: true });
      applyApplicationCountsToCases({ render: dashboardViewState.casesInitialized });
    } catch (err) {
      console.error(err);
      state.cases = [];
    } finally {
      if (force && refreshInventories && currentMatterInventory) await loadCurrentMatters({ force: true });
      state.casesPromise = null;
    }
    return state.cases;
  })();
  return state.casesPromise;
}

function buildCaseLookup() {
  state.caseLookup.clear();
  const combined = [...(state.cases || []), ...(state.casesArchived || []), ...(currentDraftInventory?.state.result?.items.filter(item => !item.localDraft) || []), ...(currentMatterInventory?.state.result?.items || [])];
  combined.forEach((c) => {
    const primaryId = parseCaseId(c);
    if (primaryId) state.caseLookup.set(String(primaryId), c);
    if (c.id) state.caseLookup.set(String(c.id), c);
    if (c._id) state.caseLookup.set(String(c._id), c);
  });
}

async function removeApplicantFromCase(caseId, paralegalId, drawerEl) {
  const confirmed = await confirmAction(
    "They will be notified and unable to reapply unless this Matter is relisted.",
    { title: "Remove this applicant?", confirmLabel: "Remove applicant", tone: "danger" }
  );
  if (!confirmed) return;
  try {
    await secureFetch(
      `/api/cases/${encodeURIComponent(caseId)}/applicants/${encodeURIComponent(paralegalId)}/reject`,
      { method: "POST", body: {} }
    );
    notifyCases("Applicant removed.", "success");
    if (drawerEl) {
      await loadApplicantsForDrawer(caseId, drawerEl);
    }
    await loadCasesWithFiles(true);
    await loadArchivedCases(true);
    const cachedApplicants = applicantDrawerCache.get(caseId) || [];
    const visibleCount = cachedApplicants.filter(
      (entry) => !["accepted", "rejected", "withdrawn"].includes(entry.status)
    ).length;
    updateCaseApplicantCount(caseId, visibleCount);
    renderCasesView();
  } catch (err) {
    notifyCases(err?.message || "Unable to remove applicant.", "error");
  }
}

async function blockApplicantFromCase(caseId, paralegalId, paralegalName, drawerEl) {
  const confirmed = await confirmAction(
    "They will no longer be able to apply, be invited, be hired, or message you. They will not be notified.",
    {
      title: `Block ${paralegalName || "this applicant"}?`,
      confirmLabel: "Block applicant",
      tone: "danger",
    }
  );
  if (!confirmed) return;
  try {
    await secureFetch("/api/blocks", {
      method: "POST",
      body: { caseId, paralegalId },
    });
    notifyCases("Applicant blocked from future interaction.", "success");
    if (drawerEl) {
      await loadApplicantsForDrawer(caseId, drawerEl);
    }
    await loadCasesWithFiles(true);
    await loadArchivedCases(true);
    const cachedApplicants = applicantDrawerCache.get(caseId) || [];
    const visibleCount = cachedApplicants.filter(
      (entry) => !["accepted", "rejected", "withdrawn"].includes(entry.status)
    ).length;
    updateCaseApplicantCount(caseId, visibleCount);
    renderCasesView();
  } catch (err) {
    notifyCases(err?.message || "Unable to block applicant.", "error");
  }
}

function toggleModal(modal, show) {
  if (!modal) return;
  modal.classList.toggle("hidden", !show);
  modal.setAttribute("aria-hidden", show ? "false" : "true");
  if (show) {
    modal.removeAttribute("inert");
    const initialFocus =
      modal.querySelector("[autofocus]") ||
      modal.querySelector("input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])");
    activateDialogFocus(modal, {
      initialFocus,
      onEscape: () => toggleModal(modal, false),
    });
    return;
  }
  modal.setAttribute("inert", "");
  deactivateDialogFocus(modal);
}

function sanitize(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeUrl(rawUrl, { requiredHost = "" } = {}) {
  const required = String(requiredHost || "").trim().toLowerCase();
  return normalizeHttpNavigationUrl(rawUrl, {
    allowedHosts: required ? [required] : [],
    allowSubdomains: Boolean(required),
  });
}

function formatCurrency(amountCents = 0) {
  const dollars = Number(amountCents || 0) / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function fetchApplicationsForMyJobs() {
  const ownerId = String(state.user?.id || state.user?._id || "");
  return caseNoteApi.readReceivedApplications({ ownerId });
}

async function loadApplicationsForMyJobs({ force = false, refreshInventory = true } = {}) {
  if (caseNoteOwnerId) {
    const result = await (applicationParentPromise || refreshApplicationParent(caseNoteOwnerId, "", { refreshInventory }));
    if (!Array.isArray(result)) throw new Error("Unable to refresh applications");
    return result;
  }
  if (force) applicationsPromise = null;
  if (applicationsPromise) return applicationsPromise;
  const ticket = ++applicationsReadEpoch;
  const pending = (async () => {
    const apps = await fetchApplicationsForMyJobs();
    if (ticket !== applicationsReadEpoch) return applicationsCache;
    if (!Array.isArray(apps)) throw new Error('Unable to load applications');
    applicationsCache = apps;
    applyApplicationsToCases(applicationsCache);
    return applicationsCache;
  })().finally(() => {
    if (applicationsPromise === pending) applicationsPromise = null;
  });
  applicationsPromise = pending;
  return pending;
}

function extractCaseIdFromApplication(app = {}) {
  const candidate =
    app.caseId ||
    app.caseID ||
    app.case_id ||
    app.case ||
    app.caseRef ||
    app.caseDoc;
  if (!candidate) return "";
  if (typeof candidate === "object") {
    return String(candidate.id || candidate._id || candidate.caseId || candidate.toString?.() || "");
  }
  return String(candidate);
}

function applyApplicationsToCases(apps = []) {
  if (!Array.isArray(apps)) return;
  caseApplicationCounts.clear();
  state.cases.forEach(item => { const caseId = parseCaseId(item); if (caseId) caseApplicationCounts.set(String(caseId), 0); });
  apps.forEach((app) => {
    const caseId = extractCaseIdFromApplication(app);
    if (!caseId) return;
    caseApplicationCounts.set(caseId, (caseApplicationCounts.get(caseId) || 0) + 1);
  });
  applyApplicationCountsToCases({ render: true });
}

function applyApplicationCountsToCases({ render = false } = {}) {
  if (!caseApplicationCounts.size || !Array.isArray(state.cases)) return;
  let didChange = false;
  state.cases.forEach((caseItem) => {
    const caseId = String(caseItem?.id || caseItem?._id || caseItem?.caseId || "");
    if (!caseId || !caseApplicationCounts.has(caseId)) return;
    const nextCount = caseApplicationCounts.get(caseId);
    const currentCount = Number(
      caseItem.applicantsCount ??
        (Array.isArray(caseItem.applicants) ? caseItem.applicants.length : caseItem.applicants) ??
        0
    );
    if (currentCount !== nextCount) {
      didChange = true;
      caseItem.applicantsCount = nextCount;
    }
  });
  // Complete inventories own their rows and counts; Home summary reconciliation
  // must not replace an independently loaded list or detach its open controls.
  if (render && didChange && dashboardViewState.casesInitialized && !currentMatterInventory && !currentDraftInventory) {
    renderCasesView();
    restoreApplicantDrawerFromQuery();
  }
}

function pluralizeCount(count, singular, plural = `${singular}s`) {
  const safeCount = Number(count || 0);
  return `${safeCount} ${safeCount === 1 ? singular : plural}`;
}

function buildNeedsAttentionItems() {
  const items = [];
  const progress = getAttorneyOnboardingProgress();
  const onboardingGuidanceActive =
    onboardingAttentionHydrated &&
    !isAttorneyOnboardingDismissed() &&
    Boolean(getNextOnboardingStep(progress));
  const hasAnyMatter =
    Number(overviewSignals.casesCreatedCount || 0) > 0;

  if (!onboardingGuidanceActive && state.billing.hasPaymentMethod === false) {
    items.push({
      key: "payment",
      title: "Add a payment method",
      meta: "Keep a card ready to fund a Matter when you hire.",
      actionLabel: "Open payments",
      href: "#funds",
      viewTarget: "funds",
    });
  }

  if (overviewSignals.overdueCount > 0) {
    items.push({
      key: "overdue",
      title: `${pluralizeCount(overviewSignals.overdueCount, "overdue task")}`,
      meta: "",
      actionLabel: "Open tasks",
      href: "#tasks",
      viewTarget: "tasks",
    });
  }

  if (!onboardingGuidanceActive && !progress.profileDone) {
    items.push({
      key: "profile",
      title: "Finish your attorney profile",
      meta: "A complete profile gives paralegals better context before accepting work.",
      actionLabel: "Open profile",
      href: "profile-settings.html?onboardingStep=profile&profilePrompt=1",
    });
  }

  if (!onboardingGuidanceActive && legacyHome?.state.inventory.phase === "ready" && !hasAnyMatter && progress.profileDone && state.billing.hasPaymentMethod === true) {
    items.push({
      key: "first-matter",
      title: "Post your first matter",
      meta: "Create a scoped matter so approved paralegals can apply or be invited.",
      actionLabel: "Create matter",
      href: "create-case.html",
    });
  }

  const unavailable = Object.entries(legacyHome?.state || {}).filter(([key, source]) => key !== "inventory" && (source.phase !== "ready" || key === "messages" && source.value.mismatch));
  if (unavailable.length) items.push({ key: "unavailable", title: unavailable.some(([, source]) => source.phase === "loading") ? "Checking remaining items…" : "Some Home items could not be verified", actionLabel: "Refresh Home", action: "refresh" });
  return items;
}

function renderNeedsAttentionQueue() {
  const shell = document.getElementById("attorneyNeedsAttention");
  const list = document.getElementById("attorneyNeedsAttentionList");
  if (!shell || !list || !legacyHome) return;
  if (caseNoteModalRef && !caseNoteModalRef.classList.contains("hidden") && !Object.values(legacyHome.state).every(source => source.phase === "failed")) { homeAttentionRefreshDeferred = true; return; }
  const focused = list.contains(document.activeElement) ? { text: document.activeElement.textContent, href: document.activeElement.getAttribute("href"), matterId: document.activeElement.closest("[data-home-attention]")?.dataset.homeAttention } : null;
  const items = buildNeedsAttentionItems();
  const matterNodes = legacyHome?.attentionNodes() || [];
  const hasMatterItems = matterNodes.length > 0;
  const progress = getAttorneyOnboardingProgress();
  const onboardingGuidanceActive =
    !isAttorneyOnboardingDismissed() && Boolean(getNextOnboardingStep(progress));
  if (!items.length && !hasMatterItems && onboardingGuidanceActive) {
    shell.hidden = true;
    shell.setAttribute("aria-hidden", "true");
    list.textContent = "";
    return;
  }
  shell.hidden = false;
  shell.setAttribute("aria-hidden", "false");

  if (!items.length && !hasMatterItems) {
    list.innerHTML = `
      <div class="queue-item">
        <div>
          <div class="queue-title">All clear</div>

        </div>
        <a class="queue-action" href="create-case.html">New matter</a>
      </div>
    `;
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const title = sanitize(item.title || "Review item");
      const meta = sanitize(item.meta || "");
      const label = sanitize(item.actionLabel || "Open");
      const actionMarkup = item.href
        ? `<a class="queue-action" href="${sanitize(item.href)}"${item.viewTarget ? ` data-view-target="${sanitize(item.viewTarget)}"` : ""}>${label}</a>`
        : item.action
          ? `<button class="queue-action" type="button" data-attention-action="${sanitize(item.action)}">${label}</button>`
          : `<span class="queue-action" aria-disabled="true">Unavailable</span>`;
      return `
        <div class="queue-item" data-attention-item="${sanitize(item.key || "")}">
          <div>
            <div class="queue-title">${title}</div>
            ${meta ? `<div class="queue-meta">${meta}</div>` : ""}
          </div>
          ${actionMarkup}
        </div>
      `;
    })
    .join("");
  list.append(...matterNodes);
  if (focused && document.activeElement === document.body) {
    const replacement = Array.from(list.querySelectorAll("a,button")).find(element => element.textContent === focused.text && element.getAttribute("href") === focused.href && element.closest("[data-home-attention]")?.dataset.homeAttention === focused.matterId);
    const target = replacement || document.getElementById("attorneyNeedsAttentionTitle");
    if (target) { if (!replacement) target.tabIndex = -1; target.focus(); }
  }
}

async function refreshApplicationsOverview({ force = false } = {}) {
  await loadApplicationsForMyJobs({ force, refreshInventory: false });
  await legacyHome?.refresh(["applications", "inventory", "payment"]);
  // A person may have opened a panel while these background reads were pending.
  // Keep that interaction intact, then apply the coalesced update after it closes.
  if (deferApplicationAutoRefresh()) return false;
  if (force) await Promise.all([
    currentDraftInventory?.state.phase === 'ready' ? loadCaseDrafts({ force: true }) : null,
    currentMatterInventory?.state.phase === 'ready' ? loadCurrentMatters({ force: true }) : null,
  ]);
  return true;
}

function initHomeTabs() {
  if (homeTabsBound) return;
  const tabs = Array.from(document.querySelectorAll("[data-home-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-home-panel]"));
  if (!tabs.length || !panels.length) return;
  homeTabsBound = true;
  const panelMap = new Map(panels.map((panel) => [panel.dataset.homePanel, panel]));

  const activate = (key) => {
    tabs.forEach((tab) => {
      const isActive = tab.dataset.homeTab === key;
      tab.classList.toggle("active", isActive);
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    panelMap.forEach((panel, panelKey) => {
      panel.hidden = panelKey !== key;
    });
  };

  const defaultKey =
    tabs.find((tab) => tab.classList.contains("active"))?.dataset.homeTab || tabs[0].dataset.homeTab;
  activate(defaultKey);

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.homeTab;
      if (key) activate(key);
    });
  });
}

function updateMessagePreviewUI({
  threads = [],
  messageSnippet,
  messagePreviewSender,
  messagePreviewText,
  eligibleCaseIds,
}) {
  const latestMessageSection = document.getElementById("latestMessagePreview");
  const scopedThreads = eligibleCaseIds
    ? threads.filter((thread) => {
        const id = thread?.caseId || thread?.case?.id || thread?.id || "";
        return id && eligibleCaseIds.has(String(id));
      })
    : threads;
  const nextThread = scopedThreads.find((t) => (t.unread || 0) > 0);
  if (!nextThread) {
    if (messageSnippet) messageSnippet.textContent = "No unread messages.";
    if (messagePreviewSender) messagePreviewSender.textContent = "Inbox";
    if (messagePreviewText) messagePreviewText.textContent = "";
    if (latestMessageSection) latestMessageSection.hidden = true;
    state.latestThreadId = null;
    state.latestThreadCaseId = null;
    return;
  }
  if (latestMessageSection) latestMessageSection.hidden = false;
  const rawSnippet = nextThread.lastMessageSnippet || "Open thread.";
  const cleanedSnippet = String(rawSnippet).replace(/\s+/g, " ").trim();
  const snippet =
    cleanedSnippet.length > 120 ? `${cleanedSnippet.slice(0, 120).trim()}…` : cleanedSnippet;
  if (messageSnippet) messageSnippet.textContent = snippet;
  if (messagePreviewSender) messagePreviewSender.textContent = nextThread.title || "Matter thread";
  if (messagePreviewText) messagePreviewText.textContent = ` – ${snippet}`;
  const threadId = nextThread.id || null;
  const threadCaseId = nextThread.caseId || nextThread.case?.id || threadId || null;
  state.latestThreadId = threadId;
  state.latestThreadCaseId = threadCaseId;
}

function renderEscrowPanel(container) {
  if (!container) return;
  const billingHref = "#funds";
  container.innerHTML = `
    <div class="info-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;">
      <a class="pill-btn primary" href="${billingHref}" data-view-target="funds">Open Payments</a>
    </div>
  `;
}

async function handleHireFromApplications({ caseId, paralegalId }) {
  await openCaseNoteModal(caseId, "hiring", null, paralegalId);
}
