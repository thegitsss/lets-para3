import { secureFetch, logout, loadUserHeaderInfo } from "./auth.js";
import { scanNotificationCenters } from "./utils/notifications.js";
import { initCaseFilesView } from "./case-files-view.js";

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
const STATUS_LABELS = {
  pending_review: "Pending Review",
  approved: "Approved",
  attorney_revision: "Attorney Revisions",
};
const MISSING_DOCUMENT_MESSAGE = "This document is no longer available for download.";
const CASE_VIEW_FILTERS = ["active", "draft", "archived", "inquiries"];
const CASE_FILE_MAX_BYTES = 20 * 1024 * 1024;
const PLATFORM_FEE_PCT = 22;
const HOME_PAGE_SIZE = 5;
const FUNDED_WORKSPACE_STATUSES = new Set([
  "in progress",
  "in_progress",
]);
const TERMINAL_CASE_STATUSES = new Set(["completed", "closed"]);
const CASE_PREVIEW_STORAGE_KEY = "lpc_case_preview_id";
const CASE_PREVIEW_RECEIPT_KEY = "lpc_case_preview_receipt";
const PARALEGAL_AVATAR_FALLBACK = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220' viewBox='0 0 220 220'><rect width='220' height='220' rx='110' fill='#f1f5f9'/><circle cx='110' cy='90' r='46' fill='#cbd5e1'/><path d='M40 188c10-40 45-68 70-68s60 28 70 68' fill='none' stroke='#cbd5e1' stroke-width='18' stroke-linecap='round'/></svg>"
)}`;
const ATTORNEY_AVATAR_FALLBACK = PARALEGAL_AVATAR_FALLBACK;
function getProfileImageUrl(user = {}) {
  const role = String(user.role || "").toLowerCase();
  const pending = role === "paralegal" ? user.pendingProfileImage : "";
  const stored = user.profileImage || user.avatarURL;
  if (pending) return pending;
  if (stored) return stored;
  return role === "paralegal" ? PARALEGAL_AVATAR_FALLBACK : ATTORNEY_AVATAR_FALLBACK;
}

const INVITE_AVATAR_FALLBACK = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'><defs><linearGradient id='g' x1='0%' y1='0%' x2='100%' y2='100%'><stop offset='0%' stop-color='#f4f4f5'/><stop offset='100%' stop-color='#e5e7eb'/></linearGradient></defs><rect width='96' height='96' rx='48' fill='url(#g)'/><circle cx='48' cy='38' r='18' fill='#d1d5db'/><path d='M20 84c6-18 22-28 28-28s22 10 28 28' fill='none' stroke='#cbd5e1' stroke-width='6' stroke-linecap='round'/></svg>"
)}`;

const overviewSignals = {
  unreadCount: 0,
  unfundedCount: 0,
  casesCreatedCount: 0,
  completedCasesCount: 0,
  pendingReviewCount: 0,
  overdueCount: 0,
  applicationsCount: 0,
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
  reviewSelection: null,
  uploadSelection: null,
  caseFilter: "all",
  tasks: [],
  latestThreadId: null,
  latestThreadCaseId: null,
  threadOverview: new Map(),
  billing: {
    summary: null,
    posted: [],
    postedMap: new Map(),
    escrows: [],
    history: [],
    spendingChart: null,
    jobChart: null,
    completedCount: 0,
    editJobId: null,
    demoLoaded: false,
    hasPaymentMethod: null,
  },
  messages: {
    cases: [],
    summary: new Map(),
    messagesByCase: new Map(),
    activeCaseId: null,
    activeThreadId: "all",
    sending: false,
  },
  documents: {
    activeTab: "templates",
    activeDocId: null,
    sort: "date",
    replaceTarget: null,
  },
  caseFiles: {
    selectedCaseId: null,
    files: [],
    loading: false,
    error: "",
  },
  archivedSelection: new Set(),
  archiveHighlightCaseId: null,
  archiveHighlightApplied: false,
  simpleMessages: {
    cases: [],
    unread: new Map(),
    activeCaseId: null,
    messagesByCase: new Map(),
    lastIds: new Map(),
    pollTimer: null,
  },
  localDrafts: [],
};

