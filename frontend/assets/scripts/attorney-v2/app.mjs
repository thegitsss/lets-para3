import { installRowActions } from '../utils/row-actions.mjs';
import {applyAppearance} from '../utils/appearance.mjs';
import {applyAccent} from '../utils/appearance-controls.mjs';
import { toggleSidebarList } from "../utils/sidebar-disclosure.mjs";
import { createFrequentShortcuts } from "../utils/frequent-shortcuts.mjs";
import { readSession } from "./session-read.mjs";
import { createTooltips } from './tooltips.mjs';
import {createMatterCreation} from './matter-creation.mjs';
import {installHeaderBack} from '../paralegal-v2/header-back.mjs';
import { createApiClient } from "./api-client.mjs";
import { createAccountApi, accountPhoto } from "./account-api.mjs";
import { createSecurityApi } from "./security-api.mjs";
import { classifySession, projectIdentity, sessionDestination } from "./session-boundary.mjs";
import { RELEASE, canEnter, createTelemetry } from "./release.mjs";
import { createWorkspaceReleaseController } from "../utils/workspace-release.mjs";
import { clearCardSetupRecovery } from "./payment-setup-recovery.mjs";
import { retainReturnedCardSetup } from "./payment-setup.mjs";
import { createRouter } from "./router.mjs";
import { createNavigation } from "./navigation.mjs";
import { createView, createRouteError, node } from "./views.mjs";
import { createGlobalTools } from "./global-tools.mjs";
import { createPrivateState } from "./private-state.mjs";
import { readClosureProof, storeClosureProof, clearClosureProof } from "../utils/account-closure-state.mjs";
import { profileComplete } from "./read-model.mjs";
import { clearHelpStorage } from "../utils/help-storage.mjs";

createTooltips();
const root = document.documentElement;
const shell = document.querySelector("[data-av2-shell]");
const gate = document.querySelector("[data-av2-gate]");
const outlet = document.querySelector("[data-av2-outlet]");
installRowActions(document.body);
installHeaderBack(outlet,{headerSelector:".av2-header",toolsSelector:".av2-header-tools"});
const telemetry = createTelemetry();
let identity = null;
let navigationRoute = null;
let creationOpen = false;
let auth = null;
let checking = null;
let sessionGeneration = 0;
let leaving = false;
let accountDraftsQuarantined = false;
let lastSessionFailure = null;
let closureContinuation = readClosureProof();
const ready = () => !leaving && root.dataset.attorneyState === "ready";
const privateState = createPrivateState();
const shortcuts = createFrequentShortcuts({role:"attorney",host:document.querySelector(".av2-sidebar > .av2-nav"),resolveMatter:(id,{signal,ownerId}={})=>api.get(`/api/cases/${id}?${new URLSearchParams({expectedOwnerId:ownerId})}`,{signal})});

