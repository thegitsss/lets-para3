import { readMatterDiscoveryPage as readBrowsePage } from "../utils/matter-discovery-page.mjs";
import {
  getRecommendationIdentityIds,
  publishRecommendationHistoryChange,
} from "../recommendation-state.mjs";

const BROWSE_CACHE_TTL_MS = 30_000;
const PAGE_SIZE = 12;
const MIN_COMPENSATION = 400;
const MAX_COMPENSATION = 900;
const PAY_STOPS = [400, 500, 600, 700, 800, 900];
const APPLY_MAX_CHARACTERS = 2000;
const FLAG_REASONS = Object.freeze([
  ["inappropriate", "Inappropriate content"],
  ["spam", "Spam or misleading"],
  ["compensation", "Compensation issue"],
  ["duplicate", "Duplicate posting"],
  ["other", "Other"],
]);
const STATE_CODES = new Map([
  ["ALABAMA", "AL"], ["ALASKA", "AK"], ["ARIZONA", "AZ"], ["ARKANSAS", "AR"],
  ["CALIFORNIA", "CA"], ["COLORADO", "CO"], ["CONNECTICUT", "CT"], ["DELAWARE", "DE"],
  ["DISTRICT OF COLUMBIA", "DC"], ["FLORIDA", "FL"], ["GEORGIA", "GA"], ["HAWAII", "HI"],
  ["IDAHO", "ID"], ["ILLINOIS", "IL"], ["INDIANA", "IN"], ["IOWA", "IA"],
  ["KANSAS", "KS"], ["KENTUCKY", "KY"], ["LOUISIANA", "LA"], ["MAINE", "ME"],
  ["MARYLAND", "MD"], ["MASSACHUSETTS", "MA"], ["MICHIGAN", "MI"], ["MINNESOTA", "MN"],
  ["MISSISSIPPI", "MS"], ["MISSOURI", "MO"], ["MONTANA", "MT"], ["NEBRASKA", "NE"],
  ["NEVADA", "NV"], ["NEW HAMPSHIRE", "NH"], ["NEW JERSEY", "NJ"], ["NEW MEXICO", "NM"],
  ["NEW YORK", "NY"], ["NORTH CAROLINA", "NC"], ["NORTH DAKOTA", "ND"], ["OHIO", "OH"],
  ["OKLAHOMA", "OK"], ["OREGON", "OR"], ["PENNSYLVANIA", "PA"], ["RHODE ISLAND", "RI"],
  ["SOUTH CAROLINA", "SC"], ["SOUTH DAKOTA", "SD"], ["TENNESSEE", "TN"], ["TEXAS", "TX"],
  ["UTAH", "UT"], ["VERMONT", "VT"], ["VIRGINIA", "VA"], ["WASHINGTON", "WA"],
  ["WEST VIRGINIA", "WV"], ["WISCONSIN", "WI"], ["WYOMING", "WY"],
]);

let cachedSnapshot = null;
let cachedAt = 0;
let cachedKey = "", pendingKey = "";
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

function normalizeId(value) {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return normalizeId(value._id || value.id || value.caseId || value.jobId || "");
}

function matterId(matter = {}) {
  return normalizeId(matter.caseId || matter.case_id || matter.case || matter.contextCaseId || matter.id || matter._id);
}

function listingId(matter = {}) {
  return matterId(matter) || normalizeId(matter.jobId || matter.job_id || matter.job);
}

function jobId(matter = {}) {
  return normalizeId(matter.jobId || matter.job_id || matter.job?._id || matter.job);
}

function applyTarget(matter = {}) {
  const postingId = jobId(matter);
  if (postingId) return { type: "job", id: postingId };
  const caseId = matterId(matter);
  return caseId ? { type: "case", id: caseId } : null;
}

function stateOf(matter = {}) {
  return String(
    matter.state || matter.locationState || matter.location?.state || matter.jurisdiction || matter.region || ""
  ).trim();
}

function moneyAmount(matter = {}) {
  for (const field of ["remainingAmount", "lockedTotalAmount", "totalAmount"]) {
    if (typeof matter[field] === "number" && Number.isFinite(matter[field])) return Math.max(0, matter[field] / 100);
  }
  if (Number(matter.payAmount) > 0) return Number(matter.payAmount);
  return Math.max(0, Number(matter.budget) || 0);
}

