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
    expect(attorneyScript).toMatch(/scope: "attorney_matters"/);
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

  test("paralegal dashboard exposes a derived next-step queue", () => {
    const html = read("frontend/dashboard-paralegal.html");
    const script = read("frontend/assets/scripts/paralegal-dashboard.js");
    expect(html).toMatch(/id="paralegalPriorityQueue"/);
    expect(html).toMatch(/Prioritized from your current Matters, applications, messages, and payout readiness/);
    expect(script).toMatch(/function renderParalegalPriorityQueue/);
    expect(script).toMatch(/Pre-engagement information required/);
    expect(script).toMatch(/Complete payout setup/);
  });
});
