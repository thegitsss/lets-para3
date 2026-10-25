import { confirmAction } from "./dialogs.js";
import { createNotificationInbox } from "./notification-inbox.mjs";

const POLL_INTERVAL_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;
const SYNC_STORAGE_PREFIX = "lpc-v2-notifications-sync:";
const notificationId = item => String(item?.id || item?._id || "").trim();
const isRead = item => item?.isRead === true || item?.read === true;
const canceled = () => new DOMException("Canceled", "AbortError");

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) element.append(child instanceof Node ? child : String(child));
  return element;
}

function relativeTime(value) {
  const timestamp = new Date(value || 0).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const seconds = Math.round((timestamp - Date.now()) / 1000), absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
  if (absolute < 604800) return formatter.format(Math.round(seconds / 86400), "day");
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function validPage(value) {
  return value && Array.isArray(value.items) && value.items.length <= 100
    && value.items.every(item => item && typeof item === "object" && /^[a-f\d]{24}$/i.test(notificationId(item)) && typeof item.message === "string")
    && new Set(value.items.map(notificationId)).size === value.items.length
    && typeof value.hasMore === "boolean"
    && (value.hasMore ? typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.items.length > 0 : value.nextCursor === null);
}

// Both workspaces share account isolation, pagination, read state and recovery.
// Each supplies its existing API transport and role-specific destination adapter.
export function createNotificationCenter({ api: transport, panel, content, actions, badge, trigger, showToast, onChange, onRefresh, destinationFor, navigate, refinePresentation = false, feed = false, background = true, feedHref = "" }) {
  const lifetime = new AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...(typeof options === "boolean" ? {capture:options} : options), signal: lifetime.signal });
  const expanded = new Set();
  let category = "";
  let items = [], authoritativeUnread = null, userId = "", identityGeneration = 0;
  let cursorStack = [null], nextCursor = null, unreadOnly = false;
  let loadController, loadSequence = 0, refreshTimer, pollingTimer, reconnectTimer, eventSource, channel;
  let stopped = true, loading = false, mutating = false, unavailable = false, renderedState = "";
  let navigationGeneration = 0, pendingFocus = null;
  let loadInFlight = false, documentDeparting = false;
  const requests = new Set(), pendingSignalTypes = new Set();
  panel.classList.add("lpc-notification-center");
  actions.classList.add("lpc-notification-actions");
  const current = ticket => !stopped && !documentDeparting && ticket === identityGeneration;
  const unreadCount = () => authoritativeUnread;
  const grouped = refinePresentation && !feed;
  const inbox = grouped ? createNotificationInbox({
    api: transport, panel, owner: () => userId,
    isCurrent: () => !stopped && !documentDeparting,
    markRead: async rows => {
      if (!rows.length) return;
      const ticket = identityGeneration;
      try {
        for (const item of rows) {
          if (!current(ticket)) return;
          const result = await ownedRequest(`/api/notifications/${notificationId(item)}/read`, { method: 'POST' });
          if (result?.success !== true) throw new Error('Read state unconfirmed');
        }
        if (current(ticket)) { publishSync('read'); await load({ reason: 'read' }); }
      } catch { if (current(ticket)) showToast?.('Read state could not be confirmed. Try again.'); }
    },
    markUnread: item => void mutate(`/api/notifications/${notificationId(item)}/unread`, 'POST', 'read-state'),
    dismiss: item => void dismiss(item),
    navigate, destinationFor, timeLabel: relativeTime, deferRead: () => unreadOnly,
  }) : null;
  if (grouped) {
    panel.classList.add('lpc-grouped-inbox');
    const heading = panel.querySelector('h2');
    if (heading) heading.textContent = 'Inbox';
  }

  async function ownedRequest(path, { method = "GET", signal } = {}) {
    const ownerId = userId, ticket = identityGeneration, controller = new AbortController();
    if (!ownerId || !current(ticket)) throw canceled();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    requests.add(controller);
    const timeout = window.setTimeout(abort, 30_000);
    try {
      if (controller.signal.aborted) throw canceled();
      let result;
      if (method === "GET") {
        const separator = path.includes("?") ? "&" : "?";
        result = await transport.get(`${path}${separator}expectedOwnerId=${encodeURIComponent(ownerId)}`, { signal: controller.signal });
      } else if (transport.mutateNotification) {
        result = await transport.mutateNotification(path, method, { ownerId, signal: controller.signal });
      } else {
        result = await transport.request(path, { method, signal: controller.signal, body: JSON.stringify({ expectedOwnerId: ownerId }) });
      }
      if (!current(ticket) || controller.signal.aborted) throw canceled();
      return result;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      requests.delete(controller);
    }
  }

  function syncBadge() {
    badge.hidden = stopped || authoritativeUnread === 0;
    badge.textContent = authoritativeUnread === null ? "!" : authoritativeUnread > 99 ? "99+" : String(authoritativeUnread);
    trigger.setAttribute("aria-label", authoritativeUnread === null && !stopped ? "View notifications, unread count unavailable" : authoritativeUnread ? `View notifications, ${authoritativeUnread} unread` : "View notifications");
  }

  function button(text, key, action, disabled = false) {
    // Keep the focused control reachable while its request is in flight.
    const element = node("button", { type: "button", text, "data-notification-focus": key, "aria-disabled": disabled ? "true" : null });
    element.addEventListener("click", event => { if (element.getAttribute("aria-disabled") !== "true") action(event); });
    return element;
  }

  function renderActions() {
    const optionsOpen = actions.querySelector(".lpc-notification-options")?.open || false;
    actions.replaceChildren();
    if (stopped) return;
    const filters = node("div", { className: "lpc-notification-filters", role: "group", "aria-label": "Filter notifications" });
    for (const [value, text] of [[false, "All"], [true, "Unread"]]) {
      if (!grouped && !feed && refinePresentation && value && authoritativeUnread === 0 && !unavailable) {
        filters.append(node("span", { className: "lpc-notification-caught-up", role: "status", text: "Caught up" }));
        continue;
      }
      const label = !feed && refinePresentation && value && authoritativeUnread > 0 ? `Unread (${authoritativeUnread})` : text;
      const filter = button(label, `filter:${value}`, () => {
        if (loading || mutating || unreadOnly === value) return;
        unreadOnly = value; cursorStack = [null]; nextCursor = null;
        void load({ announce: true, reason: "filter" });
      }, loading || mutating);
      filter.setAttribute("aria-pressed", String(unreadOnly === value)); filters.append(filter);
    }
    if (grouped) {
      const filterMenu = node('details', {className:'nc-filter-menu'});
      const filterToggle = node('summary', {'aria-label':'Filter inbox','data-notification-focus':'inbox-filter'});
      const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
      icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');
      const lines = document.createElementNS(icon.namespaceURI,'path');lines.setAttribute('d','M3 6h18M6 12h12M9 18h6');icon.append(lines);
      filterToggle.append(icon);filterMenu.append(filterToggle,filters);actions.append(filterMenu);
    } else actions.append(filters);
    if (feed) {
      const select = node('select', { 'aria-label': 'Update category', 'data-notification-focus': 'category' });
      for (const [value, label] of [['','All categories'],['matters','Matters'],['applications','Applications & invitations'],['documents','Documents'],['payments','Payments'],['messages','Messages'],['account','Account']]) {
        const option = node('option', { value, text: label }); option.selected = category === value; select.append(option);
      }
      select.disabled = loading || mutating;
      select.addEventListener('change', () => { category = select.value; cursorStack = [null]; nextCursor = null; void load({announce:true,reason:'filter'}); });
      actions.append(select);
      if (category) {
        const applied = node('div',{className:'lpc-applied-filters','aria-label':'Applied update filters'});
        const remove = button(`${select.selectedOptions[0].textContent} ×`,'remove-category',()=>{category='';cursorStack=[null];nextCursor=null;void load({announce:true,reason:'filter'});},loading||mutating);
        remove.className='lpc-filter-chip';remove.setAttribute('aria-label',`Remove category: ${select.selectedOptions[0].textContent}`);applied.append(remove);actions.append(applied);
      }
    } else if (feedHref) {
      const all = node('a', {className:'lpc-all-updates', href:feedHref, text:'All updates'});
      all.addEventListener('click', event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigationGeneration += 1;
        panel.hidden = true; trigger.setAttribute('aria-expanded','false');
        navigate({href:feedHref,internal:true});
        document.querySelector('.lpc-updates-page h1')?.focus({preventScroll:true});
      });
      actions.append(all);
    }
    let bulk = actions;
    if (refinePresentation) {
      const options = node('details', { className: 'lpc-notification-options', ...(optionsOpen ? { open: true } : {}) });
      const toggle = node('summary', { 'aria-label': 'Notification options', 'data-notification-focus': 'options', title: 'Notification options' });
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z');
      const circle = document.createElementNS(svg.namespaceURI, 'circle');circle.setAttribute('cx','12');circle.setAttribute('cy','12');circle.setAttribute('r','3');
      svg.append(path,circle);
      if (grouped) toggle.textContent = '•••';
      else toggle.append(svg);
      bulk = node('div', { className: 'lpc-notification-options-content' });
      options.append(toggle, bulk);actions.append(options);
      if (grouped) {
        const all = actions.querySelector('.lpc-all-updates');
        if(all) bulk.append(all);
      }
    }
    if (!unavailable && authoritativeUnread > 0) bulk.append(button("Mark all as read", "read-all", () => void markAll(), loading || mutating));
    if (!unavailable && (items.length || cursorStack.length > 1)) bulk.append(button(refinePresentation ? "Dismiss all" : "Clear all", "clear-all", () => void clearAll(), loading || mutating));
    if (refinePresentation && !bulk.children.length) bulk.append(node('p', {text:unavailable ? 'Notifications unavailable' : 'No actions available'}));
  }

  function notificationRow(item) {
    const id = notificationId(item), destination = destinationFor(item);
    // Only the recipient-safe presentation name is available here. Do not fetch
    // a current profile or reuse an unverified image stored in an old event.
    const actor = typeof item.actorFirstName === "string" ? item.actorFirstName.trim().slice(0, 80) : "";
    const initials = actor.split(/\s+/u).filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join("").toLocaleUpperCase();
    const timestamp = new Date(item.createdAt || 0).getTime();
    const validTimestamp = Number.isFinite(timestamp) && timestamp > 0;
    const headline = refinePresentation ? item.headline || item.message : item.message;
    const contextLabel = refinePresentation ? item.contextLabel || item.context?.matterTitle || "Account" : "";
    const marker = node("span", { className: "v2-notification-dot", "aria-hidden": "true" });
    const body = node(destination ? "a" : "button", {
      className: "v2-notification-body", "data-notification-focus": `open:${id}`,
      ...(destination ? { href: destination.href } : { type: "button" }),
      "aria-label": `${item.message}${isRead(item) ? "" : ", unread"}`,
    }, [
      initials || refinePresentation ? node("span", { className: "lpc-notification-avatar", "aria-hidden": "true" }, [initials || "L", marker]) : marker,
      node("span", { className: "v2-notification-copy" }, [
        node("strong", { text: headline }),
        node('span', { className: 'lpc-notification-meta' }, [
          contextLabel ? node('span', {text:contextLabel, title:contextLabel}) : null,
          contextLabel && validTimestamp ? node('span', {text:' · ', 'aria-hidden':'true'}) : null,
          validTimestamp ? node("time", { text: relativeTime(timestamp), datetime: new Date(timestamp).toISOString(), title: new Date(timestamp).toLocaleString() }) : null,
        ]),
      ]),
      destination ? node("span", { className: "v2-notification-action", text: item.action?.label || "Open", "aria-hidden": "true" }) : null,
    ]);
    if (feed) {
      body.classList.add('lpc-update-link');
      const context = item.contextLabel || item.context?.matterTitle || '';
      const headline = item.headline || item.message;
      const paths = /payout|payment|fund|budget|escrow|refund/.test(item.type) ? 'M3 5h18v14H3zM3 10h18M7 15h3' : /(?:^|_)(?:files?|documents?|submissions?|revisions?)(?:_|$)/.test(item.type) ? 'M6 3h8l5 5v13H6zM14 3v5h5M9 12h7M9 16h7' : /message/.test(item.type) ? 'M4 4h16v12H9l-5 4z' : /application|invite/.test(item.type) ? 'M8 4h12v16H4V8M8 2v6H2M8 13h8M8 17h5' : 'M3 7h7l2 2h9v12H3z';
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
      const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',paths); svg.append(path);
      // Retain safe event details (for example the actual file name). Only
      // remove an exact repeated context at known sentence boundaries.
      let eventText = destination ? item.message : headline;
      if (context && destination) {
        for (const prefix of [`${context}: `, `${context} is `, `${context} `]) {
          if (eventText.startsWith(prefix)) { eventText = eventText.slice(prefix.length); break; }
        }
        for (const suffix of [` for ${context}`, ` to ${context}`, ` in ${context}`]) {
          if (eventText.endsWith(suffix + '.')) eventText = eventText.slice(0,-suffix.length-1);
          else if (eventText.endsWith(suffix)) eventText = eventText.slice(0,-suffix.length);
        }
        eventText = eventText.replace(` for ${context} `, ' ');
      }
      eventText = eventText ? eventText[0].toLocaleUpperCase() + eventText.slice(1) : headline;
      const primary = context || eventText;
      const copy = node('span',{className:'lpc-update-copy'},[
        node('strong',{text:primary}),
        context && context !== eventText ? node('span',{className:'lpc-update-event',text:eventText}) : null,
        node('span',{className:'lpc-update-meta'},[
          actor && !eventText.includes(actor) ? node('span',{text:actor}) : null,
          validTimestamp ? node('time',{datetime:new Date(timestamp).toISOString(),text:new Date(timestamp).toLocaleString(undefined,{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})}) : node('span',{text:'Date not recorded'}),
          !destination && item.available === false ? node('span',{text:'Destination unavailable'}) : null,
        ]),
        expanded.has(id) && !destination && item.message !== primary && item.message !== headline ? node('span',{className:'lpc-update-detail',text:item.message}) : null,
      ]);
      body.replaceChildren(node('span',{className:'lpc-update-icon'},[svg]),copy,marker);
      if (!destination) { body.setAttribute('aria-expanded',String(expanded.has(id))); }
    }
    body.addEventListener("click", event => {
      if (destination && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
      event.preventDefault();
      if (loading || mutating) return;
      if (feed && !destination) { expanded.has(id) ? expanded.delete(id) : expanded.add(id); render({force:true}); }
      void openItem(item, destination);
    });
    if (refinePresentation) {
      const menu = node("details", { className: "lpc-notification-row-options" });
      const toggle = node("summary", { text: "⋮", "aria-label": `Options: ${headline}`, title: "Notification actions", "data-notification-focus": `row-options:${id}` });
      const choose = action => {
        menu.open = false;
        toggle.focus({ preventScroll: true });
        action();
      };
      const controls = node("div", { className: "lpc-notification-row-menu" }, [
        button(isRead(item) ? "Mark as unread" : "Mark as read", `read-state:${id}`, () => choose(() => void mutate(`/api/notifications/${encodeURIComponent(id)}/${isRead(item) ? "unread" : "read"}`, "POST", "read-state")), loading || mutating),
        button("Dismiss notification", `dismiss:${id}`, () => choose(() => void dismiss(item)), loading || mutating),
      ]);
      menu.append(toggle, controls);
      toggle.addEventListener("click", event => {
        event.preventDefault();
        menu.open = !menu.open;
        if (!menu.open) return;
        panel.querySelectorAll("details[open]").forEach(other => { if (other !== menu) other.open = false; });
        const rect = toggle.getBoundingClientRect();
        const bounds = panel.getBoundingClientRect();
        controls.style.left = `${Math.max(bounds.left + 8, rect.right - controls.offsetWidth)}px`;
        const below=rect.bottom+4;
        const top=below+controls.offsetHeight<=window.innerHeight-8?below:rect.top-controls.offsetHeight-4;
        controls.style.top = `${Math.max(8,top)}px`;
      });
      return node("article", { className: `v2-notification${isRead(item) ? "" : " is-unread"}` }, [body, menu]);
    }
    const dismissButton = button("×", `dismiss:${id}`, () => void dismiss(item), loading || mutating);
    dismissButton.className = "v2-notification-dismiss";
    dismissButton.setAttribute("aria-label", `Dismiss: ${item.message}`);
    dismissButton.title = "Dismiss notification";
    return node("article", { className: `v2-notification${isRead(item) ? "" : " is-unread"}` }, [body, dismissButton]);
  }

  function notificationRows() {
    if (grouped) return inbox.render(items);
    if (feed) {
      const rows = []; let previous = '';
      for (const item of items) {
        const at = Date.parse(item.createdAt);
        const day = Number.isFinite(at) ? new Date(at).toLocaleDateString(undefined,{timeZone:'America/New_York',weekday:'long',month:'long',day:'numeric',year:'numeric'}) : 'Date not recorded';
        if (day !== previous) { rows.push(node('h2',{className:'lpc-updates-date',text:day})); previous = day; }
        rows.push(notificationRow(item));
      }
      return rows;
    }
    if (!refinePresentation) return items.map(notificationRow);
    // Group only adjacent, recipient-authorized updates in a five-minute window.
    // Keep every event, destination, read state, and dismiss control intact.
    const groups = [];
    for (const item of items) {
      const last = groups.at(-1), first = last?.[0];
      const at = new Date(item.createdAt).getTime(), start = new Date(first?.createdAt).getTime();
      const caseId = item.available === true && item.context?.caseId;
      if (caseId && first?.available === true && first.context?.caseId === caseId && Number.isFinite(at) && Number.isFinite(start) && Math.abs(start - at) <= 300000) last.push(item);
      else groups.push([item]);
    }
    return groups.map(group => group.length === 1 ? notificationRow(group[0]) : node('section', { className: 'lpc-notification-related', 'aria-label': `${group.length} related Matter updates` }, [
      group.every(item => item.headline && item.contextLabel) ? null : node('p', { className: 'lpc-notification-related-label', text: `${group.length} updates · ${group[0].context?.matterTitle || 'Same Matter'}` }),
      ...group.map(notificationRow),
    ]));
  }

  function render({ force = false } = {}) {
    syncBadge();
    const fingerprint = JSON.stringify({ items, authoritativeUnread, cursorStack, nextCursor, unreadOnly, category, stopped, loading, mutating, unavailable });
    if (!force && fingerprint === renderedState) {
      // Passing time does not change the response fingerprint. Update labels
      // without replacing the controls a person is reading or using.
      content.querySelectorAll("time[datetime]").forEach(element => { if (!feed && !element.hasAttribute('data-nc-compact-time')) element.textContent = relativeTime(element.getAttribute("datetime")); });
      return;
    }
    renderedState = fingerprint;
    const active = document.activeElement;
    const scrollPosition = content.scrollTop;
    const focused = panel.contains(active) ? active.dataset.notificationFocus : active === document.body ? pendingFocus : null;
    const textSelection = active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;
    pendingFocus = focused || null;
    const previousKeys = [...panel.querySelectorAll("[data-notification-focus]")].map(element => element.dataset.notificationFocus);
    renderActions();
    content.setAttribute("aria-busy", String(loading));
    if (stopped) content.replaceChildren();
    else if (unavailable) content.replaceChildren(node("div", { className: "v2-notifications-empty is-error", role: "status" }, [
      node("p", { text: feed ? "Updates are temporarily unavailable." : "Notifications are temporarily unavailable." }),
      button("Try again", "retry", () => void load({ announce: true }), loading),
      cursorStack.length > 1 ? button("Back to latest", "latest", () => { cursorStack = [null]; nextCursor = null; void load({ announce: true, reason: "page" }); }, loading) : null,
    ]));
    else if (loading && !items.length) content.replaceChildren(node("p", { className: "v2-notifications-loading", role: "status", text: feed ? "Loading updates…" : "Loading notifications…" }));
    else {
      const list = items.length ? node("div", { className: "v2-notifications-list" }, notificationRows()) : node("div", { className: "v2-notifications-empty" }, [node("p", { text: feed ? (cursorStack.length > 1 ? "No older updates in this view." : unreadOnly ? "No unread updates in this view." : category ? "No updates in this category." : "No updates yet.") : cursorStack.length > 1 ? "No older notifications." : unreadOnly ? (refinePresentation ? "You’re all caught up" : "No unread notifications.") : (refinePresentation ? "No notifications yet" : "No notifications.") })]);
      const pager = node("nav", { className: "lpc-notification-pagination", "aria-label": "Notification pages" });
      if (cursorStack.length > 1) {
        pager.append(button("Newer", "newer", () => { cursorStack.pop(); void load({ announce: true, reason: "page" }); }, loading || mutating));
        if (cursorStack.length > 2) pager.append(button("Latest", "latest", () => { cursorStack = [null]; void load({ announce: true, reason: "page" }); }, loading || mutating));
      }
      if (nextCursor) pager.append(button("Older", "older", () => { cursorStack.push(nextCursor); void load({ announce: true, reason: "page" }); }, loading || mutating));
      content.replaceChildren(list, pager);
      if (grouped) content.scrollTop = scrollPosition;
    }
    if (focused && !panel.hidden) {
      const candidates = [...panel.querySelectorAll("[data-notification-focus]")];
      const replacement = candidates.find(element => element.dataset.notificationFocus === focused)
        || candidates[Math.min(previousKeys.indexOf(focused), candidates.length - 1)];
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
      if (textSelection && replacement instanceof HTMLTextAreaElement) replacement.setSelectionRange(...textSelection);
      if (!loading && !mutating) pendingFocus = null;
    }
  }

  async function load({ announce = false, reason = "refresh", signalTypes = [] } = {}) {
    if (!userId || stopped || documentDeparting || mutating) return;
    // Polls and bursts of stream events must not keep restarting a slow request's
    // timeout. Explicit paging/filter/retry intent can replace that request.
    if (loadInFlight && !announce) {
      signalTypes.forEach(type => pendingSignalTypes.add(type));
      return;
    }
    const sequence = ++loadSequence, ticket = identityGeneration;
    loadInFlight = true;
    loadController?.abort();
    loadController = new AbortController();
    const previousFingerprint = JSON.stringify({ items, authoritativeUnread });
    // A routine background refresh preserves keyboard focus and the current page.
    if (announce) { loading = true; if (["page", "filter"].includes(reason)) items = []; render(); }
    try {
      const query = new URLSearchParams({ limit: "100" });
      if (unreadOnly) query.set("unread", "1");
      if (feed && category) query.set("category", category);
      if (cursorStack.at(-1)) query.set("cursor", cursorStack.at(-1));
      const [payload, countPayload] = await Promise.all([
        ownedRequest(`/api/notifications/page?${query}`, { signal: loadController.signal }),
        ownedRequest("/api/notifications/unread-count", { signal: loadController.signal }),
      ]);
      if (sequence !== loadSequence || !current(ticket)) return;
      if (!validPage(payload) || !Number.isSafeInteger(countPayload?.count) || countPayload.count < 0) throw new Error("Invalid notification response");
      items = payload.items; nextCursor = payload.nextCursor; authoritativeUnread = countPayload.count;
      if (!grouped && !feed && refinePresentation && unreadOnly && authoritativeUnread === 0) {
        unreadOnly = false; cursorStack = [null]; nextCursor = null; items = [];
        return load({ announce: true, reason: "filter" });
      }
      loading = false; unavailable = false; render();
      if (background && previousFingerprint !== JSON.stringify({items,authoritativeUnread})) window.dispatchEvent(new CustomEvent("lpc:notification-snapshot", {detail:{userId}}));
      if (previousFingerprint !== JSON.stringify({ items, authoritativeUnread }) || signalTypes.length || ["initial", "open"].includes(reason)) onChange?.({ reason, signalTypes: [...signalTypes], items: [...items], unread: unreadCount() });
    } catch (error) {
      if (sequence !== loadSequence || !current(ticket)) return;
      // Timeouts and failed refreshes must not masquerade as an empty center.
      loadController.abort(); loading = false; unavailable = true; items = []; authoritativeUnread = null;
      render();
      if (signalTypes.length) onChange?.({ reason: "external", signalTypes: [...signalTypes], unavailable: true });
    } finally {
      if (sequence === loadSequence && current(ticket)) {
        loadInFlight = false;
        if (pendingSignalTypes.size) scheduleLoad();
        // Other authorized projections can reconcile on this same stream and
        // polling cycle even when the notification records have not changed.
        onRefresh?.();
      }
    }
  }

  function scheduleLoad(event) {
    if (stopped || documentDeparting) return;
    if (typeof event?.data === "string") try { const type = String(JSON.parse(event.data)?.type || "").trim(); if (type) pendingSignalTypes.add(type); } catch {}
    if (refreshTimer || stopped) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      if (mutating) { scheduleLoad(); return; }
      const signalTypes = [...pendingSignalTypes]; pendingSignalTypes.clear();
      void load({ reason: "external", signalTypes });
    }, 120);
  }

  async function mutate(path, method, reason) {
    if (mutating || stopped) return false;
    const ticket = identityGeneration;
    mutating = true; loadSequence += 1; loadInFlight = false; loadController?.abort(); render();
    let confirmed = false;
    try {
      const result = await ownedRequest(path, { method });
      if (result?.success !== true) throw new Error("Invalid notification update response");
      confirmed = true; publishSync(reason);
    }
    catch (error) { if (current(ticket)) showToast?.("That update could not be confirmed. Refreshing notifications…"); }
    finally {
      if (current(ticket)) { mutating = false; await load({ reason }); }
    }
    return current(ticket) && confirmed;
  }

  async function openItem(item, destination) {
    const ticket = identityGeneration, navigationTicket = ++navigationGeneration;
    if (!current(ticket) || mutating) return false;
    const confirmed = isRead(item) || await mutate(`/api/notifications/${encodeURIComponent(notificationId(item))}/read`, "POST", "read");
    if (current(ticket) && navigationTicket === navigationGeneration && destination) navigate(destination);
    return current(ticket) && confirmed;
  }
  async function dismiss(item) { await mutate(`/api/notifications/${encodeURIComponent(notificationId(item))}`, "DELETE", "dismiss"); }
  async function markAll() { if (authoritativeUnread > 0) await mutate("/api/notifications/read-all", "POST", "read-all"); }
  async function clearAll() {
    const ticket = identityGeneration, navigationTicket = navigationGeneration;
    const confirmed = await confirmAction("This removes every notification, including older notifications.", { title: refinePresentation ? "Dismiss all notifications?" : "Clear all notifications?", confirmLabel: refinePresentation ? "Dismiss all" : "Clear all", tone: "danger" });
    if (!current(ticket) || navigationTicket !== navigationGeneration) return;
    if (confirmed) { cursorStack = [null]; await mutate("/api/notifications", "DELETE", "clear-all"); }
    // A live refresh can replace the launcher while the modal is open.
    if (current(ticket) && navigationTicket === navigationGeneration && !panel.hidden) {
      const key = refinePresentation ? 'options' : confirmed ? "filter:false" : "clear-all";
      (actions.querySelector(`[data-notification-focus="${key}"]`) || trigger).focus({ preventScroll: true });
    }
  }

  function startPolling() {
    if (!background || pollingTimer || stopped || documentDeparting) return;
    pollingTimer = window.setInterval(() => { if (document.visibilityState === "visible") scheduleLoad(); }, POLL_INTERVAL_MS);
  }
  function startStream() {
    if (!background || stopped || documentDeparting || eventSource || typeof EventSource !== "function") return;
    const ticket = identityGeneration, source = new EventSource("/api/notifications/stream");
    eventSource = source;
    source.addEventListener("open", () => { if (current(ticket)) scheduleLoad(); });
    source.addEventListener("notifications", event => { if (current(ticket)) scheduleLoad(event); });
    source.addEventListener("error", () => {
      if (eventSource !== source || !current(ticket)) return;
      source.close(); eventSource = null;
      reconnectTimer = window.setTimeout(() => { reconnectTimer = null; startStream(); }, RECONNECT_DELAY_MS);
    });
  }
  function suspendDocument() {
    documentDeparting = true; loadSequence += 1; loadInFlight = false;
    loadController?.abort(); loadController = null;
    requests.forEach(controller => controller.abort()); requests.clear();
    window.clearTimeout(refreshTimer); refreshTimer = null;
    window.clearInterval(pollingTimer); pollingTimer = null;
    window.clearTimeout(reconnectTimer); reconnectTimer = null;
    eventSource?.close(); eventSource = null;
    loading = false; mutating = false;
  }
  function resumeDocument() {
    if (!documentDeparting) return;
    documentDeparting = false;
    if (!stopped && userId) { scheduleLoad(); startPolling(); startStream(); }
  }
  const resumeFromInteraction = event => { if (event.isTrusted) resumeDocument(); };
  listen(window, "beforeunload", suspendDocument);
  listen(window, "pagehide", suspendDocument);
  listen(window, "pageshow", event => { if (event.persisted) resumeDocument(); });
  // A canceled departure resumes only on real interaction. A timer can run in
  // a document already accepted for navigation before its pagehide arrives.
  listen(document, "pointerdown", resumeFromInteraction, true);
  listen(document, "keydown", resumeFromInteraction, true);
  function publishSync(reason) {
    const detail = { userId, reason, at: Date.now() };
    try { channel?.postMessage(detail); } catch {}
    try { localStorage.setItem(`${SYNC_STORAGE_PREFIX}${userId}`, JSON.stringify(detail)); } catch {}
  }
  function stop() {
    inbox?.reset();
    stopped = true; identityGeneration += 1; loadSequence += 1; navigationGeneration += 1; pendingFocus = null; userId = "";
    loadController?.abort(); loadController = null;
    requests.forEach(controller => controller.abort()); requests.clear();
    window.clearTimeout(refreshTimer); refreshTimer = null;
    window.clearInterval(pollingTimer); pollingTimer = null;
    window.clearTimeout(reconnectTimer); reconnectTimer = null;
    eventSource?.close(); eventSource = null;
    channel?.close?.(); channel = null;
    items = []; authoritativeUnread = null; cursorStack = [null]; nextCursor = null;
    unreadOnly = false; loading = false; loadInFlight = false; mutating = false; unavailable = false;
    pendingSignalTypes.clear(); render();
  }
  function start(identity) {
    const nextUserId = String(identity?.id || "").trim();
    if (!nextUserId) { stop(); return; }
    if (!stopped && userId === nextUserId) return;
    stop(); userId = nextUserId; stopped = false;
    if (typeof BroadcastChannel === "function") try {
      channel = new BroadcastChannel(`${SYNC_STORAGE_PREFIX}${userId}`);
      channel.addEventListener("message", event => { if (event.data?.userId === userId) scheduleLoad(); });
    } catch { channel = null; }
    void load({ announce: true, reason: "initial" });
    startPolling(); startStream();
  }
  function open() { void load({ announce: unavailable || !items.length, reason: "open" }); }
  listen(panel, 'keydown', event => {
    const menu = panel.querySelector('.lpc-notification-row-options[open], .lpc-notification-options[open], .nc-filter-menu[open]');
    if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); menu.open = false; menu.querySelector('summary').focus(); }
  });
  listen(document, 'click', event => {
    panel.querySelectorAll('.lpc-notification-row-options[open], .lpc-notification-options[open], .nc-filter-menu[open]').forEach(menu => {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
  listen(content, "scroll", () => {
    content.querySelectorAll(".lpc-notification-row-options[open]").forEach(menu => { menu.open = false; });
  });
  listen(window, "resize", () => {
    inbox?.resize();
    content.querySelectorAll(".lpc-notification-row-options[open]").forEach(menu => { menu.open = false; });
  });
  listen(window, "storage", event => { if (userId && event.key === `${SYNC_STORAGE_PREFIX}${userId}`) scheduleLoad(); });
  listen(window, "lpc:notifications-refreshed", scheduleLoad);
  if (!background) listen(window, "lpc:notification-snapshot", event => { if (event.detail?.userId === userId) scheduleLoad(); });
  listen(window, "hashchange", () => { navigationGeneration += 1; });
  listen(window, "online", () => { if (!stopped) { scheduleLoad(); startStream(); } });
  listen(document, "visibilitychange", () => { if (document.visibilityState === "visible" && !stopped) { scheduleLoad(); startStream(); } });
  return Object.freeze({ start, stop, destroy: () => { stop(); lifetime.abort(); }, open, load, cancelNavigation: () => { navigationGeneration += 1; }, readInContext: item => openItem(item, null), getItems: () => [...items], unreadCount });
}