function money(value) {
  const amount = Math.max(0, Number(value) || 0);
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function dateOnly(value) {
  const direct = String(value || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(direct)) return "";
  const date = new Date(`${direct}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === direct ? direct : "";
}

function displayDate(value, fallback = "No deadline") {
  const date = dateOnly(value);
  if (!date) return fallback;
  return new Date(`${date}T12:00:00.000Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function postedDate(value) {
  if (!value) return "Date not listed";
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "Date not listed";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function quantizedPay(value) {
  const amount = Math.max(MIN_COMPENSATION, Math.min(MAX_COMPENSATION, Number(value) || MIN_COMPENSATION));
  return PAY_STOPS.reduce((closest, stop) => (
    Math.abs(stop - amount) < Math.abs(closest - amount) ? stop : closest
  ), PAY_STOPS[0]);
}

function applicationEligibility(matter = {}) {
  const value = matter.applicationEligibility;
  return value && typeof value === "object"
    ? value
    : { ready: false, allowed: false, blockers: ["eligibility_unverified"] };
}

function applicationBlockMessage(matter = {}) {
  const eligibility = applicationEligibility(matter);
  const blockers = new Set(eligibility.blockers || []);
  const payoutBlockers = new Set(eligibility.facts?.payoutReadiness?.blockers || []);
  if (blockers.has("posting_verification_required")) return "Applications for this matter are temporarily unavailable.";
  if (blockers.has("profile_photo_required")) return "Add a profile photo before applying.";
  if (payoutBlockers.has("stripe_status_unverified")) {
    return "Stripe payout status is temporarily unavailable. Try again before applying.";
  }
  if (blockers.has("paralegal_payout_setup_required")) {
    return "Complete your payout setup before applying to matters.";
  }
  if (blockers.has("duplicate_application")) return "You have already applied to this matter.";
  if (blockers.has("parties_blocked")) return "This application is unavailable.";
  if (blockers.has("applications_closed") || blockers.has("paralegal_already_assigned")) {
    return "Applications are closed for this matter.";
  }
  if (blockers.has("approved_paralegal_required")) {
    return "An approved paralegal account is required to apply.";
  }
  return "We couldn’t check whether you can apply. Refresh the page and try again.";
}

function browseRequestPath(route) {
  const params = new URLSearchParams({ view: "browse", limit: String(PAGE_SIZE) });
  for (const [key, alias] of [["practice", "browsePractice"], ["state", "browseState"], ["minPay", "browseMinPay"], ["deadline", "browseDeadline"], ["posted", "browsePosted"], ["sort", "browseSort"], ["page", "browsePage"], ["matterId", "matterId"]]) {
    const value = route.query.has(key) ? route.query.get(key) : route.query.get(alias);
    if (value !== null) params.set(key, key === "minPay" ? String(quantizedPay(value)) : value);
  }
  return `/api/jobs/open?${params}`;
}

async function loadSnapshot(api, route, isCurrent) {
  const key = browseRequestPath(route);
  while (isCurrent()) {
    if (cachedSnapshot && cachedKey === key && Date.now() - cachedAt < BROWSE_CACHE_TTL_MS) return cachedSnapshot;
    if (pendingSnapshot && pendingKey === key) {
      const pending = pendingSnapshot;
      try { await pending; } catch (error) { if (pending === pendingSnapshot) throw error; }
      continue;
    }
    const revision = cacheRevision;
    const request = api.get(key).then(readBrowsePage);
    pendingSnapshot = request; pendingKey = key;
    try {
      let snapshot;
      try { snapshot = await request; }
      catch (error) { if (revision !== cacheRevision) continue; throw error; }
      if (revision !== cacheRevision) continue;
      cachedSnapshot = snapshot; cachedKey = key; cachedAt = Date.now();
      return snapshot;
    } finally {
      if (pendingSnapshot === request) { pendingSnapshot = null; pendingKey = ""; }
    }
  }
  return null;
}

function loadingView() {
  return node("section", { className: "v2-browse v2-browse--loading", "aria-label": "Loading Browse Matters" }, [
    node("div", { className: "v2-browse-loading-rail" }),
    node("div", { className: "v2-browse-loading-results" }),
  ]);
}

function option(value, label, selected = false) {
  return node("option", { value, text: label, selected: selected ? "selected" : null });
}



function filtersRoute(filters) {
  const params = new URLSearchParams();
  if (filters.practice) params.set("practice", filters.practice);
  params.set("state", filters.state);
  if (filters.minPay > MIN_COMPENSATION) params.set("minPay", String(filters.minPay));
  if (filters.deadline) params.set("deadline", filters.deadline);
  if (filters.posted) params.set("posted", filters.posted);
  if (filters.sort !== "newest") params.set("sort", filters.sort);
  if (filters.page > 1) params.set("page", String(filters.page));
  return `/browse?${params}`;
}

function writeFiltersToHash(filters) {
  window.history.replaceState(window.history.state, "", `#${filtersRoute(filters)}`);
}

function filterRail(snapshot, filters, actions) {
  const titleCase = value => value.replace(/\b[a-z]/g, letter => letter.toUpperCase());
  const states = new Map([...STATE_CODES].map(([name, code]) => [code, titleCase(name.toLowerCase())]));
  const choices = (values, selected, label = titleCase) => [...new Set([...values, ...(selected ? [selected] : [])])].map(value => [value, label(value)]);
  const definitions = [
    { key: "practice", title: "Practice area", options: [["", "All"], ...choices(snapshot.facets.practices, filters.practice)] },
    { key: "state", title: "State", options: [["", "All"], ...choices(snapshot.facets.states, filters.state, value => states.get(value) || value)] },
    { key: "minPay", title: "Minimum matter amount", label: "Minimum matter amount", options: PAY_STOPS.map((value) => [value, value >= MAX_COMPENSATION ? "$900+" : money(value)]) },
    { key: "deadline", title: "Deadline", options: [["", "Any deadline"], ["7_days", "Within 7 days"], ["30_days", "Within 30 days"], ["none", "No deadline listed"]] },
    { key: "posted", title: "Date posted", options: [["", "Any time"], ["7_days", "Past 7 days"], ["30_days", "Past 30 days"]] },
  ];
  const draft = { ...filters };
  const rail = node("aside", { id: "v2-browse-filters", popover: "auto", className: "v2-browse-filter", "aria-labelledby": "v2-browse-filter-title" });
  const selectionLabel = (definition) => definition.options.find(([value]) => String(value) === String(draft[definition.key]))?.[1] || "All";

  function mainView(focusKey = "") {
    const clear = node("button", { type: "button", className: "v2-browse-filter-clear", text: "Clear all" });
    clear.addEventListener("click", () => actions.clear());
    const categories = node("div", { className: "v2-filter-categories" });
    definitions.forEach((definition) => {
      const selected = selectionLabel(definition);
      const row = node("button", {
        type: "button", className: "v2-filter-category", "data-filter-category": definition.key,
        "aria-label": `${definition.title}: ${selected}`,
      }, [
        node("span", { text: definition.title }),
        node("span", { className: "v2-filter-selection", text: selected }),
        node("span", { className: "v2-filter-chevron", "aria-hidden": "true", text: "›" }),
      ]);
      row.addEventListener("click", () => detailView(definition));
      categories.append(row);
    });
    const apply = node("button", { className: "v2-browse-filter-apply", type: "button", text: "Apply filters" });
    apply.addEventListener("click", () => actions.updateFilters({ ...draft, minPay: quantizedPay(draft.minPay), page: 1 }));
    rail.replaceChildren(
      node("header", { className: "v2-browse-filter-heading" }, [
        node("h2", { id: "v2-browse-filter-title", text: "Add filters" }), clear,
      ]),
      categories,
      node("footer", { className: "v2-browse-filter-actions" }, [
        node("button", { className: "v2-browse-filter-close", type: "button", text: "Close", "aria-label": "Close filters", popovertarget: rail.id, popovertargetaction: "hide" }), apply,
      ]),
    );
    rail.scrollTop = 0;
    if (focusKey) rail.querySelector(`[data-filter-category="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  function detailView(definition) {
    const back = node("button", { className: "v2-filter-back", type: "button", "aria-label": "Back to filters", text: "‹" });
    back.addEventListener("click", () => mainView(definition.key));
    const clear = node("button", { className: "v2-browse-filter-clear", type: "button", text: "Clear", "aria-label": `Clear ${definition.title.toLowerCase()}` });
    const choices = node("fieldset", { className: "v2-filter-options" }, [
      node("legend", { className: "v2-visually-hidden", text: definition.label || definition.title }),
    ]);
    const choiceRows = definition.options.map(([value, label]) => {
      const input = node("input", { type: "radio", name: `browse-filter-${definition.key}`, value, ...(String(draft[definition.key]) === String(value) ? { checked: true } : {}) });
      input.addEventListener("change", () => { if (input.checked) draft[definition.key] = value; });
      const row = node("label", { className: "v2-filter-option" }, [input, node("span", { text: label })]);
      choices.append(row);
      return { row, input, label };
    });
    clear.addEventListener("click", () => {
      draft[definition.key] = definition.options[0][0];
      choiceRows.forEach(({ input }) => { input.checked = input.value === String(draft[definition.key]); });
    });
    const done = node("button", { className: "v2-browse-filter-apply", type: "button", text: "Done" });
    done.addEventListener("click", () => mainView(definition.key));
    const search = definition.options.length > 8 ? node("input", {
      className: "v2-filter-search", type: "search", placeholder: `Search ${definition.title.toLowerCase()}…`, "aria-label": `Search ${definition.title.toLowerCase()}`,
    }) : null;
    const empty = node("p", { className: "v2-filter-no-options", text: "No matches found.", hidden: true, role: "status" });
    search?.addEventListener("input", () => {
      const query = search.value.trim().toLocaleLowerCase();
      choiceRows.forEach(({ row, label }) => { row.hidden = !label.toLocaleLowerCase().includes(query); });
      empty.hidden = choiceRows.some(({ row }) => !row.hidden);
    });
    rail.replaceChildren(...[
      node("header", { className: "v2-browse-filter-heading v2-filter-detail-heading" }, [
        back, node("h2", { id: "v2-browse-filter-title", text: definition.title }), clear,
      ]), search,
      choices, empty,
      node("footer", { className: "v2-browse-filter-actions v2-filter-detail-actions" }, [done]),
    ].filter(Boolean));
    rail.scrollTop = 0;
    (search || choices.querySelector("input:checked") || back).focus({ preventScroll: true });
  }

  mainView();
  rail.addEventListener("beforetoggle", (event) => {
    if (event.newState === "open") mainView();
  });
  return rail;
}

function eligibilityButton(matter, onApply, showToast) {
  const eligibility = applicationEligibility(matter);
  const button = node("button", {
    className: `v2-browse-apply${eligibility.ready === true ? "" : " is-restricted"}`,
    type: "button",
    text: "Apply",
    "aria-disabled": eligibility.ready === true ? null : "true",
  });
  button.addEventListener("click", () => {
    if (eligibility.ready !== true) {
      showToast(applicationBlockMessage(matter));
      return;
    }
    onApply(matter, button);
  });
  return button;
}

function matterCard(matter, index, actions) {
  const id = listingId(matter);
  const title = String(matter.title || "Untitled matter");
  const article = node("article", { className: "v2-browse-card", "aria-labelledby": `v2-matter-${id || index}` }, [
    node("div", { className: "v2-browse-card-index", text: String(index + 1).padStart(2, "0") }),
    node("div", { className: "v2-browse-card-copy" }, [
      node("p", { className: "v2-browse-card-practice", text: matter.practiceArea || "Practice area not listed" }),
      node("h2", { id: `v2-matter-${id || index}`, text: title }),
      node("p", {
        className: "v2-browse-card-summary",
        text: matter.briefSummary || matter.shortDescription || matter.description || "No description provided.",
      }),
      node("dl", { className: "v2-browse-card-meta" }, [
        node("div", {}, [node("dt", { text: "State" }), node("dd", { text: stateOf(matter) || "Not listed" })]),
        node("div", {}, [node("dt", { text: "Deadline" }), node("dd", { text: displayDate(matter.deadlineDate || matter.deadline) })]),
      ]),
    ]),
    node("div", { className: "v2-browse-card-actions" }, [
      node("span", { className: "v2-desk-compensation-label", text: "Compensation" }),
      node("strong", { text: money(moneyAmount(matter)) }),
      node("a", {
        className: "v2-browse-details",
        href: `paralegal-v2.html#${actions.detailRoute(id)}`,
        "data-view": actions.detailRoute(id),
        "data-browse-detail-id": id,
        "data-v2-route": "",
        text: "Details",
      }),
      eligibilityButton(matter, actions.apply, actions.showToast),
    ]),
  ]);
  article.querySelector(".v2-browse-details")?.addEventListener("click", () => actions.rememberBrowse(id));
  return article;
}

