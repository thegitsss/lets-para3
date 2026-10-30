import { createSetupController } from './setup-controller.mjs';
import { installRowActions } from '../utils/row-actions.mjs';
import {applyAccent} from '../utils/appearance-controls.mjs';
import { createUpdatesFeed } from "../utils/updates-feed.mjs";
import { applyAppearance as applyWorkspaceAppearance } from "../utils/appearance.mjs";
import { profileTodos } from "./home-model.mjs";
import { installHeaderBack } from "./header-back.mjs";
import { toggleSidebarList, bindSidebarDetails } from "../utils/sidebar-disclosure.mjs";
import { createFrequentShortcuts } from "../utils/frequent-shortcuts.mjs";
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
import { createSettingsView } from "./settings-view.mjs?v=20261019-boot";
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
installRowActions(document.body);
installHeaderBack(outlet);
const supplementalTools = document.querySelector(".v2-more-tools");
let workspaceViewsClosedByUser = false;
if (supplementalTools) {
  supplementalTools.classList.add("portal-home-tools");
  supplementalTools.addEventListener("keydown", event => { if(event.key === "Escape"){event.preventDefault();event.stopPropagation();workspaceViewsClosedByUser=true;supplementalTools.dataset.workspaceClosedByUser="true";supplementalTools.open=false;supplementalTools.querySelector("summary").focus();} });
  const workspaceSummary = supplementalTools.querySelector("summary");
  workspaceSummary.classList.add("v2-nav-link");
  workspaceSummary.addEventListener("click", event => {
    event.preventDefault();
    supplementalTools.open = !supplementalTools.open;
    workspaceViewsClosedByUser = !supplementalTools.open;
    supplementalTools.dataset.workspaceClosedByUser = String(workspaceViewsClosedByUser);
    workspaceSummary.setAttribute("aria-expanded", String(supplementalTools.open));
  });
  supplementalTools.addEventListener("toggle", () => workspaceSummary.setAttribute("aria-expanded", String(supplementalTools.open)));
  workspaceSummary.setAttribute("aria-expanded", "false");
  workspaceSummary.innerHTML = '<svg class="v2-workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><span>Workspace views</span><svg class="v2-workspace-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  document.querySelector(".v2-sidebar .v2-desktop-primary")?.append(supplementalTools);
}
// First-paint storage is a presentation hint. Only this document's successful
// session verification may establish the owner used by protected controllers.
let verifiedIdentity = null;
let sessionCheckPromise = null;
let signOutPending = false;
let sessionCheckController = null;
let leavingProtectedShell = false;
let closureContinuation = readClosureProof();
let router;
let routeRefreshTimer = null;
let deferredRouteRefresh = null;
let searchController = null;
const shortcuts = createFrequentShortcuts({role:"paralegal",host:document.querySelector(".v2-desktop-primary"),resolveMatter:(id,{signal,ownerId}={})=>api.get(`/api/cases/${id}?${new URLSearchParams({expectedOwnerId:ownerId})}`,{signal})});
let emptyScrollFeedbackTimer = null;
let onboardingController = null;
let setupController = null;
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
    setupController?.hasUnsavedChanges?.()
    || conversationsView?.hasDrafts?.()
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
  shortcuts.clear();
  releaseControl.stop();
  navigationController?.close();
  captureClosure();
  updatesPage?.destroy(); updatesPage = null;
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
  shortcuts.clear();
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
  location.replace(closureContinuation ? "/account-closure.html" : paralegalV2LoginDestination(location.hash, { expired: true }));
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
// Safe reads belong to this live document. Abort and fence them before native
// departure so queued refresh/recovery work cannot fetch from an unloading page.
// An unsent draft stays mounted if departure is canceled; trusted interaction
// resumes reads without assuming a timer means the user stayed.
let documentReadController = new AbortController();
let documentReadsPaused = false;
let documentHasLeft = false;
let pausedReadNotice = null;
function pauseDocumentReads() {
  documentReadsPaused = true;
  documentReadController.abort();
  sessionCheckController?.abort();
  releaseControl.stop();
  window.clearTimeout(routeRefreshTimer);
  routeRefreshTimer = null;
  deferredRouteRefresh = null;
}
function resetDocumentReads() {
  documentReadController = new AbortController();
  documentReadsPaused = false;
  pausedReadNotice?.remove();
}
function continueDocumentReads(event) {
  if (!event.isTrusted || !documentReadsPaused || documentHasLeft || leavingProtectedShell) return;
  resetDocumentReads();
  void reauthorizeAndRefresh({ protectInteraction: true });
}
const api = createApiClient({
  fetchImpl(input, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) return releaseControl.fetch(input, options);
    if (documentReadsPaused || documentHasLeft) return Promise.reject(new DOMException("Document read canceled.", "AbortError"));
    const signal = options.signal
      ? AbortSignal.any([options.signal, documentReadController.signal])
      : documentReadController.signal;
    return releaseControl.fetch(input, { ...options, signal });
  },
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

function renderNotFound(route) {
  const title = route.name === "route-error" ? "This view could not open" : "Page not found";
  document.title = `${title} – Let’s-ParaConnect`;
  const copy = route.name === "route-error"
    ? "Please try again or return Home."
    : "We couldn’t find this page. Use navigation to continue.";
  return element("section", { className: "v2-route-state", "aria-labelledby": "v2-route-status-title" }, [
    element("p", { className: "v2-eyebrow", text: "LPC workspace" }),
    element("h1", { id: "v2-route-status-title", text: title }),
    element("p", { text: copy }),
  ]);
}

// Keep the actual in-portal origin, including workspace views and query filters.
const routeTrail = [];
let tourNavigation = false, tourOriginRoute = null, tourNavigationTicket = 0;
function routeLabel(route) {
  if (route.name === "home") {
    const labels = { matters: "Matter summary", insights: "Work insights", document: "Matter overview", work: "Work overview", pulse: "Updates", inbox: "Inbox", reviews: "Revisions", deadlines: "Deadlines" };
    return labels[route.query.get("view")] || "Home";
  }
  return route.name === "browse" ? "Find Work" : route.title;
}

let updatesPage = null;
async function renderRoute(route, navigation) {
  if (documentReadsPaused || documentHasLeft || leavingProtectedShell) return;
  if (!navigation.isCurrent()) return;
  if (captureClosure()) { leaveForExpiredSession(); return; }
  updatesPage?.destroy(); updatesPage = null;
  conversationsView.leave();
  if (route.name !== "payouts") payoutsView.leave();
  if (route.name !== "matter") matterView.leave();
  if (route.name !== "attorney") attorneyProfileView.leave();
  if (route.name !== "help") helpView.leave();
  if (route.name !== "settings") settingsView.leave?.();
  document.querySelectorAll("dialog[data-v2-route-dialog][open]").forEach((dialog) => dialog.close());
  outlet.setAttribute("aria-busy", "true");
  const destination = route.name === "home" ? "home" : route.name === "matter" || route.name === "work" || route.name === "home" && (!["overview", "pulse", "inbox"].includes(route.query.get("view") || "overview") || route.query.has("item")) ? "work" : route.name === "profile" ? "settings" : route.name;
  document.querySelectorAll("[data-v2-navigation-context]").forEach(group => { group.hidden = group.dataset.v2NavigationContext !== destination; });
  const workSection = route.query.get("section") || ([...route.query.keys()].some(key => key.startsWith("app") || key === "jobId") ? "applications" : "active");
  document.querySelectorAll("[data-v2-more-matter-views]").forEach(group => { if (route.name === "home" && ["work", "matters", "document"].includes(route.query.get("view"))) group.open = true; });
  const currentHomeTool = route.name === "home" && [...document.querySelectorAll("[data-desktop-home-view]")]
    .some(link => link.dataset.desktopHomeView === (route.query.get("view") || "overview"));
  if (supplementalTools) {
    const summary = supplementalTools.querySelector("summary");
    summary.toggleAttribute("data-workspace-active", Boolean(currentHomeTool));
    if (currentHomeTool && !workspaceViewsClosedByUser) supplementalTools.open = true;
    summary.setAttribute("aria-expanded", String(supplementalTools.open));
  }
  document.querySelectorAll("[data-v2-route]").forEach((link) => {
    const homeViewName = link.dataset.desktopHomeView;
    const current = link.dataset.workSection !== undefined
      ? route.name === "work" && workSection === link.dataset.workSection
      : homeViewName !== undefined
      ? route.name === "home" && (route.query.get("view") || "overview") === homeViewName
      : link.dataset.v2Route === (link.closest(".v2-desktop-primary") ? destination : route.name) && !(route.name === "work" && route.query.get("section") === "history" && !link.closest(".v2-desktop-primary"));
    // The current subsection owns the page marker rather than its parent.
    const parentOfCurrent = route.name === "work" && link.closest(".v2-desktop-primary") && link.dataset.workSection === undefined && homeViewName === undefined;
    if (current && !parentOfCurrent && !(currentHomeTool && homeViewName === undefined && link.dataset.v2Route === "home")) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  let view;
  if (route.name === "updates") {
    updatesPage = createUpdatesFeed({ api, identity: verifiedIdentity, role: 'paralegal', showToast,
      destinationFor: item => adaptLegacyDestination(item?.action?.href, {caseId:item?.context?.caseId}), navigate: navigateToDestination });
    view = updatesPage;
  } else if (route.name === "home") {
    view = await homeView.render({
      route,
      isCurrent: navigation.isCurrent,
      onRetry() {
        homeView.invalidate();
        void router.refresh();
      },
    });
  } else if (route.name === "payouts") {
    view = payoutsView.render({ route, isCurrent: navigation.isCurrent });
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
    view = renderNotFound(route);
  }

  if (!navigation.isCurrent() || !view || documentReadsPaused || documentHasLeft || leavingProtectedShell) return;
  const priorRoute = tourOriginRoute || router?.getCurrentRoute?.();
  if (!tourNavigation && priorRoute && priorRoute.key !== route.key && routeTrail.at(-1)?.key !== route.key) {
    const known = routeTrail.findLastIndex(item => item.key === route.key);
    if (priorRoute.name === "browse" && route.name === "browse") {
      // Filters, sorting, pagination, and listing selection belong to Find Work.
      // Keep its entry point rather than adding self-referential return links.
      if (routeTrail.length && routeTrail.at(-1).key === priorRoute.key) routeTrail.pop();
      routeTrail.push({ key: route.key, label: routeLabel(route) });
    } else if (known >= 0) routeTrail.splice(known + 1);
    else {
      if (!routeTrail.length) routeTrail.push({ key: priorRoute.key, label: routeLabel(priorRoute) });
      routeTrail.push({ key: route.key, label: routeLabel(route) });
    }
  }
  outlet.querySelector("[data-v2-context-back]")?.remove();
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
  if (route.name !== "home") {
    const origin = routeTrail.length > 1 ? routeTrail.at(-2) : { key: "/home", label: "Home" };
    const back = element("a", { className: "v2-context-back", href: `#${origin.key}`, "data-v2-context-back": "", text: `← Back to ${origin.label}` });
    outlet.insertBefore(back, view);
  }
  if (supplementalTools) {
    supplementalTools.querySelectorAll("[data-desktop-home-view]").forEach(link => {
      if (route.name === "home" && link.dataset.desktopHomeView === route.query.get("view")) link.setAttribute("aria-current","page");
      else link.removeAttribute("aria-current");
    });
  }
  // The router restores this synchronously again after render resolves. Setting it
  // here guarantees the replacement and its correct offset share one paint.
  outlet.scrollTop = navigation.restoredScrollTop || 0;
  if (route.name === "settings" || route.name === "profile") settingsView.afterMount(route, 0, {suppressIntro:Boolean(tourOriginRoute)});
  if (route.name === "matter") matterView.afterMount(view);
  if (!navigation.isCurrent()) return;
  outlet.removeAttribute("aria-busy");
  window.LPC_PORTAL_BOOT?.ready({outlet,settled:view.readiness});
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
    const appearance = `${nextIdentity}:${projected.preferences.theme}:${projected.preferences.fontSize}:${projected.preferences.accentColor}`;
    // Repeated reads of the same saved preferences must not undo a selection
    // that Settings is still saving. Apply each verified change once.
    if (appearance !== renderedAppearance) {
      const root = document.documentElement;
      applyWorkspaceAppearance(projected.preferences.theme);
      applyAccent(projected.preferences.accentColor);
      root.style.fontSize = ({ xs: "14px", sm: "15px", md: "16px", lg: "18px", xl: "20px" })[projected.preferences.fontSize];
      renderedAppearance = appearance;
    }
  }
  searchController?.scopeToIdentity(projected);
  shortcuts.scopeToIdentity(projected);
  const name = projected.name || [projected.firstName, projected.lastName].filter(Boolean).join(" ") || "Member";
  const nameNode = document.querySelector("[data-v2-profile-name]");
  if (nameNode) nameNode.textContent = name;
  const sidebarName = document.querySelector("[data-v2-sidebar-name]");
  if (sidebarName) {
    sidebarName.textContent = name;
    sidebarName.title = name;
    sidebarName.dataset.initials = name.trim().split(/\s+/).filter(Boolean).map(part => [...part][0]).filter(Boolean).slice(0, 2).join("").toLocaleUpperCase();
  }
  const avatar = document.querySelector("[data-v2-profile-avatar]");
  const fallback = document.querySelector("[data-portal-identity-initials]");
  if (fallback) fallback.textContent = name.trim().split(/\s+/).filter(Boolean).slice(0,2).map(part => [...part][0]).join("").toLocaleUpperCase() || "M";
  const url = String(projected.avatarURL || projected.profileImage || "");
  const hasPhoto = /^(?:\/api\/|assets\/|\/assets\/)/.test(url) && !url.endsWith("/avatar-placeholder.svg");
  if (avatar) {
    avatar.hidden = !hasPhoto;
    if (fallback) fallback.hidden = hasPhoto;
    if (!avatar.dataset.fallbackBound) {
      avatar.dataset.fallbackBound = "true";
      avatar.addEventListener("error", () => { avatar.hidden = true; if (fallback) fallback.hidden = false; });
    }
    if (hasPhoto) { if (avatar.getAttribute("src") !== url) avatar.src = url; }
    else avatar.removeAttribute("src");
  }
  return projected;
}

let workView;
const homeView = createHomeView({
  renderAccountSetup: options => setupController?.renderHome(options),
  api,
  onSessionLost: leaveForExpiredSession,
  showToast,
  getIdentity: () => verifiedIdentity,
  renderWorkContext: options => workView.renderContext(options),
  markNotificationRead: item => notificationsController.readInContext(item),
});

const payoutsView = createPayoutsView({ api, getIdentity: () => verifiedIdentity, onSessionLost: leaveForExpiredSession });

const browseView = createBrowseView({
  api,
  getIdentity: () => verifiedIdentity,
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
  onReplayTour(trigger) { onboardingController?.replay(trigger); },
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
  openAssistant: options => supportNavigationReady() ? openSupportDrawer(options) : false,
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
  if (!request || documentReadsPaused || documentHasLeft || leavingProtectedShell) return;
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
  if (request.protectInteraction && current.name === "browse" && browseView.hasInteraction()) {
    routeRefreshTimer = window.setTimeout(attemptRouteRefresh, 500);
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
  if(types.length && types.every(type=>type==='availability_refresh')) {
    browseView.invalidate();
    void homeView.refreshAvailability();
    return;
  }

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
  setupController?.stop();
  searchController?.close();
  closeSupportDrawer({ restoreFocus: false });
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  historyGate ||= element("section", { className: "v2-route-state v2-history-gate", "data-v2-history-gate": "", "aria-live": "polite" });
  historyGate.replaceChildren(element("p", { text: "Checking your session…" }));
  if (!historyGate.isConnected) document.body.append(historyGate);
}

function markRecoveryPending(button) {
  if (document.activeElement === button) button.dataset.recoveryRestoreFocus = "";
  button.disabled = true;
  button.textContent = "Checking…";
  button.dataset.recoveryPending = "";
  const signIn = button.closest(".v2-recovery-copy")?.querySelector(".v2-recovery-sign-in");
  if (signIn) signIn.disabled = true;
  const sentence = button.closest('[role="status"]');
  if (sentence) {
    sentence.firstChild.textContent = "";
    sentence.lastChild.textContent = "";
  }
}

function renderAccountRecovery(container, retry) {
  container.classList.add("v2-account-recovery");
  const mountain = () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "7 20 50 22");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M9.25 39.63C13 39 16.8 34.1 20.1 31.5S23.9 30.4 25.2 30.2C27 29.9 30.4 25.2 32.63 22.38C35 24.3 37.8 29.3 39.2 30.6S42.9 31.5 44.7 33.4S47.7 34.8 49.9 36.7S52.9 38.9 54.8 39.4");
    svg.append(path);
    svg.setAttribute("aria-hidden", "true");
    return svg;
  };
  const brand = element("a", { className: "v2-recovery-brand", href: "index.html", "aria-label": "Let’s-ParaConnect home" }, [mountain(), element("span", { text: "Let’s-ParaConnect" })]);
  const retryFailed = document.querySelector("[data-recovery-pending]") !== null;
  const restoreRetryFocus = document.querySelector("[data-recovery-restore-focus]") !== null;
  retry.textContent = "try again";
  retry.className = "v2-recovery-retry";
  const sentence = element("p", { role: "status" });
  sentence.append(document.createTextNode(retryFailed ? "We still couldn’t load your account. Please " : "Please "), retry, document.createTextNode(retryFailed ? " in a moment, or sign in again." : " in a moment."));
  const copy = element("div", { className: "v2-recovery-copy" }, [
    element("h1", { id: "v2-session-unavailable-title", text: "We couldn’t load your account" }),
    sentence,
  ]);
  if (retryFailed) {
    const signIn = element("button", { type: "button", className: "v2-recovery-sign-in", text: "Sign in" });
    signIn.addEventListener("click", async () => {
      signIn.disabled = true;
      retry.disabled = true;
      signIn.textContent = "Signing out…";
      copy.querySelector("[data-recovery-signin-error]")?.remove();
      try { await signOut({ onError: () => {
        copy.append(element("p", { role: "alert", "data-recovery-signin-error": "", text: "LPC couldn’t be reached to sign you out. Please try signing in again in a moment." }));
      } }); }
      finally {
        if (signIn.isConnected) {
          signIn.disabled = false;
          retry.disabled = false;
          signIn.textContent = "Sign in";
        }
      }
    });
    copy.append(signIn);
  }
  container.replaceChildren(element("div", { className: "v2-recovery-card" }, [element("div", { className: "v2-recovery-main" }, [brand, copy])]));
  if (restoreRetryFocus) queueMicrotask(() => { if (retry.isConnected) retry.focus({ preventScroll: true }); });
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
      await window.LPC_PORTAL_BOOT?.finished;
      await onboardingController.start(verifiedIdentity);
      return true;
    } catch {
      if (generation !== historyGeneration || leavingProtectedShell) return false;
      document.body.dataset.v2Session = "unavailable";
      const retry = element("button", { type: "button", className: "v2-settings-secondary", text: "Try again" });
      retry.addEventListener("click", () => { markRecoveryPending(retry); void restoreHistoryWorkspace(); });
      const retryOwnedFocus = historyGate.contains(document.activeElement);
      renderAccountRecovery(historyGate, retry);
      if (retryOwnedFocus) retry.focus({ preventScroll: true });
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

setupController = createSetupController({
  api, getIdentity: () => verifiedIdentity, showToast, hasUnfinishedWork,
  navigate: path => { window.location.hash = `#${path}`; }, onSessionLost: leaveForExpiredSession,
  invalidateHome: () => homeView.invalidate(), invalidateBrowse: () => browseView.invalidate(),
  updateIdentity(user) { const next=projectProfileIdentity(user,verifiedIdentity); if(next){const identity=setIdentity(next);if(identity)persistSession({user:identity});} },
});
onboardingController = createOnboardingController({
  setupFlow: setupController,
  api,
  hasUnfinishedWork,
  async navigateTour(path, {preview = false, restore = false, scrollTop = 0} = {}) {
    const ticket = ++tourNavigationTicket;
    tourOriginRoute ||= router.getCurrentRoute();
    tourNavigation = preview || restore;
    const url = new URL(location.href); url.hash = path;
    history.replaceState(history.state, "", url);
    try {
      await router.refresh();
      if (ticket === tourNavigationTicket) {
        outlet.scrollTop = scrollTop;
        if (!preview && !restore) { const title = outlet.querySelector('h1'); if (title) { title.tabIndex = -1; title.focus({preventScroll:true}); } }
      }
    }
    finally { if (ticket === tourNavigationTicket) { tourNavigation = false; if (!preview) tourOriginRoute = null; } }
  },
  async getTourContext() {
    const owner = identityKey(verifiedIdentity);
    const [profile, dashboard] = await Promise.allSettled([
      api.get("/api/users/me"), api.get(`/api/paralegal/dashboard?expectedOwnerId=${encodeURIComponent(owner)}`),
    ]);
    if (identityKey(verifiedIdentity) !== owner) return null;
    const user = profile.status === "fulfilled" ? profile.value?.user || profile.value : null;
    const work = dashboard.status === "fulfilled" && Array.isArray(dashboard.value?.activeCases) ? dashboard.value.activeCases : null;
    if (user && profileTodos({complete:true,value:user}).length) return { label: "Finish my profile", href: "/settings?tab=profile" };
    if (work?.length) return { label: "Open my Matters", href: "/work?section=active" };
    if (user && work) return { label: "Find work", href: "/browse" };
    return { label: "Go to Home", href: "/home" };
  },
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
  menu?.querySelector(".v2-menu-identity")?.addEventListener("click", () => closeProfileMenu());
  trigger?.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    setExpanded(trigger, open);
    if (open) menu.querySelector('[role="menuitem"]')?.focus();
  });
}

function setupMattersNavigation() {
  const mattersToggle = document.querySelector('[data-v2-matters-toggle]');
  const mattersSubnav = document.querySelector('#v2-matter-subnav');
  const heading=mattersToggle?.closest('.v2-matters-heading'),label=heading?.querySelector('a');
  if(label){label.setAttribute('role','button');label.setAttribute('aria-controls','v2-matter-subnav');label.setAttribute('aria-expanded',mattersToggle.getAttribute('aria-expanded'));mattersToggle.tabIndex=-1;mattersToggle.setAttribute('aria-hidden','true');}
  heading?.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();label?.focus({preventScroll:true});const collapsed=document.body.classList.contains('v2-sidebar-collapsed');if(collapsed)document.querySelector('[data-v2-mobile-menu]').click();const expanded=collapsed||mattersToggle.getAttribute('aria-expanded')!=='true';mattersToggle.setAttribute('aria-expanded',String(expanded));label?.setAttribute('aria-expanded',String(expanded));mattersToggle.setAttribute('aria-label',`${expanded?'Collapse':'Expand'} Matters navigation`);toggleSidebarList(mattersSubnav,expanded);});
  label?.addEventListener('keydown',event=>{if(event.key===' '){event.preventDefault();label.click();}});
  document.querySelectorAll('.v2-sidebar .v2-more-tools:not(.portal-home-tools)').forEach(bindSidebarDetails);
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
  const sidebar = document.querySelector('[data-v2-persistent="sidebar"]');
  if (!sidebar || !outlet) return;
  sidebar.addEventListener("wheel", (event) => {
    if (event.defaultPrevented || event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    // The mobile drawer owns its scrolling and must not move the obscured view.
    if (window.matchMedia("(max-width: 900px)").matches) return;
    const delta = normalizedWheelDelta(event);
    if (!delta) return;
    const navigation = event.target.closest?.(".v2-desktop-primary");
    if (navigation) {
      const maximum = Math.max(0, navigation.scrollHeight - navigation.clientHeight);
      if ((delta > 0 && navigation.scrollTop < maximum) || (delta < 0 && navigation.scrollTop > 0)) return;
    }
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
  setupMattersNavigation();
  setupSidebarScrollBridge();
  document.querySelector("[data-v2-search-form]")?.addEventListener("click", () => searchController.open());
  document.querySelector("[data-v2-notifications-trigger]")?.addEventListener("click", () => openPopover("notifications"));
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
    document.querySelectorAll('.pv2-work-filter-menu[open], .v2-work-record-menu[open]').forEach(menu => {
      if (!event.composedPath().includes(menu)) menu.open = false;
    });
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
      shortcuts.record();
      closePopover("notifications");
      notifySupportRouteChanged();
    }
    // A committed refresh can win a route transition after an onboarding save.
    // Tour eligibility still follows that committed route; open dialogs are idempotent.
    onboardingController?.routeChanged(event.detail);
  });
}

