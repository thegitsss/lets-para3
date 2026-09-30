import { getSupportMatterContext, clearSupportMatterContext } from "./support-workspace-context.mjs";
import "../productivity-command-registry.js";
import { getStoredSession, clearSession } from "../auth.js";
import { createSupportTransport } from "./support-transport.mjs";
import { createSupportMutationController } from "./support-mutation-controller.mjs";
import { buildSupportInlineSegments, isSafeSupportHref } from "./support-message-links.mjs";
import {
  getAssistantActionLimit,
  getAssistantSuggestionLimit,
  isSupportedEscalationMetadata,
} from "./support-response-ui.mjs";
import { startStripeOnboarding } from "./stripe-connect.js";
import { activateDialogFocus, deactivateDialogFocus } from "./dialog-focus.js";

const SUPPORT_STYLESHEET_ID = "lpc-support-drawer-styles";
const SUPPORT_STYLESHEET_HREF = "/assets/styles/support-drawer.css?v=20260831-side-drawer";
const SUPPORT_DRAWER_ID = "supportDrawer";
const SUPPORT_THREAD_ID = "supportThread";
const SUPPORT_CONTEXT_STORAGE_KEY = "lpc-support-context";
const SUPPORT_SESSION_USER_KEY = "lpc_support_session_user";
const SUPPORT_PIN_STORAGE_KEY = "lpc_support_drawer_pin";
const SUPPORT_CONTEXT_WINDOW_MS = 1000 * 60 * 60 * 4;
const COMPOSER_PROMPT_INTERVAL_MS = 3200;
const COMPOSER_PROMPT_TRANSITION_MS = 220;
const SUPPORT_NAVIGATION_DELAY_MS = 220;

function getRoleAwareComposerPrompts(role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "attorney") {
    return [
      "Ask about billing",
      "Ask about a Matter",
      "Ask about messages",
      "Ask about profile settings",
    ];
  }
  if (normalizedRole === "paralegal") {
    return [
      "Ask about a payout",
      "Ask about Stripe onboarding",
      "Ask about a Matter",
      "Ask about messages",
    ];
  }
  if (normalizedRole === "admin") {
    return [
      "Ask about the review queue",
      "Ask about approvals",
      "Ask about a support ticket",
      "Ask about an attorney record",
    ];
  }
  return [
    "Ask about billing",
    "Ask about a Matter",
    "Ask about messages",
    "Ask about account settings",
  ];
}

function getRoleAwareQuickPrompts(role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "attorney") {
    return [
      "Where are Payments?",
      "Where can I see my Matters?",
      "I can't send messages",
      "I need help with a Matter",
    ];
  }
  if (normalizedRole === "paralegal") {
    return [
      "Where is my payout?",
      "How do I finish setting up payouts?",
      "I can't send messages",
      "I need help with a Matter",
    ];
  }
  if (normalizedRole === "admin") {
    return [
      "Where is the review queue?",
      "How do I review support tickets?",
      "How do I update a ticket?",
      "I need help with the dashboard",
    ];
  }
  return [
    "Where is billing?",
    "Where can I see my Matters?",
    "I can't send messages",
    "I need help with a Matter",
  ];
}

function getDrawerSubtitle(role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "attorney") return "";
  if (normalizedRole === "paralegal") return "";
  if (normalizedRole === "admin") return "Operations, tickets, incidents, and admin tools.";
  return "Account and workflow help across LPC.";
}

function getDrawerTitle(role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "attorney") return "Attorney Assistant";
  if (normalizedRole === "paralegal") return "LPC Assistant";
  if (normalizedRole === "admin") return "Admin Assistant";
  return "LPC Assistant";
}

function isInitialAssistantGreeting(message = {}, index = 0) {
  if (index !== 0 || getMessageVariant(message) !== "assistant") return false;
  const text = String(message?.text || "").trim();
  return (
    /^Welcome back,\s+[^.]+\.?$/i.test(text) ||
    /^Hi\s+[^,]+,\s+how can I help you with Let's-ParaConnect\?\s+The more details you provide,\s+the better\.?$/i.test(text) ||
    /^Hi\s+[—-]\s+I can help with account questions,\s+payouts,\s+case activity,\s+and platform issues\.?$/i.test(text)
  );
}

const state = {
  open: false,
  pinned: false,
  restoringPinned: false,
  bootstrapped: false,
  stylesReady: false,
  loadingConversation: false,
  loadFailed: false,
  silentRefreshing: false,
  sending: false,
  restartingConversation: false,
  loadPromise: null,
  stylesheetPromise: null,
  conversation: null,
  messages: [],
  error: "",
  failedMessageText: "",
  restoredMutation: false,
  optimisticRequestId: "",
  optimisticMessageIds: new Set(),
  launchers: [],
  lastFocusedLauncher: null,
  drawer: null,
  backdrop: null,
  thread: null,
  prompts: null,
  status: null,
  form: null,
  textarea: null,
  submit: null,
  menuButton: null,
  menuPanel: null,
  restartButton: null,
  closeButton: null,
  sidebarCollapseTab: null,
  sidebarClassObserver: null,
  composerPrompt: null,
  composerPromptText: null,
  composerPromptIndex: 0,
  composerPromptTimer: null,
  composerPromptTransitionTimer: null,
  escalatingMessageId: "",
  invokingAction: "",
  feedbackSubmittingIds: new Set(),
  pollTimer: null,
  eventSource: null,
  eventSourceConversationId: "",
  streamFallbackConversationId: "",
  dismissedSuggestedReplyIds: new Set(),
  pageTracked: false,
  navigationAdapter: null,
};

let mutationSnapshot = { pending: null, phase: "idle", message: "", busy: false, canRetry: false };
let supportContentRevision = 0;

function supportInteractionPending() {
  return Boolean(mutationSnapshot.pending || state.loadingConversation || state.escalatingMessageId || state.invokingAction || state.feedbackSubmittingIds.size);
}
const supportMutations = createSupportMutationController({
  request: (url, options) => supportFetch(url, options),
  onChange: syncSupportMutation,
  onResult: applySupportMutationResult,
});

let scopedSupportUserId = "";
let scopedSupportRole = "";
let onSupportSessionLost = null;
let configuredSupportNavigationAdapter = null;
const supportTransport = createSupportTransport({
  onAuthenticationLost() {
    clearSupportIdentity();
    if (onSupportSessionLost) onSupportSessionLost();
    else { clearSession(); window.location.replace("/login.html"); }
  },
});

export function configureSupportSession({ onSessionLost, navigationAdapter } = {}) {
  onSupportSessionLost = typeof onSessionLost === "function" ? onSessionLost : null;
  configuredSupportNavigationAdapter = typeof navigationAdapter?.resolve === "function" && typeof navigationAdapter?.navigate === "function"
    ? navigationAdapter : null;
}
let supportIdentityRevision = 0;
let supportRequests = new AbortController();

export function clearSupportIdentity({ preserveMatterContext = false, preservePendingRequest = false } = {}) {
  supportIdentityRevision += 1;
  closeSupportDrawer({ restoreFocus: false });
  stopLiveUpdates();
  supportMutations.clear({ erase: !preservePendingRequest });
  supportTransport.clear();
  supportRequests.abort();
  supportRequests = new AbortController();
  scopedSupportUserId = "";
  scopedSupportRole = "";
  if (!preserveMatterContext) clearSupportMatterContext();
  closeSupportDrawer({ restoreFocus: false });
  stopLiveUpdates();
  Object.assign(state, {
    bootstrapped: false, loadingConversation: false, loadFailed: false, silentRefreshing: false, restoredMutation: false,
    sending: false, restartingConversation: false, loadPromise: null,
    conversation: null, messages: [], error: "", failedMessageText: "", escalatingMessageId: "", invokingAction: "", navigationAdapter: null,
  });
  state.feedbackSubmittingIds.clear();
  state.dismissedSuggestedReplyIds.clear();
  if (state.textarea) state.textarea.value = "";
  try {
    window.sessionStorage.removeItem(SUPPORT_CONTEXT_STORAGE_KEY);
    window.sessionStorage.removeItem(SUPPORT_PIN_STORAGE_KEY);
  } catch (_) { /* Storage may be unavailable. */ }
  render();
}

function scopeSupportIdentity() {
  const userId = getSupportSessionUserId();
  const role = getSupportRole();
  if (userId !== scopedSupportUserId || role !== scopedSupportRole) {
    const priorContext = getSupportMatterContext({ ownerId: userId, role });
    clearSupportIdentity({ preserveMatterContext: Boolean(priorContext), preservePendingRequest: !scopedSupportUserId });
    scopedSupportUserId = userId;
    scopedSupportRole = role;
  }
}

async function supportFetch(url, options = {}) {
  const revision = supportIdentityRevision;
  scopeSupportIdentity();
  if (revision !== supportIdentityRevision) throw new DOMException("Account changed", "AbortError");
  return supportTransport.request(url, {
    ...options,
    ownerId: scopedSupportUserId,
    role: scopedSupportRole,
    signal: options.signal ? AbortSignal.any([supportRequests.signal, options.signal]) : supportRequests.signal,
    isCurrent() {
      scopeSupportIdentity();
      return revision === supportIdentityRevision;
    },
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== "lpc_user") return;
    try {
      const snapshot = JSON.parse(event.newValue || "null");
      const user = snapshot?.user || snapshot;
      const nextUserId = String(user?._id || user?.id || "");
      if (nextUserId && nextUserId === scopedSupportUserId && user?.role === scopedSupportRole) return;
    } catch (_) { /* An invalid identity snapshot must fail closed. */ }
    clearSupportIdentity();
  });
}

function getSupportSession() {
  return getStoredSession();
}

function getSupportSessionUserId() {
  const session = getSupportSession();
  return String(session?.user?._id || session?.user?.id || "").trim();
}

function readPinnedSupportDrawer() {
  if (typeof window === "undefined") return false;
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(SUPPORT_PIN_STORAGE_KEY) || "null");
    return Boolean(saved?.pinned && saved?.userId && saved.userId === getSupportSessionUserId());
  } catch (_error) {
    return false;
  }
}

function persistPinnedSupportDrawer(pinned = false) {
  if (typeof window === "undefined") return;
  try {
    if (pinned && getSupportSessionUserId()) {
      window.sessionStorage.setItem(
        SUPPORT_PIN_STORAGE_KEY,
        JSON.stringify({ pinned: true, userId: getSupportSessionUserId() })
      );
    } else {
      window.sessionStorage.removeItem(SUPPORT_PIN_STORAGE_KEY);
    }
  } catch (_error) {
    // Ignore storage failures.
  }
}

