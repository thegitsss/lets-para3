import { node, link, button, page, region } from "./dom.mjs";
import { SOURCES, count, id, validId, dates, person, profileComplete, matterHref, reviewHref, reconcileUnread } from "./read-model.mjs";
import { readHomeInventory, readHomeApplications } from './home-inventory-model.mjs';

export async function readConversationThreads(api, signal) {
  const first = await api.get(SOURCES.threads, { signal });
  if (!Array.isArray(first.threads) || !Number.isSafeInteger(first.total) || first.total < first.threads.length) throw new TypeError("Invalid conversation list");
  const threads = [...first.threads];
  const seen = new Set(threads.map(id));
  for (let page = 2; threads.length < first.total; page += 1) {
    const next = await api.get(`${SOURCES.threads}&page=${page}`, { signal });
    if (next.total !== first.total || !Array.isArray(next.threads) || !next.threads.length || next.threads.some(thread => seen.has(id(thread)))) throw new TypeError("Conversation list changed; retry");
    next.threads.forEach(thread => seen.add(id(thread)));
    threads.push(...next.threads);
  }
  if (threads.length !== first.total || seen.size !== threads.length || threads.some(thread => !validId(id(thread)))) throw new TypeError("Invalid conversation list");
  return { ...first, threads };
}

export function createReader(api, signal) {
  const pending = new Map();
  return (key) => {
    if (!pending.has(key)) {
      const request = (key === "threads" ? readConversationThreads(api, signal) : api.get(SOURCES[key], { signal })).finally(() => { if (pending.get(key) === request) pending.delete(key); });
      pending.set(key, request);
    }
    return pending.get(key);
  };
}
const note = (text) => node("p", { className: "av2-muted", text });
const notice = (text) => node("p", { className: "av2-notice", text });
const list = (rows, empty) => rows.length ? node("ul", { className: "av2-summary-list" }, rows) : note(empty);
const homeIcon = (kind) => {
  const paths = {
    files: "M13 3H5v18h14V9l-6-6v6h6M8 13h8m-8 4h5",
    applications: "M9 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM3 20v-2a6 6 0 0 1 12 0v2m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2",
    messages: "M4 4h16v12H9l-5 4V4Z",
    tasks: "m3 7 2 2 4-4m4 2h8M3 16l2 2 4-4m4 2h8",
    plus: "M12 5v14M5 12h14",
  };
  if (!Object.hasOwn(paths, kind)) return null;
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(icon.namespaceURI, "path");
  path.setAttribute("d", paths[kind]);
  icon.append(path);
  return icon;
};
const reviewRow = (title, detail, label, href, kind) => {
  const target = link("", href, "av2-home-review-link");
  target.setAttribute("aria-label", `${title}${detail ? ` — ${detail}` : ""}. ${label}`);
  target.append(...[
    homeIcon(kind),
    node("div", { className: "av2-review-copy" }, [node("h3", { text: title }), ...(detail ? [note(detail)] : [])]),
  ].filter(Boolean));
  if (kind !== "messages") {
    target.classList.add("av2-home-action-row");
    target.replaceChildren(node("span", { className: "av2-record-title", text: title }), node("span", { className: "av2-review-reason", text: detail }), node("span", { className: "av2-review-action", text: label }));
  }
  return node("li", { className: "av2-summary-row av2-review-row" }, [target]);
};