function showToast(message, { appearance = "floating-pill", tone = "neutral" } = {}) {
  const region = document.querySelector("[data-v2-toast-region]");
  if (!region) return;
  const toast = element("div", { className: "v2-toast", text: String(message || "") });
  const floatingPill = appearance === "floating-pill";
  if (floatingPill) {
    toast.classList.add("v2-toast-floating-pill");
    const label = element("span", { text: String(message || "") });
    toast.replaceChildren(...(tone === "success" ? [element("span", { className: "v2-toast-pill-check", text: "✓", "aria-hidden": "true" })] : []), label);
  }
  if (tone === "error") toast.setAttribute("role", "alert");
  region.replaceChildren(toast);
  window.setTimeout(() => {
    if (!toast.isConnected) return;
    if (!floatingPill || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { toast.remove(); return; }
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 180);
  }, Math.max(tone === "error" ? 15000 : 10000, 3000 + String(message || "").trim().split(/\s+/).filter(Boolean).length * 500));
}

async function signOut({ onError } = {}) {
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
  setupController?.stop();
  closeSupportDrawer({ restoreFocus: false });
  if (signOutPending) return;
  signOutPending = true;
  sessionCheckController?.abort();
  sessionCheckController = null;
  sessionCheckPromise = null;
  const ended = await logout("", { onError });
  if (!ended) { signOutPending = false; return; }
  clearSensitiveDrafts();
  location.assign("login.html");
}