function canPinSupportDrawer() {
  if (document.body?.classList.contains("av2")) return true;
  if (typeof window === "undefined" || !window.matchMedia) return true;
  const isV2Shell = document.body?.classList.contains("lpc-v2");
  return window.matchMedia(isV2Shell ? "(min-width: 1101px)" : "(min-width: 681px)").matches;
}

function canCollapseDashboardSidebar() {
  return typeof window === "undefined" || !window.matchMedia || window.matchMedia("(min-width: 1025px)").matches;
}

function isCompactSidebarLayout() {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(max-width: 1024px)").matches);
}

function syncSidebarCollapseTab() {
  const tab = state.sidebarCollapseTab;
  if (!tab) return;
  if (isCompactSidebarLayout()) {
    if (document.body.classList.contains("support-sidebar-collapsed")) {
      document.body.classList.remove("support-sidebar-collapsed");
    }
    const isOpen = document.body.classList.contains("nav-open");
    tab.setAttribute("aria-expanded", String(isOpen));
    tab.setAttribute("aria-label", isOpen ? "Hide navigation" : "Show navigation");
    tab.title = isOpen ? "Hide navigation" : "Show navigation";
    return;
  }
  if (!canCollapseDashboardSidebar()) {
    document.body.classList.remove("support-sidebar-collapsed");
    tab.setAttribute("aria-expanded", "true");
    tab.setAttribute("aria-label", "Hide navigation");
    tab.title = "Hide navigation";
    return;
  }
  const isCollapsed = document.body.classList.contains("support-sidebar-collapsed");
  tab.setAttribute("aria-expanded", String(!isCollapsed));
  tab.setAttribute("aria-label", isCollapsed ? "Show navigation" : "Hide navigation");
  tab.title = isCollapsed ? "Show navigation" : "Hide navigation";
}

function ensureSidebarCollapseTab() {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".support-sidebar-collapse-tab").forEach((tab) => tab.remove());
  document.body?.classList.remove("support-sidebar-collapsed");
  state.sidebarClassObserver?.disconnect?.();
  state.sidebarClassObserver = null;
  state.sidebarCollapseTab = null;
}

function writeSupportSessionMarker(userId = "") {
  if (typeof window === "undefined") return;
  try {
    if (userId) window.sessionStorage.setItem(SUPPORT_SESSION_USER_KEY, userId);
    else window.sessionStorage.removeItem(SUPPORT_SESSION_USER_KEY);
  } catch (_error) {
    // Ignore storage failures.
  }
}

function isSupportSessionAllowed() {
  // An existing member session must not turn the sign-in page into a workspace.
  if (/\/login(?:\.html)?\/?$/i.test(window.location.pathname)) return false;
  const session = getSupportSession();
  const role = String(session?.role || "").toLowerCase();
  const status = String(session?.status || "").toLowerCase();
  return status === "approved" && ["attorney", "paralegal", "admin"].includes(role);
}

function inferViewName(pathname = "", hash = "", caseId = "") {
  const path = String(pathname || "").toLowerCase();
  const currentHash = String(hash || "").toLowerCase();
  if (path.includes("attorney-v2")) {
    if (caseId) return "case-detail";
    const routeName = currentHash.match(/^#\/(home|matters|tasks|paralegals|payments|settings|help)(?:\/|\?|$)/)?.[1] || "home";
    return ({ settings: "profile-settings", payments: "billing", help: "help", paralegals: "browse-paralegals", matters: "dashboard-attorney", tasks: "dashboard-attorney" })[routeName] || "dashboard-attorney";
  }
  if (path.includes("paralegal-v2")) {
    const routeName = currentHash.match(/^#\/(home|browse|work|settings|help|profile|matter)(?:\/|\?|$)/)?.[1] || "home";
    if (routeName === "matter") return "case-detail";
    if (routeName === "settings") return "profile-settings";
    if (routeName === "work") return "dashboard-paralegal";
    if (routeName === "browse") return "browse-jobs";
    return `paralegal-${routeName}`;
  }
  if (path.includes("profile-settings")) return "profile-settings";
  if (path.includes("create-case")) return "create-case";
  if (path.includes("dashboard-attorney")) {
    if (currentHash.includes("billing")) return "billing";
    return "dashboard-attorney";
  }
  if (path.includes("dashboard-paralegal")) return "dashboard-paralegal";
  if (path.includes("message")) return "messages";
  if (path.includes("billing")) return "billing";
  if (caseId || path.includes("case")) return "case-detail";
  return path.split("/").pop()?.replace(/\.html$/i, "") || "";
}

function readSupportContextStore() {
  if (typeof window === "undefined") return { views: [], opens: [] };
  try {
    window.localStorage.removeItem(SUPPORT_CONTEXT_STORAGE_KEY);
    const raw = window.sessionStorage.getItem(SUPPORT_CONTEXT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      views: Array.isArray(parsed.views) ? parsed.views : [],
      opens: Array.isArray(parsed.opens) ? parsed.opens : [],
    };
  } catch (_error) {
    return { views: [], opens: [] };
  }
}

function writeSupportContextStore(nextStore = {}) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SUPPORT_CONTEXT_STORAGE_KEY, JSON.stringify(nextStore));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function pruneSupportEvents(events = [], now = Date.now()) {
  return events.filter((entry) => {
    const at = Number(entry?.at || 0);
    return at > 0 && now - at <= SUPPORT_CONTEXT_WINDOW_MS;
  });
}

function getSupportBehaviorSnapshot(currentViewName = "") {
  const now = Date.now();
  const store = readSupportContextStore();
  const views = pruneSupportEvents(store.views, now);
  const opens = pruneSupportEvents(store.opens, now);
  const recentView = [...views].reverse().find((entry) => entry?.viewName && entry.viewName !== currentViewName) || null;
  const repeatViewCount = views.filter((entry) => entry?.viewName === currentViewName).length;
  const supportOpenCount = opens.filter((entry) => entry?.viewName === currentViewName).length;
  writeSupportContextStore({ views, opens });
  return {
    repeatViewCount,
    supportOpenCount,
    recentViewName: recentView?.viewName || "",
  };
}

function recordCurrentView() {
  if (state.pageTracked || typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const currentViewName = inferViewName(window.location.pathname, window.location.hash, params.get("caseId") || "");
  if (!currentViewName) return;
  const now = Date.now();
  const store = readSupportContextStore();
  const views = pruneSupportEvents(store.views, now);
  const lastView = views[views.length - 1] || null;
  if (!lastView || lastView.viewName !== currentViewName || now - Number(lastView.at || 0) > 30000) {
    views.push({ viewName: currentViewName, at: now });
  }
  writeSupportContextStore({
    views,
    opens: pruneSupportEvents(store.opens, now),
  });
  state.pageTracked = true;
}

function recordSupportOpen(viewName = "") {
  if (typeof window === "undefined" || !viewName) return;
  const now = Date.now();
  const store = readSupportContextStore();
  const opens = pruneSupportEvents(store.opens, now);
  opens.push({ viewName, at: now });
  writeSupportContextStore({
    views: pruneSupportEvents(store.views, now),
    opens,
  });
}

function revealDrawerShell() {
  if (!state.drawer || !state.backdrop) return;
  state.drawer.hidden = false;
  state.backdrop.hidden = false;
}

function markStylesheetReady(link = null) {
  state.stylesReady = true;
  if (link?.dataset) {
    link.dataset.loaded = "true";
  }
  revealDrawerShell();
  return link;
}

function ensureStylesheet() {
  if (typeof document === "undefined") return Promise.resolve(null);
  const existing = document.getElementById(SUPPORT_STYLESHEET_ID)
    || Array.from(document.querySelectorAll('link[rel="stylesheet"][href]')).find((link) => {
      try {
        return new URL(link.href, document.baseURI).pathname === "/assets/styles/support-drawer.css";
      } catch (_) {
        return false;
      }
    });
  if (existing) {
    if (existing.dataset.loaded === "true" || existing.sheet) {
      return Promise.resolve(markStylesheetReady(existing));
    }
    if (state.stylesheetPromise) {
      return state.stylesheetPromise;
    }
    state.stylesheetPromise = new Promise((resolve) => {
      const finalize = () => resolve(markStylesheetReady(existing));
      existing.addEventListener("load", finalize, { once: true });
      existing.addEventListener("error", finalize, { once: true });
    }).finally(() => {
      state.stylesheetPromise = null;
    });
    return state.stylesheetPromise;
  }

  const link = document.createElement("link");
  link.id = SUPPORT_STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = SUPPORT_STYLESHEET_HREF;
  state.stylesheetPromise = new Promise((resolve) => {
    const finalize = () => resolve(markStylesheetReady(link));
    link.addEventListener("load", finalize, { once: true });
    link.addEventListener("error", finalize, { once: true });
  }).finally(() => {
    state.stylesheetPromise = null;
  });
  document.head.appendChild(link);
  return state.stylesheetPromise;
}

function buildLauncherIcon() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path>
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-2.9 2.7-2.9 4"></path>
      <path d="M12 17h.01"></path>
    </svg>
  `;
}

function buildSendIcon() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m21 3-8.5 18-2.2-6.3L3 12.5 21 3Z"></path>
      <path d="M10.3 14.7 21 3"></path>
    </svg>
  `;
}

function buildCloseIcon() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 6 18 18"></path>
      <path d="M18 6 6 18"></path>
    </svg>
  `;
}

function buildMenuIcon() {
  return `
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="6.5" cy="12" r="1.35"></circle>
      <circle cx="12" cy="12" r="1.35"></circle>
      <circle cx="17.5" cy="12" r="1.35"></circle>
    </svg>
  `;
}

function buildAssistantMarkIcon() {
  return `
    <svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12.25 3.25c.48 5.4 3.1 8.02 8.5 8.5-5.4.48-8.02 3.1-8.5 8.5-.48-5.4-3.1-8.02-8.5-8.5 5.4-.48 8.02-3.1 8.5-8.5Z"></path>
      <path d="M21.75 17.25c.2 2.2 1.3 3.3 3.5 3.5-2.2.2-3.3 1.3-3.5 3.5-.2-2.2-1.3-3.3-3.5-3.5 2.2-.2 3.3-1.3 3.5-3.5Z"></path>
    </svg>
  `;
}

function buildShieldCheckIcon() {
  return `
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10 2.3 16 4.8v4.4c0 3.8-2.4 6.8-6 8.5-3.6-1.7-6-4.7-6-8.5V4.8L10 2.3Z"></path>
      <path d="m7.2 9.9 1.8 1.8 3.8-4"></path>
    </svg>
  `;
}

function buildUtilityIcon(type = "") {
  if (type === "copy") {
    return `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="2"></rect><path d="M13.5 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h1.5"></path></svg>`;
  }
  if (type === "helpful") {
    return `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 8.3 9.1 3a1.5 1.5 0 0 1 2.8.9v3h3.2a2 2 0 0 1 1.9 2.6l-1.5 5A2.2 2.2 0 0 1 13.4 16H6.2"></path><path d="M3 8.3h3.2V16H3z"></path></svg>`;
  }
  return `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6.2 11.7 2.9 5.3a1.5 1.5 0 0 0 2.8-.9v-3h3.2A2 2 0 0 0 17 10.5l-1.5-5A2.2 2.2 0 0 0 13.4 4H6.2"></path><path d="M3 4h3.2v7.7H3z"></path></svg>`;
}

