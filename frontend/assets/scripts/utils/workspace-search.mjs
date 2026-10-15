const MIN_QUERY = 2, MAX_QUERY = 80, DEBOUNCE_MS = 260, DEADLINE_MS = 15000;
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const validId = value => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const validText = value => typeof value === "string" && value.length <= 2000;
const normalize = value => String(value || "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") element.textContent = value;
    else element.setAttribute(key, String(value));
  }
  element.append(...children.filter(Boolean));
  return element;
}

export function hasOpenSearchBlockingDialog() {
  return [...document.querySelectorAll("dialog[open], [role='dialog'][aria-modal='true']:not([hidden]):not([aria-hidden='true'])")]
    .some(element => element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
}

// Validate the entire read before displaying any part of it. A malformed or
// wrong-owner success is never an empty workspace or a partly trusted result.
export function projectSearchResults(payload, { ownerId, query, types, destinationFor, dashboardPresentation = false }) {
  if (!isObject(payload) || payload.ownerId !== ownerId || payload.query !== query || !Array.isArray(payload.types)
    || payload.types.length !== types.length || payload.types.some((type, index) => type !== types[index]) || !isObject(payload.results)) throw new Error("SEARCH_RESPONSE_INVALID");
  const seen = new Set();
  const project = (values, type) => {
    if (!Array.isArray(values) || values.length > 6 || (!types.includes(type) && values.length)) throw new Error("SEARCH_RESPONSE_INVALID");
    return values.map(value => {
      if (!isObject(value) || value.type !== type || !validId(value.id) || !validText(value.title) || !value.title.trim()
        || !isObject(value.nextAction) || !validText(value.nextAction.href) || seen.has(`${type}:${value.id}`)) throw new Error("SEARCH_RESPONSE_INVALID");
      seen.add(`${type}:${value.id}`);
      const destination = destinationFor(value);
      if (!destination?.href) throw new Error("SEARCH_RESPONSE_INVALID");
      let metadata;
      if (type === "matter") {
        if (!isObject(value.status) || !validText(value.status.label) || !validText(value.status.code)
          || !isObject(value.relationship) || !validText(value.relationship.label) || !validText(value.relationship.code)
          || !validText(value.practiceArea) || (value.attention != null && (!isObject(value.attention) || !validText(value.attention.label)))) throw new Error("SEARCH_RESPONSE_INVALID");
        metadata = [value.status.label, value.practiceArea, !dashboardPresentation && value.relationship.code === "owner" ? "" : value.relationship.label];
      } else {
        if (!validText(value.headline) || !validText(value.location) || !Array.isArray(value.practiceAreas) || value.practiceAreas.length > 3 || value.practiceAreas.some(item => !validText(item))) throw new Error("SEARCH_RESPONSE_INVALID");
        metadata = dashboardPresentation ? [value.headline, value.location] : [value.headline, ...value.practiceAreas, value.location];
      }
      const distinct = new Set([normalize(value.title).toLocaleLowerCase("en-US")]);
      const meta = metadata.map(normalize).filter(item => {
        const key = item.toLocaleLowerCase("en-US");
        if (!key || distinct.has(key)) return false;
        distinct.add(key); return true;
      }).join(" · ");
      return { title: value.title, meta, destination, kind: type };
    });
  };
  return { matters: project(payload.results.matters, "matter"), profiles: project(payload.results.profiles, "profile") };
}

export function createWorkspaceSearch({ api, panel, input, results, getIdentity, verifySession, onSessionLost,
  commands = [], types, destinationFor, prefix, inline = false, showInitialCommands = true, dashboardPresentation = false, routeAttribute = "" }) {
  let sequence = 0, debounce, controller, deadline, activeIndex = -1, scopedUserId = "", composing = false, lastPage = "";
  const list = node("div", { id: `${prefix}-options`, role: "listbox", "aria-label": "Search results", class: "lpc-search-options" });
  const state = node("div", { class: "lpc-search-state" });
  const live = node("p", { class: "lpc-search-sr", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  results.classList.add("lpc-workspace-search");
  if (!inline) {
    results.setAttribute("tabindex", "0");
    results.setAttribute("role", "region");
    results.setAttribute("aria-label", "Search results");
  }
  results.removeAttribute("aria-live");
  results.replaceChildren(list, state, live);
  input.maxLength = MAX_QUERY;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  const currentId = () => String(getIdentity?.()?.id || "");
  const choices = () => [...list.querySelectorAll("[data-v2-search-result]")];
  const historyKey = () => scopedUserId ? `lpc-v2-search-recent:${scopedUserId}` : "";
  const pagesKey = id => id ? `lpc-v2-search-pages:${prefix}:${id}` : "";
  function clearHistory(id = scopedUserId) {
    try { sessionStorage.removeItem(pagesKey(id)); sessionStorage.removeItem(`lpc-v2-search-recent:${id}`); } catch { /* Optional storage. */ }
  }
  function recentPages() {
    if (!validId(scopedUserId)) return [];
    try {
      const raw = sessionStorage.getItem(pagesKey(scopedUserId)) || "[]";
      const values = raw.length <= 4096 ? JSON.parse(raw) : [];
      const hrefs = [...new Set(Array.isArray(values) ? values.filter(value => commands.some(command => command.href === value)) : [])].slice(0, 3);
      sessionStorage.setItem(pagesKey(scopedUserId), JSON.stringify(hrefs));
      return hrefs.map(href => commands.find(command => command.href === href));
    } catch {
      try { sessionStorage.removeItem(pagesKey(scopedUserId)); } catch { /* Optional storage. */ }
      return [];
    }
  }
  function recordPage() {
    // Only committed, known workspace pages. Never cache private object names,
    // arbitrary destinations, or the initial page merely because the app loaded.
    const locationHref = `${location.pathname}${location.hash}`;
    const command = commands.find(command => command.href === locationHref || command.recentAliases?.includes(locationHref));
    const href = command?.href || locationHref;
    const previous = lastPage; lastPage = href;
    if (!previous || previous === href || currentId() !== scopedUserId || !validId(scopedUserId)) return;
    if (!command) return;
    const pages = [href, ...recentPages().map(command => command.href).filter(value => value !== href)].slice(0, 3);
    try { sessionStorage.setItem(pagesKey(scopedUserId), JSON.stringify(pages)); } catch { /* Optional history. */ }
  }
  function remember(query) {
    if (!historyKey()) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(historyKey()) || "[]");
      const old = Array.isArray(saved) ? saved.filter(value => typeof value === "string" && value !== query && value.length <= MAX_QUERY) : [];
      sessionStorage.setItem(historyKey(), JSON.stringify([query, ...old].slice(0, 5)));
    } catch { /* Optional history must not prevent an authenticated search. */ }
  }
  function cancel() {
    clearTimeout(debounce); clearTimeout(deadline);
    controller?.abort(); controller = null; sequence += 1;
  }
  function visible(value) { panel.hidden = !value; input.setAttribute("aria-expanded", String(value)); }
  function reset() {
    list.replaceChildren(); state.replaceChildren(); live.textContent = "";
    activeIndex = -1; input.removeAttribute("aria-activedescendant");
    list.removeAttribute("aria-busy");
  }
  function close() { cancel(); visible(false); }
  function scopeToIdentity(identity) {
    const next = String(identity?.id || "");
    if (next === scopedUserId) return;
    if (scopedUserId) { clearHistory(); clearHistory(next); lastPage = ""; }
    cancel(); scopedUserId = next; input.value = ""; reset(); visible(false);
  }
  function sessionLost() {
    clearHistory(); lastPage = "";
    cancel(); scopedUserId = ""; input.value = ""; reset(); visible(false);
    onSessionLost?.();
  }
  function matchingCommands(query) {
    const tokens = normalize(query).toLocaleLowerCase("en-US").split(" ").filter(Boolean);
    return commands.filter(command => tokens.every(token => normalize(`${command.label} ${command.keywords}`).toLocaleLowerCase("en-US").includes(token))).slice(0, dashboardPresentation ? 9 : 6);
  }
  function addGroup(title, rows) {
    if (!rows.length) return;
    const headingId = `${prefix}-group-${list.children.length}`;
    const group = node("div", { role: "group", ...(title ? { "aria-labelledby": headingId } : { "aria-label": "Pages" }), class: "lpc-search-group" }, title ? [node("div", { id: headingId, class: "lpc-search-group-title", text: title })] : []);
    rows.forEach((row, index) => {
      const link = node("a", { href: row.destination.href, id: `${headingId}-${index}`, role: "option", tabindex: "-1", "aria-selected": "false",
        "data-v2-search-result": "", "data-v2-search-kind": row.kind, class: "lpc-search-result" }, [
        node("span", { class: "lpc-search-copy" }, [node("strong", { text: row.title }), row.meta ? node("span", { text: row.meta }) : null]),
        node("span", { class: "lpc-search-arrow", "aria-hidden": "true", text: "›" }),
      ]);
      if (routeAttribute && row.destination.internal) link.setAttribute(routeAttribute, "");
      group.append(link);
    });
    list.append(group);
  }
  function render({ mode = "initial", data = null, message = "", recent = [] } = {}) {
    const activeDestination = choices()[activeIndex]?.getAttribute("href");
    reset();
    const query = normalize(input.value);
    if (mode === "long") {
      state.append(node("p", { role: "status", text: "Use 80 characters or fewer." }));
      list.hidden = true;
      return;
    }
    if (mode === "results" && !dashboardPresentation) {
      addGroup("Matters", data.matters); addGroup("Paralegals", data.profiles);
    }
    const pageRow = command => ({ title: command.label, meta: dashboardPresentation ? command.meta : "", destination: { href: command.href, internal: true }, kind: "command" });
    if (!query) addGroup("Recent pages", recent.map(pageRow));
    const pages = (!query && (inline || !showInitialCommands) ? [] : matchingCommands(query)).filter(command => !recent.some(page => page.href === command.href)).map(pageRow);
    addGroup(dashboardPresentation ? "" : query ? "Pages" : "Quick links", pages);
    if (mode === "results" && dashboardPresentation) { addGroup("Matters", data.matters); addGroup("Paralegal profiles", data.profiles); }
    if (mode === "recent-loading") {
      list.setAttribute("aria-busy", "true");
      state.append(node("p", { role: "status", text: "Loading recent pages…" }));
    } else if (mode === "loading") {
      list.setAttribute("aria-busy", "true");
      state.append(node("p", { role: "status", text: "Searching…" }));
    } else if (mode === "error" || mode === "recent-error") {
      state.append(node("p", { role: "status", text: message || "Search is temporarily unavailable." }));
      const retry = node("button", { type: "button", text: "Try again", class: "lpc-search-retry" });
      retry.addEventListener("click", () => { input.focus(); if (mode === "recent-error") void showRecentPages(); else void runSearch(input.value); });
      state.append(retry);
    } else if (mode === "results") {
      const count = data.matters.length + data.profiles.length;
      if (!count && !pages.length) state.append(node("p", { text: "No results." }));
      live.textContent = `${choices().length} results available.`;
    } else if (query) state.append(node("p", { text: "Enter at least two characters." }));
    else if (recent.length) live.textContent = `${recent.length} recent ${recent.length === 1 ? "page" : "pages"} available.`;
    list.hidden = !list.children.length;
    if (activeDestination) {
      const index = choices().findIndex(row => row.getAttribute("href") === activeDestination);
      if (index >= 0) setActive(index);
    }
  }
  async function showRecentPages() {
    cancel(); scopeToIdentity(getIdentity?.());
    const recent = dashboardPresentation ? [] : recentPages();
    if (!recent.length) { render(); visible(!inline); return; }
    const ownerId = scopedUserId, ticket = sequence;
    const request = controller = new AbortController();
    let timedOut = false;
    const current = () => ticket === sequence && ownerId === currentId() && ownerId === scopedUserId;
    deadline = setTimeout(() => { timedOut = true; request.abort(); }, DEADLINE_MS);
    visible(true); render({ mode: "recent-loading" });
    try {
      const session = await verifySession({ signal: request.signal });
      if (!current()) return;
      if (session?.state !== "ready" || session.identity?.id !== ownerId) { sessionLost(); return; }
      if (timedOut) throw new Error("SEARCH_TIMEOUT");
      render({ recent });
    } catch (error) {
      if (!current()) return;
      if (error?.status === 401 || error?.payload?.code === "ACCOUNT_CHANGED") { sessionLost(); return; }
      if (error?.name === "AbortError" && !timedOut) return;
      render({ mode: "recent-error", message: timedOut ? "Recent pages took too long. Please try again." : "Recent pages are temporarily unavailable." });
    } finally { if (ticket === sequence) { clearTimeout(deadline); controller = null; } }
  }
  async function runSearch(rawQuery) {
    if (composing) return;
    cancel();
    scopeToIdentity(getIdentity?.());
    const query = normalize(rawQuery);
    if (query.length > MAX_QUERY) { reset(); visible(true); render({ mode: "long" }); return; }
    if (!query) { void showRecentPages(); return; }
    if (query.length < MIN_QUERY) { render(); if (inline) visible(false); return; }
    if (!validId(scopedUserId)) { sessionLost(); return; }
    const ownerId = scopedUserId, ticket = sequence;
    const request = controller = new AbortController();
    let timedOut = false;
    const current = () => ticket === sequence && ownerId === currentId() && ownerId === scopedUserId;
    deadline = setTimeout(() => { timedOut = true; request.abort(); }, DEADLINE_MS);
    visible(true); render({ mode: "loading" });
    try {
      const before = await verifySession({ signal: request.signal });
      if (!current()) return;
      if (before?.state !== "ready" || before.identity?.id !== ownerId) { sessionLost(); return; }
      const params = new URLSearchParams({ q: query, types: types.join(","), expectedOwnerId: ownerId });
      const payload = await api.get(`/api/cases/search?${params}`, { signal: request.signal });
      if (!current()) return;
      if (validId(payload?.ownerId) && payload.ownerId !== ownerId) { sessionLost(); return; }
      const data = projectSearchResults(payload, { ownerId, query, types, destinationFor, dashboardPresentation });
      const after = await verifySession({ signal: request.signal });
      if (!current()) return;
      if (after?.state !== "ready" || after.identity?.id !== ownerId) { sessionLost(); return; }
      if (timedOut) throw new Error("SEARCH_TIMEOUT");
      remember(query); render({ mode: "results", data });
    } catch (error) {
      if (!current()) return;
      if (error?.status === 401 || error?.payload?.code === "ACCOUNT_CHANGED") { sessionLost(); return; }
      if (error?.name === "AbortError" && !timedOut) return;
      render({ mode: "error", message: timedOut ? "Search took too long. Please try again." : error?.status === 429 || error?.kind === "rate_limit" ? "Please wait a moment before searching again." : "" });
    } finally { if (ticket === sequence) { clearTimeout(deadline); controller = null; } }
  }
  function schedule() {
    // Invalidate at the keystroke, including during the debounce/composition gap.
    cancel(); reset();
    if (composing) return;
    const query = normalize(input.value);
    if (query.length > MAX_QUERY) { visible(true); render({ mode: "long" }); return; }
    if (!query) { void showRecentPages(); return; }
    if (query.length < MIN_QUERY) { render(); if (inline) visible(false); return; }
    visible(true); render({ mode: "loading" });
    debounce = setTimeout(() => void runSearch(query), DEBOUNCE_MS);
  }
  function open({ refresh = false } = {}) {
    scopeToIdentity(getIdentity?.());
    input.focus();
    if (!panel.hidden && !refresh) return;
    if (normalize(input.value).length >= MIN_QUERY) void runSearch(input.value);
    else if (!normalize(input.value)) void showRecentPages();
    else { render(); if (!inline) visible(true); }
  }
  function setActive(index) {
    const rows = choices(); if (!rows.length) return;
    activeIndex = (index + rows.length) % rows.length;
    rows.forEach((row, i) => { row.classList.toggle("is-active", i === activeIndex); row.setAttribute("aria-selected", String(i === activeIndex)); });
    input.setAttribute("aria-activedescendant", rows[activeIndex].id);
    rows[activeIndex].scrollIntoView({ block: "nearest" });
  }
  input.addEventListener("input", schedule);
  input.addEventListener("compositionstart", () => { composing = true; cancel(); reset(); });
  input.addEventListener("compositionend", () => { composing = false; schedule(); });
  input.addEventListener("keydown", event => {
    if (composing || event.isComposing || panel.hidden || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const rows = choices();
    if (["ArrowDown", "ArrowUp"].includes(event.key) && rows.length) {
      event.preventDefault(); setActive(activeIndex < 0 ? event.key === "ArrowDown" ? 0 : rows.length - 1 : activeIndex + (event.key === "ArrowDown" ? 1 : -1));
    } else if (["Home", "End"].includes(event.key) && activeIndex >= 0 && rows.length) {
      event.preventDefault(); setActive(event.key === "Home" ? 0 : rows.length - 1);
    } else if (event.key === "Enter" && activeIndex >= 0 && rows[activeIndex]) {
      event.preventDefault(); rows[activeIndex].click();
    }
  });
  results.addEventListener("click", event => {
    if (event.target.closest("[data-v2-search-result]")) { remember(normalize(input.value)); close(); }
  });
  return Object.freeze({ open, close, cancel, scopeToIdentity, runSearch, render, recordPage, clear: ({ preserveHistory = false } = {}) => { if (!preserveHistory) clearHistory(); cancel(); scopedUserId = ""; lastPage = ""; input.value = ""; reset(); visible(false); } });
}
