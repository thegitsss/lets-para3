import { withMatterReturn } from "./router.mjs";
import { loadReceivedInvitations } from "../utils/received-invitations.mjs";
import { buildHomeModel, dateOnly, newYorkDateOnly } from "./home-model.mjs";
import { renderEarningsReport } from "../utils/paralegal-financials.mjs";
import { startStripeOnboarding } from "../utils/stripe-connect.js";
import { enhanceHomeDesktop, homeDesktopView } from "./home-desktop.mjs?v=20260909-text-headings";
import { deadlineTimelineRange } from "./home-timeline.mjs";
import { loadHomeDeadlines } from "./home-deadlines.mjs";
import { saveAvailability } from "../utils/availability-save.mjs";

import { fileHref, triggerDownload } from "./matter-files.mjs";

const HOME_CACHE_TTL_MS = 30_000;
const HOME_REQUEST_TIMEOUT_MS = 10_000;
const RETRYABLE_HOME_STATUSES = new Set([409, 502, 503, 504]);
const SOURCE_NAMES = ["dashboard", "profile", "stripe", "recommendations", "invites", "events", "threads", "unread", "applications", "notifications", "submissions"];

async function readHomeSource(read, signal) {
  try { return await read(); }
  catch (error) {
    if (signal?.aborted || error?.name === "AbortError" || !RETRYABLE_HOME_STATUSES.has(error?.status) && error?.kind !== "network") throw error;
    await new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 250);
      const abort = () => { window.clearTimeout(timer); reject(new DOMException("View changed", "AbortError")); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    return read();
  }
}

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  children.flat().filter(Boolean).forEach(child => element.append(child instanceof Node ? child : document.createTextNode(String(child))));
  return element;
}
function link(label, href, className = "ph-link") {
  href = withMatterReturn(href, window.location.hash.slice(1));
  return node("a", { className, href: `paralegal-v2.html#${href}`, "data-view": href, "data-v2-route": "", text: label });
}
function button(label, handler, className = "ph-link", attributes = {}) {
  const result = node("button", { type: "button", className, text: label, ...attributes });
  result.addEventListener("click", handler);
  return result;
}
function shortDate(value) {
  const day = dateOnly(value);
  return day ? new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
}
function readiness(model, actions) {
  const readinessItems = model.readiness.items.filter(item => item.id !== "photo" || !model.profileTodos.some(todo => todo.id === "profile-photo"));
  if (readinessItems.length) {
    const setup = node("aside", { className: "ph-readiness", "aria-label": "Application and invitation requirements" }, [node("h3", { text: "Before applying or accepting" })]);
    readinessItems.forEach(item => setup.append(node("div", { className: "ph-readiness-item" }, [
      node("div", {}, [node("h4", { text: item.title }), node("p", { text: item.detail })]),
      item.action === "stripe" ? button(item.actionLabel || "Continue to Stripe", actions.stripe, "ph-link", { "data-v2-home-stripe": "" }) : item.href ? link(item.actionLabel, item.href) : null,
    ])));
    return setup;
  }
  return null;
}

function paintAvailabilityTrigger(trigger, availability) {
  const label = availability.label || "Availability unavailable";
  trigger.dataset.availabilityState = availability.status || "unknown";
  trigger.setAttribute("aria-label", `Update availability: ${label}`);
  trigger.replaceChildren(
    node("span", { className: "pv2-availability-dot", "aria-hidden": "true" }),
    node("span", { "data-v2-availability-label": "", text: label }),
    node("span", { className: "pv2-availability-chevron", "aria-hidden": "true" })
  );
}