function createDrawerMarkup() {
  const backdrop = document.createElement("div");
  backdrop.className = "support-drawer-backdrop";
  backdrop.setAttribute("data-support-backdrop", "true");
  backdrop.hidden = !state.stylesReady;

  const existingHost = document.querySelector("[data-support-v2-host]");
  const drawer = existingHost || document.createElement("aside");
  drawer.className = "support-drawer";
  drawer.id = SUPPORT_DRAWER_ID;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-hidden", "true");
  drawer.setAttribute("inert", "");
  drawer.setAttribute("aria-labelledby", "supportDrawerTitle");
  drawer.hidden = !state.stylesReady;
  drawer.innerHTML = `
    <header class="support-drawer-header">
      <div class="support-drawer-heading">
        <div class="support-drawer-title-row">
          <span class="support-drawer-mark">${buildAssistantMarkIcon()}</span>
          <div class="support-drawer-title-copy">
            <div class="support-drawer-title-line">
              <h2 class="support-drawer-title" id="supportDrawerTitle" data-support-title>LPC Assistant</h2>
            </div>
            <p class="support-drawer-subtitle" data-support-subtitle></p>
          </div>
        </div>
      </div>
      <div class="support-drawer-actions">
        <div class="support-drawer-menu" data-support-menu>
          <button
            class="support-drawer-menu-trigger"
            type="button"
            data-support-menu-trigger
            data-public-action="icon"
            aria-label="Open assistant options"
            aria-expanded="false"
            aria-haspopup="menu"
          >
            ${buildMenuIcon()}
          </button>
          <div class="support-drawer-menu-panel" data-support-menu-panel role="menu" hidden>
            <button class="support-drawer-menu-item" type="button" data-support-restart data-public-action="text" role="menuitem">
              Start new conversation
            </button>
          </div>
        </div>
        <button class="support-drawer-close" type="button" data-support-close data-public-action="icon" aria-label="Close assistant">
          ${buildCloseIcon()}
        </button>
      </div>
    </header>
    <div class="support-drawer-status" data-support-status role="status" aria-live="polite"></div>
    <div class="support-thread" id="${SUPPORT_THREAD_ID}" data-support-thread></div>
    <div class="support-quick-prompts" data-support-prompts></div>
    <form class="support-composer" data-support-form>
      <div class="support-composer-shell">
        <div class="support-composer-prompt is-hidden" data-support-composer-prompt aria-hidden="true">
          <span class="support-composer-prompt-text" data-support-composer-prompt-text></span>
        </div>
        <textarea id="supportComposerInput" data-support-textarea rows="1" maxlength="4000" aria-label="Ask Assistant a question"></textarea>
        <button class="support-send" type="submit" data-support-submit data-public-action="icon" aria-label="Send message">
          ${buildSendIcon()}
        </button>
      </div>
      <p class="support-composer-hint"><span class="support-composer-hint-icon">${buildShieldCheckIcon()}</span><span>AI can make mistakes. Check important information. <a href="/privacy.html" target="_blank" rel="noopener">Privacy</a></span></p>
    </form>
  `;

  if (existingHost) {
    existingHost.insertAdjacentElement("beforebegin", backdrop);
  } else {
    document.body.append(backdrop, drawer);
  }
  state.backdrop = backdrop;
  state.drawer = drawer;
  state.thread = drawer.querySelector("[data-support-thread]");
  state.prompts = drawer.querySelector("[data-support-prompts]");
  state.status = drawer.querySelector("[data-support-status]");
  state.form = drawer.querySelector("[data-support-form]");
  state.textarea = drawer.querySelector("[data-support-textarea]");
  state.submit = drawer.querySelector("[data-support-submit]");
  state.menuButton = drawer.querySelector("[data-support-menu-trigger]");
  state.menuPanel = drawer.querySelector("[data-support-menu-panel]");
  state.restartButton = drawer.querySelector("[data-support-restart]");
  state.closeButton = drawer.querySelector("[data-support-close]");
  state.composerPrompt = drawer.querySelector("[data-support-composer-prompt]");
  state.composerPromptText = drawer.querySelector("[data-support-composer-prompt-text]");
  state.subtitle = drawer.querySelector("[data-support-subtitle]");

  state.backdrop.addEventListener("click", () => closeSupportDrawer());
  state.menuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSupportMenu();
  });
  state.restartButton?.addEventListener("click", async () => {
    closeSupportMenu();
    await restartSupportConversation();
  });
  state.closeButton?.addEventListener("click", () => closeSupportDrawer());
  state.form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendCurrentDraft();
  });
  state.textarea?.addEventListener("input", () => {
    if (state.textarea?.value.trim()) {
      const latestAssistant = getLatestAssistantMessage();
      if (
        latestAssistant?.id &&
        Array.isArray(latestAssistant.metadata?.suggestedReplies) &&
        latestAssistant.metadata.suggestedReplies.length
      ) {
        state.dismissedSuggestedReplyIds.add(latestAssistant.id);
      }
    }
    autoSizeTextarea();
    syncComposerState();
    syncComposerPrompt();
    renderThread();
  });
  state.textarea?.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await sendCurrentDraft();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.menuPanel && !state.menuPanel.hidden) {
      event.preventDefault();
      closeSupportMenu({ restoreFocus: true });
      return;
    }
    if (event.key === "Escape" && state.open && !event.defaultPrevented && (!document.body.classList.contains("av2") || state.drawer?.contains(event.target))) {
      event.preventDefault();
      closeSupportDrawer();
    }
  });
  document.addEventListener("click", (event) => {
    if (!state.drawer || !state.menuPanel || state.menuPanel.hidden) return;
    if (state.drawer.contains(event.target)) {
      const menuRoot = state.drawer.querySelector("[data-support-menu]");
      if (menuRoot?.contains(event.target)) return;
    }
    closeSupportMenu();
  });
}

function ensureDrawer() {
  if (!isSupportSessionAllowed()) return;
  if (typeof document === "undefined") return;
  ensureStylesheet();
  if (state.drawer && state.backdrop) {
    if (state.stylesReady) revealDrawerShell();
    return;
  }
  createDrawerMarkup();
  if (state.stylesReady) revealDrawerShell();
  render();
}

function autoSizeTextarea() {
  if (!state.textarea) return;
  state.textarea.style.height = "auto";
  state.textarea.style.height = `${Math.min(state.textarea.scrollHeight, 120)}px`;
}

function syncComposerState() {
  if (!state.submit || !state.textarea) return;
  const hasText = Boolean(state.textarea.value.trim());
  state.submit.disabled = supportInteractionPending() || !hasText;
  state.textarea.disabled = state.loadingConversation || state.restartingConversation;
  state.drawer?.setAttribute(
    "aria-busy",
    state.loadingConversation || state.sending || state.restartingConversation ? "true" : "false"
  );
  if (state.restartButton) {
    state.restartButton.disabled =
      supportInteractionPending();
    state.restartButton.textContent = state.restartingConversation ? "Starting..." : "Start new conversation";
  }
}

function closeSupportMenu({ restoreFocus = false } = {}) {
  if (!state.menuButton || !state.menuPanel) return;
  state.menuPanel.hidden = true;
  state.menuButton.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    state.menuButton.focus();
  }
}

function openSupportMenu() {
  if (!state.menuButton || !state.menuPanel) return;
  state.menuPanel.hidden = false;
  state.menuButton.setAttribute("aria-expanded", "true");
}

function toggleSupportMenu() {
  if (!state.menuPanel || !state.menuButton) return;
  if (state.menuPanel.hidden) {
    openSupportMenu();
    return;
  }
  closeSupportMenu({ restoreFocus: true });
}

function getSupportRole() {
  const session = getSupportSession();
  return String(session?.role || session?.user?.role || "").trim().toLowerCase();
}

function stopComposerPromptRotation() {
  if (state.composerPromptTimer) {
    window.clearInterval(state.composerPromptTimer);
    state.composerPromptTimer = null;
  }
  if (state.composerPromptTransitionTimer) {
    window.clearTimeout(state.composerPromptTransitionTimer);
    state.composerPromptTransitionTimer = null;
  }
  state.composerPrompt?.classList.remove("is-leaving", "is-entering");
}

function shouldShowComposerPrompt() {
  if (!state.open || !state.textarea || !state.composerPrompt) return false;
  if (state.sending) return false;
  return !state.textarea.value.trim();
}

function setComposerPrompt(index) {
  const prompts = getRoleAwareComposerPrompts(getSupportRole());
  if (!state.composerPromptText || !prompts.length) return;
  const normalizedIndex = ((index % prompts.length) + prompts.length) % prompts.length;
  state.composerPromptIndex = normalizedIndex;
  state.composerPromptText.textContent = prompts[normalizedIndex];
}

function rotateComposerPrompt() {
  const prompts = getRoleAwareComposerPrompts(getSupportRole());
  if (!shouldShowComposerPrompt() || prompts.length < 2 || !state.composerPrompt) return;
  const nextIndex = (state.composerPromptIndex + 1) % prompts.length;
  state.composerPrompt.classList.remove("is-entering");
  state.composerPrompt.classList.add("is-leaving");
  if (state.composerPromptTransitionTimer) {
    window.clearTimeout(state.composerPromptTransitionTimer);
  }
  state.composerPromptTransitionTimer = window.setTimeout(() => {
    setComposerPrompt(nextIndex);
    state.composerPrompt.classList.remove("is-leaving");
    state.composerPrompt.classList.add("is-entering");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        state.composerPrompt?.classList.remove("is-entering");
      });
    });
    state.composerPromptTransitionTimer = null;
  }, COMPOSER_PROMPT_TRANSITION_MS);
}