function pageButton(label, page, disabled, actions) {
  const button = node("button", { type: "button", text: label, disabled: disabled ? "disabled" : null });
  button.addEventListener("click", () => actions.page(page));
  return button;
}

function resultsView(snapshot, filters, actions) {
  const totalPages = snapshot.totalPages;
  const page = snapshot.page;
  const start = (page - 1) * PAGE_SIZE;
  const items = snapshot.listings;
  const results = node("section", { className: "v2-browse-results", "aria-labelledby": "v2-browse-title" });
  const sort = node("select", { className: "v2-browse-sort", "aria-label": "Sort matters", title: "Sort matters" }, [
    option("newest", "Newest", filters.sort === "newest"),
    option("deadline", "Soonest due", filters.sort === "deadline"),
    option("payHigh", "Highest pay", filters.sort === "payHigh"),
    option("payLow", "Lowest pay", filters.sort === "payLow"),
  ]);
  sort.addEventListener("change", () => actions.updateFilters({ ...filters, sort: sort.value, page: 1 }));
  const filterCount = [filters.practice, filters.state, filters.minPay > MIN_COMPENSATION, filters.deadline, filters.posted]
    .filter(Boolean).length;
  results.append(node("header", { className: "v2-browse-results-header" }, [
    node("div", {}, [
    node("h1", { id: "v2-browse-title", tabindex: "-1", text: "Browse matters" }),
    ]),
    node("div", { className: "v2-browse-result-controls" }, [
      node("p", {
        className: "v2-browse-result-count",
        text: snapshot.total === 1 ? "1 open matter" : `${snapshot.total} open matters`,
        "aria-live": "polite",
      }),
      node("button", {
        className: "v2-browse-filter-toggle",
        type: "button",
        text: `Filters${filterCount ? ` (${filterCount})` : ""}`,
        "aria-controls": "v2-browse-filters",
        "aria-expanded": "false",
        popovertarget: "v2-browse-filters",
      }),
      sort,
    ]),
  ]));

  const list = node("div", { className: "v2-browse-list", "aria-label": "Open matters" });
  if (!items.length) {
    list.append(node("div", { className: "v2-browse-empty" }, [
      node("h2", { text: snapshot.availableTotal ? "No matters match these filters" : "No open matters right now." }),
      snapshot.availableTotal ? node("button", { type: "button", text: "Clear filters" }) : null,
    ]));
    list.querySelector("button")?.addEventListener("click", actions.clear);
  } else {
    items.forEach((matter, index) => list.append(matterCard(matter, start + index, actions)));
  }
  results.append(list);
  if (totalPages > 1) {
    results.append(node("nav", { className: "v2-browse-pagination", "aria-label": "Matter result pages" }, [
      pageButton("Back", page - 1, page <= 1, actions),
      node("span", { text: `${page} / ${totalPages}` }),
      pageButton("Next", page + 1, page >= totalPages, actions),
    ]));
  }
  return results;
}

