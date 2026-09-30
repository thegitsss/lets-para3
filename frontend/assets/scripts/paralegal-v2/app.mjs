import { createApiClient, LpcApiError } from "./api-client.mjs";
import { createWorkspaceReleaseController } from "../utils/workspace-release.mjs";
import { clearSession, logout, persistSession, publishLifecycleRefresh } from "../auth.js";
import { confirmAction } from "../utils/dialogs.js";
import {
  destinationForSessionState,
  paralegalV2LoginDestination,
  projectSessionIdentity,
  projectProfileIdentity,
  verifyParalegalSession,
} from "./session-boundary.mjs";
import { createRouter } from "./router.mjs";
import { createNavigation } from "./navigation.mjs";
import { createPayoutsView } from "./payouts-view.mjs";
import { createHomeView } from "./home-view.mjs";
import { createBrowseView } from "./browse-view.mjs";
import { createWorkView } from "./work-view.mjs";
import { createSettingsView } from "./settings-view.mjs?v=20260909-form-rebuild-final";
import { createHelpView } from "./help-view.mjs";
import { createConversationsView } from "./conversations-view.mjs";
import { createMatterView } from "./matter-view.mjs";
import { createAttorneyProfileView } from "./attorney-profile-view.mjs";
import { createOnboardingController } from "./onboarding-controller.mjs";
import { createSearchController } from "./search-controller.mjs";
import { hasOpenSearchBlockingDialog } from "../utils/workspace-search.mjs";
import { readClosureProof, storeClosureProof, clearClosureProof } from "../utils/account-closure-state.mjs";
import { createNotificationsController } from "./notifications-controller.mjs";
import { createMatterDiscoveryController } from "./matter-discovery-controller.mjs";
import { adaptLegacyDestination, navigateToDestination } from "./deep-links.mjs";
import {
  closeSupportDrawer,
  clearSupportIdentity,
  configureSupportSession,
  notifySupportRouteChanged,
  openSupportDrawer,
  registerSupportLauncher,
} from "../utils/support-drawer.js";