function syncComposerPrompt() {
  if (!state.composerPrompt || !state.composerPromptText) return;
  if (!state.composerPromptText.textContent) {
    setComposerPrompt(state.composerPromptIndex);
  }
  const shouldShow = shouldShowComposerPrompt();
  state.composerPrompt.classList.toggle("is-hidden", !shouldShow);
  if (!shouldShow) {
    stopComposerPromptRotation();
    return;
  }
  const prompts = getRoleAwareComposerPrompts(getSupportRole());
  if (!state.composerPromptTimer && prompts.length > 1) {
    state.composerPromptTimer = window.setInterval(() => {
      if (!shouldShowComposerPrompt()) {
        syncComposerPrompt();
        return;
      }
      rotateComposerPrompt();
    }, COMPOSER_PROMPT_INTERVAL_MS);
  }
}

function getCurrentPageContext() {
  recordCurrentView();
  const heading = document.querySelector("main h1, .page-header h1, header h1");
  const params = new URLSearchParams(window.location.search);
  const session = getSupportSession();
  const pathname = window.location.pathname;
  const hash = window.location.hash;
  const isWorkspaceV2 = /^\/(attorney|paralegal)-v2\.html$/.test(pathname);
  const v2Route = isWorkspaceV2
    ? hash.match(/^#\/([^?]+)(?:\?(.*))?$/)
    : null;
  const v2Path = String(v2Route?.[1] || "");
  const v2Query = new URLSearchParams(v2Route?.[2] || "");
  const v2MatterId = v2Path.match(/^matter\/([^/]+)$/)?.[1] || "";
  const verifiedMatter = isWorkspaceV2 ? getSupportMatterContext({ ownerId: getSupportSessionUserId(), role: getSupportRole() }) : null;
  const caseId = isWorkspaceV2 ? verifiedMatter?.caseId || "" : v2MatterId || v2Query.get("matterId") || params.get("caseId") || params.get("highlightCase") || "";
  const productivity = isWorkspaceV2 ? verifiedMatter || {} : window.LPCProductivityContext && typeof window.LPCProductivityContext === "object"
    ? window.LPCProductivityContext
    : {};
  const panelContext = isWorkspaceV2 ? null : window.LPCContextPanel?.current?.() || null;
  const commandContext = {
    role: String(session?.role || ""),
    caseId: String(productivity.caseId || caseId || ""),
    availableMatterTabs: Array.isArray(productivity.availableMatterTabs) ? productivity.availableMatterTabs : [],
  };
  const permittedCommandCodes = window.LPCProductivityCommands?.listCommands
    ? window.LPCProductivityCommands.listCommands(commandContext).map((command) => command.code).slice(0, 20)
    : [];
  const viewName = inferViewName(pathname, hash, caseId);
  const behavior = getSupportBehaviorSnapshot(viewName);
  return {
    pathname,
    search: window.location.search,
    hash,
    href: window.location.href,
    title: document.title,
    label: heading?.textContent?.trim() || "",
    viewName,
    roleHint: String(session?.role || ""),
    caseId: commandContext.caseId,
    jobId: isWorkspaceV2 ? "" : v2Query.get("jobId") || params.get("jobId") || "",
    applicationId: isWorkspaceV2 ? "" : v2Query.get("applicationId") || params.get("applicationId") || "",
    repeatViewCount: behavior.repeatViewCount,
    supportOpenCount: behavior.supportOpenCount,
    recentViewName: behavior.recentViewName,
    currentTab: String(productivity.currentTab || ""),
    objectType: isWorkspaceV2 ? verifiedMatter ? "matter" : "" : String(panelContext?.kind || productivity.objectType || ""),
    objectId: isWorkspaceV2 ? verifiedMatter?.caseId || "" : String(panelContext?.id || productivity.objectId || ""),
    matterStatus: String(productivity.status || ""),
    matterRelationship: String(productivity.relationship || ""),
    matterAttention: String(productivity.attention || ""),
    matterNextAction: String(productivity.nextAction || ""),
    availableMatterTabs: commandContext.availableMatterTabs,
    permittedCommandCodes,
  };
}

function buildConversationQuery() {
  const pageContext = getCurrentPageContext();
  const query = new URLSearchParams();
  const sourcePage = `${pageContext.pathname || ""}${pageContext.search || ""}${pageContext.hash || ""}`;
  if (sourcePage) query.set("sourcePage", sourcePage);
  if (pageContext.pathname) query.set("pathname", pageContext.pathname);
  if (pageContext.search) query.set("search", pageContext.search);
  if (pageContext.hash) query.set("hash", pageContext.hash);
  if (pageContext.title) query.set("pageTitle", pageContext.title);
  if (pageContext.href) query.set("href", pageContext.href);
  if (pageContext.label) query.set("pageLabel", pageContext.label);
  if (pageContext.viewName) query.set("viewName", pageContext.viewName);
  if (pageContext.roleHint) query.set("roleHint", pageContext.roleHint);
  if (pageContext.caseId) query.set("caseId", pageContext.caseId);
  if (pageContext.jobId) query.set("jobId", pageContext.jobId);
  if (pageContext.applicationId) query.set("applicationId", pageContext.applicationId);
  if (pageContext.repeatViewCount) query.set("repeatViewCount", String(pageContext.repeatViewCount));
  if (pageContext.supportOpenCount) query.set("supportOpenCount", String(pageContext.supportOpenCount));
  if (pageContext.recentViewName) query.set("recentViewName", pageContext.recentViewName);
  return query.toString();
}

function formatTicketStatusLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "waiting_on_info") return "Waiting for your reply";
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getLatestAssistantMessage() {
  return [...state.messages].reverse().find((message) => getMessageVariant(message) === "assistant") || null;
}

function getLatestSubstantiveAssistantMessage() {
  return [...state.messages].reverse().find(message => {
    if (message.loading || !message.id || !String(message.text || "").trim() || getMessageVariant(message) !== "assistant") return false;
    if (isInitialAssistantGreeting(message, state.messages.indexOf(message))) return false;
    const metadata = message.metadata || {};
    return !["welcome", "ticket_status_notice", "support_escalation"].includes(metadata.kind)
      && !["issue_resolved", "generic_intake"].includes(metadata.primaryAsk)
      && !["CLARIFY_ONCE", "ESCALATE"].includes(metadata.responseMode)
      && !metadata.awaitingField && metadata.escalation?.requested !== true;
  }) || null;
}


function buildSuggestedReplyMessage(option = "") {
  const normalized = String(option || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "this case") return "This is happening in this Matter.";
  if (normalized === "across all messages") return "This is happening across all messages.";
  if (normalized === "billing method") return "This is about my billing method.";
  if (normalized === "case payment") return "This is about a specific Matter payment.";
  if (normalized === "billing") return "I need help with billing.";
  if (normalized === "my applications") return "Where do I see my applications?";
  if (normalized === "a case") return "I need help with a Matter.";
  if (normalized === "browse cases") return "Where can I browse open Matters?";
  if (normalized === "messages") return "I need help with messages.";
  if (normalized === "payouts") return "I need help with payouts.";
  if (normalized === "resume application") return "How do I resume my application?";
  if (normalized === "case payment") return "This is about a specific Matter payment.";
  if (normalized === "billing method") return "This is about my billing method.";
  if (normalized === "profile settings") return "I need help with profile settings.";
  return String(option || "").trim();
}

