const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(read(relativePath));

const artifactPaths = [
  "ATTORNEY_APPLICATION_V2_MIGRATION_AND_V1_RETIREMENT_PLAN.md",
  "docs/attorney-v2/PHASE0_BASELINE.md",
  "docs/attorney-v2/protected-paths.json",
  "docs/attorney-v2/routes.json",
  "docs/attorney-v2/api-dependencies.json",
  "docs/attorney-v2/lifecycle-fixtures.json",
  "docs/attorney-v2/DEFECT_REGISTER.md",
  "docs/attorney-v2/TEST_TRACEABILITY.md",
  "docs/attorney-v2/V1_CHARACTERIZATION_EVIDENCE.md",
  "docs/attorney-v2/V1_BROWSER_BASELINE.md",
  "backend/tests/attorneyV2Phase0AuditContract.test.js",
];

describe("Attorney V2 Phase 0 audit contract", () => {
  test.each(artifactPaths)("ships the Phase 0 artifact %s", (relativePath) => {
    expect(fs.existsSync(path.join(root, relativePath))).toBe(true);
  });

  test("pins the observed baseline and expressly withholds implementation authority", () => {
    const baseline = read("docs/attorney-v2/PHASE0_BASELINE.md");
    expect(baseline).toContain("dashboard-redesign");
    expect(baseline).toContain("6cecc07a72a74d4bffd9cd5fa061f738db29d00c");
    expect(baseline).toContain("Pre-existing worktree entries before Attorney Phase 0: `289`");
    expect(baseline).toMatch(/does not authorize:[\s\S]*Attorney V2 entry/);
    expect(baseline).toMatch(/Production or live Stripe access: none/);
    expect(baseline).toMatch(/local ephemeral in-memory MongoDB fixtures/);
  });

  test("keeps Phase 0 ownership disjoint from protected paralegal and shared runtime files", () => {
    const policy = readJson("docs/attorney-v2/protected-paths.json");
    expect(policy.defaultPolicy).toBe("deny-runtime-edits");
    expect(policy.phase0OwnedPaths).toEqual(expect.arrayContaining(artifactPaths.filter((item) => item !== "backend/tests/attorneyV2Phase0AuditContract.test.js")));
    expect(policy.phase0OwnedPaths).toContain("backend/tests/attorneyV2Phase0AuditContract.test.js");
    expect(policy.neverModifyForAttorneyV2).toEqual(expect.arrayContaining([
      "frontend/paralegal-v2.html",
      "frontend/assets/scripts/paralegal-v2/**",
      "frontend/assets/styles/paralegal-v2*.css",
    ]));
    expect(policy.sharedRuntimeRequiresSeparateApproval).toEqual(expect.arrayContaining([
      "backend/routes/**",
      "backend/services/**",
      "frontend/assets/scripts/utils/**",
      "frontend/case-detail.html",
      "frontend/profile-settings.html",
    ]));

    const exactProtected = new Set([
      ...policy.neverModifyForAttorneyV2,
      ...policy.sharedRuntimeRequiresSeparateApproval,
      ...policy.attorneyV1ReadOnlyDuringPhase0,
    ]);
    for (const owned of policy.phase0OwnedPaths) {
      expect(exactProtected.has(owned)).toBe(false);
    }
  });

  test("inventories every known attorney V1 entry and retirement treatment", () => {
    const ledger = readJson("docs/attorney-v2/routes.json");
    const ids = ledger.routes.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      "attorney-home",
      "attorney-matters",
      "attorney-private-tasks",
      "attorney-payments",
      "attorney-create-matter",
      "attorney-applications-redirect",
      "attorney-workspace",
      "attorney-paralegal-directory",
      "attorney-candidate-profile",
      "attorney-profile",
      "attorney-settings-directory",
      "attorney-settings-profile",
      "attorney-settings-security",
      "attorney-settings-preferences",
      "attorney-help",
      "attorney-auth-return",
      "attorney-supporting-public-content",
    ]));
    for (const route of ledger.routes) {
      expect(route.v1).toBeTruthy();
      expect(route.authentication).toBeTruthy();
      expect(route.responsibility).toBeTruthy();
      expect(route.v2Responsibility).toBeTruthy();
      expect(route.retirement).toBeTruthy();
      expect(Array.isArray(route.queryParameters)).toBe(true);
      expect(Array.isArray(route.hashValues)).toBe(true);
    }
    expect(ledger.canonicalV2Prefix).toBeNull();
    expect(ledger.canonicalV2PrefixDecision).toBe("owner-open");
  });

  test("preserves compatibility route state instead of prematurely normalizing it", () => {
    const { routes, compatibilityNotes } = readJson("docs/attorney-v2/routes.json");
    const params = new Set(routes.flatMap((route) => route.queryParameters));
    for (const key of [
      "openApplicant",
      "openApplicants",
      "returnFromProfile",
      "continueHire",
      "draftId",
      "caseId",
      "applicantId",
      "fileId",
      "messageId",
      "tab",
      "panel",
      "returnTo",
      "payment",
      "settingsTarget",
      "matterDeadline",
      "matterUpdated",
      "matterSort",
      "matterPractice",
    ]) {
      expect(params.has(key)).toBe(true);
    }
    expect(compatibilityNotes.join(" ")).toMatch(/openApplicant and openApplicants/);
    expect(compatibilityNotes.join(" ")).toMatch(/same-origin and allowlisted/);
  });

  test("records endpoint method, purpose, safety, errors, guards and characterization", () => {
    const ledger = readJson("docs/attorney-v2/api-dependencies.json");
    const familyIds = ledger.families.map((family) => family.id);
    expect(new Set(familyIds).size).toBe(familyIds.length);
    expect(familyIds).toEqual(expect.arrayContaining([
      "session",
      "attorney-dashboard",
      "current-user",
      "account-security-preferences",
      "case-drafts",
      "cases-lifecycle-workspace",
      "applications",
      "messages",
      "files",
      "payments",
      "private-checklist",
      "events-deadlines",
      "notifications",
      "blocks",
      "disputes",
      "assistant-support",
      "candidate-presentation",
      "incident-intake",
    ]));

    for (const family of ledger.families) {
      expect(family.guards).toBeTruthy();
      expect(family.consumers.length).toBeGreaterThan(0);
      expect(family.requiredErrors.length).toBeGreaterThan(0);
      expect(family.characterization.length).toBeGreaterThan(0);
      const keys = family.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const endpoint of family.endpoints) {
        expect(["GET", "POST", "PUT", "PATCH", "DELETE"]).toContain(endpoint.method);
        expect(endpoint.path).toMatch(/^\/api\//);
        expect(endpoint.purpose).toBeTruthy();
        expect(typeof endpoint.mutation).toBe("boolean");
        if (endpoint.moneyCritical) expect(endpoint.mutation).toBe(true);
        if (endpoint.csrf === true) expect(endpoint.mutation).toBe(true);
      }
    }
    expect(ledger.rules.retry).toMatch(/never automatically retry/i);
    expect(ledger.rules.money).toMatch(/exact server cents/i);
    expect(ledger.rules.authorization).toMatch(/server response is authoritative/i);
  });

  test("covers critical V1 endpoint dependencies and compatibility layers", () => {
    const ledger = readJson("docs/attorney-v2/api-dependencies.json");
    const endpoints = new Set(ledger.families.flatMap((family) => family.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)));
    for (const endpoint of [
      "GET /api/auth/me",
      "GET /api/attorney/dashboard",
      "POST /api/cases",
      "GET /api/cases/my",
      "POST /api/cases/:caseId/hire/:paralegalId",
      "POST /api/cases/:caseId/complete",
      "POST /api/cases/:caseId/partial-payout",
      "POST /api/disputes/:caseId",
      "GET /api/messages/unread-count",
      "GET /api/uploads/case/:caseId",
      "GET /api/payments/summary",
      "GET /api/payments/escrow/active",
      "GET /api/notifications/stream",
      "GET /api/support/conversation",
      "DELETE /api/account/deactivate",
    ]) {
      expect(endpoints.has(endpoint)).toBe(true);
    }
    expect(ledger.knownCompatibilityDependencies).toEqual(expect.arrayContaining([
      "Case and Job dual records",
      "Application and Case.applicants mirrors",
      "mountain and mountain-dark account preferences",
      "legacy redirects and query/hash parameters",
    ]));
  });

  test("defines synthetic full-lifecycle and cross-role fixtures without production identities", () => {
    const fixtures = readJson("docs/attorney-v2/lifecycle-fixtures.json");
    expect(fixtures.dataPolicy.productionData).toBe(false);
    expect(fixtures.dataPolicy.stripe).toMatch(/live keys forbidden/);
    for (const persona of fixtures.personas) {
      expect(persona.email).toMatch(/\.test$/);
    }
    expect(fixtures.fixtureAxes.caseStatus).toEqual(["open", "in progress", "in_progress", "paused", "completed", "disputed", "closed"]);
    expect(fixtures.fixtureAxes.applicationStatus).toEqual(["submitted", "viewed", "shortlisted", "accepted", "rejected", "withdrawn"]);
    expect(fixtures.fixtureAxes.fileSecurityStatus).toEqual(["pending", "clean", "blocked", "error", "not_required"]);

    const scenarioIds = fixtures.scenarios.map((scenario) => scenario.id);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    expect(scenarioIds).toEqual(expect.arrayContaining([
      "S00-access-boundary",
      "S02-draft-publish",
      "S04-application-review",
      "S07-hire-and-fund",
      "S08-active-workspace",
      "S09-messages",
      "S10-files",
      "S11-tasks-deadlines",
      "S12-completion",
      "S13-withdrawal-and-relist",
      "S14-dispute",
      "S15-payment-integrity",
      "S17-global-tools",
      "S18-mixed-version-rollback",
    ]));
    for (const scenario of fixtures.scenarios) {
      expect(scenario.actors.length).toBeGreaterThan(0);
      expect(scenario.events.length).toBeGreaterThan(0);
      expect(scenario.assert.length).toBeGreaterThan(0);
    }
  });

  test("keeps defects separate from design and records owner gates", () => {
    const register = read("docs/attorney-v2/DEFECT_REGISTER.md");
    for (let id = 1; id <= 23; id += 1) {
      expect(register).toContain(`A-${String(id).padStart(2, "0")}`);
    }
    expect(register).toMatch(/No item authorizes a fix or redesign/);
    expect(register).toMatch(/Security, authorization, privacy, or money defects are stop-ship/);
    expect(register).toMatch(/Required owner\/evidence/);
    expect(register).toMatch(/Blocks/);
  });

  test("defines the complete test disciplines and keeps Phase 1 separately gated", () => {
    const plan = read("ATTORNEY_APPLICATION_V2_MIGRATION_AND_V1_RETIREMENT_PLAN.md");
    const traceability = read("docs/attorney-v2/TEST_TRACEABILITY.md");
    for (const discipline of [
      "Characterization and contract",
      "Lifecycle and concurrency",
      "Money integrity",
      "Authorization, privacy, and security",
      "Accessibility",
      "Responsive and input modes",
      "Browser and platform",
      "Performance and reliability",
      "Cross-role and operational",
    ]) {
      expect(plan).toContain(discipline);
    }
    expect(traceability).toMatch(/Blocking owner decisions before Phase 1/);
    expect(traceability).toMatch(/Owner reviews Phase 0 and separately authorizes or declines Phase 1/);
    expect(traceability).toMatch(/WCAG 2\.2 AA/);
    expect(traceability).toMatch(/320, 360, 390, 768, 1024, 1366, 1440, and 1920/);
  });

  test("records executable synthetic V1 lifecycle and cross-role evidence", () => {
    const evidence = read("docs/attorney-v2/V1_CHARACTERIZATION_EVIDENCE.md");
    expect(evidence).toMatch(/12 passed \/ 12 total/);
    expect(evidence).toMatch(/125 passed \/ 125 total/);
    expect(evidence).toMatch(/local ephemeral in-memory MongoDB records/);
    expect(evidence).toMatch(/Production access: none/);
    for (const suite of [
      "phase2Lifecycle.test.js",
      "phase3AccessLoss.test.js",
      "permissionsAcl.test.js",
      "messagingNotifications.test.js",
      "paymentsPayouts.test.js",
      "disputesRefunds.test.js",
      "uploadsDownloads.test.js",
      "profileSettingsRegression.test.js",
      "authenticatedSearch.test.js",
      "notificationPresentation.test.js",
      "lifecycleTransitions.test.js",
      "caseFlowNotifications.test.js",
    ]) {
      expect(evidence).toContain(suite);
    }
    expect(evidence).toMatch(/What this result does not prove/);
    expect(evidence).toMatch(/Browser route\/deep-link characterization/);
  });

  test("records the authenticated three-browser baseline without hiding V1 failures", () => {
    const baseline = read("docs/attorney-v2/V1_BROWSER_BASELINE.md");
    expect(baseline).toMatch(/27 passed, 18 failed, 45 total/);
    expect(baseline).toMatch(/9 passed and 6 failed in each of 3 browsers/);
    expect(baseline).toMatch(/Chromium, Firefox, and WebKit/);
    expect(baseline).toMatch(/V1 is not currently a green browser baseline/);
    expect(baseline).toMatch(/No fix was attempted/);
    expect(baseline).toMatch(/Confirmed stale browser-test contract/);
    expect(baseline).toMatch(/no `#caseTitle`/);
    expect(baseline).toMatch(/body\.support-drawer-pinned > main/);
    for (let id = 18; id <= 23; id += 1) {
      expect(baseline).toContain(`A-${id}`);
    }
  });

  test("is a file-only contract with no runtime, database, network or payment-provider imports", () => {
    const source = read("backend/tests/attorneyV2Phase0AuditContract.test.js");
    const imports = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
    expect(imports).toEqual(["fs", "path"]);
    expect(source).not.toMatch(/^import\s/m);
  });
});