function availabilityDialog(model, snapshot, api, { userId, retry, onSessionLost, onSaved, isValid, showToast }, trigger) {
  const current = model.availability;
  const dialog = node("dialog", { className: "ph-dialog v2-availability-dialog", id: "v2-availability-dialog", "aria-label": "Update availability", tabindex: "-1", "data-v2-route-dialog": "" });
  const status = node("fieldset", { className: "v2-availability-options", "data-v2-availability-status": "" }, [
    node("legend", { className: "v2-visually-hidden", text: "Choose your availability" }),
    ...[["available", "Available now"], ["unavailable", "Not available"]].map(([value, label]) =>
      node("label", { className: "v2-availability-option" }, [
        node("input", { type: "radio", name: "status", value, checked: current.status === value }),
        node("span", { className: `v2-availability-option-dot is-${value}`, "aria-hidden": "true" }),
        node("span", { text: label }),
        node("span", { className: "v2-availability-option-check", "aria-hidden": "true", text: "✓" }),
      ])),
  ]);
  const selectedStatus = () => status.querySelector('input[name="status"]:checked')?.value || current.status;
  const date = node("input", { type: "date", name: "nextAvailable", "aria-label": "Available again", value: current.next || "", min: newYorkDateOnly(), "data-v2-availability-date": "" });
  const dateRow = node("label", { className: "ph-field", hidden: current.status !== "unavailable", "data-v2-availability-date-row": "" }, [node("span", { text: "Available again (optional)" }), date]);
  date.disabled = current.status !== "unavailable";
  const error = node("p", { className: "ph-form-error", role: "alert", hidden: true });
  const reload = button("Refresh Home", () => { trigger.disabled = true; close(); retry(); }, "ph-secondary", { hidden: true });
  const save = node("button", { type: "submit", className: "ph-primary", text: "Save", "aria-label": "Save availability", "data-v2-availability-save": "", disabled: !status.querySelector('input[name="status"]:checked') });
  let pending = false;
  let restoreFocus = true;
  const close = ({ focus = true } = {}) => { if (!pending) { restoreFocus = focus; dialog.close(); } };
  const form = node("form", {}, [
    status, dateRow, error, reload,
    node("div", { className: "ph-dialog-footer" }, [button("Cancel", () => close(), "ph-secondary", { "data-v2-availability-cancel": "" }), save]),
  ]);
  dialog.append(form);
  status.addEventListener("change", () => { dateRow.hidden = selectedStatus() !== "unavailable"; date.disabled = dateRow.hidden; save.disabled = false; position(); });
  const position = () => {
    if (!dialog.open) return;
    const anchor = trigger.getBoundingClientRect();
    const size = dialog.getBoundingClientRect();
    const gutter = 12;
    const below = anchor.bottom + 8;
    const above = anchor.top - size.height - 8;
    dialog.style.left = `${Math.max(gutter, Math.min(anchor.right - size.width, window.innerWidth - size.width - gutter))}px`;
    dialog.style.top = `${Math.max(gutter, Math.min(below + size.height <= window.innerHeight - gutter || above < gutter ? below : above, window.innerHeight - size.height - gutter))}px`;
  };
  const onOutside = event => { if (!dialog.contains(event.target) && !trigger.contains(event.target)) close({ focus: false }); };
  const focusableControls = () => [...dialog.querySelectorAll('input, button, select, textarea, a[href], [tabindex]')]
    .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length
      && (element.type !== "radio" || element.checked || ![...dialog.querySelectorAll('input[type="radio"]')]
        .some(radio => radio.name === element.name && radio.checked)));
  let reverseNavigation = false;
  const onFocusIn = event => {
    if (!dialog.open || dialog.contains(event.target)) return;
    // Native sequential navigation can skip visually hidden radio controls.
    // Keep its date-field navigation intact while containing any focus escape.
    const controls = focusableControls();
    (reverseNavigation ? controls.at(-1) : controls[0])?.focus({ preventScroll: true });
  };
  const onKeydown = event => {
    if (!dialog.open) return;
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    reverseNavigation = event.shiftKey;
    const controls = focusableControls();
    const first = controls[0], last = controls.at(-1), active = document.activeElement;
    if (!first) { event.preventDefault(); dialog.focus({ preventScroll: true }); return; }
    if (!dialog.contains(active) || active === dialog || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    }
  };
  const onScroll = event => { if (!dialog.contains(event.target)) position(); };
  dialog.addEventListener("close", () => {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", position);
    trigger.setAttribute("aria-expanded", "false");
    dialog.remove();
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  });
  dialog.openAtTrigger = () => {
    dialog.show();
    trigger.setAttribute("aria-expanded", "true");
    position();
    dialog.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", position);
  };
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (pending || !isValid() || !form.reportValidity()) return;
    pending = true; save.disabled = true; save.textContent = "Saving…"; error.hidden = true; reload.hidden = true;
    status.querySelectorAll("input").forEach(input => { input.disabled = true; }); date.disabled = true;
    try {
      const value = selectedStatus();
      const payload = await saveAvailability(api, { ownerId: userId, profile: snapshot.profile.value, status: value, nextAvailable: value === "unavailable" && date.value ? date.value : null, isCurrent: isValid });
      if (!isValid()) { dialog.close(); return; }
      const profile = { ...snapshot.profile.value, availability: payload.availability, availabilityDetails: payload.availabilityDetails };
      snapshot.profile = { available: true, value: profile };
      onSaved(profile); pending = false; dialog.close(); showToast?.("Availability updated.");
    } catch (failure) {
      if (failure.code === "ACCOUNT_CHANGED") { dialog.close(); onSessionLost?.(); return; }
      if (isValid()) { error.textContent = failure.message || "Availability could not be updated."; error.hidden = false; reload.hidden = !["ACCOUNT_CHANGED", "ACCOUNT_CONFLICT", "AVAILABILITY_UNCONFIRMED"].includes(failure.code); }
    } finally {
      pending = false; save.disabled = false; status.querySelectorAll("input").forEach(input => { input.disabled = false; }); date.disabled = selectedStatus() !== "unavailable"; save.textContent = "Save";
    }
  });
  return dialog;
}