function attorneyName(matter = {}) {
  const attorney = matter.attorney || {};
  return [attorney.firstName, attorney.lastName].filter(Boolean).join(" ").trim() || "Attorney";
}

function descriptionText(matter = {}) {
  return String(matter.description || matter.details || matter.briefSummary || "No additional description was provided for this matter.")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function detailView(matter, actions) {
  const attorney = matter.attorney || {};
  const attorneyId = normalizeId(matter.attorneyId || attorney._id || attorney.id);
  const tasks = Array.isArray(matter.tasks) ? matter.tasks : [];
  const page = node("section", { className: "v2-browse-detail", "aria-labelledby": "v2-browse-detail-title" }, [
    node("a", {
      className: "v2-browse-back",
      href: `paralegal-v2.html#${actions.browseRoute()}`,
      "data-view": actions.browseRoute(),
      "data-v2-route": "",
      text: "Back to Browse Matters",
    }),
    node("article", { className: "v2-browse-detail-sheet" }, [
      node("header", { className: "v2-browse-detail-header" }, [
        node("div", {}, [
          node("p", { className: "v2-browse-kicker", text: matter.practiceArea || "Practice area not listed" }),
          node("h1", { id: "v2-browse-detail-title", text: matter.title || "Untitled matter" }),
          node("p", { text: `Posted ${postedDate(matter.createdAt)}` }),
        ]),
        node("div", { className: "v2-browse-detail-actions" }, [
          node("button", { className: "v2-browse-report", type: "button", text: "Report", disabled: matterId(matter) ? null : "disabled" }),
          eligibilityButton(matter, actions.apply, actions.showToast),
        ]),
      ]),
      node("dl", { className: "v2-browse-detail-facts" }, [
        node("div", {}, [node("dt", { text: "State" }), node("dd", { text: stateOf(matter) || "Not listed" })]),
        node("div", {}, [node("dt", { text: "Compensation" }), node("dd", {}, [node("span", { text: money(moneyAmount(matter)) })])]),
        node("div", {}, [node("dt", { text: "Deadline" }), node("dd", { text: displayDate(matter.deadlineDate || matter.deadline) })]),
        node("div", {}, [
          node("dt", { text: "Experience" }),
          node("dd", { text: Number(matter.minimumYearsExperience) > 0 ? `${matter.minimumYearsExperience}+ years required` : "No minimum listed" }),
        ]),
      ]),
      node("div", { className: "v2-browse-detail-body" }, [
        node("section", {}, [
          node("h2", { text: "Matter overview" }),
          node("p", { className: "v2-browse-detail-description", text: descriptionText(matter) }),
          tasks.length ? node("div", { className: "v2-browse-task-section" }, [
            node("h2", { text: "Scope" }),
            node("ul", {}, tasks.map((task) => node("li", {
              className: typeof task === "object" && task.completed ? "is-complete" : "",
              text: typeof task === "string" ? task : task.title || "Work item",
            }))),
          ]) : null,
        ]),
        node("aside", { className: "v2-browse-attorney", "aria-label": "Posted by" }, [
          node("p", { className: "v2-browse-kicker", text: "Posted by" }),
          node("img", {
            src: attorney.profileImage || attorney.avatarURL || "assets/avatar-placeholder.svg",
            alt: `Profile photo of ${attorneyName(matter)}`,
          }),
          node("strong", { text: attorneyName(matter) }),
          node("span", { text: attorney.lawFirm || attorney.firmName || "Firm not listed" }),
          attorneyId ? node("a", {
            href: `paralegal-v2.html#/attorney/${encodeURIComponent(attorneyId)}`,
            "data-view": `/attorney/${encodeURIComponent(attorneyId)}`,
            "data-v2-route": "",
            text: "View profile",
          }) : null,
        ]),
      ]),
    ]),
  ]);
  page.querySelector(".v2-browse-report")?.addEventListener("click", (event) => actions.report(matter, event.currentTarget));
  return page;
}

function dialogCloseButton(dialog, label = "Close") {
  const button = node("button", { className: "v2-browse-dialog-close", type: "button", "aria-label": label, text: "×" });
  button.addEventListener("click", () => dialog.close());
  return button;
}

function bindDialogDismiss(dialog) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    if (!inside) dialog.close();
  });
}

