import { notificationDestination } from "./routes.mjs";
import { classifySession } from "./session-boundary.mjs";
import { createWorkspaceSearch, hasOpenSearchBlockingDialog } from "../utils/workspace-search.mjs";
import { createNotificationCenter } from "../utils/notification-center.mjs";

export function createGlobalTools({ api, ready, telemetry, onSessionLost, onNotificationRefresh }) {
  let activePanel = "";
  let scopedIdentity = null;
  let support;
  let supportPromise;
  const input = document.querySelector("#av2-query");
  const searchSlot=document.querySelector('.av2-search-slot');
  const searchPanel=document.querySelector('[data-av2-panel="search"]');
  function positionSearch(){
    if(searchPanel.hidden)return;
    const rect=searchSlot.getBoundingClientRect(),gutter=innerWidth<=640?8:12;
    const width=innerWidth<=640?innerWidth-gutter*2:rect.width;
    const top=Math.min(Math.max(rect.top,0),innerHeight-96);
    searchPanel.style.width=`${width}px`;
    searchPanel.style.left=`${Math.min(Math.max(rect.right-width,gutter),innerWidth-width-gutter)}px`;
    searchPanel.style.right='auto';searchPanel.style.top=`${Math.round(top)}px`;
    searchPanel.style.maxHeight=`${innerWidth<=640?Math.max(160,innerHeight-top-gutter):Math.min(320,Math.max(160,innerHeight-top-gutter))}px`;
  }
  new ResizeObserver(positionSearch).observe(searchSlot);
  window.addEventListener('resize',positionSearch);
  const searchResults = document.querySelector("[data-av2-search-results]");
  const notificationResults = document.querySelector("[data-av2-notification-results]");
  const panels = [...document.querySelectorAll("[data-av2-panel]")];
  const assistantButton = document.querySelector("[data-av2-assistant]");
  const assistantHost = document.querySelector("#supportDrawer");
  const search = createWorkspaceSearch({
    api, panel: document.querySelector('[data-av2-panel="search"]'), input, results: searchResults,
    getIdentity: () => ready() ? scopedIdentity : null,
    verifySession: async options => classifySession(await api.get("/api/auth/me", options)),
    onSessionLost, prefix: "av2-search", types: ["matter", "profile"], routeAttribute: "data-av2-route", showInitialCommands: false, dashboardPresentation: true,
    commands: [
      {label:"Home",path:"/home",keywords:"dashboard overview"},
      {label:"Matters",path:"/matters",keywords:"cases matters"},
      {label:"Messages",path:"/conversations",keywords:"messages inbox chats"},
      {label:"Tasks",path:"/tasks",keywords:"tasks todo private"},
      {label:"Browse Paralegals",path:"/paralegals",keywords:"find people profiles"},
      {label:"Review Applications",path:"/matters?view=applications",keywords:"applicants applications",meta:"Workflow"},
      {label:"Payments",path:"/payments",keywords:"billing funds payouts receipts"},
      {label:"Post a Matter",path:"/matters/new",keywords:"create new matter",meta:"Workflow"},
      {label:"Account Settings",path:"/settings",keywords:"settings preferences security"},
      {label:"Help",path:"/help",keywords:"support faq"},
    ].map(command=>({...command,href:`/attorney-v2.html#${command.path}`,meta:command.meta||"Navigation"})),
    destinationFor: row => {
      try {
        const url = new URL(row.nextAction.href, location.origin);
        const path = row.type === "matter" ? "/case-detail.html" : "/profile-paralegal.html";
        const key = row.type === "matter" ? "caseId" : "paralegalId";
        if (url.origin !== location.origin || url.pathname !== path || url.searchParams.get(key) !== row.id || url.username || url.password) return null;
        return notificationDestination({ action: row.nextAction }, location.origin);
      } catch { return null; }
    },
  });
  const notifications = createNotificationCenter({
    refinePresentation: true,
    api,
    panel: document.querySelector('[data-av2-panel="notifications"]'),
    content: notificationResults,
    actions: document.querySelector("[data-av2-notification-actions]"),
    badge: document.querySelector("[data-av2-notification-badge]"),
    trigger: document.querySelector('[data-av2-open="notifications"]'),
    showToast: text => { document.querySelector("[data-av2-live]").textContent = text; },
    onRefresh: () => { if (ready()) onNotificationRefresh?.(); },
    destinationFor: item => notificationDestination(item, location.origin),
    navigate: destination => {
      if (!ready()) return;
      close();
      const url = new URL(destination.href, location.origin);
      if (destination.internal) {
        if (location.hash === url.hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
        else location.hash = url.hash;
      } else location.assign(destination.href);
    },
  });
  const header=document.querySelector('.av2-header');
  if(header)new ResizeObserver(()=>{
    document.body.style.setProperty('--av2-header-current-height',`${header.getBoundingClientRect().height}px`);
  }).observe(header);
  let assistantOpened=false;
  new MutationObserver(() => {
    const opened=assistantHost.getAttribute("aria-hidden")==="false";
    assistantOpened ||= opened;
    assistantButton.setAttribute("aria-label",opened?"Close LPC Assistant":assistantOpened?"Resume LPC Assistant":"Open LPC Assistant");
    assistantButton.setAttribute("aria-expanded", String(opened));
  }).observe(assistantHost, { attributes: true, attributeFilter: ["aria-hidden"] });

  function close({ focus = false } = {}) {
    notifications.cancelNavigation();
    const previous = activePanel;
    activePanel = "";
    search.close();
    searchSlot.classList.remove("is-open");
    panels.forEach((panel) => { panel.hidden = true; });
    document.querySelectorAll("[data-av2-open]").forEach((button) => button.setAttribute("aria-expanded", "false"));
    if (focus && previous) document.querySelector(`[data-av2-open="${previous}"]`)?.focus();
  }
  function setPanel(name) {
    if (!ready()) return false;
    const wasOpen = activePanel === name;
    close();
    if (wasOpen) return false;
    activePanel = name;
    if(name==="search")searchSlot.classList.add("is-open");
    const brandMenu = document.querySelector('.av2-brand-menu');
    if (brandMenu) brandMenu.open = false;
    document.querySelector(`[data-av2-panel="${name}"]`).hidden = false;
    document.querySelector(`[data-av2-open="${name}"]`).setAttribute("aria-expanded", "true");
    if(name==="search")positionSearch();
    return true;
  }
  input.addEventListener("focus",()=>{if(ready()&&activePanel!=="search"){setPanel("search");search.open({refresh:true});}});
  document.querySelectorAll("[data-av2-open]").forEach((button) => button.addEventListener("click", () => {
    if (!setPanel(button.dataset.av2Open)) return;
    if (activePanel === "search") search.open({ refresh: true });
    else { document.querySelector('[data-av2-panel="notifications"] h2').focus(); notifications.open(); }
  }));
  document.querySelectorAll("[data-av2-close]").forEach((button) => button.addEventListener("click", () => close({ focus: true })));
  document.querySelector("[data-av2-search-form]").addEventListener("submit", event => { event.preventDefault(); if (ready() && activePanel === "search") void search.runSearch(input.value); });
  async function openAssistant({ launcher = assistantButton } = {}) {
    if (!ready()) return false;
    close();
    const assistantFailure = "LPC Assistant couldn’t open. Please try again.";
    const live = document.querySelector("[data-av2-live]");
    if (live.textContent === assistantFailure) live.textContent = "";
    // A new attempt replaces feedback from either launcher. Help owns its
    // inline notice; the header launcher uses the shared status region.
    const helpFeedback = document.querySelector(".v2-help-assistant-status");
    if (helpFeedback) { helpFeedback.hidden = true; helpFeedback.textContent = ""; }
    launcher.disabled = true;
    try {
      // Import after the session boundary and DOMContentLoaded. Shared auth's
      // boot listener must not become a second session owner in this entry.
      supportPromise ||= import("../utils/support-drawer.js");
      support = await supportPromise;
      support.configureSupportSession({ onSessionLost });
      if (!ready()) { support.closeSupportDrawer({ restoreFocus: false }); return false; }
      await support.openSupportDrawer({ launcher, navigationAdapter: {
        resolve: href => ready() ? notificationDestination({ action: { href } }, location.origin) : null,
        navigate: destination => {
          if (!ready() || !destination?.internal) return;
          const url = new URL(destination.href, location.origin);
          if (location.hash === url.hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
          else location.hash = url.hash;
        },
      } });
      if(!assistantHost.querySelector('[data-av2-assistant-minimize]')){
        const minimize=document.createElement('button');minimize.type='button';minimize.className='av2-assistant-minimize';minimize.dataset.av2AssistantMinimize='';minimize.setAttribute('aria-label','Minimize Assistant');minimize.title='Minimize Assistant';minimize.textContent='−';
        minimize.addEventListener('click',()=>support.closeSupportDrawer());assistantHost.querySelector('.support-drawer-actions')?.prepend(minimize);
      }
      if (!ready()) support.closeSupportDrawer({ restoreFocus: false });
      return ready();
    } catch {
      supportPromise = null;
      telemetry.record("tool_error");
      if (launcher === assistantButton) live.textContent = assistantFailure;
      return false;
    } finally { launcher.disabled = false; }
  }
  assistantButton.addEventListener("click", () => {
    if (!ready()) return;
    if (support && assistantHost.getAttribute("aria-hidden") === "false") { support.closeSupportDrawer(); return; }
    void openAssistant();
  });
  document.addEventListener("click", (event) => {
    // Rendering may detach the clicked row before this bubbling listener runs.
    const insideTool = event.composedPath().some(element => element instanceof Element && element.matches("[data-av2-panel], [data-av2-open], .av2-search-slot, .lpc-dialog"));
    if (!insideTool) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape" && activePanel) { event.preventDefault(); close({ focus: true }); }
    if (ready() && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.altKey && !event.shiftKey && !event.repeat
      && (event.target === input || !event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))
      && !hasOpenSearchBlockingDialog()) {
      event.preventDefault();
      if (activePanel !== "search") { setPanel("search"); search.open({ refresh: true }); }
      else close({ focus: true });
    }
  });
  return Object.freeze({
    openAssistant,
    dismiss({ preserveAssistant = false } = {}) { close(); if (!preserveAssistant) support?.closeSupportDrawer({ restoreFocus: false }); },
    start: identity => { scopedIdentity = identity; search.scopeToIdentity(identity); notifications.start(identity); },
    routeChanged() { close(); search.recordPage(); support?.notifySupportRouteChanged(); },
    clear({ preserveSearchHistory = false } = {}) {
      close();
      notifications.stop();
      scopedIdentity = null;
      search.clear({ preserveHistory: preserveSearchHistory });
      notificationResults.replaceChildren();
      support?.closeSupportDrawer({ restoreFocus: false });
      window.LPCProductivityContext = null;
      document.querySelector("[data-av2-live]").textContent = "";
    },
  });
}
