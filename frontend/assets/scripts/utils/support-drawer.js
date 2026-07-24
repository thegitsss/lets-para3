import { getStoredSession, secureFetch } from "../auth.js";
import { buildSupportInlineSegments, isSafeSupportHref } from "./support-message-links.mjs";
import {
  getAssistantActionLimit,
  getAssistantSuggestionLimit,
  isSupportedEscalationMetadata,
} from "./support-response-ui.mjs";
import { startStripeOnboarding } from "./stripe-connect.js";

const SUPPORT_STYLESHEET_ID = "lpc-support-drawer-styles";
const SUPPORT_STYLESHEET_HREF = "/assets/styles/support-drawer.css";
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
      "Ask about a case",
      "Ask about messages",
      "Ask about profile settings",
      "Describe what's blocking you",
    ];
  }
  if (normalizedRole === "paralegal") {
    return [
      "Ask about a payout",
      "Ask about Stripe onboarding",
      "Ask about a case",
      "Ask about messages",
      "Describe what's blocking you",
    ];
  }
  if (normalizedRole === "admin") {
    return [
      "Ask about the review queue",
      "Ask about approvals",
      "Ask about a support ticket",
      "Ask about an attorney record",
      "Describe what's blocking you",
    ];
  }
  return [
    "Ask about billing",
    "Ask about a case",
    "Ask about messages",
    "Ask about account settings",
    "Describe what's blocking you",
  ];
}

function getRoleAwareQuickPrompts(role = "") {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "attorney") {
    return [
      "Where is Billing & Payments?",
      "Where can I see my cases?",
      "I can't send messages",
      "I need help with a case",
    ];
  }
  if (normalizedRole === "paralegal") {
    return [
      "Where is my payout?",
      "Why aren't payouts enabled?",
      "I can't send messages",
      "I need help with a case",
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
    "Where can I see my cases?",
    "I can't send messages",
    "I need help with a case",
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
  if (normalizedRole === "paralegal") return "Paralegal Assistant";
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
  silentRefreshing: false,
  sending: false,
  restartingConversation: false,
  loadPromise: null,
  stylesheetPromise: null,
  conversation: null,
  messages: [],
  error: "",
  failedMessageText: "",
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
  pinButton: null,
  sidebarCollapseTab: null,
  sidebarClassObserver: null,
  composerPrompt: null,
  composerPromptText: null,
  composerPromptIndex: 0,
  composerPromptTimer: null,
  composerPromptTransitionTimer: null,
  escalatingMessageId: "",
  feedbackSubmittingIds: new Set(),
  pollTimer: null,
  eventSource: null,
  eventSourceConversationId: "",
  dismissedSuggestedReplyIds: new Set(),
  pageTracked: false,
};

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
  return typeof window === "undefined" || !window.matchMedia || window.matchMedia("(min-width: 681px)").matches;
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
  if (typeof document === "undefined" || state.sidebarCollapseTab?.isConnected) return;
  const sidebar = document.querySelector("#sidebarNav.sidebar");
  if (!(sidebar instanceof HTMLElement)) return;
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "support-sidebar-collapse-tab";
  tab.setAttribute("aria-controls", "sidebarNav");
  tab.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m14.5 6-6 6 6 6"></path>
    </svg>
  `;
  tab.addEventListener("click", () => {
    if (isCompactSidebarLayout()) {
      document.body.classList.toggle("nav-open");
      syncSidebarCollapseTab();
      return;
    }
    if (!canCollapseDashboardSidebar()) return;
    document.body.classList.toggle("support-sidebar-collapsed");
    syncSidebarCollapseTab();
  });
  document.body.appendChild(tab);
  state.sidebarCollapseTab = tab;
  if (typeof MutationObserver !== "undefined") {
    state.sidebarClassObserver?.disconnect?.();
    state.sidebarClassObserver = new MutationObserver(syncSidebarCollapseTab);
    state.sidebarClassObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  syncSidebarCollapseTab();
}

function readSupportSessionMarker() {
  if (typeof window === "undefined") return "";
  try {
    return String(window.sessionStorage.getItem(SUPPORT_SESSION_USER_KEY) || "").trim();
  } catch (_error) {
    return "";
  }
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
  const session = getSupportSession();
  const role = String(session?.role || "").toLowerCase();
  const status = String(session?.status || "").toLowerCase();
  return status === "approved" && ["attorney", "paralegal", "admin"].includes(role);
}

function inferViewName(pathname = "", hash = "", caseId = "") {
  const path = String(pathname || "").toLowerCase();
  const currentHash = String(hash || "").toLowerCase();
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
    const raw = window.localStorage.getItem(SUPPORT_CONTEXT_STORAGE_KEY);
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
    window.localStorage.setItem(SUPPORT_CONTEXT_STORAGE_KEY, JSON.stringify(nextStore));
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
  const existing = document.getElementById(SUPPORT_STYLESHEET_ID);
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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

function buildPinIcon() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 3h12"></path>
      <path d="M7 3v6l-2.5 4h15L17 9V3"></path>
      <path d="M12 13v8"></path>
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
    return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="6.5" width="9" height="9" rx="2"></rect><path d="M13.5 6.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6.5a2 2 0 0 0 2 2h1.5"></path></svg>`;
  }
  if (type === "helpful") {
    return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.2 8.3 9.1 3a1.5 1.5 0 0 1 2.8.9v3h3.2a2 2 0 0 1 1.9 2.6l-1.5 5A2.2 2.2 0 0 1 13.4 16H6.2"></path><path d="M3 8.3h3.2V16H3z"></path></svg>`;
  }
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6.2 11.7 2.9 5.3a1.5 1.5 0 0 0 2.8-.9v-3h3.2A2 2 0 0 0 17 10.5l-1.5-5A2.2 2.2 0 0 0 13.4 4H6.2"></path><path d="M3 4h3.2v7.7H3z"></path></svg>`;
}

