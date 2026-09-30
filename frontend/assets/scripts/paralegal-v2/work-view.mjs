import { safeMatterReturn, withMatterReturn } from "./router.mjs";
import { loadReceivedInvitations } from "../utils/received-invitations.mjs";
import { createEarlierApplicationWithdrawal } from "../utils/earlier-application-withdrawal.mjs";
import { createPreEngagementDrafts } from "../utils/pre-engagement-drafts.mjs";
import { historyWorkLabel, loadParalegalHistory, renderHistoryPayout } from "../utils/paralegal-history.mjs";
const WORK_CACHE_TTL_MS = 30_000;
const PAGE_SIZE = 3;
const APPLICATION_SCOPE = "paralegal_applications";
const BUILT_IN_VIEWS = Object.freeze([
  Object.freeze({ id: "recent", name: "Recent applications", filters: Object.freeze({ search: "", status: "all", practice: "all", dateRange: "30", sort: "newest" }) }),
  Object.freeze({ id: "all", name: "All applications", filters: Object.freeze({ search: "", status: "all", practice: "all", dateRange: "all", sort: "newest" }) }),
  Object.freeze({ id: "oldest", name: "Waiting longest", filters: Object.freeze({ search: "", status: "all", practice: "all", dateRange: "all", sort: "oldest" }) }),
]);