const ATTORNEY_ONBOARDING_STEP_KEY = "lpc_attorney_onboarding_step";
const ATTORNEY_ONBOARDING_MODAL_SEEN_KEY = "lpc_attorney_onboarding_modal_seen_case";
let onboardingChecklistApi = null;
let caseOnboardingPrompted = false;
let caseOnboardingModalBound = false;
let caseOnboardingScrollY = 0;
let caseOnboardingBodyOverflow = "";

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
let chatMenuWrapper = null;
let applicationsActionsBound = false;
let homeTabsBound = false;
let headerDocListenersBound = false;
const applicantDrawerCache = new Map();
let applicantReturnHandled = false;
let applicantReturnContext = null;
let applicantsCaseHandled = false;
const caseApplicationCounts = new Map();
let applicationsCache = [];
let applicationsPromise = null;

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
  caseTabsBound: false,
  caseFilesPromise: null,
  caseFilesReady: false,
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
  await loadUserHeaderInfo();
  applyRoleVisibility(user);
  if (!state.user) {
    state.user = user;
  }
  bootstrap();
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
  if (headerOnly) {
    return;
  }

  switch (pageKey) {
    case "messages":
      await initMessagesPage();
      break;
    case "documents":
      await initDocumentsPage();
      break;
    case "cases":
      await initCasesPage();
      break;
    case "review":
      await initReviewPage();
      break;
    case "case-files":
      await initCaseFilesPage();
      break;
    case "tasks":
      await initTasksPage();
      break;
    case "overview":
    default:
      await initOverviewPage();
      break;
  }
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
  .lpc-shared-header .user-chip{display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.4);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);transition:border-color .2s ease, box-shadow .2s ease}
  .lpc-shared-header .user-chip img{width:44px;height:44px;border-radius:50%;border:2px solid #fff;box-shadow:0 4px 16px rgba(0,0,0,0.08);object-fit:cover}
  .lpc-shared-header .user-chip strong{display:block;font-family:var(--font-serif);font-weight:500;letter-spacing:.02em;color:#1a1a1a;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lpc-shared-header .user-chip span{font-size:.85rem;color:#6b6b6b;max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  body.theme-dark .lpc-shared-header .user-chip{background:rgba(15,23,42,0.4);border-color:rgba(255,255,255,0.15);box-shadow:0 10px 25px rgba(0,0,0,0.35)}
  body.theme-dark .lpc-shared-header .user-chip strong{color:#fff}
  body.theme-dark .lpc-shared-header .user-chip span{color:rgba(255,255,255,0.8)}
  body.theme-mountain .lpc-shared-header .user-chip{background:rgba(255,255,255,0.65);border-color:rgba(255,255,255,0.42);box-shadow:0 18px 34px rgba(17,22,26,0.2)}
  body.theme-mountain .lpc-shared-header .user-chip strong{color:#1b1b1b}
  body.theme-mountain .lpc-shared-header .user-chip span{color:#6b6b6b}
  .lpc-shared-header .profile-dropdown{position:absolute;right:0;top:calc(100% + 10px);background:var(--panel,#fff);border:1px solid var(--line,rgba(0,0,0,0.08));border-radius:16px;box-shadow:0 18px 30px rgba(0,0,0,0.12);display:none;flex-direction:column;min-width:200px;z-index:9999;pointer-events:auto;overflow:visible;color:var(--ink,#1a1a1a)}
  .lpc-shared-header .profile-dropdown.show{display:flex;pointer-events:auto;overflow:visible}
  .lpc-shared-header .profile-dropdown button,
  .lpc-shared-header .profile-dropdown a{background:none;border:none;padding:.85rem 1.1rem;text-align:left;font-size:.92rem;cursor:pointer;color:inherit;text-decoration:none;display:block;font-weight:200;border-radius:12px;margin:4px 6px;width:calc(100% - 12px)}
  .lpc-shared-header .profile-dropdown button:hover,
  .lpc-shared-header .profile-dropdown a:hover{background:rgba(0,0,0,0.04)}
  .lpc-shared-header .profile-dropdown .logout-btn{color:#b91c1c;background:rgba(185,28,28,0.08);border:1px solid rgba(185,28,28,0.2)}
  .lpc-shared-header .profile-dropdown .logout-btn:hover{background:rgba(185,28,28,0.15);color:#991b1b}
  body.theme-dark .lpc-shared-header .profile-dropdown button:hover,
  body.theme-dark .lpc-shared-header .profile-dropdown a:hover,
  body.theme-mountain-dark .lpc-shared-header .profile-dropdown button:hover,
  body.theme-mountain-dark .lpc-shared-header .profile-dropdown a:hover{background:rgba(255,255,255,0.06)}
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

function ensureSimpleMessageStyles() {
  if (document.getElementById("simple-message-styles")) return;
  const style = document.createElement("style");
  style.id = "simple-message-styles";
  style.textContent = `
  #msgInterface{
    margin-top:2rem;
    border:1px solid var(--line, rgba(0,0,0,0.08));
    border-radius:12px;
    background:var(--panel, #fcfcfc);
    padding:1.25rem;
    display:flex;
    flex-direction:column;
    gap:1rem;
    font-family:'Sarabun',sans-serif;
    box-shadow:0 10px 30px rgba(0,0,0,0.06);
  }
  #msgInterface select{
    width:100%;
    border:1px solid var(--line, rgba(0,0,0,0.1));
    border-radius:8px;
    padding:0.55rem 0.75rem;
    font-size:0.95rem;
    background:#fff;
  }
  #msgInterface #msgThread{
    min-height:140px;
    border:1px dashed var(--line, rgba(0,0,0,0.15));
    border-radius:8px;
    padding:0.75rem;
    font-size:0.9rem;
    color:var(--muted,#6b6b6b);
    background:#fff;
  }
  #msgInterface form{
    display:flex;
    flex-direction:column;
    gap:0.75rem;
  }
  #msgInterface textarea{
    width:100%;
    border:1px solid var(--line, rgba(0,0,0,0.12));
    border-radius:10px;
    padding:0.65rem 0.85rem;
    resize:vertical;
    min-height:80px;
    font-size:0.95rem;
    background:#fff;
  }
  #msgInterface button{
    align-self:flex-end;
    border:none;
    border-radius:999px;
    padding:0.55rem 1.4rem;
    font-size:0.95rem;
    background:var(--accent,#b6a47a);
    color:#fff;
    cursor:pointer;
    transition:background .2s ease, transform .2s ease;
  }
  #msgInterface button:hover{
    background:var(--accent-dark,#9c8a63);
    transform:translateY(-1px);
  }
  `;
  document.head.appendChild(style);
}

async function initHeader(options = {}) {
  const { skipNotifications = false } = options;
  const target = document.querySelector("[data-attorney-header]");
  if (!target) return;
  target.innerHTML = `
    <div class="lpc-shared-header">
      <div class="header-controls" data-notification-center>
        <div class="notification-wrapper">
          <button class="notification-icon" aria-label="View notifications" data-notification-toggle>
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
            <span id="headerRole">Member</span>
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

async function triggerLogout(evt) {
  evt?.preventDefault?.();
  if (typeof window.logoutUser === "function") {
    await window.logoutUser(evt);
    return;
  }
  try {
    await logout("login.html");
  } catch {
    window.location.href = "login.html";
  }
}

function bindHeaderEvents() {
  const profileTrigger = document.getElementById("headerUser");
  const profileMenu = document.getElementById("profileDropdown");
  const settingsBtn = profileMenu?.querySelector("[data-account-settings]");
  const notifToggle = document.querySelector("[data-notification-toggle]");
  const notifPanel = document.querySelector("[data-notification-panel]");

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

  // Fallback notification toggle if notifications.js didn't bind yet
  if (notifToggle && notifPanel && !notifToggle.dataset.boundNotifFallback) {
    notifToggle.dataset.boundNotifFallback = "true";
    notifToggle.addEventListener("click", () => {
      const notificationCenter = notifToggle.closest("[data-notification-center]");
      if (notificationCenter?.dataset?.boundNotificationCenter === "true") return;
      const willShow = !notifPanel.classList.contains("show");
      document.querySelectorAll("[data-notification-panel].show").forEach((panel) => {
        if (panel !== notifPanel) panel.classList.remove("show");
      });
      notifPanel.classList.toggle("show", willShow);
      notifPanel.classList.toggle("hidden", !willShow);
      if (willShow && typeof window.refreshNotificationCenters === "function") {
        window.refreshNotificationCenters();
      }
    });
  }

  if (!headerDocListenersBound) {
    headerDocListenersBound = true;
    document.addEventListener("click", (evt) => {
      const target = evt.target.closest("[data-logout]");
      if (target) {
        triggerLogout(evt);
        return;
      }
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
  const roleLabel = (current.role || "Attorney").replace(/\b\w/g, (c) => c.toUpperCase());
  const isParalegal = String(current.role || "").toLowerCase() === "paralegal";
  const isPendingPhoto =
    isParalegal &&
    (String(current.profilePhotoStatus || "").toLowerCase() === "pending_review" || current.pendingProfileImage);
  const roleText = isPendingPhoto ? `${roleLabel} • PENDING` : roleLabel;
  const nameEl = document.getElementById("headerName");
  const avatarEl = document.getElementById("headerAvatar");
  const roleEl = document.getElementById("headerRole");
  const heading = document.getElementById("user-name-heading");
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) avatarEl.src = avatar;
  if (roleEl) roleEl.textContent = roleText;
  if (heading) heading.textContent = current.firstName || heading.textContent;
  updateWelcomeGreeting(current);
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

function updateWelcomeGreeting(user) {
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

async function markNotificationsRead(options = {}) {
  try {
    const normalizedCase = options.caseId ? String(options.caseId) : "";
    const normalizedType = options.type ? String(options.type) : "";
    if (!normalizedCase && !normalizedType) {
      await secureFetch("/api/notifications/read-all", { method: "POST" });
      window.refreshNotificationCenters?.();
      return;
    }
    const res = await secureFetch("/api/notifications", {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) throw new Error("Unable to load notifications");
    const items = await res.json().catch(() => []);
    const targets = (Array.isArray(items) ? items : []).filter((item) => {
      if (!item) return false;
      if (normalizedType && String(item.type || "") !== normalizedType) return false;
      if (normalizedCase) {
        const payloadCase =
          item.caseId ||
          item.payload?.caseId ||
          item.payload?.caseID ||
          item.payload?.case?.id ||
          item.payload?.case;
        if (String(payloadCase || "") !== normalizedCase) return false;
      }
      return true;
    });
    await Promise.all(
      targets.map((item) =>
        secureFetch(`/api/notifications/${item._id || item.id}/read`, {
          method: "POST",
          credentials: "include",
        })
      )
    );
    window.refreshNotificationCenters?.();
  } catch (err) {
    console.warn("Notifications mark read failed", err);
  }
}

function isAttorneyProfileComplete(user = {}) {
  if (!user || typeof user !== "object") return false;
  const practiceAreas = Array.isArray(user.practiceAreas)
    ? user.practiceAreas.filter((item) => String(item || "").trim())
    : [];
  const description = String(user.practiceDescription || user.bio || "").trim();
  const hasPractice = practiceAreas.length > 0;
  const hasSummary = description.length >= 40 || Boolean(user.lawFirm) || Boolean(user.linkedInURL);
  return hasPractice && hasSummary;
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
      ref.action.onclick = onClick;
    }
  };

  const goToProfile = () => {
    window.location.href = "profile-settings.html";
  };
  const goToBilling = () => {
    if (typeof showDashboardView === "function") {
      showDashboardView("billing");
    } else {
      window.location.hash = "billing";
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
    const profileDone = isAttorneyProfileComplete(state.user || {});
    const paymentDone = state.billing.hasPaymentMethod === true;
    const caseDone = (state.cases?.length || 0) > 0 || (state.casesArchived?.length || 0) > 0;

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
      actionText: caseDone ? "View" : "New case",
      onClick: caseDone ? goToCaseList : goToCases,
    });
  };

  onboardingChecklistApi = { update };
  update();
  return onboardingChecklistApi;
}

function updateOnboardingChecklist() {
  onboardingChecklistApi?.update?.();
}

function bindCaseOnboardingModal() {
  if (caseOnboardingModalBound) return;
  const modal = document.getElementById("attorneyCaseOnboardingModal");
  const overlay = document.getElementById("attorneyCaseOnboardingOverlay");
  if (!modal || !overlay) return;
  caseOnboardingModalBound = true;
  const closeBtn = modal.querySelector("[data-case-onboarding-close]");
  const continueBtn = modal.querySelector("[data-case-onboarding-continue]");

  const handleClose = () => {
    hideCaseOnboardingModal();
    highlightNewCaseButton();
  };

  closeBtn?.addEventListener("click", handleClose);
  continueBtn?.addEventListener("click", handleClose);
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
  const messageBox = document.getElementById("messageBox");
  const messageCountSpan = document.getElementById("messageCount");
  const messageLabelSpan = document.getElementById("messageLabel");
  const completedJobsList = document.getElementById("completedJobsList");
  const messageSnippet = document.getElementById("messageSnippet");
  const messagePreviewSender = document.getElementById("messagePreviewSender");
  const messagePreviewText = document.getElementById("messagePreviewText");
  const messagePreviewLink = document.getElementById("messagePreviewLink");
  const deadlineList = document.getElementById("deadlineList");
  const escrowDetails = document.getElementById("escrowDetails");
  const caseCards = document.getElementById("caseCards");
  const quickButtons = document.querySelectorAll("[data-quick-link]");
  const weeklyNotesGrid = document.getElementById("weeklyNotesGrid");
  const weeklyNotesRange = document.getElementById("weeklyNotesRange");
  setupOnboardingChecklist();

  const toastHelper = window.toastUtils;
  const stagedToast = toastHelper?.consume();
  if (stagedToast?.message) {
    toastHelper.show(stagedToast.message, { targetId: "toastBanner", type: stagedToast.type });
  }

  if (messageBox) {
    messageBox.addEventListener("click", () => {
      goToMessages(state.latestThreadCaseId);
    });
    messageBox.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        goToMessages(state.latestThreadCaseId);
      }
    });
  }

  function updateMessageBubble(count = 0) {
    if (messageCountSpan) {
      messageCountSpan.textContent = count === 0 ? "Caught up" : String(count);
      messageCountSpan.classList.toggle("is-muted", count === 0);
    }
    if (messageLabelSpan) {
      messageLabelSpan.textContent = count === 1 ? "message waiting" : "messages waiting";
    }
    updateOverviewSignals({ unreadCount: count });
  }

  updateMessageBubble(0);
  fetchUnreadMessages().catch(() => {});
  loadCompletedJobs(completedJobsList).catch(() => {});
  hydrateOverview().catch(() => {});
  setupWeeklyNoteModal();
  void initWeeklyNotes(weeklyNotesGrid, weeklyNotesRange);

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

  async function fetchUnreadMessages() {
    try {
      const res = await secureFetch("/api/messages/unread-count", { headers: { Accept: "application/json" }, noRedirect: true });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      updateMessageBubble(data.count || 0);
    } catch (err) {
      console.warn("Message count fallback", err?.message);
    }
  }

  async function hydrateOverview() {
    try {
      const [dashboard, overdueCount, events, threads, apps, hasPaymentMethod] = await Promise.all([
        fetchDashboardData(),
        fetchOverdueCount(),
        fetchUpcomingEvents(),
        fetchThreadsOverview(200),
        loadApplicationsForMyJobs(),
        hasDefaultPaymentMethod(),
        loadCasesWithFiles(),
        loadArchivedCases(),
      ]);
      state.billing.hasPaymentMethod = hasPaymentMethod;
      updateOnboardingChecklist();
      applyApplicationsToCases(apps || []);
      const eligibleCaseIds = new Set(
        filterWorkspaceEligibleCases(state.cases).map((item) => String(item.id || item._id || ""))
      );
      const threadByCase = new Map();
      (threads || []).forEach((thread) => {
        const id = thread?.caseId || thread?.case?.id || thread?.id || "";
        if (id) threadByCase.set(String(id), thread);
      });
      state.threadOverview = threadByCase;
      const filteredCaseCards = (dashboard?.activeCases || []).filter((item) => {
        const id = item?.caseId || item?.id || item?._id;
        return id && eligibleCaseIds.has(String(id));
      });
      updateMetrics(dashboard?.metrics, overdueCount);
      renderCaseCards(caseCards, filteredCaseCards, threadByCase);
      renderEscrowPanel(escrowDetails, dashboard?.metrics);
      renderDeadlines(deadlineList, events);
      updateMessagePreviewUI({
        threads,
        messageSnippet,
        messagePreviewSender,
        messagePreviewText,
        eligibleCaseIds,
      });
      renderApplications(apps || [], hasPaymentMethod);
      updateOverviewSignals(
        buildOverviewSignals({ cases: state.cases, archivedCases: state.casesArchived, apps, overdueCount })
      );
    } catch (err) {
      console.warn("Overview hydration failed", err);
      if (deadlineList) deadlineList.innerHTML = `<div class="info-line" style="color:var(--muted);">Unable to load deadlines.</div>`;
    }
  }

  setupDashboardViewRouter();
  initHomeTabs();
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
  const saveTimers = new Map();
  const state = {
    mode: "week",
    weekStart: getWeekStart(new Date()),
    monthDate: getMonthStart(new Date()),
  };

  const updateRangeLabel = (label) => {
    if (rangeEl) rangeEl.textContent = label;
  };

  const scheduleSave = (weekKey, notes) => {
    const existing = saveTimers.get(weekKey);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      saveTimers.delete(weekKey);
      void persistWeeklyNotes(weekKey, notes);
    }, 500);
    saveTimers.set(weekKey, timer);
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
      toggleBtn.textContent = state.mode === "week" ? "Full Month" : "Week View";
      toggleBtn.classList.toggle("is-active", state.mode === "month");
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

  const renderDayCard = ({ date, note, isOutsideMonth, onSave, showWeekday = true, dateFormat = {} }) => {
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
      const textarea = document.createElement("textarea");
      textarea.className = "weekly-note-input";
      textarea.rows = 3;
      textarea.placeholder = "";
      textarea.value = currentNote;
      textarea.addEventListener("input", () => {
        currentNote = textarea.value;
        onSave(currentNote);
      });
      day.append(header, textarea);
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
        onSave: (value) => {
          currentNote = value;
          updateBody(value);
          onSave(value);
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

  const renderWeek = async () => {
    const start = getWeekStart(state.weekStart);
    state.weekStart = start;
    const weekKey = formatDateKey(start);
    const notes = await loadWeekNotes(start);

    const end = addDays(start, 6);
    const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    updateRangeLabel(`${startLabel}–${endLabel}`);

    grid.classList.remove("month-view");
    grid.innerHTML = "";
    if (monthHeader) {
      monthHeader.classList.remove("is-visible");
      monthHeader.setAttribute("aria-hidden", "true");
    }

    for (let i = 0; i < 7; i += 1) {
      const date = addDays(start, i);
      const day = renderDayCard({
        date,
        note: notes[i] || "",
        isOutsideMonth: false,
        showWeekday: true,
        dateFormat: { month: "short", day: "numeric" },
        onSave: (value) => {
          notes[i] = value;
          scheduleSave(weekKey, notes);
        },
      });
      grid.appendChild(day);
    }
  };

  const renderMonth = async () => {
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
        onSave: (value) => {
          notes[idx] = value;
          scheduleSave(weekKey, notes);
        },
      });
      grid.appendChild(day);
    }
  };

  const render = () => {
    if (state.mode === "month") return void renderMonth();
    return void renderWeek();
  };

  let lastCompact = window.matchMedia("(max-width: 900px)").matches;
  window.addEventListener("resize", () => {
    const isCompact = window.matchMedia("(max-width: 900px)").matches;
    if (isCompact !== lastCompact && state.mode === "month") {
      lastCompact = isCompact;
      render();
    } else if (isCompact !== lastCompact) {
      lastCompact = isCompact;
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
  modal.innerHTML = `
    <div class="note-modal-card">
      <h3 id="weeklyNoteModalTitle" style="font-family:var(--font-serif);font-weight:300;">Weekly Note</h3>
      <div class="weekly-note-modal-date" id="weeklyNoteModalDate"></div>
      <textarea id="weeklyNoteModalTextarea" placeholder="Add a note for this day."></textarea>
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

  weeklyNoteCancelBtn?.addEventListener("click", closeWeeklyNoteModal);
  weeklyNoteModalRef.addEventListener("click", (event) => {
    if (event.target === weeklyNoteModalRef) {
      closeWeeklyNoteModal();
    }
  });
  weeklyNoteSaveBtn?.addEventListener("click", () => {
    if (!weeklyNoteModalOnSave) return;
    const value = weeklyNoteTextarea?.value?.trim() || "";
    weeklyNoteModalOnSave(value);
    closeWeeklyNoteModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && weeklyNoteModalRef && !weeklyNoteModalRef.classList.contains("hidden")) {
      closeWeeklyNoteModal();
    }
  });
}

function openWeeklyNoteModal({ date, note, onSave }) {
  setupWeeklyNoteModal();
  if (!weeklyNoteModalRef) return;
  weeklyNoteModalOnSave = onSave;
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
  weeklyNoteModalRef.removeAttribute("aria-hidden");
  weeklyNoteTextarea?.focus();
}

function closeWeeklyNoteModal() {
  if (!weeklyNoteModalRef) return;
  weeklyNoteModalRef.classList.add("hidden");
  weeklyNoteModalRef.removeAttribute("aria-busy");
  weeklyNoteModalOnSave = null;
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

async function fetchWeeklyNotes(weekStart) {
  try {
    const res = await secureFetch(`/api/users/me/weekly-notes?weekStart=${encodeURIComponent(weekStart)}`, {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    if (!res.ok) throw new Error("Unable to load weekly notes.");
    const payload = await res.json().catch(() => ({}));
    const notes = Array.isArray(payload.notes) ? payload.notes : [];
    return normalizeWeeklyNotes(notes);
  } catch (err) {
    console.warn("Weekly notes load failed", err);
    return Array(7).fill("");
  }
}

async function persistWeeklyNotes(weekStart, notes = []) {
  try {
    const res = await secureFetch("/api/users/me/weekly-notes", {
      method: "PUT",
      headers: { Accept: "application/json" },
      body: { weekStart, notes },
    });
    if (!res.ok) throw new Error("Unable to save weekly notes.");
  } catch (err) {
    console.warn("Weekly notes save failed", err);
  }
}

function normalizeWeeklyNotes(notes = []) {
  const normalized = Array(7).fill("");
  notes.forEach((note, idx) => {
    if (idx >= normalized.length) return;
    normalized[idx] = String(note || "");
  });
  return normalized;
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
  if (dashboardViewState.currentView === target) return;

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
    const wantsFilter = caseFilter && CASE_VIEW_FILTERS.includes(caseFilter);
    if (wantsFilter && !dashboardViewState.casesInitialized) {
      setCaseFilter(caseFilter, { render: false });
    }
    void ensureCasesViewReady().then(() => {
      if (wantsFilter && state.casesViewFilter !== caseFilter) {
        setCaseFilter(caseFilter);
      }
      maybeOpenCasePreviewFromQuery();
      maybeOpenApplicantFromQuery();
      maybeOpenApplicantsCaseFromQuery();
      maybePromptCaseOnboarding();
    });
  }
}

function ensureCasesViewReady() {
  if (dashboardViewState.casesInitialized) return Promise.resolve();
  if (dashboardViewState.casesInitPromise) return dashboardViewState.casesInitPromise;
  dashboardViewState.casesInitPromise = (async () => {
    await initCasesPage();
    bindCaseViewTabs();
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

function bindCaseViewTabs() {
  if (dashboardViewState.caseTabsBound) return;
  const viewButtons = document.querySelectorAll("[data-case-view]");
  if (!viewButtons.length) return;
  const sections = {
    cases: document.getElementById("casesViewSection"),
    files: document.getElementById("caseFilesSection"),
  };
  viewButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetView = btn.dataset.caseView;
      if (!targetView || btn.classList.contains("active")) return;
      viewButtons.forEach((node) => {
        const active = node === btn;
        node.classList.toggle("active", active);
        node.setAttribute("aria-selected", active ? "true" : "false");
      });
      Object.entries(sections).forEach(([key, node]) => {
        if (!node) return;
        node.classList.toggle("hidden", key !== targetView);
      });
      if (targetView === "files") {
        void ensureCaseFilesEmbedReady();
      }
    });
  });
  dashboardViewState.caseTabsBound = true;
}

function setCaseFilter(filterKey, { render = true } = {}) {
  const key = (filterKey || "").toLowerCase();
  if (!CASE_VIEW_FILTERS.includes(key)) return;
  const tabs = document.querySelectorAll("[data-case-filter]");
  const tables = document.querySelectorAll("[data-case-table]");
  if (!tabs.length || !tables.length) return;
  state.casesViewFilter = key;
  tabs.forEach((btn) => {
    const active = btn.dataset.caseFilter === key;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  tables.forEach((table) => {
    table.classList.toggle("hidden", table.dataset.caseTable !== key);
  });
  if (render) {
    renderCasesView();
  }
}

function ensureCaseFilesEmbedReady() {
  if (dashboardViewState.caseFilesReady) return Promise.resolve();
  if (dashboardViewState.caseFilesPromise) return dashboardViewState.caseFilesPromise;
  dashboardViewState.caseFilesPromise = initCaseFilesView({
    containerId: "caseFilesEmbedContainer",
    filters: [
      { id: "caseFilesEmbedFilterAll", fn: (files) => files },
      { id: "caseFilesEmbedFilterApproved", fn: (files) => files.filter((f) => f.status === "approved") },
      { id: "caseFilesEmbedFilterPending", fn: (files) => files.filter((f) => f.status === "pending_review") },
      { id: "caseFilesEmbedFilterRevisions", fn: (files) => files.filter((f) => f.status === "attorney_revision") },
    ],
    emptyCopy: "Awaiting paralegal submissions.",
    emptySubtext: "Once files arrive, they’ll show up here automatically.",
    gatedCopy: "Fund a case to unlock file review.",
    unauthorizedCopy: "You need an attorney account to view these files.",
  })
    .then(() => {
      dashboardViewState.caseFilesReady = true;
    })
    .catch((err) => {
      console.warn("Case files embed failed", err);
    })
    .finally(() => {
      dashboardViewState.caseFilesPromise = null;
    });
  return dashboardViewState.caseFilesPromise;
}

async function loadCompletedJobs(container) {
  if (!container) return;
  try {
    await loadArchivedCases();
    const completed = (state.casesArchived || []).filter((item) => {
      const statusKey = normalizeCaseStatus(item?.status);
      return statusKey === "completed" && item?.archived === true;
    });
    if (!completed.length) {
      container.innerHTML = '<p class="info-line" style="color:var(--muted);">No completed jobs yet.</p>';
      return;
    }
    container.innerHTML = completed.map((job) => renderCompletedJobCard(job)).join("");
  } catch (err) {
    console.warn("Unable to load completed jobs", err);
    container.innerHTML = '<p class="info-line" style="color:var(--muted);">Unable to load completed jobs.</p>';
  }
}

function renderCompletedJobCard(job) {
  const summary = sanitize(job.briefSummary || job.title || "Completed case");
  const completedAt = job.completedAt ? new Date(job.completedAt).toLocaleDateString() : "Date unavailable";
  const caseId = job.id || job._id;
  const archiveLink = caseId
    ? `<a href="/api/cases/${encodeURIComponent(caseId)}/archive/download" target="_blank" rel="noopener">Download Archive</a>`
    : '<span class="muted">Archive unavailable</span>';
  return `
    <div class="completed-job-card">
      <div class="info-line"><strong>${summary}</strong></div>
      <div class="info-line" style="color:var(--muted);">Completed ${completedAt}</div>
      <div class="downloads">${archiveLink}</div>
    </div>
  `;
}

function goToMessages(caseId) {
  if (!caseId) {
    notifyMessages("Open an active case to view messages.", "info");
    return;
  }
  const target = `case-detail.html?caseId=${encodeURIComponent(caseId)}#case-messages`;
  window.location.href = target;
}
// -------------------------
// Billing Page
// -------------------------
async function initBillingPage() {
  const postedBody = document.getElementById("postedJobsBody");
  const activeBody = document.getElementById("activeEscrowsBody");
  const editModal = document.getElementById("editJobModal");
  const editForm = document.getElementById("editJobForm");
  const toastHelper = window.toastUtils;
  const stagedToast = toastHelper?.consume?.();
  if (stagedToast?.message) {
    toastHelper.show(stagedToast.message, { targetId: "toastBanner", type: stagedToast.type });
  }

  postedBody?.addEventListener("click", onPostedJobsAction);
  activeBody?.addEventListener("click", onActiveEscrowAction);
  editModal?.querySelector("[data-close-modal]")?.addEventListener("click", () => toggleModal(editModal, false));
  editForm?.addEventListener("submit", submitJobEdit);
  document.querySelectorAll("[data-refresh]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.refresh;
      if (type === "posted") loadPostedJobs(true);
      else if (type === "escrows") loadActiveEscrows(true);
      else if (type === "history") loadCompletedPayments(true);
    });
  });

  document.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => triggerExport(btn.dataset.export));
  });
  document.querySelector("[data-customer-portal]")?.addEventListener("click", () => openCustomerPortal());

  await hydrateBillingOverview();
  await Promise.all([loadPostedJobs(), loadActiveEscrows()]);
}

async function hydrateBillingOverview(force = false) {
  try {
    const [summary, history] = await Promise.all([fetchBillingSummary(force), fetchPaymentHistory(force)]);
    renderBillingSummary(summary);
    renderSpendingChart(history);
    renderCompletedPayments(history);
    updateJobDistributionChart();
  } catch (err) {
    console.warn("Unable to hydrate billing overview", err);
    loadBillingDemoData();
  }
}

async function loadPostedJobs(force = false) {
  const body = document.getElementById("postedJobsBody");
  if (!body) return;
  if (force) body.innerHTML = `<tr><td colspan="4" class="empty-state">Refreshing posted jobs…</td></tr>`;
  try {
    const res = await secureFetch("/api/cases/posted", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => []);
    const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
    state.billing.posted = items;
    state.billing.postedMap.clear();
    items.forEach((job) => {
      const id = parseCaseId(job);
      if (id) state.billing.postedMap.set(String(id), job);
    });
    renderPostedJobs(body, items);
    updateJobDistributionChart();
    updatePostedSummaryCount();
  } catch (err) {
    console.warn("Unable to load posted jobs", err);
    loadBillingDemoData();
  }
}

function renderPostedJobs(body, jobs = []) {
  if (!jobs.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty-state">No open jobs awaiting hire.</td></tr>`;
    return;
  }
  body.innerHTML = jobs
    .map((job) => {
      const caseId = parseCaseId(job);
      const title = sanitize(job.title || job.caseTitle || "Untitled Matter");
      const applicants = Number(job.applicantsCount ?? (Array.isArray(job.applicants) ? job.applicants.length : 0)) || 0;
      const budget = formatCurrency(
        normalizeAmountToCents(job.lockedTotalAmount ?? job.totalAmount ?? job.paymentAmount ?? job.budget)
      );
      const escrowFunded = String(job.escrowStatus || "").toLowerCase() === "funded";
      const canOpenWorkspace = !!job.paralegal && escrowFunded && job.escrowIntentId;
      const openAction = canOpenWorkspace ? "open-case" : "view-details";
      const openLabel = canOpenWorkspace ? "Open Case" : "View Details";
      const openDisabled = caseId
        ? ""
        : ' disabled aria-disabled="true" title="Case unavailable."';
      const viewApplicantsDisabled = caseId
        ? ""
        : ' disabled aria-disabled="true" title="Case unavailable."';
      return `
        <tr data-case-id="${caseId || ""}">
          <td>${title}</td>
          <td>${budget}</td>
          <td>${applicants}</td>
          <td>
            <div class="btn-group">
              <button type="button" class="secondary" data-job-action="view-applicants" data-case-id="${caseId}"${viewApplicantsDisabled}>View Applicants</button>
              <button type="button" data-job-action="edit" data-case-id="${caseId}">Edit Job</button>
              <button type="button" class="danger" data-job-action="delete" data-case-id="${caseId}">Delete</button>
              <button type="button" class="secondary" data-job-action="${openAction}" data-case-id="${caseId}"${openDisabled}>${openLabel}</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function onPostedJobsAction(event) {
  const btn = event.target.closest("[data-job-action]");
  if (!btn) return;
  const action = btn.dataset.jobAction;
  const caseId = btn.getAttribute("data-case-id");
  if (!caseId) return;
  if (action === "view-applicants") {
    void openCaseApplications(caseId);
  } else if (action === "open-case") {
    window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
  } else if (action === "view-details") {
    void openCasePreview(caseId);
  } else if (action === "edit") {
    openEditJobModal(caseId);
  } else if (action === "delete") {
    deletePostedJob(caseId);
  }
}

function openEditJobModal(caseId) {
  const modal = document.getElementById("editJobModal");
  const form = document.getElementById("editJobForm");
  const job = state.billing.postedMap.get(String(caseId));
  if (!modal || !form || !job) return;
  state.billing.editJobId = caseId;
  form.caseId.value = caseId;
  form.title.value = job.title || job.caseTitle || "";
  form.description.value = getJobDescription(job);
  const amountCents = normalizeAmountToCents(job.lockedTotalAmount ?? job.totalAmount ?? job.paymentAmount ?? job.budget);
  form.budget.value = amountCents ? (amountCents / 100).toFixed(2) : "";
  toggleModal(modal, true);
}

async function submitJobEdit(event) {
  event.preventDefault();
  const form = event.target;
  const modal = document.getElementById("editJobModal");
  const submitBtn = form.querySelector('button[type="submit"]');
  const caseId = form.caseId?.value || state.billing.editJobId;
  if (!caseId) return;
  const payload = {
    title: form.title.value.trim(),
    details: form.description.value.trim(),
    totalAmount: dollarsToCents(form.budget.value),
    budget: dollarsToCents(form.budget.value),
  };
  const defaultText = submitBtn?.textContent || "Save";
  let restoreButton = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Posting…";
  }
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
      method: "PATCH",
      body: payload,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notifyBilling("Job updated successfully.", "success");
    toggleModal(modal, false);
    await loadPostedJobs(true);
    enableButtonOnFormInput(form, submitBtn, defaultText);
    restoreButton = false;
  } catch (err) {
    console.error("Job update failed", err);
    notifyBilling("Unable to save those changes right now.", "error");
  } finally {
    if (restoreButton && submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = defaultText;
    }
  }
}

async function deletePostedJob(caseId) {
  if (!caseId) return;
  const confirmed = window.confirm("Delete this job posting? Applicants will no longer see it.");
  if (!confirmed) return;
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notifyBilling("Job removed.", "success");
    await loadPostedJobs(true);
  } catch (err) {
    console.error("Job delete failed", err);
    notifyBilling("Unable to delete this job right now.", "error");
  }
}

async function loadActiveEscrows(force = false) {
  const body = document.getElementById("activeEscrowsBody");
  if (!body) return;
  if (force) body.innerHTML = `<tr><td colspan="5" class="empty-state">Refreshing activity…</td></tr>`;
  try {
    const res = await secureFetch("/api/payments/escrow/active", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => []);
    const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
    state.billing.escrows = items;
    renderActiveEscrows(body, items);
    updateJobDistributionChart();
  } catch (err) {
    console.warn("Unable to load escrow activity", err);
    loadBillingDemoData();
  }
}

function renderActiveEscrows(body, escrows = []) {
  if (!escrows.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty-state">No active payments.</td></tr>`;
    return;
  }
  body.innerHTML = escrows
    .map((record) => {
      const caseId = parseCaseId(record);
      const title = sanitize(record.caseTitle || record.title || "Case");
      const paralegal = sanitize(
        record.paralegalName ||
          (record.paralegal && [record.paralegal.firstName, record.paralegal.lastName].filter(Boolean).join(" ")) ||
          "Assigned Paralegal"
      );
      const fundedDate = formatDisplayDate(record.fundedAt || record.createdAt || record.updatedAt);
      const statusRaw = (record.status || record.escrowStatus || "").toLowerCase();
      const status =
        statusRaw.includes("pending") || statusRaw === "awaiting_release"
          ? "Pending Approval"
          : statusRaw
          ? statusRaw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
          : "In Progress";
      const amount = formatCurrency(
        normalizeAmountToCents(record.amount ?? record.lockedTotalAmount ?? record.totalAmount ?? record.budget)
      );
      return `
        <tr data-case-id="${caseId || ""}">
          <td>${title}</td>
          <td>${paralegal}</td>
          <td>${amount}</td>
          <td>${fundedDate}</td>
          <td><span class="pill">${sanitize(status)}</span></td>
        </tr>
      `;
    })
    .join("");
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

async function loadCompletedPayments(force = false) {
  const body = document.getElementById("completedPaymentsBody");
  if (!body) return;
  if (force) body.innerHTML = `<tr><td colspan="5" class="empty-state">Refreshing payment history…</td></tr>`;
  try {
    const records = await fetchPaymentHistory(force);
    renderCompletedPayments(records);
    renderSpendingChart(records);
    updateJobDistributionChart();
  } catch (err) {
    console.warn("Unable to load payment history", err);
    loadBillingDemoData();
  }
}

function renderCompletedPayments(records = []) {
  const body = document.getElementById("completedPaymentsBody");
  if (!body) return;
  if (!records.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty-state">No completed payments yet.</td></tr>`;
    return;
  }
  body.innerHTML = records
    .map((entry) => {
      const title = sanitize(entry.caseTitle || entry.title || "Case");
      const paralegal = sanitize(
        entry.paralegalName ||
          (entry.paralegal && [entry.paralegal.firstName, entry.paralegal.lastName].filter(Boolean).join(" ")) ||
          "Paralegal"
      );
      const amount = formatCurrency(
        normalizeAmountToCents(entry.finalAmount ?? entry.amount ?? entry.lockedTotalAmount ?? entry.totalAmount)
      );
      const releaseDate = formatDisplayDate(entry.releaseDate || entry.releasedAt || entry.completedAt || entry.paidOutAt);
      const downloadUrl = Array.isArray(entry.downloadUrl) ? entry.downloadUrl[0] : entry.downloadUrl;
      const receiptPath = sanitizeDownloadPath(entry.receiptUrl || entry.receipt || downloadUrl || "");
      const receiptCell = receiptPath && receiptPath !== "#"
        ? `<a class="btn-link secondary" href="${receiptPath}" target="_blank" rel="noopener">Download</a>`
        : `<span class="muted">Not available</span>`;
      return `
        <tr>
          <td>${title}</td>
          <td>${paralegal}</td>
          <td>${amount}</td>
          <td>${releaseDate}</td>
          <td>${receiptCell}</td>
        </tr>
      `;
    })
    .join("");
}

async function fetchBillingSummary(force = false) {
  if (state.billing.summary && !force) return state.billing.summary;
  try {
    const res = await secureFetch("/api/payments/summary", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => ({}));
    state.billing.summary = payload || {};
    return state.billing.summary;
  } catch (err) {
    console.warn("Unable to fetch billing summary", err);
    state.billing.summary = state.billing.summary || {};
    return state.billing.summary;
  }
}

async function fetchPaymentHistory(force = false) {
  if (state.billing.history.length && !force) return state.billing.history;
  try {
    const res = await secureFetch("/api/payments/history", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => []);
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.history)
      ? payload.history
      : Array.isArray(payload)
      ? payload
      : [];
    state.billing.history = items;
    state.billing.completedCount = items.length;
    return items;
  } catch (err) {
    console.warn("Unable to fetch payment history", err);
    state.billing.history = [];
    state.billing.completedCount = 0;
    throw err;
  }
}

function renderBillingSummary(summary = {}) {
  const totalSpent =
    summary.totalSpentCents ??
    summary.totalSpent ??
    summary.total ??
    summary.allTime ??
    0;
  const activeEscrow = summary.activeEscrowTotal ?? summary.escrowActive ?? summary.escrowTotal ?? 0;
  const postedJobs =
    typeof summary.postedJobsCount === "number" ? summary.postedJobsCount : state.billing.posted.length;
  const completedJobs =
    typeof summary.completedJobsCount === "number" ? summary.completedJobsCount : state.billing.completedCount;
  const summaryMap = {
    totalSpent: formatCurrency(normalizeAmountToCents(totalSpent)),
    activeEscrow: formatCurrency(normalizeAmountToCents(activeEscrow)),
    postedJobs: String(postedJobs),
    completedJobs: String(completedJobs),
  };
  Object.entries(summaryMap).forEach(([key, value]) => {
    const el = document.querySelector(`[data-summary="${key}"]`);
    if (el) el.textContent = value;
  });
}

function updatePostedSummaryCount() {
  const summary = state.billing.summary || {};
  if (typeof summary.postedJobsCount === "number") return;
  const el = document.querySelector('[data-summary="postedJobs"]');
  if (el) el.textContent = String(state.billing.posted.length);
}

function renderSpendingChart(records = []) {
  const ctx = document.getElementById("billingSpendingChart");
  if (!ctx || !window.Chart) return;
  const { labels, data } = buildMonthlySeries(records);
  if (!state.billing.spendingChart) {
    state.billing.spendingChart = new window.Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Monthly spend",
            data,
            borderColor: "#b6a47a",
            backgroundColor: "rgba(182,164,122,0.2)",
            tension: 0.35,
            fill: true,
          },
        ],
      },
      options: {
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback(value) {
                return `$${Number(value).toLocaleString()}`;
              },
            },
          },
        },
      },
    });
  } else {
    state.billing.spendingChart.data.labels = labels;
    state.billing.spendingChart.data.datasets[0].data = data;
    state.billing.spendingChart.update();
  }
}

function updateJobDistributionChart() {
  const canvas = document.getElementById("billingJobChart");
  if (!canvas || !window.Chart) return;
  const posted = state.billing.posted.length;
  const active = state.billing.escrows.length;
  const completed =
    typeof state.billing.summary?.completedJobsCount === "number"
      ? state.billing.summary.completedJobsCount
      : state.billing.completedCount;
  const data = [posted, active, completed];
  const labels = ["Posted Jobs", "Active Funds in Stripe", "Completed Jobs"];
  if (!state.billing.jobChart) {
    state.billing.jobChart = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: ["#d9c9a3", "#b6a47a", "#a08c60"],
            borderWidth: 0,
          },
        ],
      },
      options: {
        plugins: { legend: { position: "bottom" } },
        cutout: "60%",
      },
    });
  } else {
    state.billing.jobChart.data.datasets[0].data = data;
    state.billing.jobChart.update();
  }
}

function buildMonthlySeries(records = []) {
  const buckets = new Map();
  records.forEach((entry) => {
    const rawDate = entry.releaseDate || entry.releasedAt || entry.completedAt || entry.paidOutAt || entry.fundedAt;
    if (!rawDate) return;
    const dt = new Date(rawDate);
    if (Number.isNaN(dt.getTime())) return;
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    const prev = buckets.get(key) || 0;
    buckets.set(key, prev + normalizeAmountToCents(entry.finalAmount ?? entry.amount ?? entry.lockedTotalAmount ?? entry.totalAmount));
  });
  const sorted = Array.from(buckets.entries()).sort(([a], [b]) => (a > b ? 1 : -1));
  if (!sorted.length) return { labels: ["No data"], data: [0] };
  const labels = sorted.map(([key]) => {
    const [year, month] = key.split("-");
    const date = new Date(Number(year), Number(month) - 1, 1);
    return date.toLocaleString(undefined, { month: "short", year: "numeric" });
  });
  const data = sorted.map(([, cents]) => (cents || 0) / 100);
  return { labels, data };
}

async function openCustomerPortal() {
  try {
    const res = await secureFetch("/api/payments/portal", { method: "POST", headers: { Accept: "application/json" } });
    const payload = await res.json().catch(() => ({}));
    if (res.ok && payload.url) {
      window.location.href = payload.url;
      return;
    }
    throw new Error(payload.error || "No portal URL");
  } catch (err) {
    console.warn("Unable to open customer portal", err);
    notifyBilling("Customer portal link is unavailable right now.", "error");
  }
}

