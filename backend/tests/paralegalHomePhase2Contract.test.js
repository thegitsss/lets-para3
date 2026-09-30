const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("paralegal Home Phase 2 ownership contract", () => {
  const html = read("frontend/dashboard-paralegal.html");
  const script = read("frontend/assets/scripts/paralegal-dashboard.js");

  test("removes the proven-dead legacy Home controls and template", () => {
    for (const obsolete of ["messageBox", "earnedThisMonthCard", "earningsToggle", "assignmentCardTemplate"]) {
      expect(html).not.toContain(`id="${obsolete}"`);
      expect(script).not.toContain(`getElementById('${obsolete}')`);
    }
    expect(script).not.toMatch(/lpc-earnings-mode|function toggleEarningsMode|function renderEarningsDisplay/);
  });

  test("the Home module is the only owner of the dashboard endpoint", () => {
    expect(html).not.toContain('/api/paralegal/dashboard');
    expect(script.match(/["']\/api\/paralegal\/dashboard/g)).toHaveLength(1);
    expect(script).toMatch(/notifyCasesApplicationsRefresh\('initial',[\s\S]*activeCases: snapshot\.activeCases/);
    expect(html).toMatch(/lpc:paralegal-dashboard-request-refresh/);
  });

  test("initial and refresh paths share one normalized snapshot renderer", () => {
    expect(script).toMatch(/function buildDashboardSnapshot/);
    expect(script).toMatch(/function renderDashboardSnapshot/);
    expect(script.match(/renderDashboardSnapshot\(/g)).toHaveLength(3);
    expect(script).toMatch(/const recommendationRequest = loadRecommendedMatters\(\)/);
    expect(script).toContain("readOwnedHome('recommendations', options => fetchJson('/api/jobs/recommended', options))");
    expect(script).not.toMatch(/applyRoleVisibility\(user\);\s*updateProfile\(user/);
  });

  test("dashboard refreshes coalesce while account changes and newer application reads invalidate stale work", () => {
    const dashboard = script.slice(script.indexOf('async function refreshDashboardFromServer('), script.indexOf('function setupDashboardAutoRefresh('));
    expect(dashboard).toMatch(/if \(dashboardRefreshInFlight\) \{\s*dashboardRefreshQueuedReason = reason \|\| 'queued';\s*return;/);
    expect(dashboard.indexOf('if (dashboardRefreshInFlight)')).toBeLessThan(dashboard.indexOf('const generation = ++dashboardRefreshGeneration;'));
    expect(dashboard).toMatch(/if \(generation !== dashboardRefreshGeneration\) return;/);
    expect(dashboard).toContain("queueMicrotask(() => refreshDashboardFromServer(queuedReason, { force: true }))");
    expect(script).toContain('homeAccountLost = true; ++dashboardRefreshGeneration; ++deskEnrichmentGeneration; ++applicationRefreshGeneration;');
    const applications = script.slice(script.indexOf('async function loadAppliedJobs('), script.indexOf('async function loadAppliedJobs(') + 1800);
    expect(applications).toContain('const generation = ++applicationRefreshGeneration;');
    expect(applications).toContain("await readOwnedHome('applications', options => fetchJson('/api/applications/my', options))");
    expect(applications.indexOf('if (generation !== applicationRefreshGeneration) return;')).toBeLessThan(applications.indexOf("homeApplicationsPhase = 'ready'"));
  });
});