function content(snapshot, api, actions) {
  // A second user-scoped projection must agree before partial Home reads paint.
  const safeSnapshot = snapshot.profile?.available ? snapshot : Object.fromEntries(SOURCE_NAMES.map(name => [name, name === "profile" ? snapshot.profile : { available: false, state: snapshot.profile?.state === "loading" ? "loading" : "restricted", value: null }]));
  const model = buildHomeModel(safeSnapshot, { userId: actions.userId });
  actions.snapshot = safeSnapshot;
  const host = node("div", { className: "ph-content" });
  const availability = model.availability;
  const trigger = button(availability.label || "Availability unavailable", () => {
    const existing = document.getElementById("v2-availability-dialog");
    if (existing?.open) { existing.close(); return; }
    const dialog = availabilityDialog(buildHomeModel(snapshot, { userId: actions.userId }), snapshot, api, actions, trigger);
    document.body.append(dialog);
    dialog.openAtTrigger();
  }, "ph-availability", { "data-v2-availability-trigger": "", "aria-haspopup": "dialog", "aria-controls": "v2-availability-dialog", "aria-expanded": "false", disabled: !model.sources.profile.complete });
  paintAvailabilityTrigger(trigger, availability);
  // The workspace renderer reuses these controls when it builds the selected view.
  // Do not build a second, discarded Home layout before that render.
  host.append(trigger);
  if (model.profileTodos.length) host.append(node("aside", { className: "ph-readiness ph-profile-todos", "aria-label": "Profile to-dos" }, [
    node("h3", { text: "Complete your profile" }),
    ...model.profileTodos.map(item => node("div", { className: "ph-readiness-item" }, [node("div", {}, [node("h4", { text: item.title }), node("p", { text: item.detail })]), link(item.actionLabel, item.href)])),
  ]));
  const setup = readiness(model, actions);
  if (setup) host.append(setup);
  enhanceHomeDesktop({ host, model, actions, node, link, button, shortDate });
  return host;
}