let cachedSnapshot = null;
let cachedAt = 0;
let pendingSnapshot = null;
let cacheRevision = 0;

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else if (name === "hidden") element.hidden = Boolean(value);
    else if (name === "checked") element.checked = Boolean(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  children.flat().filter(Boolean).forEach((child) => {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return element;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function result(settled) {
  return settled.status === "fulfilled"
    ? { available: true, value: settled.value }
    : { available: false, value: null, error: settled.reason };
}

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return normalizeId(value._id || value.id || value.caseId || value.jobId || "");
}

function caseId(value = {}) {
  return normalizeId(value.caseId || value.case || value._id || value.id || "");
}

function applicationId(value = {}) {
  return normalizeId(value._id || value.id || value.applicationId || "");
}

function applicationJob(value = {}) {
  const job = value.jobId || value.job || {};
  return job && typeof job === "object" ? job : {};
}

function jobId(value = {}) {
  const job = applicationJob(value);
  return normalizeId(job._id || job.id || value.jobId || "");
}

function applicationStatus(value = {}) {
  return String(value.status || value.applicationStatus || value.application_status || value.state || "submitted")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function humanStatus(value) {
  const clean = String(value || "submitted").replace(/_/g, " ").trim().toLowerCase();
  if (clean === "rejected") return "Not selected";
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "Submitted";
}

export function retainedApplications(applications = []) {
  return applications.filter((application) => {
    const job = applicationJob(application);
    if (!normalizeId(job._id || job.id) && !job.title) return false;
    return true;
  });
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateLabel(value, fallback = "Date not recorded") {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function deadlineLabel(value) {
  const direct = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(direct)) return "No deadline listed";
  return new Date(`${direct}T12:00:00.000Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function money(value = 0, currency = "USD") {
  const amount = Number(value);
  return (Number.isFinite(amount) ? amount : 0).toLocaleString(undefined, {
    style: "currency",
    currency: String(currency || "USD").toUpperCase(),
  });
}

function centsOrBudget(job = {}) {
  if (Number(job.lockedTotalAmount) > 0) return Number(job.lockedTotalAmount) / 100;
  if (Number(job.totalAmount) > 0) return Number(job.totalAmount) / 100;
  return Math.max(0, Number(job.budget) || 0);
}

function preEngagement(value = {}) {
  if (["withdrawn", "rejected", "hired"].includes(applicationStatus(value))) return null;
  const pre = value.preEngagement;
  if (!pre || typeof pre !== "object") return null;
  const status = String(pre.status || "").trim().toLowerCase();
  if (!["requested", "submitted", "changes_requested"].includes(status)) return null;
  return { ...pre, status };
}

function preEngagementLabel(application) {
  const pre = preEngagement(application);
  if (!pre) return "";
  if (pre.status === "changes_requested") return "Changes requested";
  if (pre.status === "requested") return "Information needed before hiring";
  return "With attorney for review";
}

function applicationIsFunded(application = {}) {
  const job = applicationJob(application);
  return application.casePaymentReleased === true || job.paymentReleased === true ||
    String(application.caseEscrowStatus || job.escrowStatus || "").toLowerCase() === "funded";
}

function applicationIsRevocable(application = {}) {
  if (["withdrawn", "rejected", "hired"].includes(applicationStatus(application))) return false;
  if (application.applicationSource === 'case_applicant') return application.withdrawal?.available === true;
  const inviteAccepted = String(application.applicationSource || "").toLowerCase() === "invite_accept" && caseId(application);
  const currentJobStatus = String(applicationJob(application).status || "").toLowerCase();
  if (applicationIsFunded(application)) return false;
  if (currentJobStatus && currentJobStatus !== "open" && !inviteAccepted) return false;
  return Boolean(applicationId(application) || inviteAccepted);
}

function payoutReadiness(snapshot = {}) {
  if (!snapshot.payoutStatus?.available) return "unknown";
  return snapshot.payoutStatus.value?.readiness?.ready === true ? "ready" : "incomplete";
}

async function loadSnapshot(api, { force = false, ownerId, isCurrent = () => true } = {}) {
  while (true) {
    if (!ownerId || !isCurrent()) throw new DOMException("View changed", "AbortError");
    if (!force && cachedSnapshot?.ownerId === ownerId && Date.now() - cachedAt < WORK_CACHE_TTL_MS) return cachedSnapshot;
    if (pendingSnapshot) {
      const pending = pendingSnapshot;
      try {
        await pending;
      } catch (error) {
        if (pending === pendingSnapshot) throw error;
      }
      continue;
    }
    const revision = cacheRevision;
    const request = (async () => {
    const settled = await Promise.allSettled([
      api.get(`/api/paralegal/dashboard?expectedOwnerId=${encodeURIComponent(ownerId)}`),
      api.get("/api/applications/my"),
      loadReceivedInvitations(api, ownerId, { isCurrent: () => revision === cacheRevision && isCurrent() }),
      loadParalegalHistory(api, ownerId, { isCurrent: () => revision === cacheRevision && isCurrent() }),
      api.get(`/api/account/dashboard-views?scope=${APPLICATION_SCOPE}&expectedOwnerId=${encodeURIComponent(ownerId)}`),
      api.get("/api/payments/connect/status"),
    ]);
    const dashboard = result(settled[0]);
    const applications = result(settled[1]);
    const invitations = result(settled[2]);
    const history = result(settled[3]);
    const savedViews = result(settled[4]);
    if (savedViews.available && (savedViews.value?.ownerId !== ownerId || savedViews.value?.scope !== APPLICATION_SCOPE || !Array.isArray(savedViews.value?.views) || savedViews.value.views.some(view => !/^[a-f0-9]{64}$/.test(view.revision || "")))) { savedViews.available = false; savedViews.value = null; }
    const payoutStatus = result(settled[5]);
    if (![dashboard, applications, invitations, history].some((entry) => entry.available)) {
      throw settled[0].reason || new Error("Work is unavailable");
    }
    const snapshot = Object.freeze({
      loadedAt: Date.now(), ownerId,
      dashboard,
      applications,
      invitations,
      history,
      savedViews,
      payoutStatus,
      activeCases: normalizeList(dashboard.value?.activeCases),
      activeApplications: retainedApplications(normalizeList(applications.value)),
      pendingInvitations: normalizeList(invitations.value),
      completedCases: normalizeList(history.value),
      customViews: normalizeList(savedViews.value?.views),
    });
    return snapshot;
    })();
    pendingSnapshot = request;
    try {
      let snapshot;
      try {
        snapshot = await request;
      } catch (error) {
        if (revision !== cacheRevision) continue;
        throw error;
      }
      if (revision !== cacheRevision) continue;
      // A superseded view can abort protected reads while other reads succeed.
      // Its partial result must not become the next view's cached snapshot.
      if (!isCurrent()) throw new DOMException("View changed", "AbortError");
      cachedSnapshot = snapshot;
      cachedAt = Date.now();
      return snapshot;
    } finally {
      if (pendingSnapshot === request) pendingSnapshot = null;
    }
  }
}

function pageSlice(items, page) {
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  return { items: items.slice(start, start + PAGE_SIZE), page: safePage, totalPages, start, end: Math.min(start + PAGE_SIZE, items.length) };
}

function correctedPager(label, pageData, total, onPage) {
  if (pageData.totalPages <= 1) return null;
  const previous = node("button", { type: "button", text: "Previous", disabled: pageData.page <= 1 ? "" : null });
  const next = node("button", { type: "button", text: "Next", disabled: pageData.page >= pageData.totalPages ? "" : null });
  previous.addEventListener("click", () => onPage(pageData.page - 1));
  next.addEventListener("click", () => onPage(pageData.page + 1));
  return node("nav", { className: "v2-work-pager", "aria-label": `${label} pages` }, [
    previous,
    node("span", { text: `${pageData.start + 1}–${pageData.end} of ${total}` }),
    next,
  ]);
}

function localError(copy, retry) {
  const button = node("button", { className: "v2-work-text-action", type: "button", text: "Try again" });
  button.addEventListener("click", retry);
  return node("div", { className: "v2-work-empty is-error" }, [node("p", { text: copy }), button]);
}

function sectionHeading(title, id) {
  return node("header", { className: "v2-work-section-heading" }, [node("h2", { id, text: title })]);
}

function activeMatterRow(matter) {
  const id = caseId(matter);
  const source = safeMatterReturn(window.location.hash.slice(1)) || '/work';
  const [path, query] = source.split('?'), parameters = new URLSearchParams(query);
  parameters.set('highlightCase',id);
  const href = withMatterReturn(`/matter/${encodeURIComponent(id)}?tab=overview`,path + '?' + parameters);
  const tasksTotal = Math.max(0, Number(matter.tasksTotal) || 0);
  const tasksRemaining = Math.max(0, Number(matter.tasksRemaining) || 0);
  const context = [matter.practiceArea, matter.attorneyName ? `With ${matter.attorneyName}` : ""].filter(Boolean).join(" · ");
  const progress = tasksTotal ? `${Math.max(0, tasksTotal - tasksRemaining)} of ${tasksTotal} work items complete` : null;
  const link = id
    ? node("a", { className: "v2-work-row-action", href: `paralegal-v2.html#${href}`, "data-view": href, "data-v2-route": "", text: "Open workspace" })
    : node("span", { className: "v2-work-row-action is-disabled", "aria-disabled": "true", text: "Matter unavailable" });
  return node("article", { className: "v2-work-matter-row", "data-work-case-id": id }, [
    node("div", { className: "v2-work-row-main" }, [
      context ? node("p", { className: "v2-work-row-overline", text: context }) : null,
      node("h3", { text: matter.jobTitle || matter.title || "Matter" }),
      progress ? node("p", { text: progress }) : null,
    ]),
    node("dl", { className: "v2-work-row-facts" }, [
      node("div", {}, [node("dt", { text: "Status" }), node("dd", { text: humanStatus(matter.status || "active") })]),
      node("div", {}, [node("dt", { text: "Deadline" }), node("dd", { text: deadlineLabel(matter.deadlineDate || matter.deadline) })]),
    ]),
    link,
  ]);
}

function activeSection(snapshot, state, actions) {
  const section = node("section", { className: "v2-work-section v2-work-active", id: "v2-work-active", "aria-labelledby": "v2-work-active-title" });
  section.append(sectionHeading("Active Matters", "v2-work-active-title"));
  if (!snapshot.dashboard.available) {
    section.append(localError("Your active matters couldn’t load.", actions.reload));
    return section;
  }
  if (!snapshot.activeCases.length) {
    section.append(node("div", { className: "v2-work-empty" }, [
      node("p", { text: "No active matters yet." }),
      node("span", { text: "New assignments will appear here after hiring and funding are complete." }),
    ]));
    return section;
  }
  const page = pageSlice(snapshot.activeCases, state.activePage);
  const list = node("div", { className: "v2-work-list" }, page.items.map(activeMatterRow));
  section.append(list);
  const pagination = correctedPager("Active Matters", page, snapshot.activeCases.length, (next) => actions.page("activePage", next));
  if (pagination) section.append(pagination);
  return section;
}

function inviteRow(invite, readiness, actions, { inline = false } = {}) {
  const id = caseId(invite);
  const amountCents = typeof invite.lockedTotalAmount === "number" ? invite.lockedTotalAmount : Number(invite.totalAmount);
  const attorney = invite.attorney || invite.attorneyId || {};
  const attorneyName = attorney.name || [attorney.firstName, attorney.lastName].filter(Boolean).join(" ") || "Attorney";
  let accept;
  if (readiness === "ready") {
    accept = node("button", { className: "v2-work-primary", type: "button", text: "Accept invitation", disabled: id ? null : "" });
    accept.addEventListener("click", () => actions.respondInvite(invite, "accept", accept));
  } else if (readiness === "incomplete") {
    accept = node("a", {
      className: "v2-work-primary",
      href: "paralegal-v2.html#/settings?tab=security&section=payments",
      "data-view": "/settings?tab=security&section=payments",
      "data-v2-route": "",
      text: "Connect Stripe to receive your payouts",
    });
  } else {
    accept = node("button", { className: "v2-work-primary", type: "button", text: "Check payout status" });
    accept.addEventListener("click", actions.reload);
  }
  const decline = node("button", { className: "v2-work-secondary", type: "button", text: "Decline", disabled: id ? null : "" });
  decline.addEventListener("click", () => actions.confirmInviteDecline(invite, decline));
  const article = node("article", { className: "v2-work-invite-row", "data-work-invite-id": id }, [
    node("div", {}, [
      node("p", { className: "v2-work-invite-from", text: `Invitation from ${attorneyName}` }),
      node("h3", { text: invite.title || "Matter invitation" }),
      invite.briefSummary || invite.details ? node("p", { text: invite.briefSummary || invite.details, "data-invite-preview-repeat": (invite.briefSummary || invite.details) === (invite.details || invite.description || invite.briefSummary) }) : null,
    ]),
    node("dl", {}, [
      node("div", {}, [node("dt", { text: "Practice area" }), node("dd", { text: invite.practiceArea || "Practice area not listed" })]),
      node("div", {}, [node("dt", { text: "Compensation" }), node("dd", { text: Number.isFinite(amountCents) ? money(amountCents / 100, invite.currency) : "Not listed" })]),
      node("div", {}, [node("dt", { text: "Invited" }), node("dd", { text: dateLabel(invite.inviteInvitedAt || invite.pendingParalegalInvitedAt) })]),
    ]),
    node("details", { className: "v2-work-invite-scope", open: actions.openInvitations.has(id) }, [
      node("summary", { text: "Review full invitation" }),
      node("h4", { text: "Matter scope" }),
      node("p", { className: "v2-work-invite-description", text: invite.details || invite.description || invite.briefSummary || "No additional description provided." }),
      node("ul", {}, (Array.isArray(invite.tasks) ? invite.tasks : []).map((task) => node("li", { text: typeof task === "string" ? task : task.title || "Work item" }))),
      node("dl", {}, [
        node("div", {}, [node("dt", { text: "Jurisdiction" }), node("dd", { text: invite.state || invite.locationState || "Not listed" })]),
        node("div", {}, [node("dt", { text: "Experience" }), node("dd", { text: Number(invite.minimumYearsExperience) > 0 ? `${invite.minimumYearsExperience}+ years required` : "No minimum listed" })]),
        node("div", {}, [node("dt", { text: "Deadline" }), node("dd", { text: deadlineLabel(invite.deadlineDate || invite.deadline) })]),
        node("div", {}, [node("dt", { text: "Estimated payout for approved work · 18% fee" }), node("dd", { text: Number.isFinite(amountCents) ? money(Math.round(amountCents * 0.82) / 100, invite.currency) : "Not listed" })]),
      ]),
      normalizeId(attorney) ? node("a", { href: `paralegal-v2.html#/attorney/${encodeURIComponent(normalizeId(attorney))}`, "data-v2-route": "", "data-view": `/attorney/${encodeURIComponent(normalizeId(attorney))}`, text: "View attorney profile" }) : null,
    ]),
    node("div", { className: "v2-work-invite-action-group" }, [
      node("p", { text: "Accepting confirms interest. Work starts after any requested checks, hiring, and funding." }),
      readiness === "incomplete" ? node("p", { text: "Payout setup is required before accepting." }) : null,
      readiness === "unknown" ? node("p", { text: "We couldn’t check your payout setup. Please try again before accepting." }) : null,
      node("div", { className: "v2-work-invite-actions" }, [decline, accept]),
    ]),
  ]);
  if (inline) {
    // Retain the existing decision owners while presenting one properties group
    // and the complete scope directly in the selected context.
    const identity = article.firstElementChild;
    identity.querySelector('h3')?.remove();
    identity.querySelector('p:not(.v2-work-invite-from)')?.remove();
    const scope = article.querySelector('.v2-work-invite-scope');
    const extra = scope.querySelector('dl');
    article.querySelector('dl').append(...extra.children);
    extra.remove();
    scope.querySelector('summary').remove();
    const content = node('section', { className: 'v2-work-invite-scope' });
    content.append(...scope.childNodes);
    scope.replaceWith(content);
  }
  return article;
}

function invitationsSection(snapshot, actions, requestedId = "") {
  const section = node("section", { className: `v2-work-invitations${snapshot.pendingInvitations.length ? " has-items" : ""}`, id: "v2-work-invitations", "aria-labelledby": "v2-work-invitations-title" });
  section.append(sectionHeading("Invitations", "v2-work-invitations-title"));
  if (snapshot.invitations.available && requestedId && !snapshot.pendingInvitations.some(item => caseId(item) === requestedId)) {
    section.append(node("p", { role: "status", text: "This invitation is no longer in your pending invitations." }));
  }
  if (!snapshot.invitations.available) {
    section.append(localError("Your invitations couldn’t load.", actions.reload));
  } else if (!snapshot.pendingInvitations.length) {
    section.append(node("div", { className: "v2-work-empty v2-work-empty--line" }, [node("p", { text: "No invitations awaiting your response." })]));
  } else {
    const readiness = payoutReadiness(snapshot);
    section.append(node("div", { className: "v2-work-invite-list" }, snapshot.pendingInvitations.map((invite) => inviteRow(invite, readiness, actions))));
  }
  return section;
}

function filtersFromRoute(route) {
  return {
    search: String(route.query.get("appQuery") || ""),
    status: String(route.query.get("appStatus") || "all"),
    practice: String(route.query.get("appPractice") || "all"),
    dateRange: ["3", "7", "30", "all"].includes(String(route.query.get("appRange") || "all")) ? String(route.query.get("appRange") || "all") : "all",
    sort: ["newest", "oldest", "matter"].includes(String(route.query.get("appSort") || "newest")) ? String(route.query.get("appSort") || "newest") : "newest",
  };
}

function filterApplications(applications, filters) {
  const query = filters.search.trim().toLowerCase();
  let filtered = applications.filter((application) => {
    const job = applicationJob(application);
    if (query && !`${job.title || ""} ${job.practiceArea || ""}`.toLowerCase().includes(query)) return false;
    if (filters.status !== "all" && applicationStatus(application) !== filters.status) return false;
    if (filters.practice !== "all" && String(job.practiceArea || "") !== filters.practice) return false;
    if (filters.dateRange !== "all") {
      const cutoff = Date.now() - Number(filters.dateRange) * 24 * 60 * 60 * 1000;
      if (timestamp(application.createdAt) < cutoff) return false;
    }
    return true;
  });
  filtered = filtered.sort((left, right) => {
    if (filters.sort === "oldest") return timestamp(left.createdAt) - timestamp(right.createdAt);
    if (filters.sort === "matter") return String(applicationJob(left).title || "").localeCompare(String(applicationJob(right).title || ""));
    return timestamp(right.createdAt) - timestamp(left.createdAt);
  });
  return filtered;
}

function options(values, selected, label) {
  return [node("option", { value: "all", text: label }), ...values.map((value) => node("option", { value, text: value, selected: selected === value ? "" : null }))];
}

function applicationFilters(snapshot, state, actions) {
  const statuses = [...new Set([...snapshot.activeApplications.map(applicationStatus), state.filters.status].filter(value => value && value !== "all"))].sort();
  const practices = [...new Set([...snapshot.activeApplications.map((item) => String(applicationJob(item).practiceArea || "")), state.filters.practice].filter(value => value && value !== "all"))].sort();
  const viewSelect = node("select", { "aria-label": "Application saved view", "data-work-saved-view": "" }, [
    ...BUILT_IN_VIEWS.map((view) => node("option", { value: `built:${view.id}`, text: view.name, selected: state.savedView === `built:${view.id}` ? "" : null })),
    ...snapshot.customViews.map((view) => node("option", { value: `saved:${view.id}`, text: view.name, selected: state.savedView === `saved:${view.id}` ? "" : null })),
    node("option", { value: "custom", text: "Custom", selected: state.savedView === "custom" ? "" : null }),
  ]);
  viewSelect.addEventListener("change", () => actions.applySavedView(viewSelect.value, viewSelect));
  const save = node("button", { className: "v2-work-filter-action", type: "button", text: "Save view" });
  save.addEventListener("click", actions.saveView);
  const remove = node("button", { className: "v2-work-filter-action", type: "button", text: "Delete view", hidden: !state.savedView.startsWith("saved:") });
  remove.addEventListener("click", actions.deleteView);

  const search = node("input", { type: "search", value: state.filters.search, placeholder: "Search applications", "aria-label": "Search applications" });
  const status = node("select", { "aria-label": "Application status" }, [
    node("option", { value: "all", text: "All statuses" }),
    ...statuses.map((value) => node("option", { value, text: humanStatus(value), selected: state.filters.status === value ? "" : null })),
  ]);
  const practice = node("select", { "aria-label": "Application practice area" }, options(practices, state.filters.practice, "All practice areas"));
  const range = node("select", { "aria-label": "Application date range" }, [
    ["3", "Past 3 days"], ["7", "Past 7 days"], ["30", "Past 30 days"], ["all", "Any time"],
  ].map(([value, text]) => node("option", { value, text, selected: state.filters.dateRange === value ? "" : null })));
  const sort = node("select", { "aria-label": "Sort applications" }, [
    ["newest", "Newest first"], ["oldest", "Oldest first"], ["matter", "Matter name"],
  ].map(([value, text]) => node("option", { value, text, selected: state.filters.sort === value ? "" : null })));
  const update = () => actions.filters({ search: search.value, status: status.value, practice: practice.value, dateRange: range.value, sort: sort.value });
  search.addEventListener("input", update);
  [status, practice, range, sort].forEach((control) => control.addEventListener("change", update));
  return node("div", { className: "v2-work-filter-panel" }, [
    snapshot.savedViews.available ? node("div", { className: "v2-work-saved-views" }, [viewSelect, save, remove]) : localError("Saved views couldn’t load.", actions.reloadApplications),
    node("div", { className: "v2-work-filter-fields" }, [search, status, practice, range, sort]),
  ]);
}

function applicationRow(application, actions) {
  const job = applicationJob(application);
  const preLabel = preEngagementLabel(application);
  const status = preLabel || humanStatus(applicationStatus(application));
  const open = node("button", { className: "v2-work-row-action", type: "button", text: preLabel && preEngagement(application)?.status !== "submitted" ? "Provide requested information" : "Details" });
  open.addEventListener("click", () => actions.openApplication(application, open));
  return node("article", { className: "v2-work-application-row", "data-work-application-id": applicationId(application), "data-work-job-id": jobId(application) }, [
    node("div", { className: "v2-work-application-status" }, [node("span", { className: `is-${applicationStatus(application)}`, text: status })]),
    node("div", { className: "v2-work-row-main" }, [
      job.practiceArea ? node("p", { className: "v2-work-row-overline", text: job.practiceArea }) : null,
      node("h3", { text: job.title || application.caseTitle || "Matter" }),
      node("p", { text: `Applied ${dateLabel(application.createdAt)}` }),
    ]),
    node("dl", { className: "v2-work-row-facts" }, [
      node("div", {}, [node("dt", { text: "Compensation" }), node("dd", { text: centsOrBudget(job) ? money(centsOrBudget(job), job.currency) : "Not listed" })]),
    ]),
    open,
  ]);
}

function applicationsSection(snapshot, state, actions) {
  const section = node("section", { className: "v2-work-section v2-work-applications", id: "v2-work-applications", "aria-labelledby": "v2-work-applications-title", tabindex: -1 });
  section.append(sectionHeading("Applications", "v2-work-applications-title"));
  if (!snapshot.applications.available) {
    section.append(localError("Your applications couldn’t load.", actions.reloadApplications));
    return section;
  }
  if (snapshot.activeApplications.length) section.append(applicationFilters(snapshot, state, actions));
  else if (!snapshot.savedViews.available) section.append(localError("Saved views couldn’t load.", actions.reloadApplications));
  else if (snapshot.customViews.length) {
    const manager = node("details", { className: "v2-work-saved-manager", open: state.emptySavedViewsOpen ? "" : null }, [
      node("summary", { text: "Saved views" }), applicationFilters(snapshot, state, actions),
    ]);
    manager.addEventListener("toggle", () => { if (manager.isConnected) state.emptySavedViewsOpen = manager.open; });
    section.append(manager);
  }
  section.append(applicationResults(snapshot, state, actions));
  return section;
}

function applicationResults(snapshot, state, actions) {
  const results = node("div", { "data-work-application-results": "" });
  const filtered = filterApplications(snapshot.activeApplications, state.filters);
  if (!snapshot.activeApplications.length) {
    results.append(node("div", { className: "v2-work-empty" }, [
      node("p", { text: "No applications yet." }),
    ]));
    return results;
  }
  if (!filtered.length) {
    results.append(node("div", { className: "v2-work-empty" }, [node("p", { text: "No applications match your filters." })]));
    return results;
  }
  const page = pageSlice(filtered, state.applicationPage);
  results.append(node("div", { className: "v2-work-list" }, page.items.map((application) => applicationRow(application, actions))));
  const pagination = correctedPager("Applications", page, filtered.length, (next) => actions.page("applicationPage", next));
  if (pagination) results.append(pagination);
  return results;
}

function historyRow(item, actions) {
  const id = caseId(item);
  const withdrawn = item.isWithdrawn === true;
  const dispute = withdrawn && item.canDispute && id
    ? node("button", { className: "v2-work-history-link", type: "button", text: "Request LPC review" })
    : null;
  dispute?.addEventListener("click", () => actions.openDispute(item, dispute));
  const block = item.blockStatus?.blocked
    ? node("a", { className: "v2-work-history-link", href: "paralegal-v2.html#/settings?tab=security&section=blocked", "data-view": "/settings?tab=security&section=blocked", "data-v2-route": "", text: "Blocked · manage in Settings" })
    : item.blockStatus?.canBlock && id
      ? node("button", { className: "v2-work-history-link", type: "button", text: "Block attorney" })
      : null;
  if (block?.tagName === "BUTTON") block.addEventListener("click", () => actions.confirmBlock(item, block));
  return node("article", { className: "v2-work-history-row", "data-work-history-id": id }, [
    node("div", { className: "v2-work-history-mark", "aria-hidden": "true", text: withdrawn ? "W" : item.workState === "completed" ? "✓" : "—" }),
    node("div", { className: "v2-work-row-main" }, [
      node("h2", { text: item.title || "Matter" }),
      node("p", { text: [item.attorneyName ? `With ${item.attorneyName}` : "", `${historyWorkLabel(item.workState, item.reviewKind)}${item.completedAt ? ` · ${dateLabel(item.completedAt)}` : ""}`].filter(Boolean).join(" · ") }),
    ]),
    actions.renderPayout(item),
    node("div", { className: "v2-work-history-actions" }, [dispute, block]),
  ]);
}

function sortedHistoryItems(snapshot) {
  return [...snapshot.completedCases].sort((left, right) => timestamp(right.completedAt || right.updatedAt) - timestamp(left.completedAt || left.updatedAt));
}

function historySection(snapshot, state, actions) {
  const section = node("section", { className: "v2-work-section v2-work-history", id: "v2-work-history", "aria-labelledby": "v2-work-title" });
  if (!snapshot.history.available) {
    section.append(localError("These records couldn’t load.", actions.reload));
    return section;
  }
  if (!snapshot.completedCases.length) {
    section.append(node("div", { className: "v2-work-empty v2-work-empty--line" }, [node("p", { text: "No past matters yet." })]));
    return section;
  }
  const sorted = sortedHistoryItems(snapshot);
  const page = pageSlice(sorted, state.historyPage);
  section.append(node("div", { className: "v2-work-list" }, page.items.map((item) => historyRow(item, actions))));
  const pagination = correctedPager("Past Matters", page, sorted.length, (next) => actions.page("historyPage", next));
  if (pagination) section.append(pagination);
  return section;
}

function metricLink(label, count, hash, selected) {
  const link = node("a", { "data-v2-route": "", "aria-current": selected === hash ? "page" : null }, [
    node("span", { text: label }), node("strong", { text: count }),
  ]);
  const updateDestination = () => {
    const query = new URLSearchParams(window.location.hash.split("?")[1] || "");
    ["applicationId", "appId", "jobId", "highlightCase", "matterId"].forEach(key => query.delete(key));
    query.set("section", hash);
    link.href = `paralegal-v2.html#/work?${query}`;
    link.dataset.view = `/work?${query}`;
  };
  updateDestination();
  link.addEventListener("focus", updateDestination);
  link.addEventListener("click", updateDestination);
  return link;
}

function buildWork(snapshot, state, actions) {
  const isHistory = state.section === "history";
  const root = node("section", { className: "v2-work", "data-v2-work": "", "data-work-section": state.section });
  root.append(
    node("header", { className: "v2-work-titlebar" }, [
      node("div", {}, [
        node("h1", { id: "v2-work-title", text: isHistory ? "History" : "Matters" }),
      ]),
      isHistory
        ? node("a", { className: "v2-work-history-return", href: "paralegal-v2.html#/work?section=active", "data-view": "/work?section=active", "data-v2-route": "", text: "Active Matters" })
        : node("a", { className: "v2-work-browse", href: "paralegal-v2.html#/browse", "data-view": "/browse", "data-v2-route": "", text: "Browse matters" }),
    ]),
    ...(isHistory ? [] : [node("nav", { className: "v2-work-index", "aria-label": "Work sections" }, [
      metricLink("Active", snapshot.dashboard.available ? snapshot.activeCases.length : "—", "active", state.section),
      metricLink("Applications", snapshot.applications.available ? snapshot.activeApplications.length : "—", "applications", state.section),
      metricLink("Invitations", snapshot.invitations.available ? snapshot.pendingInvitations.length : "—", "invitations", state.section),
      metricLink("History", snapshot.history.available ? snapshot.completedCases.length : "—", "history", state.section),
    ])]),
    state.section === "invitations" ? invitationsSection(snapshot, actions, state.requestedInvitationId)
      : state.section === "applications" ? applicationsSection(snapshot, state, actions)
        : state.section === "history" ? historySection(snapshot, state, actions)
          : activeSection(snapshot, state, actions),
  );
  return root;
}

function dialogShell(title, { className = "", closeLabel = "Close" } = {}) {
  const dialog = node("dialog", { className: `v2-work-dialog ${className}`.trim(), "aria-labelledby": "v2-work-dialog-title", "data-v2-route-dialog": "" });
  const close = node("button", { className: "v2-work-dialog-close", type: "button", "aria-label": closeLabel, text: "×" });
  close.addEventListener("click", () => dialog.close());
  dialog.append(node("header", {}, [node("h2", { id: "v2-work-dialog-title", text: title }), close]));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  return dialog;
}

function clearApplicationDeepLink() {
  const url = new URL(window.location.href);
  const [path, rawQuery = ""] = url.hash.replace(/^#/, "").split("?");
  if (path !== "/work") return;
  const query = new URLSearchParams(rawQuery);
  if (!query.has("section") && ["applicationId", "appId", "jobId"].some(key => query.has(key))) query.set("section", "applications");
  query.delete("applicationId");
  query.delete("appId");
  query.delete("jobId");
  url.hash = `${path}${query.size ? `?${query}` : ""}`;
  window.history.replaceState(window.history.state, "", url);
}

function confirmDialog({ title, copy, confirmLabel, tone = "primary", trigger, onConfirm, onReturnFocus }) {
  const dialog = dialogShell(title, { className: "v2-work-confirm-dialog" });
  const failure = node("p", { role: "alert", hidden: true });
  const cancel = node("button", { className: "v2-work-secondary", type: "button", text: "Cancel" });
  const confirm = node("button", { className: tone === "danger" ? "v2-work-danger" : "v2-work-primary", type: "button", text: confirmLabel });
  cancel.addEventListener("click", () => dialog.close());
  confirm.addEventListener("click", async () => {
    failure.hidden = true;
    failure.textContent = "";
    confirm.disabled = true;
    cancel.disabled = true;
    try {
      if (await onConfirm(confirm) !== false) dialog.close();
    } catch (error) {
      failure.textContent = error?.message || "This action could not be completed. Please try again.";
      failure.hidden = false;
    } finally {
      confirm.disabled = false;
      cancel.disabled = false;
    }
  });
  dialog.append(node("div", { className: "v2-work-dialog-body" }, [node("p", { text: copy }), failure]), node("footer", {}, [cancel, confirm]));
  document.querySelector("[data-v2-dialog-host]")?.append(dialog);
  dialog.addEventListener("close", () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); else onReturnFocus?.(); }, { once: true });
  dialog.showModal();
  cancel.focus();
  return { dialog, confirm, cancel };
}

function openDocument(api, application, showToast, isCurrent) {
  const pre = preEngagement(application);
  const id = caseId(application);
  const key = String(pre?.confidentialityDocument?.key || "");
  if (!id || !key) return;
  void api.get(`/api/uploads/signed-get?${new URLSearchParams({ caseId: id, key })}`).then((payload) => {
    if (!isCurrent()) return;
    const url = String(payload?.url || "");
    if (!/^https?:\/\//i.test(url)) throw new Error("This document link isn’t available.");
    window.open(url, "_blank", "noopener");
  }).catch((error) => { if (isCurrent()) showToast(error?.message || "Unable to open this document."); });
}

function applicationDialog(api, application, trigger, actions, { inline = false } = {}) {
  const job = { ...applicationJob(application), ...(application.scopeSnapshot || {}) };
  const title = job.title || application.caseTitle || "Matter application";
  const dialog = inline ? node("section", { className: "v2-work-inline-application" }) : dialogShell(title, { className: "v2-work-application-dialog", closeLabel: "Close application details" });
  if (inline) dialog.close = () => {};
  let pre = preEngagement(application);
  const selection = { caseId: caseId(application), applicationId: applicationId(application) };
  const preDraft = pre ? actions.requirements.get(selection, pre) : null;
  const latestRequestRevision = Number(pre?.revision || 0);
  if (preDraft && (preDraft.sending || preDraft.pending || preDraft.reading)) pre = preDraft.requestPre;
  if (preDraft?.savedPre && Number(pre?.revision || 0) <= preDraft.savedPre.revision) pre = preDraft.savedPre;
  let updateResponse = () => {};
  const body = node("div", { className: "v2-work-dialog-body" });
  body.append(node("dl", { className: "v2-work-dialog-facts" }, [
    node("div", {}, [node("dt", { text: "Practice area" }), node("dd", { text: job.practiceArea || "Practice area not listed" })]),
    node("div", {}, [node("dt", { text: "Status" }), node("dd", { text: preEngagementLabel({ ...application, preEngagement: pre }) || humanStatus(applicationStatus(application)) })]),
    node("div", {}, [node("dt", { text: "Applied" }), node("dd", { text: dateLabel(application.createdAt) })]),
    node("div", {}, [node("dt", { text: "Compensation" }), node("dd", { text: centsOrBudget(job) ? money(centsOrBudget(job), job.currency) : "Not listed" })]),
  ]));
  const scope = node("section", { className: "v2-work-dialog-copy", hidden: true, "data-application-scope": "", tabindex: "-1" }, [
    node("h3", { text: "Matter details" }),
    node("p", { text: application.scopeSnapshot?.capturedAt ? "Matter details as listed when you applied." : "These are the latest available details. The original listing wasn’t saved when you applied." }),
    node("p", { text: job.description || "No matter description is available." }),
    job.state ? node("p", { text: `State: ${job.state}` }) : null,
    job.deadlineDate ? node("p", { text: `Deadline: ${deadlineLabel(job.deadlineDate)}` }) : null,
    node("ul", {}, (job.tasks || []).map((task) => node("li", { text: typeof task === "string" ? task : task.title }))),
  ]);
  body.append(scope);
  body.append(node("section", { className: "v2-work-dialog-copy" }, [node("h3", { text: "Cover letter" }), node("p", { text: application.coverLetter || "No cover letter available." })]));

  const requirementsChanged = preDraft?.requirementsChanged || preDraft && preDraft.requestRevision !== latestRequestRevision;
  if (pre) {
    const readOnly = pre.status === "submitted";
    const preSection = node("section", { className: "v2-work-preengagement", "aria-labelledby": "v2-work-pre-title" }, [
      node("div", { className: "v2-work-preengagement-heading" }, [
        node("div", {}, [node("h3", { id: "v2-work-pre-title", text: "Before hiring" })]),
      ]),
      requirementsChanged && !readOnly ? node("p", { role: "status", text: "The requirements changed. Review them again before submitting." }) : null,
    ]);
    if (pre.confidentialityAgreementRequired) {
      const acknowledge = node("input", { type: "checkbox", checked: preDraft.confidentialityAcknowledged, disabled: readOnly ? "" : null });
      const review = pre.confidentialityDocument?.key
        ? node("button", { className: "v2-work-text-action", type: "button", text: "Review document" })
        : null;
      review?.addEventListener("click", () => openDocument(api, { ...application, preEngagement: pre }, actions.showToast, () => actions.requirements.isCurrent(preDraft)));
      const savedFileName = String(pre.paralegalConfidentialityDocument?.name || "");
      const file = node("input", { type: "file", accept: ".pdf,.doc,.docx,.png,.jpg,.jpeg", "aria-label": "Upload signed confidentiality agreement", hidden: true, disabled: readOnly ? "" : null });
      const chooseFile = node("button", { type: "button", className: "v2-work-secondary", "data-response-file-action": "", text: preDraft.file || savedFileName ? "Replace file" : "Choose file" });
      const removeFile = node("button", { type: "button", className: "v2-work-text-action", "data-response-file-action": "", text: "Remove file", hidden: !preDraft.file });
      chooseFile.addEventListener("click", () => file.click());
      const retainedFile = !readOnly
        ? node("small", {
            className: "v2-work-retained-file",
            text: preDraft.file ? `Selected: ${preDraft.file.name}` : savedFileName ? `Saved: ${savedFileName}` : "",
            hidden: !preDraft.file && !savedFileName,
          })
        : null;
      acknowledge.addEventListener("change", () => { preDraft.confidentialityAcknowledged = acknowledge.checked; });
      const showSelectedFile = () => {
        chooseFile.textContent = preDraft.file || savedFileName ? "Replace file" : "Choose file";
        removeFile.hidden = !preDraft.file;
        if (retainedFile) {
          retainedFile.textContent = preDraft.file ? `Selected: ${preDraft.file.name}` : savedFileName ? `Saved: ${savedFileName}` : "";
          retainedFile.hidden = !preDraft.file && !savedFileName;
        }
      };
      file.addEventListener("change", () => { preDraft.file = file.files?.[0] || null; showSelectedFile(); });
      removeFile.addEventListener("click", () => { preDraft.file = null; file.value = ""; showSelectedFile(); });
      preSection.append(node("article", { className: "v2-work-pre-card" }, [
        node("div", {}, [node("h4", { text: "Confidentiality agreement" }), review]),
        readOnly
          ? node("div", {}, [node("p", { text: pre.confidentialityAcknowledged ? `Acknowledged${pre.confidentialityAcknowledgedAt ? ` ${dateLabel(pre.confidentialityAcknowledgedAt)}` : ""}.` : "Submitted." }), savedFileName ? node("p", { text: `Signed copy: ${savedFileName}` }) : null])
          : node("div", { className: "v2-work-pre-fields" }, [
            node("label", { className: "v2-work-check" }, [acknowledge, node("span", { text: "I reviewed and acknowledge this confidentiality agreement." })]),
            node("div", { className: "v2-work-file-field" }, [node("span", { text: "Signed copy (optional)" }), file, node("div", { className: "v2-work-file-actions" }, [chooseFile, removeFile]), retainedFile]),
          ]),
      ]));
    }
    if (pre.conflictsCheckRequired) {
      if (readOnly) {
        preSection.append(node("article", { className: "v2-work-pre-card" }, [
          node("h4", { text: "Conflicts check" }),
          node("p", { text: pre.conflictsResponseType === "disclosure" ? "Possible conflict disclosed" : "No known conflict" }),
          pre.conflictsResponseType === "disclosure" && pre.conflictsDisclosureText ? node("p", { text: pre.conflictsDisclosureText }) : null,
        ]));
      } else {
        const none = node("input", { type: "radio", name: `v2-pre-conflict-${caseId(application)}`, value: "none_known", checked: preDraft.conflictsResponseType === "none_known" });
        const disclosure = node("input", { type: "radio", name: `v2-pre-conflict-${caseId(application)}`, value: "disclosure", checked: preDraft.conflictsResponseType === "disclosure" });
        const details = node("textarea", { rows: "4", placeholder: "Describe the possible conflict for the attorney to review.", "aria-label": "Possible conflict details" }, [preDraft.conflictsDisclosureText]);
        const updateConflict = () => {
          preDraft.conflictsResponseType = disclosure.checked ? "disclosure" : none.checked ? "none_known" : "";
          details.hidden = preDraft.conflictsResponseType !== "disclosure";
          if (details.hidden) preDraft.conflictsDisclosureText = "";
        };
        none.addEventListener("change", updateConflict);
        disclosure.addEventListener("change", updateConflict);
        details.addEventListener("input", () => { preDraft.conflictsDisclosureText = details.value; });
        updateConflict();
        preSection.append(node("article", { className: "v2-work-pre-card" }, [
          node("h4", { text: "Conflicts check" }),
          node("p", { text: pre.conflictsDetails || "Review your records and choose the accurate response." }),
          node("div", { className: "v2-work-pre-fields" }, [
            node("label", { className: "v2-work-check" }, [none, node("span", { text: "No known conflict" })]),
            node("label", { className: "v2-work-check" }, [disclosure, node("span", { text: "Disclose a possible conflict" })]),
            details,
          ]),
        ]));
      }
    }
    if (!readOnly) {
      const submit = node("button", { className: "v2-work-primary", type: "button", text: "Submit to attorney" });
      const problem = node("p", { role: "alert", text: preDraft.pendingMessage || "", hidden: !preDraft.pendingMessage });
      const refreshRequirements = node("button", { className: "v2-work-secondary", type: "button", text: "Review saved requirements", hidden: !preDraft.pending });
      updateResponse = () => {
        const withdrawal = actions.withdrawal.state(application);
        const blocked = !!(preDraft.sending || preDraft.pending || preDraft.reading || withdrawal.pending || withdrawal.review || withdrawal.saved);
        submit.disabled = blocked;
        submit.textContent = preDraft.sending ? "Submitting…" : "Submit to attorney";
        refreshRequirements.hidden = !preDraft.pending || !!preDraft.sending;
        refreshRequirements.disabled = !!preDraft.reading;
        const message = preDraft.pendingMessage || (withdrawal.review ? "The withdrawal result could not be confirmed. Review it before responding." : "");
        problem.hidden = !message;
        problem.textContent = message;
        preSection.querySelectorAll("input, textarea, [data-response-file-action]").forEach(control => { control.disabled = blocked; });
        const revoke = dialog.querySelector("[data-application-withdraw]");
        if (revoke) { revoke.disabled = !!(preDraft.sending || preDraft.pending || preDraft.reading || withdrawal.pending || withdrawal.saved); revoke.textContent = withdrawal.review ? "Review withdrawal" : "Withdraw application"; }
      };
      refreshRequirements.addEventListener("click", async () => {
        if (preDraft.sending || preDraft.reading || !actions.requirements.isCurrent(preDraft)) return;
        preDraft.reading = true; actions.requirements.notify(preDraft);
        try {
          const updated = await actions.readUpdatedApplication(application);
          if (!dialog.isConnected || !actions.requirements.isCurrent(preDraft)) return;
          preDraft.reading = false; delete preDraft.pending; delete preDraft.pendingMessage;
          if (inline) await actions.reload();
          else {
            dialog.close(); applicationDialog(api, updated, trigger, actions);
          }
        } catch (error) { if (actions.requirements.isCurrent(preDraft)) preDraft.pendingMessage = error?.message || "Updated requirements could not load. Try again."; }
        finally { preDraft.reading = false; actions.requirements.notify(preDraft); }
      });
      submit.addEventListener("click", async () => {
        if (preDraft.sending || preDraft.pending || preDraft.reading || preDraft.savedPre || !actions.requirements.isCurrent(preDraft)) return;
        const withdrawal = actions.withdrawal.state(application);
        if (withdrawal.pending || withdrawal.review || withdrawal.saved) return;
        if (pre.confidentialityAgreementRequired && !preDraft.confidentialityAcknowledged) {
          actions.showToast("Review and acknowledge the confidentiality agreement to continue.");
          return;
        }
        if (pre.conflictsCheckRequired && !["none_known", "disclosure"].includes(preDraft.conflictsResponseType)) {
          actions.showToast("Choose a conflicts check response.");
          return;
        }
        if (preDraft.conflictsResponseType === "disclosure" && !preDraft.conflictsDisclosureText.trim()) {
          actions.showToast("Enter your conflicts disclosure details.");
          return;
        }
        preDraft.sending = true; preDraft.pendingMessage = "";
        actions.requirements.notify(preDraft);
        const form = new FormData();
        form.set("expectedPreEngagementRevision", String(preDraft.requestRevision));
        form.set("confidentialityAcknowledged", preDraft.confidentialityAcknowledged ? "true" : "false");
        form.set("conflictsResponseType", preDraft.conflictsResponseType);
        form.set("conflictsDisclosureText", preDraft.conflictsDisclosureText);
        if (preDraft.file) form.set("paralegalConfidentialityFile", preDraft.file, preDraft.file.name);
        try {
          const result = await api.post(`/api/cases/${encodeURIComponent(caseId(application))}/pre-engagement/respond`, form);
          if (!actions.requirements.isCurrent(preDraft)) return;
          if (result?.success !== true || result.preEngagement?.status !== "submitted" || result.preEngagement.revision !== preDraft.requestRevision + 1 || normalizeId(result.preEngagement.requestedParalegalId) !== normalizeId(pre.requestedParalegalId)) throw new Error("Submission could not be confirmed.");
          actions.requirements.saved(preDraft, result.preEngagement);
        } catch (error) {
          if (!actions.requirements.isCurrent(preDraft)) return;
          const changed = error?.status === 409 && error?.payload?.code === "PRE_ENGAGEMENT_CONFLICT";
          const uncertain = !error?.status || error.status >= 500;
          preDraft.pending = changed || uncertain;
          preDraft.pendingMessage = uncertain ? "Submission could not be confirmed. Review the saved requirements before trying again." : error?.message || "Unable to send the requested information.";
        } finally {
          preDraft.sending = false;
          actions.requirements.notify(preDraft);
        }
      });
      preSection.append(problem, node("div", { className: "v2-work-pre-submit" }, [submit, refreshRequirements]));
    }
    body.append(preSection);
  }
  if (inline) {
    const history = (Array.isArray(application.statusHistory) ? application.statusHistory : []).filter(entry => entry.to && timestamp(entry.at)).slice().sort((a,b) => timestamp(a.at)-timestamp(b.at));
    if (history.length) body.append(node('section', {className:'v2-work-dialog-copy'}, [
      node('h3', {text:'Recorded activity'}),
      node('ol', {}, history.map(entry => node('li', {}, [
        node('span', {text: humanStatus(entry.to)}), ' · ',
        node('time', {datetime:entry.at, text:dateLabel(entry.at)}),
      ]))),
    ]));
  }
  dialog.append(body);
  const footer = node("footer", {});
  if (applicationIsRevocable(application)) {
    const revoke = node("button", { className: "v2-work-danger-link", type: "button", text: "Withdraw application", "data-application-withdraw": "" });
    revoke.addEventListener("click", () => actions.confirmApplicationRevoke(application, revoke, dialog));
    footer.append(revoke);
  }
  const details = node("button", { className: "v2-work-secondary", type: "button", "aria-expanded": "false", text: "Matter details" });
  details.addEventListener("click", () => {
    scope.hidden = !scope.hidden;
    details.setAttribute("aria-expanded", String(!scope.hidden));
    if (!scope.hidden) { scope.scrollIntoView({ block: "nearest" }); scope.focus({ preventScroll: true }); }
  });
  footer.append(details);
  if (footer.children.length) dialog.append(footer);
  if (preDraft) {
    updateResponse();
    const stopWithdrawal = actions.withdrawal.observe(application, state => {
      if (!dialog.isConnected) return false;
      updateResponse();
      if (state.saved) dialog.close();
    });
    if (!inline) dialog.addEventListener("close", stopWithdrawal, { once: true });
    const stop = actions.requirements.observe(preDraft, () => {
      if (!dialog.isConnected) return false;
      updateResponse();
      if (preDraft.savedPre) {
        stop(); dialog.close();
        actions.showToast(pre.status === "changes_requested" ? "Updated information sent to the attorney." : "Information sent to the attorney.");
        void actions.reload();
      }
      return true;
    });
    if (!inline) dialog.addEventListener("close", stop, { once: true });
  }
  if (inline) { scope.hidden = false; details.remove(); return dialog; }
  document.querySelector("[data-v2-dialog-host]")?.append(dialog);
  dialog.addEventListener("close", () => { clearApplicationDeepLink(); dialog.remove(); trigger?.focus(); }, { once: true });
  dialog.showModal();
  dialog.querySelector(".v2-work-dialog-close")?.focus();
}

function disputeDialog(api, item, trigger, actions) {
  const dialog = dialogShell("Request a withdrawal review", { className: "v2-work-dispute-dialog" });
  const textarea = node("textarea", { rows: "5", maxlength: "5000", "aria-label": "Review request details", placeholder: "Explain what you would like LPC to review." });
  const cancel = node("button", { className: "v2-work-secondary", type: "button", text: "Cancel" });
  const submit = node("button", { className: "v2-work-primary", type: "button", text: "Submit request" });
  cancel.addEventListener("click", () => dialog.close());
  submit.addEventListener("click", async () => {
    const message = textarea.value.trim();
    if (!message) { actions.showToast("Details are required."); textarea.focus(); return; }
    submit.disabled = true;
    cancel.disabled = true;
    try {
      await api.post(`/api/disputes/${encodeURIComponent(caseId(item))}`, { message });
      dialog.close();
      actions.showToast("Request submitted.");
      await actions.reload();
    } catch (error) {
      actions.showToast(error?.message || "Unable to submit request.");
      submit.disabled = false;
      cancel.disabled = false;
    }
  });
  dialog.append(node("div", { className: "v2-work-dialog-body" }, [
    node("p", { text: `Tell LPC what should be reviewed for ${item.title || "this matter"}.` }),
    node("label", {}, [node("span", { text: "Details" }), textarea]),
  ]), node("footer", {}, [cancel, submit]));
  document.querySelector("[data-v2-dialog-host]")?.append(dialog);
  dialog.addEventListener("close", () => { dialog.remove(); trigger?.focus(); }, { once: true });
  dialog.showModal();
  textarea.focus();
}

function saveViewDialog(api, state, trigger, actions) {
  const ownerId = actions.owner(), requestId = crypto.randomUUID(), filters = { ...state.filters };
  const dialog = dialogShell("Save application view", { className: "v2-work-save-dialog" });
  const input = node("input", { type: "text", maxlength: "48", autocomplete: "off", "aria-label": "Saved view name" });
  const cancel = node("button", { className: "v2-work-secondary", type: "button", text: "Cancel" });
  const save = node("button", { className: "v2-work-primary", type: "button", text: "Save view" });
  cancel.addEventListener("click", () => dialog.close());
  save.addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) { actions.showToast("Enter a name for this view."); input.focus(); return; }
    save.disabled = true;
    try {
      if (actions.owner() !== ownerId) throw new Error("Your account changed. Refresh before saving this view.");
      const payload = await api.post("/api/account/dashboard-views", { scope: APPLICATION_SCOPE, name, filters, expectedOwnerId: ownerId, id: requestId, revision: null });
      if (actions.owner() !== ownerId || !dialog.isConnected) return;
      state.savedView = `saved:${payload?.view?.id || ""}`;
      dialog.close();
      actions.showToast("Application view saved.");
      await actions.reload();
      actions.focusApplications({ onlyIfIdle: true });
    } catch (error) {
      actions.showToast(error?.message || "Unable to save this view.");
      save.disabled = false;
    }
  });
  dialog.append(node("div", { className: "v2-work-dialog-body" }, [
    node("label", {}, [node("span", { text: "View name" }), input]),
  ]), node("footer", {}, [cancel, save]));
  document.querySelector("[data-v2-dialog-host]")?.append(dialog);
  dialog.addEventListener("close", () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); else actions.focusApplications(); }, { once: true });
  dialog.showModal();
  input.focus();
}