function createApplyDialog(api, matter, trigger, actions, drafts) {
  const titleId = `v2-apply-${listingId(matter) || "matter"}`;
  const draftKey = `${normalizeId(actions.viewerId?.())}:${listingId(matter)}`;
  const draft = String(drafts.get(draftKey) || "");
  const counter = node("span", { text: `${draft.length} / ${APPLY_MAX_CHARACTERS}` });
  const status = node("p", { className: "v2-browse-dialog-status", role: "status", "aria-live": "polite" });
  const textarea = node("textarea", {
    id: `${titleId}-note`,
    rows: 7,
    minlength: 20,
    maxlength: APPLY_MAX_CHARACTERS,
    required: "required",
    "aria-describedby": `${titleId}-help`,
    text: draft,
  });
  const submit = node("button", { className: "v2-browse-dialog-primary", type: "submit", text: "Submit application" });
  const dialog = node("dialog", { className: "v2-browse-dialog", "aria-labelledby": titleId, "data-v2-route-dialog": "" }, [
    node("form", { method: "dialog" }, [
      node("header", {}, [
        node("div", {}, [node("p", { className: "v2-browse-kicker", text: "Application" }), node("h2", { id: titleId, text: `Apply to ${matter.title || "this matter"}` })]),
        node("span"),
      ]),
      node("p", { id: `${titleId}-help`, className: "v2-browse-dialog-help", text: "Share why your experience is a strong fit. Your résumé and LinkedIn link are shared if you’ve added them to your profile." }),
      node("label", { className: "v2-browse-dialog-field", for: `${titleId}-note` }, [node("span", { text: "Cover letter" }), textarea]),
      node("div", { className: "v2-browse-dialog-meta" }, [counter, status]),
      node("footer", {}, [
        node("button", { className: "v2-browse-dialog-secondary", type: "button", text: "Cancel" }),
        submit,
      ]),
    ]),
  ]);
  dialog.querySelector("header > span").replaceWith(dialogCloseButton(dialog, "Close application"));
  dialog.querySelector(".v2-browse-dialog-secondary").addEventListener("click", () => dialog.close());
  textarea.addEventListener("input", () => {
    counter.textContent = `${textarea.value.length} / ${APPLY_MAX_CHARACTERS}`;
    if (textarea.value) drafts.set(draftKey, textarea.value);
    else drafts.delete(draftKey);
  });
  dialog.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const note = textarea.value.trim();
    if (note.length < 20) {
      status.textContent = "Add a cover letter of at least 20 characters.";
      textarea.focus();
      return;
    }
    const target = applyTarget(matter);
    if (!target) {
      status.textContent = "This application cannot be submitted right now.";
      return;
    }
    submit.disabled = true;
    submit.textContent = "Submitting…";
    status.textContent = "";
    try {
      const path = target.type === "job"
        ? `/api/jobs/${encodeURIComponent(target.id)}/apply`
        : `/api/cases/${encodeURIComponent(target.id)}/apply`;
      await api.post(path, { coverLetter: note });
      drafts.delete(draftKey);
      dialog.close();
      actions.applied(matter);
    } catch (error) {
      status.textContent = error?.message || "The application could not be submitted.";
      submit.disabled = false;
      submit.textContent = "Submit application";
    }
  });
  dialog.addEventListener("close", () => trigger?.focus({ preventScroll: true }), { once: true });
  bindDialogDismiss(dialog);
  return dialog;
}