function appendLocalNotice(text = "") {
  const normalized = String(text || "").trim();
  if (!normalized) return;
  appendMessageIfMissing({
    id: `local-system-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sender: "system",
    text: normalized,
    metadata: { kind: "local_notice" },
    createdAt: new Date().toISOString(),
  });
}


function delay(ms = 0) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

async function navigateFromSupport(href = "") {
  const targetHref = String(href || "").trim();
  if (!targetHref) return;
  if (state.navigationAdapter) {
    const destination = state.navigationAdapter.resolve(targetHref);
    if (!destination) return;
    if (destination.internal) {
      state.navigationAdapter.navigate(destination);
      return;
    }
    closeSupportDrawer({ restoreFocus: false });
    await delay(SUPPORT_NAVIGATION_DELAY_MS);
    window.location.assign(destination.href);
    return;
  }
  const v2Adapter = window.__LPC_PARALEGAL_V2__?.adaptLegacyDestination;
  const v2Navigator = window.__LPC_PARALEGAL_V2__?.navigateToDestination;
  if (typeof v2Adapter === "function" && typeof v2Navigator === "function") {
    const destination = v2Adapter(targetHref, { caseId: getCurrentPageContext().caseId });
    if (destination?.internal) {
      v2Navigator(destination);
      return;
    }
  }
  closeSupportDrawer({ restoreFocus: false });
  await delay(SUPPORT_NAVIGATION_DELAY_MS);
  window.location.assign(targetHref);
}

function getMessageVariant(message = {}) {
  if (message.sender === "user") return "user";
  if (message.metadata?.kind === "team_reply") return "team";
  if (message.metadata?.kind === "support_escalation") return "notice";
  if (message.sender === "system") return "notice";
  return "assistant";
}

function removeRedundantActionBubbleReference(text = "", navigation = null) {
  const messageText = String(text || "");
  const inlineLinkText = String(navigation?.inlineLinkText || "").trim();
  if (!messageText || inlineLinkText.toLowerCase() !== "here") return messageText;

  return messageText
    .replace(/\s+here(?=\s*[.,;:!?]|\s*$)/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function validateSupportCommandNavigation(navigation = null) {
  if (!navigation || typeof navigation !== "object") return null;
  const code = String(navigation.commandCode || "").trim();
  if (!code) return navigation;
  const isWorkspaceV2 = /^\/(attorney|paralegal)-v2\.html$/.test(window.location.pathname);
  const productivity = isWorkspaceV2 ? getSupportMatterContext({ ownerId: getSupportSessionUserId(), role: getSupportRole() }) || {} : window.LPCProductivityContext && typeof window.LPCProductivityContext === "object"
    ? window.LPCProductivityContext
    : {};
  const command = window.LPCProductivityCommands?.resolveCommand?.(code, {
    role: getSupportRole(),
    caseId: String(productivity.caseId || ""),
    availableMatterTabs: Array.isArray(productivity.availableMatterTabs) ? productivity.availableMatterTabs : [],
  });
  if (!command || command.href !== String(navigation.ctaHref || "")) return null;
  return { ...navigation, ctaLabel: command.label, ctaHref: command.href };
}

function appendMessageBubbleContent(bubble, message = {}) {
  const actionHrefs = new Set(
    (Array.isArray(message.metadata?.actions) ? message.metadata.actions : [])
      .map((action) => String(action?.href || "").trim())
      .filter((href) => isSafeSupportHref(href))
  );
  const navigation = validateSupportCommandNavigation(message.metadata?.navigation || null);
  const navigationHref = String(navigation?.ctaHref || "").trim();
  const actionDuplicatesNavigation = Boolean(navigationHref && actionHrefs.has(navigationHref));
  const segments = buildSupportInlineSegments(
    actionDuplicatesNavigation ? removeRedundantActionBubbleReference(message.text || "", navigation) : message.text || "",
    actionDuplicatesNavigation ? null : navigation
  );
  if (!segments.length) {
    bubble.textContent = "";
    return;
  }
  const fragment = document.createDocumentFragment();
  segments.forEach((segment) => {
    if (!segment?.text) return;
    const destination = state.navigationAdapter?.resolve(segment.href);
    if (segment.type === "link" && (!state.navigationAdapter || destination) && !actionHrefs.has(String(segment.href || "").trim())) {
      const anchor = document.createElement("a");
      anchor.className = "support-inline-link";
      anchor.href = destination?.href || segment.href;
      anchor.textContent = segment.text;
      anchor.setAttribute("data-support-inline-link", "true");
      if (destination?.internal || window.__LPC_PARALEGAL_V2__?.adaptLegacyDestination?.(segment.href)?.internal) {
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          void navigateFromSupport(segment.href);
        });
      }
      fragment.appendChild(anchor);
      return;
    }
    fragment.appendChild(document.createTextNode(segment.text));
  });
  bubble.replaceChildren(fragment);
}

function retainInteractionFocus(launcher, target) {
  const revision = supportIdentityRevision;
  let moved = !launcher || document.activeElement !== launcher;
  const onFocus = event => {
    if (event.target !== launcher && event.target !== document.body && event.target !== document.documentElement) moved = true;
  };
  document.addEventListener("focusin", onFocus);
  return () => {
    document.removeEventListener("focusin", onFocus);
    if (!moved && state.open && revision === supportIdentityRevision && document.activeElement === document.body) target()?.focus({ preventScroll: true });
  };
}

function createMessageElement(message = {}) {
  const item = document.createElement("article");
  const variant = getMessageVariant(message);
  item.dataset.supportMessageId = String(message.id || "");
  item.className = `support-message support-message--${variant}${message.loading ? " support-message--loading" : ""}${
    message.metadata?.kind === "ticket_status_notice" ? " support-message--status-notice" : ""
  }`;

  if (!message.loading && variant === "team") {
    const identity = document.createElement("div");
    identity.className = "support-message-identity";
    const label = document.createElement("span");
    label.className = "support-message-identity-label";
    label.textContent = message.metadata?.teamLabel || "LPC Team";
    identity.append(label);
    item.appendChild(identity);
  }

  const bubble = document.createElement("div");
  bubble.className = "support-message-bubble";

  if (message.loading) {
    const dots = document.createElement("span");
    dots.className = "support-loading-dots";
    dots.setAttribute("aria-label", "Assistant is responding");
    dots.innerHTML = "<span></span><span></span><span></span>";
    bubble.append(dots);
  } else {
    appendMessageBubbleContent(bubble, message);
  }

  item.append(bubble);

  if (!message.loading && message.createdAt) {
    const timestamp = new Date(message.createdAt);
    if (!Number.isNaN(timestamp.getTime())) {
      const meta = document.createElement("time");
      meta.className = "support-message-meta";
      meta.dateTime = timestamp.toISOString();
      meta.textContent = timestamp.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      item.appendChild(meta);
    }
  }

  const actionBar = createMessageActions(message);
  if (actionBar) {
    item.appendChild(actionBar);
  }

  const suggestedReplies = createSuggestedReplies(message);
  if (suggestedReplies) {
    item.appendChild(suggestedReplies);
  }

  const escalationCard = createEscalationCard(message);
  if (escalationCard) {
    item.appendChild(escalationCard);
  }
  return item;
}

async function runSupportAction(action = {}) {
  if (supportInteractionPending()) return;
  const revision = supportIdentityRevision;
  const actionType = String(action?.type || "").trim().toLowerCase();
  const invokeAction = String(action?.action || "").trim().toLowerCase();
  const commandCode = String(action?.commandCode || "").trim();
  if (commandCode) {
    const command = validateSupportCommandNavigation({ commandCode, ctaHref: String(action?.href || "") });
    if (!command) return;
    await navigateFromSupport(command.ctaHref);
    return;
  }
  if (actionType === "invoke" && invokeAction === "start_stripe_onboarding") {
    const restoreFocus = retainInteractionFocus(document.activeElement, () => state.thread?.querySelector('[data-support-invoke="start_stripe_onboarding"]'));
    state.invokingAction = invokeAction;
    render();
    try {
      await startStripeOnboarding({
        request: (url, options) => supportFetch(url, { ...options, timeoutMs: 30000 }),
        isCurrent: () => revision === supportIdentityRevision,
      });
    } catch (error) {
      if (revision !== supportIdentityRevision) return;
      state.error = error?.message || "Unable to start Stripe onboarding.";
      render();
    } finally {
      if (revision === supportIdentityRevision) { state.invokingAction = ""; render(); restoreFocus(); }
    }
    return;
  }
  if (actionType === "invoke" && invokeAction === "request_password_reset") {
    const restoreFocus = retainInteractionFocus(document.activeElement, () => state.thread?.querySelector('[data-support-invoke="request_password_reset"]'));
    state.invokingAction = invokeAction;
    render();
    try {
      const accountResponse = await supportFetch("/api/users/me", { method: "GET", headers: { Accept: "application/json" } });
      if (!accountResponse.ok) throw new Error("Unable to load your account email. Please try again.");
      const account = await accountResponse.json();
      const email = String(account?.email || account?.user?.email || "").trim();
      if (!email) {
        throw new Error("We couldn't find an email address for this account.");
      }
      const response = await supportFetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { Accept: "application/json" },
        body: { email },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error || "Couldn't send a reset link right now.");
      }
      if (revision !== supportIdentityRevision) return;
      appendLocalNotice("Reset requested. Check your email for a link.");
      state.error = "";
      render();
    } catch (error) {
      if (revision !== supportIdentityRevision) return;
      state.error = error?.message || "Couldn't send a reset link right now.";
      render();
    } finally {
      if (revision === supportIdentityRevision) { state.invokingAction = ""; render(); restoreFocus(); }
    }
    return;
  }
  const href = String(action?.href || "").trim();
  if (!isSafeSupportHref(href)) return;
  await navigateFromSupport(href);
}

async function copySupportMessage(message = {}) {
  const text = String(message?.text || "").trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    appendLocalNotice("Assistant response copied.");
  } catch (_error) {
    state.error = "Couldn't copy that response. Please select the text and copy it manually.";
  }
  render();
}

async function submitMessageFeedback(message = {}, rating = "", launcher = document.activeElement) {
  const revision = supportIdentityRevision;
  if (!state.conversation?.id || !message?.id || supportInteractionPending()) return;
  const restoreFocus = retainInteractionFocus(launcher, () => state.thread?.querySelector(`[data-support-message-id="${CSS.escape(String(message.id))}"] [data-support-feedback="${rating}"]`));
  state.feedbackSubmittingIds.add(message.id);
  state.error = "";
  render();
  try {
    const response = await supportFetch(
      `/api/support/conversation/${encodeURIComponent(state.conversation.id)}/messages/${encodeURIComponent(
        message.id
      )}/feedback`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
        body: { rating },
      }
    );
    if (!response.ok) throw new Error("Couldn't save that feedback.");
    const payload = await response.json();
    replaceMessageInState(payload.message);
  } catch (error) {
    if (revision !== supportIdentityRevision) return;
    state.error = error?.message || "Couldn't save that feedback.";
  } finally {
    if (revision !== supportIdentityRevision) { restoreFocus(); return; }
    state.feedbackSubmittingIds.delete(message.id);
    render();
    restoreFocus();
  }
}

function createMessageActions(message = {}) {
  if (message.loading || getMessageVariant(message) !== "assistant") return null;
  const actions = Array.isArray(message.metadata?.actions) ? message.metadata.actions.filter(Boolean) : [];

  const bar = document.createElement("div");
  bar.className = "support-message-actions";
  actions.slice(0, getAssistantActionLimit(message.metadata)).forEach((action) => {
    const isInvoke = String(action?.type || "").trim().toLowerCase() === "invoke";
    const invokeAction = String(action?.action || "").trim().toLowerCase();
    if (isInvoke && !(invokeAction === "request_password_reset" || invokeAction === "start_stripe_onboarding" && getSupportRole() === "paralegal")) return;
    if (action?.commandCode && !validateSupportCommandNavigation({
      commandCode: action.commandCode,
      ctaHref: String(action?.href || ""),
    })) return;
    if (!isInvoke && (!isSafeSupportHref(action?.href || "") || (state.navigationAdapter && !state.navigationAdapter.resolve(action?.href || "")))) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "support-message-action";
    button.dataset.publicAction = "secondary";
    button.dataset.actionShape = "control";
    button.textContent = String(action.label || "Open");
    if (isInvoke) button.dataset.supportInvoke = invokeAction;
    button.disabled = supportInteractionPending();
    button.addEventListener("click", () => {
      runSupportAction(action).catch((error) => {
        console.error("[support] assistant action rejected", error);
      });
    });
    bar.appendChild(button);
  });

  if (getLatestSubstantiveAssistantMessage()?.id !== message.id) return bar.childElementCount ? bar : null;

  const utilityBar = document.createElement("div");
  utilityBar.className = "support-message-utilities";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "support-message-utility";
  copyButton.dataset.publicAction = "icon";
  copyButton.setAttribute("aria-label", "Copy");
  copyButton.title = "Copy response";
  copyButton.innerHTML = buildUtilityIcon("copy");
  copyButton.addEventListener("click", () => copySupportMessage(message));
  utilityBar.appendChild(copyButton);

  [
    ["helpful", "Helpful"],
    ["unhelpful", "Not helpful"],
  ].forEach(([rating, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "support-message-utility";
    button.dataset.publicAction = "icon";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = buildUtilityIcon(rating);
    button.dataset.supportFeedback = rating;
    button.setAttribute("aria-pressed", message.metadata?.feedback?.rating === rating ? "true" : "false");
    button.disabled = supportInteractionPending();
    button.addEventListener("click", event => submitMessageFeedback(message, rating, event.currentTarget));
    utilityBar.appendChild(button);
  });
  bar.appendChild(utilityBar);
  return bar.childElementCount ? bar : null;
}

function createSuggestedReplies(message = {}) {
  if (message.loading || getMessageVariant(message) !== "assistant") return null;
  const latestAssistant = getLatestAssistantMessage();
  if (!latestAssistant?.id || latestAssistant.id !== message.id) return null;
  if (state.dismissedSuggestedReplyIds.has(message.id)) return null;
  if (state.sending || state.loadingConversation) return null;
  const replies = Array.isArray(message.metadata?.suggestedReplies)
    ? message.metadata.suggestedReplies
        .filter(Boolean)
        .slice(0, getAssistantSuggestionLimit(message.metadata))
    : [];
  if (!replies.length) return null;

  const bar = document.createElement("div");
  bar.className = "support-suggested-replies";
  replies.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "support-suggested-reply";
    button.dataset.publicAction = "secondary";
    button.dataset.actionShape = "pill";
    button.textContent = String(option);
    button.disabled = supportInteractionPending();
    button.addEventListener("click", async () => {
      await sendSupportMessage(buildSuggestedReplyMessage(option));
    });
    bar.appendChild(button);
  });
  return bar.childElementCount ? bar : null;
}

function createEscalationCard(message = {}) {
  const variant = getMessageVariant(message);
  const escalation = message.metadata?.escalation || null;
  const requested = escalation?.requested === true;
  const available = isSupportedEscalationMetadata(message.metadata);
  const alreadyAutoEscalating = /\bsending (this|that|the .*issue) to (the team|engineering) now\b/i.test(
    String(message.text || "")
  );
  if (variant !== "assistant" || message.loading) {
    return null;
  }

  const card = document.createElement("div");
  card.className = "support-escalation-card";

  const copy = document.createElement("div");
  copy.className = "support-escalation-copy";
  const title = document.createElement("p");
  title.className = "support-escalation-title";
  title.textContent = requested ? "Sent to the team for review." : "Need help from the LPC team?";
  copy.appendChild(title);

  const reason = document.createElement("p");
  reason.className = "support-escalation-text";
  if (requested) {
    const pieces = [];
    const reference = String(
      escalation?.ticketReference || message.metadata?.ticketReference || state.conversation?.escalation?.ticketReference || ""
    ).trim();
    const ticketStatus = formatTicketStatusLabel(
      escalation?.ticketStatus || message.metadata?.ticketStatus || state.conversation?.status || ""
    );
    if (reference) pieces.push(reference);
    if (ticketStatus && !["Open", "Escalated"].includes(ticketStatus)) pieces.push(ticketStatus);
    reason.textContent = pieces.join(" · ") || "You'll receive a response after team review.";
  } else {
    reason.textContent = "";
  }
  if (reason.textContent) copy.appendChild(reason);
  card.appendChild(copy);

  if (requested) {
    card.classList.add("is-sent");
    return card;
  }

  if (alreadyAutoEscalating) {
    return null;
  }

  if (!available) {
    return null;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "support-escalation-button";
  button.dataset.publicAction = "primary";
  button.dataset.actionShape = "control";
  button.textContent = state.escalatingMessageId === message.id ? "Sending…" : "Send to the team";
  button.disabled = supportInteractionPending();
  button.addEventListener("click", async () => {
    await sendEscalationRequest(message.id);
  });
  card.appendChild(button);

  return card;
}

function renderThread(viewport = captureThreadViewport()) {
  if (!state.thread) return;
  state.thread.innerHTML = "";

  if (state.loadingConversation && !state.messages.length) {
    return;
  }

  state.messages
    .filter((message, index) => {
      if (message?.metadata?.kind === "support_escalation") return false;
      return !isInitialAssistantGreeting(message, index);
    })
    .forEach((message) => {
    state.thread.appendChild(createMessageElement(message));
    });
  restoreThreadViewport(viewport);
}

function shouldShowQuickPrompts() {
  if (state.loadingConversation) return false;
  if (state.loadFailed || (state.error && !state.conversation)) return false;
  const userMessages = state.messages.filter((message) => message.sender === "user");
  return userMessages.length === 0;
}

function renderPrompts() {
  if (!state.prompts) return;
  state.prompts.innerHTML = "";
  const supportRole = getSupportRole();
  if (state.drawer) state.drawer.dataset.supportRole = supportRole;
  if (state.subtitle) {
    const subtitle = getDrawerSubtitle(supportRole);
    state.subtitle.textContent = subtitle;
    state.subtitle.hidden = !subtitle;
  }
  const title = state.drawer?.querySelector("[data-support-title]");
  if (title) title.textContent = getDrawerTitle(supportRole);
  if (!shouldShowQuickPrompts()) return;

  getRoleAwareQuickPrompts(supportRole).forEach((promptText) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "support-quick-prompt";
    button.dataset.publicAction = "secondary";
    button.dataset.actionShape = "pill";
    const label = document.createElement("span");
    label.textContent = promptText;
    button.append(label);
    button.disabled = supportInteractionPending();
    button.addEventListener("click", async () => {
      await sendSupportMessage(promptText);
    });
    state.prompts.appendChild(button);
  });
}

function renderStatus() {
  if (!state.status) return;
  const copy = state.error || mutationSnapshot.message;
  if (!copy) {
    state.status.classList.remove("is-visible", "is-info");
    state.status.textContent = "";
    return;
  }
  state.status.classList.add("is-visible");
  state.status.classList.toggle("is-info", !state.error && ["running", "checking", "pending"].includes(mutationSnapshot.phase));
  const label = document.createElement("span");
  label.textContent = copy;
  state.status.replaceChildren(label);
  function action(text, name, callback, disabled = false) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "support-status-retry";
    button.textContent = text; button.dataset.supportRequestAction = name; button.disabled = disabled;
    button.addEventListener("click", async () => {
      const restore = retainInteractionFocus(button, () => state.status?.querySelector(`[data-support-request-action="${name}"]`) || state.status?.querySelector("button") || state.textarea);
      try { await callback(); } catch (error) { state.error = error?.message || "The request could not be checked."; render(); } finally { restore(); }
    });
    state.status.appendChild(button);
  }
  if (mutationSnapshot.pending) {
    if (mutationSnapshot.busy) action("Stop waiting", "stop", () => supportMutations.stopWaiting());
    else if (mutationSnapshot.phase === "failed") action("Return to conversation", "return", async () => {
      if (supportMutations.dismissFailed()) { state.error = ""; await ensureConversationLoaded(true); }
    });
    else {
      action("Check result", "check", () => supportMutations.check());
      if (mutationSnapshot.canRetry) action("Retry request", "retry", () => supportMutations.retry());
    }
  } else if (state.loadFailed) {
    action("Try again", "history", () => ensureConversationLoaded(true), state.loadingConversation);
  }
}

function captureThreadViewport() {
  if (!state.thread || !state.open) return null;
  const bounds = state.thread.getBoundingClientRect();
  const anchor = [...state.thread.children].find(element => element.getBoundingClientRect().bottom > bounds.top + 1);
  return {
    follow: state.sending || state.thread.scrollHeight - state.thread.clientHeight - state.thread.scrollTop < 48,
    top: state.thread.scrollTop,
    anchorId: anchor?.dataset.supportMessageId || "",
    offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : 0,
  };
}

function restoreThreadViewport(viewport) {
  if (!viewport || !state.thread || !state.open) return;
  if (viewport.follow) { state.thread.scrollTop = state.thread.scrollHeight; return; }
  const anchor = viewport.anchorId ? state.thread.querySelector(`[data-support-message-id="${CSS.escape(viewport.anchorId)}"]`) : null;
  if (anchor) state.thread.scrollTop += anchor.getBoundingClientRect().top - state.thread.getBoundingClientRect().top - viewport.offset;
  else state.thread.scrollTop = viewport.top;
}

function syncLauncherState() {
  state.launchers = state.launchers.filter((launcher) => launcher?.isConnected);
  state.launchers.forEach((launcher) => {
    launcher.classList.toggle("is-open", state.open);
    launcher.setAttribute("aria-expanded", state.open ? "true" : "false");
  });
}

function render() {
  ensureDrawer();
  if (!state.drawer) return;
  const viewport = captureThreadViewport();
  renderStatus();
  renderThread(viewport);
  renderPrompts();
  autoSizeTextarea();
  syncComposerState();
  syncComposerPrompt();
  syncLauncherState();
  syncLiveUpdates();
  restoreThreadViewport(viewport);
}

function closeNotificationPanels() {
  document.querySelectorAll("[data-notification-panel].show").forEach((panel) => {
    panel.classList.remove("show");
    panel.classList.add("hidden");
    panel.style.removeProperty("display");
  });
  document.querySelectorAll(".notification-dropdown").forEach((dropdown) => {
    dropdown.style.display = "none";
  });
}

function closeProfileMenus() {
  document.querySelectorAll(".profile-dropdown.show").forEach((menu) => {
    menu.classList.remove("show");
    menu.setAttribute("aria-hidden", "true");
  });
  document.querySelectorAll('[aria-haspopup="true"][aria-expanded="true"]').forEach((trigger) => {
    if (trigger.classList.contains("support-launcher")) return;
    trigger.setAttribute("aria-expanded", "false");
  });
}

async function refreshConversationMessages({ silent = false, throwOnFailure = false, verifyOnly = false } = {}) {
  const revision = supportIdentityRevision;
  const contentRevision = supportContentRevision;
  if (!state.conversation?.id) return null;
  if (!verifyOnly && (mutationSnapshot.pending || state.escalatingMessageId || state.feedbackSubmittingIds.size)) return state.conversation;
  if (silent && (state.loadingConversation || state.silentRefreshing)) return state.conversation;
  const targetConversationId = state.conversation.id;

  if (silent) {
    state.silentRefreshing = true;
  } else {
    state.loadingConversation = true;
    state.error = "";
    render();
  }

  try {
    const messagesRes = await supportFetch(
      `/api/support/conversation/${encodeURIComponent(state.conversation.id)}/messages`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      }
    );
    if (!messagesRes.ok) {
      throw new Error("Unable to load support history.");
    }
    const messagesPayload = await messagesRes.json();
    if (!Array.isArray(messagesPayload.messages) || messagesPayload.conversation?.id !== targetConversationId) {
      throw new Error("Unable to load support history.");
    }
    if (verifyOnly || revision !== supportIdentityRevision || contentRevision !== supportContentRevision || state.conversation?.id !== targetConversationId) {
      return state.conversation;
    }
    state.conversation = messagesPayload.conversation || state.conversation;
    state.messages = Array.isArray(messagesPayload.messages) ? messagesPayload.messages : [];
    state.dismissedSuggestedReplyIds.forEach((messageId) => {
      if (!state.messages.some((message) => message?.id === messageId)) {
        state.dismissedSuggestedReplyIds.delete(messageId);
      }
    });
    if (!silent) {
      state.error = "";
    }
  } catch (error) {
    if (revision !== supportIdentityRevision) return;
    if (!silent) {
      state.error = error?.message || "Unable to load support history.";
    }
    if (throwOnFailure) throw error;
  } finally {
    if (revision !== supportIdentityRevision) return;
    if (silent) {
      state.silentRefreshing = false;
    } else {
      state.loadingConversation = false;
    }
    render();
  }

  return state.conversation;
}

function stopPolling() {
  if (!state.pollTimer) return;
  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function stopLiveUpdates() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.eventSourceConversationId = "";
  state.streamFallbackConversationId = "";
  stopPolling();
}

function syncPolling() {
  const shouldPoll =
    typeof window !== "undefined" &&
    state.open &&
    Boolean(state.conversation?.id) &&
    state.conversation?.escalation?.requested === true;

  if (!shouldPoll) {
    stopPolling();
    return;
  }

  if (state.pollTimer) return;
  state.pollTimer = window.setInterval(() => {
    refreshConversationMessages({ silent: true }).catch((error) => {
      console.warn("[support] conversation poll rejected", error);
    });
  }, 15000);
}

function syncLiveUpdates() {
  const shouldSync =
    typeof window !== "undefined" &&
    state.open &&
    Boolean(state.conversation?.id) &&
    state.conversation?.escalation?.requested === true;

  if (!shouldSync) {
    stopLiveUpdates();
    return;
  }

  if (state.streamFallbackConversationId === state.conversation.id || typeof window.EventSource === "undefined") {
    syncPolling();
    return;
  }

  stopPolling();
  if (state.eventSource && state.eventSourceConversationId === state.conversation.id) return;
  if (state.eventSource && state.eventSourceConversationId !== state.conversation.id) {
    state.eventSource.close();
    state.eventSource = null;
    state.eventSourceConversationId = "";
  }

  try {
    const revision = supportIdentityRevision;
    const source = new window.EventSource(supportTransport.boundEventsUrl(
      `/api/support/conversation/${encodeURIComponent(state.conversation.id)}/events`,
      { ownerId: scopedSupportUserId, role: scopedSupportRole }
    ));
    source.addEventListener("conversation.ready", () => {});
    source.addEventListener("conversation.updated", () => {
      if (state.eventSource !== source || revision !== supportIdentityRevision) return;
      refreshConversationMessages({ silent: true }).catch((error) => {
        console.warn("[support] live conversation refresh rejected", error);
      });
    });
    source.onerror = () => {
      if (state.eventSource !== source || revision !== supportIdentityRevision) return;
      if (state.eventSource === source) {
        source.close();
        state.eventSource = null;
        state.eventSourceConversationId = "";
      }
      // Stay on bounded polling for this open drawer. Redraws must not turn
      // an offline stream plus failed read into a reconnect/request loop.
      state.streamFallbackConversationId = state.conversation.id;
      syncPolling();
      void refreshConversationMessages({ silent: true, verifyOnly: true });
    };
    state.eventSource = source;
    state.eventSourceConversationId = state.conversation.id;
  } catch (_error) {
    syncPolling();
  }
}

async function ensureConversationLoaded(force = false) {
  scopeSupportIdentity();
  const revision = supportIdentityRevision;
  if (!isSupportSessionAllowed()) return null;
  if (state.loadPromise && !force) return state.loadPromise;
  if (state.bootstrapped && !force) return state.conversation;

  state.loadingConversation = true;
  state.loadFailed = false;
  state.error = "";
  render();

  state.loadPromise = (async () => {
    try {
      const query = buildConversationQuery();
      const conversationRes = await supportFetch(
        `/api/support/conversation${query ? `?${query}` : ""}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
        }
      );
      if (!conversationRes.ok) {
        throw new Error("Support isn't available right now. Please try again in a moment.");
      }
      const conversationPayload = await conversationRes.json();
      if (!conversationPayload.conversation?.id) throw new Error("Support isn't available right now. Please try again in a moment.");
      if (state.conversation?.id !== conversationPayload.conversation.id) {
        supportContentRevision++;
        state.messages = [];
        state.dismissedSuggestedReplyIds.clear();
      }
      state.conversation = conversationPayload.conversation;
      await refreshConversationMessages({ silent: false, throwOnFailure: true });
      if (revision !== supportIdentityRevision) return null;
      await maybeRefreshConversationForAuthSession();
      if (revision !== supportIdentityRevision) return null;
      state.bootstrapped = true;
      state.error = "";
      if (!state.restoredMutation) {
        state.restoredMutation = true;
        try {
          supportMutations.restore({ ownerId: scopedSupportUserId, role: scopedSupportRole });
        } catch (error) {
          if (revision === supportIdentityRevision) state.error = error?.message || "The earlier request could not be restored.";
        }
      }
      if (mutationSnapshot.pending) await supportMutations.check();
      if (conversationPayload.recoveryRequest && conversationPayload.recoveryRequest.requestId !== mutationSnapshot.pending?.requestId) {
        const previous = mutationSnapshot.pending;
        if (previous?.action === "send" && state.textarea && !state.textarea.value.trim()) state.textarea.value = previous.body.text;
        supportMutations.adopt(conversationPayload.recoveryRequest, { ownerId: scopedSupportUserId, role: scopedSupportRole }, { replaceInactive: true });
        if (mutationSnapshot.pending?.requestId === conversationPayload.recoveryRequest.requestId) await supportMutations.check();
      }
    } catch (error) {
      if (revision !== supportIdentityRevision) return null;
      state.loadFailed = true;
      state.error = error?.message || "Support isn't available right now. Please try again in a moment.";
    } finally {
      if (revision !== supportIdentityRevision) return null;
      state.loadingConversation = false;
      state.loadPromise = null;
      render();
    }

    return state.conversation;
  })();

  return state.loadPromise;
}