async function establishSession() {
  if (signOutPending) return false;
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
      navigationController?.close();
      document.querySelector('[data-v2-persistent="header"]').inert = false;
      return true;
    } catch (error) {
      if (leavingProtectedShell || sessionCheckController !== controller || error?.name === "AbortError") return false;
      if (error instanceof LpcApiError && error.kind === "authentication") {
        clearSession();
        location.replace(paralegalV2LoginDestination(location.hash, { expired: true }));
        return false;
      }
      document.body.dataset.v2Session = "unavailable";
      navigationController?.close();
      document.querySelector('[data-v2-persistent="header"]').inert = true;
      if (!verifiedIdentity) {
        const retry = element("button", { type: "button", className: "v2-settings-secondary", text: "Try again" });
        retry.addEventListener("click", () => { markRecoveryPending(retry); void startVerifiedWorkspace(); });
        const recovery = element("section", {
          "aria-labelledby": "v2-session-unavailable-title",
          "data-v2-session-recovery": "",
        });
        const retryOwnedFocus = outlet.contains(document.activeElement);
        renderAccountRecovery(recovery, retry);
        outlet.replaceChildren(recovery);
        if (retryOwnedFocus) retry.focus({ preventScroll: true });
        outlet.removeAttribute("aria-busy");
      } else showToast(error instanceof LpcApiError ? error.message : "LPC is temporarily unreachable.");
      window.LPC_PORTAL_BOOT?.fail();
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
    if(event.detail?.url==='/api/paralegals/update-availability' && event.detail?.accessMayChange!==true){
      browseView.invalidate();
      if(event.detail.sourceId!==v2MutationSourceId)void homeView.refreshAvailability();
      return;
    }

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
    documentHasLeft = false;
    resetDocumentReads();
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
  documentHasLeft = true;
  pauseDocumentReads();
  releaseControl.stop();
  if (!captureClosure()) { protectHistoryWorkspace(); return; }
  leavingProtectedShell = true;
  sessionCheckController?.abort();
  clearSensitiveDrafts();
  concealClosureWorkspace();
  restoreClosure();
});
window.addEventListener("beforeunload", (event) => {
  pauseDocumentReads();
  pausedReadNotice ||= element("div", { className: "v2-toast", role: "status", "data-v2-read-pause": "", text: "Updates paused. Click or press a key to continue." });
  if (!pausedReadNotice.isConnected) document.querySelector("[data-v2-toast-region]")?.append(pausedReadNotice);
  if (!hasUnfinishedWork()) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("pointerdown", continueDocumentReads, { capture: true });
window.addEventListener("keydown", continueDocumentReads, { capture: true });
window.addEventListener("focus", continueDocumentReads);
async function startVerifiedRoutes() {
  await router.start();
  await window.LPC_PORTAL_BOOT?.finished;
  await onboardingController.start(verifiedIdentity);
}
async function startVerifiedWorkspace() {
  const sessionReady = await establishSession();
  if (sessionReady) await startVerifiedRoutes();
}
await startVerifiedWorkspace();