async function triggerExport(type) {
  const endpoint = type === "pdf" ? "/api/payments/export/pdf" : "/api/payments/export/csv";
  try {
    const res = await secureFetch(endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = type === "pdf" ? "lpc-billing-summary.pdf" : "lpc-billing-history.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => window.URL.revokeObjectURL(url), 1500);
    notifyBilling("Export ready.", "success");
  } catch (err) {
    console.warn("Unable to export billing data", err);
    notifyBilling("Unable to export data right now.", "error");
  }
}

function notifyBilling(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}

function parseCaseId(entry = {}) {
  return entry.caseId || entry.id || entry._id || entry.case || entry.caseID;
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

function dollarsToCents(input) {
  const value = typeof input === "number" ? input : parseFloat(String(input).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value * 100));
}

function getJobDescription(job = {}) {
  return job.details || job.description || job.briefSummary || "";
}

function loadBillingDemoData() {
  if (state.billing.demoLoaded) return;
  state.billing.demoLoaded = true;
  const today = new Date();
  const day = 24 * 60 * 60 * 1000;
  const history = [
    {
      caseId: "demo-complete-1",
      caseTitle: "Contract Review for Acme Holdings",
      paralegalName: "Morgan Ellis",
      finalAmount: 420000,
      releaseDate: today,
      downloadUrl: [],
    },
    {
      caseId: "demo-complete-2",
      caseTitle: "Trademark Diligence – West Coast Launch",
      paralegalName: "Priya Patel",
      finalAmount: 560000,
      releaseDate: new Date(today.getTime() - 4 * day),
      downloadUrl: [],
    },
    {
      caseId: "demo-complete-3",
      caseTitle: "M&A Filings – Series B Close",
      paralegalName: "Henry Nolan",
      finalAmount: 310000,
      releaseDate: new Date(today.getTime() - 9 * day),
      downloadUrl: [],
    },
    {
      caseId: "demo-complete-4",
      caseTitle: "Delaware Franchise Filings",
      paralegalName: "Claudia Stone",
      finalAmount: 360000,
      releaseDate: new Date(today.getTime() - 13 * day),
      downloadUrl: [],
    },
    {
      caseId: "demo-complete-5",
      caseTitle: "SaaS MSAs – Redline Support",
      paralegalName: "Noah Rivers",
      finalAmount: 290000,
      releaseDate: new Date(today.getTime() - 18 * day),
      downloadUrl: [],
    },
    {
      caseId: "demo-complete-6",
      caseTitle: "Immigration Packet Assembly",
      paralegalName: "Priya Patel",
      finalAmount: 250000,
      releaseDate: new Date(today.getTime() - 22 * day),
      downloadUrl: [],
    },
    {
      caseId: "demo-complete-7",
      caseTitle: "Urgent Discovery Support",
      paralegalName: "Morgan Ellis",
      finalAmount: 315000,
      releaseDate: new Date(today.getTime() - 26 * day),
      downloadUrl: [],
    },
    {
      caseId: "demo-complete-8",
      caseTitle: "Compliance Audit Prep",
      paralegalName: "Henry Nolan",
      finalAmount: 275000,
      releaseDate: new Date(today.getTime() - 30 * day),
      downloadUrl: [],
    },
  ];
  const posted = [
    {
      caseId: "demo-posted-1",
      title: "Urgent Discovery Support",
      totalAmount: 250000,
      applicantsCount: 7,
      details: "Need organization and Bates stamping for productions.",
    },
    {
      caseId: "demo-posted-2",
      title: "Immigration Packet Assembly",
      totalAmount: 180000,
      applicantsCount: 4,
      details: "Prepare I-140 supporting document set.",
    },
  ];
  const active = [
    {
      caseId: "demo-active-1",
      title: "Delaware Franchise Filings",
      paralegalName: "Claudia Stone",
      amount: 360000,
      fundedAt: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000),
      status: "In Progress",
    },
    {
      caseId: "demo-active-2",
      title: "SaaS MSAs – Redline Support",
      paralegalName: "Noah Rivers",
      amount: 290000,
      fundedAt: new Date(today.getTime() - 9 * 24 * 60 * 60 * 1000),
      status: "Pending Approval",
    },
  ];

  state.billing.history = history;
  state.billing.completedCount = history.length;
  state.billing.posted = posted;
  state.billing.postedMap.clear();
  posted.forEach((item) => state.billing.postedMap.set(String(item.caseId), item));
  state.billing.escrows = active;
  state.billing.summary = {
    totalSpentCents: history.reduce((sum, entry) => sum + Number(entry.finalAmount || 0), 0),
    activeEscrowTotal: active.reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
    postedJobsCount: posted.length,
    completedJobsCount: history.length,
  };

  renderBillingSummary(state.billing.summary);
  renderSpendingChart(history);
  renderCompletedPayments(history);
  renderPostedJobs(document.getElementById("postedJobsBody"), posted);
  renderActiveEscrows(document.getElementById("activeEscrowsBody"), active);
  updateJobDistributionChart();
}

// -------------------------
// Review Page
// -------------------------
async function initReviewPage() {
  const container = document.getElementById("reviewContainer");
  if (!container) return;

  await loadCasesWithFiles();
  renderReviewList(container);
  bindReviewActions(container);

  const revisionModal = document.getElementById("revisionModal");
  const uploadModal = document.getElementById("uploadModal");
  revisionModal?.querySelector("[data-close-revision]")?.addEventListener("click", () => toggleModal(revisionModal, false));
  revisionModal?.querySelector("[data-submit-revision]")?.addEventListener("click", submitRevisionRequest);
  uploadModal?.querySelector("[data-close-upload]")?.addEventListener("click", () => toggleModal(uploadModal, false));
  uploadModal?.querySelector("[data-submit-upload]")?.addEventListener("click", submitRevisionUpload);
}

function renderReviewList(container) {
  const cases = state.cases.filter(
    (c) => Array.isArray(c.files) && c.files.some((file) => file.status !== "approved")
  );
  if (!cases.length) {
    container.innerHTML = `<p style="color:var(--muted);font-size:.95rem;">No submissions are awaiting review.</p>`;
    return;
  }
  container.innerHTML = cases
    .map((caseItem) => {
      const reviewFiles = (caseItem.files || []).filter((file) => file.status !== "approved");
      const files = reviewFiles.map((file) => renderReviewItem(caseItem, file)).join("");
      return `
        <section class="case-review" data-case-id="${caseItem.id}">
          <h2 class="case-title">${sanitize(caseItem.title || "Untitled Case")}</h2>
          ${files || `<p style="color:var(--muted);font-size:.9rem;">All documents are approved.</p>`}
        </section>
      `;
    })
    .join("");
}

function renderReviewItem(caseItem, file) {
  const statusLabel = STATUS_LABELS[file.status] || file.status;
  const submitted = file.uploadedAt ? new Date(file.uploadedAt).toLocaleDateString() : "Unknown date";
  const actions =
    file.status === "approved"
      ? `
        <button class="btn secondary" type="button" data-review-action="view" data-case-id="${caseItem.id}" data-file-id="${file.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}" data-file-download="${sanitize(sanitizeDownloadPath((file.downloadUrl && file.downloadUrl[0]) || ""))}">View</button>
        <button class="btn secondary" type="button" data-review-action="download" data-case-id="${caseItem.id}" data-file-id="${file.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}" data-file-download="${sanitize(sanitizeDownloadPath((file.downloadUrl && file.downloadUrl[0]) || ""))}">Download</button>
        <button class="btn secondary" type="button" data-review-action="print" data-case-id="${caseItem.id}" data-file-id="${file.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}" data-file-download="${sanitize(sanitizeDownloadPath((file.downloadUrl && file.downloadUrl[0]) || ""))}">Print</button>
      `
      : `
        <button class="btn secondary" type="button" data-review-action="view" data-case-id="${caseItem.id}" data-file-id="${file.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}" data-file-download="${sanitize(sanitizeDownloadPath((file.downloadUrl && file.downloadUrl[0]) || ""))}">View</button>
        <button class="btn secondary" type="button" data-review-action="download" data-case-id="${caseItem.id}" data-file-id="${file.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}" data-file-download="${sanitize(sanitizeDownloadPath((file.downloadUrl && file.downloadUrl[0]) || ""))}">Download</button>
        <button class="btn primary" type="button" data-review-action="approve" data-case-id="${caseItem.id}" data-file-id="${file.id}">Approve</button>
        <button class="btn secondary" type="button" data-review-action="revision" data-case-id="${caseItem.id}" data-file-id="${file.id}">Request Revisions</button>
        <button class="btn secondary" type="button" data-review-action="upload" data-case-id="${caseItem.id}" data-file-id="${file.id}">Upload Revised Version</button>
      `;

  return `
    <div class="review-item" data-file-id="${file.id}">
      <div class="review-info">
        <h3>${sanitize(file.filename || file.original || "Document")}</h3>
        <p>Uploaded ${submitted} · Status: ${statusLabel}</p>
      </div>
      <div class="review-actions">
        ${actions}
      </div>
    </div>
  `;
}

function bindReviewActions(container) {
  container.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-review-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-review-action");
    const caseId = btn.getAttribute("data-case-id");
    const fileId = btn.getAttribute("data-file-id");
    const fileKey = btn.getAttribute("data-file-key");
    const fileName = btn.getAttribute("data-file-name");
    const directDownload = btn.getAttribute("data-file-download");
    if (!caseId || !fileId) return;

    state.reviewSelection = { caseId, fileId, fileKey, fileName, downloadUrl: directDownload };

    try {
      if (action === "view") {
        await openReviewFile(caseId, fileKey, directDownload, "view", fileName);
      } else if (action === "download") {
        await openReviewFile(caseId, fileKey, directDownload, "download", fileName);
      } else if (action === "print") {
        await openReviewFile(caseId, fileKey, directDownload, "print", fileName);
      } else if (action === "approve") {
        await updateFileStatus(caseId, fileId, { status: "approved" });
      } else if (action === "revision") {
        toggleModal(document.getElementById("revisionModal"), true);
      } else if (action === "upload") {
        const uploadInput = document.getElementById("revisedFile");
        if (uploadInput) uploadInput.value = "";
        state.uploadSelection = { caseId, fileId };
        toggleModal(document.getElementById("uploadModal"), true);
      }
    } catch (err) {
      console.error(err);
      alert("Unable to complete that action. Please try again.");
    }
  });
}