function createReportDialog(api, matter, trigger, showToast) {
  const titleId = `v2-report-${listingId(matter) || "matter"}`;
  const status = node("p", { className: "v2-browse-dialog-status", role: "status", "aria-live": "polite" });
  const details = node("textarea", { rows: 4, maxlength: 2000, placeholder: "Optional details" });
  const submit = node("button", { className: "v2-browse-dialog-primary", type: "submit", text: "Submit report", disabled: "disabled" });
  const reasons = FLAG_REASONS.map(([value, label]) => node("label", { className: "v2-browse-report-option" }, [
    node("input", { type: "radio", name: `${titleId}-reason`, value }),
    node("span", { text: label }),
  ]));
  const dialog = node("dialog", { className: "v2-browse-dialog", "aria-labelledby": titleId, "data-v2-route-dialog": "" }, [
    node("form", { method: "dialog" }, [
      node("header", {}, [
        node("div", {}, [node("p", { className: "v2-browse-kicker", text: "Safety" }), node("h2", { id: titleId, text: "Report this matter" })]),
        node("span"),
      ]),
      node("p", { className: "v2-browse-dialog-help", text: "Tell LPC what should be reviewed." }),
      node("fieldset", { className: "v2-browse-report-options" }, [node("legend", { className: "v2-visually-hidden", text: "Report reason" }), reasons]),
      node("label", { className: "v2-browse-dialog-field" }, [node("span", { text: "Additional details" }), details]),
      status,
      node("footer", {}, [
        node("button", { className: "v2-browse-dialog-secondary", type: "button", text: "Cancel" }),
        submit,
      ]),
    ]),
  ]);
  dialog.querySelector("header > span").replaceWith(dialogCloseButton(dialog, "Close report"));
  dialog.querySelector(".v2-browse-dialog-secondary").addEventListener("click", () => dialog.close());
  dialog.querySelectorAll('input[type="radio"]').forEach((input) => input.addEventListener("change", () => { submit.disabled = false; }));
  dialog.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = dialog.querySelector('input[type="radio"]:checked');
    if (!selected) return;
    submit.disabled = true;
    submit.textContent = "Submitting…";
    try {
      await api.post(`/api/cases/${encodeURIComponent(matterId(matter))}/flag`, {
        reason: selected.value,
        details: details.value.trim(),
      });
      dialog.close();
      showToast("Thanks for letting us know. We’ll review this matter.");
    } catch (error) {
      status.textContent = error?.message || "The report could not be submitted.";
      submit.disabled = false;
      submit.textContent = "Submit report";
    }
  });
  dialog.addEventListener("close", () => trigger?.focus({ preventScroll: true }), { once: true });
  bindDialogDismiss(dialog);
  return dialog;
}

