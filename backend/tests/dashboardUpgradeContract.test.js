const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("attorney and paralegal dashboard upgrade contracts", () => {
  test("saved views are account-persisted and mounted on both dashboard workflows", () => {
    const user = read("backend/models/User.js");
    const account = read("backend/routes/account.js");
    const attorneyHtml = read("frontend/dashboard-attorney.html");
    const attorneyScript = read("frontend/assets/scripts/attorney-tabs.js");
    const paralegalHtml = read("frontend/dashboard-paralegal.html");
    const paralegalScript = read("frontend/assets/scripts/paralegal-dashboard.js");
    expect(user).toMatch(/dashboardViews: \{ type: \[dashboardSavedViewSchema\]/);
    expect(account).toMatch(/"\/dashboard-views"/);
    expect(account).toMatch(/"\/dashboard-views\/:scope\/:viewId"/);
    expect(attorneyHtml).toMatch(/data-matter-saved-view/);
    expect(attorneyScript).toMatch(/mountAttorneySavedViews/);
    expect(read("frontend/assets/scripts/attorney-v2/saved-view-model.mjs")).toMatch(/VIEW_SCOPE = "attorney_matters"/);
    expect(paralegalHtml).toMatch(/data-application-saved-view/);
    expect(paralegalScript).toMatch(/scope: 'paralegal_applications'/);
  });

  test("both dashboards consume the scoped semantic token layer", () => {
    const tokens = read("frontend/assets/styles/dashboard-system.css");
    const attorneyHtml = read("frontend/dashboard-attorney.html");
    const paralegalHtml = read("frontend/dashboard-paralegal.html");
    expect(tokens).toMatch(/--lpc-surface-canvas/);
    expect(tokens).toMatch(/--lpc-text-primary/);
    expect(tokens).toMatch(/--lpc-control-height/);
    expect(attorneyHtml).toMatch(/assets\/styles\/dashboard-system\.css/);
    expect(paralegalHtml).toMatch(/assets\/styles\/dashboard-system\.css/);
  });

  test("Matter previews, deep relationships, and contextual AI are shared across dashboards", () => {
    const panel = read("frontend/assets/scripts/context-panel.js");
    const search = read("frontend/assets/scripts/global-search.js");
    const attorney = read("frontend/assets/scripts/attorney-tabs.js");
    const paralegal = read("frontend/assets/scripts/paralegal-dashboard.js");
    expect(panel).toMatch(/register\("matter"/);
    expect(panel).toMatch(/AI Matter briefing/);
    expect(panel).toMatch(/openMatter/);
    expect(search).toMatch(/data-search-object-type="matter"/);
    expect(attorney).toMatch(/LPCContextPanel\?\.openMatter/);
    expect(paralegal).toMatch(/LPCContextPanel\?\.openMatter/);
  });

  test("paralegal dashboard exposes the private-office worktable and authorized activity inbox", () => {
    const html = read("frontend/dashboard-paralegal.html");
    const script = read("frontend/assets/scripts/paralegal-dashboard.js");
    expect(html).toMatch(/id="paralegalPriorityQueue"/);
    expect(html).toMatch(/id="paralegalPriorityTitle">Office inbox/);
    expect(html).toMatch(/id="homeWorkSection"/);
    expect(html).toMatch(/On your desk/);
    expect(html).toMatch(/id="deadlineList"/);
    expect(html).toMatch(/id="recommendedMattersList"/);
    expect(html).toMatch(/id="homeApplicationPipeline"/);
    expect(html).toMatch(/id="recommendedMattersTitle">Matters to explore/);
    expect(html).not.toMatch(/id="privateOfficeDate"/);
    expect(script).toContain("renderCalendar");
    expect(read("frontend/assets/scripts/legacy-paralegal-calendar.mjs")).toContain("No deadlines or reminders this week.");
    expect(script).toContain("No requests or unread messages.");
    expect(script).toMatch(/No matters to show right now\./);
    expect(script).toMatch(/No applications in progress/);
    expect(script).toMatch(/Required before applying to Matters or receiving payment\./);
    expect(html).toMatch(/data-paralegal-priority-count aria-live="polite"/);
    expect(html).toMatch(/data-paralegal-priority-list aria-live="polite"/);
    expect(script).toMatch(/function renderParalegalPriorityQueue/);
    expect(script).toContain("Pre-engagement information requested");
    expect(script).toMatch(/function renderPrivateOfficeDesk/);
    expect(script).toMatch(/assignmentReviewState/);
  });
});
