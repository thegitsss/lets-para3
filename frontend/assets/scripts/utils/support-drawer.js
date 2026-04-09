import { getStoredSession, secureFetch } from "../auth.js";
import { buildSupportInlineSegments, isSafeSupportHref } from "./support-message-links.mjs";
import { startStripeOnboarding } from "./stripe-connect.js";

const SUPPORT_STYLESHEET_ID = "lpc-support-drawer-styles";
const SUPPORT_STYLESHEET_HREF = "/assets/styles/support-drawer.css";
const SUPPORT_DRAWER_ID = "supportDrawer";
const SUPPORT_THREAD_ID = "supportThread";
const SUPPORT_CONTEXT_STORAGE_KEY = "lpc-support-context";
const SUPPORT_SESSION_USER_KEY = "lpc_support_session_user";
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
  if (normalizedRole === "attorney") {
    return "Ask a question or describe what's happening. You'll get help right here.";
  }
  if (normalizedRole === "paralegal") {
    return "Ask a question or describe what's happening. You'll get help right here.";
  }
  if (normalizedRole === "admin") {
    return "Ask a question or describe what's happening. You'll get help right here.";
  }
  return "Ask a question or describe what's happening. You'll get help right here.";
}

const state = {
  open: false,
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
  composerPrompt: null,
  composerPromptText: null,
  composerPromptIndex: 0,
  composerPromptTimer: null,
  composerPromptTransitionTimer: null,
  escalatingMessageId: "",
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
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m21 3-8.5 18-2.2-6.3L3 12.5 21 3Z"></path>
      <path d="M10.3 14.7 21 3"></path>
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
        <h2 class="support-drawer-title" id="supportDrawerTitle">Support</h2>
        <p class="support-drawer-subtitle" data-support-subtitle></p>
      </div>
      <div class="support-drawer-actions">
        <div class="support-drawer-menu" data-support-menu>
          <button
            class="support-drawer-menu-trigger"
            type="button"
            data-support-menu-trigger
            aria-label="Open support options"
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
        <button class="support-drawer-close" type="button" data-support-close aria-label="Close support">
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
        <textarea id="supportComposerInput" data-support-textarea rows="1" aria-label="Describe your issue"></textarea>
        <button class="support-send" type="submit" data-support-submit aria-label="Send message">
          ${buildSendIcon()}
        </button>
      </div>
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

function appendMessageBubbleContent(bubble, message = {}) {
  const segments = buildSupportInlineSegments(message.text || "", message.metadata?.navigation || null);
  if (!segments.length) {
    bubble.textContent = "";
    return;
  }
  const fragment = document.createDocumentFragment();
  segments.forEach((segment) => {
    if (!segment?.text) return;
    if (segment.type === "link") {
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

function createMessageActions(message = {}) {
  if (message.loading || getMessageVariant(message) !== "assistant") return null;
  const actions = Array.isArray(message.metadata?.actions) ? message.metadata.actions.filter(Boolean) : [];
  if (!actions.length) return null;

  const bar = document.createElement("div");
  bar.className = "support-message-actions";
  actions.slice(0, 2).forEach((action) => {
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
  return bar.childElementCount ? bar : null;
}

function createSuggestedReplies(message = {}) {
  if (message.loading || getMessageVariant(message) !== "assistant") return null;
  const latestAssistant = getLatestAssistantMessage();
  if (!latestAssistant?.id || latestAssistant.id !== message.id) return null;
  if (state.dismissedSuggestedReplyIds.has(message.id)) return null;
  if (state.sending || state.loadingConversation) return null;
  const replies = Array.isArray(message.metadata?.suggestedReplies)
    ? message.metadata.suggestedReplies.filter(Boolean).slice(0, 3)
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
  const available = escalation?.available === true || message.metadata?.needsEscalation === true;
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
    return null;
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
    .filter((message) => message?.metadata?.kind !== "support_escalation")
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
  if (state.subtitle) {
    state.subtitle.textContent = getDrawerSubtitle(getSupportRole());
  }
  if (!shouldShowQuickPrompts()) return;

  const supportState = state.conversation?.supportState || {};
  if (supportState.welcomePrompt || supportState.proactivePrompt?.text) {
    const copy = document.createElement("div");
    copy.className = "support-proactive-copy";
    copy.textContent = [supportState.welcomePrompt, supportState.proactivePrompt?.text].filter(Boolean).join(" ");
    if (copy.textContent) {
      state.prompts.appendChild(copy);
    }
    if (supportState.proactivePrompt?.message) {
      const proactiveButton = document.createElement("button");
      proactiveButton.type = "button";
      proactiveButton.className = "support-quick-prompt support-quick-prompt--primary";
      proactiveButton.textContent = supportState.proactivePrompt.actionText || "Get help";
      proactiveButton.addEventListener("click", async () => {
        await sendSupportMessage(supportState.proactivePrompt.message, {
          promptAction: supportState.proactivePrompt,
        });
      });
      state.prompts.appendChild(proactiveButton);
    }
  }

  getRoleAwareQuickPrompts(getSupportRole()).forEach((promptText) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "support-quick-prompt";
    button.textContent = promptText;
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
  state.status.textContent = state.error;
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

export function closeSupportDrawer({ restoreFocus = true } = {}) {
  if (!state.open) return;
  state.open = false;
  stopLiveUpdates();
  stopComposerPromptRotation();
  closeSupportMenu();
  document.documentElement.classList.remove("support-drawer-open");
  document.body.classList.remove("support-drawer-open");
  state.drawer?.setAttribute("aria-hidden", "true");
  syncLauncherState();
  if (restoreFocus && state.lastFocusedLauncher?.focus) {
    state.lastFocusedLauncher.focus();
  }
}

export async function openSupportDrawer({ launcher = null } = {}) {
  if (!isSupportSessionAllowed()) return;
  ensureDrawer();
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
  render();
  await ensureConversationLoaded();
  syncLiveUpdates();
  syncComposerPrompt();
  if (state.textarea) {
    state.textarea.focus();
  }
}

function createLauncher() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "notification-icon support-launcher";
  button.setAttribute("aria-label", "Open support");
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
  document.querySelectorAll("[data-notification-center]").forEach((root) => {
    if (!(root instanceof HTMLElement)) return;
    if (root.dataset.boundSupportLauncher === "true") return;
    root.dataset.boundSupportLauncher = "true";
    insertLauncher(root);
  });
  syncLauncherState();
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
}