function buildArrowIcon() {
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h11"></path><path d="m11 6 4 4-4 4"></path></svg>`;
}

function createDrawerMarkup() {
  const backdrop = document.createElement("div");
  backdrop.className = "support-drawer-backdrop";
  backdrop.setAttribute("data-support-backdrop", "true");
  backdrop.hidden = !state.stylesReady;

  const drawer = document.createElement("aside");
  drawer.className = "support-drawer";
  drawer.id = SUPPORT_DRAWER_ID;
  drawer.setAttribute("role", "dialog");
  drawer.setAttribute("aria-modal", "true");
  drawer.setAttribute("aria-hidden", "true");
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
            aria-label="Open assistant options"
            aria-expanded="false"
            aria-haspopup="menu"
          >
            ${buildMenuIcon()}
          </button>
          <div class="support-drawer-menu-panel" data-support-menu-panel role="menu" hidden>
            <button class="support-drawer-menu-item" type="button" data-support-restart role="menuitem">
              Start new conversation
            </button>
          </div>
        </div>
        <button
          class="support-drawer-pin"
          type="button"
          data-support-pin
          aria-label="Pin assistant while you browse"
          aria-pressed="false"
          title="Pin assistant"
        >
          ${buildPinIcon()}
        </button>
        <button class="support-drawer-close" type="button" data-support-close aria-label="Close assistant">
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
        <textarea id="supportComposerInput" data-support-textarea rows="1" aria-label="Ask Assistant a question"></textarea>
        <button class="support-send" type="submit" data-support-submit aria-label="Send message">
          ${buildSendIcon()}
        </button>
      </div>
      <p class="support-composer-hint"><span class="support-composer-hint-icon">${buildShieldCheckIcon()}</span><span>Uses your authorized LPC context. Verify important details.</span></p>
    </form>
  `;

  document.body.append(backdrop, drawer);
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
  state.pinButton = drawer.querySelector("[data-support-pin]");
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
  state.pinButton?.addEventListener("click", () => {
    setSupportDrawerPinned(!state.pinned);
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
    if (event.key === "Escape" && state.open) {
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
  state.submit.disabled = state.sending || state.loadingConversation || state.restartingConversation || !hasText;
  state.textarea.disabled = state.loadingConversation || state.restartingConversation;
  state.drawer?.setAttribute(
    "aria-busy",
    state.loadingConversation || state.sending || state.restartingConversation ? "true" : "false"
  );
  if (state.restartButton) {
    state.restartButton.disabled =
      state.loadingConversation || state.sending || state.escalatingMessageId || state.restartingConversation;
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
  const search = window.location.search;
  const hash = window.location.hash;
  const caseId = params.get("caseId") || params.get("highlightCase") || "";
  const billingPaymentMethod =
    window.__lpcBillingPaymentMethod && typeof window.__lpcBillingPaymentMethod === "object"
      ? {
          brand: String(window.__lpcBillingPaymentMethod.brand || ""),
          last4: String(window.__lpcBillingPaymentMethod.last4 || ""),
          exp_month: Number(window.__lpcBillingPaymentMethod.exp_month || 0) || null,
          exp_year: Number(window.__lpcBillingPaymentMethod.exp_year || 0) || null,
          type: String(window.__lpcBillingPaymentMethod.type || ""),
        }
      : null;
  const viewName = inferViewName(pathname, hash, caseId);
  const behavior = getSupportBehaviorSnapshot(viewName);
  return {
    href: window.location.href,
    pathname,
    search,
    hash,
    title: document.title,
    label: heading?.textContent?.trim() || "",
    viewName,
    roleHint: String(session?.role || ""),
    caseId,
    jobId: params.get("jobId") || "",
    applicationId: params.get("applicationId") || "",
    repeatViewCount: behavior.repeatViewCount,
    supportOpenCount: behavior.supportOpenCount,
    recentViewName: behavior.recentViewName,
    ...(billingPaymentMethod &&
    (billingPaymentMethod.last4 || billingPaymentMethod.brand || billingPaymentMethod.exp_month || billingPaymentMethod.exp_year)
      ? { paymentMethod: billingPaymentMethod }
      : {}),
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
  if (normalized === "waiting_on_info") return "Waiting on user";
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getLatestAssistantMessage() {
  return [...state.messages].reverse().find((message) => getMessageVariant(message) === "assistant") || null;
}

function getLatestTeamReply() {
  return [...state.messages].reverse().find((message) => getMessageVariant(message) === "team") || null;
}

function buildSuggestedReplyMessage(option = "") {
  const normalized = String(option || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "this case") return "This is happening in this case.";
  if (normalized === "across all messages") return "This is happening across all messages.";
  if (normalized === "billing method") return "This is about my billing method.";
  if (normalized === "case payment") return "This is about a specific case payment.";
  if (normalized === "billing") return "I need help with billing.";
  if (normalized === "my applications") return "Where do I see my applications?";
  if (normalized === "a case") return "I need help with a case.";
  if (normalized === "browse cases") return "Where can I browse open cases?";
  if (normalized === "messages") return "I need help with messages.";
  if (normalized === "payouts") return "I need help with payouts.";
  if (normalized === "resume application") return "How do I resume my application?";
  if (normalized === "case payment") return "This is about a specific case payment.";
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

function getThreadStatusNotice() {
  return null;
}

function delay(ms = 0) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

async function navigateFromSupport(href = "") {
  const targetHref = String(href || "").trim();
  if (!targetHref) return;
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

function appendMessageBubbleContent(bubble, message = {}) {
  const actionHrefs = new Set(
    (Array.isArray(message.metadata?.actions) ? message.metadata.actions : [])
      .map((action) => String(action?.href || "").trim())
      .filter((href) => isSafeSupportHref(href))
  );
  const navigation = message.metadata?.navigation || null;
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
    if (segment.type === "link" && !actionHrefs.has(String(segment.href || "").trim())) {
      const anchor = document.createElement("a");
      anchor.className = "support-inline-link";
      anchor.href = segment.href;
      anchor.textContent = segment.text;
      anchor.setAttribute("data-support-inline-link", "true");
      fragment.appendChild(anchor);
      return;
    }
    fragment.appendChild(document.createTextNode(segment.text));
  });
  bubble.replaceChildren(fragment);
}

function createMessageElement(message = {}) {
  const item = document.createElement("article");
  const variant = getMessageVariant(message);
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
    const label = document.createElement("span");
    label.textContent = "Checking that now";
    const dots = document.createElement("span");
    dots.className = "support-loading-dots";
    dots.innerHTML = "<span></span><span></span><span></span>";
    bubble.append(label, dots);
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
  const actionType = String(action?.type || "").trim().toLowerCase();
  const invokeAction = String(action?.action || "").trim().toLowerCase();
  if (actionType === "invoke" && invokeAction === "start_stripe_onboarding") {
    try {
      await startStripeOnboarding();
    } catch (error) {
      state.error = error?.message || "Unable to start Stripe onboarding.";
      render();
    }
    return;
  }
  if (actionType === "invoke" && invokeAction === "request_password_reset") {
    try {
      const session = getSupportSession();
      const email = String(session?.user?.email || "").trim();
      if (!email) {
        throw new Error("We couldn't find an email address for this account.");
      }
      const response = await secureFetch("/api/auth/request-password-reset", {
        method: "POST",
        headers: { Accept: "application/json" },
        body: { email },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error || "Couldn't send a reset link right now.");
      }
      appendLocalNotice("Password reset link sent.");
      state.error = "";
      render();
    } catch (error) {
      state.error = error?.message || "Couldn't send a reset link right now.";
      render();
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

async function submitMessageFeedback(message = {}, rating = "") {
  if (!state.conversation?.id || !message?.id || state.feedbackSubmittingIds.has(message.id)) return;
  state.feedbackSubmittingIds.add(message.id);
  state.error = "";
  render();
  try {
    const response = await secureFetch(
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
    state.error = error?.message || "Couldn't save that feedback.";
  } finally {
    state.feedbackSubmittingIds.delete(message.id);
    render();
  }
}

function createMessageActions(message = {}) {
  if (message.loading || getMessageVariant(message) !== "assistant") return null;
  const actions = Array.isArray(message.metadata?.actions) ? message.metadata.actions.filter(Boolean) : [];

  const bar = document.createElement("div");
  bar.className = "support-message-actions";
  actions.slice(0, getAssistantActionLimit(message.metadata)).forEach((action) => {
    const isInvoke = String(action?.type || "").trim().toLowerCase() === "invoke";
    if (!isInvoke && !isSafeSupportHref(action?.href || "")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "support-message-action";
    button.textContent = String(action.label || "Open");
    button.disabled = state.sending || state.loadingConversation || state.restartingConversation;
    button.addEventListener("click", () => {
      runSupportAction(action).catch(() => {});
    });
    bar.appendChild(button);
  });

  const utilityBar = document.createElement("div");
  utilityBar.className = "support-message-utilities";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "support-message-utility";
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
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = buildUtilityIcon(rating);
    button.setAttribute("aria-pressed", message.metadata?.feedback?.rating === rating ? "true" : "false");
    button.disabled = state.feedbackSubmittingIds.has(message.id);
    button.addEventListener("click", () => submitMessageFeedback(message, rating));
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
    button.textContent = String(option);
    button.disabled = state.sending || state.loadingConversation || state.restartingConversation;
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
  title.textContent = requested ? "Sent to the team for review." : "Need a manual review?";
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
  button.textContent = state.escalatingMessageId === message.id ? "Sending..." : "Send to the team";
  button.disabled = state.escalatingMessageId === message.id || state.sending || state.loadingConversation;
  button.addEventListener("click", async () => {
    await sendEscalationRequest(message.id);
  });
  card.appendChild(button);

  return card;
}

function renderThread() {
  if (!state.thread) return;
  state.thread.innerHTML = "";

  if (state.loadingConversation && !state.messages.length) {
    state.thread.appendChild(
      createMessageElement({
        sender: "assistant",
        loading: true,
      })
    );
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
}

function shouldShowQuickPrompts() {
  if (state.loadingConversation) return false;
  if (state.error && !state.conversation) return false;
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
    const label = document.createElement("span");
    label.textContent = promptText;
    const arrow = document.createElement("span");
    arrow.className = "support-quick-prompt-arrow";
    arrow.innerHTML = buildArrowIcon();
    button.append(label, arrow);
    button.disabled = state.sending || state.loadingConversation || state.restartingConversation;
    button.addEventListener("click", async () => {
      await sendSupportMessage(promptText);
    });
    state.prompts.appendChild(button);
  });
}

function renderStatus() {
  if (!state.status) return;
  if (!state.error) {
    state.status.classList.remove("is-visible");
    state.status.classList.remove("is-info");
    state.status.textContent = "";
    return;
  }
  state.status.classList.add("is-visible");
  state.status.classList.remove("is-info");
  const label = document.createElement("span");
  label.textContent = state.error;
  state.status.replaceChildren(label);
  if (state.failedMessageText) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "support-status-retry";
    retry.textContent = "Retry";
    retry.disabled = state.sending;
    retry.addEventListener("click", async () => {
      const failedText = state.failedMessageText;
      state.failedMessageText = "";
      await sendSupportMessage(failedText);
    });
    state.status.appendChild(retry);
  }
}

function scrollThreadToBottom() {
  if (!state.thread || !state.open) return;
  window.requestAnimationFrame(() => {
    state.thread.scrollTop = state.thread.scrollHeight;
  });
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
  renderStatus();
  renderThread();
  renderPrompts();
  autoSizeTextarea();
  syncComposerState();
  syncComposerPrompt();
  syncLauncherState();
  syncLiveUpdates();
  scrollThreadToBottom();
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

async function refreshConversationMessages({ silent = false } = {}) {
  if (!state.conversation?.id) return null;
  if (state.sending || state.escalatingMessageId) return state.conversation;
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
    const messagesRes = await secureFetch(
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
    if (state.conversation?.id !== targetConversationId) {
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
    if (!silent) {
      state.error = error?.message || "Unable to load support history.";
    }
  } finally {
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
    refreshConversationMessages({ silent: true }).catch(() => {});
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

  if (typeof window.EventSource === "undefined") {
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
    const source = new window.EventSource(
      `/api/support/conversation/${encodeURIComponent(state.conversation.id)}/events`
    );
    source.addEventListener("conversation.ready", () => {});
    source.addEventListener("conversation.updated", () => {
      refreshConversationMessages({ silent: true }).catch(() => {});
    });
    source.onerror = () => {
      if (state.eventSource === source) {
        source.close();
        state.eventSource = null;
        state.eventSourceConversationId = "";
      }
      syncPolling();
    };
    state.eventSource = source;
    state.eventSourceConversationId = state.conversation.id;
  } catch (_error) {
    syncPolling();
  }
}

async function ensureConversationLoaded(force = false) {
  if (!isSupportSessionAllowed()) return null;
  if (state.loadPromise && !force) return state.loadPromise;
  if (state.bootstrapped && !force) return state.conversation;

  state.loadingConversation = true;
  state.error = "";
  render();

  state.loadPromise = (async () => {
    try {
      const query = buildConversationQuery();
      const conversationRes = await secureFetch(
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
      state.conversation = conversationPayload.conversation;
      await refreshConversationMessages({ silent: false });
      await maybeRefreshConversationForAuthSession();
      state.bootstrapped = true;
      state.error = "";
    } catch (error) {
      state.error = error?.message || "Support isn't available right now. Please try again in a moment.";
    } finally {
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

async function sendSupportMessage(rawText, options = {}) {
  const text = String(rawText || "").trim();
  if (!text || state.sending) return;
  if (!isSupportSessionAllowed()) return;

  ensureDrawer();
  await ensureConversationLoaded();
  if (!state.conversation?.id) {
    state.error = "Support isn't available right now. Please try again in a moment.";
    render();
    return;
  }

  const optimisticUser = createOptimisticMessage({ sender: "user", text });
  const optimisticAssistant = createOptimisticMessage({ sender: "assistant", text: "", loading: true });
  const previousDraft = state.textarea?.value || "";

  state.sending = true;
  state.error = "";
  state.failedMessageText = "";
  if (state.textarea) {
    state.textarea.value = "";
  }
  state.messages = [...state.messages, optimisticUser, optimisticAssistant];
  render();

  try {
    const pageContext = getCurrentPageContext();
    const sourcePage = `${pageContext.pathname || ""}${pageContext.search || ""}${pageContext.hash || ""}`;
    const response = await secureFetch(
      `/api/support/conversation/${encodeURIComponent(state.conversation.id)}/messages`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
        body: {
          text,
          sourcePage,
          pageContext,
          promptAction: options?.promptAction || null,
        },
      }
    );
    if (!response.ok) {
      throw new Error("Your message didn't send. Please try again.");
    }

    const payload = await response.json();
    state.conversation = payload.conversation || state.conversation;
    if (payload.assistantMessage?.id) {
      state.dismissedSuggestedReplyIds.delete(payload.assistantMessage.id);
    }
    state.messages = state.messages.filter(
      (message) => message.id !== optimisticUser.id && message.id !== optimisticAssistant.id
    );
    state.messages.push(payload.userMessage, payload.assistantMessage);
    if (payload.systemMessage) {
      appendMessageIfMissing(payload.systemMessage);
    }
  } catch (error) {
    state.messages = state.messages.filter(
      (message) => message.id !== optimisticUser.id && message.id !== optimisticAssistant.id
    );
    state.error = error?.message || "Your message didn't send. Please try again.";
    state.failedMessageText = text;
    if (state.textarea && !state.textarea.value.trim()) {
      state.textarea.value = previousDraft || text;
    }
  } finally {
    state.sending = false;
    render();
  }
}

async function sendEscalationRequest(messageId) {
  if (!messageId || state.escalatingMessageId) return;
  await ensureConversationLoaded();
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
    const response = await secureFetch(
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
      throw new Error("Couldn't send this to the team right now. Please try again.");
    }

    const payload = await response.json();
    state.conversation = payload.conversation || state.conversation;
    replaceMessageInState(payload.assistantMessage || null);
    appendMessageIfMissing(payload.systemMessage || null);
  } catch (error) {
    state.error = error?.message || "Couldn't send this to the team right now. Please try again.";
  } finally {
    state.escalatingMessageId = "";
    render();
  }
}

async function restartSupportConversation() {
  if (state.restartingConversation || state.sending || state.loadingConversation) return;
  await ensureConversationLoaded();
  if (!state.conversation?.id) {
    state.error = "Support isn't available right now. Please try again in a moment.";
    render();
    return;
  }

  state.restartingConversation = true;
  state.error = "";
  stopLiveUpdates();
  const restartingConversationId = state.conversation.id;
  state.messages = [];
  state.dismissedSuggestedReplyIds.clear();
  render();

  try {
    await performSupportConversationRestart(restartingConversationId);
  } catch (error) {
    state.error = error?.message || "Couldn't start a new conversation right now. Please try again.";
  } finally {
    state.restartingConversation = false;
    render();
    if (state.textarea) {
      state.textarea.focus();
    }
  }
}

async function performSupportConversationRestart(conversationId) {
  const pageContext = getCurrentPageContext();
  const sourcePage = `${pageContext.pathname || ""}${pageContext.search || ""}${pageContext.hash || ""}`;
  const response = await secureFetch(
    `/api/support/conversation/${encodeURIComponent(conversationId)}/restart`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
      body: {
        sourcePage,
        pageContext,
      },
    }
  );
  if (!response.ok) {
    throw new Error("Couldn't start a new conversation right now. Please try again.");
  }

  const payload = await response.json();
  state.conversation = payload.conversation || null;
  state.messages = Array.isArray(payload.messages) ? payload.messages : [];
  state.dismissedSuggestedReplyIds.clear();
  state.bootstrapped = true;
  state.error = "";
  syncLiveUpdates();
  writeSupportSessionMarker(getSupportSessionUserId());
  if (state.textarea) {
    state.textarea.value = "";
  }
  return payload;
}

async function maybeRefreshConversationForAuthSession() {
  const currentUserId = getSupportSessionUserId();
  if (!currentUserId) return;
  if (readSupportSessionMarker() === currentUserId) return;
  const hasUserHistory = state.messages.some((message) => message?.sender === "user");
  if (!state.conversation?.id || !hasUserHistory) {
    writeSupportSessionMarker(currentUserId);
    return;
  }
  await performSupportConversationRestart(state.conversation.id);
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
  state.pinButton?.setAttribute("aria-pressed", isPinned ? "true" : "false");
  state.pinButton?.setAttribute("aria-label", isPinned ? "Unpin assistant" : "Pin assistant while you browse");
  if (state.pinButton) state.pinButton.title = isPinned ? "Unpin assistant" : "Pin assistant";
}

function setSupportDrawerPinned(pinned = false) {
  if (pinned && !canPinSupportDrawer()) return;
  state.pinned = Boolean(pinned);
  persistPinnedSupportDrawer(state.pinned);
  if (state.pinned) closeSupportMenu();
  syncPinnedSupportDrawer();
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
  syncPinnedSupportDrawer();
  syncLauncherState();
  if (restoreFocus && state.lastFocusedLauncher?.focus) {
    state.lastFocusedLauncher.focus();
  }
}

export async function openSupportDrawer({ launcher = null, focusComposer = true } = {}) {
  if (!isSupportSessionAllowed()) return;
  if (!state.open) state.pinned = readPinnedSupportDrawer() && canPinSupportDrawer();
  ensureDrawer();
  ensureSidebarCollapseTab();
  if (!state.drawer) return;
  await ensureStylesheet();
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
  syncPinnedSupportDrawer();
  render();
  await ensureConversationLoaded();
  syncLiveUpdates();
  syncComposerPrompt();
  if (focusComposer && state.textarea) {
    state.textarea.focus();
  }
}

function createLauncher() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "notification-icon support-launcher";
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
  window.addEventListener("resize", syncSidebarCollapseTab);
}
