const path = require("node:path");

// Current read contracts shared by the isolated legacy-workspace E2E fixtures.
// Scenario-specific reads and mutations remain in each script.
function installWorkspaceReads(app, getUser, getCases = () => []) {
  for (const [url, file] of [
    ["/assets/vendor/simplewebauthn-13.3.0.js", "@simplewebauthn/browser/dist/bundle/index.umd.min.js"],
    ["/assets/vendor/web-vitals-6.1.1.js", "web-vitals/dist/web-vitals.js"],
  ]) app.get(url, (_req, res) => res.type("application/javascript").sendFile(path.resolve(__dirname, "../node_modules", file)));

  const owned = read => (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    return read(req, res, user);
  };
  app.get("/api/auth/workspace-release", owned((_req, res, user) => res.json({ workspace: {
    schemaVersion: 1, ownerId: user.id || user._id, role: user.role, revision: 0,
    version: "legacy", defaultDestination: `/dashboard-${user.role}.html`,
  } })));
  app.get("/api/payments/attorney-financial-history", owned((req, res, user) => res.json({
    ownerId: user.id || user._id, revision: "b".repeat(64), view: req.query.view || "all",
    q: req.query.q || "", caseId: req.query.caseId || null, total: 0, entries: [], nextCursor: null,
    summary: { currencies: [], requiresReview: 0, pending: 0, undated: 0 },
  })));
  app.get("/api/cases/inventory/home", owned((req, res, user) => {
    const cases = getCases(req).filter(item => !item.archived && item.status !== "completed");
    const items = cases.map(item => ({ id: item.id || item._id, title: item.title, practiceArea: item.practiceArea, label: "In Progress" }));
    return res.json({
      ownerId: user.id || user._id, revision: "a".repeat(64),
      counts: { active: cases.length, applications: 0, draft: 0, archived: 0 }, postedCount: cases.length,
      recent: { total: items.length, items: items.slice(0, 5) }, completed: { total: 0, items: [] },
      attention: { total: 0, items: [], page: 1, pageSize: 5, pages: 1 },
      week: { start: "2026-09-14", end: "2026-09-20", total: 0, items: [], page: 1, pageSize: 3, pages: 1 },
    });
  }));
}

module.exports = { installWorkspaceReads };