const outlet = document.querySelector("[data-v2-route-outlet]");
// First-paint storage is a presentation hint. Only this document's successful
// session verification may establish the owner used by protected controllers.
let verifiedIdentity = null;
let sessionCheckPromise = null;
let sessionCheckController = null;
let leavingProtectedShell = false;
let closureContinuation = readClosureProof();
let router;
let routeRefreshTimer = null;
let deferredRouteRefresh = null;
let searchController = null;
let emptyScrollFeedbackTimer = null;
let onboardingController = null;
let matterDiscoveryController = null;
let renderedAppearance = "";
let navigationController = null;
let historyProtected = false;
let historyGeneration = 0;
let historyRestorePromise = null;
let historyGate = null;
const v2MutationSourceId = `paralegal-v2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function identityKey(identity) {
  return String(identity?.id || identity?._id || identity?.email || "").trim().toLowerCase();
}

function hasUnfinishedWork() {
  return Boolean(
    conversationsView?.hasDrafts?.()
    || browseView?.hasDrafts?.()
    || workView?.hasDrafts?.()
    || matterView?.hasDrafts?.()
    || settingsView?.hasUnsavedChanges?.()
    || helpView?.hasDrafts?.()
  );
}

function captureClosure() {
  const pending = settingsView?.getPendingClosure?.();
  if (pending?.pending && pending.ownerId === identityKey(verifiedIdentity) && typeof pending.proof === "string") closureContinuation = pending.proof;
  return closureContinuation;
}

function restoreClosure() {
  if (!closureContinuation) return;
  try { storeClosureProof(closureContinuation); } catch { /* The result page stays unavailable if tab storage fails. */ }
}

function discardClosure() {
  closureContinuation = null;
  settingsView?.discardClosure?.();
  clearClosureProof();
}

function concealClosureWorkspace() {
  router?.stop();
  document.body.dataset.v2Closure = "pending";
  document.body.inert = true;
  outlet.replaceChildren();
  closeSupportDrawer({ restoreFocus: false });
}

function clearSensitiveDrafts() {
  releaseControl.stop();
  navigationController?.close();
  captureClosure();
  homeView?.clearProtected?.();
  payoutsView?.clearProtected?.();
  clearSupportIdentity();
  // Let workspace controllers normalize or cancel in-flight work first, then
  // erase their retained drafts so an abort callback cannot repopulate data
  // after logout, account replacement, or authorization loss.
  conversationsView?.leave?.();
  conversationsView?.clearDrafts?.();
  matterView?.leave?.();
  browseView?.clearDrafts?.();
  workView?.clearDrafts?.();
  matterView?.clearDrafts?.();
  settingsView?.clearDrafts?.();
  helpView?.clearDrafts?.();
  restoreClosure();
}

function leaveForExpiredSession() {
  if (leavingProtectedShell) return;
  captureClosure();
  leavingProtectedShell = true;
  sessionCheckController?.abort();
  notificationsController?.stop?.();
  matterDiscoveryController?.stop?.();
  clearSensitiveDrafts();
  clearSession();
  restoreClosure();
  if (closureContinuation) concealClosureWorkspace();
  location.replace(closureContinuation ? "/account-closure.html" : paralegalV2LoginDestination(location.hash));
}

function isProjectionMutation(url) {
  const pathname = String(url || "").split("?", 1)[0];
  if (pathname === "/api/notifications/workspace-presence") return false;
  if (/^\/api\/messages\/[^/]+\/read$/.test(pathname)) return false;
  if (/^\/api\/notifications(?:\/|$)/.test(pathname)) return false;
  if (/^\/api\/support(?:\/|$)/.test(pathname)) return false;
  return true;
}

const releaseControl = createWorkspaceReleaseController({ outlet, baselineAllowed: identity => identity.role === 'paralegal' && identity.status === 'approved' && !identity.disabled && !identity.deleted, hasUnfinishedWork, onAccessLost: leaveForExpiredSession });
const api = createApiClient({
  fetchImpl: releaseControl.fetch,
  onAuthenticationLost: leaveForExpiredSession,
  onMutationCommitted({ url, method }) {
    // Read acknowledgements, notification-center housekeeping, Assistant
    // conversation writes, and presence heartbeats already have narrower
    // synchronization authorities. Treating them as Matter lifecycle changes
    // can create refresh loops (for example, render -> mark read -> rerender).
    if (!isProjectionMutation(url)) return;
    publishLifecycleRefresh({ url, method, sourceId: v2MutationSourceId });
  },
});

const VIEW_COPY = Object.freeze({
  home: Object.freeze({ eyebrow: "Paralegal workspace", title: "Home", copy: "Your work and next steps, together." }),
  browse: Object.freeze({ eyebrow: "Open opportunities", title: "Browse Matters", copy: "Explore available matters and review the details before applying." }),
  work: Object.freeze({ eyebrow: "Your work", title: "Matters", copy: "Manage your matters, invitations, and applications." }),
  settings: Object.freeze({ eyebrow: "Your account", title: "Profile Settings", copy: "Manage your profile and account settings." }),
  help: Object.freeze({ eyebrow: "Support", title: "Help", copy: "Find answers or contact LPC for help." }),
  profile: Object.freeze({ eyebrow: "Profile", title: "Profile preview", copy: "See how your profile looks to attorneys." }),
  matter: Object.freeze({ eyebrow: "Matter workspace", title: "Matter workspace", copy: "Manage your work in one place." }),
});

function element(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (name === "className") node.className = value;
    else if (name === "text") node.textContent = value;
    else node.setAttribute(name, value);
  });
  children.forEach((child) => node.append(child));
  return node;
}

function renderFoundationView(route) {
  const content = VIEW_COPY[route.name];
  if (!content) return renderNotFound(route);

  const headingId = `v2-${route.name}-title`;
  const section = element("section", { className: "v2-route-state", "aria-labelledby": headingId }, [
    element("p", { className: "v2-eyebrow", text: content.eyebrow }),
    element("h1", { id: headingId, text: content.title }),
    element("p", { text: content.copy }),
  ]);

  section.append(element("div", { className: "v2-foundation-panel", "aria-label": "Workspace guide" }, [
    element("div", { className: "v2-foundation-item" }, [
      element("strong", { text: "Your Private Office" }),
      element("span", { text: "Use navigation to move between your work and account settings." }),
    ]),
    element("div", { className: "v2-foundation-item" }, [
      element("strong", { text: "Your profile" }),
      element("span", { text: "Keep your experience and availability up to date." }),
    ]),
    element("div", { className: "v2-foundation-item" }, [
      element("strong", { text: "Need help?" }),
      element("span", { text: "Open Help or ask LPC Assistant." }),
    ]),
  ]));
  return section;
}

function renderNotFound(route) {
  const title = route.name === "route-error" ? "This view could not open" : "Page not found";
  const copy = route.name === "route-error"
    ? "Please try again or return Home."
    : "We couldn’t find this page. Use navigation to continue.";
  return element("section", { className: "v2-route-state", "aria-labelledby": "v2-route-status-title" }, [
    element("p", { className: "v2-eyebrow", text: "LPC workspace" }),
    element("h1", { id: "v2-route-status-title", text: title }),
    element("p", { text: copy }),
  ]);
}

async function renderRoute(route, navigation) {
  if (!navigation.isCurrent()) return;
  if (captureClosure()) { leaveForExpiredSession(); return; }
  conversationsView.leave();
  if (route.name !== "payouts") payoutsView.leave();
  if (route.name !== "matter") matterView.leave();
  if (route.name !== "attorney") attorneyProfileView.leave();
  if (route.name !== "help") helpView.leave();
  if (route.name !== "settings") settingsView.leave?.();
  document.querySelectorAll("dialog[data-v2-route-dialog][open]").forEach((dialog) => dialog.close());
  outlet.setAttribute("aria-busy", "true");
  const destination = route.name === "matter" || route.name === "work" || route.name === "home" && (!["overview", "pulse", "inbox"].includes(route.query.get("view") || "overview") || route.query.has("item")) ? "work" : route.name === "profile" ? "settings" : route.name;
  document.querySelectorAll("[data-v2-navigation-context]").forEach(group => { group.hidden = group.dataset.v2NavigationContext !== destination; });
  const workSection = route.query.get("section") || ([...route.query.keys()].some(key => key.startsWith("app") || key === "jobId") ? "applications" : "active");
  document.querySelectorAll("[data-v2-more-matter-views]").forEach(group => { if (route.name === "home" && ["work", "matters", "document"].includes(route.query.get("view"))) group.open = true; });
  document.querySelectorAll("[data-v2-route]").forEach((link) => {
    const homeViewName = link.dataset.desktopHomeView;
    const current = link.dataset.workSection !== undefined
      ? route.name === "work" && workSection === link.dataset.workSection
      : homeViewName !== undefined
      ? route.name === "home" && (route.query.get("view") || "overview") === homeViewName
      : link.dataset.v2Route === (link.closest(".v2-desktop-primary") ? destination : route.name) && !(route.name === "work" && route.query.get("section") === "history" && !link.closest(".v2-desktop-primary"));
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  let view;
  if (route.name === "home") {
    view = await homeView.render({
      route,
      isCurrent: navigation.isCurrent,
      onRetry() {
        homeView.invalidate();
        void router.refresh();
      },
    });
  } else if (route.name === "payouts") {
    view = payoutsView.render({ isCurrent: navigation.isCurrent });
  } else if (route.name === "conversations") {
    view = conversationsView.render({route});
  } else if (route.name === "browse") {
    view = await browseView.render({
      route,
      isCurrent: navigation.isCurrent,
      onRetry() {
        browseView.invalidate();
        void router.refresh();
      },
    });
  } else if (route.name === "work") {
    view = await workView.render({
      route,
      isCurrent: navigation.isCurrent,
      onRetry() {
        workView.invalidate();
        void router.refresh();
      },
    });
  } else if (route.name === "settings") {
    view = await settingsView.render({ route, isCurrent: navigation.isCurrent });
  } else if (route.name === "help") {
    view = helpView.render({ route, isCurrent: navigation.isCurrent });
  } else if (route.name === "matter") {
    view = await matterView.render({
      route,
      isCurrent: navigation.isCurrent,
      onRetry() {
        void router.refresh();
      },
    });
  } else if (route.name === "profile" && ["me", String(verifiedIdentity?.id || verifiedIdentity?._id || "")].includes(route.params.profileId)) {
    view = await settingsView.renderPreview({ isCurrent: navigation.isCurrent });
  } else if (route.name === "attorney") {
    view = await attorneyProfileView.render({ route, isCurrent: navigation.isCurrent });
  } else {
    view = renderFoundationView(route);
  }

  if (!navigation.isCurrent() || !view) return;
  // A workspace-release notice may share the outlet with the retained view.
  // Detaching that view to remove its sibling would discard keyboard focus.
  const alreadyMounted = view.parentElement === outlet;
  view.dataset.v2RenderedRoute = route.name;
  if (!alreadyMounted) {
    if (!navigation.isInitial && navigation.isPrimaryRouteChange) {
      view.classList.add("v2-route-arriving");
      view.addEventListener("animationend", () => view.classList.remove("v2-route-arriving"), { once: true });
    }
    outlet.replaceChildren(view);
  }
  // The router restores this synchronously again after render resolves. Setting it
  // here guarantees the replacement and its correct offset share one paint.
  outlet.scrollTop = navigation.restoredScrollTop || 0;
  if (route.name === "settings") settingsView.afterMount(route);
  if (route.name === "matter") matterView.afterMount(view);
  if (!navigation.isCurrent()) return;
  outlet.removeAttribute("aria-busy");
}

function setIdentity(identity, { applyAppearance = true } = {}) {
  const projected = projectSessionIdentity(identity);
  if (!projected) return null;
  const previousIdentity = identityKey(verifiedIdentity);
  const nextIdentity = identityKey(projected);
  if (previousIdentity && nextIdentity && (previousIdentity !== nextIdentity || verifiedIdentity?.role !== projected.role)) {
    discardClosure();
    clearSensitiveDrafts();
    homeView.invalidate();
    browseView.invalidate();
    workView?.invalidate();
    settingsView.invalidate();
    matterView.leave();
    attorneyProfileView.leave();
  }
  verifiedIdentity = projected;
  if (applyAppearance) {
    const appearance = `${nextIdentity}:${projected.preferences.theme}:${projected.preferences.fontSize}`;
    // Repeated reads of the same saved preferences must not undo a selection
    // that Settings is still saving. Apply each verified change once.
    if (appearance !== renderedAppearance) {
      const root = document.documentElement;
      root.classList.toggle("theme-light", projected.preferences.theme === "light");
      root.classList.toggle("theme-dark", projected.preferences.theme === "dark");
      root.style.fontSize = ({ xs: "15px", sm: "16px", md: "17px", lg: "20px", xl: "22px" })[projected.preferences.fontSize];
      renderedAppearance = appearance;
    }
  }
  searchController?.scopeToIdentity(projected);
  const name = projected.name || [projected.firstName, projected.lastName].filter(Boolean).join(" ") || "Member";
  const nameNode = document.querySelector("[data-v2-profile-name]");
  if (nameNode) nameNode.textContent = name;
  const avatar = document.querySelector("[data-v2-profile-avatar]");
  const url = String(projected.avatarURL || projected.profileImage || "");
  if (avatar) {
    if (!avatar.dataset.fallbackBound) {
      avatar.dataset.fallbackBound = "true";
      avatar.addEventListener("error", () => {
        if (!avatar.src.endsWith("/assets/avatar-placeholder.svg")) avatar.src = "/assets/avatar-placeholder.svg";
      });
    }
    avatar.src = /^(?:\/api\/|assets\/|\/assets\/)/.test(url) ? url : "/assets/avatar-placeholder.svg";
  }
  return projected;
}

let workView;
const homeView = createHomeView({
  api,
  onSessionLost: leaveForExpiredSession,
  showToast,
  updateIdentity: setIdentity,
  getIdentity: () => verifiedIdentity,
  requestRefresh: () => scheduleRouteRefresh(["home"], { delay: 0 }),
  renderWorkContext: options => workView.renderContext(options),
  markNotificationRead: item => notificationsController.readInContext(item),
});

const payoutsView = createPayoutsView({ api, getIdentity: () => verifiedIdentity, onSessionLost: leaveForExpiredSession });

const browseView = createBrowseView({
  api,
  showToast,
  invalidateHome: () => homeView.invalidate(),
  invalidateWork: () => workView?.invalidate(),
});

workView = createWorkView({
  api,
  getIdentity: () => verifiedIdentity,
  showToast,
  invalidateHome: () => homeView.invalidate(),
  invalidateBrowse: () => browseView.invalidate(),
  onReplayTour(trigger) {
    onboardingController?.replay(trigger);
  },
});

const settingsView = createSettingsView({
  api,
  onSessionLost: leaveForExpiredSession,
  onClosurePending: leaveForExpiredSession,
  getIdentity: () => verifiedIdentity,
  showToast,
  onReplayTour(trigger) {
    onboardingController?.replay(trigger);
  },
  updateIdentity(user) {
    const profileIdentity = projectProfileIdentity(user, verifiedIdentity);
    if (!profileIdentity) return;
    const identity = setIdentity(profileIdentity);
    if (identity) persistSession({ user: identity });
  },
  invalidateHome: () => homeView.invalidate(),
  invalidateBrowse: () => browseView.invalidate(),
  invalidateWork: () => workView?.invalidate(),
});

function supportNavigationReady() {
  return !leavingProtectedShell && !captureClosure()
    && document.body.dataset.v2Session === "ready"
    && verifiedIdentity?.role === "paralegal" && verifiedIdentity.status === "approved"
    && !verifiedIdentity.disabled && !verifiedIdentity.deleted;
}

configureSupportSession({
  onSessionLost: leaveForExpiredSession,
  navigationAdapter: {
    resolve: href => supportNavigationReady() ? adaptLegacyDestination(href) : null,
    navigate: destination => supportNavigationReady() && destination?.internal
      ? navigateToDestination(destination) : false,
  },
});

const helpView = createHelpView({
  api,
  getIdentity: () => verifiedIdentity,
  onSessionLost: () => leaveForExpiredSession(),
  openAssistant(options) {
    return openSupportDrawer(options);
  },
});

const attorneyProfileView = createAttorneyProfileView({
  api,
  onSessionLost() {
    leaveForExpiredSession();
  },
});

const conversationsView = createConversationsView({api, getIdentity:()=>verifiedIdentity, onSessionLost:leaveForExpiredSession, onChanged:()=>homeView.invalidate()});

const matterView = createMatterView({
  api,
  getIdentity: () => verifiedIdentity,
  showToast,
  onSessionLost() {
    leaveForExpiredSession();
  },
  onAccessLost() {
    homeView.invalidate();
    workView.invalidate();
  },
  onMessagesChanged() {
    homeView.invalidate();
    window.dispatchEvent(new CustomEvent("lpc:notifications-refreshed"));
  },
  onFilesChanged() {
    homeView.invalidate();
    window.dispatchEvent(new CustomEvent("lpc:notifications-refreshed"));
  },
  onDeadlinesChanged() {
    homeView.invalidate();
  },
  onMatterChanged() {
    homeView.invalidate();
    workView.invalidate();
    scheduleRouteRefresh(["matter"], { delay: 100 });
  },
  onMatterWithdrawn() {
    homeView.invalidate();
    workView.invalidate();
    browseView.invalidate();
    window.dispatchEvent(new CustomEvent("lpc:notifications-refreshed"));
  },
});

searchController = createSearchController({
  api,
  panel: document.querySelector("[data-v2-search-panel]"),
  input: document.querySelector("[data-v2-search-input]"),
  results: document.querySelector("[data-v2-search-results]"),
  getIdentity: () => verifiedIdentity,
  onSessionLost: leaveForExpiredSession,
});

const NON_DISCOVERY_SIGNAL_PREFIXES = Object.freeze([
  "message_",
  "case_file_",
  "calendar_event_",
  "matter_documents_",
  "matter_meeting_",
  "matter_dispute_comment_",
]);

const WORK_SIGNAL_PREFIXES = Object.freeze([
  "application_",
  "notification_record_",
  "case_invite",
  "case_work_",
  "case_awaiting_",
  "case_update_",
  "case_budget_",
  "pre_engagement_",
  "matter_",
  "payout_",
  "dispute_",
  "account_participation_",
  "dashboard_views_",
]);

const SETTINGS_SIGNAL_PATTERN = /^(?:profile(?:_record)?|availability|account_preferences|notification_preferences|account_security|session_revoked|payout_readiness)_refresh$/i;

function signalAffectsDiscovery(type) {
  const value = String(type || "").trim().toLowerCase();
  if (!value) return true;
  return !NON_DISCOVERY_SIGNAL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function signalAffectsWork(type) {
  const value = String(type || "").trim().toLowerCase();
  if (!value) return true;
  return WORK_SIGNAL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function openRouteDialogs() {
  return [...document.querySelectorAll("dialog[data-v2-route-dialog][open]")];
}

function scheduleRouteRefresh(routeNames, { delay = 180, protectInteraction = true } = {}) {
  const names = new Set(Array.isArray(routeNames) ? routeNames.filter(Boolean) : []);
  if (!names.size) return;
  const current = router?.getCurrentRoute?.();
  if (!current || !names.has(current.name)) return;
  const request = {
    routeKey: current.key,
    routeNames: names,
    protectInteraction,
  };
  if (deferredRouteRefresh?.routeKey === request.routeKey) {
    deferredRouteRefresh.routeNames.forEach((name) => request.routeNames.add(name));
    // Any access-changing request must bypass an older interaction deferral.
    request.protectInteraction = deferredRouteRefresh.protectInteraction && protectInteraction;
  }
  deferredRouteRefresh = request;
  window.clearTimeout(routeRefreshTimer);
  routeRefreshTimer = window.setTimeout(attemptRouteRefresh, delay);
}

function attemptRouteRefresh() {
  routeRefreshTimer = null;
  const request = deferredRouteRefresh;
  if (!request) return;
  const current = router?.getCurrentRoute?.();
  if (!current || current.key !== request.routeKey || !request.routeNames.has(current.name)) {
    deferredRouteRefresh = null;
    return;
  }
  const dialogs = request.protectInteraction ? openRouteDialogs() : [];
  if (dialogs.length) {
    dialogs.forEach((dialog) => {
      if (dialog.dataset.v2RefreshWaitBound === "true") return;
      dialog.dataset.v2RefreshWaitBound = "true";
      dialog.addEventListener("close", () => {
        delete dialog.dataset.v2RefreshWaitBound;
        window.clearTimeout(routeRefreshTimer);
        routeRefreshTimer = window.setTimeout(attemptRouteRefresh, 0);
      }, { once: true });
    });
    return;
  }
  if (request.protectInteraction && current.name === "home" && homeView.hasInteraction()) {
    homeView.deferRefresh();
    routeRefreshTimer = window.setTimeout(attemptRouteRefresh, 500);
    return;
  }
  if (request.protectInteraction && (current.name === "work" && workView.hasPendingDownload() || current.name === "matter" && matterView.hasPendingDownload())) {
    routeRefreshTimer = window.setTimeout(attemptRouteRefresh, 500);
    return;
  }
  if (current.name === "work") workView.flushDeferredRefresh();
  deferredRouteRefresh = null;
  void router.refresh();
}

function reconcileGlobalData({ reason, signalTypes = [] } = {}) {
  const types = Array.isArray(signalTypes) ? signalTypes.filter(Boolean) : [];
  const refreshAll = types.length === 0;
  const affectsDiscovery = refreshAll || types.some(signalAffectsDiscovery);
  const affectsWork = refreshAll || types.some(signalAffectsWork);
  const requiresAuthorizationCheck = types.some((type) => [
    "authorization_refresh",
    "account_suspended_refresh",
    "account_deactivated_refresh",
  ].includes(String(type || "").toLowerCase()));
  // Initial notification hydration and read-state housekeeping do not invalidate
  // Home's independent progressive projection. External signals still do.
  if (reason === "external" || types.length) homeView.invalidate();
  if (affectsWork) workView.invalidate({ preserveDownloads: !requiresAuthorizationCheck });
  if (affectsDiscovery) browseView.invalidate();
  if (types.length) {
    window.dispatchEvent(new CustomEvent("lpc:v2-authoritative-refresh", {
      detail: { signalTypes: types },
    }));
  }
  if (types.some((type) => ["onboarding_refresh", "profile_refresh", "payout_readiness_refresh"].includes(type))) {
    void onboardingController?.start(verifiedIdentity, { force: true });
  }
  if (requiresAuthorizationCheck) {
    homeView.clearProtected();
    payoutsView.clearProtected();
    void establishSession().then((ready) => {
      if (ready && router?.getCurrentRoute?.()) scheduleRouteRefresh(["home", "payouts", "browse", "work", "settings", "help", "profile", "attorney", "matter"], { delay: 0, protectInteraction: false });
    });
    return;
  }
  if (reason !== "external") return;
  const current = router?.getCurrentRoute?.();
  const settingsSignal = types.some((type) => SETTINGS_SIGNAL_PATTERN.test(String(type || "")));
  const refreshBackgroundSettings = current?.name === "settings"
    && settingsSignal
    && settingsView.invalidate();
  const routes = [
    "home",
    "payouts",
    affectsWork ? "work" : "",
    affectsDiscovery ? "browse" : "",
    refreshBackgroundSettings ? "settings" : "",
  ];
  scheduleRouteRefresh(routes);
}

function invalidateAuthoritativeViews({ includeSettings = true, preserveDownloads = false } = {}) {
  homeView.invalidate();
  browseView.invalidate();
  workView.invalidate({ preserveDownloads });
  return includeSettings ? settingsView.invalidate() : false;
}

function reauthorizeAndRefresh({ protectInteraction = true } = {}) {
  if (historyProtected) return restoreHistoryWorkspace();
  const settingsCanRefresh = invalidateAuthoritativeViews({ preserveDownloads: protectInteraction });
  return establishSession().then(async (ready) => {
    if (!ready) return ready;
    // A sibling tab may replace the initial verification before routing starts.
    // The replacement verification must finish that startup, not only refresh
    // an already committed route.
    if (!router?.getCurrentRoute?.()) {
      await startVerifiedRoutes();
      return ready;
    }
    scheduleRouteRefresh([
      "home",
      "payouts",
      "browse",
      "work",
      settingsCanRefresh ? "settings" : "",
      "help",
      "profile",
      "attorney",
      "matter",
    ], { delay: 0, protectInteraction });
    return ready;
  });
}

function protectHistoryWorkspace() {
  historyProtected = true;
  historyGeneration += 1;
  historyRestorePromise = null;
  document.body.dataset.v2History = "checking";
  document.body.dataset.v2Session = "checking";
  sessionCheckController?.abort();
  sessionCheckController = null;
  sessionCheckPromise = null;
  window.clearTimeout(routeRefreshTimer);
  deferredRouteRefresh = null;
  router?.stop();
  notificationsController.stop();
  matterDiscoveryController?.stop();
  onboardingController?.stop();
  searchController?.close();
  closeSupportDrawer({ restoreFocus: false });
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  historyGate ||= element("section", { className: "v2-route-state v2-history-gate", "data-v2-history-gate": "", "aria-live": "polite" });
  historyGate.replaceChildren(element("p", { text: "Checking your session…" }));
  if (!historyGate.isConnected) document.body.append(historyGate);
}

function restoreHistoryWorkspace() {
  if (historyRestorePromise) return historyRestorePromise;
  const generation = historyGeneration;
  historyRestorePromise = (async () => {
    try {
      invalidateAuthoritativeViews();
      if (!await establishSession()) throw new Error("Session verification unavailable");
      if (generation !== historyGeneration || leavingProtectedShell) return false;
      await router.start();
      if (generation !== historyGeneration || leavingProtectedShell) return false;
      // The cached document stays concealed until both identity and the current
      // route have been checked. A replaced account cannot reveal the old view.
      historyProtected = false;
      delete document.body.dataset.v2History;
      historyGate?.remove();
      await onboardingController.start(verifiedIdentity);
      return true;
    } catch {
      if (generation !== historyGeneration || leavingProtectedShell) return false;
      document.body.dataset.v2Session = "unavailable";
      const retry = element("button", { type: "button", className: "v2-settings-secondary", text: "Try again" });
      retry.addEventListener("click", () => { retry.disabled = true; void restoreHistoryWorkspace(); });
      historyGate.replaceChildren(
        element("h1", { text: "Your account could not be verified" }),
        element("p", { text: "Check your connection and try again." }),
        retry
      );
      return false;
    } finally {
      if (generation === historyGeneration) historyRestorePromise = null;
    }
  })();
  return historyRestorePromise;
}

const notificationsController = createNotificationsController({
  api,
  panel: document.querySelector("[data-v2-notifications-panel]"),
  content: document.querySelector("[data-v2-notifications-content]"),
  actions: document.querySelector("[data-v2-notifications-actions]"),
  badge: document.querySelector("[data-v2-notification-badge]"),
  trigger: document.querySelector("[data-v2-notifications-trigger]"),
  showToast,
  onChange: reconcileGlobalData,
});

matterDiscoveryController = createMatterDiscoveryController({
  api,
  onChange() {
    homeView.invalidate();
    browseView.invalidate();
    workView.invalidate({ preserveDownloads: true });
    scheduleRouteRefresh(["home", "browse", "work"], { delay: 120 });
  },
});

router = createRouter({ scrollElement: outlet, render: renderRoute });

onboardingController = createOnboardingController({
  api,
  dialogHost: document.querySelector("[data-v2-dialog-host]"),
  getIdentity: () => verifiedIdentity,
  updateIdentity(identity) {
    const projected = setIdentity(identity);
    if (projected) persistSession({ user: projected });
  },
  showToast,
  getRoute: () => router?.getCurrentRoute?.(),
});

if (typeof BroadcastChannel === "function") {
  try {
    const deadlineChannel = new BroadcastChannel("lpc-v2-deadlines");
    deadlineChannel.addEventListener("message", () => {
      homeView.invalidate();
      scheduleRouteRefresh(["home"], { delay: 100 });
    });
  } catch {}
  try {
    const fileChannel = new BroadcastChannel("lpc-v2-files");
    fileChannel.addEventListener("message", () => {
      homeView.invalidate();
      scheduleRouteRefresh(["home"], { delay: 100 });
    });
  } catch {}
}

function setExpanded(trigger, expanded) {
  trigger?.setAttribute("aria-expanded", String(Boolean(expanded)));
}

function closeProfileMenu({ restoreFocus = false } = {}) {
  const trigger = document.querySelector("[data-v2-profile-trigger]");
  const menu = document.querySelector("[data-v2-profile-menu]");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  setExpanded(trigger, false);
  if (restoreFocus) trigger.focus();
}

function setupProfileMenu() {
  const trigger = document.querySelector("[data-v2-profile-trigger]");
  const menu = document.querySelector("[data-v2-profile-menu]");
  trigger?.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    setExpanded(trigger, open);
    if (open) menu.querySelector('[role="menuitem"]')?.focus();
  });
}

function setSidebarCollapsed(collapsed) {
  const supported = window.matchMedia("(min-width: 901px)").matches;
  const next = supported && Boolean(collapsed);
  const button = document.querySelector("[data-v2-sidebar-grip]");
  document.body.classList.toggle("v2-sidebar-collapsed", next);
  if (button) {
    const action = next ? "Expand" : "Collapse";
    button.setAttribute("aria-label", `${action} sidebar`);
    button.setAttribute("data-tooltip", `${action} sidebar`);
    button.setAttribute("aria-expanded", String(!next));
    const label = button.querySelector(".v2-sidebar-grip__label");
    if (label) label.textContent = action;
  }
  document.querySelectorAll(".v2-nav-link").forEach((link) => {
    const label = link.querySelector("span:not([aria-hidden])")?.textContent?.trim();
    if (next && label && !link.hasAttribute("data-tooltip")) link.setAttribute("title", label);
    else link.removeAttribute("title");
  });
  const profile = document.querySelector("[data-v2-profile-trigger]");
  if (profile) {
    if (next && !profile.hasAttribute("data-tooltip")) profile.setAttribute("title", "Account");
    else profile.removeAttribute("title");
  }
  if (next) closeProfileMenu();
}

function setupSidebarGrip() {
  const button = document.querySelector("[data-v2-sidebar-grip]");
  if (!button) return;
  button.addEventListener("click", () => {
    setSidebarCollapsed(!document.body.classList.contains("v2-sidebar-collapsed"));
  });
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(min-width: 901px)").matches) setSidebarCollapsed(false);
  });
  setSidebarCollapsed(false);
}

function closePopover(name, { restoreFocus = false } = {}) {
  if (name === "notifications") notificationsController.cancelNavigation();
  const trigger = document.querySelector(`[data-v2-${name}-trigger]`);
  const panel = document.querySelector(`[data-v2-${name}-panel]`);
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  setExpanded(trigger, false);
  if (restoreFocus) trigger?.focus();
}

function openPopover(name) {
  const trigger = document.querySelector(`[data-v2-${name}-trigger]`);
  const panel = document.querySelector(`[data-v2-${name}-panel]`);
  if (!trigger || !panel) return;
  const shouldOpen = panel.hidden;
  if (!shouldOpen && name === "notifications") notificationsController.cancelNavigation();
  searchController.close();
  closeProfileMenu();
  panel.hidden = !shouldOpen;
  setExpanded(trigger, shouldOpen);
  if (shouldOpen && name === "notifications") {
    notificationsController.open();
    panel.querySelector("button, a, [tabindex]")?.focus();
  }
}

function normalizedWheelDelta(event) {
  const delta = Number(event.deltaY) || 0;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * Math.max(1, outlet.clientHeight);
  return delta;
}

function showEmptyScrollFeedback(delta) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const className = delta < 0 ? "v2-view--empty-scroll-back" : "v2-view--empty-scroll-forward";
  if (outlet.classList.contains("v2-view--empty-scroll-back") || outlet.classList.contains("v2-view--empty-scroll-forward")) return;
  outlet.classList.add(className);
  window.clearTimeout(emptyScrollFeedbackTimer);
  emptyScrollFeedbackTimer = window.setTimeout(() => {
    outlet.classList.remove("v2-view--empty-scroll-back", "v2-view--empty-scroll-forward");
  }, 220);
}

function setupSidebarScrollBridge() {
  const sidebar = document.querySelector(".v2-desk-topbar");
  if (!sidebar || !outlet) return;
  sidebar.addEventListener("wheel", (event) => {
    if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    const delta = normalizedWheelDelta(event);
    if (!delta) return;
    event.preventDefault();
    const maximumScroll = Math.max(0, outlet.scrollHeight - outlet.clientHeight);
    if (maximumScroll <= 1) {
      showEmptyScrollFeedback(delta);
      return;
    }
    outlet.scrollTop = Math.max(0, Math.min(maximumScroll, outlet.scrollTop + delta));
  }, { passive: false });
}

function setupShellControls() {
  const updateScrollChrome = () => outlet.toggleAttribute("data-v2-scrolled", outlet.scrollTop > 0);
  outlet.addEventListener("scroll", updateScrollChrome, { passive: true });
  updateScrollChrome();
  navigationController = createNavigation({
    ready: () => !leavingProtectedShell && document.body.dataset.v2Session === "ready" && !document.body.inert,
    beforeOpen: () => { closeProfileMenu(); searchController.close(); closePopover("notifications"); closeSupportDrawer({ restoreFocus: false }); },
  });
  setupProfileMenu();
  setupSidebarGrip();
  setupSidebarScrollBridge();
  document.querySelector("[data-v2-search-form]")?.addEventListener("click", () => searchController.open());
  document.querySelector("[data-v2-notifications-trigger]")?.addEventListener("click", () => openPopover("notifications"));
  document.querySelector("[data-v2-notification-close]")?.addEventListener("click", () => closePopover("notifications", { restoreFocus: true }));
  // establishSession registers the launcher after the initial identity is known.
  // A pre-session global scan removes registered launchers without access.
  document.querySelector("[data-v2-search-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void searchController.runSearch(document.querySelector("[data-v2-search-input]")?.value);
  });
  document.querySelector("[data-v2-sign-out]")?.addEventListener("click", () => {
    closeProfileMenu();
    navigationController?.close();
    void signOut();
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-v2-profile-trigger], [data-v2-profile-menu]")) closeProfileMenu();
    const insideSearch = event.composedPath().some(element => element instanceof Element && element.matches("[data-v2-search-form], [data-v2-search-panel]"));
    if (!insideSearch) searchController.close();
    const insideNotifications = event.composedPath().some(element => element instanceof Element && element.matches("[data-v2-notifications-trigger], [data-v2-notifications-panel], .lpc-dialog"));
    if (!insideNotifications) closePopover("notifications");
  });

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const opensSearch = !event.defaultPrevented
      && !event.repeat
      && !event.altKey
      && !event.shiftKey
      && (event.metaKey || event.ctrlKey)
      && String(event.key).toLowerCase() === "k"
      && (event.target.matches("[data-v2-search-input]") || !event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))
      && !hasOpenSearchBlockingDialog();
    if (opensSearch) {
      event.preventDefault();
      searchController.open();
      return;
    }
    if (event.key !== "Escape") return;
    if (!document.querySelector("[data-v2-profile-menu]").hidden) {
      event.preventDefault();
      closeProfileMenu({ restoreFocus: true });
      return;
    }
    if (!document.querySelector("[data-v2-search-panel]").hidden) {
      event.preventDefault();
      searchController.close();
      document.querySelector("[data-v2-search-input]").focus();
      return;
    }
    closeProfileMenu({ restoreFocus: true });
    searchController.close();
    closePopover("notifications", { restoreFocus: true });
  });

  window.addEventListener("lpc:v2-route-changed", (event) => {
    if (!event.detail?.refresh) {
      closeProfileMenu();
      searchController.close();
      searchController.recordPage();
      closePopover("notifications");
      notifySupportRouteChanged();
      onboardingController?.routeChanged(event.detail);
    }
  });
}

function showToast(message) {
  const region = document.querySelector("[data-v2-toast-region]");
  if (!region) return;
  const toast = element("div", { className: "v2-toast", text: String(message || "") });
  region.replaceChildren(toast);
  window.setTimeout(() => {
    if (toast.isConnected) toast.remove();
  }, 5000);
}

async function signOut() {
  if (captureClosure()) { leaveForExpiredSession(); return; }
  if (hasUnfinishedWork()) {
    const confirmed = await confirmAction(
      "You have unsaved text or files waiting to be sent. Signing out will discard them.",
      { title: "Log out and discard unfinished work?", confirmLabel: "Log out", tone: "danger" }
    );
    if (!confirmed) return;
  }
  notificationsController.stop();
  matterDiscoveryController?.stop();
  onboardingController?.stop();
  closeSupportDrawer({ restoreFocus: false });
  const ended = await logout("");
  if (!ended) return;
  clearSensitiveDrafts();
  location.assign("login.html");
}

async function establishSession() {
  if (captureClosure()) { leaveForExpiredSession(); return false; }
  if (leavingProtectedShell) return false;
  if (sessionCheckPromise) return sessionCheckPromise;
  const controller = new AbortController();
  sessionCheckController = controller;
  sessionCheckPromise = (async () => {
    try {
      const result = await verifyParalegalSession(api, {
        signal: controller.signal,
        persistIdentity: (session) => {
          if (sessionCheckController !== controller) return;
          if (!leavingProtectedShell) persistSession(session);
        },
      });
      if (leavingProtectedShell || sessionCheckController !== controller) return false;
      if (result.state !== "ready") {
        if (result.identity && verifiedIdentity && (identityKey(result.identity) !== identityKey(verifiedIdentity) || result.identity.role !== verifiedIdentity.role)) discardClosure();
        clearSensitiveDrafts();
        if (result.state !== "wrong_role") clearSession();
        location.replace(destinationForSessionState(result, { returnHash: location.hash }));
        return false;
      }
      if (!await releaseControl.start(result.identity)) return false;
      if (leavingProtectedShell || sessionCheckController !== controller) return false;
      setIdentity(result.identity);
      notificationsController.start(result.identity);
      matterDiscoveryController?.start(result.identity);
      registerSupportLauncher(document.querySelector("[data-v2-assistant-trigger]"));
      document.body.dataset.v2Session = "ready";
      document.querySelector('[data-v2-persistent="sidebar"]').inert = false;
      document.querySelector('[data-v2-persistent="header"]').inert = false;
      return true;
    } catch (error) {
      if (leavingProtectedShell || sessionCheckController !== controller || error?.name === "AbortError") return false;
      if (error instanceof LpcApiError && error.kind === "authentication") {
        clearSession();
        location.replace(paralegalV2LoginDestination(location.hash));
        return false;
      }
      document.body.dataset.v2Session = "unavailable";
      if (!verifiedIdentity) {
        const retry = element("button", { type: "button", className: "v2-settings-secondary", text: "Try again" });
        retry.addEventListener("click", () => { retry.disabled = true; void startVerifiedWorkspace(); });
        outlet.replaceChildren(element("section", {
          className: "v2-route-state v2-settings-session-state",
          "aria-labelledby": "v2-session-unavailable-title",
          "data-v2-session-recovery": "",
        }, [
          element("h1", { id: "v2-session-unavailable-title", text: "LPC is temporarily unavailable" }),
          element("p", { text: "Your account could not be verified." }),
          retry,
        ]));
        outlet.removeAttribute("aria-busy");
      } else showToast(error instanceof LpcApiError ? error.message : "LPC is temporarily unreachable.");
      return false;
    } finally {
      if (sessionCheckController === controller) {
        sessionCheckController = null;
        sessionCheckPromise = null;
      }
    }
  })();
  return sessionCheckPromise;
}

function setupSessionReauthorization() {
  window.addEventListener("storage", (event) => {
    if (event.key !== "lpc_user") return;
    if (captureClosure()) { leaveForExpiredSession(); return; }
    if (!event.newValue && event.oldValue) {
      leavingProtectedShell = true;
      sessionCheckController?.abort();
      clearSensitiveDrafts();
      clearSession();
      location.replace("login.html");
      return;
    }
    // This event may replace the account during an earlier verification. A
    // result started before the event cannot establish the current identity.
    sessionCheckController?.abort();
    sessionCheckController = null;
    sessionCheckPromise = null;
    releaseControl.stop();
    homeView.clearProtected();
    payoutsView.clearProtected();
    void reauthorizeAndRefresh({ protectInteraction: false });
  });
  window.addEventListener("lpc:lifecycle-refresh", (event) => {
    if (event.detail?.sourceId === v2MutationSourceId) {
      // The owning view applies its confirmed response in place. Drop shared
      // snapshots and reconcile the badge so later navigation cannot revive
      // pre-mutation data even if the SSE connection is temporarily offline.
      // Do not invalidate Settings here: its autosave, preference, and security
      // handlers still own the live controls while applying that same response.
      invalidateAuthoritativeViews({ includeSettings: false });
      window.dispatchEvent(new CustomEvent("lpc:notifications-refreshed"));
      return;
    }
    if (event.detail?.accessMayChange === true) { homeView.clearProtected(); payoutsView.clearProtected(); }
    void reauthorizeAndRefresh({ protectInteraction: event.detail?.accessMayChange !== true });
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    closureContinuation = readClosureProof();
    if (document.body.dataset.v2Closure === "pending") { location.reload(); return; }
    if (closureContinuation) { leaveForExpiredSession(); return; }
    if (!historyProtected) protectHistoryWorkspace();
    void restoreHistoryWorkspace();
  });
  window.addEventListener("online", () => {
    void reauthorizeAndRefresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void reauthorizeAndRefresh();
  });
}

// Publish the persistent-shell integration surface before any asynchronous
// session or route work. Header tools and legacy destination adapters can be
// used as soon as the static shell is interactive, without a brief ready-state
// window where the integration object is still undefined.
window.__LPC_PARALEGAL_V2__ = Object.freeze({
  foundation: true,
  shell: Object.freeze({
    sidebar: document.querySelector('[data-v2-persistent="sidebar"]'),
    header: document.querySelector('[data-v2-persistent="header"]'),
    assistant: document.querySelector('[data-v2-persistent="assistant"]'),
  }),
  router,
  adaptLegacyDestination,
  navigateToDestination,
});

setupShellControls();
setupSessionReauthorization();
window.addEventListener("pagehide", () => {
  releaseControl.stop();
  if (!captureClosure()) { protectHistoryWorkspace(); return; }
  leavingProtectedShell = true;
  sessionCheckController?.abort();
  clearSensitiveDrafts();
  concealClosureWorkspace();
  restoreClosure();
});
window.addEventListener("beforeunload", (event) => {
  if (!hasUnfinishedWork()) return;
  event.preventDefault();
  event.returnValue = "";
});
async function startVerifiedRoutes() {
  await router.start();
  await onboardingController.start(verifiedIdentity);
}
async function startVerifiedWorkspace() {
  const sessionReady = await establishSession();
  if (sessionReady) await startVerifiedRoutes();
}
await startVerifiedWorkspace();