function createOptimisticMessage({ sender, text, loading = false }) {
  return {
    id: `temp-${sender}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sender,
    text,
    createdAt: new Date().toISOString(),
    loading,
  };
}

function replaceMessageInState(nextMessage = null) {
  if (!nextMessage?.id) return;
  const index = state.messages.findIndex((message) => message?.id === nextMessage.id);
  if (index === -1) {
    state.messages.push(nextMessage);
    return;
  }
  state.messages.splice(index, 1, nextMessage);
}

function appendMessageIfMissing(nextMessage = null) {
  if (!nextMessage?.id) return;
  if (state.messages.some((message) => message?.id === nextMessage.id)) return;
  state.messages.push(nextMessage);
}

function clearOptimisticSupportMessages() {
  if (state.optimisticMessageIds.size) state.messages = state.messages.filter(message => !state.optimisticMessageIds.has(message?.id));
  state.optimisticMessageIds.clear();
  state.optimisticRequestId = "";
}

function syncSupportMutation(next) {
  if (next.pending?.requestId !== mutationSnapshot.pending?.requestId || (next.phase === "running" && mutationSnapshot.phase !== "running")) supportContentRevision++;
  mutationSnapshot = next;
  state.sending = next.busy && next.pending?.action === "send";
  state.restartingConversation = next.busy && next.pending?.action === "restart";
  if (next.phase === "running" && next.pending?.action === "send" && state.optimisticRequestId !== next.pending.requestId) {
    clearOptimisticSupportMessages();
    const user = createOptimisticMessage({ sender: "user", text: next.pending.body.text });
    const assistant = createOptimisticMessage({ sender: "assistant", text: "", loading: true });
    state.optimisticRequestId = next.pending.requestId;
    state.optimisticMessageIds.add(user.id); state.optimisticMessageIds.add(assistant.id);
    state.messages.push(user, assistant);
    if (state.textarea?.value.trim() === next.pending.body.text) state.textarea.value = "";
    state.error = ""; state.failedMessageText = "";
  }
  if (next.phase !== "running" || !next.busy) clearOptimisticSupportMessages();
  if (!next.busy && next.pending?.action === "send" && state.textarea && !state.textarea.value.trim()) state.textarea.value = next.pending.body.text;
  render();
}

function applySupportMutationResult(payload, record) {
  supportContentRevision++;
  clearOptimisticSupportMessages();
  // Outcome receipts describe the original operation. A different current
  // conversation may already have been started in another tab.
  const currentId = state.conversation?.id;
  if (record.action === "send" && state.textarea?.value.trim() === record.body.text) state.textarea.value = "";
  if (currentId && currentId !== record.conversationId) {
    state.error = "";
    return;
  }
  const existingUpdatedAt = new Date(state.conversation?.updatedAt || 0).getTime();
  const resultUpdatedAt = new Date(payload.conversation?.updatedAt || 0).getTime();
  if (record.action === "restart" || resultUpdatedAt >= existingUpdatedAt) state.conversation = payload.conversation;
  if (record.action === "restart") {
    state.messages = payload.messages;
    state.dismissedSuggestedReplyIds.clear();
  } else {
    appendMessageIfMissing(payload.userMessage);
    if (record.action === "escalate") replaceMessageInState(payload.assistantMessage);
    else appendMessageIfMissing(payload.assistantMessage);
    appendMessageIfMissing(payload.systemMessage);
    state.dismissedSuggestedReplyIds.delete(payload.assistantMessage.id);
  }
  state.bootstrapped = true; state.loadFailed = false; state.error = "";
  writeSupportSessionMarker(getSupportSessionUserId());
}

async function sendSupportMessage(rawText, options = {}) {
  scopeSupportIdentity();
  const revision = supportIdentityRevision;
  const text = String(rawText || "").trim();
  if (!text || mutationSnapshot.pending || state.escalatingMessageId || state.invokingAction || state.feedbackSubmittingIds.size || !isSupportSessionAllowed()) return;
  if (text.length > 4000) { state.error = "Keep your question within 4,000 characters."; render(); return; }
  ensureDrawer();
  await ensureConversationLoaded();
  if (revision !== supportIdentityRevision || supportInteractionPending()) return;
  if (!state.conversation?.id || state.loadFailed) {
    state.error ||= "Support isn't available right now. Please try again in a moment.";
    render(); return;
  }
  const pageContext = getCurrentPageContext();
  const sourcePage = `${pageContext.pathname || ""}${pageContext.search || ""}${pageContext.hash || ""}`;
  try {
    await supportMutations.begin({ ownerId: scopedSupportUserId, role: scopedSupportRole, conversationId: state.conversation.id, action: "send", body: { text, sourcePage, pageContext, promptAction: options?.promptAction || null } });
    if (revision === supportIdentityRevision && mutationSnapshot.phase === "blocked") await ensureConversationLoaded(true);
  } catch (error) {
    if (revision !== supportIdentityRevision) return;
    state.error = error?.message || "Your request could not be saved. Please try again."; render();
  }
}

async function sendEscalationRequest(messageId) {
  const revision = supportIdentityRevision;
  let recoverOther = false;
  if (!messageId || supportInteractionPending()) return;
  await ensureConversationLoaded();
  if (revision !== supportIdentityRevision || supportInteractionPending()) return;
  if (!state.conversation?.id) {
    state.error = "Support isn't available right now. Please try again in a moment.";
    render();
    return;
  }

  state.escalatingMessageId = messageId;
  state.error = "";
  render();

  try {
    const pageContext = getCurrentPageContext();
    const sourcePage = `${pageContext.pathname || ""}${pageContext.search || ""}${pageContext.hash || ""}`;
    const response = await supportFetch(
      `/api/support/conversation/${encodeURIComponent(state.conversation.id)}/escalate`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
        body: {
          messageId,
          sourcePage,
          pageContext,
        },
      }
    );
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      recoverOther = failure.code === "SUPPORT_CONVERSATION_BUSY";
      throw new Error("Couldn't send this to the team right now. Please try again.");
    }

    const payload = await response.json();
    state.conversation = payload.conversation || state.conversation;
    replaceMessageInState(payload.assistantMessage || null);
    appendMessageIfMissing(payload.systemMessage || null);
  } catch (error) {
    if (revision !== supportIdentityRevision) return;
    state.error = error?.message || "Couldn't send this to the team right now. Please try again.";
  } finally {
    if (revision !== supportIdentityRevision) return;
    state.escalatingMessageId = "";
    render();
  }
  if (recoverOther && revision === supportIdentityRevision) await ensureConversationLoaded(true);
}

async function restartSupportConversation() {
  const revision = supportIdentityRevision;
  if (supportInteractionPending()) return;
  await ensureConversationLoaded();
  if (revision !== supportIdentityRevision || supportInteractionPending()) return;
  if (!state.conversation?.id || state.loadFailed) {
    state.error ||= "Support isn't available right now. Please try again in a moment.";
    render(); return;
  }
  state.error = "";
  stopLiveUpdates();
  const pageContext = getCurrentPageContext();
  const sourcePage = `${pageContext.pathname || ""}${pageContext.search || ""}${pageContext.hash || ""}`;
  try {
    await supportMutations.begin({ ownerId: scopedSupportUserId, role: scopedSupportRole, conversationId: state.conversation.id, action: "restart", body: { sourcePage, pageContext } });
    if (revision === supportIdentityRevision && mutationSnapshot.phase === "blocked") await ensureConversationLoaded(true);
  } catch (error) {
    if (revision !== supportIdentityRevision) return;
    state.error = error?.message || "The new conversation request could not be saved."; render();
  }
}

async function maybeRefreshConversationForAuthSession() {
  const currentUserId = getSupportSessionUserId();
  if (currentUserId) writeSupportSessionMarker(currentUserId);
  // A new tab is not a request to restart. The server owns inactivity resets;
  // the explicit Start new conversation action owns manual resets.
}

async function sendCurrentDraft() {
  if (!state.textarea) return;
  await sendSupportMessage(state.textarea.value);
}

function syncPinnedSupportDrawer() {
  const isPinned = Boolean(state.open && state.pinned);
  document.documentElement.classList.toggle("support-drawer-pinned", isPinned);
  document.body.classList.toggle("support-drawer-pinned", isPinned);
  state.drawer?.classList.toggle("is-pinned", isPinned);
  state.drawer?.setAttribute("aria-modal", isPinned ? "false" : "true");
  if (isPinned) deactivateDialogFocus(state.drawer, { restoreFocus: false });
}

function setSupportDrawerPinned(pinned = false) {
  if (pinned && !canPinSupportDrawer()) return;
  state.pinned = Boolean(pinned);
  persistPinnedSupportDrawer(state.pinned);
  if (state.pinned) closeSupportMenu();
  syncPinnedSupportDrawer();
  if (state.open && !state.pinned && state.drawer) {
    activateDialogFocus(state.drawer, {
      initialFocus: document.activeElement instanceof HTMLElement && state.drawer.contains(document.activeElement)
        ? document.activeElement
        : state.textarea,
      returnFocus: state.lastFocusedLauncher,
      onEscape: () => closeSupportDrawer(),
    });
  }
}

function syncSupportResponsiveState() {
  syncSidebarCollapseTab();
  if (!state.open) return;
  const shouldPin = canPinSupportDrawer();
  if (state.pinned !== shouldPin) setSupportDrawerPinned(shouldPin);
}

export function closeSupportDrawer({ restoreFocus = true } = {}) {
  if (!state.open) return;
  if (state.pinned) setSupportDrawerPinned(false);
  state.open = false;
  stopLiveUpdates();
  stopComposerPromptRotation();
  closeSupportMenu();
  document.documentElement.classList.remove("support-drawer-open");
  document.body.classList.remove("support-drawer-open");
  state.drawer?.setAttribute("aria-hidden", "true");
  state.drawer?.setAttribute("inert", "");
  deactivateDialogFocus(state.drawer, { restoreFocus: false });
  syncPinnedSupportDrawer();
  syncLauncherState();
  if (restoreFocus && state.lastFocusedLauncher?.focus) {
    state.lastFocusedLauncher.focus();
  }
}

export async function openSupportDrawer({ launcher = null, focusComposer = true, promptText = "", submitPrompt = false, navigationAdapter = null } = {}) {
  scopeSupportIdentity();
  const revision = supportIdentityRevision;
  if (!isSupportSessionAllowed()) return;
  state.navigationAdapter = navigationAdapter || configuredSupportNavigationAdapter;
  if (!state.open) state.pinned = canPinSupportDrawer();
  ensureDrawer();
  ensureSidebarCollapseTab();
  if (!state.drawer) return;
  await ensureStylesheet();
  if (revision !== supportIdentityRevision) return;
  revealDrawerShell();
  state.lastFocusedLauncher = launcher || document.activeElement;
  closeNotificationPanels();
  closeProfileMenus();
  const pageContext = getCurrentPageContext();
  recordSupportOpen(pageContext.viewName || "");
  state.open = true;
  document.documentElement.classList.add("support-drawer-open");
  document.body.classList.add("support-drawer-open");
  state.drawer.setAttribute("aria-hidden", "false");
  state.drawer.removeAttribute("inert");
  syncPinnedSupportDrawer();
  render();
  await ensureConversationLoaded();
  if (revision !== supportIdentityRevision) return;
  syncLiveUpdates();
  syncComposerPrompt();
  const normalizedPrompt = String(promptText || "").trim();
  if (normalizedPrompt && state.textarea) {
    state.textarea.value = normalizedPrompt;
    state.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    if (submitPrompt) await sendSupportMessage(normalizedPrompt);
  }
  if (focusComposer && state.textarea) {
    state.textarea.focus();
  }
  if (!state.pinned) {
    activateDialogFocus(state.drawer, {
      initialFocus: focusComposer ? state.textarea : state.closeButton,
      returnFocus: state.lastFocusedLauncher,
      onEscape: () => closeSupportDrawer(),
    });
  }
}

function createLauncher() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "notification-icon support-launcher";
  button.dataset.publicAction = "icon";
  button.setAttribute("aria-label", "Open AI help chat");
  button.title = "AI help chat";
  button.setAttribute("aria-controls", SUPPORT_DRAWER_ID);
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = buildLauncherIcon();
  button.addEventListener("click", async () => {
    if (state.open) {
      closeSupportDrawer();
      return;
    }
    await openSupportDrawer({ launcher: button });
  });
  return button;
}

export function registerSupportLauncher(button) {
  if (!(button instanceof HTMLElement)) return null;
  if (!state.launchers.includes(button)) state.launchers.push(button);
  button.setAttribute("aria-controls", SUPPORT_DRAWER_ID);
  button.setAttribute("aria-expanded", state.open ? "true" : "false");
  if (button.dataset.boundSupportLauncher !== "true") {
    button.dataset.boundSupportLauncher = "true";
    button.addEventListener("click", async () => {
      if (state.open) {
        closeSupportDrawer();
        return;
      }
      await openSupportDrawer({ launcher: button });
    });
  }
  ensureDrawer();
  syncLauncherState();
  return button;
}

export function notifySupportRouteChanged() {
  state.pageTracked = false;
  recordCurrentView();
}

function insertLauncher(root) {
  const anchor = root.matches(".notification-wrapper")
    ? root
    : root.querySelector(".notification-wrapper") || root.querySelector("[data-notification-toggle]");
  const launcher = createLauncher();
  if (anchor) {
    anchor.insertAdjacentElement("afterend", launcher);
  } else {
    root.insertAdjacentElement("afterbegin", launcher);
  }
  state.launchers.push(launcher);
}

export function scanSupportLaunchers() {
  if (!isSupportSessionAllowed()) {
    stopLiveUpdates();
    state.launchers.forEach((launcher) => launcher?.remove?.());
    state.launchers = [];
    return;
  }
  ensureDrawer();
  ensureSidebarCollapseTab();
  if (document.documentElement.dataset.lpcSupportExternalLauncher === "true") {
    document.querySelectorAll(".support-launcher--floating").forEach((launcher) => launcher.remove());
    state.launchers = state.launchers.filter((launcher) => launcher?.isConnected);
    syncLauncherState();
    if (readPinnedSupportDrawer() && !state.open && !state.restoringPinned && canPinSupportDrawer()) {
      state.restoringPinned = true;
      void openSupportDrawer({ focusComposer: false }).finally(() => {
        state.restoringPinned = false;
      });
    }
    return;
  }
  const roots = [...document.querySelectorAll("[data-notification-center]")];
  if (roots.length) {
    document.querySelectorAll(".support-launcher--floating").forEach((launcher) => launcher.remove());
    state.launchers = state.launchers.filter((launcher) => launcher?.isConnected);
  }
  roots.forEach((root) => {
    if (!(root instanceof HTMLElement)) return;
    if (root.dataset.boundSupportLauncher === "true") return;
    root.dataset.boundSupportLauncher = "true";
    insertLauncher(root);
  });
  if (!roots.length && !document.querySelector(".support-launcher--floating")) {
    const launcher = createLauncher();
    launcher.classList.add("support-launcher--floating");
    document.body.appendChild(launcher);
    state.launchers.push(launcher);
  }
  syncLauncherState();
  if (readPinnedSupportDrawer() && !state.open && !state.restoringPinned && canPinSupportDrawer()) {
    state.restoringPinned = true;
    void openSupportDrawer({ focusComposer: false }).finally(() => {
      state.restoringPinned = false;
    });
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scanSupportLaunchers();
    });
  } else {
    scanSupportLaunchers();
  }
}

if (typeof window !== "undefined") {
  window.scanSupportLaunchers = scanSupportLaunchers;
  window.closeSupportDrawer = closeSupportDrawer;
  window.openSupportDrawer = openSupportDrawer;
  window.addEventListener("resize", syncSupportResponsiveState);
}