export function createHomeView({ api, showToast, updateIdentity, getIdentity = () => null, requestRefresh, renderWorkContext, markNotificationRead, onSessionLost } = {}) {
  if (!api) throw new TypeError("Home requires the shared API client.");
  let cachedSnapshot = null, cachedAt = 0, cacheRevision = 0;
  let currentRoot = null, currentUser = "", controller = null, pendingContent = null, paintTimer = null;
  let sessionRevision = 0, explicitRefresh = false;
  const desktopHistory = new Map();
  const deadlineReads = new Map();
  let deadlineController = new AbortController();
  let desktop = { view: "overview", selected: "", search: "", sort: "priority", board: false }, desktopRoute = "";
  const key = () => String(getIdentity()?.id || getIdentity()?._id || "");
  function loadDeadlines(ownerId, range, { force = false } = {}) {
    const rangeKey = `${ownerId}:${range.start}:${range.end}`;
    if (!force && deadlineReads.has(rangeKey)) return deadlineReads.get(rangeKey);
    const request = new AbortController(), parent = deadlineController.signal;
    const cancel = () => request.abort();
    if (parent?.aborted) cancel();
    parent?.addEventListener("abort", cancel, { once: true });
    const timer = window.setTimeout(cancel, 30_000);
    const value = loadHomeDeadlines(api, ownerId, range, { signal: request.signal, isCurrent: () => ownerId === key() })
      .catch(error => { if (deadlineReads.get(rangeKey) === value) deadlineReads.delete(rangeKey); throw error; })
      .finally(() => { window.clearTimeout(timer); parent?.removeEventListener("abort", cancel); });
    deadlineReads.set(rangeKey, value);
    return value;
  }
  const interacting = () => {
    if (currentRoot?.isConnected && currentRoot.dataset.homeLoading === "true") {
      // Disabled loading controls cannot retain an abandoned read. Protect real
      // input and open overlays while allowing its verified replacement to load.
      return Boolean(currentRoot.contains(document.activeElement) && document.activeElement.matches("input,select,textarea,[contenteditable=true]") || document.querySelector("dialog[open], .support-drawer[aria-hidden='false'], [data-v2-search-panel]:not([hidden]), [data-v2-notifications-panel]:not([hidden])"));
    }
    return Boolean(currentRoot?.isConnected && ((currentRoot.contains(document.activeElement) && !document.activeElement.closest("[data-home-refresh-notice]")) || currentRoot.querySelector(".ld-row:hover, .ld-card:hover, .ld-queue-row:hover, .ld-detail:hover, .lc-context:hover, .ph-matter:hover, .ph-opportunity-row:hover, .ph-inbox-row:hover, .ph-desktop-detail:hover, .ph-timeline:hover, .ph-availability:hover, .ph-link:hover, .ph-primary:hover") || currentRoot.dataset.homeLoading !== "true" && document.querySelector("dialog[open], .support-drawer[aria-hidden='false'], [data-v2-search-panel]:not([hidden]), [data-v2-notifications-panel]:not([hidden])")))
  };
  function setRefreshNotice(text = "Updates available. Refresh when you’re ready.") {
    const notice = currentRoot?.querySelector("[data-home-refresh-notice]");
    if (notice) { notice.hidden = false; notice.querySelector("span").textContent = text; }
  }
  function flush({ explicit = false } = {}) {
    if (!pendingContent || !currentRoot) return;
    const editing = document.querySelector("dialog[data-v2-route-dialog][open]") || currentRoot.contains(document.activeElement) && document.activeElement.matches("input,select,textarea,[contenteditable=true]");
    // A progressive loading paint has no settled controls to preserve. Let its
    // verified result replace the placeholder even when the pointer is over a
    // disabled control; otherwise that control can strand the pending result.
    const retainInteraction = currentRoot.dataset.homeLoading !== "true" && interacting();
    if (editing || (!explicit && !explicitRefresh && retainInteraction)) { setRefreshNotice(); return; }
    const { snapshot, actions } = pendingContent;
    if (!actions.isValid()) { pendingContent = null; return; }
    const opened = new Set([...currentRoot.querySelectorAll("details[open]")].map(el => el.querySelector("summary")?.textContent));
    const previousContent = currentRoot.querySelector(".ph-content");
    if (previousContent?.querySelector(".lc-list")) desktop.listScroll = previousContent.querySelector(".lc-list").scrollTop;
    const next = content(snapshot, api, actions);
    next.querySelectorAll("details").forEach(el => { if (opened.has(el.querySelector("summary")?.textContent)) el.open = true; });
    const old = currentRoot.querySelector(".ph-content");
    old?.__workspaceDispose?.();
    old?.replaceWith(next);
    currentRoot.dataset.homeLoading = String(SOURCE_NAMES.some(name => snapshot[name]?.state === "loading"));
    currentRoot.dataset.homeFreshness = "current";
    currentRoot.querySelector("[data-home-refresh-notice]").hidden = true;
    // One requested refresh includes every source in that read. An early
    // partial paint must not consume it while the profile is still pending.
    if (currentRoot.dataset.homeLoading === "false") explicitRefresh = false;
    pendingContent = null;
  }
  function queuePaint(snapshot, actions) {
    if (!actions.isValid()) return;
    pendingContent = { snapshot: { ...snapshot }, actions };
    window.clearTimeout(paintTimer);
    paintTimer = window.setTimeout(() => flush(), 40);
  }
  function invalidate() {
    if (currentRoot?.isConnected && currentRoot.dataset.homeLoading === "false") {
      setRefreshNotice("Refreshing Home. Displayed records may have changed.");
      currentRoot.querySelectorAll("[data-payout-totals]").forEach(value => value.replaceWith(renderEarningsReport(null)));
      currentRoot.dataset.homeFreshness = "stale";
    }
    cacheRevision += 1; controller?.abort(); controller = null; cachedSnapshot = null; cachedAt = 0; pendingContent = null;
    deadlineController.abort(); deadlineController = new AbortController(); deadlineReads.clear();
  }
  return Object.freeze({
    createLoadingView() { return node("section", { className: "v2-home ph-home", "aria-label": "Loading Home" }, [node("p", { role: "status", text: "Loading your work…" })]); },
    async render({ route, force = false, isCurrent = () => true, onRetry } = {}) {
      const userId = key();
      if (currentUser !== userId) { explicitRefresh = false; invalidate(); sessionRevision += 1; currentRoot?.replaceChildren(); currentRoot = null; currentUser = userId; desktopHistory.clear(); desktop = { view: "overview", selected: "", search: "", sort: "priority", board: false }; desktopRoute = ""; }
      const routeChanged = Boolean(route && route.key !== desktopRoute);
      if (routeChanged) {
        if (desktopRoute) {
          currentRoot?.querySelector('.ph-content')?.__workspaceDispose?.();
          desktopHistory.set(desktopRoute, {...desktop});
        }
        desktopRoute = route.key;
        desktop.view = homeDesktopView(route.query?.get("view"));
        desktop.selected = route.query?.get("item") || "";
        desktop.search = "";
        desktop.tab = route.query?.get("tab") || ""; desktop.tabChosen = Boolean(desktop.tab); desktop.board = false; desktop.returned = false; desktop.displayOpen = false; desktop.filterOpen = false; desktop.unreadOnly = false; desktop.listScroll = 0;
        if (desktopHistory.has(desktopRoute)) Object.assign(desktop, desktopHistory.get(desktopRoute));
      }
      const session = sessionRevision;
      const valid = () => isCurrent() && session === sessionRevision && userId === key();
      const retry = () => { explicitRefresh = true; invalidate(); onRetry?.(); };
      const actions = { userId, retry, onSessionLost, showToast, isValid: valid, desktop,
        snapshot: null,
        renderWorkContext: options => renderWorkContext?.({ ...options, isValid: () => valid() && (!options.isValid || options.isValid()), onChanged: retry }),
        markNotificationRead: item => valid() && markNotificationRead?.(item),
        loadMatter: (id, signal) => api.get(`/api/cases/${encodeURIComponent(id)}`, { signal }),
        loadDeadlines: (range, options) => loadDeadlines(userId, range, options),
        downloadFile: async (matterId, file, signal) => {
          const blob = await api.blob(fileHref(matterId, file.id || file._id), { signal, headers: { Accept: "application/octet-stream" } });
          if (!valid() || signal.aborted) return;
          triggerDownload(blob, file.originalName || file.original || file.filename || 'Matter file');
        },
        onSaved(profile) {
          if (!valid()) return;
          updateIdentity?.(profile);
          const label = currentRoot?.querySelector("[data-v2-availability-trigger]");
          const result = buildHomeModel({ profile: { available: true, value: profile } }, { userId }).availability;
          if (label) paintAvailabilityTrigger(label, result);
          requestRefresh?.();
        },
        async stripe(event) {
          const target = event.currentTarget;
          if (target.disabled || !valid()) return;
          target.disabled = true; const label = target.textContent; target.textContent = "Opening Stripe…";
          try { await startStripeOnboarding(); }
          catch (error) { if (valid()) { target.disabled = false; target.textContent = label; showToast?.(error.message || "Unable to open Stripe. Try again."); } }
        },
      };
      if (!currentRoot?.isConnected) {
        currentRoot = node("section", { className: "v2-home ph-home", "data-v2-home": "", "data-home-loading": "true" });
        currentRoot.append(node("div", { className: "ph-refresh-notice", hidden: true, "data-home-refresh-notice": "" }, [
          node("span", { role: "status", text: "Updates available." }), button("Refresh Home", () => { if (pendingContent) flush({ explicit: true }); else retry(); }),
        ]));
        currentRoot.addEventListener("pointerleave", () => flush());
        currentRoot.addEventListener("focusout", () => window.setTimeout(() => flush(), 0));
      }
      const cached = !force && cachedSnapshot && Date.now() - cachedAt < HOME_CACHE_TTL_MS;
      const snapshot = cached ? cachedSnapshot : Object.fromEntries(SOURCE_NAMES.map(name => [name, { available: false, value: null, state: "loading" }]));
      if (!currentRoot.querySelector(".ph-content")) {
        currentRoot.append(content(snapshot, api, actions));
        currentRoot.dataset.homeLoading = String(SOURCE_NAMES.some(name => snapshot[name]?.state === "loading"));
      }
      else if (routeChanged) {
        // Navigation is an explicit change of view. Refreshes defer around
        // editing, but browser Back must not leave the previous filtered view
        // visible under the newly committed route.
        window.clearTimeout(paintTimer); pendingContent = null;
        currentRoot.querySelector(".ph-content").__workspaceDispose?.();
        currentRoot.querySelector(".ph-content").replaceWith(content(snapshot, api, actions));
        currentRoot.dataset.homeLoading = String(!cached);
      } else if (cached) queuePaint(snapshot, actions);
      // queuePaint marks the rendered state when it actually commits. A cached
      // response must not mark an older loading placeholder as finished first.
      if (cached) return currentRoot;
      invalidate();
      const revision = cacheRevision;
      controller = new AbortController();
      const requestController = controller;
      const requestOptions = { signal: requestController.signal };
      const timer = window.setTimeout(() => requestController.abort("timeout"), HOME_REQUEST_TIMEOUT_MS);
      const read = operation => readHomeSource(operation, requestOptions.signal);
      const requests = [read(() => api.get(`/api/paralegal/dashboard?expectedOwnerId=${encodeURIComponent(userId)}`, requestOptions)), read(() => api.get("/api/users/me", requestOptions)), read(() => api.get("/api/payments/connect/status", requestOptions)), read(() => api.get("/api/jobs/recommended", requestOptions)), read(() => loadReceivedInvitations(api, userId, { ...requestOptions, isCurrent: () => valid() && revision === cacheRevision })), read(() => loadDeadlines(userId, deadlineTimelineRange(newYorkDateOnly(new Date()), desktop.timelinePeriod || 0, 6))), read(() => api.get("/api/messages/threads?limit=50", requestOptions)), read(() => api.get("/api/messages/unread-count", requestOptions)), read(() => api.get("/api/applications/my", requestOptions)), read(() => api.get("/api/notifications", requestOptions))];
      requests.push((async () => {
        const [dashboard, profile] = await Promise.all([requests[0], requests[1]]);
        if (!valid() || revision !== cacheRevision) throw new Error('View changed');
        const verified = buildHomeModel({ dashboard: {available:true,value:dashboard}, profile:{available:true,value:profile} }, {userId});
        const matters = {}, queue = verified.activeWork.filter(row=>row.workspaceReady);
        await Promise.all(Array.from({length:Math.min(4,queue.length)}, async () => {
          while(queue.length && valid() && !requestController.signal.aborted) {
            const row=queue.shift();
            try { const value=await api.get(`/api/uploads/case/${encodeURIComponent(row.id)}?presentation=matter`,requestOptions); matters[row.id]={state:Array.isArray(value?.files)?'ready':'unavailable',value}; }
            catch(error) { if(Number(error.status)===401) throw error; matters[row.id]={state:[403,404].includes(Number(error.status))?'restricted':'unavailable',value:null}; }
          }
        }));
        return {matters};
      })());
      void Promise.allSettled(requests.map(async (request, index) => {
        const name = SOURCE_NAMES[index];
        try { snapshot[name] = { available: true, value: await request }; }
        catch (error) { snapshot[name] = { available: false, value: null, error }; }
        if (valid() && revision === cacheRevision) queuePaint(snapshot, actions);
      })).then(() => {
        window.clearTimeout(timer);
        if (!valid() || revision !== cacheRevision) return;
        snapshot.loadedAt = Date.now(); cachedSnapshot = snapshot;
        cachedAt = SOURCE_NAMES.every(name => snapshot[name].available) ? Date.now() : 0;
        queuePaint(snapshot, actions);
      });
      return currentRoot;
    },
    invalidate,
    deferRefresh: setRefreshNotice,
    hasInteraction: interacting,
    clearProtected() {
      sessionRevision += 1; invalidate(); window.clearTimeout(paintTimer);
      currentRoot?.querySelector(".ph-content")?.__workspaceDispose?.();
      currentRoot?.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
      currentRoot?.replaceChildren(node("p", { role: "status", text: "Verifying workspace access…" })); currentRoot = null; currentUser = ""; desktopHistory.clear();
      document.querySelector("[data-v2-desktop-matters]")?.replaceChildren();
      document.querySelectorAll("[data-workspace-count]").forEach(count => count.remove());
      desktop.selected = ""; desktop.search = ""; desktopRoute = "";
    },
    getCachedSnapshot() { return cachedSnapshot; },
  });
}
