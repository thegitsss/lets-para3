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
  attorney: new Set(["create-case"]),
};
const STATUS_LABELS = {
  pending_review: "Pending Review",
  approved: "Approved",
  attorney_revision: "Attorney Revisions",
};
const CASE_VIEW_FILTERS = ["active", "draft", "archived", "inquiries"];
const CASE_FILE_MAX_BYTES = 20 * 1024 * 1024;
const LOCAL_DRAFTS_KEY = "attorneyLocalDraftCases";
const PENDING_HIRE_KEY = "lpc_pending_hire_funding";
const FUNDED_WORKSPACE_STATUSES = new Set([
  "funded_in_progress",
  "in progress",
  "in_progress",
  "active",
  "awaiting_documents",
  "reviewing",
]);
const TERMINAL_CASE_STATUSES = new Set(["completed", "closed", "cancelled", "canceled"]);
function getProfileImageUrl(user = {}) {
  return user.profileImage || user.avatarURL || "assets/images/default-avatar.png";
}

const INVITE_AVATAR_FALLBACK = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'><defs><linearGradient id='g' x1='0%' y1='0%' x2='100%' y2='100%'><stop offset='0%' stop-color='#f4f4f5'/><stop offset='100%' stop-color='#e5e7eb'/></linearGradient></defs><rect width='96' height='96' rx='48' fill='url(#g)'/><circle cx='48' cy='38' r='18' fill='#d1d5db'/><path d='M20 84c6-18 22-28 28-28s22 10 28 28' fill='none' stroke='#cbd5e1' stroke-width='6' stroke-linecap='round'/></svg>"
)}`;

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
  tasksPromise: null,
  latestThreadId: null,
  latestThreadCaseId: null,
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

let openCaseMenu = null;
let openCaseMenuTrigger = null;
let caseMenuKeydownBound = false;
let chatMenuWrapper = null;
let applicationsActionsBound = false;

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

  ensureHeaderStyles();
  const pageKey = (PAGE_ID || "").toLowerCase();
  const role = String(state.user?.role || "").toLowerCase();
  const headerOnly = HEADER_ONLY_ROUTES[role]?.has(pageKey);
  const skipNotifications = role !== "paralegal" && headerOnly;
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
  .lpc-shared-header .notification-wrapper{position:relative}
  .lpc-shared-header .notification-icon{width:46px;height:46px;border-radius:50%;border:1px solid var(--line, rgba(0,0,0,0.08));display:flex;justify-content:center;align-items:center;background:var(--panel, #fff);cursor:pointer;transition:border-color .2s ease,transform .2s ease,background .2s ease}
  .lpc-shared-header .notification-icon:hover{border-color:#b6a47a;transform:translateY(-1px)}
  .lpc-shared-header .notification-icon svg{width:22px;height:22px;color:var(--ink, #1a1a1a);transition:color .2s ease}
  .lpc-shared-header .notification-badge{position:absolute;top:-4px;right:-4px;background:#c0392b;color:#fff;font-size:.75rem;border-radius:999px;padding:2px 6px;line-height:1;display:none;font-weight:600}
  .lpc-shared-header .notification-badge.show{display:inline-flex}
  .lpc-shared-header [data-notification-toggle][data-count]:after{
    content:attr(data-count);
    position:absolute;
    top:-4px;
    right:-4px;
    background:#b6a47a;
    color:#fff;
    font-family:'Sarabun',sans-serif;
    font-weight:200;
    font-size:0.7rem;
    padding:2px 6px;
    border-radius:999px;
  }
  .lpc-shared-header .user-chip{display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.4);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);transition:border-color .2s ease, box-shadow .2s ease}
  .lpc-shared-header .user-chip img{width:44px;height:44px;border-radius:50%;border:2px solid #fff;box-shadow:0 4px 16px rgba(0,0,0,0.08);object-fit:cover}
  .lpc-shared-header .user-chip strong{display:block;font-weight:600;color:#1a1a1a}
  .lpc-shared-header .user-chip span{font-size:.85rem;color:#6b6b6b}
  body.theme-dark .lpc-shared-header .user-chip{background:rgba(15,23,42,0.4);border-color:rgba(255,255,255,0.15);box-shadow:0 10px 25px rgba(0,0,0,0.35)}
  body.theme-dark .lpc-shared-header .user-chip strong{color:#fff}
  body.theme-dark .lpc-shared-header .user-chip span{color:rgba(255,255,255,0.8)}
  body.theme-mountain .lpc-shared-header .user-chip{background:rgba(255,255,255,0.65);border-color:rgba(255,255,255,0.42);box-shadow:0 18px 34px rgba(17,22,26,0.2)}
  body.theme-mountain .lpc-shared-header .user-chip strong{color:#1b1b1b}
  body.theme-mountain .lpc-shared-header .user-chip span{color:#6b6b6b}
  .lpc-shared-header .profile-dropdown{position:absolute;right:0;top:calc(100% + 10px);background:#fff;border:1px solid rgba(0,0,0,0.08);border-radius:16px;box-shadow:0 18px 30px rgba(0,0,0,0.12);display:none;flex-direction:column;min-width:200px;z-index:9999;pointer-events:auto;overflow:visible}
  .lpc-shared-header .profile-dropdown.show{display:flex;pointer-events:auto;overflow:visible}
  .lpc-shared-header .profile-dropdown button{background:none;border:none;padding:.85rem 1.1rem;text-align:left;font-size:.92rem;cursor:pointer}
  .lpc-shared-header .profile-dropdown button:hover{background:rgba(0,0,0,0.04)}
  .lpc-shared-header .notifications-panel{position:absolute;top:72px;right:0;width:340px;background:var(--panel,#fff);border-radius:14px;border:1px solid var(--line,rgba(0,0,0,0.08));box-shadow:0 24px 48px rgba(0,0,0,0.15);padding:0;opacity:0;pointer-events:none;transform:translateY(-10px);transition:opacity .2s ease,transform .2s ease;z-index:30;display:flex;flex-direction:column}
  .lpc-shared-header .notifications-panel.show{opacity:1;pointer-events:auto;transform:translateY(0)}
  .lpc-shared-header .notifications-panel.hidden{display:none}
  .lpc-shared-header .notifications-panel .notif-header{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:1.2rem;padding:14px 18px;border-bottom:1px solid var(--line,rgba(0,0,0,0.08));background:rgba(0,0,0,0.02);margin:0}
  .lpc-shared-header .notifications-panel #notifList{max-height:220px;overflow-y:auto}
  .lpc-shared-header .notifications-panel .notif-item{padding:14px 18px;border-bottom:1px solid var(--line,rgba(0,0,0,0.06));cursor:pointer}
  .lpc-shared-header .notifications-panel .notif-item.unread{border-left:3px solid #b6a47a}
  .lpc-shared-header .notifications-panel .notif-item.read{opacity:.75}
  .lpc-shared-header .notifications-panel .notif-title{font-family:'Cormorant Garamond',serif;font-weight:300;font-size:1.1rem;margin-bottom:2px}
  .lpc-shared-header .notifications-panel .notif-body{font-family:'Sarabun',sans-serif;font-weight:200;font-size:.92rem;color:var(--ink,#4b4b4b)}
  .lpc-shared-header .notifications-panel .notif-time{font-family:'Sarabun',sans-serif;font-weight:200;font-size:.78rem;color:var(--muted,#888);margin-top:4px}
  .lpc-shared-header .notifications-panel .notif-empty{padding:16px;text-align:center;font-size:.9rem;color:var(--muted,#777);margin:0}
  .lpc-shared-header .notifications-panel .notif-markall{border:none;border-top:1px solid var(--line,rgba(0,0,0,0.08));background:rgba(0,0,0,0.02);padding:12px;text-align:left;font-size:.9rem;cursor:pointer;font-family:'Sarabun',sans-serif;font-weight:200;color:var(--ink,#1a1a1a)}
  body.theme-dark .lpc-shared-header .notification-icon{border-color:rgba(255,255,255,0.18);background:rgba(17,25,40,0.75)}
  body.theme-dark .lpc-shared-header .notification-icon svg{color:#f8fbff}
  body.theme-dark .lpc-shared-header .notifications-panel{background:rgba(18,23,36,0.98);border-color:rgba(255,255,255,0.12);box-shadow:0 24px 48px rgba(0,0,0,0.5)}
  body.theme-dark .lpc-shared-header .notifications-panel .notif-header{background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.12)}
  body.theme-dark .lpc-shared-header .notifications-panel .notif-item{border-color:rgba(255,255,255,0.08)}
  body.theme-dark .lpc-shared-header .notifications-panel .notif-body{color:#e3e8f7}
  body.theme-dark .lpc-shared-header .notifications-panel .notif-time,
  body.theme-dark .lpc-shared-header .notifications-panel .notif-empty{color:#a9b4d6}
  body.theme-dark .lpc-shared-header .notifications-panel .notif-markall{background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.08);color:#f4f7ff}
  body.theme-mountain .lpc-shared-header .notification-icon{background:rgba(255,255,255,0.75);border-color:rgba(255,255,255,0.5)}
  body.theme-mountain .lpc-shared-header .notification-icon svg{color:#1d1d1d}
  body.theme-mountain .lpc-shared-header .notifications-panel{background:rgba(255,255,255,0.9);border-color:rgba(255,255,255,0.5);backdrop-filter:blur(14px)}
  body.theme-mountain .lpc-shared-header .notifications-panel .notif-header{background:rgba(255,255,255,0.6);border-color:rgba(255,255,255,0.4)}
  body.theme-mountain .lpc-shared-header .notifications-panel .notif-body{color:#2e2b28}
  `;
  document.head.appendChild(style);
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
            <div class="notif-header">Notifications</div>
            <div class="notif-scroll" data-notification-list></div>
            <div class="notif-empty" data-notification-empty>Loading…</div>
            <button type="button" class="notif-markall" data-notification-mark>Mark All Read</button>
          </div>
        </div>
        <div class="user-chip" id="headerUser" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-controls="profileDropdown" aria-label="Open profile menu">
          <img id="headerAvatar" src="https://via.placeholder.com/60" alt="Attorney avatar" />
          <div>
            <strong id="headerName">Attorney</strong>
            <span id="headerRole">Member</span>
          </div>
          <div class="profile-dropdown" id="profileDropdown" aria-hidden="true">
            <button type="button" data-account-settings>Account Settings</button>
            <button type="button" data-logout onclick="window.logoutUser?.(event)">Log Out</button>
          </div>
        </div>
      </div>
    </div>
  `;

  await loadUser();
  bindHeaderEvents();
  if (!skipNotifications) {
    scanNotificationCenters();
  }
}

function bindHeaderEvents() {
  const profileTrigger = document.getElementById("headerUser");
  const profileMenu = document.getElementById("profileDropdown");
  const settingsBtn = profileMenu?.querySelector("[data-account-settings]");
  const logoutBtn = profileMenu?.querySelector("[data-logout]");
  const notifToggle = document.querySelector("[data-notification-toggle]");
  const notifPanel = document.querySelector("[data-notification-panel]");
  const triggerLogout = async (evt) => {
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
  };

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
  if (logoutBtn && !logoutBtn.dataset.boundLogout) {
    logoutBtn.dataset.boundLogout = "true";
    logoutBtn.addEventListener("click", triggerLogout);
  }

  // Fallback notification toggle if notifications.js didn't bind yet
  if (notifToggle && notifPanel && !notifToggle.dataset.boundNotifFallback) {
    notifToggle.dataset.boundNotifFallback = "true";
    notifToggle.addEventListener("click", () => {
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

  document.addEventListener("click", (evt) => {
    const target = evt.target.closest("[data-logout]");
    if (!target) return;
    triggerLogout(evt);
  });

  document.addEventListener("click", (evt) => {
    if (profileMenu && !profileMenu.contains(evt.target) && !profileTrigger.contains(evt.target)) {
      profileMenu.classList.remove("show");
      profileMenu.setAttribute("aria-hidden", "true");
      profileTrigger?.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("keydown", (evt) => {
    if (evt.key !== "Escape") return;
    if (!profileMenu || !profileTrigger) return;
    if (!profileMenu.classList.contains("show")) return;
    profileMenu.classList.remove("show");
    profileMenu.setAttribute("aria-hidden", "true");
    profileTrigger.setAttribute("aria-expanded", "false");
  });
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
  const nameEl = document.getElementById("headerName");
  const avatarEl = document.getElementById("headerAvatar");
  const roleEl = document.getElementById("headerRole");
  const heading = document.getElementById("user-name-heading");
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) avatarEl.src = avatar;
  if (roleEl) roleEl.textContent = roleLabel;
  if (heading) heading.textContent = current.firstName || heading.textContent;
  if (current.profileImage) {
    const avatarNode = document.querySelector("#user-avatar");
    if (avatarNode) avatarNode.src = current.profileImage;
  }
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

// -------------------------
// Overview Page
// -------------------------
async function initOverviewPage() {
  const messageBox = document.getElementById("messageBox");
  const messageCountSpan = document.getElementById("messageCount");
  const pluralSpan = document.getElementById("plural");
  const completedJobsList = document.getElementById("completedJobsList");
  const messageSnippet = document.getElementById("messageSnippet");
  const messagePreviewSender = document.getElementById("messagePreviewSender");
  const messagePreviewText = document.getElementById("messagePreviewText");
  const messagePreviewLink = document.getElementById("messagePreviewLink");
  const deadlineList = document.getElementById("deadlineList");
  const escrowDetails = document.getElementById("escrowDetails");
  const caseCards = document.getElementById("caseCards");
  const quickButtons = document.querySelectorAll("[data-quick-link]");

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

  function updateMessageBubble(count = 0) {
    if (messageCountSpan) messageCountSpan.textContent = String(count);
    if (pluralSpan) pluralSpan.textContent = count === 1 ? " waiting" : "s waiting";
  }

  updateMessageBubble(0);
  fetchUnreadMessages().catch(() => {});
  loadCompletedJobs(completedJobsList).catch(() => {});
  hydrateOverview().catch(() => {});

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
        fetchThreadsOverview(),
        fetchApplicationsForMyJobs(),
        hasDefaultPaymentMethod(),
        loadCasesWithFiles(),
      ]);
      state.billing.hasPaymentMethod = hasPaymentMethod;
      const eligibleCaseIds = new Set(
        filterWorkspaceEligibleCases(state.cases).map((item) => String(item.id || item._id || ""))
      );
      const filteredCaseCards = (dashboard?.activeCases || []).filter((item) => {
        const id = item?.caseId || item?.id || item?._id;
        return id && eligibleCaseIds.has(String(id));
      });
      updateMetrics(dashboard?.metrics, overdueCount);
      renderCaseCards(caseCards, filteredCaseCards);
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
    } catch (err) {
      console.warn("Overview hydration failed", err);
      if (deadlineList) deadlineList.innerHTML = `<div class="info-line" style="color:var(--muted);">Unable to load deadlines.</div>`;
    }
  }

  setupDashboardViewRouter();
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

  if (!skipHash && target) {
    const normalized = `#${target}`;
    if (window.location.hash !== normalized) {
      window.location.hash = target;
      return;
    }
  }

  if (target === "cases") {
    void ensureCasesViewReady().then(() => {
      if (caseFilter && CASE_VIEW_FILTERS.includes(caseFilter)) {
        setCaseFilter(caseFilter);
      }
      maybeOpenCasePreviewFromQuery();
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

function setCaseFilter(filterKey) {
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
  renderCasesView();
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
  const receiptLink = caseId
    ? `<a href="/api/payments/receipt/attorney/${encodeURIComponent(caseId)}?regen=1" target="_blank" rel="noopener">Download Receipt</a>`
    : '<span class="muted">Receipt unavailable</span>';
  return `
    <div class="completed-job-card">
      <div class="info-line"><strong>${summary}</strong></div>
      <div class="info-line" style="color:var(--muted);">Completed ${completedAt}</div>
      <div class="downloads">${archiveLink} · ${receiptLink}</div>
    </div>
  `;
}

function goToMessages(caseId) {
  if (!caseId) {
    notifyMessages("Open an active case to view messages.", "info");
    return;
  }
  const target = `case-detail.html?caseId=${encodeURIComponent(caseId)}#messages`;
  window.location.href = target;
}
// -------------------------
// Billing Page
// -------------------------
async function initBillingPage() {
  const postedBody = document.getElementById("postedJobsBody");
  const activeBody = document.getElementById("activeEscrowsBody");
  const completedBody = document.getElementById("completedPaymentsBody");
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
  if (force) body.innerHTML = `<tr><td colspan="6" class="empty-state">Refreshing escrow activity…</td></tr>`;
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
    body.innerHTML = `<tr><td colspan="6" class="empty-state">No active escrow payments.</td></tr>`;
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
          <td>
            <div class="btn-group">
              <button type="button" class="secondary" data-escrow-action="view" data-case-id="${caseId}">View Case</button>
              <button type="button" data-escrow-action="messages" data-case-id="${caseId}">Open Messages</button>
            </div>
          </td>
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
  const labels = ["Posted Jobs", "Active Escrows", "Completed Jobs"];
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
  open: "Open",
  assigned: "Invited",
  active: "Active",
  awaiting_funding: "Hired - Pending Funding",
  awaiting_documents: "Awaiting Docs",
  reviewing: "Reviewing",
  "in progress": "In Progress",
  in_progress: "In Progress",
  completed: "Completed",
  disputed: "Disputed",
  cancelled: "Cancelled",
  closed: "Closed",
};
const CASE_STATUS_CLASSES = {
  open: "public",
  active: "public",
  assigned: "pending",
  awaiting_funding: "pending",
  awaiting_documents: "pending",
  reviewing: "pending",
  "in progress": "private",
  in_progress: "private",
  completed: "accepted",
  disputed: "declined",
  cancelled: "declined",
  closed: "declined",
};

async function initCasesPage() {
  const wrapper = document.querySelector("[data-cases-wrapper]");
  if (!wrapper) return;

  const searchInput = document.querySelector("[data-cases-search]");
  const tabs = document.querySelectorAll("[data-case-filter]");

  try {
    await Promise.all([loadCasesWithFiles(), loadArchivedCases()]);
    state.localDrafts = readLocalDrafts();
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
  const applicantCount = Number(item.applicants || 0);
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

function renderCaseRow(item, filterKey = "active") {
  let client = item.paralegal?.name || item.paralegalNameSnapshot || "Awaiting hire";
  if (!item.paralegal && item.pendingParalegal) {
    const pendingName =
      item.pendingParalegal.name ||
      [item.pendingParalegal.firstName, item.pendingParalegal.lastName].filter(Boolean).join(" ").trim();
    client = `${pendingName || "Invitation"} (Invitation Sent)`;
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
  const rawNote = (item.internalNotes?.note || "").trim();
  const notePreview = rawNote.length > 140 ? `${rawNote.slice(0, 137)}…` : rawNote;
  const noteDisplay = notePreview ? `<div class="note-preview">${sanitize(notePreview)}</div>` : '<span class="muted">—</span>';
  const noteAction =
    !item.localDraft && canEditCaseNotes() && item.id
      ? `<button type="button" class="note-edit-btn" data-case-action="edit-note" data-case-id="${item.id}">${
          rawNote ? "Edit Note" : "Add Note"
        }</button>`
      : "";
  const selectionCell =
    filterKey === "archived"
      ? `<td class="case-select"><input type="checkbox" data-archived-select value="${item.id}" ${
          state.archivedSelection.has(String(item.id)) ? "checked" : ""
        } aria-label="Select case ${sanitize(item.title || "Untitled Case")}" /></td>`
      : "";
  return `
    <tr data-case-id="${item.id}">
      ${selectionCell}
      <td>${
        item.localDraft
          ? `<a href="create-case.html#description">${sanitize(item.title || "Untitled Case")}</a>`
          : canViewWorkspace
          ? `<a href="case-detail.html?caseId=${encodeURIComponent(item.id)}">${sanitize(item.title || "Untitled Case")}</a>`
          : `<span>${sanitize(item.title || "Untitled Case")}</span>`
      }</td>
      <td>${sanitize(client)}</td>
      <td>${sanitize(practice)}</td>
      <td><span class="status ${statusClass}">${statusText}</span></td>
      <td>${sanitize(amountDisplay)}</td>
      <td class="note-cell">${noteDisplay}${noteAction ? `<div>${noteAction}</div>` : ""}</td>
      <td>${displayedDate}</td>
      <td class="actions">${renderCaseMenu(item)}</td>
    </tr>
  `;
}

function renderCaseMenu(item) {
  const safeId = String(item.id || "case").replace(/[^a-z0-9_-]/gi, "");
  const menuId = `case-menu-${safeId || "case"}`;
  const isFinal = isFinalCase(item);
  const canViewWorkspace = isWorkspaceEligibleCase(item);
  const statusKey = String(item.status || "").toLowerCase();
  const hasPendingInvite = !!(item.pendingParalegal || item.pendingParalegalId);
  if (item.localDraft) {
    return `
    <div class="case-actions" data-case-id="${item.id}">
      <button class="menu-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" data-case-menu-trigger>⋯</button>
      <div class="case-menu" id="${menuId}" role="menu" style="width: 180px; min-width: 180px;">
        <button type="button" class="menu-item" data-case-action="resume-draft" data-case-id="${item.id}">Resume Draft</button>
        <button type="button" class="menu-item danger" data-case-action="discard-draft" data-case-id="${item.id}">Discard Draft</button>
      </div>
    </div>
    `;
  }
  const parts = [];
  if (canViewWorkspace) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="view" data-case-id="${item.id}">View Case</button>`,
      `<button type="button" class="menu-item" data-case-action="messages" data-case-id="${item.id}">Open Messages</button>`
    );
  } else if (!item.archived) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="details" data-case-id="${item.id}">View Details</button>`
    );
  }
  if (statusKey === "assigned" && hasPendingInvite) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="view-invited" data-case-id="${item.id}">View Invited Paralegals</button>`
    );
  }
  if (hasDeliverables(item)) {
    parts.push(
      `<button type="button" class="menu-item" data-case-action="download" data-case-id="${item.id}">Download Files</button>`
    );
  }
  if (item.archived) {
    if (!isFinal) {
      parts.push(
        `<button type="button" class="menu-item" data-case-action="restore" data-case-id="${item.id}">Restore Case</button>`
      );
    }
  } else {
    parts.push(
      `<button type="button" class="menu-item danger" data-case-action="archive" data-case-id="${item.id}">Archive Case</button>`
    );
  }
  parts.push(
    `<button type="button" class="menu-item danger" data-case-action="delete-case" data-case-id="${item.id}">Delete Case</button>`
  );
  return `
    <div class="case-actions" data-case-id="${item.id}">
      <button class="menu-trigger" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${menuId}" data-case-menu-trigger>⋯</button>
      <div class="case-menu" id="${menuId}" role="menu" style="width: 180px; min-width: 180px;">
        ${parts.join("")}
      </div>
    </div>
  `;
}

function pruneArchivedSelection() {
  if (!state.archivedSelection) state.archivedSelection = new Set();
  if (!state.archivedSelection.size) return;
  const valid = new Set((state.casesArchived || []).map((c) => String(c.id)));
  state.archivedSelection.forEach((id) => {
    if (!valid.has(id)) state.archivedSelection.delete(id);
  });
}

function readLocalDrafts() {
  try {
    const raw = localStorage.getItem(LOCAL_DRAFTS_KEY);
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && item.id)
      .map((item) => ({
        ...item,
        localDraft: true,
        createdAt: item.createdAt || item.updatedAt || new Date().toISOString(),
        updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

function removeLocalDraft(draftId) {
  if (!draftId) return;
  try {
    const raw = localStorage.getItem(LOCAL_DRAFTS_KEY);
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return;
    const next = parsed.filter((item) => item && item.id !== draftId);
    localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(next));
    const currentId = localStorage.getItem("currentDraftId");
    if (currentId && currentId === draftId) {
      localStorage.removeItem("currentDraftId");
    }
  } catch {
    /* ignore */
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
  const restoreBtn = bar.querySelector('[data-archived-bulk="restore"]');
  if (restoreBtn && selectedCount > 0) {
    const selectedFinal = Array.from(state.archivedSelection).some((id) => {
      const entry = state.caseLookup.get(String(id));
      return isFinalCase(entry);
    });
    if (selectedFinal) restoreBtn.disabled = true;
  }

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
  };
  casePreviewModalRef.querySelectorAll("[data-case-preview-close]").forEach((btn) => {
    btn.addEventListener("click", closeCasePreviewModal);
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
  casePreviewTargetId = null;
}

function getCasePreviewQueryId() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    return params.get("previewCaseId");
  } catch {
    return null;
  }
}

function clearCasePreviewQuery() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("previewCaseId")) return;
    url.searchParams.delete("previewCaseId");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {}
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
let caseApplicationsModalRef = null;
let caseApplicationsListRef = null;
let caseApplicationsSetup = false;

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

function setupCaseApplicationsModal() {
  if (caseApplicationsSetup) return;
  caseApplicationsSetup = true;
  caseApplicationsModalRef = document.getElementById("caseApplicationsModal");
  if (!caseApplicationsModalRef) return;
  if (caseApplicationsModalRef.parentElement !== document.body) {
    document.body.appendChild(caseApplicationsModalRef);
  }
  caseApplicationsListRef = caseApplicationsModalRef.querySelector("[data-case-applications-list]");
  caseApplicationsModalRef.querySelectorAll("[data-case-applications-close]").forEach((btn) => {
    btn.addEventListener("click", closeCaseApplicationsModal);
  });
  caseApplicationsModalRef.addEventListener("click", (event) => {
    if (event.target === caseApplicationsModalRef) {
      closeCaseApplicationsModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && caseApplicationsModalRef && !caseApplicationsModalRef.classList.contains("hidden")) {
      closeCaseApplicationsModal();
    }
  });
}

function closeCaseApplicationsModal() {
  if (caseApplicationsModalRef) {
    caseApplicationsModalRef.classList.add("hidden");
    caseApplicationsModalRef.removeAttribute("aria-busy");
  }
}

function buildParalegalProfileUrl(paralegalId) {
  const safeId = String(paralegalId || "").trim();
  if (!safeId) return "";
  return `profile-paralegal.html?paralegalId=${encodeURIComponent(safeId)}`;
}

function formatInvitedDate(value) {
  const formatted = formatCaseDate(value);
  return formatted && formatted !== "—" ? `Invited ${formatted}` : "Invitation date unavailable";
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
    }));
  } catch {
    return null;
  }
}

function hydrateInviteEntry(entry, invite) {
  if (!entry || !invite) return;
  if (invite.profile && typeof invite.profile === "object") {
    entry.pendingParalegal = invite.profile;
    entry.pendingParalegalId = invite.profile.id || invite.profile._id || entry.pendingParalegalId;
  }
  if (invite.invitedAt) {
    entry.pendingParalegalInvitedAt = invite.invitedAt;
  }
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

  let invitees = [];
  if (entry?.pendingParalegal || entry?.pendingParalegalId) {
    const pendingProfile =
      entry.pendingParalegal && typeof entry.pendingParalegal === "object" ? entry.pendingParalegal : null;
    const pendingId =
      entry.pendingParalegalId ||
      pendingProfile?.id ||
      pendingProfile?._id ||
      (typeof entry.pendingParalegal === "string" ? entry.pendingParalegal : "");
    invitees.push({
      profile: pendingProfile,
      id: pendingId,
      invitedAt: entry.pendingParalegalInvitedAt,
    });
  }

  if (invitees.length && invitees.some(shouldFetchInviteDetails)) {
    const fresh = await fetchInviteDetails(caseId);
    if (Array.isArray(fresh) && fresh.length) {
      invitees = fresh;
      hydrateInviteEntry(entry, fresh[0]);
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
    itemsHtml.push(`
      <div class="case-invite-item">
        <img src="${sanitize(avatar)}" alt="${sanitize(name)} profile photo" />
        <div class="case-invite-meta">
          ${link ? `<a href="${sanitize(link)}">${sanitize(name)}</a>` : `<span>${sanitize(name)}</span>`}
          <span class="case-invite-date">${sanitize(formatInvitedDate(invite.invitedAt))}</span>
        </div>
      </div>
    `);
  }

  caseInvitesListRef.innerHTML = itemsHtml.join("");
  caseInvitesModalRef.removeAttribute("aria-busy");
}

async function openCaseApplications(caseId) {
  if (!caseId) return;
  setupCaseApplicationsModal();
  if (!caseApplicationsModalRef || !caseApplicationsListRef) return;
  caseApplicationsModalRef.classList.remove("hidden");
  caseApplicationsModalRef.setAttribute("aria-busy", "true");
  caseApplicationsListRef.innerHTML = `<p class="muted">Loading applications…</p>`;

  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload?.error || "Unable to load applications.");
    }
    const applicants = Array.isArray(payload?.applicants) ? payload.applicants : [];
    if (!applicants.length) {
      caseApplicationsListRef.innerHTML = `<p class="muted">No applications yet.</p>`;
      caseApplicationsModalRef.removeAttribute("aria-busy");
      return;
    }
    const items = applicants.map((applicant) => {
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
      const paralegalId =
        profile?.id || profile?._id || applicant?.paralegalId || "";
      const name = getApplicantDisplayName(profile, snapshot);
      const avatar =
        snapshot.profileImage || profile.profileImage || profile.avatarURL || INVITE_AVATAR_FALLBACK;
      const link = buildParalegalProfileUrl(paralegalId);
      const appliedAt = applicant?.appliedAt || applicant?.createdAt || "";
      return `
        <div class="case-invite-item">
          <img src="${sanitize(avatar)}" alt="${sanitize(name)} profile photo" />
          <div class="case-invite-meta">
            ${link ? `<a href="${sanitize(link)}">${sanitize(name)}</a>` : `<span>${sanitize(name)}</span>`}
            <span class="case-invite-date">${sanitize(formatAppliedDate(appliedAt))}</span>
          </div>
        </div>
      `;
    });
    caseApplicationsListRef.innerHTML = items.join("");
    caseApplicationsModalRef.removeAttribute("aria-busy");
  } catch (err) {
    console.warn("Case applications load failed", err);
    caseApplicationsListRef.innerHTML = `<p class="muted">Unable to load applications.</p>`;
    caseApplicationsModalRef.removeAttribute("aria-busy");
  }
}

async function openCasePreview(caseId) {
  if (!caseId) return;
  if (dashboardViewState.currentView !== "cases") {
    try {
      window.location.hash = "cases";
    } catch {}
    showDashboardView("cases", { skipHash: true });
  }
  setupCasePreviewModal();
  if (!casePreviewModalRef || !casePreviewFields) return;
  casePreviewTargetId = String(caseId);
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
    closeCasePreviewModal();
    notifyCases("Unable to load case details.", "error");
    return;
  }

  const summary = String(entry.briefSummary || "");
  const experience = extractSummaryValue(summary, "Experience") || "Not specified";
  const location =
    entry.locationState || entry.state || extractSummaryValue(summary, "State") || "—";
  const compensation = formatCaseAmount(entry);
  const description = String(entry.details || "").trim() || "No description provided.";
  const practiceArea = titleCaseWords(entry.practiceArea || "");

  if (casePreviewFields.title) casePreviewFields.title.textContent = entry.title || "Case Preview";
  if (casePreviewFields.field) casePreviewFields.field.textContent = practiceArea || "—";
  if (casePreviewFields.location) casePreviewFields.location.textContent = location || "—";
  if (casePreviewFields.comp) casePreviewFields.comp.textContent = compensation || "—";
  if (casePreviewFields.experience) casePreviewFields.experience.textContent = experience || "—";
  if (casePreviewFields.description) casePreviewFields.description.textContent = description;

  casePreviewModalRef.removeAttribute("aria-busy");
}

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
    if (action === "restore") {
      for (const id of ids) {
        await toggleCaseArchive(id, false);
      }
      notifyCases("Cases restored.", "success");
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
      window.location.href = "create-case.html#description";
      return;
    } else if (action === "discard-draft") {
      removeLocalDraft(caseId);
      state.localDrafts = readLocalDrafts();
      renderCasesView();
      return;
    } else if (action === "view") {
      const entry = state.caseLookup.get(String(caseId));
      if (!isWorkspaceEligibleCase(entry)) {
        notifyCases("Workspace unlocks after a paralegal is hired and escrow is funded.", "info");
        return;
      }
      window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
    } else if (action === "details") {
      await openCasePreview(caseId);
    } else if (action === "view-invited") {
      await openCaseInvites(caseId);
    } else if (action === "messages") {
      const entry = state.caseLookup.get(String(caseId));
      if (!isWorkspaceEligibleCase(entry)) {
        notifyCases("Messaging unlocks after a paralegal is hired and escrow is funded.", "info");
        return;
      }
      goToMessages(caseId);
    } else if (action === "edit-note") {
      openCaseNoteModal(caseId);
      return;
    } else if (action === "download") {
      await downloadCaseDeliverables(caseId);
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

  // Ensure a valid status before unarchiving to avoid enum errors.
  if (!archived) {
    const entry = state.caseLookup.get(String(caseId));
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

async function ensureCaseOpenForDelete(caseId, suppressErrors = false) {
  const entry = state.caseLookup.get(String(caseId));
  try {
    if (entry?.archived) {
      await toggleCaseArchive(caseId, false);
    }
    const statusKey = String(entry?.status || "").toLowerCase();
    if (statusKey && statusKey !== "open") {
      const res = await secureFetch(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: "PATCH",
        headers: { Accept: "application/json" },
        body: { status: "open" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to prepare case for deletion.");
      }
      syncCaseCollections(data);
    }
  } catch (err) {
    if (!suppressErrors) throw err;
    console.warn("ensureCaseOpenForDelete failed", err);
  }
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
  if (!status) return "Open";
  const key = String(status).toLowerCase();
  return CASE_STATUS_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getStatusClass(status) {
  if (!status) return "public";
  const key = String(status).toLowerCase();
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
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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
      await openFile(doc.caseId, doc.file.key, "download", doc.file.filename || doc.file.original);
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
  return lower;
}

function isFinalCase(caseItem) {
  if (!caseItem) return false;
  if (caseItem.paymentReleased === true) return true;
  const status = normalizeCaseStatus(caseItem?.status);
  return status === "completed";
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
  if (!status || !FUNDED_WORKSPACE_STATUSES.has(status)) return false;
  const escrowFunded =
    !!caseItem?.escrowIntentId && String(caseItem?.escrowStatus || "").toLowerCase() === "funded";
  if (!escrowFunded) return false;
  const hasParalegal = caseItem?.paralegal || caseItem?.paralegalId;
  return !!hasParalegal;
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
    state.caseLookup.set(String(c.id), c);
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
  if (!url) throw new Error("Unable to sign file");
  if (mode === "download") {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "document";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } else if (mode === "print") {
    const win = window.open(url, "_blank");
    if (win) {
      win.addEventListener("load", () => win.print());
    }
  } else {
    window.open(url, "_blank");
  }
}

async function openReviewFile(caseId, fileKey, downloadUrl, mode, fileName) {
  if (fileKey) {
    await openFile(caseId, fileKey, mode, fileName);
    return;
  }
  if (downloadUrl && downloadUrl !== "#" && downloadUrl !== "undefined") {
    if (mode === "print") {
      const win = window.open(downloadUrl, "_blank");
      win?.addEventListener("load", () => win.print());
    } else {
      window.open(downloadUrl, "_blank");
    }
    return;
  }
  throw new Error("Download link unavailable for this file.");
}

async function getSignedUrl(caseId, key) {
  const res = await secureFetch(`/api/cases/${caseId}/files/signed-get?key=${encodeURIComponent(key)}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("signed url failed");
  const data = await res.json();
  return data.url;
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

function updateMetrics(metrics = {}, overdueCount = 0) {
  document.querySelectorAll("[data-metric]").forEach((el) => {
    const key = el.dataset.metric;
    let text = "--";
    if (key === "activeCases") {
      const value = Number(metrics.activeCases || 0);
      const suffix = value === 1 ? "" : "s";
      text = `${value} active case${suffix}`;
      const heading = document.getElementById("activeCasesHeading");
      if (heading) heading.textContent = value > 0 ? `You have ${value} active case${suffix}` : "";
    } else if (key === "overdueTasks") {
      text = `${overdueCount} overdue task${overdueCount === 1 ? "" : "s"}`;
    } else if (key === "escrowTotal") {
      text = `${formatCurrency(metrics.escrowTotal || 0)} held in escrow`;
    }
    el.textContent = text;
  });
}

function renderDeadlines(container, events = []) {
  if (!container) return;
  if (!events.length) {
    container.innerHTML = `<div class="info-line" style="color:var(--muted);">No upcoming deadlines.</div>`;
    return;
  }
  container.innerHTML = events
    .map((ev) => {
      const title = sanitize(ev.title || "Event");
      const when = ev.start ? new Date(ev.start).toLocaleDateString() : "TBD";
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
  const snippet = nextThread.lastMessageSnippet || "Open thread.";
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
      <a class="pill-btn primary" href="${billingHref}" data-view-target="billing">Open Billing &amp; Escrow</a>
      <a class="pill-btn" href="/api/payments/export/csv">Download Receipts (CSV)</a>
    </div>
  `;
}

function renderApplications(apps = [], hasPaymentMethod = true) {
  const container = document.getElementById("applicationsSection");
  if (!container) return;
  const filteredApps = apps.filter((app) => {
    if (!app?.caseId) return true;
    const caseEntry = state.caseLookup.get(String(app.caseId));
    if (!caseEntry) return false;
    const statusKey = normalizeCaseStatus(caseEntry?.status);
    if (statusKey === "completed") return false;
    if (caseEntry?.archived === true) return false;
    if (caseEntry?.paymentReleased === true) return false;
    return true;
  });
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
  container.innerHTML = filteredApps
    .map((app) => {
      const name = sanitize(
        `${app?.paralegal?.firstName || ""} ${app?.paralegal?.lastName || ""}`.trim() || "Paralegal"
      );
      const paralegalId =
        app?.paralegal?.id ||
        app?.paralegal?._id ||
        app?.paralegalId ||
        "";
      const jobTitle = sanitize(app.jobTitle || "Job");
      const practice = sanitize(app.practiceArea || "General practice");
      const when = app.createdAt
        ? new Date(app.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        : "Recently";
      const budget =
        typeof app.budget === "number"
          ? `$${app.budget.toLocaleString()}`
          : app.budget && Number.isFinite(+app.budget)
          ? `$${Number(app.budget).toLocaleString()}`
          : "";
      const hasCaseId = !!app.caseId;
      const statusKey = String(app.status || "").toLowerCase();
      const canHire = !!hasCaseId && !!paralegalId && !["accepted", "rejected"].includes(statusKey);
      const paymentBlocked = hasPaymentMethod === false;
      const showPaymentGate = paymentBlocked && canHire;
      const hireDisabledAttr = showPaymentGate
        ? ' disabled aria-disabled="true" title="Add a payment method to fund escrow."'
        : "";
      const disabledAttr = hasCaseId ? "" : ' disabled aria-disabled="true" title="Case unavailable."';
      const cover = app.coverLetter ? sanitize(app.coverLetter.slice(0, 200)) : "";
      const paymentHelper = showPaymentGate
        ? `<div class="case-subinfo">Payment method required to fund escrow.</div>`
        : "";
      const paymentCta = showPaymentGate
        ? `<a class="chip" href="dashboard-attorney.html#billing">Add payment method</a>`
        : "";
      return `
        <div class="case-card">
          <div class="case-header">
            <div>
              <h2>${jobTitle}</h2>
              <div class="case-subinfo">${practice}${budget ? ` • ${budget}` : ""}</div>
              <div class="case-subinfo">Applied on ${when} by ${name}</div>
            </div>
          <div class="case-actions">
            ${
              canHire
                ? `<button class="chip" type="button" data-hire-paralegal data-case-id="${sanitize(
                    app.caseId
                  )}" data-paralegal-id="${sanitize(paralegalId)}" data-paralegal-name="${name}"${hireDisabledAttr}>Hire</button>`
                : ""
            }
            ${paymentCta}
            <button class="chip" type="button" data-view-applicants data-case-id="${sanitize(
              app.caseId || ""
            )}"${disabledAttr}>View Applicants</button>
          </div>
        </div>
        ${cover ? `<p class="case-subinfo" style="margin:0.5rem 0 0;">${cover}</p>` : ""}
        ${paymentHelper}
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
      if (viewBtn.hasAttribute("disabled") || viewBtn.getAttribute("aria-disabled") === "true") {
        return;
      }
      event.preventDefault();
      const caseId = viewBtn.dataset.caseId || "";
      if (!caseId) return;
      void openCaseApplications(caseId);
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
  const paymentReady = await hasDefaultPaymentMethod();
  if (!paymentReady) {
    state.billing.hasPaymentMethod = false;
    notifyCases("Add a payment method to fund escrow before hiring.", "error");
    return;
  }
  const confirmed = window.confirm(`Hire '${paralegalName}' for this case?`);
  if (!confirmed) return;
  const originalText = button?.textContent || "Hire";
  if (button) {
    button.textContent = "Processing...";
    button.setAttribute("disabled", "disabled");
  }

  try {
    const res = await secureFetch(
      `/api/cases/${encodeURIComponent(caseId)}/hire/${encodeURIComponent(paralegalId)}`,
      { method: "POST", body: {} }
    );
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.error || "Unable to hire paralegal.");
    const escrowStatus = String(payload?.escrowStatus || "").toLowerCase();
    const funded = escrowStatus === "funded";
    const hasPaymentMethod = await hasDefaultPaymentMethod();
    if (!funded && !hasPaymentMethod) {
      const message = `Add a payment method to hire '${paralegalName}'`;
      storePendingHire({ caseId, paralegalName, message });
      notifyCases(`${paralegalName} has been hired. Redirecting to Billing...`, "success");
      setTimeout(() => {
        window.location.href = "dashboard-attorney.html#billing";
      }, 400);
      return;
    }
    notifyCases(
      funded
        ? `${paralegalName} has been hired. Escrow funded. Opening workspace...`
        : `${paralegalName} has been hired. Redirecting to fund escrow...`,
      "success"
    );
    const target = funded
      ? `case-detail.html?caseId=${encodeURIComponent(caseId)}`
      : `fund-escrow.html?caseId=${encodeURIComponent(caseId)}`;
    setTimeout(() => {
      window.location.href = target;
    }, 400);
  } catch (err) {
    notifyCases(err?.message || "Unable to hire paralegal.", "error");
  } finally {
    if (button) {
      button.removeAttribute("disabled");
      button.textContent = originalText;
    }
  }
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

function storePendingHire(payload) {
  if (!payload?.caseId) return;
  const data = {
    caseId: String(payload.caseId),
    paralegalName: payload.paralegalName || "",
    message: payload.message || "",
    fundUrl: `fund-escrow.html?caseId=${encodeURIComponent(payload.caseId)}`,
  };
  try {
    localStorage.setItem(PENDING_HIRE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

function renderCaseCards(container, cases = []) {
  if (!container) return;
  if (!cases.length) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = cases
    .map((c) => {
      const title = sanitize(c.jobTitle || "Untitled Matter");
      const paralegal = sanitize(c.paralegalName || "Unassigned");
      const status = sanitize((c.status || "").replace(/_/g, " "));
      const created = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "";
      const practice = sanitize(c.practiceArea || "General");
      return `
        <div class="case-card" data-case-id="${c.caseId}">
          <div class="case-header">
            <div>
              <h2>${title}</h2>
              <div class="case-subinfo">Paralegal: ${paralegal} · Status: ${status}${created ? ` · Created ${created}` : ""}</div>
            </div>
            <div class="case-toggle" role="button" aria-label="Toggle details">▾</div>
          </div>
          <div class="case-content">
            <p>Practice Area: ${practice}</p>
            <div class="case-actions">
              <button type="button" data-case-link="view" data-case-id="${c.caseId}">View Case</button>
              <button type="button" data-case-link="messages" data-case-id="${c.caseId}">Open Messages</button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".case-card").forEach((card) => {
    card.addEventListener("click", (evt) => {
      if (evt.target.closest(".case-actions")) return;
      card.classList.toggle("open");
    });
  });

  container.querySelectorAll("[data-case-link]").forEach((btn) => {
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const caseId = btn.getAttribute("data-case-id");
      const intent = btn.getAttribute("data-case-link");
      if (!caseId) return;
      if (intent === "view") {
        window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
      } else if (intent === "messages") {
        goToMessages(caseId);
      }
    });
  });
}
