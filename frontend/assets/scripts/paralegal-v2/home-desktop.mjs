// Linear's public desktop compositions, rendered from LPC's verified Home model.
// This module has no API client: record mutations stay in their existing owners.
import { isWorkspaceView, renderHomeWorkspace } from "./home-workspace-view.mjs";
import { deadlineTimelineRange } from "./home-timeline.mjs";
import { buildHomeModel } from "./home-model.mjs";
const VIEWS = { overview: "Home", pulse: "Updates", work: "My work", inbox: "Inbox", reviews: "Reviews", matters: "Matters", deadlines: "Deadlines", board: "Work board", insights: "Work insights", document: "Matter overview", invitations: "Invitations", applications: "Applications", recommendations: "Browse matters", history: "History" };
export function homeDesktopView(value) { return Object.hasOwn(VIEWS, value) ? value : "overview"; }
const PATHS = {
  status: 'M12 3a9 9 0 1 0 9 9M12 3v9h9', circle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  check: 'm7 12 3 3 7-7M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', down: 'm8 10 4 4 4-4',
  filter: 'M4 6h16M7 12h10M10 18h4', sliders: 'M4 7h7m5 0h4M4 17h3m5 0h8M11 4v6M7 14v6',
  chart: 'M5 18v-6m7 6V4m7 14V8', panel: 'M9 4v16M3 4h18v16H3z',
  more: 'M5 12h.01M12 12h.01M19 12h.01', plus: 'M12 5v14M5 12h14',
  link: 'm10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  copy: 'M8 8h12v13H8zM16 8V3H3v14h5', branch: 'M6 7v10m12-10v3a5 5 0 0 1-5 5H6M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0m0 14a2 2 0 1 1-4 0 2 2 0 0 1 4 0m12-14a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z',
  right: 'm9 6 6 6-6 6', up: 'm7 10 5-5 5 5M12 5v14', arrow: 'm7 14 5 5 5-5M12 5v14', back: 'm14 6-6 6 6 6',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5M9 12h7M9 16h7', calendar: 'M3 5h18v16H3zM7 3v4m10-4v4M3 11h18',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21a8 8 0 0 1 16 0',
  comment: 'M21 11a9 9 0 1 1-17 4l-2 7 7-2a9 9 0 0 0 12-9',
  pulse: 'm13 2-9 12h7l-1 8 10-13h-7z', tag: 'M3 3h8l10 10-8 8L3 11zM7 7h.01',
  board: 'M3 4h18v16H3zM9 4v16M15 4v16', box: 'm12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10',
};
export function enhanceHomeDesktop({ host, model, actions, node, link, button, shortDate }) {
  if (isWorkspaceView(actions.desktop.view)) return renderHomeWorkspace({host, model, actions, node, link, button, shortDate});
  const state = actions.desktop;
  let disposed = false, deadlineRead = null;
  host.__workspaceDispose = () => { disposed = true; deadlineRead = null; };
  state.view = homeDesktopView(state.view);
  const availability = host.querySelector("[data-v2-availability-trigger]");
  const profileTodos = host.querySelector('.ph-profile-todos');
  const records = [
    ...model.activeWork.map(row => ({ ...row, type: "matter", group: "work" })),
    ...model.opportunities.invitations.map(row => ({ ...row, type: "invitation", group: "invitations" })),
    ...model.opportunities.applications.map(row => ({ ...row, type: "application", group: "applications" })),
    ...model.opportunities.recommendations.map(row => ({ ...row, type: "recommendation", group: "recommendations" })),
  ].map(row => ({ ...row, key: `${row.type}:${row.id}` }));
  const byKey = new Map(records.map(row => [row.key, row]));
  const active = records.filter(row => row.type === "matter");
  const reference = row => row.reference || "";
  const el = (tag, className, text) => node(tag, { className, text });
  function icon(name, cls = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", `ld-icon ${cls}`);
    const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", PATHS[name] || PATHS.circle); svg.append(path); return svg;
  }
  const safe = handler => event => { if (actions.isValid()) handler(event); };
  const control = (label, handler, cls = "ld-button", attrs = {}) => button(label, safe(handler), cls, attrs);
  const tool = (label, name, handler, attrs = {}) => { const b = control("", handler, "ld-tool", { "aria-label": label, title: label, "data-ld-tool": name, ...attrs }); b.append(icon(name)); return b; };
  const chip = (text, name = "circle") => node("span", { className: "ld-chip" }, [icon(name), el("span", "", text)]);
  const avatar = name => el("span", "ld-avatar", (name || "LPC").split(/\s+/).map(part => part[0]).slice(0, 2).join(""));
  const empty = text => el("p", "ld-empty", text);
  const date = value => shortDate(value).replace(/, \d{4}$/, "");
  const match = row => !state.search || `${row.title} ${row.attorney || ""} ${row.practice || ""} ${row.label || ""}`.toLowerCase().includes(state.search.toLowerCase());
  const ordered = rows => [...rows].filter(match).sort((a, b) => state.sort === "title" ? a.title.localeCompare(b.title) : state.sort === "deadline" ? (a.deadline || a.matterDeadline || "9999").localeCompare(b.deadline || b.matterDeadline || "9999") : 0);
  const workspaceLink = (row, label, tab, cls = "ld-inline-link") => row.workspaceReady ? link(label, `/matter/${encodeURIComponent(row.id)}?tab=${tab}`, cls) : null;
  let visibleRecords = [];
  host.classList.add("ph-desktop", "ld-desktop");
  host.replaceChildren();
  const stage = node("div", { className: "ld-stage" });
  host.append(stage);
  const mount = (...children) => stage.append(...children.filter(Boolean));
  if (state.favorite === undefined && active.length) state.favorite = active[0].key;
  function sourceNote(names, labels = {}) {
    const missing = names.filter(name => !model.sources[name]?.complete);
    if (!missing.length) return null;
    const loading = missing.some(name => model.sources[name]?.state === "loading");
    return node("div", { className: "ld-source", role: "status", "data-home-source-state": loading ? "loading" : "partial" }, [
      el("span", "", loading ? labels.loading || "Loading your workspace…" : labels.unavailable || "Some records are unavailable. Showing the verified information."),
      loading ? null : control("Try again", actions.retry, "ld-inline-link", { "data-v2-home-retry": "" }),
    ]);
  }
  function go(view, key = "") {
    state.view = view; state.selected = key; state.search = ""; state.filterOpen = false; state.tab = ""; state.returned = false; state.returnKey = ""; paint();
  }
  function select(row) { if (!actions.isValid()) return; state.selected = row.key; state.returned = false; paint(); stage.querySelector("[data-home-detail-title]")?.focus({ preventScroll: true }); }
  function tabbar(items, selected, change) {
    const tabs = node("div", { className: "ld-tabs", role: "tablist", "aria-label": `${VIEWS[state.view]} views` });
    items.forEach(([value, label]) => {
      const tab = control(label, () => { change(value); paint(); }, "ld-tab", { role: "tab", "aria-selected": String(value === selected), tabindex: value === selected ? "0" : "-1", "data-home-desktop-tab": value });
      tab.addEventListener("keydown", event => {
        const controls = [...tabs.children], at = controls.indexOf(tab);
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); controls[event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length].focus();
      }); tabs.append(tab);
    }); return tabs;
  }
  function heading(title, trailing = []) {
    return node("header", { className: "ld-heading" }, [el("h1", "", title), ...trailing]);
  }
  function utility() {
    return node("div", { className: "ld-tools" }, [
      tool("Filter Home records", "filter", () => { state.filterOpen = !state.filterOpen; paint(); stage.querySelector(".ld-filter-input")?.focus(); }, { "aria-expanded": String(Boolean(state.filterOpen)) }),
      tool("Display options", "sliders", () => { state.displayOpen = !state.displayOpen; paint(); }, { "aria-expanded": String(Boolean(state.displayOpen)) }),
      tool("Work insights", "chart", () => go("insights")),
      tool("Toggle sidebar", "panel", () => document.querySelector("[data-v2-sidebar-grip]")?.click()),
    ]);
  }
  function toolbar(tabs, tools = utility()) { return node("div", { className: "ld-toolbar" }, [tabs, tools]); }
  function filters() {
    const region = node("div", { className: "ld-filter-region", hidden: !state.filterOpen && !state.displayOpen });
    if (state.filterOpen) {
      const input = node("input", { type: "search", className: "ld-filter-input", placeholder: "Filter by title, attorney, or practice area…", "aria-label": "Filter Home records", value: state.search || "" });
      input.addEventListener("input", () => { if (!actions.isValid()) return; const caret = input.selectionStart; state.search = input.value; paint(); const replacement = stage.querySelector(".ld-filter-input"); replacement?.focus(); try { replacement?.setSelectionRange(caret, caret); } catch {} });
      region.append(input);
    }
    if (state.displayOpen) {
      const sort = node("select", { "aria-label": "Sort Home records" }, [["priority", "Default order"], ["title", "Title"], ["deadline", "Due date"]].map(([value, text]) => node("option", { value, text })));
      sort.value = state.sort || "priority"; sort.addEventListener("change", safe(() => { state.sort = sort.value; paint(); }));
      region.append(el("span", "", "Order by"), sort, control("List", () => { state.board = false; paint(); }, "ld-tab", { "aria-pressed": String(!state.board) }), control("Board", () => { state.board = true; paint(); }, "ld-tab", { "aria-label": "Toggle board view", "aria-pressed": String(Boolean(state.board)) }));
    }
    return region;
  }
  function groupTitle(label, count, name = "status") {
    return node("header", { className: "ld-group-heading" }, [icon("down", "ld-chevron"), icon(name, "ld-blue"), el("h2", "", label), el("span", "ld-muted", String(count))]);
  }
  function rowElement(row, board = false) {
    const b = control("", () => select(row), board ? "ld-card" : "ld-row", { "aria-label": `Show details for ${row.title}`, [`data-home-${row.type}-id`]: row.id, "data-desktop-record": row.key });
    const meta = node("span", { className: "ld-row-meta" }, [row.practice ? chip(row.practice) : null, row.attorney ? avatar(row.attorney) : null, el("time", "ld-row-date", date(row.deadline || row.matterDeadline))]);
    if (board) b.append(node("span", { className: "ld-card-top" }, [el("span", "ld-id", reference(row)), chip(row.label, "status")]), node("span", { className: "ld-card-title" }, [icon("status", "ld-blue"), el("span", "", row.title)]), meta);
    else b.append(icon("chart", "ld-muted"), el("span", "ld-id", reference(row)), icon(row.status === "reviewing" ? "check" : "status", "ld-blue"), el("span", "ld-row-title", row.title), meta);
    return b;
  }
  function recordGroups(rows, board = false) {
    const groups = new Map(); rows.forEach(row => { const label = row.label || "Work"; if (!groups.has(label)) groups.set(label, []); groups.get(label).push(row); });
    const wrapper = node("div", { className: board ? "ld-board" : "ld-groups", "data-home-desktop-list": "" });
    groups.forEach((items, label) => wrapper.append(node("section", { className: board ? "ld-column" : "ld-group", "aria-label": label }, [groupTitle(label, items.length), ...items.map(row => rowElement(row, board))])));
    if (!rows.length) wrapper.append(empty(state.search ? "No matching records." : "No verified records in this view."));
    return wrapper;
  }
  function workScreen() {
    const op = ["invitations", "applications", "recommendations"].includes(state.view);
    const board = state.view === "board" || Boolean(state.board);
    const tab = state.tab || (op ? state.view : "work");
    const tabItems = op ? [[state.view, VIEWS[state.view]]] : [["work", "Assigned"], ["invitations", "Invitations"], ["applications", "Applications"], ["recommendations", "Recommended"]];
    visibleRecords = ordered(records.filter(row => row.group === tab));
    mount(heading(state.view === "overview" ? "My work" : VIEWS[state.view]), toolbar(tabbar(tabItems, tab, value => { state.tab = value; state.selected = ""; })), filters(), sourceNote([({ work: "dashboard", invitations: "invites", applications: "applications", recommendations: "recommendations" })[tab]]), recordGroups(visibleRecords, board));
  }
  function copyValue(value) { if (!actions.isValid()) return; navigator.clipboard?.writeText(value).then(() => { if (actions.isValid()) actions.showToast?.("Copied."); }).catch(() => { if (actions.isValid()) actions.showToast?.("The value could not be copied."); }); }
  function detail(row, split = false, review = false) {
    const panel = node("section", { className: `ld-detail${split ? " ld-detail-split" : ""}`, "aria-label": "Record details", "data-home-desktop-detail": "" });
    const index = visibleRecords.findIndex(item => item.key === row.key), found = index >= 0;
    const back = tool("Back to list", "back", () => { state.returnKey = row.key; state.selected = ""; state.returned = true; paint(); const target = [...stage.querySelectorAll("[data-desktop-record]")].find(item => item.dataset.desktopRecord === row.key); (target || stage.querySelector("h1"))?.focus({ preventScroll: true }); });
    const favorite = tool(state.favorite === row.key ? "Remove from favorites" : "Add to favorites", "star", () => { state.favorite = state.favorite === row.key ? "" : row.key; paint(); }, { "aria-pressed": String(state.favorite === row.key) });
    const top = node("header", { className: "ld-detail-heading" }, [back, icon("status", "ld-blue"), el("span", "ld-id", reference(row)), favorite,
      tool("Record actions", "more", () => { state.recordMenu = !state.recordMenu; paint(); }, { "aria-expanded": String(Boolean(state.recordMenu)) }),
      el("span", "ld-detail-count", `${found ? index + 1 : 1} / ${found ? visibleRecords.length : 1}`),
      tool("Previous record", "up", () => select(visibleRecords[index - 1]), { disabled: !found || index <= 0 }), tool("Next record", "arrow", () => select(visibleRecords[index + 1]), { disabled: !found || index >= visibleRecords.length - 1 }),
    ]);
    const url = new URL("paralegal-v2.html", document.baseURI); url.hash = `/home?view=work&item=${encodeURIComponent(row.key)}`;
    const tools = node("div", { className: "ld-detail-tools" }, [tool("Copy link", "link", () => copyValue(url.href)), tool("Copy record ID", "copy", () => copyValue(row.id)), tool("Open matter activity", "branch", () => { if (row.workspaceReady) { const target = workspaceLink(row, "Activity", "activity"); target.click(); } }, { disabled: !row.workspaceReady }), tool("Open LPC Assistant", "pulse", () => document.querySelector("[data-v2-assistant-trigger]")?.click())]);
    if (review) {
      const reviewTab = state.reviewTab || "overview";
      panel.append(top, toolbar(tabbar([["overview", "Overview"], ["activity", "Activity"], ["files", "Files"]], reviewTab, value => { state.reviewTab = value; }), tools));
      const paper = node("section", { className: "ld-review-document", "aria-label": "Review document" }, [node("header", {}, [icon("file"), row.latestFileName ? el("span", "", row.latestFileName) : null, chip(row.label, "status")])]);
      const contents = node("article", { className: "ld-review-paper" }, [node("h2", { text: row.title, tabindex: "-1", "data-home-detail-title": "" }), el("p", "ld-description", row.practice || "")]);
      if (reviewTab === "files") contents.append(row.latestFileName ? null : el("p", "", "No file metadata is included in this preview."), workspaceLink(row, "Open files & submissions", "files"));
      else if (reviewTab === "activity") contents.append(el("h3", "", "Latest update"), el("p", "", row.latestUpdate || row.detail || "No recent update is included in this preview."), workspaceLink(row, "Open full activity", "activity"));
      else contents.append(el("h3", "", "Scope"), el("p", "", row.description || row.detail || "Open the full matter workspace to review the recorded scope and documents."), el("h3", "", "Recorded details"), node("dl", {}, [["Attorney", row.attorney], ["Due date", shortDate(row.deadline || row.matterDeadline)]].filter(([, value]) => value).map(([label, value]) => node("div", {}, [el("dt", "ld-muted", label), el("dd", "", value)]))), el("h3", "", "Next step"), row.href ? link(row.actionLabel || "Review details", row.href, "ld-inline-link") : null);
      paper.append(contents); panel.append(paper); return panel;
    }
    panel.append(top, tools);
    if (state.recordMenu) panel.append(node("nav", { className: "ld-record-menu", "aria-label": "Record actions" }, [row.href ? link(row.actionLabel || "View details", row.href, "ld-inline-link") : null, workspaceLink(row, "Files", "files"), workspaceLink(row, "Messages", "messages"), workspaceLink(row, "Deadlines", "deadlines")]));
    const description = row.description || row.detail;
    const article = node("article", { className: "ld-article" }, [node("h2", { text: row.title, tabindex: "-1", "data-home-detail-title": "" }), description && ![row.label, row.latestUpdate].includes(description) ? el("p", "ld-description", description) : null]);
    if (split) article.append(node("section", { className: "ld-context-card", "aria-label": "Record context" }, [node("header", {}, [icon(review ? "branch" : "pulse"), el("h3", "", review ? "Review context" : "Matter context")]), node("div", { className: "ld-context-properties" }, [el("span", "ld-muted", "Status"), chip(row.label, "status"), row.practice ? chip(row.practice, "tag") : null]), node("div", { className: "ld-context-properties" }, [el("span", "ld-muted", row.attorney ? "Attorney" : "Next step"), el("span", "", row.attorney || row.actionLabel || "Review details")]), row.deadline || row.matterDeadline ? node("div", { className: "ld-context-properties" }, [el("span", "ld-muted", "Deadline"), el("span", "", date(row.deadline || row.matterDeadline))]) : null]));
    if (row.latestUpdate) article.append(el("h3", "ld-activity-heading", "Latest update"), node("div", { className: "ld-events" }, [node("div", { className: "ld-event" }, [icon("pulse"), el("span", "", row.latestUpdate), row.latestUpdateAt && Number.isFinite(Date.parse(row.latestUpdateAt)) ? el("time", "ld-muted", date(row.latestUpdateAt)) : null])]));
    if (row.latestFileName) article.append(node("section", { className: "ld-thread" }, [node("header", {}, [icon("file"), el("span", "", "Latest file")]), node("div", { className: "ld-thread-body" }, [el("span", "", row.latestFileName), workspaceLink(row, "Open files", "files")])]));
    if (row.total > 0 && row.completed !== null) article.append(node("section", { className: "ld-thread" }, [node("header", {}, [icon("check"), el("span", "", "Work items")]), node("div", { className: "ld-thread-body" }, [el("span", "", `${row.completed} of ${row.total} complete`), node("progress", { max: row.total, value: row.completed, "aria-label": "Completed work items" })])]));
    if (row.workspaceReady) article.append(node("div", { className: "ld-message-entry" }, [workspaceLink(row, "Open workspace", "overview", "ld-inline-link"), workspaceLink(row, "Open messages", "messages", "ld-message-link"), row.unread > 0 ? el("span", "ld-muted", `${row.unread} unread`) : null]));
    else article.append(node("div", { className: "ld-message-entry" }, [el("p", "ld-muted", row.type === "invitation" ? "Review this invitation before accepting or declining." : "Continue in the full record to take the next step."), row.href ? link(row.actionLabel || "View details", row.href, "ld-message-link") : null]));
    const properties = node("aside", { className: "ld-properties", "aria-label": "Properties" });
    properties.append(el("h3", "", "Properties"));
    const values = [["Status", row.label, "status"], ["Attorney", row.attorney, "person"], ["Deadline", date(row.deadline || row.matterDeadline), "calendar"], ["State", row.state, "box"]];
    values.filter(([, value]) => value).forEach(([label, value, symbol]) => properties.append(node("div", { className: "ld-property", "aria-label": `${label}: ${value}`, title: label }, [icon(symbol), el("span", "", value)])));
    if (row.practice) properties.append(el("h3", "", "Labels"), chip(row.practice, "tag"));
    if (row.compensation != null) properties.append(el("h3", "", "Posted compensation"), el("span", "", row.compensation.toLocaleString(undefined, { style: "currency", currency: row.currency || "USD" })));
    if (!row.latestFileName && row.workspaceReady) properties.append(el("h3", "", "Files"), workspaceLink(row, "Files & submissions", "files"));
    if (row.workspaceReady) properties.append(el("h3", "", "Payment"), workspaceLink(row, "Payment details", "financials"));
    panel.append(node("div", { className: "ld-detail-body" }, [article, split ? null : properties]));
    return panel;
  }
  function overviewScreen() {
    mount(heading("Home", [availability]));
    const feed = node("div", { className: "ld-feed", "data-home-summary": "" });
    const section = (title, href, rows, emptyText, complete) => {
      const block = node("section", { className: "ld-feed-item", "aria-label": title }, [el("h2", "", title)]);
      rows.slice(0, 3).forEach(row => block.append(node("article", { className: "ld-feed-item" }, [
        row.href ? link(row.title, row.href, "ld-feed-title") : el("h3", "", row.title),
        el("p", "", row.reason || row.detail || row.label),
      ])));
      if (!rows.length && complete) block.append(empty(emptyText));
      block.append(link("View all", href, "ld-inline-link")); feed.append(block);
    };
    const attention = [...model.workspace.reviews.action.map(row => ({ ...row, reason: `Revision requested · ${row.contentTitle}: ${row.reason}` })), ...model.attention.candidates.filter(row =>
      ["request", "invitation"].includes(row.kind) || row.kind === "deadline" && row.deadline <= model.today
    ).map(row => ({ ...row, reason: `${row.label} · ${row.detail}` }))];
    feed.append(...[sourceNote(["dashboard", "submissions", "invites", "applications"], { unavailable: "Some attention items could not be checked. Showing available information." })].filter(Boolean));
    section("Needs your attention", "/home?view=work", attention, "No action items in the available records.", model.attention.complete && model.workspace.reviewsComplete);
    section("Current Matters", "/home?view=work", active.map(row => ({ ...row, reason: `${row.label}${row.deadline ? ` · Due ${date(row.deadline)}` : ""}` })), "No active Matters.", model.sources.dashboard.complete);
    feed.append(...[sourceNote(["threads", "unread", "dashboard"], { unavailable: "Message activity could not be checked." })].filter(Boolean));
    section("Messages", "/conversations", model.communications.items, "No unread messages.", model.communications.complete);
    if (model.profileTodos.length || model.readiness.items.length) feed.append(node("section", { className: "ld-feed-item", "aria-label": "Account setup" }, [
      el("h2", "", "Account setup"),
      ...model.readiness.items.map(item => link(item.title, item.href, "ld-feed-title")),
      profileTodos ? node('details', {}, [node('summary', { text: `Complete your profile · ${model.profileTodos.length} items` }), profileTodos]) : null,
    ]));
    mount(feed); visibleRecords = active;
  }
  function mattersScreen() {
    const group = state.tab || "active";
    const data = ordered(group === "pending" ? records.filter(row => ["application", "invitation"].includes(row.type)) : group === "all" ? records.filter(row => row.type !== "recommendation") : active);
    visibleRecords = data;
    mount(heading("Matters", [tool("Browse available matters", "plus", () => go("recommendations"))]), toolbar(tabbar([["active", "Active"], ["pending", "Pending"], ["all", "All matters"]], group, value => { state.tab = value; })), filters(), sourceNote(["dashboard", "invites", "applications"]));
    const table = node("table", { className: "ld-matters-table" }, [node("thead", {}, [node("tr", {}, ["Name", "Target", "Status", "Work items", "Attorney", "Updates"].map(text => node("th", { scope: "col", text })))])]);
    const body = node("tbody"); data.forEach(row => body.append(node("tr", {}, [node("td", {}, [icon("box", "ld-blue"), control(row.title, () => select(row), "ld-table-title")]), node("td", { text: date(row.deadline || row.matterDeadline) || "—" }), node("td", {}, [chip(row.label, "status")]), node("td", { text: row.total > 0 && row.completed !== null ? `${row.completed} / ${row.total}` : "—" }), node("td", { text: row.attorney || "—" }), node("td", { text: row.unread > 0 ? `${row.unread} unread` : "—" })]))); table.append(body);
    mount(state.board ? recordGroups(data, true) : node("div", { className: "ld-table-scroll", tabindex: "0", "aria-label": "Matters table" }, [table]), data.length ? null : empty("No matters in this view."));
  }
  function readTimeline(range, force = false) {
    const read = { key: `${range.start}:${range.end}`, state: "loading", dates: model.deadlines.filter(row => row.source === "matter") };
    deadlineRead = read;
    Promise.resolve().then(() => {
      if (disposed || !actions.isValid()) throw new DOMException("View changed", "AbortError");
      return actions.loadDeadlines(range, { force });
    }).then(value => {
      if (disposed || deadlineRead !== read || !actions.isValid()) return;
      read.dates = buildHomeModel({ ...actions.snapshot, events: { available: true, value } }, { userId: actions.userId }).deadlines;
      read.state = "ready";
      paint();
    }, () => {
      if (disposed || deadlineRead !== read || !actions.isValid()) return;
      read.state = "unavailable";
      paint();
    });
    return read;
  }
  function timelineScreen() {
    const range = deadlineTimelineRange(model.today, state.timelinePeriod || 0, 6);
    const rangeKey = `${range.start}:${range.end}`;
    if (deadlineRead?.key !== rangeKey) {
      const loadedRange = model.sources.events.value?.range;
      if (model.sources.events.complete && loadedRange?.start === range.start && loadedRange?.end === range.end) {
        deadlineRead = { key: rangeKey, state: "ready", dates: model.deadlines };
      } else readTimeline(range);
    }
    const anchor = new Date(`${range.start}T00:00:00Z`);
    const months = Array.from({ length: 6 }, (_, index) => {
      const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + index, 1));
      return { date: start.toISOString().slice(0, 10), label: start.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }), left: 100 + index * 160 };
    });
    const position = value => { const day = new Date(`${value}T00:00:00Z`); const month = (day.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + day.getUTCMonth() - anchor.getUTCMonth(); const days = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate(); return 100 + (month + (day.getUTCDate() - 1) / days) * 160; };
    const period = delta => { state.timelinePeriod = delta === 0 ? 0 : (state.timelinePeriod || 0) + delta; paint(); };
    mount(heading("Deadlines"), toolbar(tabbar([["all", "All deadlines"], ["matter", "Matter deadlines"], ["private", "Private reminders"]], state.tab || "all", value => { state.tab = value; }), node("div", { className: "ld-tools" }, [tool("Previous three months", "back", () => period(-1)), control("Today", () => period(0)), tool("Next three months", "right", () => period(1))])), sourceNote(["dashboard"]));
    mount(el("p", "ld-timeline-note", `${range.months[0].label} – ${range.months.at(-1).label} · New York time`));
    const remindersReady = state.tab === "matter" || deadlineRead.state === "ready";
    if (state.tab !== "matter" && deadlineRead.state !== "ready") mount(node("div", { className: "ld-source", role: "status", "data-home-deadline-state": deadlineRead.state }, [
      el("span", "", deadlineRead.state === "loading" ? "Loading reminders for this period…" : "Reminders for this period could not be loaded."),
      deadlineRead.state === "unavailable" ? control("Try again", () => { readTimeline(range, true); paint(); }, "ld-inline-link", { "data-home-deadline-retry": "" }) : null,
    ]));
    const dates = deadlineRead.dates.filter(row => (row.deadline || row.date) >= range.start && (row.deadline || row.date) < range.end).filter(row => !state.tab || state.tab === "all" || (state.tab === "private" ? row.label === "Private reminder" : row.label !== "Private reminder"));
    const timeline = node("div", { className: "ld-timeline", "data-home-timeline": "", "data-deadline-range": rangeKey, "aria-busy": String(state.tab !== "matter" && deadlineRead.state === "loading") });
    timeline.append(node("div", { className: "ld-months" }, months.map(month => node("span", { text: month.label, style: `left:${month.left}px;width:160px` }))));
    months.forEach(month => timeline.append(node("div", { className: "ld-month-line", style: `left:${month.left}px`, "aria-hidden": "true" })));
    dates.forEach(row => {
      const day = row.deadline || row.date;
      const line = node("div", { className: "ld-timeline-row" });
      const p = position(day), align = p > 740 ? "end" : "start";
      const marker = node("div", { className: `ld-deadline-marker align-${align}`, style: `left:${p}px` }, [node("div", { className: "ld-deadline-label" }, [icon("calendar", "ld-blue"), row.href ? link(row.title, row.href, "ld-inline-link") : el("span", "", row.title)]), node("time", { datetime: day, text: `${date(day)}${!state.tab || state.tab === "all" ? ` · ${row.label}` : ""}` })]);
      line.append(marker); timeline.append(line);
    });
    if (!dates.length && remindersReady && model.sources.dashboard.complete) timeline.append(empty("No deadlines in this period."));
    mount(node("div", { className: "ld-timeline-scroll", tabindex: "0", "aria-label": "Deadline timeline" }, [timeline]));
  }
  function insightsScreen() {
    mount(heading("Work insights"));
    const valid = model.sources.dashboard.complete;
    const completed = active.reduce((sum, row) => sum + (row.completed || 0), 0);
    const total = active.reduce((sum, row) => sum + (row.total || 0), 0);
    const metrics = [["Recorded work items complete", completed], ["Active matters", active.length], ["Matters under review", active.filter(row => row.status === "reviewing").length]];
    const wrap = node("div", { className: "ld-insights" }, [sourceNote(["dashboard"]), node("div", { className: "ld-metrics" }, metrics.map(([label, value]) => node("section", { className: "ld-metric" }, [el("h2", "", label), el("strong", "", valid ? String(value) : "—")])))]);
    const chart = node("section", { className: "ld-chart-panel", "aria-label": "Recorded work items by matter" }, [el("h2", "", "Recorded work items by matter")]);
    const bars = node("div", { className: "ld-chart-bars" }, [20, 40, 60, 80, 100].map(value => node("span", { className: "ld-chart-gridline", "aria-hidden": "true", style: `bottom:${value}%` })));
    [...active].filter(row => row.total > 0 && row.completed !== null).sort((a, b) => b.total - a.total).forEach(row => bars.append(node("div", { className: "ld-chart-column", title: `${row.title}: ${row.completed} of ${row.total} complete` }, [node("div", { className: "ld-chart-bar", style: `height:${Math.max(2, row.total / Math.max(...active.map(item => item.total || 0), 1) * 100)}%` }, [node("span", { className: "ld-chart-completed", style: `height:${row.completed / row.total * 100}%` })]), el("span", "ld-chart-label", reference(row))])));
    chart.append(bars, el("p", "ld-chart-key", `${completed} complete · ${Math.max(0, total - completed)} remaining`));
    const table = node("table", { className: "ld-insights-table" }, [node("thead", {}, [node("tr", {}, ["Matter", "Total", "Done", "Left"].map(text => node("th", { scope: "col", text })))])]);
    const body = node("tbody"); active.forEach(row => body.append(node("tr", {}, [node("td", {}, [control(row.title, () => select(row), "ld-table-title")]), ...[row.total, row.completed, row.total != null && row.completed != null ? row.total - row.completed : null].map(value => node("td", { text: value ?? "—" }))]))); table.append(body);
    wrap.append(node("div", { className: "ld-insight-panels" }, [chart, node("section", { className: "ld-chart-panel" }, [el("h2", "", "Current matters"), table])])); mount(wrap); visibleRecords = active;
  }
  function documentScreen() {
    const row = byKey.get(state.documentKey) || active[0]; visibleRecords = active;
    mount(heading("Matter overview"));
    if (active.length) mount(toolbar(null, node("div", { className: "ld-tools" }, [tool("Choose matter", "filter", () => { state.documentPicker = !state.documentPicker; paint(); }, { "aria-expanded": String(Boolean(state.documentPicker)) }), tool("Show properties", "sliders", () => { state.hideProperties = !state.hideProperties; paint(); }, { "aria-pressed": String(!state.hideProperties) }), tool("Work insights", "chart", () => go("insights"))])));
    if (state.documentPicker && active.length) {
      const picker = node("nav", { className: "ld-document-picker", "aria-label": "Choose matter" }, active.map(item => control(item.title, () => {
        state.documentKey = item.key; state.documentPicker = false; paint(); stage.querySelector(".ld-document h2")?.focus();
      }, "ld-inline-link", item.key === row?.key ? { "aria-current": "true" } : {})));
      picker.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); state.documentPicker = false; paint(); stage.querySelector('[aria-label="Choose matter"]')?.focus(); } });
      mount(picker);
    }
    const source = sourceNote(["dashboard"], { loading: "Loading matter overview…", unavailable: "Matter overview could not be loaded." }); mount(source);
    if (!row) { if (!source) mount(empty("No active matters.")); return; }
    const facts = [["Status", row.label], ["Attorney", row.attorney], ["Practice area", row.practice], ["Due date", row.deadline ? shortDate(row.deadline) : ""]];
    const properties = node("dl", { className: "ld-document-facts", hidden: Boolean(state.hideProperties) }, facts.filter(([, value]) => value).map(([label, value]) => node("div", {}, [el("dt", "ld-muted", label), el("dd", "", value)])));
    const article = node("article", { className: "ld-document" }, [node("h2", { text: row.title, tabindex: "-1" }), properties]);
    if (row.progress) article.append(el("p", "ld-document-progress", row.progress));
    const updates = [["Latest update", row.latestUpdate], ["Latest file", row.latestFileName]];
    for (const [label, value] of updates) if (value) article.append(node("section", { className: "ld-document-update" }, [el("h3", "", label), el("p", "", value)]));
    const resources = node("nav", { className: "ld-document-resources", "aria-label": "Matter workspace" }, [
      row.href ? link(row.actionLabel, row.href, "ld-inline-link") : null,
      workspaceLink(row, "Files & submissions", "files"), workspaceLink(row, "Messages", "messages"), workspaceLink(row, "Deadlines", "deadlines"),
    ]);
    article.append(resources);
    mount(article);
  }
  function paintSidebar() {
    document.querySelectorAll("[data-desktop-home-view]").forEach(item => { const current = item.dataset.desktopHomeView === state.view; if (current && !state.selected) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current"); });
    const shortcuts = document.querySelector("[data-v2-desktop-matters]");
    if (!shortcuts) return;
    const favorite = byKey.get(state.favorite);
    const rows = favorite ? [favorite] : [];
    shortcuts.replaceChildren(...rows.map(row => {
      const a = link("", `/home?view=work&item=${encodeURIComponent(row.key)}`, "v2-nav-link v2-desktop-matter-link"); a.dataset.homeShortcutKey = row.key; a.setAttribute("title", row.title); a.append(icon("status", "ld-blue"), el("span", "", row.title)); if (state.selected === row.key) a.setAttribute("aria-current", "page"); return a;
    }));
  }
  function paint() {
    if (!actions.isValid()) return;
    const focused = document.activeElement;
    const focus = stage.contains(focused) && focused.matches("button,input,select") ? {
      tag: focused.tagName, tab: focused.dataset.homeDesktopTab, tool: focused.dataset.ldTool,
      label: focused.getAttribute("aria-label"), text: focused.textContent,
    } : null;
    stage.replaceChildren(); host.dataset.desktopView = state.view; host.dataset.desktopMode = "list"; host.dataset.desktopLayout = state.view === "board" || state.board ? "board" : "list";
    {
      if (state.view === "overview") overviewScreen();
      else if (state.view === "matters") mattersScreen();
      else if (state.view === "deadlines") timelineScreen();
      else if (state.view === "insights") insightsScreen();
      else if (state.view === "document") documentScreen();
      else workScreen();
      const row = byKey.get(state.selected);
      if (row) { stage.replaceChildren(detail(row)); host.dataset.desktopMode = "detail"; }
    }
    paintSidebar();
    if (focus) {
      const replacement = [...stage.querySelectorAll("button,input,select")].find(item => item.tagName === focus.tag &&
        (focus.tab !== undefined ? item.dataset.homeDesktopTab === focus.tab : focus.tool ? item.dataset.ldTool === focus.tool : focus.label ? item.getAttribute("aria-label") === focus.label : item.textContent === focus.text));
      replacement?.focus({ preventScroll: true });
    }
  }
  paint();
}