function createApplicationConfirmation(matter) {
  const dialog = node("dialog", { className: "v2-browse-dialog v2-browse-confirmation", "aria-labelledby": "v2-application-confirmation-title", "data-v2-route-dialog": "" }, [
    node("div", { className: "v2-browse-confirmation-body" }, [
      node("p", { className: "v2-browse-kicker", text: "Application submitted" }),
      node("h2", { id: "v2-application-confirmation-title", text: matter.title || "Matter application" }),
      node("div", { className: "v2-browse-confirmation-actions" }, [
        node("a", {
          href: "paralegal-v2.html#/work?section=applications",
          "data-view": "/work?section=applications",
          "data-v2-route": "",
          text: "View my applications",
        }),
        node("button", { className: "v2-browse-dialog-primary", type: "button", text: "Close" }),
      ]),
    ]),
  ]);
  dialog.querySelector("button").addEventListener("click", () => dialog.close());
  bindDialogDismiss(dialog);
  return dialog;
}

function errorView(onRetry) {
  const retry = node("button", { className: "v2-browse-filter-apply", type: "button", text: "Try again" });
  retry.addEventListener("click", onRetry);
  return node("section", { className: "v2-browse-error", "aria-labelledby": "v2-browse-error-title" }, [
    node("h1", { id: "v2-browse-error-title", text: "Open matters could not be loaded" }),
    retry,
  ]);
}