let creation = null;
const releaseControl = createWorkspaceReleaseController({ outlet, currentLocation: () => creation?.workspaceLocation(), noticeHost: () => creation?.noticeHost(), baselineAllowed: user => canEnter(user, location.hostname), hasUnfinishedWork: () => privateState.hasUnsaved(), onAccessLost: () => leave("/login.html") });
const api = createApiClient({ fetchImpl: releaseControl.fetch, onAuthenticationLost: () => leave("/login.html") });
const accountApi = createAccountApi({ fetchImpl: releaseControl.fetch, onAuthenticationLost: () => leave("/login.html") });
const securityApi = createSecurityApi({ fetchImpl: releaseControl.fetch, onAuthenticationLost: () => leave("/login.html") });
const globalTools = createGlobalTools({ api, ready, telemetry, onSessionLost: () => leave("/login.html"), onNotificationRefresh: () => { void outlet.querySelector('[data-av2-region="messages"]')?.refreshFromNotice?.(); void outlet.querySelector('.av2-account')?.refreshPreferencesFromNotice?.(); } });
creation = createMatterCreation({api,privateState,identity:()=>identity,ready,onOpenChange:open=>{creationOpen=open;syncNavigation();releaseControl.refreshPresentation();},beforeOpen:()=>{globalTools.dismiss();navigation.close();},onSuccess:message=>{document.querySelector('[data-av2-live]').textContent=message;}});
const router = createRouter({
  outlet,
  interceptRoute(route,current){
    if(!ready()||route.name!=='create'||route.query.has('caseId')||!current)return false;
    history.replaceState(history.state,'','#'+current.key);
    void creation.open(route.query);return true;
  },
  render: (route, { signal }) => {
    if (captureClosure()) { leave("/account-closure.html"); return node("div", { inert: "", hidden: true }); }
    return createView(route, identity, { api, accountApi, securityApi, signal, privateState, openAssistant: options => globalTools.openAssistant(options), onAccountConfirmed, onClosurePending: () => leave("/account-closure.html"), onSessionLost: () => leave("/login.html"), refresh: () => void router.refresh() });
  },
  onError: () => { telemetry.record("route_error"); return createRouteError(() => void router.refresh()); },
  onCommit(route) {
    window.LPC_PORTAL_BOOT?.ready({outlet,settled:outlet.firstElementChild?.readiness});
    navigationRoute = route;
    syncNavigation();
    navigation.close();
    globalTools.routeChanged();
    shortcuts.scopeToIdentity(identity);
    shortcuts.record();
    telemetry.record("route_ready");
  },
});