function loadingView() {
  return node("section", { className: "v2-work v2-work--loading", "aria-label": "Loading Matters" }, [
    node("div", { className: "v2-work-loading-line" }),
    node("div", { className: "v2-work-loading-index" }),
    node("div", { className: "v2-work-loading-grid" }, [node("div"), node("div")]),
  ]);
}

function errorView(onRetry, section) {
  const retry = node("button", { className: "v2-work-primary", type: "button", text: "Try again" });
  retry.addEventListener("click", onRetry);
  return node("section", { className: "v2-work v2-work-error", "aria-labelledby": "v2-work-error-title" }, [
    node("h1", { id: "v2-work-error-title", text: section === "history" ? "History" : "Matters" }),
    node("p", { text: section === "history" ? "These records couldn’t load." : "Your work couldn’t load." }),
    retry,
  ]);
}

function writeFilterRoute(filters, page = 1) {
  const url = new URL(window.location.href);
  const query = new URLSearchParams(url.hash.split("?")[1] || "");
  const values = {
    appQuery: filters.search,
    appStatus: filters.status === "all" ? "" : filters.status,
    appPractice: filters.practice === "all" ? "" : filters.practice,
    appRange: filters.dateRange === "all" ? "" : filters.dateRange,
    appSort: filters.sort === "newest" ? "" : filters.sort,
    appPage: Number(page) > 1 ? String(page) : "",
  };
  Object.entries(values).forEach(([key, value]) => value ? query.set(key, value) : query.delete(key));
  url.hash = `/work${query.size ? `?${query}` : ""}`;
  window.history.replaceState(window.history.state, "", url);
}