async function updateFileStatus(caseId, fileId, body) {
  const res = await secureFetch(`/api/cases/${caseId}/files/${fileId}/status`, {
    method: "PATCH",
    body,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("Status update failed");
  const payload = await res.json();
  if (payload?.file) {
    mergeUpdatedFile(caseId, payload.file);
    renderReviewList(document.getElementById("reviewContainer"));
    renderCaseFilesList();
  }
}

async function submitRevisionRequest() {
  const modal = document.getElementById("revisionModal");
  const notesEl = document.getElementById("revisionNotes");
  if (!state.reviewSelection || !notesEl) return;
  try {
    const res = await secureFetch(`/api/cases/${state.reviewSelection.caseId}/files/${state.reviewSelection.fileId}/revision-request`, {
      method: "POST",
      body: { notes: notesEl.value },
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error("Revision request failed");
    const payload = await res.json();
    if (payload?.file) {
      mergeUpdatedFile(state.reviewSelection.caseId, payload.file);
      renderReviewList(document.getElementById("reviewContainer"));
      renderCaseFilesList();
    }
  } catch (err) {
    console.error(err);
    alert("Unable to send revision request.");
  } finally {
    notesEl.value = "";
    toggleModal(modal, false);
  }
}

async function submitRevisionUpload() {
  const modal = document.getElementById("uploadModal");
  const fileInput = document.getElementById("revisedFile");
  if (!state.uploadSelection || !fileInput || !fileInput.files?.length) {
    alert("Please choose a file to upload.");
    return;
  }
  const file = fileInput.files[0];
  try {
    const key = await uploadToS3(file, state.uploadSelection.caseId);
    const res = await secureFetch(`/api/cases/${state.uploadSelection.caseId}/files/${state.uploadSelection.fileId}/replace`, {
      method: "POST",
      body: { key, original: file.name, mime: file.type, size: file.size },
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error("Replace failed");
    const payload = await res.json();
    if (payload?.file) {
      mergeUpdatedFile(state.uploadSelection.caseId, payload.file);
      renderReviewList(document.getElementById("reviewContainer"));
      renderCaseFilesList();
    }
  } catch (err) {
    console.error(err);
    alert("Unable to upload revised version.");
  } finally {
    toggleModal(modal, false);
    state.uploadSelection = null;
  }
}

// -------------------------
// Case Files Page
// -------------------------
function getCaseFileQueryId() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    return params.get("caseId");
  } catch {
    return null;
  }
}

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

function getAvailableCaseOptions() {
  return [...state.cases, ...state.casesArchived];
}

function setupCaseFilesUploadUI() {
  const cases = getAvailableCaseOptions();
  if (!state.caseFiles.selectedCaseId) {
    const queryId = getCaseFileQueryId();
    if (queryId && cases.some((item) => String(item.id) === String(queryId))) {
      state.caseFiles.selectedCaseId = queryId;
    } else if (cases.length) {
      state.caseFiles.selectedCaseId = String(cases[0].id);
    } else {
      state.caseFiles.selectedCaseId = null;
    }
  }

  const host = document.querySelector(".main") || document.body;
  if (!host) return;

  let uploadWrapper = document.getElementById("caseFilesUploadWrapper");
  if (!uploadWrapper) {
    uploadWrapper = document.createElement("div");
    uploadWrapper.id = "caseFilesUploadWrapper";
    uploadWrapper.innerHTML = `
      <div>
        <select id="caseFileCaseSelect"></select>
        <input type="file" id="caseFileInput" />
        <button type="button" class="btn primary" id="caseFileUploadBtn">Upload</button>
      </div>
    `;
    const filtersBlock = document.querySelector(".filters");
    host.insertBefore(uploadWrapper, filtersBlock || host.firstChild);
  }

  let listHost = document.getElementById("caseFilesList");
  if (!listHost) {
    listHost = document.createElement("div");
    listHost.id = "caseFilesList";
    const container = document.getElementById("caseFilesContainer");
    host.insertBefore(listHost, container || null);
  }

  const caseSelect = document.getElementById("caseFileCaseSelect");
  if (caseSelect) {
    caseSelect.innerHTML = "";
    if (!cases.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No cases available";
      caseSelect.appendChild(option);
      caseSelect.disabled = true;
      state.caseFiles.selectedCaseId = null;
    } else {
      cases.forEach((caseItem) => {
        const option = document.createElement("option");
        option.value = String(caseItem.id);
        option.textContent = caseItem.title || "Untitled Case";
        caseSelect.appendChild(option);
      });
      caseSelect.disabled = false;
      if (state.caseFiles.selectedCaseId) {
        caseSelect.value = String(state.caseFiles.selectedCaseId);
      }
    }
    if (!caseSelect.dataset.bound) {
      caseSelect.dataset.bound = "true";
      caseSelect.addEventListener("change", () => {
        state.caseFiles.selectedCaseId = caseSelect.value || null;
        refreshCaseFilesList();
      });
    }
  }

  const uploadBtn = document.getElementById("caseFileUploadBtn");
  if (uploadBtn && !uploadBtn.dataset.bound) {
    uploadBtn.dataset.bound = "true";
    uploadBtn.addEventListener("click", handleCaseFileUpload);
  }
}

async function refreshCaseFilesList() {
  const caseId = state.caseFiles.selectedCaseId;
  if (!caseId) {
    state.caseFiles.files = [];
    state.caseFiles.loading = false;
    state.caseFiles.error = "";
    renderModernCaseFilesList();
    return;
  }
  state.caseFiles.loading = true;
  state.caseFiles.error = "";
  renderModernCaseFilesList();
  try {
    const res = await secureFetch(`/api/uploads/case/${encodeURIComponent(caseId)}`, {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.msg || payload?.error || "Unable to load files.");
    }
    state.caseFiles.files = Array.isArray(payload.files) ? payload.files : [];
  } catch (err) {
    state.caseFiles.files = [];
    state.caseFiles.error = err?.message || "Unable to load files.";
  } finally {
    state.caseFiles.loading = false;
    renderModernCaseFilesList();
  }
}

function renderModernCaseFilesList() {
  const listHost = document.getElementById("caseFilesList");
  if (!listHost) return;
  const caseId = state.caseFiles.selectedCaseId;
  if (!caseId) {
    listHost.innerHTML = `<p style="color:var(--muted);font-size:.95rem;">Select a case to view its files.</p>`;
    return;
  }
  if (state.caseFiles.loading) {
    listHost.innerHTML = `<p style="color:var(--muted);font-size:.95rem;">Loading files…</p>`;
    return;
  }
  if (state.caseFiles.error) {
    listHost.innerHTML = `<p style="color:#b91c1c;font-size:.95rem;">${sanitize(state.caseFiles.error)}</p>`;
    return;
  }
  if (!state.caseFiles.files.length) {
    listHost.innerHTML = `<p style="color:var(--muted);font-size:.95rem;">No files uploaded yet.</p>`;
    return;
  }
  listHost.innerHTML = state.caseFiles.files
    .map((file) => {
      const safeName = sanitize(file.originalName || "Document");
      const uploadedAt = file.createdAt ? new Date(file.createdAt).toLocaleString() : "Unknown date";
      const sizeText = formatBytes(file.size);
      return `
        <div class="case-file-row">
          <div>
            <div class="file-name">${safeName}</div>
            <div class="file-meta">${sanitize(uploadedAt)}${sizeText ? ` · ${sanitize(sizeText)}` : ""}</div>
          </div>
          <a class="btn secondary" href="/api/uploads/case/${encodeURIComponent(caseId)}/${encodeURIComponent(file.id)}/download">Download</a>
        </div>
      `;
    })
    .join("");
}

async function handleCaseFileUpload() {
  const caseId = state.caseFiles.selectedCaseId;
  if (!caseId) {
    notifyCases("Select a case before uploading.", "error");
    return;
  }
  const input = document.getElementById("caseFileInput");
  const btn = document.getElementById("caseFileUploadBtn");
  if (!input || !input.files || !input.files.length) {
    notifyCases("Choose a file to upload.", "error");
    return;
  }
  const file = input.files[0];
  if (!file || file.size <= 0) {
    notifyCases("Selected file is empty.", "error");
    return;
  }
  if (file.size > CASE_FILE_MAX_BYTES) {
    notifyCases("Files must be 20MB or less.", "error");
    return;
  }
  btn.disabled = true;
  const originalText = btn.textContent || "Upload";
  btn.textContent = "Uploading…";
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await secureFetch(`/api/uploads/case/${encodeURIComponent(caseId)}`, {
      method: "POST",
      body: form,
      noRedirect: true,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.msg || payload?.error || "Upload failed.");
    }
    input.value = "";
    notifyCases("File uploaded.", "info");
    await refreshCaseFilesList();
  } catch (err) {
    console.error(err);
    notifyCases(err?.message || "Unable to upload file.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function initCaseFilesPage() {
  await loadCasesWithFiles();
  await loadArchivedCases();
  setupCaseFilesUploadUI();
  await refreshCaseFilesList();
  const filters = document.querySelectorAll(".filters button");
  filters.forEach((btn) => {
    btn.addEventListener("click", () => {
      filters.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.caseFilter = btn.getAttribute("data-filter") || "all";
      renderCaseFilesList();
    });
  });
  renderCaseFilesList();

  const container = document.getElementById("caseFilesContainer");
  container?.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-file-action]");
    if (!target) return;
    const action = target.getAttribute("data-file-action");
    const caseId = target.getAttribute("data-case-id");
    const fileKey = target.getAttribute("data-file-key");
    const fileName = target.getAttribute("data-file-name");
    if (!caseId || !fileKey) return;
    try {
      await openFile(caseId, fileKey, action, fileName);
    } catch (err) {
      console.warn(err);
      alert("Unable to open the file.");
    }
  });
}

function renderCaseFilesList() {
  const container = document.getElementById("caseFilesContainer");
  if (!container) return;
  const cases = [...state.cases, ...state.casesArchived];
  if (!cases.length) {
    container.innerHTML = `<p style="color:var(--muted);font-size:.95rem;">You have not attached any files to your cases.</p>`;
    return;
  }
  container.innerHTML = cases
    .map((caseItem) => {
      const files = (caseItem.files || []).filter((file) => {
        if (state.caseFilter === "all") return true;
        return file.status === state.caseFilter;
      });
      const rows = files.length
        ? files
            .map(
              (file) => `
        <div class="file-item" data-file-id="${file.id}">
          <div class="file-info">
            <h3 class="file-name" data-file-action="view" data-case-id="${caseItem.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}">${sanitize(file.filename || file.original || "Document")}</h3>
            <p>${sanitize(file.uploadedByRole || "Contributor")} · ${file.uploadedAt ? new Date(file.uploadedAt).toLocaleDateString() : "Unknown"} · Status: ${STATUS_LABELS[file.status] || file.status}</p>
          </div>
          <div class="file-actions">
            <button class="btn secondary" type="button" data-file-action="view" data-case-id="${caseItem.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}">View</button>
            <button class="btn secondary" type="button" data-file-action="download" data-case-id="${caseItem.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}">Download</button>
            <button class="btn secondary" type="button" data-file-action="print" data-case-id="${caseItem.id}" data-file-key="${file.key}" data-file-name="${sanitize(file.filename)}">Print</button>
          </div>
        </div>`
            )
            .join("")
        : `<p style="color:var(--muted);font-size:.9rem;">No files match this filter.</p>`;

      return `
        <div class="case-block">
          <h2>${sanitize(caseItem.title || "Untitled Case")}</h2>
          ${rows}
        </div>
      `;
    })
    .join("");
}

// -------------------------
// Tasks Page
// -------------------------
async function initTasksPage() {
  setupTaskCreation();
  await Promise.all([loadCasesWithFiles(), loadTasks()]);
  renderTasks();
  bindTaskEvents();
}

async function loadTasks() {
  try {
    const res = await secureFetch("/api/checklist?status=all&limit=200", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Task fetch failed");
    const payload = await res.json();
    state.tasks = Array.isArray(payload.items) ? payload.items : [];
  } catch (err) {
    console.warn("Unable to load tasks", err);
    state.tasks = [];
  }
}

function renderTasks() {
  const container = document.getElementById("taskColumns");
  if (!container) return;
  if (!state.tasks.length) {
    container.innerHTML = `<section class="task-column"><h2>To Do</h2><p style="color:var(--muted);font-size:0.9rem;">No tasks yet.</p></section>`;
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
    ${renderTaskColumn("To Do", todo)}
    ${renderTaskColumn("In Progress", inProgress)}
    ${renderTaskColumn("Review", done)}
  `;
}

function renderTaskColumn(title, tasks) {
  if (!tasks.length) {
    return `<section class="task-column"><h2>${title}</h2><p style="color:var(--muted);font-size:0.85rem;">No tasks.</p></section>`;
  }
  const map = state.caseLookup;
  const rows = tasks
    .map((task) => {
      const caseTitle = map.get(String(task.caseId))?.title || "";
      const due = task.due ? new Date(task.due).toLocaleDateString() : "No due date";
      return `
        <article class="task-card" data-task-id="${task.id}">
          <h3>${sanitize(task.title)}</h3>
          <p>${sanitize(task.notes || "")}</p>
          <div class="task-meta">
            <span>Due: ${due}</span>
            <span>${sanitize(caseTitle)}</span>
          </div>
        </article>
      `;
    })
    .join("");
  return `<section class="task-column"><h2>${title}</h2>${rows}</section>`;
}

function bindTaskEvents() {
  const container = document.getElementById("taskColumns");
  const modal = document.getElementById("taskDetailModal");
  container?.addEventListener("click", (event) => {
    const card = event.target.closest(".task-card");
    if (!card) return;
    const id = card.getAttribute("data-task-id");
    const task = state.tasks.find((t) => String(t.id) === String(id));
    if (!task) return;
    openTaskModal(task);
  });

  modal?.querySelector("[data-close-task-modal]")?.addEventListener("click", () => toggleModal(modal, false));
  modal?.querySelector("[data-toggle-task]")?.addEventListener("click", async () => {
    const taskId = modal?.getAttribute("data-task-id");
    if (!taskId) return;
    try {
      const res = await secureFetch(`/api/checklist/${taskId}/toggle`, { method: "POST" });
      if (!res.ok) throw new Error("toggle failed");
      await loadTasks();
      renderTasks();
      toggleModal(modal, false);
      notifyTasks("Task updated.", "success");
    } catch (err) {
      console.error(err);
      notifyTasks("Unable to update task.", "error");
    }
  });
}

function openTaskModal(task) {
  const modal = document.getElementById("taskDetailModal");
  if (!modal) return;
  modal.setAttribute("data-task-id", task.id);
  const caseTitle = state.caseLookup.get(String(task.caseId))?.title || "Unassigned case";
  const notesEl = document.getElementById("taskDetailNotes");
  const metaEl = document.getElementById("taskDetailMeta");
  const toggleBtn = modal.querySelector("[data-toggle-task]");
  document.getElementById("taskDetailTitle").textContent = task.title || "Task";
  if (notesEl) notesEl.textContent = task.notes || "No additional notes.";
  if (metaEl) {
    const due = task.due ? new Date(task.due).toLocaleString() : "No due date";
    metaEl.innerHTML = `<strong>Case:</strong> ${sanitize(caseTitle)}<br/><strong>Due:</strong> ${due}`;
  }
  if (toggleBtn) {
    toggleBtn.textContent = task.done ? "Mark Incomplete" : "Mark Complete";
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
  modal.querySelector("[data-close-task-create]")?.addEventListener("click", () => toggleModal(modal, false));
  form?.addEventListener("submit", submitTaskCreate);
}

function populateTaskCaseOptions() {
  const select = document.querySelector("[data-task-case]");
  if (!select) return;
  const combinedCases = [...state.cases, ...state.casesArchived];
  const options = [
    `<option value="">Select a case (optional)</option>`,
    ...combinedCases.map(
      (caseItem) => `<option value="${caseItem.id}">${sanitize(caseItem.title || "Case")}</option>`
    ),
  ];
  select.innerHTML = options.join("");
}

async function submitTaskCreate(event) {
  event.preventDefault();
  const form = event.target;
  const modal = document.getElementById("taskCreateModal");
  const submitBtn = form.querySelector('button[type="submit"]');
  const title = form.title.value.trim();
  const caseId = form.caseId.value;
  const due = form.due.value;
  const notes = form.notes.value.trim();
  if (!title) {
    notifyTasks("Task title is required.", "error");
    form.title.focus();
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
    if (!res.ok) throw new Error("Unable to create task.");
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
  closed: "Closed",
};
const CASE_STATUS_CLASSES = {
  open: "public",
  "in progress": "private",
  in_progress: "private",
  completed: "accepted",
  disputed: "declined",
  closed: "declined",
};

async function initCasesPage() {
  const wrapper = document.querySelector("[data-cases-wrapper]");
  if (!wrapper) return;

  const searchInput = document.querySelector("[data-cases-search]");
  const tabs = document.querySelectorAll("[data-case-filter]");

  try {
    await Promise.all([loadCasesWithFiles(), loadArchivedCases(), loadApplicationsForMyJobs(), loadCaseDrafts()]);
  } catch (err) {
    console.warn("Unable to load cases", err);
  }
  renderCasesView();

  searchInput?.addEventListener("input", (event) => {
    state.casesSearchTerm = event.target.value.trim().toLowerCase();
    renderCasesView();
  });

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.caseFilter;
      if (!target || target === state.casesViewFilter) return;
      setCaseFilter(target);
    });
  });

  wrapper.addEventListener("click", onCasesTableClick);
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

  document.querySelectorAll("[data-case-quick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const quick = btn.dataset.caseQuick;
      if (quick === "create") {
        window.location.href = "create-case.html";
      }
    });
  });
  document.querySelectorAll("[data-archived-bulk]").forEach((btn) => {
    btn.addEventListener("click", onArchivedBulkAction);
  });
  setupCaseNoteModal();
  window.addEventListener("lpc-case-notes-updated", async (event) => {
    const targetId = event?.detail?.caseId;
    if (!targetId) return;
    try {
      const payload = await fetchCaseNote(targetId);
      applyNoteToState(targetId, payload);
      renderCasesView();
    } catch (err) {
      console.warn("External note refresh failed", err);
    }
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
      if (!res.ok) throw new Error("Archived case fetch failed");
      const data = await res.json();
      state.casesArchived = Array.isArray(data) ? data : [];
      buildCaseLookup();
    } catch (err) {
      console.error(err);
      state.casesArchived = [];
    } finally {
      state.casesArchivedPromise = null;
    }
    return state.casesArchived;
  })();
  return state.casesArchivedPromise;
}

function renderCasesView() {
  if (state.casesViewFilter !== "archived" && state.archivedSelection.size) {
    state.archivedSelection.clear();
  }
  pruneArchivedSelection();
  state.localDrafts = readLocalDrafts();
  const totals = computeCaseCounts();
  Object.entries(totals).forEach(([key, count]) => {
    const target = document.querySelector(`[data-case-count="${key}"]`);
    if (target) target.textContent = String(count);
  });

  CASE_VIEW_FILTERS.forEach((key) => {
    const body = document.querySelector(`[data-table-body="${key}"]`);
    if (!body) return;
    const records = getCasesByFilter(key, { applySearch: key === state.casesViewFilter });
    if (!records.length) {
      const searchActive = state.casesSearchTerm && key === state.casesViewFilter;
      const message = searchActive ? "No cases match your search." : "No cases in this category.";
      const span = key === "archived" ? 9 : 8;
      body.innerHTML = `<tr><td colspan="${span}" class="empty-row">${message}</td></tr>`;
      return;
    }
    body.innerHTML = records.map((item) => renderCaseRow(item, key)).join("");
  });
  syncArchivedBulkUI();
  maybeHighlightArchivedCase();
}

function computeCaseCounts() {
  const counts = {
    active: 0,
    draft: Array.isArray(state.localDrafts) ? state.localDrafts.length : 0,
    archived: state.casesArchived.length,
    inquiries: 0,
  };
  state.cases.forEach((item) => {
    if (isTerminalCase(item)) return;
    const bucket = categorizeCase(item);
    if (counts[bucket] !== undefined) counts[bucket] += 1;
  });
  return counts;
}

function getCasesByFilter(filterKey, { applySearch = false } = {}) {
  let source = filterKey === "archived" ? state.casesArchived : state.cases;
  if (filterKey !== "archived") {
    source = source.filter((item) => !isTerminalCase(item) && categorizeCase(item) === filterKey);
  }
  if (filterKey === "draft" && Array.isArray(state.localDrafts) && state.localDrafts.length) {
    source = [...state.localDrafts, ...source];
  }
  let records = [...source];
  records.sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
  if (applySearch && state.casesSearchTerm) {
    records = records.filter((item) => matchesCaseSearch(item, state.casesSearchTerm));
  }
  return records;
}

function categorizeCase(item) {
  if (item.archived) return "archived";
  if (item.localDraft) return "draft";
  const status = String(item.status || "").toLowerCase();
  const applicantCount = Number(
    item.applicantsCount ?? (Array.isArray(item.applicants) ? item.applicants.length : item.applicants) ?? 0
  );
  if (!item.paralegal && applicantCount > 0) return "inquiries";
  if (status === "draft") return "draft";
  return "active";
}

function matchesCaseSearch(item, term) {
  if (!term) return true;
  const haystack = [
    item.title,
    item.practiceArea,
    item.details,
    item.paralegal?.name,
    item.paralegal?.firstName,
    item.paralegal?.lastName,
    item.internalNotes?.note,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(term);
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
  const resumeURL = applicant?.resumeURL || "";
  const linkedInURL = applicant?.linkedInURL || "";
  return {
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
    resumeURL,
    linkedInURL,
  };
}

function buildApplicantDrawerRow(applicant, index, caseId) {
  const avatar = applicant.avatar
    ? `<img src="${sanitize(applicant.avatar)}" alt="${sanitize(applicant.name)} profile photo" />`
    : `<span>${sanitize((applicant.name || "P")[0] || "P")}</span>`;
  const appliedText = formatApplicantDate(applicant.appliedAt);
  const stateText = applicant.state || "—";
  const experienceText = formatApplicantExperience(applicant.yearsExperience);
  const metaParts = [appliedText, stateText, experienceText].filter(Boolean);
  const metaHtml = metaParts.map((part) => `<span>${sanitize(part)}</span>`).join('<span class="dot">•</span>');
  return `
    <div class="applicant-card" data-applicant-row data-case-id="${sanitize(caseId)}" data-applicant-index="${index}">
      <div class="applicant-card-top">
        <div class="applicant-avatar">${avatar}</div>
        <div class="applicant-card-info">
          <div class="applicant-card-name">
            <span class="applicant-name legacy-font">${sanitize(applicant.name)}</span>
          </div>
          <div class="applicant-card-meta">${metaHtml}</div>
        </div>
      </div>
    </div>
  `;
}

function buildApplicantDetail(applicant, { caseId } = {}) {
  const caseItem = caseId ? state.caseLookup.get(String(caseId)) : null;
  const statusKey = normalizeCaseStatus(caseItem?.status);
  const canHire =
    !!caseId &&
    !!applicant.paralegalId &&
    statusKey === "open" &&
    !hasAssignedParalegal(caseItem) &&
    !caseItem?.readOnly;
  const returnTo = caseId && applicant.paralegalId ? buildApplicantReturnUrl(caseId, applicant.paralegalId) : "";
  const profileLink = applicant.paralegalId
    ? buildParalegalProfileUrl(applicant.paralegalId, { returnTo })
    : "";
  const resumeURL = applicant.resumeURL || "";
  const resumeIsHttp = isHttpUrl(resumeURL);
  const resumeKey = resumeIsHttp ? "" : normalizeDocKey(resumeURL);
  const linkedInURL = applicant.linkedInURL || "";
  const casePractice = titleCaseWords(caseItem?.practiceArea || caseItem?.field || "");
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
  const detailMeta = [locationLabel, casePractice, experienceShort !== "—" ? experienceShort : ""]
    .filter(Boolean)
    .join(" • ");
  const profileDetails = [];
  if (casePractice) profileDetails.push(`Practice area: ${casePractice}`);
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
  const coverMarkup = cover
    ? `<div class="applicant-cover-box">${sanitize(cover).replace(/\n/g, "<br>")}</div>`
    : `<div class="applicant-cover-box muted">No cover note provided.</div>`;
  const safeProfileLink = sanitizeUrl(profileLink);
  const safeResumeUrl = sanitizeUrl(resumeURL);
  const safeLinkedInUrl = sanitizeUrl(linkedInURL);
  const profileMarkup = safeProfileLink
    ? `<a href="${sanitize(safeProfileLink)}" class="applicant-side-btn">View full profile</a>`
    : `<span class="applicant-side-btn muted" aria-disabled="true">Profile unavailable</span>`;
  const resumeMarkup = resumeURL
    ? resumeIsHttp && safeResumeUrl
      ? `<a href="${sanitize(safeResumeUrl)}" target="_blank" rel="noopener" class="applicant-side-btn">Résumé</a>`
      : `<a href="#" data-applicant-doc data-doc-key="${sanitize(resumeKey)}" class="applicant-side-btn">Résumé</a>`
    : `<span class="applicant-side-btn muted" aria-disabled="true">No résumé</span>`;
  const linkedInMarkup = safeLinkedInUrl
    ? `<a href="${sanitize(safeLinkedInUrl)}" target="_blank" rel="noopener" class="applicant-side-btn">LinkedIn</a>`
    : `<span class="applicant-side-btn muted" aria-disabled="true">LinkedIn unavailable</span>`;
  const firstName = String(applicant.name || "Paralegal").split(" ")[0] || "Paralegal";
  const hireMarkup = canHire
    ? `<button type="button" class="applicant-side-hire" data-hire-paralegal data-case-id="${sanitize(
        caseId
      )}" data-paralegal-id="${sanitize(applicant.paralegalId)}" data-paralegal-name="${sanitize(
        applicant.name || "Paralegal"
      )}">Hire ${sanitize(firstName)}</button>`
    : "";
  return `
    <div class="applicant-detail-grid">
      <div class="applicant-detail-main">
        <div class="applicant-detail-name">Cover note</div>
        <div class="applicant-detail-divider"></div>
        <div class="applicant-detail-section">
          ${coverMarkup}
        </div>
        <div class="applicant-detail-section">
          <div class="applicant-detail-section-title">Profile details</div>
          ${profileDetailsMarkup}
        </div>
      </div>
      <aside class="applicant-detail-side">
        <div class="applicant-side-card">
          <div class="applicant-side-name">${sanitize(applicant.name || "Applicant")}</div>
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
  let client = item.paralegal?.name || item.paralegalNameSnapshot || "Awaiting hire";
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
  const created = formatCaseDate(item.createdAt || item.updatedAt);
  const updated = formatCaseDate(item.updatedAt || item.completedAt || item.createdAt);
  const displayedDate =
    filterKey === "draft" ? updated : filterKey === "archived" ? updated : created;
  const statusText = item.localDraft ? "Draft" : formatCaseStatus(item.status);
  const statusClass = item.localDraft ? "pending" : getStatusClass(item.status);
  const amountDisplay = formatCaseAmount(item);
  const canViewWorkspace = isWorkspaceEligibleCase(item);
  const caseId = item.id || item.caseId || item._id || "";
  const returnContext = getApplicantReturnContext();
  const shouldOpenDrawer =
    filterKey === "inquiries" && returnContext && String(returnContext.caseId) === String(caseId);
  const applicantCount = Number(
    item.applicantsCount ?? (Array.isArray(item.applicants) ? item.applicants.length : item.applicants) ?? 0
  );
  const selectionCell =
    filterKey === "archived"
      ? `<td class="case-select"><input type="checkbox" data-archived-select value="${item.id}" ${
          state.archivedSelection.has(String(item.id)) ? "checked" : ""
        } aria-label="Select case ${sanitize(item.title || "Untitled Case")}" /></td>`
      : "";
  const applicantsToggle =
    filterKey === "inquiries"
      ? `<button type="button" class="applicant-toggle" data-applicants-toggle data-case-id="${sanitize(
          caseId
        )}" aria-expanded="${shouldOpenDrawer ? "true" : "false"}"${
          caseId ? "" : ' disabled aria-disabled="true"'
        }>Applicants (${applicantCount || 0})</button>`
      : "";
  const actionsCell = `
      <td class="actions">
        <div class="case-actions-inline">
          ${applicantsToggle}
          ${renderCaseMenu(item)}
        </div>
      </td>`;
  const drawerRow =
    filterKey === "inquiries"
      ? `
    <tr class="applicant-drawer-row${shouldOpenDrawer ? "" : " hidden"}" data-applicants-row data-case-id="${sanitize(
          caseId
        )}">
      <td colspan="8">
        <div class="applicant-drawer" data-applicants-drawer data-case-id="${sanitize(caseId)}">
          <div class="applicant-drawer-header">
            <div class="applicant-drawer-title">Applicants for ${sanitize(item.title || "Case")}</div>
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
    <tr data-case-id="${sanitize(caseId)}">
      ${selectionCell}
      <td>${
        item.localDraft
          ? `<a href="create-case.html#description">${sanitize(item.title || "Untitled Case")}</a>`
          : canViewWorkspace
          ? `<a href="case-detail.html?caseId=${encodeURIComponent(caseId)}">${sanitize(item.title || "Untitled Case")}</a>`
          : `<span>${sanitize(item.title || "Untitled Case")}</span>`
      }</td>
      <td>${sanitize(client)}</td>
      <td>${sanitize(practice)}</td>
      <td><span class="status ${statusClass}">${statusText}</span></td>
      <td>${sanitize(amountDisplay)}</td>
      <td>${displayedDate}</td>
      ${actionsCell}
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
  const hasAssigned = hasAssignedParalegal(item);
  const statusKey = normalizeCaseStatus(item.status);
  if (statusKey === "in progress") {
    return "";
  }
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
    (statusKey === "open" || statusKey === "draft" || !statusKey);
  if (item.localDraft) {
    return `
    <div class="case-actions" data-case-id="${baseCaseId}">
      <button class="menu-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" data-case-menu-trigger>⋯</button>
      <div class="case-menu" id="${menuId}" role="menu" style="width: 180px; min-width: 180px;">
        <button type="button" class="menu-item" data-case-action="resume-draft" data-case-id="${baseCaseId}">Resume Draft</button>
        <button type="button" class="menu-item danger" data-case-action="discard-draft" data-case-id="${baseCaseId}">Discard Draft</button>
      </div>
    </div>
    `;
  }
  const parts = [];
  if (canEditCase) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="edit-case" data-case-id="${baseCaseId}">Edit Case</button>`
    );
  }
  if (!item.archived) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="details" data-case-id="${baseCaseId}">View Details</button>`
    );
  }
  if (canViewWorkspace) {
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
  if (hasDeliverables(item) && !item.archived) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="download" data-case-id="${baseCaseId}">Download Files</button>`
    );
  }
  if (isFinal) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="download-receipt" data-case-id="${baseCaseId}">Download Receipt</button>`
    );
  }
  if (item.archived) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="download-archive" data-case-id="${baseCaseId}">Download Archive</button>`
    );
    if (!isFinal) {
      parts.push(
        `<button type="button" class="menu-item" data-case-action="restore" data-case-id="${baseCaseId}">Restore Case</button>`
      );
    }
  } else if (!hasAssigned) {
    parts.push(
      `<button type="button" class="menu-item danger" data-case-action="archive" data-case-id="${baseCaseId}">Archive Case</button>`
    );
  }
  parts.push(
    `<button type="button" class="menu-item danger" data-case-action="delete-case" data-case-id="${baseCaseId}">Delete Case</button>`
  );
  return `
    <div class="case-actions" data-case-id="${baseCaseId}">
      <button class="menu-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" data-case-menu-trigger>⋯</button>
      <div class="case-menu" id="${menuId}" role="menu" style="width: 180px; min-width: 180px;">
        ${parts.join("")}
      </div>
    </div>
  `;
}

function closeApplicantsDrawer(drawerRow, toggleBtn) {
  if (drawerRow) drawerRow.classList.add("hidden");
  if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
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
  if (!applicants.length) {
    body.innerHTML = `<div class="applicant-card empty-card">No applications yet.</div>`;
    const detail = drawerEl.querySelector("[data-applicant-detail]");
    if (detail) {
      detail.innerHTML = "";
      detail.classList.add("hidden");
    }
    return;
  }
  body.innerHTML = applicants.map((applicant, index) => buildApplicantDrawerRow(applicant, index, caseId)).join("");
  drawerEl.querySelectorAll("[data-applicant-row]").forEach((row) => row.classList.remove("is-active"));
  showApplicantDetail(caseId, 0, drawerEl);
}

async function loadApplicantsForDrawer(caseId, drawerEl) {
  if (!caseId || !drawerEl) return;
  const body = drawerEl.querySelector("[data-applicants-body]");
  if (body) {
    body.innerHTML = `<div class="applicant-card empty-card">Loading applicants…</div>`;
  }
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error || "Unable to load applicants.");
    }
    const applicantsRaw = Array.isArray(payload?.applicants) ? payload.applicants : [];
    const applicants = applicantsRaw.map((applicant) => normalizeApplicantData(applicant));
    applicantDrawerCache.set(caseId, applicants);
    renderApplicantsInDrawer(caseId, applicants, drawerEl);
  } catch (err) {
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
    drawerEl.dataset.loaded = "true";
  }
}

function showApplicantDetail(caseId, index, drawerEl) {
  if (!drawerEl || !caseId) return;
  const applicants = applicantDrawerCache.get(caseId) || [];
  const applicant = applicants[index];
  if (!applicant) return;
  drawerEl.querySelectorAll("[data-applicant-row]").forEach((row) => row.classList.remove("is-active"));
  const activeRow = drawerEl.querySelector(`[data-applicant-row][data-applicant-index="${index}"]`);
  if (activeRow) activeRow.classList.add("is-active");
  const detail = drawerEl.querySelector("[data-applicant-detail]");
  if (!detail) return;
  detail.innerHTML = buildApplicantDetail(applicant, { caseId });
  detail.classList.remove("hidden");
}

function showApplicantDetailById(caseId, applicantId, drawerEl) {
  if (!drawerEl || !caseId || !applicantId) return;
  const applicants = applicantDrawerCache.get(caseId) || [];
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
    window.open(payload.url, "_blank", "noopener");
  } catch (err) {
    notifyCases(err?.message || "Unable to open document.", "error");
  }
}

function pruneArchivedSelection() {
  if (!state.archivedSelection) state.archivedSelection = new Set();
  if (!state.archivedSelection.size) return;
  const valid = new Set((state.casesArchived || []).map((c) => String(c.id)));
  state.archivedSelection.forEach((id) => {
    if (!valid.has(id)) state.archivedSelection.delete(id);
  });
}

async function loadCaseDrafts() {
  try {
    const res = await secureFetch("/api/case-drafts?limit=200", {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    if (!res.ok) throw new Error("Draft fetch failed");
    const payload = await res.json().catch(() => ({}));
    const items = Array.isArray(payload?.items) ? payload.items : [];
    state.localDrafts = items.map((item) => ({
      id: item.id,
      title: item.title || "Untitled Case",
      practiceArea: item.practiceArea || "",
      details: item.description || "",
      state: item.state || "",
      status: "draft",
      createdAt: item.createdAt || item.updatedAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      localDraft: true,
    }));
  } catch (err) {
    console.warn("Unable to load drafts", err);
    state.localDrafts = [];
  }
}

function readLocalDrafts() {
  return Array.isArray(state.localDrafts) ? state.localDrafts : [];
}

async function removeLocalDraft(draftId) {
  if (!draftId) return;
  try {
    const res = await secureFetch(`/api/case-drafts/${encodeURIComponent(draftId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    if (!res.ok) throw new Error("Unable to delete draft");
  } catch (err) {
    console.warn(err);
  } finally {
    state.localDrafts = readLocalDrafts().filter((item) => String(item.id) !== String(draftId));
  }
}

function syncArchivedBulkUI() {
  const bar = document.querySelector("[data-archived-bulk-bar]");
  if (!bar) return;
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
  bulkButtons.forEach((btn) => (btn.disabled = selectedCount === 0));

  if (selectAll) {
    const totalVisible = checkboxes.length;
    const selectedVisible = checkboxes.filter((cb) => cb.checked).length;
    selectAll.checked = totalVisible > 0 && selectedVisible === totalVisible;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < totalVisible;
  }
}

function hasDeliverables(item) {
  return (
    (Array.isArray(item.downloadUrl) && item.downloadUrl.length > 0) ||
    (Array.isArray(item.files) && item.files.length > 0)
  );
}

function canEditCaseNotes() {
  const role = String(state.user?.role || "").toLowerCase();
  return role === "attorney" || role === "admin";
}

let caseNoteModalRef = null;
let caseNoteTextarea = null;
let caseNoteSaveBtn = null;
let caseNoteCancelBtn = null;
let caseNoteTargetId = null;
let caseNoteSaving = false;

function setupCaseNoteModal() {
  caseNoteModalRef = document.getElementById("caseNoteModal");
  if (!caseNoteModalRef) return;
  caseNoteTextarea = document.getElementById("caseNoteTextarea") || caseNoteModalRef.querySelector("textarea");
  caseNoteSaveBtn = caseNoteModalRef.querySelector("[data-note-save]");
  caseNoteCancelBtn = caseNoteModalRef.querySelector("[data-note-cancel]");
  caseNoteCancelBtn?.addEventListener("click", closeCaseNoteModal);
  caseNoteModalRef.addEventListener("click", (event) => {
    if (event.target === caseNoteModalRef) {
      closeCaseNoteModal();
    }
  });
  caseNoteSaveBtn?.addEventListener("click", async () => {
    if (!caseNoteTargetId || caseNoteSaving) return;
    const note = caseNoteTextarea?.value?.trim() || "";
    await persistCaseNote(caseNoteTargetId, note);
  });
}

