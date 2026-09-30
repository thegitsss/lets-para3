const {
  DashboardSavedViewError,
  normalizeDashboardSavedView,
  normalizeDashboardViewFilters,
} = require("../services/dashboardSavedViews");

describe("dashboard saved views", () => {
  test("normalizes attorney Matter view filters to registered values", () => {
    expect(normalizeDashboardViewFilters("attorney_matters", {
      view: "ARCHIVED",
      search: "  probate   filing  ",
      practice: "Probate",
      deadline: "overdue",
      updated: "not-registered",
      sort: "deadline",
      ignored: "private evidence",
    })).toEqual({
      view: "archived",
      search: "probate filing",
      practice: "Probate",
      deadline: "overdue",
      updated: "",
      sort: "deadline",
      archiveStatus: "all",
    });
  });

  test("normalizes paralegal application views without accepting unknown keys", () => {
    expect(normalizeDashboardViewFilters("paralegal_applications", {
      search: "employment",
      status: "submitted",
      practice: "Employment",
      dateRange: "30",
      sort: "matter",
      secret: "discarded",
    })).toEqual({
      search: "employment",
      status: "submitted",
      practice: "Employment",
      dateRange: "30",
      sort: "matter",
    });
  });

  test("requires a registered scope and a non-empty name", () => {
    expect(() => normalizeDashboardSavedView({ scope: "admin", name: "Anything" }))
      .toThrow(DashboardSavedViewError);
    expect(() => normalizeDashboardSavedView({ scope: "attorney_matters", name: "" }))
      .toThrow("dashboard_view_name_required");
  });
});
