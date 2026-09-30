const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Paralegal V2 Home contract", () => {
  test("Home is a real view inside the persistent shell", () => {
    const html = read("frontend/paralegal-v2.html");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    expect(html).toMatch(/paralegal-v2-home\.css/);
    expect(app).toMatch(/createHomeView/);
    expect(app).toMatch(/route\.name === "home"/);
    expect(app).toMatch(/homeView\.render/);
    expect(app).not.toMatch(/location\.(?:assign|replace)\([^)]*home/);
  });

  test("Home reads every existing authoritative projection without replacing backend eligibility", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/home-view.mjs");
    const model = read("frontend/assets/scripts/paralegal-v2/home-model.mjs");
    expect(source).toContain('api.get(`/api/paralegal/dashboard?expectedOwnerId=${encodeURIComponent(userId)}`, requestOptions)');
    expect(source).toContain("loadReceivedInvitations(api, userId,");
    expect(read("frontend/assets/scripts/utils/received-invitations.mjs")).toContain("/api/cases/invited-to");
    const expectedPaths = ["/api/users/me", "/api/payments/connect/status", "/api/jobs/recommended", "/api/messages/threads?limit=50", "/api/messages/unread-count", "/api/applications/my"];
    expectedPaths.forEach(endpoint => expect(source).toContain(`api.get("${endpoint}", requestOptions)`));
    expect(source).toContain("loadHomeDeadlines(api, ownerId, range");
    expect(read("frontend/assets/scripts/paralegal-v2/home-deadlines.mjs")).toContain("/api/events?");
    expect(source).toMatch(/requestOptions\s*=\s*\{\s*signal:/);
    expect(source).not.toMatch(/function\s+(?:matchesRecommendation|recommendationEligible)/);
    // Explicitly selected, authorized scope is permitted by the Linear contract.
    expect(source).toContain('loadMatter: (id, signal)');
    const contextual = fs.readFileSync(path.join(__dirname, '../../frontend/assets/scripts/paralegal-v2/home-workspace-view.mjs'), 'utf8');
    expect(contextual).toContain("row.workspaceReady && (row.type==='matter'||row.kind==='scope')");
    expect(source).not.toMatch(/api\.(?:post|patch)\([^\n]*(?:read|apply|respond-invite|withdraw)/);
    expect(source).toMatch(/import\s*\{[^}]*buildHomeModel[^}]*\}\s*from\s*"\.\/home-model\.mjs"/);
    expect(model).not.toMatch(/\b(?:api|fetch|window|document)\./);
  });

  test("Home data is cached and route changes keep the current view until one atomic commit", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/home-view.mjs");
    const app = read("frontend/assets/scripts/paralegal-v2/app.mjs");
    expect(source).toMatch(/Promise\.allSettled/);
    expect(source).toMatch(/HOME_CACHE_TTL_MS/);
    expect(source).toMatch(/if \(!valid\(\) \|\| revision !== cacheRevision\) return/);
    expect(source.indexOf("let cachedSnapshot")).toBeGreaterThan(source.indexOf("export function createHomeView"));
    expect(source).toMatch(/currentUser !== userId/);
    expect(source).toMatch(/session === sessionRevision && userId === key\(\)/);
    expect(source).toMatch(/revision === cacheRevision/);
    expect(source).toMatch(/controller\?\.abort\(\)/);
    expect(source).toMatch(/if \(editing \|\| \(!explicit && !explicitRefresh && interacting\(\)\)\)/);
    expect(source).toMatch(/const editing =[^;]*dialog\[open\][^;]*input,select,textarea/);
    expect(source).toMatch(/clearProtected\(\)/);
    expect(app).not.toMatch(/outlet\.replaceChildren\(homeView\.createLoadingView\(\)\)/);
    expect(app).not.toMatch(/outlet\.replaceChildren\((?:browseView|workView|settingsView)\.createLoadingView\(\)\)/);
    expect(app).toMatch(/outlet\.replaceChildren\(view\)/);
    expect(app.indexOf("view = await homeView.render")) .toBeLessThan(app.indexOf("outlet.replaceChildren(view)"));
    expect(app.indexOf("await establishSession()")) .toBeLessThan(app.indexOf("await router.start()"));
  });

  test("Home preserves the approved state-adaptive content and language", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/home-view.mjs");
    const model = read("frontend/assets/scripts/paralegal-v2/home-model.mjs");
    const requiredCopy = [
      "Active work",
      "Opportunities",
      "No deadlines in the available schedule.",
      "No unread messages.",
      "Recommended",
      "No matters to show right now.",
      "No applications in progress",
      "Payouts & history",
    ];
    requiredCopy.forEach((copy) => expect(source).toContain(copy));
    expect(model).toContain('href: "/work?section=invitations"');
    expect(source).toContain('"/work?section=applications"');
    expect(source + model).not.toMatch(/\/work\?tab=(?:applications|invitations)/);
    expect(model).toContain("Add a profile photo before applying");
    expect(model).toContain("Payout setup is required before applying or accepting an invitation.");
    expect(source).toMatch(/model\.readiness\.items/);
    expect(source).toMatch(/model\.attention\.(?:complete === false|state === "partial")/);
    expect(source).not.toContain("Welcome,");
    expect(source).not.toContain("Private office");
    expect(source).not.toContain("Your worktable");
    expect(source).not.toContain("You’re up to date.");
  });

  test("recommendations remain opportunities with contextual previews and never become assigned work", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/home-view.mjs");
    const model = read("frontend/assets/scripts/paralegal-v2/home-model.mjs");
    expect(source).toMatch(/function opportunities\(model,/);
    expect(source).toMatch(/model\.opportunities\[key\]/);
    expect(source).toMatch(/model\.activeWork\.slice/);
    expect(source).not.toMatch(/activeWork\([^)]*recommendation/);
    expect(model).toMatch(/const activeWork = activeRows\(sources\.dashboard\.value,/);
    expect(source).toContain("Accepting an invitation does not start an active matter.");
    expect(source).toContain("Review the full scope and application requirements in Browse Matters.");
    expect(source).toMatch(/row\.description \|\| row\.detail/);
    expect(source).toContain("Posted compensation");
    expect(source).toMatch(/trigger\.focus\(\{ preventScroll: true \}\)/);
  });

  test("availability uses the shared mutation boundary and does not reload the document", () => {
    const source = read("frontend/assets/scripts/paralegal-v2/home-view.mjs");
    expect(source).toMatch(/saveAvailability\(api,/);
    const writer = read("frontend/assets/scripts/utils/availability-save.mjs");
    expect(writer).toContain("api.post('/api/paralegals/update-availability'");
    expect(writer).toContain('expectedOwnerId: ownerId');
    expect(source).toMatch(/dialog\.showModal\(\)/);
    expect(source).toMatch(/if \(pending \|\| !isValid\(\) \|\| !form\.reportValidity\(\)\)/);
    expect(source).toMatch(/save\.disabled = true/);
    expect(writer).toContain('receipt?.ownerId !== ownerId');
    expect(source).toMatch(/if \(!isValid\(\)\) \{ dialog\.close\(\); return; \}/);
    expect(source).toMatch(/aria-labelledby/);
    expect(source).toMatch(/role: "alert"/);
    expect(source).not.toMatch(/window\.location|location\.reload/);
  });

  test("the authenticated entry keeps the active cascade and responsive hidden-state safeguards", () => {
    const html = read("frontend/paralegal-v2.html");
    const source = read("frontend/assets/styles/paralegal-original-workspace.css");
    const shell = read("frontend/assets/styles/paralegal-original-shell.css");
    const base = read("frontend/assets/styles/paralegal-v2.css");
    const stylesheets = [...html.matchAll(/<link\s+[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => match[1].split("?")[0]);
    const ordered = ["paralegal-v2.css", "paralegal-original-workspace.css", "paralegal-original-shell.css", "paralegal-consistency.css", "paralegal-financials.css"].map(name => stylesheets.indexOf("assets/styles/" + name));
    expect(ordered.every(index => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(new Set(stylesheets).size).toBe(stylesheets.length);
    expect(html).not.toMatch(/paralegal-(?:v2-desk|v2-polish|linear-home|linear-shell|workspace-contract)\.css/);
    expect(source).toMatch(/\.ph-home\.v2-home[^}]*font:[^}]*var\(--v2-font-sans\)/);
    expect(base).toMatch(/--v2-font-sans:[^;]*Sarabun/);
    expect(source).toMatch(/@container work-records/);
    expect(source).toMatch(/@media\s*\(max-width:\s*900px\)/);
    expect(source).toMatch(/:focus-visible[^}]*outline:\s*2px solid/);
    expect(source + shell).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(source).toMatch(/forced-colors:\s*active/);
    expect(source).not.toMatch(/forced-color-adjust:\s*none/);
    expect(source).toMatch(/\.lc-workspace \[hidden\]\s*\{\s*display:\s*none/);
  });
});
