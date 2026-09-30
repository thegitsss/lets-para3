export const VIEW_SCOPE = "attorney_matters";
export const BUILT_IN_VIEWS = [
  { id: "active", name: "Active matters", filters: { view: "active", sort: "recent" } },
  { id: "deadlines", name: "Upcoming deadlines", filters: { view: "active", deadline: "7_days", sort: "deadline" } },
  { id: "applicants", name: "Applicant review", filters: { view: "inquiries", sort: "recent" } },
];
const clean = (value) => String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const allowed = (value, options, fallback = "") => options.includes(value) ? value : fallback;
export function viewFilters(input = {}) {
  return {
    view: allowed(input.view === "applications" ? "inquiries" : input.view, ["active", "draft", "archived", "inquiries"], "active"),
    search: clean(input.search), practice: clean(input.practice),
    deadline: allowed(input.deadline, ["overdue", "7_days", "none"]), updated: allowed(input.updated, ["7_days", "30_days"]),
    sort: allowed(input.sort, ["recent", "deadline", "status", "alphabetical"], "recent"),
    archiveStatus: allowed(input.archiveStatus, ["all", "completed", "paused", "archived"], "all"),
  };
}
export function viewName(value) { const name = clean(value); if (!name || name.length > 48) throw new Error("invalid_name"); return name; }
export const sameFilters = (a, b) => JSON.stringify(viewFilters(a)) === JSON.stringify(viewFilters(b));
export function readSavedViews(value, ownerId) {
  if (value?.ownerId !== ownerId) throw Object.assign(new Error("saved_view_account_changed"), { kind: "authentication" });
  if (value?.scope !== VIEW_SCOPE || !Array.isArray(value.views)) throw new Error("invalid_saved_views");
  if (value.views.some((view) => !/^[\w-]{1,80}$/.test(view?.id || "") || view.scope !== VIEW_SCOPE || typeof view.name !== "string" || !view.name || !/^[a-f0-9]{64}$/.test(view.revision || "") || !view.filters || (typeof view.filters !== "object" || Array.isArray(view.filters)))) throw new Error("invalid_saved_views");
  return value.views.map((view) => ({ ...view, filters: viewFilters(view.filters) }));
}
export const matchesCreation = (view, sent) => view?.id === sent.id && view.name === sent.name && sameFilters(view.filters, sent.filters);
export function filterDescription(value) {
  const f = viewFilters(value);
  return [
    ["Matter category", ({ active: "Active", draft: "Drafts", archived: "Archived", inquiries: "Applications" })[f.view]],
    ["Search", f.search || "Any text"], ["Practice area", f.practice || "All practice areas"],
    ["Deadline", ({ overdue: "Overdue", "7_days": "Next 7 days", none: "No deadline" })[f.deadline] || "All deadlines"],
    ["Last updated", ({ "7_days": "Last 7 days", "30_days": "Last 30 days" })[f.updated] || "Any time"],
    ["Sort", ({ recent: "Recently updated", deadline: "Deadline", status: "Status", alphabetical: "Alphabetical" })[f.sort]],
    ["Archive status", ({ all: "All statuses", completed: "Completed", paused: "Paused", archived: "Archived / closed" })[f.archiveStatus]],
  ];
}
