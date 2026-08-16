const DASHBOARD_VIEW_SCOPES = Object.freeze([
  "attorney_matters",
  "paralegal_applications",
]);

const MAX_VIEWS_PER_SCOPE = 12;
const MAX_VIEW_NAME_LENGTH = 48;

class DashboardSavedViewError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "DashboardSavedViewError";
    this.code = code;
  }
}

function cleanText(value, max = 120) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function allowed(value, values, fallback = "") {
  const normalized = cleanText(value, 80).toLowerCase();
  return values.includes(normalized) ? normalized : fallback;
}

function normalizeDashboardViewFilters(scope, input = {}) {
  if (!DASHBOARD_VIEW_SCOPES.includes(scope)) {
    throw new DashboardSavedViewError("dashboard_view_scope_invalid");
  }
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (scope === "attorney_matters") {
    return {
      view: allowed(source.view, ["active", "draft", "archived", "inquiries"], "active"),
      search: cleanText(source.search, 80),
      practice: cleanText(source.practice, 120),
      deadline: allowed(source.deadline, ["", "overdue", "7_days", "none"]),
      updated: allowed(source.updated, ["", "7_days", "30_days"]),
      sort: allowed(source.sort, ["recent", "deadline", "status", "alphabetical"], "recent"),
    };
  }
  return {
    search: cleanText(source.search, 80),
    status: cleanText(source.status, 80) || "all",
    practice: cleanText(source.practice, 120) || "all",
    dateRange: allowed(source.dateRange, ["3", "7", "30", "all"], "all"),
    sort: allowed(source.sort, ["newest", "oldest", "matter"], "newest"),
  };
}

function normalizeDashboardSavedView(input = {}) {
  const scope = cleanText(input.scope, 80).toLowerCase();
  const name = cleanText(input.name, MAX_VIEW_NAME_LENGTH);
  if (!name) throw new DashboardSavedViewError("dashboard_view_name_required");
  const id = cleanText(input.id, 80);
  return {
    ...(id ? { id } : {}),
    scope,
    name,
    filters: normalizeDashboardViewFilters(scope, input.filters),
  };
}

function serializeDashboardSavedView(view = {}) {
  return {
    id: cleanText(view.id || view._id, 80),
    scope: cleanText(view.scope, 80),
    name: cleanText(view.name, MAX_VIEW_NAME_LENGTH),
    filters: normalizeDashboardViewFilters(cleanText(view.scope, 80), view.filters || {}),
    createdAt: view.createdAt || null,
    updatedAt: view.updatedAt || null,
  };
}

module.exports = {
  DASHBOARD_VIEW_SCOPES,
  MAX_VIEWS_PER_SCOPE,
  DashboardSavedViewError,
  normalizeDashboardSavedView,
  normalizeDashboardViewFilters,
  serializeDashboardSavedView,
};