export function createWorkView({ api, showToast, invalidateHome, invalidateBrowse, getIdentity } = {}) {
  const owner = () => { const user = getIdentity?.(); return String(user?.id || user?._id || ""); };
  const earlierWithdrawal = createEarlierApplicationWithdrawal({
    getOwner: owner, post: (url, body) => api.post(url, body), get: url => api.get(url),
    resolveAdditionalAction(application) {
      if (!applicationIsRevocable(application)) return null;
      const invite = application.applicationSource === 'invite_accept', id = invite ? caseId(application) : applicationId(application);
      if (!/^[a-f0-9]{24}$/i.test(id)) return null;
      return { url: invite ? `/api/cases/${encodeURIComponent(id)}/invite/revoke` : `/api/applications/${encodeURIComponent(id)}/revoke`, body: {}, verify: response => response?.success === true };
    },
  });
  let downloads = new AbortController();
  const resetDownloads = () => { downloads.abort(); downloads = new AbortController(); };
  let currentSnapshot = null;
  let currentRoot = null;
  let currentState = null;
  let pendingApplicationFocus = null;
  let currentRouteKey = null;
  let deferredInvalidation = false;
  let renderGeneration = 0;
  const requirements = createPreEngagementDrafts({ getOwner: owner, onSaved() { invalidate(); invalidateHome?.(); invalidateBrowse?.(); } });
  const openInvitations = new Set();
  const openReceipts = new Set();
  const hasPendingDownload = () => !!(currentRoot?.isConnected && currentRoot.querySelector('[data-payout-receipt]:disabled'));
  let invitationReview = null;
  let inlineContext = null;
  const reviewLandmarks = "summary, h4, p, li, dt, dd, a";

  function captureInvitationReview() {
    invitationReview = null;
    if (!currentRoot?.isConnected) return;
    const outlet = document.querySelector("[data-v2-route-outlet]");
    const bounds = outlet.getBoundingClientRect();
    const rows = Array.from(currentRoot.querySelectorAll("[data-work-invite-id]"));
    let anchor = null;
    let focus = null;
    for (const row of rows) {
      const id = row.dataset.workInviteId;
      const details = row.querySelector(".v2-work-invite-scope");
      if (details?.open) openInvitations.add(id);
      else openInvitations.delete(id);
      const controls = Array.from(row.querySelectorAll("summary, a, button"));
      const focusIndex = controls.indexOf(document.activeElement);
      if (focusIndex >= 0) focus = { id, index: focusIndex };
      if (!details?.open || anchor) continue;
      const landmarks = Array.from(details.querySelectorAll(reviewLandmarks));
      const index = landmarks.findIndex(element => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      if (index >= 0) anchor = { id, index, top: landmarks[index].getBoundingClientRect().top };
    }
    invitationReview = { anchor, focus, restored: false };
  }

  function restoreInvitationReview(event) {
    if (!invitationReview || !currentRoot?.isConnected) return;
    const review = invitationReview;
    const { anchor, focus } = review;
    invitationReview = null;
    // A server refresh should preserve reading position. An explicit route
    // change must keep its own requested destination and keyboard focus.
    if (event && event.detail?.refresh !== true) return;
    review.restored = Boolean(anchor);
    const rows = Array.from(currentRoot.querySelectorAll("[data-work-invite-id]"));
    const rowFor = id => rows.find(row => row.dataset.workInviteId === id);
    const outlet = document.querySelector("[data-v2-route-outlet]");
    const landmark = anchor && rowFor(anchor.id)?.querySelector(".v2-work-invite-scope")?.querySelectorAll(reviewLandmarks)[anchor.index];
    if (landmark) outlet.scrollTop += landmark.getBoundingClientRect().top - anchor.top;
    if (focus && [document.body, outlet].includes(document.activeElement)) {
      rowFor(focus.id)?.querySelectorAll("summary, a, button")[focus.index]?.focus({ preventScroll: true });
    }
  }
  window.addEventListener("lpc:v2-route-changed", restoreInvitationReview);

  function applicationAction(selection) {
    if (!selection || !currentRoot?.isConnected || currentState?.section !== "applications") return null;
    const key = selection.application ? "data-work-application-id" : "data-work-job-id";
    const value = selection.application || selection.job;
    return value ? currentRoot.querySelector(`[${key}="${CSS.escape(value)}"] .v2-work-row-action`) : null;
  }

  function focusedApplication() {
    const element = document.activeElement;
    if (!element?.matches(".v2-work-row-action") || !currentRoot?.contains(element)) return null;
    const row = element.closest("[data-work-application-id]");
    return row ? { element, application: row.dataset.workApplicationId, job: row.dataset.workJobId } : null;
  }

  function restoreApplicationFocus(selection) {
    if (![document.body, currentRoot?.closest("[data-v2-route-outlet]")].includes(document.activeElement)) return false;
    const target = applicationAction(selection);
    target?.focus({ preventScroll: true });
    return !!target;
  }

  window.addEventListener("lpc:v2-route-changed", () => {
    const selection = pendingApplicationFocus;
    pendingApplicationFocus = null;
    restoreApplicationFocus(selection);
  });


  function invalidate({ preserveDownloads = false } = {}) {
    if (preserveDownloads && hasPendingDownload()) { deferredInvalidation = true; return; }
    deferredInvalidation = false;
    resetDownloads();
    if (currentSnapshot) currentSnapshot = { ...currentSnapshot, history: { available: false, value: null }, completedCases: [] };
    currentRoot?.querySelectorAll("[data-payout-details]").forEach(element => element.replaceChildren(node("p", { text: "Refreshing payout details…" })));
    cacheRevision += 1;
    cachedSnapshot = null;
    cachedAt = 0;
    pendingSnapshot = null;
  }

  function replaceCurrent() {
    if (!currentRoot || !currentSnapshot || !currentState) return;
    const applicationFocus = focusedApplication();
    const savedManager = currentRoot.querySelector(".v2-work-saved-manager");
    if (savedManager) currentState.emptySavedViewsOpen = savedManager.open;
    captureInvitationReview();
    resetDownloads();
    const replacement = buildWork(currentSnapshot, currentState, actions);
    currentRoot.replaceWith(replacement);
    currentRoot = replacement;
    restoreInvitationReview();
    restoreApplicationFocus(applicationFocus);
  }

  function replaceApplicationResults() {
    const current = currentRoot?.querySelector("[data-work-application-results]");
    if (!current || !currentSnapshot || !currentState) return;
    current.replaceWith(applicationResults(currentSnapshot, currentState, actions));
  }

  async function refreshAfterMutation() {
    if (inlineContext) {
      const context = inlineContext;
      invalidate(); invalidateHome?.(); invalidateBrowse?.();
      if (context.isValid()) await context.onChanged?.();
      return;
    }
    invalidate();
    invalidateHome?.();
    invalidateBrowse?.();
    const generation = ++renderGeneration, ownerId = owner();
    try {
      const snapshot = await loadSnapshot(api, { force: true, ownerId, isCurrent: () => generation === renderGeneration && owner() === ownerId });
      if (generation !== renderGeneration || !currentRoot?.isConnected) return;
      currentSnapshot = snapshot;
      replaceCurrent();
      return snapshot;
    } catch (error) {
      if (generation !== renderGeneration || owner() !== ownerId || !currentRoot?.isConnected) return;
      showToast(error?.message || "Unable to refresh this view.");
    }
  }

  const actions = {
    owner,
    renderPayout(item) {
      const ownerId = currentSnapshot?.ownerId, revision = cacheRevision;
      return renderHistoryPayout(item, { api, ownerId, signal: downloads.signal, isCurrent: () => ownerId === owner() && revision === cacheRevision, onRefresh: refreshAfterMutation, expanded: openReceipts.has(item.caseId), onExpandedChange: open => { if (open) openReceipts.add(item.caseId); else openReceipts.delete(item.caseId); } });
    },
    showToast,
    requirements,
    withdrawal: earlierWithdrawal,
    openInvitations,
    reload: refreshAfterMutation,
    async reloadApplications() {
      await refreshAfterMutation();
      actions.focusApplications({ onlyIfIdle: true });
    },
    page(key, value) {
      currentState[key] = value;
      if (key === "applicationPage") {
        writeFilterRoute(currentState.filters, value);
        replaceApplicationResults();
        currentRoot?.querySelector("#v2-work-applications")?.scrollIntoView({ block: "start" });
        return;
      }
      replaceCurrent();
      currentRoot?.querySelector(`#${key === "activePage" ? "v2-work-active" : key === "historyPage" ? "v2-work-history" : "v2-work-applications"}`)?.scrollIntoView({ block: "start" });
    },
    filters(filters) {
      currentState.filters = { ...filters };
      currentState.applicationPage = 1;
      currentState.savedView = "custom";
      writeFilterRoute(filters, 1);
      const savedSelect = currentRoot?.querySelector("[data-work-saved-view]");
      if (savedSelect) savedSelect.value = "custom";
      currentRoot?.querySelector(".v2-work-saved-views .v2-work-filter-action:last-child")?.setAttribute("hidden", "");
      replaceApplicationResults();
    },
    focusApplications({ onlyIfIdle = false } = {}) {
      if (onlyIfIdle && ![document.body, currentRoot?.closest("[data-v2-route-outlet]")].includes(document.activeElement)) return;
      const manager = currentRoot?.querySelector(".v2-work-saved-manager");
      const target = manager && !manager.open ? manager.querySelector("summary") : currentRoot?.querySelector("[data-work-saved-view]") || currentRoot?.querySelector("#v2-work-applications");
      if (target?.isConnected) target.focus({ preventScroll: true });
    },
    applySavedView(value, trigger) {
      const restoreFocus = trigger === document.activeElement;
      const built = BUILT_IN_VIEWS.find((view) => value === `built:${view.id}`);
      const saved = currentSnapshot.customViews.find((view) => value === `saved:${view.id}`);
      const selected = built || saved;
      if (!selected) { currentState.savedView = "custom"; replaceCurrent(); if (restoreFocus) actions.focusApplications(); return; }
      currentState.savedView = value;
      currentState.filters = { ...selected.filters };
      currentState.applicationPage = 1;
      writeFilterRoute(currentState.filters, 1);
      replaceCurrent();
      if (restoreFocus) actions.focusApplications();
    },
    saveView(event) {
      saveViewDialog(api, currentState, event?.currentTarget || null, actions);
    },
    deleteView(event) {
      const id = currentState.savedView.startsWith("saved:") ? currentState.savedView.slice(6) : "";
      if (!id) return;
      const ownerId = owner(), reviewed = currentSnapshot.customViews.find(view => view.id === id);
      confirmDialog({
        title: "Delete saved view?",
        copy: "This removes the saved filter set. It does not change any applications.",
        confirmLabel: "Delete view",
        tone: "danger",
        trigger: event?.currentTarget,
        onReturnFocus: actions.focusApplications,
        async onConfirm() {
          try {
            if (owner() !== ownerId) throw new Error("Your account changed. Refresh before deleting this view.");
            await api.request(`/api/account/dashboard-views/${APPLICATION_SCOPE}/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedOwnerId: ownerId, revision: reviewed?.revision }) });
            if (owner() !== ownerId) return;
            currentState.savedView = "built:recent";
            currentState.filters = { ...BUILT_IN_VIEWS[0].filters };
            currentState.applicationPage = 1;
            writeFilterRoute(currentState.filters, 1);
            showToast("Saved view deleted.");
            await refreshAfterMutation();
          } catch (error) {
            showToast(error?.message || "Unable to delete this view.");
            throw error;
          }
        },
      });
    },
    openApplication(application, trigger) {
      applicationDialog(api, application, trigger, actions);
    },
    async readUpdatedApplication(application) {
      const context = inlineContext, ownerId = owner();
      if (context) invalidate();
      const snapshot = context
        ? await loadSnapshot(api, { force: true, ownerId, isCurrent: () => owner() === ownerId && context.isValid() })
        : await refreshAfterMutation();
      if (!snapshot?.applications.available) throw new Error("Updated requirements could not load. Try again.");
      const selectedId = applicationId(application), selectedCase = caseId(application);
      const matches = snapshot.activeApplications.filter(item => selectedId
        ? applicationId(item) === selectedId && caseId(item) === selectedCase
        : selectedCase && caseId(item) === selectedCase);
      if (matches.length !== 1) throw new Error("This application is no longer available. Close these details and review your applications.");
      return matches[0];
    },
    confirmApplicationRevoke(application, trigger, parentDialog) {
      if (requirements.pending({ caseId: caseId(application) })) return;
      parentDialog?.close();
      {
        const view = confirmDialog({ title: 'Withdraw this application?', copy: 'Your application will no longer be considered for this Matter.', confirmLabel: 'Withdraw application', tone: 'danger', trigger,
          async onConfirm() {
            const reviewing = earlierWithdrawal.state(application).review;
            const result = await earlierWithdrawal.act(application);
            if (!result) return true;
            if (result.saved) { requirements.discard({ caseId: caseId(application) }); showToast('Application withdrawn.'); await refreshAfterMutation(); return true; }
            if (reviewing && !result.review) {
              view.dialog.close();
              applicationDialog(api, result.application, trigger, actions);
              showToast('Review the updated application before withdrawing.');
              return true;
            }
            return false;
          },
          onReturnFocus: () => {
            const selection = { application: applicationId(application), job: jobId(application) };
            if (!restoreApplicationFocus(selection)) actions.focusApplications({ onlyIfIdle: true });
          },
        });
        const message = node('p', { role: 'status', 'data-earlier-withdrawal-status': '' });
        view.dialog.querySelector('.v2-work-dialog-body').append(message);
        const stop = earlierWithdrawal.observe(application, state => {
          view.confirm.disabled = state.pending || state.saved || !state.review && !applicationIsRevocable(state.application);
          view.cancel.disabled = false;
          view.confirm.textContent = state.pending ? 'Checking…' : state.review ? 'Review saved application' : 'Withdraw application';
          message.textContent = state.message;
          if (state.saved) queueMicrotask(() => { if (view.dialog.isConnected) view.dialog.close(); });
        });
        view.dialog.addEventListener('close', stop, { once: true });
        return;
      }
    },
    confirmInviteDecline(invite, trigger) {
      confirmDialog({
        title: "Decline this invitation?",
        copy: `Decline the invitation for ${invite.title || "this matter"}?`,
        confirmLabel: "Decline invitation",
        tone: "danger",
        trigger,
        async onConfirm(button) {
          await actions.respondInvite(invite, "decline", button);
        },
      });
    },
    async respondInvite(invite, decision, button) {
      const id = caseId(invite);
      if (!id) return;
      if (decision === "accept" && payoutReadiness(currentSnapshot) !== "ready") {
        showToast("Confirm your payout setup before accepting this invitation.");
        return;
      }
      const original = button.textContent;
      button.disabled = true;
      button.textContent = decision === "accept" ? "Accepting…" : "Declining…";
      try {
        await api.post(`/api/cases/${encodeURIComponent(id)}/invite/${decision}`, {});
        showToast(decision === "accept" ? "Invitation accepted." : "Invitation declined.");
        await refreshAfterMutation();
      } catch (error) {
        showToast(error?.message || "Unable to update this invitation.");
        button.disabled = false;
        button.textContent = original;
        throw error;
      }
    },
    openDispute(item, trigger) {
      disputeDialog(api, item, trigger, actions);
    },
    confirmBlock(item, trigger) {
      confirmDialog({
        title: "Block this attorney?",
        copy: "This prevents future applications, invitations, hiring, and direct messaging between you on Let’s-ParaConnect. The attorney will not be notified. Existing matter and payment history remain available.",
        confirmLabel: "Block attorney",
        tone: "danger",
        trigger,
        async onConfirm(button) {
          button.textContent = "Blocking…";
          try {
            await api.post("/api/blocks", { caseId: caseId(item) });
            showToast("Attorney blocked.");
            await refreshAfterMutation();
          } catch (error) {
            showToast(error?.message || "Unable to block this attorney.");
            throw error;
          }
        },
      });
    },
  };

  return Object.freeze({
    createLoadingView: loadingView,
    getCachedSnapshot() { return cachedSnapshot; },
    hasDrafts() { return requirements.hasDrafts(); },
    hasPendingDownload,
    flushDeferredRefresh() { if (deferredInvalidation) invalidate(); },
    clearDrafts() { earlierWithdrawal.clear(); requirements.clear(); resetDownloads(); deferredInvalidation = false; currentRouteKey = null; inlineContext = null; openInvitations.clear(); openReceipts.clear(); invitationReview = null; currentRoot = null; },
    invalidate,
    renderContext({ kind, record, snapshot, isValid, onChanged }) {
      inlineContext = {isValid,onChanged};
      currentSnapshot = { payoutStatus: snapshot.stripe };
      const guarded = Object.fromEntries(Object.entries(actions).map(([key,value]) => [key,typeof value === 'function' ? (...args) => isValid() && value(...args) : value]));
      if (kind === 'invitation') {
        openInvitations.add(caseId(record));
        return inviteRow(record, payoutReadiness(currentSnapshot), guarded, {inline:true});
      }
      return applicationDialog(api, record, null, guarded, {inline:true});
    },
    async render({ route, isCurrent, onRetry }) {
      inlineContext = null;
      const applicationFocus = focusedApplication();
      pendingApplicationFocus = null;
      const generation = ++renderGeneration, ownerId = owner();
      if (deferredInvalidation) invalidate();
      resetDownloads();
      let snapshot;
      try {
        snapshot = await loadSnapshot(api, { ownerId, isCurrent: () => isCurrent() && generation === renderGeneration && owner() === ownerId });
      } catch (_error) {
        if (!isCurrent() || generation !== renderGeneration) return null;
        return errorView(() => { invalidate(); onRetry?.(); }, route.query.get("section"));
      }
      if (!isCurrent() || generation !== renderGeneration) return null;
      currentSnapshot = snapshot;
      const historyPage = currentRouteKey === route.key ? currentState?.historyPage || 1 : 1;
      currentRouteKey = route.key;
      currentState = {
        section: ["active", "applications", "invitations", "history"].includes(route.query.get("section")) ? route.query.get("section") : "active",
        activePage: 1,
        applicationPage: Math.max(1, Number.parseInt(route.query.get("appPage"), 10) || 1),
        historyPage,
        filters: filtersFromRoute(route),
        savedView: route.query.toString() ? "custom" : "built:recent",
        emptySavedViewsOpen: currentState?.emptySavedViewsOpen || false,
      };
      if (!route.query.toString()) currentState.filters = { ...BUILT_IN_VIEWS[0].filters };
      if (!route.query.has("section") && [...route.query.keys()].some(key => key.startsWith("app") || key === "jobId")) currentState.section = "applications";
      const highlightedCase = String(route.query.get("highlightCase") || route.query.get("matterId") || "");
      const highlightedApplication = String(route.query.get("applicationId") || route.query.get("appId") || "");
      const highlightedJob = String(route.query.get("jobId") || "");
      const invitationMatch = snapshot.pendingInvitations.find(item => caseId(item) === highlightedCase);
      currentState.requestedInvitationId = route.query.get("section") === "invitations" ? highlightedCase : "";
      if (highlightedCase) {
        const activeIndex = snapshot.activeCases.findIndex((item) => caseId(item) === highlightedCase);
        const historyIndex = sortedHistoryItems(snapshot).findIndex((item) => caseId(item) === highlightedCase);
        if (activeIndex >= 0) { currentState.section = "active"; currentState.activePage = Math.floor(activeIndex / PAGE_SIZE) + 1; }
        if (historyIndex >= 0) { currentState.section = "history"; currentState.historyPage = Math.floor(historyIndex / PAGE_SIZE) + 1; }
      }
      const applicationMatch = snapshot.activeApplications.find((item) =>
        (highlightedApplication && applicationId(item) === highlightedApplication) ||
        (!highlightedApplication && highlightedJob && jobId(item) === highlightedJob)
      );
      if (applicationMatch) {
        currentState.section = "applications";
        const filtered = filterApplications(snapshot.activeApplications, currentState.filters);
        const index = filtered.indexOf(applicationMatch);
        if (index >= 0) currentState.applicationPage = Math.floor(index / PAGE_SIZE) + 1;
      }
      captureInvitationReview();
      if (invitationMatch) {
        currentState.section = "invitations";
        openInvitations.add(highlightedCase);
      }
      const pendingIds = new Set(snapshot.pendingInvitations.map(caseId));
      openInvitations.forEach(id => { if (!pendingIds.has(id)) openInvitations.delete(id); });
      const historyIds = new Set(snapshot.completedCases.map(caseId));
      openReceipts.forEach(id => { if (!historyIds.has(id)) openReceipts.delete(id); });
      if (applicationFocus?.element === document.activeElement) pendingApplicationFocus = applicationFocus;
      currentRoot = buildWork(snapshot, currentState, actions);
      requestAnimationFrame(() => {
        if (!currentRoot?.isConnected || generation !== renderGeneration) return;
        if (applicationMatch) {
          const trigger = currentRoot.querySelector(`[data-work-application-id="${CSS.escape(applicationId(applicationMatch))}"] button`);
          applicationDialog(api, applicationMatch, trigger, actions);
        }
        if (highlightedCase) {
          if (currentState.requestedInvitationId && !invitationMatch) return;
          if (invitationMatch) {
            const invitation = currentRoot.querySelector(`[data-work-invite-id="${CSS.escape(highlightedCase)}"]`);
            const heading = invitation?.querySelector("h3");
            heading?.setAttribute("tabindex", "-1");
            heading?.focus({ preventScroll: true });
            invitation?.scrollIntoView({ block: "start" });
          }
          currentRoot.querySelector(`[data-work-case-id="${CSS.escape(highlightedCase)}"], [data-work-history-id="${CSS.escape(highlightedCase)}"]`)?.scrollIntoView({ block: "center" });
          const url = new URL(window.location.href);
          const [path, rawQuery = ""] = url.hash.replace(/^#/, "").split("?");
          const query = new URLSearchParams(rawQuery);
          query.delete("highlightCase");
          query.delete("matterId");
          query.set("section", currentState.section);
          url.hash = `${path}${query.size ? `?${query}` : ""}`;
          window.history.replaceState(window.history.state, "", url);
        }
      });
      return currentRoot;
    },
  });
}