export function createBrowseView({ api, showToast, invalidateHome, invalidateWork }) {
  let currentSnapshot = null;
  let currentFilters = null;
  let currentRoot = null;
  const applicationDrafts = new Map();
  let browseContext = null;
  let refreshRoute = null, returnFocus = "";
  let pendingConfirmation = null;
  window.addEventListener("lpc:v2-route-changed", event => {
    if (pendingConfirmation && event.detail?.name === "browse" && !event.detail.query?.get("matterId")) {
      const matter = pendingConfirmation;
      pendingConfirmation = null;
      showApplicationConfirmation(matter);
    } else if (event.detail?.name !== "browse") pendingConfirmation = null;
    if (returnFocus && currentRoot?.isConnected && window.location.hash.startsWith("#/browse")) {
      currentRoot.querySelector(returnFocus)?.focus({ preventScroll: true }); returnFocus = "";
    }
    if (!browseContext || !currentRoot?.isConnected || window.location.hash.includes("matterId=")) return;
    if (filtersRoute(currentFilters) !== browseContext.route) return;
    const trigger = Array.from(currentRoot.querySelectorAll("[data-browse-detail-id]")).find((item) => item.dataset.browseDetailId === browseContext.id);
    document.querySelector("[data-v2-route-outlet]").scrollTop = browseContext.scrollTop;
    trigger?.focus({ preventScroll: true });
    browseContext = null;
  });

  function invalidate() {
    cacheRevision += 1;
    cachedSnapshot = null;
    cachedAt = 0;
    cachedKey = ""; pendingKey = "";
    pendingSnapshot = null;
  }

  function navigateFilters(filters) {
    returnFocus = currentRoot?.querySelector(".v2-browse-filter")?.matches(":popover-open") ? ".v2-browse-filter-toggle"
      : document.activeElement?.matches(".v2-browse-sort") ? ".v2-browse-sort" : "#v2-browse-title";
    currentFilters = { ...filters };
    const hash = `#${filtersRoute(currentFilters)}`;
    if (window.location.hash === hash) refreshRoute?.();
    else window.location.hash = hash;
  }

  function showApplicationConfirmation(matter) {
    const confirmation = createApplicationConfirmation(matter);
    document.querySelector("[data-v2-dialog-host]")?.append(confirmation);
    confirmation.showModal();
    confirmation.querySelector("button")?.focus();
    confirmation.addEventListener("close", () => {
      confirmation.remove();
      document.querySelector("[data-v2-route-outlet]")?.focus({ preventScroll: true });
    }, { once: true });
  }

  const actions = {
    showToast,
    browseRoute() { return filtersRoute(currentFilters); },
    detailRoute(id) { return `${filtersRoute(currentFilters)}&matterId=${encodeURIComponent(id)}`; },
    rememberBrowse(id) {
      browseContext = { id, route: filtersRoute(currentFilters), scrollTop: document.querySelector("[data-v2-route-outlet]")?.scrollTop || 0 };
    },
    viewerId() {
      return currentSnapshot?.profile?._id || currentSnapshot?.profile?.id || "";
    },
    updateFilters(filters) {
      navigateFilters(filters);
    },
    clear() {
      navigateFilters({ practice: "", state: "", minPay: MIN_COMPENSATION, deadline: "", posted: "", sort: "newest", page: 1 });
    },
    page(page) {
      navigateFilters({ ...currentFilters, page });
    },
    apply(matter, trigger) {
      const dialog = createApplyDialog(api, matter, trigger, actions, applicationDrafts);
      document.querySelector("[data-v2-dialog-host]")?.append(dialog);
      dialog.showModal();
      dialog.querySelector("textarea")?.focus();
      dialog.addEventListener("close", () => dialog.remove(), { once: true });
    },
    report(matter, trigger) {
      const dialog = createReportDialog(api, matter, trigger, showToast);
      document.querySelector("[data-v2-dialog-host]")?.append(dialog);
      dialog.showModal();
      dialog.querySelector('input[type="radio"]')?.focus();
      dialog.addEventListener("close", () => dialog.remove(), { once: true });
    },
    applied(matter) {
      invalidate();
      invalidateHome?.();
      invalidateWork?.();
      publishRecommendationHistoryChange({
        viewerId: normalizeId(currentSnapshot.profile?._id || currentSnapshot.profile?.id),
        caseIds: [matter.caseId, matter.contextCaseId].filter(Boolean),
        jobIds: [matter.jobId].filter(Boolean),
        matterIds: getRecommendationIdentityIds(matter),
      });
      // Opening before the destination commits lets route cleanup immediately
      // dismiss this receipt, particularly after a real application SSE event.
      pendingConfirmation = matter;
      if (window.location.hash.includes("matterId=")) {
        window.location.hash = actions.browseRoute();
      } else {
        refreshRoute?.();
      }
    },
  };

  function buildBrowse(snapshot, filters) {
    const root = node("section", { className: "v2-browse", "data-v2-browse": "" });
    const rail = filterRail(snapshot, filters, actions);
    const results = resultsView(snapshot, filters, actions);
    root.append(rail, results);
    const toggle = results.querySelector(".v2-browse-filter-toggle");
    const closeFilters = () => {
      rail.hidePopover();
      toggle?.focus({ preventScroll: true });
    };
    rail.addEventListener("click", (event) => {
      if (!event.target.closest(".v2-browse-filter-close")) return;
      event.preventDefault();
      closeFilters();
    });
    rail.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeFilters();
    });
    rail.addEventListener("beforetoggle", (event) => {
      if (event.newState !== "open") return;
      const anchor = toggle.getBoundingClientRect();
      const width = Math.min(280, window.innerWidth - 32);
      const top = Math.min(anchor.bottom + 8, Math.max(16, window.innerHeight - 240));
      rail.style.width = `${width}px`;
      rail.style.left = `${Math.max(16, Math.min(anchor.right - width, window.innerWidth - width - 16))}px`;
      rail.style.top = `${top}px`;
      rail.style.maxHeight = `${window.innerHeight - top - 16}px`;
    });
    rail.addEventListener("toggle", (event) => {
      const open = event.newState === "open";
      root.classList.toggle("is-filter-open", open);
      toggle?.setAttribute("aria-expanded", String(open));
      if (open) rail.querySelector("[data-filter-category]")?.focus({ preventScroll: true });
    });
    return root;
  }

  return Object.freeze({
    createLoadingView: loadingView,
    getCachedSnapshot() {
      return cachedSnapshot;
    },
    hasDrafts() {
      return applicationDrafts.size > 0;
    },
    clearDrafts() {
      applicationDrafts.clear();
      browseContext = null;
      returnFocus = "";
      pendingConfirmation = null;
    },
    invalidate,
    async render({ route, isCurrent, onRetry }) {
      refreshRoute = onRetry;
      let snapshot;
      try {
        snapshot = await loadSnapshot(api, route, isCurrent);
      } catch (_error) {
        if (!isCurrent()) return null;
        return errorView(() => {
          invalidate();
          onRetry?.();
        });
      }
      if (!isCurrent()) return null;
      currentSnapshot = snapshot;
      currentFilters = { ...snapshot.filters };
      const requestedMatter = String(route.query.get("matterId") || "").trim();
      if (requestedMatter) {
        const matter = snapshot.selected;
        if (matter) return detailView(matter, actions);
        const missing = node("section", { className: "v2-browse-error", "aria-labelledby": "v2-browse-missing-title" }, [
          node("h1", { id: "v2-browse-missing-title", text: "This matter is no longer available" }),
          node("a", { href: `paralegal-v2.html#${actions.browseRoute()}`, "data-view": actions.browseRoute(), "data-v2-route": "", text: "Return to Browse Matters" }),
        ]);
        return missing;
      }
      writeFiltersToHash(currentFilters);
      currentRoot = buildBrowse(snapshot, currentFilters);
      return currentRoot;
    },
  });
}