function syncNavigation() {
  const route = navigationRoute;
  if (!route) return;
    document.querySelectorAll(".av2-nav a").forEach((link) => {
      const selected = creationOpen ? link.hasAttribute("data-av2-create-new") : link.hasAttribute("data-av2-create-new") ? route.name === "create" : link.dataset.av2Route === route.name
        || (link.dataset.av2Route === "matters" && ["workspace", "create", "matter-management", "matter-invitations", "matter-applications", "matter-archive", "matter-downloads", "matter-receipt", "matter-export"].includes(route.name))
        || (link.dataset.av2Route === "paralegals" && route.name === "candidate")
        || (link.dataset.av2Route === "payments" && route.name === "payment-setup")
        || (link.dataset.av2Route === "settings" && route.name === "profile");
      if (selected) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    });
    const matterView = !creationOpen && route.name === 'matters' ? route.query.get('view') || 'active' : null;
    document.querySelectorAll('[data-av2-matter-view]').forEach(link => {
      if (link.dataset.av2MatterView === matterView) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    if (creationOpen || matterView || route.name === 'create') {
      setMatterNavigation(true);
      document.querySelector('[data-av2-route="matters"]')?.removeAttribute('aria-current');
    }
}

function setMatterNavigation(open) {
  const toggle = document.querySelector('.av2-matters-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} Matters navigation`);
  const label=document.querySelector('.av2-matters-nav-heading > a');label?.setAttribute('aria-expanded',String(open));
  toggleSidebarList(document.querySelector('#av2-matter-subnav'),open);
}
const mattersHeading=document.querySelector('.av2-matters-nav-heading'), mattersLabel=mattersHeading.querySelector('a'), mattersArrow=mattersHeading.querySelector('button');
mattersLabel.setAttribute('role','button');mattersLabel.setAttribute('aria-controls','av2-matter-subnav');mattersLabel.setAttribute('aria-expanded','false');mattersArrow.tabIndex=-1;mattersArrow.setAttribute('aria-hidden','true');
mattersHeading.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();mattersLabel.focus({preventScroll:true});const collapsed=document.body.classList.contains('av2-collapsed');if(collapsed)document.querySelector('[data-av2-nav-toggle]').click();setMatterNavigation(collapsed||mattersArrow.getAttribute('aria-expanded')!=='true');});
mattersLabel.addEventListener('keydown',event=>{if(event.key===' '){event.preventDefault();mattersLabel.click();}});
document.querySelector('.av2-brand-menu > summary').addEventListener('click', async () => {
  const link = document.querySelector('[data-av2-finish-setup]');
  link.hidden = true;
  if (!ready() || document.querySelector('.av2-brand-menu').open) return;
  const owner = identity.id;
  try {
    const [profile, payment] = await Promise.all([api.get('/api/users/me'), api.get('/api/payments/payment-method/default')]);
    if (!ready() || identity?.id !== owner || !payment || !Object.hasOwn(payment, 'paymentMethod')) return;
    const completeProfile = profileComplete(profile);
    link.href = completeProfile ? 'attorney-v2.html#/payments/setup' : 'attorney-v2.html#/settings';
    link.hidden = completeProfile && Boolean(payment.paymentMethod);
  } catch { telemetry.record("tool_error"); }
});

function renderIdentity() {
  if (!identity) return;
  const name = [identity.firstName, identity.lastName].filter(Boolean).join(" ") || identity.name || "Attorney";
  document.querySelector("[data-av2-name]").textContent = name;
  const sidebarName = document.querySelector("[data-av2-sidebar-name]");
  if (sidebarName) { sidebarName.textContent = name; sidebarName.title = name; }
  const avatar = document.querySelector("[data-av2-initials]");
  const initials = [identity.firstName, identity.lastName].filter(Boolean).map(part => part[0]).join("") || "A";
  avatar.textContent = initials;
  const photo = accountPhoto(identity.profileImage || identity.avatarURL, identity.id);
  if (photo) {
    const image = node("img", { src: photo, alt: "", width: "40", height: "40", className: "av2-identity-photo" });
    image.addEventListener("error", () => { if (avatar.contains(image)) avatar.textContent = initials; }, { once: true });
    avatar.replaceChildren(image);
  }
  applyAppearance(identity.preferences.theme);
  applyAccent(identity.preferences.accentColor);
  root.style.fontSize = ({ xs: "87.5%", sm: "93.75%", md: "100%", lg: "112.5%", xl: "125%" })[identity.preferences.fontSize];
}

function onAccountConfirmed(value) {
  if (!ready() || !identity || value?.id !== identity.id) return;
  const changes = {};
  for (const key of ["firstName", "lastName", "profileImage", "avatarURL"]) if (typeof value[key] === "string") changes[key] = value[key];
  identity = projectIdentity({ ...identity, ...changes, preferences: { ...identity.preferences, ...(value.preferences || {}) } });
  renderIdentity();
  auth?.persistSession({ user: identity });
}

const navigation = createNavigation({
  ready: () => ready() && !shell.inert,
  beforeOpen: () => globalTools.dismiss({ preserveAssistant: true }),
});
document.querySelector(".av2-skip").addEventListener("click", (event) => { event.preventDefault(); outlet.focus(); });

function captureClosure() {
  const pending = privateState.account.closure;
  if (pending?.pending && identity && pending.ownerId === identity.id && typeof pending.proof === "string") closureContinuation = pending.proof;
  return closureContinuation;
}
function retainClosure() {
  if (!closureContinuation) return;
  try { storeClosureProof(closureContinuation); } catch { /* The result screen stays unavailable if tab storage fails. */ }
}
function discardClosure() {
  closureContinuation = null;
  delete privateState.account.closure;
  clearClosureProof();
}
function protect({ preserveDrafts = false, preserveSearchHistory = false, preserveHelpDrafts = false, preserveCardSetup = false, preserveCreationResume = false } = {}) {
  shortcuts.clear();
  releaseControl.stop();
  creation.clear({forgetResume:!preserveCreationResume&&Boolean(identity)&&!preserveDrafts});
  captureClosure();
  navigation.close();
  // Retained drafts remain inaccessible until the API re-verifies the same
  // account. Storage metadata never authorizes a screen or a pending write.
  if (!preserveDrafts) privateState.clear({ preserveHelpDrafts, preserveCardSetup });
  retainClosure();
  accountDraftsQuarantined = preserveDrafts;
  root.dataset.attorneyState = "checking";
  shell.inert = true;
  gate.hidden = false;
  globalTools.clear({ preserveSearchHistory });
  router.suspend();
  api.clear();
  accountApi.clear();
  securityApi.clear();
  outlet.replaceChildren();
}
function leave(destination, { preserveHelpDrafts = false } = {}) {
  if (leaving) return;
  leaving = true;
  clearCardSetupRecovery();
  sessionGeneration += 1;
  if (!preserveHelpDrafts) clearHelpStorage();
  protect({ preserveHelpDrafts });
  router.stop();
  outlet.replaceChildren();
  identity = null;
  document.querySelector("[data-av2-name]").textContent = "Attorney";
  const sidebarName = document.querySelector("[data-av2-sidebar-name]");
  if (sidebarName) { sidebarName.textContent = "Attorney"; sidebarName.removeAttribute("title"); }
  document.querySelector("[data-av2-initials]").textContent = "A";
  auth?.clearSession();
  retainClosure();
  telemetry.record("session_lost");
  location.replace(closureContinuation ? "/account-closure.html" : destination);
}
async function establishSession({ background = false, preserveDrafts = accountDraftsQuarantined } = {}) {
  if (leaving || checking) return checking;
  if (captureClosure()) { leave("/account-closure.html"); return; }
  const wasReady = background && ready();
  if (!wasReady) {
    protect({ preserveDrafts });
    gate.replaceChildren(node("p", { text: "Checking your session…" }));
  }
  const ticket = ++sessionGeneration;
  checking = (async () => {
    let phase = "session";
    try {
      const result = classifySession(await readSession(api, { isCurrent: () => !leaving && ticket === sessionGeneration }));
      if (leaving || ticket !== sessionGeneration) return;
      if (result.identity && identity && (result.identity.id !== identity.id || result.identity.role !== identity.role)) discardClosure();
      if (result.state !== "ready") { leave(sessionDestination(result)); return; }
      phase = "workspace";
      retainReturnedCardSetup(result.identity.id);
      if (!await releaseControl.start(result.identity)) return;
      if (leaving || ticket !== sessionGeneration) return;
      if (identity && identity.id !== result.identity.id) { discardClosure(); leave("/dashboard-attorney.html"); return; }
      const identityChanged = JSON.stringify(identity) !== JSON.stringify(result.identity);
      identity = result.identity;
      auth ||= await import("../auth.js");
      if (leaving || ticket !== sessionGeneration) return;
      // Checking the same session must not rebuild a route, steal focus, or
      // republish an identical identity into other open tabs.
      if (!wasReady || identityChanged) {
        auth.persistSession({ user: identity });
        renderIdentity();
      }
      let creationQuery=null;
      if(!wasReady && /^#\/matters\/new(?:\?|$)/.test(location.hash)){
        const query=new URLSearchParams(location.hash.split('?')[1]);
        if(!query.has('caseId')){creationQuery=query;history.replaceState(history.state,'','#/matters?view=draft');}
      }
      if (!wasReady) await router.start();
      if (leaving || ticket !== sessionGeneration) return;
      if (wasReady) await router.refreshWeeklyNotesAfterSessionCheck({
        ownerId: identity.id, isCurrent: () => !leaving && ticket === sessionGeneration,
      });
      if (leaving || ticket !== sessionGeneration) return;
      root.dataset.attorneyState = "ready";
      accountDraftsQuarantined = false;
      shell.inert = false;
      gate.hidden = true;
      if (!wasReady || identityChanged) globalTools.start(identity);
      if(!wasReady){
        const resumeCreation=()=>{if(!ready()||leaving||ticket!==sessionGeneration)return;if(creationQuery)void creation.open(creationQuery);else creation.resume();};
        if(window.LPC_PORTAL_BOOT?.pending)void window.LPC_PORTAL_BOOT.finished.then(resumeCreation);
        else resumeCreation();
      }
      if (wasReady) {
        await creation.refreshAfterSessionCheck();
        if (leaving || ticket !== sessionGeneration) return;
        await outlet.querySelector('[data-av2-posting-editor]')?.refreshAfterSessionCheck?.();
      }
      if (leaving || ticket !== sessionGeneration) return;
      lastSessionFailure = null;
      telemetry.record("session_ready");
    } catch (error) {
      if (leaving || ticket !== sessionGeneration || error.name === "AbortError") return;
      protect({ preserveDrafts: Boolean(identity) || preserveDrafts });
      lastSessionFailure = { phase, kind: ["network", "authentication", "authorization", "invalid_response"].includes(error.kind) ? error.kind : "unavailable", status: Number.isInteger(error.status) ? error.status : 0 };
      telemetry.record("session_error");
      const retry = node("button", { type: "button", className: "av2-button", text: "Try again" });
      retry.addEventListener("click", () => void establishSession());
      gate.replaceChildren(node("p", { text: phase === "session" ? "We couldn’t verify your session. Check your connection and try again." : "Your workspace couldn’t open. Please try again." }), retry);
      window.LPC_PORTAL_BOOT?.fail();
    } finally { if (ticket === sessionGeneration) checking = null; }
  })();
  return checking;
}

window.addEventListener("beforeunload", (event) => {
  if (privateState.hasUnsaved()) { event.preventDefault(); event.returnValue = ""; }
});
window.addEventListener("storage", (event) => {
  if (event.key !== "lpc_user" && event.key !== null) return;
  // Snapshot changes are only signals, never authorization evidence.
  if (captureClosure()) { leave("/account-closure.html"); return; }
  sessionGeneration += 1;
  checking = null;
  let hint = null;
  try { hint = event.newValue ? JSON.parse(event.newValue) : null; } catch {}
  const preserveDrafts = Boolean(identity && String(hint?.id || hint?._id) === identity.id && hint.role === "attorney" && hint.status === "approved" && !hint.disabled && !hint.deleted);
  if (preserveDrafts && ready()) {
    // Same-owner snapshot updates are reverified without hiding the page.
    // A cleared, changed-owner, disabled, or unapproved hint still quarantines.
    void establishSession({ background: true });
    return;
  }
  protect({ preserveDrafts });
  void establishSession({ preserveDrafts });
});
window.addEventListener("pagehide", () => {
  sessionGeneration += 1;
  checking = null;
  protect({ preserveSearchHistory: !leaving, preserveHelpDrafts: !leaving, preserveCardSetup: !leaving, preserveCreationResume: !leaving });
  router.stop();
  outlet.replaceChildren();
});
window.addEventListener("pageshow", (event) => { if (event.persisted) { closureContinuation = readClosureProof(); void establishSession(); } });
window.addEventListener("focus", () => { if (document.visibilityState === "visible") void establishSession({ background: true }); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void establishSession({ background: true }); });
window.addEventListener("online", () => {
  document.querySelector("[data-av2-live]").textContent = "Connection restored. Checking your workspace…";
  void establishSession({ background: true }).then(() => { if (ready()) document.querySelector("[data-av2-live]").textContent = "Connection restored."; });
});
window.addEventListener("offline", () => {
  if (ready()) document.querySelector("[data-av2-live]").textContent = "You’re offline. Displayed information may be out of date.";
});
document.querySelector("[data-av2-logout]").addEventListener("click", async (event) => {
  if (!ready() || !auth) return;
  const button = event.currentTarget;
  button.disabled = true;
  if (await auth.logout(null)) leave("/login.html");
  else button.disabled = false;
});

root.dataset.attorneyRelease = RELEASE.id;
window.__LPC_ATTORNEY_V2__ = Object.freeze({ release: RELEASE.id, health: () => ({ ...telemetry.snapshot(), lastSessionFailure: lastSessionFailure ? { ...lastSessionFailure } : null }) });
if (document.readyState === "loading") await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
if (closureContinuation) leave("/account-closure.html");
else await establishSession();