function closeCaseNoteModal() {
  if (caseNoteModalRef) {
    caseNoteModalRef.classList.add("hidden");
    caseNoteModalRef.removeAttribute("aria-busy");
  }
  caseNoteTargetId = null;
}

async function openCaseNoteModal(caseId) {
  if (!caseId || !caseNoteModalRef) return;
  caseNoteTargetId = caseId;
  caseNoteModalRef.classList.remove("hidden");
  caseNoteModalRef.removeAttribute("aria-hidden");
  if (caseNoteTextarea) {
    caseNoteTextarea.value = "";
    caseNoteTextarea.focus();
  }
  try {
    const payload = await fetchCaseNote(caseId);
    if (caseNoteTextarea && payload?.note) {
      caseNoteTextarea.value = payload.note;
    }
  } catch (err) {
    notifyCases(err?.message || "Unable to load notes.", "error");
  }
}

async function fetchCaseNote(caseId) {
  const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/notes`, {
    headers: { Accept: "application/json" },
    noRedirect: true,
  });
  if (!res.ok) throw new Error("Unable to load notes.");
  return res.json();
}

async function persistCaseNote(caseId, note) {
  caseNoteSaving = true;
  if (caseNoteSaveBtn) {
    caseNoteSaveBtn.disabled = true;
    caseNoteSaveBtn.textContent = "Saving…";
  }
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/notes`, {
      method: "PUT",
      headers: { Accept: "application/json" },
      body: { note },
    });
    if (!res.ok) throw new Error("Unable to save note.");
    const payload = await res.json();
    applyNoteToState(caseId, payload);
    renderCasesView();
    closeCaseNoteModal();
    notifyCases("Note updated.", "success");
  } catch (err) {
    console.warn("Note save failed", err);
    notifyCases(err?.message || "Unable to save note.", "error");
  } finally {
    caseNoteSaving = false;
    if (caseNoteSaveBtn) {
      caseNoteSaveBtn.disabled = false;
      caseNoteSaveBtn.textContent = "Save Note";
    }
  }
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
const CASE_EDIT_PREFILL_KEY = "lpc_case_edit_prefill";

function cacheCaseEditPrefill(caseId, payload = {}) {
  if (!caseId) return;
  try {
    sessionStorage.setItem(CASE_EDIT_PREFILL_KEY, JSON.stringify({ caseId: String(caseId), payload }));
  } catch {}
}

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
      const payload = casePreviewModalRef?.dataset?.editPayload
        ? JSON.parse(casePreviewModalRef.dataset.editPayload)
        : null;
      if (payload) {
        cacheCaseEditPrefill(caseId, payload);
      }
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
    casePreviewModalRef.removeAttribute("aria-busy");
  }
  if (casePreviewFields?.receipt) {
    casePreviewFields.receipt.hidden = true;
    casePreviewFields.receipt.removeAttribute("href");
  }
  casePreviewTargetId = null;
  if (casePreviewModalRef) {
    delete casePreviewModalRef.dataset.caseId;
    delete casePreviewModalRef.dataset.editPayload;
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
  try {
    const stored = sessionStorage.getItem(CASE_PREVIEW_STORAGE_KEY);
    return stored || null;
  } catch {
    return null;
  }
}