export function conversationRow(thread, data) {
      const preview = reviewRow(thread.title || "Matter messages", thread.lastMessageSnippet || "No messages yet.", "Open conversation", `#/conversations?matter=${id(thread)}`, "messages");
      const copy = preview.querySelector('.av2-review-copy');
      if (thread.lastSenderName) copy.querySelector('.av2-muted').prepend(node('strong', { className: 'av2-message-sender', text: `${thread.lastSenderName}: ` }));
      const unread = data.mismatch ? 0 : data.byId.get(id(thread)) || 0;
      preview.classList.toggle("av2-conversation-unread", Boolean(unread));
      if (unread) preview.querySelector('.av2-review-copy').append(node("span", { className: "av2-unread-label", text: `${unread} unread` }));
      return preview;
}
export function activityTime(value) {
  const at = new Date(value || '').getTime();
  if (!Number.isFinite(at)) return node('span', { className: 'av2-home-matter-activity', text: 'Unavailable' });
  const date = new Date(at), now = new Date(), minutes = Math.max(0, Math.floor((now - date) / 60000));
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const text = minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes} min ago`
    : date.toDateString() === now.toDateString() ? `${Math.floor(minutes / 60)} hr ago`
    : date.toDateString() === yesterday.toDateString() ? 'Yesterday'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return node('time', { className: 'av2-home-matter-activity', datetime: date.toISOString(), title: date.toLocaleString(), text });
}
const matterRow = (item) => {
  const target = link("", matterHref(item), "av2-home-record-link av2-home-matter");
  target.append(node("div", {}, [node("span", { className: "av2-record-title", text: item.title || "Untitled Matter" })]), node("span", { className: "av2-home-matter-person", text: item.assignedParalegalName || "—" }), activityTime(item.lastActivityAt));
  return node("li", { className: "av2-summary-row" }, [target]);
};
const deadlineRow = (item) => {
  const value = dates.normalize(item.dueDate);
  const date = new Date(`${value}T12:00:00Z`);
  const stamp = node("time", { className: "av2-home-date", datetime: value, "aria-label": dates.format(value) }, [
    node("span", { text: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date) }),
    node("strong", { text: value.slice(-2).replace(/^0/, "") }),
  ]);
  const target = link("", matterHref(item, "activity"), "av2-home-record-link av2-home-deadline");
  target.append(stamp, node("div", {}, [node("span", { className: "av2-record-title", text: item.title || "Untitled Matter" }), note("Matter deadline")]));
  return node("li", { className: "av2-summary-row" }, [target]);
};

function onboarding(progress, identity, { api, signal }) {
  const key = `lpc_attorney_v2_onboarding:${identity.id}`;
  let state = {};
  try { state = JSON.parse(sessionStorage.getItem(key) || "{}") || {}; } catch { /* Storage is optional. */ }
  if (typeof state !== "object" || Array.isArray(state)) state = {};
  if (state.tour !== undefined && (!Number.isInteger(state.tour) || state.tour < 0 || state.tour > 3)) delete state.tour;
  let replayRequested = new URLSearchParams(location.search).get("replayTour") === "1" || new URLSearchParams(location.hash.split("?")[1]).get("replayTour") === "1";
  try {
    if (sessionStorage.getItem("lpc_attorney_replay_tour") === "1") replayRequested = true;
    sessionStorage.removeItem("lpc_attorney_replay_tour");
  } catch { /* URL and visible replay controls still work. */ }
  if (replayRequested) {
    state.replaying = true;
    const url = new URL(location.href);
    url.searchParams.delete("replayTour");
    const [path, query] = url.hash.split("?");
    const params = new URLSearchParams(query);
    params.delete("replayTour");
    url.hash = `${path}${params.size ? `?${params}` : ""}`;
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }
  state.tourCompleted = progress.tourCompleted || state.tourCompleted === true;
  if (replayRequested || (identity.isFirstLogin && !progress.tourCompleted && !state.tourCompleted && !state.dismissed && state.tour === undefined)) {
    state.dismissed = false; state.tour = 0;
  }
  const save = () => { try { sessionStorage.setItem(key, JSON.stringify(state)); } catch { /* Navigation remains available. */ } };
  const tourSteps = [
    { title: "Profile", copy: "Edit the practice details on your profile.", label: "Open profile", href: "#/settings" },
    { title: "Payment method", copy: "Manage your card for Matter funding.", label: "Open payment settings", href: "#/payments/setup" },
    { title: "Matters", copy: "Manage postings, applications, and work.", label: "View Matters", href: "#/matters" },
    { title: "Paralegals", copy: "Find and invite paralegals to your Matters.", label: "Browse paralegals", href: "#/paralegals" },
  ];
  const wrapper = node("div", { className: "av2-home-onboarding", "data-av2-onboarding": "" });
  if (state.dismissed || (state.tourCompleted && !state.replaying)) { save(); return wrapper; }
  const guide = node("details", { className: "av2-home-setup av2-workspace-guide" });
  const summary = node("summary", { text: "Workspace guide" });
  const contents = node("div", { className: "av2-guide-content" });
  guide.open = !state.dismissed && Number.isInteger(state.tour);
  guide.addEventListener("toggle", () => { state.dismissed = !guide.open; save(); });
  let saving = false, saveError = "", guideFinished = false;
  const changeStep = value => {
    state.tour = value; state.dismissed = false; guideFinished = false; saveError = "";
    save(); draw(); guide.open = true;
    contents.querySelector('[data-guide-title]')?.focus();
  };
  async function finishTour() {
    if (saving || signal.aborted) return;
    saving = true; saveError = ""; draw();
    try {
      await api.completeAttorneyTour({ signal });
      if (signal.aborted) return;
      state.tourCompleted = true; state.replaying = false; guideFinished = true; delete state.tour;
      try {
        sessionStorage.setItem("lpc_attorney_tour_completed", "1");
        sessionStorage.removeItem("lpc_attorney_tour_active");
        sessionStorage.removeItem("lpc_attorney_tour_step");
      } catch { /* Optional storage. */ }
      save();
    } catch {
      saveError = "Couldn’t save guide completion. Try again.";
    } finally {
      if (!signal.aborted) {
        saving = false; draw();
        if (saveError) contents.querySelector('[data-setup-next]')?.focus();
        else removeGuide();
      }
    }
  }
  const removeGuide = () => {
    guide.remove();
    const heading = document.querySelector('.av2-home h1');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
  };
  const closeGuide = () => {
    state.dismissed = true; state.replaying = false; delete state.tour;
    try {
      sessionStorage.removeItem("lpc_attorney_onboarding_step");
      sessionStorage.setItem("lpc_attorney_onboarding_dismissed", "1");
      sessionStorage.removeItem("lpc_attorney_tour_active");
      sessionStorage.removeItem("lpc_attorney_tour_step");
    } catch { /* Closing never depends on browser storage. */ }
    save(); removeGuide();
  };
  function draw() {
    contents.replaceChildren();
    const guided = Number.isInteger(state.tour);
    if (!guided) {
      if (guideFinished) contents.append(node("p", { className: "av2-muted", role: "status", tabindex: "-1", text: "Workspace guide finished." }));
      const start = button(state.tourCompleted ? "Replay" : "Start", () => changeStep(0), "av2-guide-start");
      start.setAttribute("aria-label", state.tourCompleted ? "Replay workspace guide" : "Start workspace guide");
      contents.append(start);
      return;
    }
    const step = tourSteps[state.tour];
    contents.append(
      node("p", { className: "av2-guide-progress", text: `Tour · ${state.tour + 1} of ${tourSteps.length}` }),
      node("h3", { text: step.title, tabindex: "-1", "data-guide-title": "" }),
      note(step.copy),
      link(step.label, step.href, "av2-guide-destination"),
    );
    const previous = button("Back", () => changeStep(state.tour - 1), "av2-guide-back");
    previous.disabled = saving || state.tour === 0;
    const next = button(saving ? "Saving…" : state.tour < 3 ? "Next" : "Finish tour", () => {
      if (state.tour < 3) changeStep(state.tour + 1); else void finishTour();
    }, "av2-guide-next");
    next.disabled = saving; next.dataset.setupNext = "";
    const close = button("Close", closeGuide, "av2-guide-close");
    close.disabled = saving;
    contents.append(node("div", { className: "av2-guide-controls", "aria-label": "Workspace tour navigation" }, [close, previous, next]));
    if (saveError) contents.append(node("p", { className: "av2-notice", role: "alert", text: saveError }));
  }
  guide.append(summary, contents); wrapper.append(guide);
  save(); draw();
  return wrapper;
}

export function createHome(identity, { api, signal }) {
  const read = createReader(api, signal);
  const section = page("Today");
  section.classList.add("av2-home");
  const today = new Date();
  const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  section.querySelector('.av2-view-header').append(node('time', { className: 'av2-home-today', datetime: localDate, text: new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(today) }));
  const requestedPages = new URLSearchParams(location.hash.split('?')[1]);
  const pages = Object.fromEntries(['attentionPage', 'deadlinePage'].map(key => [key, Math.min(999999, Math.max(1, Number.parseInt(requestedPages.get(key), 10) || 1))]));
  let homePending;
  const records = () => {
    if (!homePending) {
      const currentPages = { ...pages };
      const query = new URLSearchParams({ expectedOwnerId: identity.id, attentionPage: String(currentPages.attentionPage), deadlinePage: String(currentPages.deadlinePage) });
      const request = api.get(`/api/cases/inventory/home?${query}`, { signal }).then(value => readHomeInventory(value, identity.id, currentPages.attentionPage, currentPages.deadlinePage)).finally(() => { if (homePending === request) homePending = null; });
      homePending = request;
    }
    return homePending;
  };
  const paging = (data, key, label, panel) => {
    const controls = node("nav", { className: "av2-actions", "aria-label": `${label} pages` });
    const go = async page => {
      pages[key] = page; homePending = null;
      const url = new URL(location.href), query = new URLSearchParams(url.hash.split('?')[1]);
      if (page === 1) query.delete(key); else query.set(key, String(page));
      url.hash = `#/home${query.size ? `?${query}` : ''}`;
      history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
      await panel.refresh();
      if (!signal.aborted) { const heading = panel.querySelector('h2'); heading.tabIndex = -1; heading.focus(); }
    };
    if (data.page > 1) controls.append(button(`Previous ${label.toLowerCase()} page`, () => void go(data.page - 1)));
    if (data.page < data.pages) controls.append(button(`Next ${label.toLowerCase()} page`, () => void go(data.page + 1)));
    if (data.page > data.pages) controls.append(button(`First ${label.toLowerCase()} page`, () => void go(1)));
    return controls.childElementCount ? [controls] : [];
  };
  const grid = node("div", { className: "av2-home-grid" });
  const panels = new Map();
  const destinations = {
    applications: ["All applications", "#/matters?view=applications"],
    recent: ["View all", "#/matters"],
  };
  const add = (title, key, load, render) => {
    const panel = region(title, { key, signal, load, render });
    panel.querySelector(".av2-refresh").dataset.retryLabel = "Retry";
    if (destinations[key]) {
      const target = link(...destinations[key], "av2-home-section-link");
      panel.querySelector('.av2-card-heading').append(target);
    }
    panels.set(key, panel);
    return panel;
  };
  add("Matter summary", "overview", records, data => [node("dl", { className: "av2-metrics" }, [
    ["Active Matters", data.counts.active, "#/matters?view=active"],
    ["With applications", data.counts.applications, "#/matters?view=applications"],
    ["Drafts", data.counts.draft, "#/matters?view=draft"],
    ["Archived", data.counts.archived, "#/matters?view=archived"],
  ].map(([label, total, href]) => {
    const target = link("", href, "av2-metric-link");
    target.append(node("strong", { text: total }), node("span", { text: label }));
    target.setAttribute("aria-label", `${label}: ${total}`);
    return node("div", {}, [node("dt", { className: "av2-metric-label", text: label }), node("dd", {}, [target])]);
  })) ]);
  const attentionPanel = add("Needs attention", "attention", async () => {
    const [data, overdue] = await Promise.all([records(), read("overdue")]);
    return { ...data.attention, overdue: count(overdue.total) };
  }, data => {
    panels.get("attention").dataset.empty = String(!data.total && !data.overdue);
    const rows = data.items.map(matter => {
      const actions = matter.actions.map(action => {
      const [title, label, href] = {
        files: ["Files submitted for review", "Review files", matterHref(matter, "files")],
        moderation: ["Listing needs review", "Review listing", `#/matters/${matter.id}/manage`],
        payment: ["Payment status needs review", "Review payment status", matterHref(matter, "financials")],
        withdrawal: ["Withdrawal · response due", "Review withdrawal", matterHref(matter, "financials")],
      }[action];
        return { title, label, href, kind: action };
      });
      const first = actions[0];
      const result = reviewRow(matter.title || "Untitled Matter", actions.map(action => action.title).join(" · "), first.label, first.href, first.kind);
      if (actions.length > 1) {
        const more = node("details", { className: "av2-review-options" }, [node("summary", { text: `${actions.length} actions` })]);
        more.append(node("nav", { "aria-label": `Actions for ${matter.title || "Matter"}` }, actions.map(action => link(action.label, action.href))));
        result.append(more);
      }
      return result;
    });
    if (data.overdue) rows.unshift(reviewRow("Private tasks", `${data.overdue} overdue`, "View overdue tasks", "#/tasks?status=overdue", "tasks"));
    return [
      ...(data.total > 5 ? [note(`${data.total} Matters need attention · Page ${data.page} of ${data.pages}`)] : []),
      list(rows, data.total ? "No Matters on this page." : "No outstanding items in your Matters or private tasks."),
      ...paging(data, "attentionPage", "Attention", attentionPanel),
    ];
  });
  add("Applications", "applications", async () => readHomeApplications(await api.readReceivedApplications({ ownerId: identity.id, signal })), apps => {
    panels.get("applications").dataset.empty = String(!apps.length);
    return [
    ...(apps.length > 3 ? [note(`Showing 3 of ${apps.length} applications`)] : []),
    list(apps.slice(0, 3).map(app => reviewRow(app.jobTitle || "Matter application", `${person(app.paralegal) || "A paralegal"} applied`, "View application", validId(app.caseId) ? reviewHref({ id: app.caseId, applicantId: id(app.paralegal), applicationId: id(app) }) : "#/matters?view=applications", "applications")), "No applications to review."),
    ];
  });
  let conversationsExpanded = false;
  const messagesPanel = add("Messages", "messages", async () => {
    const results = await Promise.all([read("unread"), read("messageSummary"), read("threads")]);
    return reconcileUnread(...results);
  }, (data) => {
    const content = node("div");
    const paint = (focus = false) => {
      const visible = conversationsExpanded ? data.threads : data.threads.slice(0, 3);
      const toggle = button(conversationsExpanded ? "Show fewer" : "View All", () => { conversationsExpanded = !conversationsExpanded; paint(true); }, "av2-text-link");
      toggle.setAttribute("aria-expanded", String(conversationsExpanded));
      toggle.setAttribute("aria-controls", "av2-home-conversations-list");
      const rows = list(visible.map(thread => conversationRow(thread, data)), "No Matter conversations yet.");
      rows.id = "av2-home-conversations-list";
      content.replaceChildren(
        ...(data.mismatch ? [notice("Unread counts are updating.")] : []), rows,
        ...(!data.mismatch && data.total > visible.reduce((sum, thread) => sum + (data.byId.get(id(thread)) || 0), 0) ? [note(`${data.total} unread messages across your Matters`)] : []),
        ...(data.totalThreads > 3 ? [node("div", { className:"av2-conversations-footer" }, [node("span", { className:"av2-home-list-count", text:`${visible.length} of ${data.totalThreads} conversations` }), toggle])] : [])
      );
      if (focus) toggle.focus();
    };
    paint();
    return [content];
  });
  // Reuse the shell's one notification stream/polling cycle. Coalesce bursts
  // without restarting a slow read, and discard results when this route leaves.
  let messagesRefresh = null, messagesDirty = false;
  messagesPanel.refreshFromNotice = () => {
    if (signal.aborted) return Promise.resolve();
    messagesDirty = true;
    if (!messagesRefresh) messagesRefresh = (async () => {
      await messagesPanel.readiness;
      do { messagesDirty = false; await messagesPanel.refresh({ background: true }); }
      while (messagesDirty && !signal.aborted);
    })().finally(() => { messagesRefresh = null; });
    return messagesRefresh;
  };
  const deadlinesPanel = add("This week’s deadlines", "deadlines", records, data => {
    deadlinesPanel.dataset.empty = String(data.week.total === 0);
    return [
    ...(data.week.total ? [note(`${dates.format(data.week.start)} – ${dates.format(data.week.end)}`)] : []),
    ...(data.week.total > 3 ? [note(`${data.week.total} deadlines · Page ${data.week.page} of ${data.week.pages}`)] : []),
    list(data.week.items.map(deadlineRow), data.week.total ? "No deadlines on this page." : "No deadlines this week."),
    ...paging(data.week, "deadlinePage", "Deadline", deadlinesPanel),
  ]; });
  add("Recent Matters", "recent", records, data => [
    ...(data.recent.items.length ? [node("div", { className: "av2-matter-columns", "aria-hidden": "true" }, [node("span", { text: "Matter" }), node("span", { text: "Paralegal" }), node("span", { text: "Last activity" })])] : []),
    list(data.recent.items.map(matterRow), "No current Matters yet."),
    ...(data.recent.total > data.recent.items.length ? [node("p", { className: "av2-home-list-count", text: `${data.recent.items.length} of ${data.recent.total} current Matters`, "aria-label": `Showing ${data.recent.items.length} of ${data.recent.total} current Matters` })] : []),
  ]);
  const setupPanel = add("Account setup", "onboarding", async () => {
    const [profile, payment, data] = await Promise.all([read("profile"), read("payment"), records()]);
    if (!payment || !Object.hasOwn(payment, "paymentMethod")) throw new TypeError("Invalid payment readiness");
    return { profile: profileComplete(profile), payment: Boolean(payment.paymentMethod), case: data.postedCount > 0, tourCompleted: profile.onboarding?.attorneyTourCompleted === true };
  }, (progress) => [onboarding(progress, identity, { api, signal })]);
  // A single review list retains each source's independent loading and recovery.
  const reviewHeading = node("div", { className: "av2-card-heading" }, [node("h2", { id: "av2-home-review-title", text: "For your review" })]);
  const review = node("section", { className: "av2-home-review", "aria-labelledby": "av2-home-review-title" }, [
    reviewHeading,
    node("div", { className: "av2-review-list", tabindex: "0", "aria-label": "Matter and application review items" }, [attentionPanel, panels.get("applications")]),
    node("p", { className: "av2-muted av2-review-clear", text: "No outstanding Matter or application reviews." }),
  ]);
  const primary = node("div", { className: "av2-home-primary" }, [review, messagesPanel, panels.get("recent"), deadlinesPanel, setupPanel]);
  grid.append(primary);
  section.append(panels.get("overview"), grid);
  section.readiness = Promise.all([...panels.values()].map((panel) => panel.readiness));
  return section;
}