function clearCasePreviewQuery() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has("previewCaseId")) {
      url.searchParams.delete("previewCaseId");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {}
  try {
    sessionStorage.removeItem(CASE_PREVIEW_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  casePreviewFromQueryHandled = false;
}

function getCasePreviewReceipt(caseId) {
  try {
    const raw = sessionStorage.getItem(CASE_PREVIEW_RECEIPT_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || String(payload.caseId) !== String(caseId)) return null;
    return String(payload.receiptUrl || "").trim() || null;
  } catch {
    return null;
  }
}

function clearCasePreviewReceipt() {
  try {
    sessionStorage.removeItem(CASE_PREVIEW_RECEIPT_KEY);
  } catch {
    /* ignore */
  }
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
  if (caseInvitesModalRef) {
    caseInvitesModalRef.classList.add("hidden");
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
  if (!returnFromProfile && !openApplicant) return null;
  if (!caseId || !applicantId) return null;
  return { caseId, applicantId };
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
      !url.searchParams.has("openApplicant")
    )
      return;
    url.searchParams.delete("caseId");
    url.searchParams.delete("applicantId");
    url.searchParams.delete("returnFromProfile");
    url.searchParams.delete("openApplicant");
    const nextQuery = url.searchParams.toString();
    const nextUrl = `${url.pathname}${nextQuery ? `?${nextQuery}` : ""}${url.hash}`;
    window.history.replaceState({}, "", nextUrl);
  } catch {}
}

async function openApplicantFromQuery({ setFilter = true } = {}) {
  const context = getApplicantReturnContext();
  if (!context) return;
  const { caseId, applicantId } = context;
  applicantReturnContext = context;
  if (setFilter) {
    setCaseFilter("inquiries", { render: false });
  }
  const toggleBtn = document.querySelector(`[data-applicants-toggle][data-case-id="${caseId}"]`);
  if (!toggleBtn) return;
  const drawerRow = getDrawerRow(caseId, toggleBtn);
  const drawerEl = getDrawerElement(caseId, toggleBtn);
  if (!drawerEl) return;
  if (drawerEl.dataset.loaded !== "true") {
    await loadApplicantsForDrawer(caseId, drawerEl);
  } else {
    renderApplicantsInDrawer(caseId, applicantDrawerCache.get(caseId) || [], drawerEl);
  }
  if (drawerRow) {
    window.requestAnimationFrame(() => openApplicantsDrawer(drawerRow, toggleBtn, { skipAnimation: true }));
  }
  showApplicantDetailById(caseId, applicantId, drawerEl);
  if (setFilter) {
    clearApplicantReturnQuery();
  }
}

function restoreApplicantDrawerFromQuery() {
  if (!applicantReturnContext) return;
  void openApplicantFromQuery({ setFilter: false }).finally(() => {
    applicantReturnContext = null;
  });
}

function maybeOpenApplicantFromQuery() {
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
  if (!openApplicants || !caseId) return null;
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
  if (applicantsCaseHandled) return;
  const context = getApplicantsCaseContextFromQuery();
  if (!context) return;
  applicantsCaseHandled = true;
  void openApplicantsForCase(context.caseId).finally(() => {
    clearApplicantsCaseQuery();
  });
}

function formatInvitedDate(value) {
  const formatted = formatCaseDate(value);
  return formatted && formatted !== "—" ? `Invited ${formatted}` : "Invitation date unavailable";
}

function formatInviteStatus(value) {
  const status = String(value || "").trim();
  if (!status) return "";
  return titleCaseWords(status.replace(/_/g, " "));
}

function getInviteDisplayName(profile = {}) {
  const name =
    profile.name ||
    [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  return name || "Invited paralegal";
}

function getApplicantDisplayName(profile = {}, snapshot = {}) {
  const name =
    profile.name ||
    [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  return name || snapshot.name || "Paralegal";
}

function formatAppliedDate(value) {
  const formatted = formatCaseDate(value);
  return formatted && formatted !== "—" ? `Applied ${formatted}` : "Applied recently";
}

function shouldFetchInviteDetails(invite = {}) {
  const profile = invite.profile || {};
  const hasName = Boolean(profile.name || profile.firstName || profile.lastName);
  const hasAvatar = Boolean(profile.profileImage || profile.avatarURL);
  return !hasName || !hasAvatar;
}

async function fetchInviteDetails(caseId) {
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/invites`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => ({}));
    const invites = Array.isArray(payload?.invites) ? payload.invites : [];
    return invites.map((invite) => ({
      profile: invite?.paralegal || {},
      id: invite?.paralegal?.id || invite?.paralegal?._id || "",
      invitedAt: invite?.invitedAt || null,
      respondedAt: invite?.respondedAt || null,
      status: invite?.status || "",
    }));
  } catch {
    return null;
  }
}

function hydrateInviteEntry(entry, invitees = []) {
  if (!entry || !Array.isArray(invitees)) return;
  entry.invites = invitees
    .filter((invite) => invite?.id)
    .map((invite) => ({
      paralegalId: invite.id,
      status: invite.status || "pending",
      invitedAt: invite.invitedAt || null,
      respondedAt: invite.respondedAt || null,
    }));
}

async function openCaseInvites(caseId) {
  if (!caseId) return;
  if (dashboardViewState.currentView !== "cases") {
    try {
      window.location.hash = "cases";
    } catch {}
    showDashboardView("cases", { skipHash: true });
  }
  setupCaseInvitesModal();
  if (!caseInvitesModalRef || !caseInvitesListRef) return;
  caseInvitesModalRef.classList.remove("hidden");
  caseInvitesModalRef.setAttribute("aria-busy", "true");
  caseInvitesListRef.innerHTML = `<p class="muted">Loading invited paralegals…</p>`;

  let entry = state.caseLookup.get(String(caseId));
  if (!entry) {
    await loadCasesWithFiles();
    entry = state.caseLookup.get(String(caseId));
  }
  if (!entry) {
    await loadArchivedCases();
    entry = state.caseLookup.get(String(caseId));
  }

  let invitees = Array.isArray(entry?.invites)
    ? entry.invites.map((invite) => ({
        profile: invite?.profile || {},
        id: invite?.paralegalId || "",
        invitedAt: invite?.invitedAt || null,
        respondedAt: invite?.respondedAt || null,
        status: invite?.status || "pending",
      }))
    : [];
  if (!invitees.length && (entry?.pendingParalegal || entry?.pendingParalegalId)) {
    const pendingProfile =
      entry.pendingParalegal && typeof entry.pendingParalegal === "object" ? entry.pendingParalegal : null;
    const pendingId =
      entry.pendingParalegalId ||
      pendingProfile?.id ||
      pendingProfile?._id ||
      (typeof entry.pendingParalegal === "string" ? entry.pendingParalegal : "");
    invitees.push({
      profile: pendingProfile || {},
      id: pendingId,
      invitedAt: entry.pendingParalegalInvitedAt,
      respondedAt: null,
      status: "pending",
    });
  }

  if (invitees.length && invitees.some(shouldFetchInviteDetails)) {
    const fresh = await fetchInviteDetails(caseId);
    if (Array.isArray(fresh) && fresh.length) {
      invitees = fresh;
      hydrateInviteEntry(entry, fresh);
    }
  }

  if (!invitees.length) {
    caseInvitesListRef.innerHTML = `<p class="muted">No invited paralegals yet.</p>`;
    caseInvitesModalRef.removeAttribute("aria-busy");
    return;
  }

  const itemsHtml = [];
  for (const invite of invitees) {
    const profile = invite.profile || {};
    const id = invite.id || profile.id || profile._id || "";
    const name = getInviteDisplayName(profile);
    const avatar = profile.profileImage || profile.avatarURL || INVITE_AVATAR_FALLBACK;
    const link = buildParalegalProfileUrl(id);
    const statusLabel = formatInviteStatus(invite.status);
    itemsHtml.push(`
      <div class="case-invite-item">
        <img src="${sanitize(avatar)}" alt="${sanitize(name)} profile photo" />
        <div class="case-invite-meta">
          ${sanitizeUrl(link) ? `<a href="${sanitize(sanitizeUrl(link))}">${sanitize(name)}</a>` : `<span>${sanitize(name)}</span>`}
          <span class="case-invite-date">${sanitize(formatInvitedDate(invite.invitedAt))}</span>
          ${statusLabel ? `<span class="case-invite-date">${sanitize(statusLabel)}</span>` : ""}
        </div>
      </div>
    `);
  }

  caseInvitesListRef.innerHTML = itemsHtml.join("");
  caseInvitesModalRef.removeAttribute("aria-busy");
}

function openCaseApplications(caseId) {
  if (!caseId) return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("openApplicants", "1");
    url.searchParams.set("caseId", caseId);
    const nextQuery = url.searchParams.toString();
    const nextUrl = `${url.pathname}${nextQuery ? `?${nextQuery}` : ""}#cases:inquiries`;
    window.history.replaceState({}, "", nextUrl);
  } catch {}
  if (window.location.hash !== "#cases:inquiries") {
    window.location.hash = "cases:inquiries";
  } else {
    showDashboardView("cases", { skipHash: true, caseFilter: "inquiries" });
  }
}

async function openCasePreview(caseId, options = {}) {
  if (!caseId) return;
  const keepView = Boolean(options.keepView);
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
    } catch {}
  }
  if (!entry) {
    if (casePreviewFields.title) casePreviewFields.title.textContent = "Case Details";
    if (casePreviewFields.field) casePreviewFields.field.textContent = "—";
    if (casePreviewFields.location) casePreviewFields.location.textContent = "—";
    if (casePreviewFields.comp) casePreviewFields.comp.textContent = "—";
    if (casePreviewFields.experience) casePreviewFields.experience.textContent = "—";
    if (casePreviewFields.description) {
      casePreviewFields.description.textContent = "Unable to load case details right now.";
    }
    if (casePreviewFields.tasks) {
      casePreviewFields.tasks.innerHTML = `<p class="case-preview-empty">No tasks listed.</p>`;
    }
    if (casePreviewFields.receipt) {
      casePreviewFields.receipt.hidden = true;
      casePreviewFields.receipt.removeAttribute("href");
    }
    casePreviewModalRef.removeAttribute("aria-busy");
    notifyCases("Unable to load case details.", "error");
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

  if (casePreviewFields.title) casePreviewFields.title.textContent = entry.title || "Case Preview";
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
    const receiptUrl = getCasePreviewReceipt(casePreviewTargetId);
    if (receiptUrl) {
      casePreviewFields.receipt.href = receiptUrl;
      casePreviewFields.receipt.hidden = false;
    } else {
      casePreviewFields.receipt.hidden = true;
      casePreviewFields.receipt.removeAttribute("href");
    }
    clearCasePreviewReceipt();
  }

  const editPayload = {
    title: entry.title || "",
    practiceArea,
    state: location || entry.state || entry.locationState || "",
    locationState: location || entry.locationState || entry.state || "",
    totalAmount: entry.lockedTotalAmount ?? entry.totalAmount ?? 0,
    deadline: entry.deadline || null,
    experience,
    details: rawDetails,
    tasks: taskTitles.map((title) => ({ title })),
  };
  if (casePreviewModalRef) {
    casePreviewModalRef.dataset.editPayload = JSON.stringify(editPayload);
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
  if (event.target.closest("[data-archived-select]") || event.target.closest("[data-archived-select-all]")) {
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
      drawerRow.classList.add("hidden");
      const caseId = drawerRow.getAttribute("data-case-id") || "";
      const toggleBtn = drawerRow
        .closest("tbody")
        ?.querySelector(`[data-applicants-toggle][data-case-id="${caseId}"]`);
      if (toggleBtn) toggleBtn.setAttribute("aria-expanded", "false");
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

async function onArchivedBulkAction(event) {
  const btn = event.target.closest("[data-archived-bulk]");
  if (!btn) return;
  const action = btn.dataset.archivedBulk;
  const ids = Array.from(state.archivedSelection);
  if (!ids.length) return;
  try {
    if (action === "download") {
      ids.forEach((id) => {
        window.open(`/api/cases/${encodeURIComponent(id)}/archive/download`, "_blank");
      });
      notifyCases("Download started for selected cases.", "success");
    } else if (action === "delete") {
      const confirmed = window.confirm(`Delete ${ids.length} case${ids.length === 1 ? "" : "s"}? This cannot be undone.`);
      if (!confirmed) return;
      for (const id of ids) {
        await deleteArchivedCase(id, { skipConfirm: true, silent: true });
      }
      notifyCases("Cases deleted.", "success");
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
  menu.style.minWidth = "180px";
  menu.style.width = "180px";
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
  if (!caseId) return;
  try {
    if (action === "resume-draft") {
      window.location.href = `create-case.html?draftId=${encodeURIComponent(caseId)}#description`;
      return;
    } else if (action === "discard-draft") {
      await removeLocalDraft(caseId);
      renderCasesView();
      return;
    } else if (action === "view") {
      await openCasePreview(caseId);
      return;
    } else if (action === "details") {
      await openCasePreview(caseId);
    } else if (action === "workspace") {
      const entry = state.caseLookup.get(String(caseId));
      if (!isWorkspaceEligibleCase(entry)) {
        notifyCases("Workspace unlocks after a paralegal is hired and the case is funded.", "info");
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
    } else if (action === "edit-note") {
      openCaseNoteModal(caseId);
      return;
    } else if (action === "download") {
      await downloadCaseDeliverables(caseId);
    } else if (action === "download-receipt") {
      window.open(`/api/payments/receipt/attorney/${encodeURIComponent(caseId)}?regen=1`, "_blank");
    } else if (action === "download-archive") {
      window.open(`/api/cases/${encodeURIComponent(caseId)}/archive/download`, "_blank");
    } else if (action === "archive") {
      await toggleCaseArchive(caseId, true);
      renderCasesView();
      notifyCases("Case archived.");
    } else if (action === "restore") {
      await toggleCaseArchive(caseId, false);
      renderCasesView();
      notifyCases("Case restored.");
    } else if (action === "delete-case") {
      await deleteArchivedCase(caseId);
      renderCasesView();
    }
  } catch (err) {
    console.error(err);
    notifyCases(err.message || "Unable to complete that action.", "error");
  }
}

async function downloadCaseDeliverables(caseId) {
  const entry = state.caseLookup.get(String(caseId));
  if (!entry) throw new Error("Case not found");
  if (Array.isArray(entry.downloadUrl) && entry.downloadUrl.length) {
    window.open(sanitizeDownloadPath(entry.downloadUrl[0]), "_blank");
    return;
  }
  const file = Array.isArray(entry.files) ? entry.files[0] : null;
  if (file?.key) {
    const url = await getSignedUrl(caseId, file.key);
    if (url) {
      window.open(url, "_blank");
      return;
    }
  }
  throw new Error("No files available to download yet.");
}

async function toggleCaseArchive(caseId, archived) {
  const archiveUrl = `/api/cases/${encodeURIComponent(caseId)}/archive`;
  const caseUrl = `/api/cases/${encodeURIComponent(caseId)}`;
  const entry = state.caseLookup.get(String(caseId));

  if (archived && hasAssignedParalegal(entry)) {
    throw new Error("Cases with a hired paralegal cannot be archived.");
  }

  // Ensure a valid status before unarchiving to avoid enum errors.
  if (!archived) {
    if (isFinalCase(entry)) {
      throw new Error("Completed cases cannot be restored.");
    }
    try {
      await secureFetch(caseUrl, {
        method: "PATCH",
        headers: { Accept: "application/json" },
        body: { status: "open" },
      });
    } catch (err) {
      console.warn("Pre-unarchive status normalization failed", err);
    }
  }

  const attemptArchiveToggle = async (body) => {
    const res = await secureFetch(archiveUrl, {
      method: "PATCH",
      body,
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || "Unable to update case.");
    }
    return payload;
  };

  try {
    const payload = await attemptArchiveToggle(archived ? { archived } : { archived, status: "open" });
    if (!archived && payload && !payload.status) payload.status = "open";
    syncCaseCollections(payload);
    return;
  } catch (err) {
    const message = String(err?.message || "").toLowerCase();
    const draftError = message.includes("draft");
    if (!archived && draftError) {
      // Final fallback: direct case PATCH to clear archived flag with a safe status.
      try {
        const res = await secureFetch(caseUrl, {
          method: "PATCH",
          headers: { Accept: "application/json" },
          body: { archived: false, status: "open" },
        });
        const payload = await res.json().catch(() => ({}));
        if (res.ok) {
          payload.status = payload.status || "open";
          syncCaseCollections(payload);
          return;
        }
      } catch (innerErr) {
        console.warn("Direct unarchive fallback failed", innerErr);
      }
    }
    throw err;
  }
}

async function deleteArchivedCase(caseId, { skipConfirm = false, silent = false } = {}) {
  if (!caseId) return;
  if (!skipConfirm) {
    const confirmed = window.confirm("Permanently delete this case? This cannot be undone.");
    if (!confirmed) return;
  }
  await ensureCaseOpenForDelete(caseId);
  const attemptDelete = async () => {
    const response = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    const payload =
      response.status === 204
        ? {}
        : await response.json().catch(() => ({}));
    return { response, payload };
  };

  let { response: res, payload } = await attemptDelete();
  if (!res.ok) {
    await loadArchivedCases(true);
    await ensureCaseOpenForDelete(caseId, true);
    ({ response: res, payload } = await attemptDelete());
  }
  if (!res.ok) {
    throw new Error(payload.error || "Unable to delete case.");
  }
  removeCaseFromState(caseId);
  if (!silent) notifyCases("Case deleted.", "success");
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

async function ensureCaseOpenForDelete(_caseId, _suppressErrors = false) {
  // Deletion no longer requires status or archive normalization.
}

function syncCaseCollections(updatedCase) {
  if (!updatedCase) return;
  const normalized = Object.assign({}, updatedCase);
  normalized.id = String(normalized.id || normalized._id);
  const removeFromList = (list) => {
    const idx = list.findIndex((item) => String(item.id) === String(normalized.id));
    if (idx >= 0) list.splice(idx, 1);
  };
  removeFromList(state.cases);
  removeFromList(state.casesArchived);
  if (normalized.archived) state.casesArchived.push(normalized);
  else state.cases.push(normalized);
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatCaseAmount(item) {
  const cents = Number(
    item?.lockedTotalAmount ?? item?.totalAmount ?? item?.paymentAmount ?? item?.budget ?? 0
  );
  if (!Number.isFinite(cents) || cents <= 0) return "—";
  return formatCurrency(cents);
}

function notifyCases(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}

// -------------------------
// Messages Page
// -------------------------
let chatCountdownTimer = null;

async function initMessagesPage() {
  const casesPane = document.querySelector("[data-message-cases]");
  if (!casesPane) return;

  setupChatMenu();
  markNotificationsRead({ type: "message" });
  casesPane.addEventListener("click", onMessageCaseClick);
  document.querySelector("[data-message-threads]")?.addEventListener("click", onMessageThreadClick);

  const sendBtn = document.querySelector("[data-chat-send]");
  const chatInput = document.querySelector("[data-chat-input]");
  sendBtn?.addEventListener("click", sendCurrentMessage);
  chatInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage();
    }
  });

  try {
    await Promise.all([loadCasesWithFiles(), loadArchivedCases(), loadThreadSummary()]);
  } catch (err) {
    console.warn("Unable to load conversations", err);
  }
  state.messages.cases = filterWorkspaceEligibleCases(state.cases);
  renderMessageCases();

  const firstCase = state.messages.cases[0];
  if (firstCase) {
    await selectMessageCase(firstCase.id);
  } else {
    renderMessageThreads(null);
    renderChatMessages();
  }

  try {
    await setupCaseScopedMessagingUI();
  } catch (err) {
    console.warn("Case-scoped messaging unavailable", err);
  }
}

async function loadThreadSummary() {
  try {
    const res = await secureFetch("/api/messages/threads?limit=200", { headers: { Accept: "application/json" }, noRedirect: true });
    const payload = await res.json().catch(() => ({}));
    const threads = Array.isArray(payload?.threads) ? payload.threads : [];
    state.messages.summary = new Map();
    threads.forEach((thread) => {
      if (!thread || !thread.id) return;
      state.messages.summary.set(String(thread.id), thread);
    });
  } catch (err) {
    console.warn("Unable to load thread summaries", err);
    state.messages.summary = new Map();
  }
}

function renderMessageCases() {
  const container = document.querySelector("[data-message-cases]");
  if (!container) return;
  const list = state.messages.cases;
  if (!list.length) {
    container.innerHTML = `<div class="messages-placeholder" role="status">You have no active cases yet.</div>`;
    return;
  }
  const activeId = state.messages.activeCaseId;
  container.innerHTML = list
    .map((item) => {
      const id = String(item.id);
      const summary = state.messages.summary.get(id);
      const snippet = formatSnippet(summary?.lastMessageSnippet || "");
      const unread = Number(summary?.unread || 0);
      const badge = unread > 0 ? `<span style="font-weight:600;color:var(--accent);">${unread}</span>` : "";
      const snippetText = snippet || "No recent messages.";
      return `
        <div class="case-item${id === activeId ? " active" : ""}" data-message-case="${id}">
          <div>${sanitize(item.title || "Untitled Case")}</div>
          <div class="case-label">
            <span>${sanitize(snippetText)}</span>
            ${badge}
          </div>
        </div>
      `;
    })
    .join("");
}

function onMessageCaseClick(event) {
  const target = event.target.closest("[data-message-case]");
  if (!target) return;
  const caseId = target.getAttribute("data-message-case");
  selectMessageCase(caseId);
}

async function selectMessageCase(caseId) {
  if (!caseId) return;
  state.messages.activeCaseId = String(caseId);
  state.messages.activeThreadId = "all";
  renderMessageCases();
  try {
    await ensureCaseMessages(caseId);
    renderMessageThreads(caseId);
    renderChatMessages();
    await markNotificationsRead({ caseId: String(caseId) });
  } catch (err) {
    console.warn(err);
    notifyMessages(err.message || "Unable to load messages for that case.", "error");
  }
}

async function ensureCaseMessages(caseId, force = false) {
  const key = String(caseId);
  if (!force && state.messages.messagesByCase.has(key)) {
    return state.messages.messagesByCase.get(key);
  }
  const res = await secureFetch(`/api/messages/${encodeURIComponent(caseId)}?limit=200`, { headers: { Accept: "application/json" } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || "Unable to load conversation.");
  }
  const items = Array.isArray(payload.messages) ? payload.messages : [];
  const normalized = items.map(normalizeMessageRecord);
  state.messages.messagesByCase.set(key, normalized);
  await markMessagesRead(caseId, normalized);
  return normalized;
}

function normalizeUserId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.id || value._id || value.userId || "");
}

function getCurrentUserId() {
  const fromState = normalizeUserId(state.user);
  if (fromState) return fromState;
  const cached = window.getStoredUser?.();
  const cachedId = normalizeUserId(cached);
  if (cachedId) return cachedId;
  try {
    const stored = localStorage.getItem("lpc_user");
    return normalizeUserId(stored ? JSON.parse(stored) : null);
  } catch (_) {}
  return "";
}

function normalizeMessageRecord(msg = {}) {
  const senderObj = msg.senderId && typeof msg.senderId === "object" ? msg.senderId : null;
  const senderId = normalizeUserId(senderObj || msg.senderId);
  const baseName = senderObj
    ? [senderObj.firstName, senderObj.lastName].filter(Boolean).join(" ").trim() || senderObj.name || ""
    : "";
  const roleLabel =
    msg.senderRole === "system"
      ? "System"
      : msg.senderRole === "admin"
      ? "Admin"
      : msg.senderRole === "paralegal"
      ? "Paralegal"
      : "Attorney";
  const senderName = baseName || roleLabel;
  const currentUserId = getCurrentUserId();
  const isSelf = senderId && currentUserId && String(senderId) === String(currentUserId);
  return {
    id: msg._id || msg.id || `${Date.now()}-${Math.random()}`,
    text: msg.text || msg.content || "",
    senderId,
    senderName: isSelf ? "You" : senderName,
    senderRole: msg.senderRole || senderObj?.role || "",
    createdAt: msg.createdAt || msg.updatedAt || new Date().toISOString(),
    isSelf,
  };
}

function renderMessageThreads(caseId) {
  const container = document.querySelector("[data-message-threads]");
  if (!container) return;
  if (!caseId) {
    container.innerHTML = `<div class="messages-placeholder" role="status">Select a case to view conversations.</div>`;
    return;
  }
  const messages = state.messages.messagesByCase.get(String(caseId)) || [];
  if (!messages.length) {
    container.innerHTML = `<p style="color:var(--muted);font-size:.9rem;">No messages yet. Start the conversation below.</p>`;
    const chatInput = document.querySelector("[data-chat-input]");
    const sendBtn = document.querySelector("[data-chat-send]");
    if (chatInput) chatInput.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
    return;
  }
  const threads = buildThreadsFromMessages(messages);
  if (!threads.some((entry) => entry.id === state.messages.activeThreadId)) {
    state.messages.activeThreadId = "all";
  }
  container.innerHTML = threads
    .map((entry) => {
      const active = entry.id === state.messages.activeThreadId ? " active" : "";
      return `
        <div class="thread-item${active}" data-message-thread="${entry.id}">
          <div>
            <strong>${sanitize(entry.title)}</strong>
            <div class="thread-meta">${sanitize(entry.snippet || "No messages yet.")}</div>
          </div>
          <button type="button" class="reply-btn" data-thread-reply="${entry.id}">Reply</button>
        </div>
      `;
    })
    .join("");
}

function buildThreadsFromMessages(messages = []) {
  const groups = new Map();
  messages.forEach((msg) => {
    const key = msg.isSelf ? "self" : msg.senderId || `${msg.senderRole}-${msg.senderName}`;
    const existing = groups.get(key) || {
      id: key,
      title: msg.isSelf ? "You" : msg.senderName || "Paralegal",
      snippet: "",
      updatedAt: null,
    };
    if (!existing.updatedAt || new Date(msg.createdAt) > new Date(existing.updatedAt || 0)) {
      existing.snippet = msg.text;
      existing.updatedAt = msg.createdAt;
    }
    groups.set(key, existing);
  });
  const latest = messages[messages.length - 1];
  const allEntry = {
    id: "all",
    title: "All messages",
    snippet: latest?.text || "Start the conversation.",
    updatedAt: latest?.createdAt || null,
  };
  return [
    allEntry,
    ...Array.from(groups.values()).sort(
      (a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)
    ),
  ];
}

function onMessageThreadClick(event) {
  const reply = event.target.closest("[data-thread-reply]");
  if (reply) {
    event.stopPropagation();
    state.messages.activeThreadId = reply.dataset.threadReply;
    const input = document.querySelector("[data-chat-input]");
    input?.focus();
    renderMessageThreads(state.messages.activeCaseId);
    renderChatMessages();
    return;
  }
  const target = event.target.closest("[data-message-thread]");
  if (!target) return;
  state.messages.activeThreadId = target.dataset.messageThread;
  renderMessageThreads(state.messages.activeCaseId);
  renderChatMessages();
}

function renderChatMessages() {
  const body = document.querySelector("[data-chat-body]");
  const chatTitle = document.getElementById("chatTitle");
  if (!body) return;
  const caseId = state.messages.activeCaseId;
  if (!caseId) {
    body.innerHTML = `<p style="color:var(--muted);">Select a case to view messages.</p>`;
    setComposerLock(true);
    if (chatCountdownTimer) {
      clearInterval(chatCountdownTimer);
      chatCountdownTimer = null;
    }
    chatTitle.textContent = "Chat";
    return;
  }
  const caseEntry = state.caseLookup.get(String(caseId));
  const readOnly = !!caseEntry?.readOnly;
  const purgeAt = caseEntry?.purgeScheduledFor ? new Date(caseEntry.purgeScheduledFor) : null;
  chatTitle.textContent = caseEntry?.title || "Chat";
  const messages = state.messages.messagesByCase.get(String(caseId)) || [];
  const filterId = state.messages.activeThreadId;
  let visible = messages;
  if (filterId && filterId !== "all") {
    visible = messages.filter((msg) => {
      const key = msg.isSelf ? "self" : msg.senderId || `${msg.senderRole}-${msg.senderName}`;
      return key === filterId;
    });
  }
  if (!visible.length) {
    body.innerHTML = `<p style="color:var(--muted);">No messages yet. Start the conversation.</p>`;
  } else {
    body.innerHTML = visible
      .map(
        (msg) => `
        <div class="chat-msg ${msg.isSelf ? "you" : "them"}">
          <div>${sanitize(msg.text || "")}</div>
          <span class="meta">${sanitize(msg.senderName || (msg.isSelf ? "You" : "Paralegal"))} · ${formatChatTimestamp(msg.createdAt)}</span>
        </div>
      `
      )
      .join("");
    body.scrollTop = body.scrollHeight;
  }
  if (readOnly) {
    const countdownText = purgeAt ? formatAutoDelete(purgeAt) : "--:--";
    body.innerHTML =
      `<p style="color:var(--muted);font-size:.85rem;margin-bottom:.6rem;">Case archived. Auto-delete in <span data-chat-countdown>${countdownText}</span>.</p>` +
      body.innerHTML;
    const countdownNode = body.querySelector("[data-chat-countdown]");
    if (countdownNode && purgeAt) startChatCountdown(countdownNode, purgeAt);
  } else if (chatCountdownTimer) {
    clearInterval(chatCountdownTimer);
    chatCountdownTimer = null;
  }
  setComposerLock(readOnly);
}

function setComposerLock(readOnly) {
  const chatInput = document.querySelector("[data-chat-input]");
  const sendBtn = document.querySelector("[data-chat-send]");
  if (chatInput) {
    const disable = readOnly || !state.messages.activeCaseId;
    chatInput.disabled = disable;
    chatInput.placeholder = disable ? "Case archived. Messaging disabled." : "Type a message...";
    if (disable) chatInput.value = "";
  }
  if (sendBtn) {
    const disable = readOnly || state.messages.sending || !state.messages.activeCaseId;
    sendBtn.disabled = disable;
    sendBtn.textContent = readOnly ? "Locked" : "Send";
  }
}

async function setupCaseScopedMessagingUI() {
  injectCaseScopedMessagingUI();
  updateSimpleMessageCases();
  await loadMessageSummaryCounts();
  populateCaseSelectOptions();
  const initialCaseId =
    state.simpleMessages.activeCaseId ||
    (state.simpleMessages.cases[0] ? String(state.simpleMessages.cases[0].id) : null);
  if (initialCaseId) {
    await loadSimpleMessageThread(initialCaseId, { replace: true });
  } else {
    renderSimpleMessageThread(null, [], "Select a case to view messages.");
  }
}

function injectCaseScopedMessagingUI() {
  if (document.getElementById("msgInterface")) return;
  const host = document.querySelector(".main");
  if (!host) return;
  ensureSimpleMessageStyles();
  const wrapper = document.createElement("section");
  wrapper.id = "msgInterface";
  wrapper.innerHTML = `
    <div>
      <select id="msgCaseSelect"></select>
    </div>
    <div id="msgThread"></div>
    <form id="msgForm">
      <textarea id="msgInput" rows="3" placeholder="Type a case message..."></textarea>
      <button type="submit" id="msgSend">Send</button>
    </form>
  `;
  host.appendChild(wrapper);
  const select = wrapper.querySelector("#msgCaseSelect");
  const form = wrapper.querySelector("#msgForm");
  select?.addEventListener("change", (event) => {
    loadSimpleMessageThread(event.target.value, { replace: true });
  });
  form?.addEventListener("submit", handleSimpleMessageSend);
}

function updateSimpleMessageCases() {
  state.simpleMessages.cases = (state.messages.cases || []).map((caseItem) => ({
    id: String(caseItem.id),
    title: caseItem.title || "Untitled Case",
  }));
}

async function loadMessageSummaryCounts() {
  try {
    const res = await secureFetch("/api/messages/summary", {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    const payload = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(payload.items)) {
      state.simpleMessages.unread = new Map(
        payload.items.map((entry) => [String(entry.caseId), Number(entry.unread) || 0])
      );
    } else {
      state.simpleMessages.unread = new Map();
    }
  } catch {
    state.simpleMessages.unread = new Map();
  }
}

function populateCaseSelectOptions() {
  const select = document.getElementById("msgCaseSelect");
  if (!select) return;
  select.innerHTML = "";
  const cases = state.simpleMessages.cases;
  if (!cases.length) {
    select.disabled = true;
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No cases available";
    select.appendChild(option);
    return;
  }
  select.disabled = false;
  cases.forEach((caseItem) => {
    const option = document.createElement("option");
    const unread = state.simpleMessages.unread.get(String(caseItem.id)) || 0;
    option.value = String(caseItem.id);
    option.textContent =
      unread > 0 ? `${caseItem.title || "Case"} (${unread})` : caseItem.title || "Case";
    select.appendChild(option);
  });
  const active =
    state.simpleMessages.activeCaseId &&
    cases.some((entry) => String(entry.id) === String(state.simpleMessages.activeCaseId))
      ? String(state.simpleMessages.activeCaseId)
      : String(cases[0].id);
  state.simpleMessages.activeCaseId = active;
  select.value = active;
}

async function loadSimpleMessageThread(caseId, { replace = true } = {}) {
  if (!caseId) {
    state.simpleMessages.activeCaseId = null;
    renderSimpleMessageThread(null, [], "Select a case to view messages.");
    stopSimpleMessagePolling();
    return;
  }
  state.simpleMessages.activeCaseId = String(caseId);
  const select = document.getElementById("msgCaseSelect");
  if (select && select.value !== String(caseId)) {
    select.value = String(caseId);
  }
  const result = await fetchSimpleMessages(caseId, { replace });
  renderSimpleMessageThread(caseId, result.messages, result.error);
  await markMessagesRead(caseId, result.messages);
  state.simpleMessages.unread.set(String(caseId), 0);
  populateCaseSelectOptions();
  startSimpleMessagePolling();
}

async function fetchSimpleMessages(caseId, { replace = true } = {}) {
  const existing = state.simpleMessages.messagesByCase.get(caseId) || [];
  try {
    const res = await secureFetch(`/api/messages/${encodeURIComponent(caseId)}`, {
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error || (res.status === 403 ? "Access denied." : "Unable to load messages."));
    }
    const currentUserId = getCurrentUserId();
    const incoming = Array.isArray(payload.messages)
      ? payload.messages.map((msg) => {
          const senderId = normalizeUserId(msg.senderId);
          return {
            id: msg._id || msg.id || `${Date.now()}-${Math.random()}`,
            text: msg.text || msg.content || "",
            createdAt: msg.createdAt || msg.updatedAt || new Date().toISOString(),
            isMine: senderId && currentUserId && String(senderId) === String(currentUserId),
          };
        })
      : [];
    const merged = mergeSimpleMessages(caseId, incoming, replace);
    return { messages: merged, error: null };
  } catch (err) {
    return { messages: existing, error: err?.message || "Unable to load messages." };
  }
}

function mergeSimpleMessages(caseId, incoming, replace) {
  const current = replace ? [] : state.simpleMessages.messagesByCase.get(caseId) || [];
  const known = new Set(current.map((msg) => msg.id));
  let changed = false;
  incoming.forEach((msg) => {
    if (!known.has(msg.id)) {
      current.push(msg);
      known.add(msg.id);
      changed = true;
    }
  });
  if (changed || replace) {
    current.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }
  state.simpleMessages.messagesByCase.set(caseId, current);
  state.simpleMessages.lastIds.set(caseId, current.length ? current[current.length - 1].id : null);
  return current;
}

function renderSimpleMessageThread(caseId, messages = [], error) {
  const thread = document.getElementById("msgThread");
  if (!thread) return;
  if (!caseId) {
    thread.innerHTML = `<p style="color:var(--muted);font-size:.9rem;">Select a case to view messages.</p>`;
    return;
  }
  if (error) {
    thread.innerHTML = `<p style="color:#b91c1c;font-size:.9rem;">${sanitize(error)}</p>`;
    return;
  }
  if (!messages.length) {
    thread.innerHTML = `<p style="color:var(--muted);font-size:.9rem;">No messages yet.</p>`;
    return;
  }
  thread.innerHTML = messages
    .map(
      (msg) => `
        <div class="msg-row${msg.isMine ? " mine" : ""}">
          <div class="msg-text">${sanitize(msg.text || "")}</div>
          <div class="msg-time">${sanitize(formatMessageTimestamp(msg.createdAt))}</div>
        </div>
      `
    )
    .join("");
}

function formatMessageTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function getLatestMessageTimestamp(messages = []) {
  let latest = 0;
  messages.forEach((msg) => {
    const stamp = msg?.createdAt || msg?.updatedAt || msg?.created;
    if (!stamp) return;
    const time = new Date(stamp).getTime();
    if (!Number.isNaN(time)) {
      latest = Math.max(latest, time);
    }
  });
  return latest ? new Date(latest).toISOString() : null;
}

async function markMessagesRead(caseId, messages = []) {
  const upTo = getLatestMessageTimestamp(messages);
  if (!caseId || !upTo) return;
  try {
    await secureFetch(`/api/messages/${encodeURIComponent(caseId)}/read`, {
      method: "POST",
      body: { upTo },
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
  } catch (err) {
    console.warn("Unable to mark messages read", err);
  }
}

async function handleSimpleMessageSend(event) {
  event.preventDefault();
  const caseId = state.simpleMessages.activeCaseId;
  if (!caseId) {
    notifyMessages("Select a case before sending.", "error");
    return;
  }
  const input = document.getElementById("msgInput");
  const btn = document.getElementById("msgSend");
  const text = (input?.value || "").trim();
  if (!text) {
    notifyMessages("Enter a message before sending.", "error");
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent || "Send";
    btn.textContent = "Sending…";
  }
  try {
    const res = await secureFetch(`/api/messages/${encodeURIComponent(caseId)}`, {
      method: "POST",
      body: { text },
      headers: { Accept: "application/json" },
      noRedirect: true,
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload?.error || "Unable to send message.");
    }
    if (input) input.value = "";
    const result = await fetchSimpleMessages(caseId, { replace: true });
    renderSimpleMessageThread(caseId, result.messages, result.error);
    await markMessagesRead(caseId, result.messages);
    startSimpleMessagePolling();
  } catch (err) {
    notifyMessages(err?.message || "Unable to send message.", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || "Send";
    }
  }
}

function startSimpleMessagePolling() {
  if (state.simpleMessages.pollTimer) {
    clearInterval(state.simpleMessages.pollTimer);
  }
  if (!state.simpleMessages.activeCaseId) return;
  state.simpleMessages.pollTimer = setInterval(pollSimpleMessages, 10_000);
}

function stopSimpleMessagePolling() {
  if (state.simpleMessages.pollTimer) {
    clearInterval(state.simpleMessages.pollTimer);
    state.simpleMessages.pollTimer = null;
  }
}

async function pollSimpleMessages() {
  const caseId = state.simpleMessages.activeCaseId;
  if (!caseId) return;
  const previousLast = state.simpleMessages.lastIds.get(caseId);
  const result = await fetchSimpleMessages(caseId, { replace: false });
  const currentLast = state.simpleMessages.lastIds.get(caseId);
  if (result.error) {
    renderSimpleMessageThread(caseId, result.messages, result.error);
    return;
  }
  if (currentLast && currentLast !== previousLast) {
    renderSimpleMessageThread(caseId, result.messages);
  }
}

function startChatCountdown(node, targetDate) {
  if (!node || !targetDate) return;
  const update = () => {
    const diff = targetDate.getTime() - Date.now();
    if (diff <= 0) {
      node.textContent = "00:00";
      clearInterval(chatCountdownTimer);
      chatCountdownTimer = null;
      return;
    }
    node.textContent = formatAutoDelete(targetDate);
  };
  update();
  clearInterval(chatCountdownTimer);
  chatCountdownTimer = setInterval(update, 60 * 1000);
}

function formatAutoDelete(targetDate) {
  const diff = Math.max(0, targetDate.getTime() - Date.now());
  const totalMinutes = Math.floor(diff / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, "0")}h`;
  }
  return `${String(totalHours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

async function sendCurrentMessage() {
  if (state.messages.sending) return;
  const chatInput = document.querySelector("[data-chat-input]");
  if (!chatInput) return;
  const value = chatInput.value.trim();
  if (!value || !state.messages.activeCaseId) return;
  const caseEntry = state.caseLookup.get(String(state.messages.activeCaseId));
  if (caseEntry?.readOnly) {
    notifyMessages("This case is archived. Messaging is disabled.", "error");
    return;
  }
  const sendBtn = document.querySelector("[data-chat-send]");
  state.messages.sending = true;
  if (sendBtn) sendBtn.disabled = true;
  try {
    const res = await secureFetch(`/api/messages/${encodeURIComponent(state.messages.activeCaseId)}`, {
      method: "POST",
      body: { content: value },
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.error || "Unable to send message.");
    }
    chatInput.value = "";
    await ensureCaseMessages(state.messages.activeCaseId, true);
    await loadThreadSummary();
    renderMessageCases();
    renderMessageThreads(state.messages.activeCaseId);
    renderChatMessages();
    await markMessagesRead(
      state.messages.activeCaseId,
      state.messages.messagesByCase.get(String(state.messages.activeCaseId))
    );
    notifyMessages("Message sent.", "success");
  } catch (err) {
    console.warn(err);
    notifyMessages(err.message || "Unable to send message.", "error");
  } finally {
    state.messages.sending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

function setupChatMenu() {
  chatMenuWrapper = document.getElementById("chatActions");
  if (!chatMenuWrapper) return;
  const trigger = chatMenuWrapper.querySelector(".chat-menu-trigger");
  const menu = chatMenuWrapper.querySelector(".chat-menu");
  if (trigger) {
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = chatMenuWrapper.classList.contains("open");
      closeChatMenu();
      if (!open) {
        chatMenuWrapper.classList.add("open");
        trigger.setAttribute("aria-expanded", "true");
      }
    });
  }
  if (menu) {
    menu.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-chat-action]");
      if (!btn) return;
      handleChatAction(btn.dataset.chatAction);
      closeChatMenu();
    });
  }
  document.addEventListener("click", (event) => {
    if (chatMenuWrapper && !chatMenuWrapper.contains(event.target)) {
      closeChatMenu();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeChatMenu();
  });
}

function closeChatMenu() {
  if (!chatMenuWrapper) return;
  const trigger = chatMenuWrapper.querySelector(".chat-menu-trigger");
  chatMenuWrapper.classList.remove("open");
  trigger?.setAttribute("aria-expanded", "false");
}

function handleChatAction(action) {
  const caseId = state.messages.activeCaseId;
  if (!caseId) return;
  if (action === "print") {
    try {
      const transcript = buildConversationTranscript(caseId);
      const popup = window.open("", "_blank", "noopener");
      if (popup) {
        popup.document.write(`<pre style="font-family:monospace;white-space:pre-wrap;">${sanitize(transcript)}</pre>`);
        popup.document.close();
        popup.focus();
        popup.print();
      }
    } catch (err) {
      console.warn(err);
      notifyMessages(err.message || "Unable to print conversation.", "error");
    }
  } else if (action === "download") {
    try {
      downloadConversation(caseId);
    } catch (err) {
      console.warn(err);
      notifyMessages(err.message || "Unable to download conversation.", "error");
    }
  }
}

function downloadConversation(caseId) {
  const messages = state.messages.messagesByCase.get(String(caseId)) || [];
  if (!messages.length) throw new Error("No conversation available.");
  const caseEntry = state.caseLookup.get(String(caseId));
  const lines = messages.map((msg) => {
    const label = msg.isSelf ? "You" : msg.senderName || "Paralegal";
    return `[${formatChatTimestamp(msg.createdAt)}] ${label}: ${msg.text}`;
  });
  const blob = new Blob([lines.join("\\n")], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  const safeTitle = (caseEntry?.title || "conversation").replace(/[^a-z0-9-_]/gi, "_");
  link.download = `${safeTitle}_messages.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(link.href), 500);
}

function buildConversationTranscript(caseId) {
  const messages = state.messages.messagesByCase.get(String(caseId)) || [];
  if (!messages.length) throw new Error("No conversation available.");
  const caseEntry = state.caseLookup.get(String(caseId));
  const header = `Conversation for ${caseEntry?.title || "Case"}\\n`;
  const lines = messages.map((msg) => {
    const label = msg.isSelf ? "You" : msg.senderName || "Paralegal";
    return `[${formatChatTimestamp(msg.createdAt)}] ${label}: ${msg.text}`;
  });
  return `${header}\\n${lines.join("\\n")}`;
}

function formatSnippet(text) {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= 60) return trimmed;
  return `${trimmed.slice(0, 57)}…`;
}

function formatChatTimestamp(raw) {
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function notifyMessages(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}

// -------------------------
// Documents Page
// -------------------------
async function initDocumentsPage() {
  const listPane = document.querySelector("[data-doc-list]");
  if (!listPane) return;
  try {
    await Promise.all([loadCasesWithFiles(), loadArchivedCases()]);
  } catch (err) {
    console.warn("Unable to load documents", err);
  }
  state.documents.activeDocId = null;
  state.documents.activeTab = "templates";
  state.documents.sort = document.querySelector("[data-doc-sort]")?.value || "date";
  bindDocumentEvents();
  setDocumentTab(state.documents.activeTab);
}

function bindDocumentEvents() {
  document.querySelectorAll("[data-doc-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const current = tab.dataset.docTab || "templates";
      setDocumentTab(current);
    });
  });
  document.querySelector("[data-doc-sort]")?.addEventListener("change", (event) => {
    state.documents.sort = event.target.value;
    renderDocumentGroups();
  });
  document.querySelector("[data-doc-upload]")?.addEventListener("click", () => triggerDocumentUpload());
  document.querySelector("[data-doc-new]")?.addEventListener("click", () => triggerDocumentUpload());
  document.querySelector("[data-doc-refresh]")?.addEventListener("click", async () => {
    await refreshDocuments();
  });
  document.querySelector("[data-doc-upload-input]")?.addEventListener("change", handleDocumentUpload);
  document.querySelector("[data-doc-replace-input]")?.addEventListener("change", handleDocumentReplace);
  document.querySelector("[data-doc-list]")?.addEventListener("click", onDocumentListClick);
  document.querySelector(".right-panel")?.addEventListener("click", onDocumentPreviewAction);
}

function setDocumentTab(tab) {
  state.documents.activeTab = tab;
  document.querySelectorAll("[data-doc-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.docTab === tab);
  });
  const standard = document.getElementById("standardContent");
  const archive = document.getElementById("archiveContent");
  if (tab === "archive") {
    standard?.classList.add("hidden");
    archive?.classList.remove("hidden");
    renderArchiveList();
  } else {
    standard?.classList.remove("hidden");
    archive?.classList.add("hidden");
    renderDocumentGroups();
  }
}

function getDocumentInventory({ includeArchived = false } = {}) {
  const collection = includeArchived ? state.casesArchived : state.cases;
  const docs = [];
  collection.forEach((caseItem) => {
    const files = Array.isArray(caseItem.files) ? caseItem.files : [];
    files.forEach((file) => {
      const fileId = String(file.id || file._id || file.key || `${caseItem.id}-${file.filename}`);
      docs.push({
        id: `${caseItem.id}-${fileId}`,
        caseId: caseItem.id,
        caseTitle: caseItem.title || "Case",
        file,
      });
    });
  });
  return docs;
}

function renderDocumentGroups() {
  const container = document.querySelector("[data-doc-groups]");
  if (!container) return;
  const list = getFilteredDocuments();
  if (!list.length) {
    container.innerHTML = `<p style="color:var(--muted);font-size:.9rem;">No documents found for this view.</p>`;
    renderDocumentPreview(null);
    return;
  }

  const groups = new Map();
  list.forEach((item) => {
    const bucket = item.caseTitle || "Case";
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(item);
  });

  const orderedGroups = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  container.innerHTML = orderedGroups
    .map(([caseTitle, entries]) => {
      const items = entries
        .map((doc) => {
          const active = doc.id === state.documents.activeDocId ? " active" : "";
          const uploadedLabel = formatCaseDate(doc.file.uploadedAt || doc.file.createdAt || doc.file.updatedAt);
          return `
            <div class="template-item${active}" data-doc-file="${doc.id}" data-doc-case="${doc.caseId}" data-doc-file-id="${doc.file.id || doc.file._id || ""}" data-doc-file-key="${doc.file.key || ""}">
              <div>
                <strong>${sanitize(doc.file.filename || doc.file.original || "Document")}</strong>
                <span>${sanitize(doc.file.status || "pending_review")}</span>
              </div>
              <span>${uploadedLabel}</span>
            </div>
          `;
        })
        .join("");
      return `
        <div class="group-header">
          <span>${sanitize(caseTitle)}</span>
          <span style="font-size:.85rem;color:var(--muted);">${entries.length} file${entries.length === 1 ? "" : "s"}</span>
        </div>
        ${items}
      `;
    })
    .join("");

  if (!state.documents.activeDocId && list.length) {
    selectDocument(list[0].id);
  } else if (state.documents.activeDocId) {
    const current = list.find((entry) => entry.id === state.documents.activeDocId);
    renderDocumentPreview(current || null);
  }
}

function getFilteredDocuments() {
  const tab = state.documents.activeTab || "templates";
  let docs = getDocumentInventory({ includeArchived: false });
  if (tab === "fields") {
    docs = docs.filter((entry) => (entry.file.status || "").toLowerCase() === "pending_review");
  } else if (tab === "forms") {
    docs = docs.filter((entry) => (entry.file.status || "").toLowerCase() === "approved");
  }
  return sortDocuments(docs);
}

function sortDocuments(docs) {
  const sort = state.documents.sort || "date";
  if (sort === "alpha") {
    return docs.sort((a, b) => (a.file.filename || "").localeCompare(b.file.filename || ""));
  }
  if (sort === "case") {
    return docs.sort((a, b) => (a.caseTitle || "").localeCompare(b.caseTitle || ""));
  }
  return docs.sort(
    (a, b) =>
      new Date(b.file.uploadedAt || b.file.createdAt || 0).getTime() -
      new Date(a.file.uploadedAt || a.file.createdAt || 0).getTime()
  );
}

function onDocumentListClick(event) {
  const card = event.target.closest("[data-doc-file]");
  if (!card) return;
  const docId = card.getAttribute("data-doc-file");
  selectDocument(docId);
}

function selectDocument(docId) {
  if (!docId) return;
  state.documents.activeDocId = docId;
  document.querySelectorAll("[data-doc-file]").forEach((node) => {
    node.classList.toggle("active", node.getAttribute("data-doc-file") === docId);
  });
  const doc = findDocumentById(docId);
  renderDocumentPreview(doc);
}

function findDocumentById(docId) {
  const allDocs = [...getDocumentInventory({ includeArchived: false }), ...getDocumentInventory({ includeArchived: true })];
  return allDocs.find((entry) => entry.id === docId) || null;
}

function renderDocumentPreview(doc) {
  const title = document.getElementById("templateTitle");
  const meta = document.querySelector("[data-doc-meta]");
  const preview = document.querySelector("[data-doc-preview]");
  const table = document.getElementById("placeholderBody");
  if (!doc) {
    if (title) title.textContent = "Select a document";
    meta.innerHTML = `<span>Select a file from the list to view details.</span>`;
    preview.textContent = "No document selected.";
    table.innerHTML = `
      <tr><td>Status</td><td>—</td></tr>
      <tr><td>Version</td><td>—</td></tr>
      <tr><td>Uploaded</td><td>—</td></tr>
    `;
    return;
  }
  const file = doc.file || {};
  const caseTitle = state.caseLookup.get(String(doc.caseId))?.title || doc.caseTitle || "Case";
  if (title) title.textContent = file.filename || file.original || "Document";
  const uploaded = formatCaseDate(file.uploadedAt || file.createdAt || file.updatedAt);
  meta.innerHTML = `
    <span>${sanitize(caseTitle)}</span>
    <span>Uploaded ${uploaded || "—"}</span>
    <a href="#" data-doc-download>Download</a>
    <a href="#" data-doc-replace>Replace</a>
  `;
  preview.textContent = file.original || file.filename || "Preview not available.";
  const rows = [
    ["Status", formatCaseStatus(file.status || "pending_review")],
    ["Version", file.version || 1],
    ["Size", formatFileSize(file.size)],
  ];
  table.innerHTML = rows
    .map((row) => `<tr><td>${sanitize(row[0])}</td><td>${sanitize(String(row[1] ?? "—"))}</td></tr>`)
    .join("");
}

async function triggerDocumentUpload() {
  const input = document.querySelector("[data-doc-upload-input]");
  if (input) {
    input.value = "";
    input.click();
  }
}

async function handleDocumentUpload(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;
  const active = state.documents.activeDocId ? findDocumentById(state.documents.activeDocId) : null;
  const targetCaseId = active?.caseId || state.cases[0]?.id;
  if (!targetCaseId) {
    notifyDocuments("Select a case before uploading.", "error");
    return;
  }
  try {
    await uploadDocumentsToCase(targetCaseId, files);
    await refreshDocuments(true);
    notifyDocuments("Document uploaded.", "success");
  } catch (err) {
    console.warn(err);
    notifyDocuments(err.message || "Unable to upload document.", "error");
  }
}

async function uploadDocumentsToCase(caseId, files) {
  for (const file of files) {
    const key = await uploadToS3(file, caseId);
    await secureFetch(`/api/cases/${encodeURIComponent(caseId)}/files`, {
      method: "POST",
      body: { key, original: file.name, mime: file.type, size: file.size },
      headers: { Accept: "application/json" },
    });
  }
}

function onDocumentPreviewAction(event) {
  const downloadBtn = event.target.closest("[data-doc-download]");
  if (downloadBtn) {
    event.preventDefault();
    downloadSelectedDocument();
    return;
  }
  const replaceBtn = event.target.closest("[data-doc-replace]");
  if (replaceBtn) {
    event.preventDefault();
    const doc = findDocumentById(state.documents.activeDocId);
    if (!doc) return;
    state.documents.replaceTarget = doc;
    const input = document.querySelector("[data-doc-replace-input]");
    if (input) {
      input.value = "";
      input.click();
    }
  }
}

async function downloadSelectedDocument() {
  const doc = findDocumentById(state.documents.activeDocId);
  if (!doc) return;
  try {
    if (Array.isArray(doc.file.downloadUrl) && doc.file.downloadUrl.length) {
      window.open(sanitizeDownloadPath(doc.file.downloadUrl[0]), "_blank");
      return;
    }
    if (doc.file.key) {
      const opened = await openFile(doc.caseId, doc.file.key, "download", doc.file.filename || doc.file.original);
      if (!opened) return;
      return;
    }
    throw new Error("Download link unavailable.");
  } catch (err) {
    console.warn(err);
    notifyDocuments(err.message || "Unable to download document.", "error");
  }
}

async function handleDocumentReplace(event) {
  const file = event.target.files?.[0];
  if (!file || !state.documents.replaceTarget) return;
  const target = state.documents.replaceTarget;
  try {
    const key = await uploadToS3(file, target.caseId);
    const fileId = target.file.id || target.file._id;
    if (!fileId) {
      throw new Error("File identifier missing.");
    }
    await secureFetch(`/api/cases/${encodeURIComponent(target.caseId)}/files/${encodeURIComponent(fileId)}/replace`, {
      method: "POST",
      body: { key, original: file.name, mime: file.type, size: file.size },
      headers: { Accept: "application/json" },
    });
    await refreshDocuments(true);
    notifyDocuments("Document replaced.", "success");
  } catch (err) {
    console.warn(err);
    notifyDocuments(err.message || "Unable to replace document.", "error");
  } finally {
    state.documents.replaceTarget = null;
  }
}

async function refreshDocuments(force = false) {
  await Promise.all([loadCasesWithFiles(true), loadArchivedCases(true)]);
  state.documents.activeDocId = null;
  renderDocumentGroups();
  renderArchiveList();
}

function renderArchiveList() {
  const list = document.getElementById("archiveList");
  const empty = document.getElementById("archiveEmpty");
  if (!list || !empty) return;
  const docs = getDocumentInventory({ includeArchived: true });
  if (!docs.length) {
    empty.classList.remove("hidden");
    list.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");
  list.innerHTML = docs
    .map(
      (doc) => `
      <li>
        <span>${sanitize(doc.file.filename || doc.file.original || "Document")} — ${sanitize(doc.caseTitle || "Case")}</span>
        <span style="color:var(--muted);">${formatCaseDate(doc.file.uploadedAt || doc.file.createdAt)}</span>
      </li>
    `
    )
    .join("");
}

function formatFileSize(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function notifyDocuments(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
  }
}

function notifyTasks(message, type = "info") {
  const helper = window.toastUtils;
  if (helper?.show) {
    helper.show(message, { targetId: "toastBanner", type });
  } else {
    alert(message);
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

function isTerminalCase(caseItem) {
  if (!caseItem) return false;
  if (caseItem.paymentReleased === true) return true;
  const status = normalizeCaseStatus(caseItem?.status);
  return TERMINAL_CASE_STATUSES.has(status);
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

function filterWorkspaceEligibleCases(list = []) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.filter((item) => isWorkspaceEligibleCase(item));
}

async function loadCasesWithFiles(force = false) {
  if (force) state.casesPromise = null;
  if (state.casesPromise) {
    await state.casesPromise;
    return state.cases;
  }
  const url = "/api/cases/my?withFiles=true&limit=100&archived=false";
  state.casesPromise = (async () => {
    try {
      const res = await secureFetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("Case fetch failed");
      const data = await res.json();
      state.cases = Array.isArray(data) ? data.filter((item) => !isTerminalCase(item)) : [];
      buildCaseLookup();
      applyApplicationCountsToCases({ render: dashboardViewState.casesInitialized });
    } catch (err) {
      console.error(err);
      state.cases = [];
    } finally {
      state.casesPromise = null;
    }
    return state.cases;
  })();
  return state.casesPromise;
}

function buildCaseLookup() {
  state.caseLookup.clear();
  const combined = [...(state.cases || []), ...(state.casesArchived || [])];
  combined.forEach((c) => {
    const primaryId = parseCaseId(c);
    if (primaryId) state.caseLookup.set(String(primaryId), c);
    if (c.id) state.caseLookup.set(String(c.id), c);
    if (c._id) state.caseLookup.set(String(c._id), c);
  });
}

function mergeUpdatedFile(caseId, file) {
  const caseEntry = state.cases.find((c) => String(c.id) === String(caseId));
  if (!caseEntry) return;
  const idx = (caseEntry.files || []).findIndex((f) => String(f.id || f.key) === String(file.id || file.key));
  if (idx >= 0) caseEntry.files[idx] = file;
  else caseEntry.files = [...(caseEntry.files || []), file];
}

async function openFile(caseId, key, mode, fileName) {
  if (!key) throw new Error("Missing key");
  const url = await getSignedUrl(caseId, key);
  if (!url) {
    notifyCases(MISSING_DOCUMENT_MESSAGE, "info");
    return false;
  }
  if (mode === "download") {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "document";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } else if (mode === "print") {
    const win = window.open(url, "_blank");
    if (win) {
      win.addEventListener("load", () => win.print());
    }
    return true;
  } else {
    window.open(url, "_blank");
    return true;
  }
}

async function openReviewFile(caseId, fileKey, downloadUrl, mode, fileName) {
  if (fileKey) {
    const opened = await openFile(caseId, fileKey, mode, fileName);
    if (!opened) return false;
    return true;
  }
  if (downloadUrl && downloadUrl !== "#" && downloadUrl !== "undefined") {
    if (mode === "print") {
      const win = window.open(downloadUrl, "_blank");
      win?.addEventListener("load", () => win.print());
    } else {
      window.open(downloadUrl, "_blank");
    }
    return true;
  }
  throw new Error("Download link unavailable for this file.");
}

async function getSignedUrl(caseId, key) {
  const res = await secureFetch(`/api/cases/${caseId}/files/signed-get?key=${encodeURIComponent(key)}`, {
    headers: { Accept: "application/json" },
    noRedirect: true,
  });
  if (res.status === 401) {
    throw new Error("Session expired. Please sign in again.");
  }
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error || payload?.msg || "Unable to sign file");
  }
  const data = await res.json();
  return data?.url || null;
}

async function uploadToS3(file, caseId) {
  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  const body = {
    contentType: file.type || "application/octet-stream",
    ext,
    folder: "cases",
    caseId,
    size: file.size,
  };
  const presignRes = await secureFetch("/api/uploads/presign", {
    method: "POST",
    body,
    headers: { Accept: "application/json" },
  });
  if (!presignRes.ok) throw new Error("Presign failed");
  const { url, key } = await presignRes.json();
  const uploadRes = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!uploadRes.ok) throw new Error("S3 upload failed");
  return key;
}

function toggleModal(modal, show) {
  if (!modal) return;
  modal.classList.toggle("hidden", !show);
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

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const url = new URL(String(rawUrl), window.location.origin);
    const protocol = url.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
      return url.href;
    }
  } catch {}
  return "";
}

function sanitizeDownloadPath(path) {
  if (!path) return "#";
  if (/^https?:/i.test(path)) return path;
  return path.startsWith("/") ? path : `/${path}`;
}

function formatCurrency(amountCents = 0) {
  const dollars = Number(amountCents || 0) / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function fetchDashboardData() {
  const res = await secureFetch("/api/attorney/dashboard", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("Dashboard fetch failed");
  return res.json();
}

async function fetchOverdueCount() {
  try {
    const res = await secureFetch("/api/checklist?overdue=true&limit=1", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Checklist fetch failed");
    const data = await res.json();
    return data.total || 0;
  } catch (err) {
    console.warn("Unable to fetch overdue tasks", err);
    return 0;
  }
}

async function fetchUpcomingEvents(limit = 3) {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await secureFetch(`/api/events?${params.toString()}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error("Events fetch failed");
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch (err) {
    console.warn("Unable to fetch events", err);
    return [];
  }
}

async function fetchThreadsOverview(limit = 10) {
  try {
    const res = await secureFetch(`/api/messages/threads?limit=${limit}`, { headers: { Accept: "application/json" }, noRedirect: true });
    if (!res.ok) throw new Error("Threads fetch failed");
    const data = await res.json();
    return Array.isArray(data.threads) ? data.threads : [];
  } catch (err) {
    console.warn("Unable to fetch threads", err);
    return [];
  }
}

async function fetchApplicationsForMyJobs() {
  try {
    const res = await secureFetch("/api/applications/my-postings", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error("Unable to load applications");
    return res.json();
  } catch (err) {
    console.warn("Failed to load applications", err);
    return [];
  }
}

async function loadApplicationsForMyJobs({ force = false } = {}) {
  if (force) applicationsPromise = null;
  if (applicationsPromise) return applicationsPromise;
  applicationsPromise = (async () => {
    const apps = await fetchApplicationsForMyJobs();
    applicationsCache = Array.isArray(apps) ? apps : [];
    applyApplicationsToCases(applicationsCache);
    return applicationsCache;
  })()
    .catch((err) => {
      console.warn("Applications load failed", err);
      applicationsCache = [];
      return [];
    })
    .finally(() => {
      applicationsPromise = null;
    });
  return applicationsPromise;
}

function updateMetrics(metrics = {}, overdueCount = 0) {
  document.querySelectorAll("[data-metric]").forEach((el) => {
    const key = el.dataset.metric;
    let text = "--";
    if (key === "activeCases") {
      const value = Number(metrics.activeCases || 0);
      const suffix = value === 1 ? "" : "s";
      text = `${value} active case${suffix}`;
      const heading = document.getElementById("activeCasesHeading");
      if (heading && heading.dataset.static !== "true") {
        heading.textContent = value > 0 ? `You have ${value} active case${suffix}` : "";
      }
    } else if (key === "overdueTasks") {
      text = `${overdueCount} overdue task${overdueCount === 1 ? "" : "s"}`;
    } else if (key === "escrowTotal") {
      text = `${formatCurrency(metrics.escrowTotal || 0)} pending in Stripe`;
    }
    el.textContent = text;
  });
}

function filterApplicationsForDisplay(apps = []) {
  return apps.filter((app) => {
    if (!app?.caseId) return true;
    const caseEntry = state.caseLookup.get(String(app.caseId));
    if (!caseEntry) return false;
    if (hasAssignedParalegal(caseEntry)) return false;
    const statusKey = normalizeCaseStatus(caseEntry?.status);
    if (statusKey === "completed") return false;
    if (caseEntry?.archived === true) return false;
    if (caseEntry?.paymentReleased === true) return false;
    return true;
  });
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
    return String(candidate.id || candidate._id || candidate.caseId || "");
  }
  return String(candidate);
}

function applyApplicationsToCases(apps = []) {
  caseApplicationCounts.clear();
  if (!Array.isArray(apps) || !apps.length) return;
  apps.forEach((app) => {
    const caseId = extractCaseIdFromApplication(app);
    if (!caseId) return;
    caseApplicationCounts.set(caseId, (caseApplicationCounts.get(caseId) || 0) + 1);
  });
  applyApplicationCountsToCases({ render: true });
}

function applyApplicationCountsToCases({ render = false } = {}) {
  if (!caseApplicationCounts.size || !Array.isArray(state.cases)) return;
  state.cases.forEach((caseItem) => {
    const caseId = String(caseItem?.id || caseItem?._id || caseItem?.caseId || "");
    if (!caseId || !caseApplicationCounts.has(caseId)) return;
    const existing = Number(
      caseItem.applicantsCount ?? (Array.isArray(caseItem.applicants) ? caseItem.applicants.length : caseItem.applicants) ?? 0
    );
    caseItem.applicantsCount = Math.max(existing, caseApplicationCounts.get(caseId));
  });
  if (render && dashboardViewState.casesInitialized) {
    renderCasesView();
    restoreApplicantDrawerFromQuery();
  }
}

function buildOverviewSignals({ cases = [], apps = [], archivedCases = [], overdueCount = 0 } = {}) {
  const reviewCaseIds = new Set();
  let unfundedCount = 0;
  let completedCasesCount = 0;

  (cases || []).forEach((caseItem) => {
    const statusKey = normalizeCaseStatus(caseItem?.status);
    const hasParalegal = !!(caseItem?.paralegal || caseItem?.paralegalId);
    const escrowFunded = String(caseItem?.escrowStatus || "").toLowerCase() === "funded";
    const awaitingFunding = hasParalegal && !escrowFunded && statusKey !== "open";
    if (awaitingFunding) unfundedCount += 1;

    const caseId = String(caseItem?.id || caseItem?._id || caseItem?.caseId || "");
    (caseItem?.files || []).forEach((file) => {
      const fileStatus = String(file?.status || "").toLowerCase();
      if (fileStatus === "pending_review") {
        reviewCaseIds.add(caseId || String(reviewCaseIds.size));
      }
    });
  });

  (archivedCases || []).forEach((caseItem) => {
    const statusKey = normalizeCaseStatus(caseItem?.status);
    if (statusKey === "completed") {
      completedCasesCount += 1;
    }
  });

  const pendingApplications = filterApplicationsForDisplay(Array.isArray(apps) ? apps : []).filter((app) => {
    const status = String(app?.status || "").toLowerCase();
    return !status || status === "submitted" || status === "pending";
  }).length;

  return {
    unfundedCount,
    casesCreatedCount: Array.isArray(cases) ? cases.length : 0,
    completedCasesCount,
    pendingReviewCount: reviewCaseIds.size,
    overdueCount,
    applicationsCount: pendingApplications,
  };
}

function updateOverviewSignals(partial = {}) {
  Object.assign(overviewSignals, partial);
  const todayMap = {
    unfunded: overviewSignals.unfundedCount,
    casesCreated: overviewSignals.casesCreatedCount,
    completedCases: overviewSignals.completedCasesCount,
    pendingReviews: overviewSignals.pendingReviewCount,
    overdue: overviewSignals.overdueCount,
    applications: overviewSignals.applicationsCount,
  };
  document.querySelectorAll("[data-today]").forEach((el) => {
    const key = el.dataset.today;
    if (key && Object.prototype.hasOwnProperty.call(todayMap, key)) {
      el.textContent = String(todayMap[key]);
    }
  });

  const queueMap = {
    unfunded: overviewSignals.unfundedCount,
    pendingReviews: overviewSignals.pendingReviewCount,
    applications: overviewSignals.applicationsCount,
  };
  document.querySelectorAll("[data-queue]").forEach((el) => {
    const key = el.dataset.queue;
    if (key && Object.prototype.hasOwnProperty.call(queueMap, key)) {
      el.textContent = String(queueMap[key]);
    }
  });
}

async function refreshApplicationsOverview({ force = false } = {}) {
  await loadCasesWithFiles(force);
  const [apps, hasPaymentMethod] = await Promise.all([
    loadApplicationsForMyJobs({ force }),
    hasDefaultPaymentMethod(),
  ]);
  state.billing.hasPaymentMethod = hasPaymentMethod;
  updateOnboardingChecklist();
  renderApplications(apps || [], hasPaymentMethod);
  updateOverviewSignals(
    buildOverviewSignals({
      cases: state.cases,
      apps,
      overdueCount: overviewSignals.overdueCount,
    })
  );
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

function renderDeadlines(container, events = []) {
  if (!container) return;
  const now = new Date();
  const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const upcoming = (events || [])
    .map((ev) => {
      const start = ev?.start ? new Date(ev.start) : null;
      if (!start || Number.isNaN(start.getTime())) return null;
      return { ...ev, start };
    })
    .filter((ev) => ev && ev.start >= now && ev.start <= weekFromNow)
    .sort((a, b) => a.start - b.start)
    .slice(0, 2);
  if (!upcoming.length) {
    container.innerHTML = `<div class="info-line" style="color:var(--muted);">No upcoming deadlines this week.</div>`;
    return;
  }
  container.innerHTML = upcoming
    .map((ev) => {
      const title = sanitize(ev.title || "Event");
      const when = ev.start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      const where = ev.where ? ` · ${sanitize(ev.where)}` : "";
      return `<div class="info-line">&bull; ${title}${where} – <strong>${when}</strong></div>`;
    })
    .join("");
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
  if (messagePreviewSender) messagePreviewSender.textContent = nextThread.title || "Case thread";
  if (messagePreviewText) messagePreviewText.textContent = ` – ${snippet}`;
  const threadId = nextThread.id || null;
  const threadCaseId = nextThread.caseId || nextThread.case?.id || threadId || null;
  state.latestThreadId = threadId;
  state.latestThreadCaseId = threadCaseId;
}

function renderEscrowPanel(container, metrics = {}) {
  if (!container) return;
  const billingHref = "#billing";
  container.innerHTML = `
    <div class="info-line">&bull; View all invoices and receipts in Billing.</div>
    <div class="info-line">&bull; Export your history anytime.</div>
    <div class="info-actions" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;">
      <a class="pill-btn primary" href="${billingHref}" data-view-target="billing">Open Billing &amp; Payments</a>
      <a class="pill-btn" href="/api/payments/export/csv">Download Receipts (CSV)</a>
    </div>
  `;
}

function formatApplicationBudget(app = {}) {
  const value = app.budget ?? app.totalAmount ?? app.paymentAmount ?? "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `$${value.toLocaleString()}`;
  }
  if (value && Number.isFinite(+value)) {
    return `$${Number(value).toLocaleString()}`;
  }
  if (typeof value === "string" && value.trim()) {
    const cleaned = value.trim();
    if (cleaned.startsWith("$")) return cleaned;
    const parsed = parseFloat(cleaned.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(parsed)) {
      return `$${parsed.toLocaleString()}`;
    }
  }
  return "—";
}

function getPrimaryApplication(apps = []) {
  if (!apps.length) return null;
  let primary = apps[0];
  let primaryTime = new Date(primary.createdAt || primary.appliedAt || primary.updatedAt || 0).getTime();
  if (!Number.isFinite(primaryTime)) primaryTime = 0;
  apps.slice(1).forEach((app) => {
    const time = new Date(app.createdAt || app.appliedAt || app.updatedAt || 0).getTime();
    if (Number.isFinite(time) && time > primaryTime) {
      primary = app;
      primaryTime = time;
    }
  });
  return primary;
}

function renderApplications(apps = [], hasPaymentMethod = true) {
  const container = document.getElementById("applicationsSection");
  if (!container) return;
  const filteredApps = filterApplicationsForDisplay(apps);
  if (!filteredApps.length) {
    container.innerHTML = `
      <div class="case-card empty-state">
        <div class="case-header">
          <div>
            <h2>No applications yet</h2>
            <div class="case-subinfo">Paralegal applications to your postings will appear here.</div>
          </div>
        </div>
      </div>`;
    return;
  }
  const grouped = new Map();
  filteredApps.forEach((app, index) => {
    const caseId = extractCaseIdFromApplication(app);
    const key = caseId || `app-${index}`;
    const entry = grouped.get(key) || { caseId, apps: [], latestTimestamp: 0 };
    entry.apps.push(app);
    const timestamp = new Date(app.createdAt || app.appliedAt || app.updatedAt || 0).getTime();
    if (Number.isFinite(timestamp)) {
      entry.latestTimestamp = Math.max(entry.latestTimestamp, timestamp);
    }
    grouped.set(key, entry);
  });

  container.innerHTML = Array.from(grouped.values())
    .sort((a, b) => (b.latestTimestamp || 0) - (a.latestTimestamp || 0))
    .map((group) => {
      const caseId = group.caseId || "";
      const caseEntry = caseId ? state.caseLookup.get(String(caseId)) : null;
      const primaryApp = getPrimaryApplication(group.apps) || group.apps[0] || {};
      const title = sanitize(caseEntry?.title || primaryApp.jobTitle || primaryApp.caseTitle || "Case");
      const practiceRaw =
        caseEntry?.practiceArea ||
        caseEntry?.field ||
        primaryApp.practiceArea ||
        primaryApp.practice ||
        "General practice";
      const practice = sanitize(titleCaseWords(practiceRaw));
      const amountFromCase = caseEntry ? formatCaseAmount(caseEntry) : "—";
      const amount = amountFromCase !== "—" ? amountFromCase : formatApplicationBudget(primaryApp);
      const amountText = amount && amount !== "—" ? sanitize(amount) : "—";
      const applicantsFromCase = caseEntry
        ? Number(
            caseEntry.applicantsCount ??
              (Array.isArray(caseEntry.applicants) ? caseEntry.applicants.length : caseEntry.applicants) ??
              0
          )
        : 0;
      const applicantCount = Math.max(group.apps.length, applicantsFromCase);
      const applicantsLabel = applicantCount === 1 ? "1 applicant" : `${applicantCount} applicants`;
      const paralegalId =
        primaryApp?.paralegal?.id ||
        primaryApp?.paralegal?._id ||
        primaryApp?.paralegalId ||
        "";
      const name = sanitize(
        `${primaryApp?.paralegal?.firstName || ""} ${primaryApp?.paralegal?.lastName || ""}`.trim() ||
          "Paralegal"
      );
      const statusKey = String(primaryApp?.status || "").toLowerCase();
      const canHire = !!caseId && !!paralegalId && !["accepted", "rejected"].includes(statusKey);
      const paymentBlocked = hasPaymentMethod === false;
      const showPaymentGate = paymentBlocked && canHire;
      let hireDisabledAttr = "";
      if (showPaymentGate) {
        hireDisabledAttr = ' disabled aria-disabled="true" title="Add a payment method to hire."';
      } else if (!canHire) {
        hireDisabledAttr = ' disabled aria-disabled="true" title="Select an applicant to hire."';
      }
      const viewApplicantsHref = caseId
        ? `dashboard-attorney.html?openApplicants=1&caseId=${encodeURIComponent(caseId)}#cases:inquiries`
        : "#cases:inquiries";
      const viewApplicantsAttrs = caseId ? "" : ' aria-disabled="true" tabindex="-1"';
      return `
        <div class="case-card applications-summary">
          <div class="case-header">
            <div>
              <h2>${title}</h2>
              <div class="case-subinfo">${practice}${amountText ? ` • ${amountText}` : ""}</div>
              <div class="case-subinfo">${applicantsLabel}</div>
            </div>
            <div class="case-actions">
              <button class="chip" type="button" data-hire-paralegal data-case-id="${sanitize(
                caseId
              )}" data-paralegal-id="${sanitize(paralegalId)}" data-paralegal-name="${name}"${hireDisabledAttr}>Hire</button>
              <a class="chip" href="${sanitize(viewApplicantsHref)}" data-view-applicants data-case-id="${sanitize(
                caseId
              )}"${viewApplicantsAttrs}>View applicants</a>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  bindApplicationsActions();
}

function bindApplicationsActions() {
  if (applicationsActionsBound) return;
  const container = document.getElementById("applicationsSection");
  if (!container) return;
  container.addEventListener("click", (event) => {
    const viewBtn = event.target.closest("[data-view-applicants]");
    if (viewBtn) {
      if (viewBtn.getAttribute("aria-disabled") === "true") {
        return;
      }
      const caseId = viewBtn.dataset.caseId || "";
      if (!caseId) return;
      event.preventDefault();
      openCaseApplications(caseId);
      return;
    }
    const hireBtn = event.target.closest("[data-hire-paralegal]");
    if (!hireBtn) return;
    if (hireBtn.hasAttribute("disabled") || hireBtn.getAttribute("aria-disabled") === "true") {
      return;
    }
    event.preventDefault();
    const caseId = hireBtn.dataset.caseId || "";
    const paralegalId = hireBtn.dataset.paralegalId || "";
    const paralegalName = hireBtn.dataset.paralegalName || "Paralegal";
    if (!caseId || !paralegalId) return;
    handleHireFromApplications({ caseId, paralegalId, paralegalName, button: hireBtn });
  });
  applicationsActionsBound = true;
}

async function handleHireFromApplications({ caseId, paralegalId, paralegalName, button }) {
  if (button) {
    button.classList.add("is-pressed");
    window.setTimeout(() => button.classList.remove("is-pressed"), 180);
  }
  const paymentReady = await hasDefaultPaymentMethod();
  if (!paymentReady) {
    state.billing.hasPaymentMethod = false;
    notifyCases("Add a payment method to hire before hiring.", "error");
    return;
  }
  let caseDetails;
  try {
    caseDetails = await getCaseForHire(caseId);
  } catch (err) {
    notifyCases(err?.message || "Unable to load case details.", "error");
    return;
  }
  const amountCents = Number(caseDetails?.lockedTotalAmount ?? caseDetails?.totalAmount ?? 0);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    notifyCases("Payment amount is unavailable for this case.", "error");
    return;
  }

  openHireConfirmModal({
    paralegalName,
    amountCents,
    feePct: PLATFORM_FEE_PCT,
    continueHref: `case-detail.html?caseId=${encodeURIComponent(caseId)}`,
    onConfirm: async () => {
      const originalText = button?.textContent || "Hire";
      if (button) {
        button.textContent = "Processing...";
        button.setAttribute("disabled", "disabled");
      }
      try {
        await hireParalegal(caseId, paralegalId);
        await refreshApplicationsOverview({ force: true });
      } catch (err) {
        if (button) {
          button.removeAttribute("disabled");
          button.textContent = originalText;
        }
        throw err;
      }
    },
  });
}

async function hasDefaultPaymentMethod() {
  try {
    const res = await secureFetch("/api/payments/payment-method/default", {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) return false;
    return !!payload?.paymentMethod;
  } catch {
    return false;
  }
}

async function getCaseForHire(caseId) {
  const existing = state.caseLookup.get(String(caseId));
  if (existing) return existing;
  const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, { headers: { Accept: "application/json" } });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "Unable to load case details.");
  }
  return payload;
}

const DEFAULT_HIRE_ERROR = "Unable to hire paralegal.";

function formatHireErrorMessage(message) {
  if (!message || typeof message !== "string") return DEFAULT_HIRE_ERROR;
  const normalized = message.toLowerCase();
  if (normalized.includes("stripe") && normalized.includes("connect")) {
    return "This paralegal must connect Stripe before you can hire them.";
  }
  if (
    normalized.includes("stripe") &&
    (normalized.includes("onboard") || normalized.includes("onboarding") || normalized.includes("payout"))
  ) {
    return "This paralegal must complete Stripe onboarding before you can hire them.";
  }
  return message;
}

async function hireParalegal(caseId, paralegalId) {
  const res = await secureFetch(
    `/api/cases/${encodeURIComponent(caseId)}/hire/${encodeURIComponent(paralegalId)}`,
    { method: "POST", body: {} }
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || DEFAULT_HIRE_ERROR);
  return payload;
}

function ensureHireModalStyles() {
  if (document.getElementById("hire-confirm-styles")) return;
  const style = document.createElement("style");
  style.id = "hire-confirm-styles";
  style.textContent = `
    .hire-confirm-overlay{position:fixed;inset:0;background:rgba(15,23,42,.4);display:flex;align-items:center;justify-content:center;z-index:1500;opacity:0;visibility:hidden;transition:opacity .16s ease,visibility .16s ease}
    .hire-confirm-overlay.is-visible{opacity:1;visibility:visible}
    .hire-confirm-overlay.is-closing{pointer-events:none}
    .hire-confirm-modal{background:var(--panel,#fff);border:1px solid var(--line,rgba(0,0,0,0.08));border-radius:var(--radius,18px);padding:28px;max-width:580px;width:min(94%,580px);box-shadow:0 24px 50px rgba(0,0,0,.2);display:grid;gap:16px;font-family:'Cormorant Garamond',serif;font-weight:300;color:var(--ink,#1a1a1a);font-size:1.05rem;opacity:0;transform:translateY(10px) scale(.985);transition:opacity .16s ease,transform .16s ease}
    .hire-confirm-overlay.is-visible .hire-confirm-modal{opacity:1;transform:translateY(0) scale(1)}
    .hire-confirm-modal button,
    .hire-confirm-modal a{font-family:'Cormorant Garamond',serif}
    .hire-confirm-modal p{font-weight:300;color:var(--muted,#666)}
    .hire-confirm-title{font-weight:300;font-size:1.6rem;letter-spacing:0.01em}
    .hire-confirm-summary{border:1px solid var(--line,rgba(0,0,0,0.08));border-radius:var(--radius,14px);padding:14px 18px;display:grid;gap:12px;background:var(--panel,#fff)}
    .hire-confirm-row{display:flex;justify-content:space-between;gap:16px;align-items:baseline}
    .hire-confirm-row span{text-transform:uppercase;font-size:0.75rem;letter-spacing:0.08em;color:var(--muted,#666);font-weight:300}
    .hire-confirm-row strong{font-size:1.3rem;font-weight:300;color:var(--ink,#1a1a1a)}
    .hire-confirm-total strong{font-weight:400}
    .hire-confirm-help{display:flex;justify-content:flex-end;margin-top:-6px}
    .hire-confirm-info{width:26px;height:26px;border-radius:50%;border:1px solid var(--line,rgba(0,0,0,0.08));background:var(--panel,#fff);color:var(--muted,#666);font-size:0.8rem;font-weight:250;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;position:relative;padding:0;transition:border-color .2s ease,color .2s ease,transform .15s ease}
    .hire-confirm-info:hover,
    .hire-confirm-info:focus-visible{border-color:var(--accent,#b6a47a);color:var(--ink,#1a1a1a);transform:translateY(-1px)}
    .hire-confirm-tooltip{position:absolute;right:0;bottom:calc(100% + 10px);width:min(320px,80vw);padding:12px 14px;border-radius:12px;background:var(--panel,#fff);border:1px solid var(--line,rgba(0,0,0,0.08));box-shadow:0 18px 40px rgba(0,0,0,.18);font-size:0.78rem;line-height:1.45;color:var(--ink,#1a1a1a);opacity:0;pointer-events:none;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;z-index:2}
    .hire-confirm-info:hover .hire-confirm-tooltip,
    .hire-confirm-info:focus-visible .hire-confirm-tooltip{opacity:1;pointer-events:auto;transform:translateY(0)}
    .hire-confirm-error{border:1px solid rgba(185,28,28,.4);background:rgba(254,242,242,.9);color:#991b1b;border-radius:10px;padding:8px 10px;font-size:0.9rem}
    .hire-confirm-error a{color:inherit;text-decoration:underline;font-weight:400}
    .hire-confirm-error a:hover{color:var(--ink,#1a1a1a)}
    .hire-confirm-success{border:1px solid rgba(22,163,74,.35);background:rgba(240,253,244,.9);color:#166534;border-radius:10px;padding:8px 10px;font-size:0.9rem}
    .hire-confirm-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:4px;flex-wrap:wrap}
    .hire-confirm-actions[hidden]{display:none}
    @media (prefers-reduced-motion: reduce){
      .hire-confirm-overlay,.hire-confirm-modal{transition:none}
    }
  `;
  document.head.appendChild(style);
}

function openHireConfirmModal({ paralegalName, amountCents, feePct, continueHref, onConfirm }) {
  ensureHireModalStyles();
  const safeName = sanitize(paralegalName || "Paralegal");
  const feeNote =
    "Platform fee includes Stripe security, dispute support, payment processing, and vetted paralegal access.";
  const feeRate = Number(feePct || 0);
  const feeCents = Math.max(0, Math.round(Number(amountCents || 0) * (feeRate / 100)));
  const totalCents = Math.max(0, Math.round(Number(amountCents || 0) + feeCents));
  const overlay = document.createElement("div");
  overlay.className = "hire-confirm-overlay";
  overlay.innerHTML = `
    <div class="hire-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="hireConfirmTitle">
      <div class="hire-confirm-title" id="hireConfirmTitle">Confirm Hire</div>
      <p>You’re about to hire ${safeName}. This will fund Stripe immediately. Once you mark the matter Complete, only then will funds be released to the paralegal.</p>
      <div class="hire-confirm-summary">
        <div class="hire-confirm-row">
          <span>Case amount</span>
          <strong>${sanitize(formatCurrency(amountCents))}</strong>
        </div>
        <div class="hire-confirm-row">
          <span>Platform fee (${feeRate}%)</span>
          <strong>${sanitize(formatCurrency(feeCents))}</strong>
        </div>
        <div class="hire-confirm-row hire-confirm-total">
          <span>Total charge</span>
          <strong>${sanitize(formatCurrency(totalCents))}</strong>
        </div>
      </div>
      <div class="hire-confirm-help">
        <button class="hire-confirm-info" type="button" aria-label="${sanitize(feeNote)}">
          ?
          <span class="hire-confirm-tooltip" aria-hidden="true">${sanitize(feeNote)}</span>
        </button>
      </div>
      <div class="hire-confirm-error" data-hire-error hidden></div>
      <div class="hire-confirm-success" data-hire-success hidden>Case funded. Work can begin.</div>
      <div class="hire-confirm-actions" data-hire-actions>
        <button class="btn secondary" type="button" data-hire-cancel>Cancel</button>
        <button class="btn primary" type="button" data-hire-confirm>Confirm &amp; Hire</button>
        <a class="btn primary" href="${sanitize(continueHref || "#")}" data-hire-continue hidden>Continue to case</a>
      </div>
    </div>
  `;
  const errorEl = overlay.querySelector("[data-hire-error]");
  const successEl = overlay.querySelector("[data-hire-success]");
  const continueEl = overlay.querySelector("[data-hire-continue]");
  const confirmBtn = overlay.querySelector("[data-hire-confirm]");
  const cancelBtn = overlay.querySelector("[data-hire-cancel]");

  const close = () => {
    if (overlay.classList.contains("is-closing")) return;
    overlay.classList.add("is-closing");
    overlay.classList.remove("is-visible");
    const removeOverlay = () => {
      overlay.removeEventListener("transitionend", handleTransitionEnd);
      overlay.remove();
    };
    const handleTransitionEnd = (event) => {
      if (event.target === overlay) removeOverlay();
    };
    overlay.addEventListener("transitionend", handleTransitionEnd);
    window.setTimeout(removeOverlay, 200);
  };
  const canClose = () => {
    if (successEl && !successEl.hidden) return true;
    return !confirmBtn?.disabled;
  };
  const setLoading = (isLoading) => {
    if (confirmBtn) {
      confirmBtn.disabled = isLoading;
      confirmBtn.textContent = isLoading ? "Charging..." : "Confirm & Hire";
    }
    if (cancelBtn) cancelBtn.disabled = isLoading;
  };
  if (errorEl) {
    errorEl.addEventListener("click", (event) => {
      const link = event.target?.closest?.("a");
      if (!link) return;
      close();
    });
  }
  const showError = (message) => {
    if (!errorEl) return;
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    const safe = sanitize(message);
    const phrase = "update your payment method";
    if (safe.toLowerCase().includes(phrase)) {
      const linked = safe.replace(
        new RegExp(phrase, "i"),
        `<a href="dashboard-attorney.html#billing">update your payment method</a>`
      );
      errorEl.innerHTML = linked;
    } else {
      errorEl.textContent = safe;
    }
    errorEl.hidden = false;
  };
  const showSuccess = () => {
    if (successEl) successEl.hidden = false;
    if (confirmBtn) confirmBtn.hidden = true;
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = "Close";
    }
    if (continueEl) continueEl.hidden = false;
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay && canClose()) close();
  });
  cancelBtn?.addEventListener("click", () => {
    if (canClose()) close();
  });
  confirmBtn?.addEventListener("click", async () => {
    showError("");
    setLoading(true);
    try {
      await onConfirm?.();
      showSuccess();
    } catch (err) {
      showError(formatHireErrorMessage(err?.message));
      setLoading(false);
    }
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && canClose()) close();
    },
    { once: true }
  );
  document.body.appendChild(overlay);
  window.requestAnimationFrame(() => overlay.classList.add("is-visible"));
}

function renderCaseCards(container, cases = [], threadsByCase = new Map()) {
  if (!container) return;
  const homeView = document.querySelector(".view-home");
  if (homeView) {
    homeView.classList.toggle("home-compact", cases.length <= 2);
  }
  const pageCases = cases.slice(0, HOME_PAGE_SIZE);
  if (!cases.length) {
    container.hidden = false;
    container.innerHTML = `
      <div class="matter-row">
        <div class="matter-main">
          <div class="matter-title">No recent matters</div>
          <div class="matter-meta">Your latest matters will appear here.</div>
        </div>
      </div>
    `;
    return;
  }
  container.hidden = false;
  container.innerHTML = pageCases
    .map((c) => {
      return buildMatterRowMarkup(c, threadsByCase);
    })
    .join("");

  bindMatterRowHandlers(container);
}

function buildMatterRowMarkup(caseItem, threadsByCase) {
  const caseId = String(caseItem.caseId || caseItem.id || "");
  const title = sanitize(caseItem.jobTitle || "Untitled Matter");
  const paralegal = sanitize(caseItem.paralegalName || "Unassigned");
  const practice = sanitize(caseItem.practiceArea || "General");
  const rawStatus = normalizeCaseStatus(caseItem.status);
  const status = rawStatus
    ? rawStatus.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    : "Open";
  const created = caseItem.createdAt ? new Date(caseItem.createdAt).toLocaleDateString() : "";
  const metaParts = [practice, paralegal, status, created ? `Created ${created}` : ""].filter(Boolean);
  const thread = threadsByCase.get(caseId);
  const unread = Number(thread?.unread || 0);
  const messageLabel =
    unread > 0
      ? `\u{1F4AC} ${unread} new message${unread === 1 ? "" : "s"}${
          paralegal && paralegal !== "Unassigned" ? ` from ${paralegal}` : ""
        }`
      : "";
  return `
    <div class="matter-row" data-case-id="${caseId}">
      <div class="matter-main">
        <div class="matter-title">${title}</div>
        <div class="matter-meta">${metaParts.join(" • ")}</div>
        ${messageLabel ? `<button type="button" class="matter-message" data-case-link="view" data-case-id="${caseId}">${messageLabel}</button>` : ""}
      </div>
      <button type="button" class="matter-view" data-case-link="view" data-case-id="${caseId}">View →</button>
    </div>
  `;
}

function bindMatterRowHandlers(container) {
  if (!container) return;
  container.querySelectorAll(".matter-row").forEach((row) => {
    row.addEventListener("click", (evt) => {
      if (evt.target.closest("[data-case-link]")) return;
      const caseId = row.getAttribute("data-case-id");
      if (caseId) {
        const entry = state.caseLookup.get(String(caseId));
        if (isWorkspaceEligibleCase(entry)) {
          window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
        } else {
          void openCasePreview(caseId);
        }
      }
    });
  });

  container.querySelectorAll("[data-case-link]").forEach((btn) => {
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const caseId = btn.getAttribute("data-case-id");
      if (!caseId) return;
      const entry = state.caseLookup.get(String(caseId));
      if (isWorkspaceEligibleCase(entry)) {
        window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
      } else {
        void openCasePreview(caseId);
      }
    });
  });
}
