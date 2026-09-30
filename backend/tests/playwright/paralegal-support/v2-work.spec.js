const { receivedInvitations } = require("./received-invitation-fixture");
const { installNotificationReads } = require("./notification-fixtures");
const financial = require("./financial-fixtures");
const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const ACTIVE_CASE_ID = "64b000000000000000001001";
const INVITE_CASE_ID = "64b000000000000000001002";
const APPLICATION_ID = "64b000000000000000001101";
const APPLICATION_JOB_ID = "64b000000000000000001201";
const PRE_CASE_ID = "64b000000000000000001003";
const HISTORY_CASE_ID = "64b000000000000000001004";

for (const status of ['withdrawn', 'rejected']) test(`current ${status} application date filter changed during an unchanged refresh is applied`, async ({ page }, info) => {
  const state = await installWorkProjection(page);
  state.applications = [{ ...state.applications[0], status, preEngagement: null, createdAt: '2020-01-01T00:00:00.000Z' }];
  await page.goto('/dashboard-paralegal.html#cases');
  await expect(page.locator(`#appliedStatusFilter option[value="${status}"]`)).toHaveCount(1);
  await page.getByRole('button', { name: 'Show application filters', exact: true }).click();
  await page.locator('#appliedDateFilter').selectOption('3');
  await expect(page.locator('#appliedJobsList')).toContainText('No matching applications');
  let release, arrived, reads = 0;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route('**/api/applications/my', async route => { reads++; arrived(); await gate; return json(route, state.applications); });
  const evidence = [];
  const observe = async label => evidence.push({ label, reads, ...await page.evaluate(() => ({ range: document.querySelector('#appliedDateFilter')?.value, status: document.querySelector('#appliedStatusFilter')?.value, practice: document.querySelector('#appliedPracticeFilter')?.value, query: document.querySelector('#appliedSearch')?.value, rows: document.querySelectorAll('.applied-card').length, text: document.querySelector('#appliedJobsList')?.textContent })) });
  try {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:paralegal-dashboard-request-refresh', { detail: { reason: 'synthetic-filter-race' } })));
    await waiting;
    await observe('refresh-pending');
    await page.locator('#appliedDateFilter').selectOption('all');
    await observe('filter-changed-during-refresh');
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/applications/my');
    release(); await response;
    await expect(page.locator('.applied-card')).toContainText(status === 'withdrawn' ? 'Withdrawn' : 'Not selected');
  } finally {
    release(); await observe('final');
    await require('node:fs/promises').writeFile(info.outputPath('application-filter-refresh-evidence.json'), JSON.stringify(evidence, null, 2));
  }
});

for (const entry of ['current', 'v2']) for (const status of ['withdrawn', 'rejected']) test(`${entry} ${status} application history has no redundant withdrawal action`, async ({ page }, info) => {
  const state = await installWorkProjection(page); state.applications = [{ ...state.applications[0], status, preEngagement: null }];
  await page.goto(entry === 'current' ? `/dashboard-paralegal.html?applicationId=${APPLICATION_ID}#cases` : `/paralegal-v2.html#/work?applicationId=${APPLICATION_ID}`);
  if (entry === 'v2') await waitForWork(page);
  const dialog = entry === 'current' ? page.locator('#applicationDetailModal') : page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText(status === 'withdrawn' ? 'Withdrawn' : 'Not selected');
  await expect(dialog).toContainText('I can complete the requested litigation review on schedule.');
  await expect(dialog.getByRole('button', { name: 'Withdraw application', exact: true })).toBeHidden();
  if (entry === 'current') {
    await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
    await page.getByRole('button', { name: 'Show application filters', exact: true }).click();
    await page.locator('#appliedDateFilter').selectOption('all');
    await expect(page.locator('.applied-card')).toContainText(status === 'withdrawn' ? 'Withdrawn' : 'Not selected');
    await expect(page.locator(`#appliedStatusFilter option[value="${status}"]`)).toHaveCount(1);
    await page.locator('.applied-card [data-application-view]').click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
    for (const [width, dark] of [[1366, false], [320, true]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(dark => window.applyThemePreference(dark ? 'dark' : 'light'), dark);
      const card = page.locator('.applied-card'); await card.scrollIntoViewIfNeeded();
      expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      if (width === 320) {
        const facts = await card.locator('.case-header > div').first().boundingBox();
        const action = await card.locator('.case-actions').boundingBox();
        expect(action.y).toBeGreaterThanOrEqual(facts.y + facts.height);
      }
      expect((await new AxeBuilder({ page }).include('.applied-card').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`current-${status}-history-${width}.png`) });
    }
  }
});

test("application outcome deep link opens retained scope after the listing closes", async ({ page }) => {
  await installWorkProjection(page, { applications: [{
    _id: APPLICATION_ID, caseId: PRE_CASE_ID, status: "withdrawn", createdAt: "2026-08-30T14:00:00Z", coverLetter: "Original submitted message",
    jobId: { _id: APPLICATION_JOB_ID, caseId: PRE_CASE_ID, title: "Closed opportunity", description: "Current listing changed", status: "closed", budget: 900 },
    scopeSnapshot: { title: "Original opportunity", description: "Original agreed scope", tasks: ["Prepare chronology"], totalAmount: 90000, currency: "usd", capturedAt: "2026-08-30T14:00:00Z" },
  }] });
  await page.goto(`/paralegal-v2.html#/work?applicationId=${APPLICATION_ID}`);
  await waitForWork(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Original submitted message");
  await dialog.getByRole("button", { name: "Matter details", exact: true }).click();
  await expect(dialog).toContainText("Original agreed scope");
  await expect(dialog).toContainText("Prepare chronology");
  await expect(dialog.getByRole("button", { name: "Withdraw application" })).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`applicationId=${APPLICATION_ID}`));
});

async function json(route, payload, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

async function installWorkProjection(page, state = {}) {
  state.payoutStatus = state.payoutStatus || { readiness: { ready: true, evidenceState: "verified" } };
  state.invites = state.invites || [{
    _id: INVITE_CASE_ID,
    caseId: INVITE_CASE_ID,
    title: "Probate inventory support",
    practiceArea: "Probate",
    briefSummary: "Prepare the asset inventory and flag incomplete source records.",
    totalAmount: 80000,
    currency: "usd",
    inviteInvitedAt: "2026-09-01T14:00:00.000Z",
    attorney: { firstName: "Avery", lastName: "Counsel" },
  }];
  state.applications = state.applications || [{
    _id: APPLICATION_ID,
    caseId: PRE_CASE_ID,
    status: "shortlisted",
    createdAt: "2026-08-30T14:00:00.000Z",
    coverLetter: "I can complete the requested litigation review on schedule.",
    caseEscrowStatus: "pending",
    jobId: {
      _id: APPLICATION_JOB_ID,
      caseId: PRE_CASE_ID,
      title: "Discovery chronology review",
      practiceArea: "Civil Litigation",
      description: "Build a verified chronology from discovery records.",
      budget: 900,
      status: "open",
    },
    preEngagement: {
      revision: 7,
      status: "requested",
      requestedParalegalId: "64b000000000000000000001",
      confidentialityAgreementRequired: true,
      conflictsCheckRequired: true,
      conflictsDetails: "Check the listed parties against your current matters.",
      confidentialityDocument: { key: "safe/key.pdf", name: "Confidentiality agreement.pdf" },
      requestedAt: "2026-09-01T17:00:00.000Z",
    },
  }, {
    _id: "64b000000000000000001102",
    status: "submitted",
    createdAt: "2026-08-29T14:00:00.000Z",
    jobId: { _id: "64b000000000000000001202", title: "Lease abstraction", practiceArea: "Real Estate", budget: 700, status: "open" },
  }, {
    _id: "64b000000000000000001103",
    status: "viewed",
    createdAt: "2026-08-28T14:00:00.000Z",
    jobId: { _id: "64b000000000000000001203", title: "Corporate records audit", practiceArea: "Corporate", budget: 750, status: "open" },
  }, {
    _id: "64b000000000000000001104",
    status: "submitted",
    createdAt: "2026-08-27T14:00:00.000Z",
    jobId: { _id: "64b000000000000000001204", title: "Estate correspondence", practiceArea: "Probate", budget: 650, status: "open" },
  }, {
    _id: "64b000000000000000001105",
    status: "rejected",
    createdAt: "2026-08-26T14:00:00.000Z",
    jobId: { _id: "64b000000000000000001205", title: "Rejected application", practiceArea: "Probate", budget: 650, status: "open" },
  }];
  state.history = state.history || [{
    caseId: HISTORY_CASE_ID,
    title: "Contract review archive",
    attorneyName: "Jordan Lee",
    completedAt: "2026-08-25T14:00:00.000Z",
    paymentAmount: 840,
    receiptAvailable: true,
    currency: "usd",
    isWithdrawn: false,
    blockStatus: { blocked: false, canBlock: true },
  }, {
    caseId: "64b000000000000000001005",
    title: "Withdrawn records project",
    attorneyName: "Morgan Reed",
    completedAt: "2026-08-20T14:00:00.000Z",
    paymentAmount: 0,
    receiptAvailable: false,
    isWithdrawn: true,
    canDispute: true,
    currency: "usd",
    blockStatus: { blocked: false, canBlock: false },
  }];

  await page.route(/\/api\/paralegal\/dashboard(?:\?|$)/, (route) => {
    state.dashboardReads = (state.dashboardReads || 0) + 1;
    return json(route, {
      metrics: { activeCases: 1 },
      activeCases: [{
        caseId: ACTIVE_CASE_ID,
        jobTitle: "Disclosure response preparation",
        practiceArea: "Civil Litigation",
        attorneyName: "Jordan Lee",
        status: "in progress",
        deadlineDate: "2026-09-12",
        tasksTotal: 5,
        tasksRemaining: 2,
        escrowStatus: "funded",
      }],
    });
  });
  await page.route("**/api/applications/my", (route) => json(route, state.applications));
  const viewer = (await (await page.request.get('/api/auth/me')).json()).user;
  await page.route(url => url.pathname === '/api/cases/invited-to', route => json(route, receivedInvitations(String(viewer.id || viewer._id), state.invites, new URL(route.request().url()).searchParams)));
  await page.route(/\/api\/cases\/my-completed(?:\?|$)/, route => { const query = new URL(route.request().url()).searchParams; return json(route, financial.history(query.get("expectedOwnerId"), state.history, query)); });
  await page.route("**/api/payments/connect/status", (route) => json(route, state.payoutStatus));
  state.views ||= [{ id: "saved-litigation", scope: "paralegal_applications", name: "Litigation", filters: { search: "", status: "all", practice: "Civil Litigation", dateRange: "all", sort: "newest" } }];
  await page.route(url => url.pathname === "/api/account/dashboard-views", (route) => json(route, {
    ownerId: String(viewer.id || viewer._id),
    scope: "paralegal_applications",
    views: state.views.map(view => ({ ...view, revision: view.revision || "a".repeat(64) })),
  }));
  return state;
}

async function waitForWork(page) {
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("[data-v2-work]")).toBeVisible();
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
}

test("Work distinguishes unavailable sources from empty inventories and recovers each section", async ({ page }, testInfo) => {
  await installWorkProjection(page);
  const sources = [
    ['Active', 'active', '/api/paralegal/dashboard', 'Disclosure response preparation'],
    ['Applications', 'applications', '/api/applications/my', 'Discovery chronology review'],
    ['History', 'history', '/api/cases/my-completed', 'Contract review archive'],
  ];
  let unavailable = new Set();
  await page.route(url => sources.some(([, , path]) => url.pathname === path) || url.pathname === '/api/cases/invited-to', route => unavailable.has(new URL(route.request().url()).pathname) ? json(route, { error: 'Synthetic unavailable source' }, 503) : route.fallback());
  await page.setViewportSize({ width: 390, height: 1000 });
  for (const [label, section, path, title] of sources) {
    unavailable = new Set([path]);
    await page.goto("about:blank");
    await page.goto(`/paralegal-v2.html#/work?section=${section}`);
    await waitForWork(page);
    if (section === 'history') {
      await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
      await expect(page.locator('.v2-work-index')).toHaveCount(0);
    } else await expect(page.locator('.v2-work-index').getByRole('link', { name: new RegExp(label) }).locator('strong')).toHaveText('—');
    await expect(page.locator('.v2-work-empty.is-error')).toContainText('couldn’t load');
    await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`unavailable-${section}.png`) });
    unavailable.clear();
    await page.locator('.v2-work-empty.is-error').getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    if (section !== 'history') await expect(page.locator('.v2-work-index').getByRole('link', { name: new RegExp(label) }).locator('strong')).not.toHaveText('—');
  }
  unavailable = new Set([...sources.map(([, , path]) => path), '/api/cases/invited-to']);
  await page.goto('about:blank');
  await page.goto('/paralegal-v2.html#/work');
  await expect(page.locator('.v2-work-error')).toContainText('Your work couldn’t load.');
  await expect(page.locator('.v2-work-index')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('unavailable-work.png') });
  unavailable.clear();
  await page.locator('.v2-work-error').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: sources[0][3], exact: true })).toBeVisible();
});

test("Work renders authoritative active, invitation, application, and historical projections", async ({ page }, testInfo) => {
  await installWorkProjection(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/paralegal-v2.html#/work", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  await expect(page.getByRole("heading", { level: 1, name: "My matters & applications" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Disclosure response preparation" })).toBeVisible();
  if (process.env.LPC_DESIGN_REVIEW_DIR) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: require('node:path').join(process.env.LPC_DESIGN_REVIEW_DIR, testInfo.project.name + '-work-light-1440.png') }); }
  await expect(page.getByRole("heading", { name: "Probate inventory support" })).toHaveCount(0);
  await page.locator(".v2-work-index").getByRole("link", { name: /Invitations/ }).click();
  await waitForWork(page);
  await expect(page.getByRole("heading", { name: "Probate inventory support" })).toBeVisible();
  if (process.env.LPC_DESIGN_REVIEW_DIR) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: require('node:path').join(process.env.LPC_DESIGN_REVIEW_DIR, testInfo.project.name + '-work-invitations-light-1440.png') }); }
  await expect(page.getByRole("heading", { name: "Disclosure response preparation" })).toHaveCount(0);
  await page.locator(".v2-work-index").getByRole("link", { name: /Applications/ }).click();
  await waitForWork(page);
  await expect(page.getByRole("heading", { name: "Discovery chronology review" })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
  if (process.env.LPC_DESIGN_REVIEW_DIR) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: require('node:path').join(process.env.LPC_DESIGN_REVIEW_DIR, testInfo.project.name + '-work-applications-light-1440.png') }); }
  await expect(page.getByText("Rejected application")).toHaveCount(0);
  await page.locator(".v2-work-index").getByRole("link", { name: /History/ }).click();
  await waitForWork(page);
  await expect(page.getByRole("heading", { name: "Contract review archive" })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toHaveCount(1);
  await expect(page.locator('.v2-work-index')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Past Matters', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-v2-work]')).not.toContainText('null');
  if (process.env.LPC_DESIGN_REVIEW_DIR) { await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: require('node:path').join(process.env.LPC_DESIGN_REVIEW_DIR, testInfo.project.name + '-work-history-light-1440.png') }); }
  await expect(page.locator(`[data-work-history-id="${HISTORY_CASE_ID}"]`).getByRole("button", { name: "Download receipt", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Request LPC review" })).toBeVisible();

  const violations = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations.violations).toEqual([]);
  await page.locator('[data-v2-work]').getByRole('link', { name: 'Active Matters', exact: true }).click();
  await waitForWork(page);
  await expect(page.getByRole('heading', { name: 'Disclosure response preparation' })).toBeVisible();
  await expect(page.locator('.v2-work-index')).toBeVisible();
});

test('History links select the displayed page after sorting and stay in History after reload', async ({ page }) => {
  const history = Array.from({ length: 7 }, (_, index) => ({ caseId: (700 + index).toString(16).padStart(24, '0'), title: `Retained history ${index}`, attorneyName: 'Jordan Lee', completedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(), receiptAvailable: true, paymentAmount: 81, currency: 'USD', isWithdrawn: false }));
  await installWorkProjection(page, { history });
  for (const alias of ['highlightCase', 'matterId']) {
    await page.goto(`/paralegal-v2.html#/work?${alias}=${history[0].caseId}`);
    await waitForWork(page);
    await expect(page.locator(`[data-work-history-id="${history[0].caseId}"]`)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/#\/work\?section=history$/);
    await page.reload(); await waitForWork(page);
    await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toBeVisible();
    await expect(page.locator('.v2-work-index')).toHaveCount(0);
  }
});

test('History distinguishes an empty list from a wholly unavailable workspace and recovers', async ({ page }) => {
  await installWorkProjection(page, { history: [] });
  let unavailable = false;
  const paths = new Set(['/api/paralegal/dashboard', '/api/applications/my', '/api/cases/invited-to', '/api/cases/my-completed']);
  await page.route(url => paths.has(url.pathname), route => unavailable ? json(route, {}, 503) : route.fallback());
  await page.goto('/paralegal-v2.html#/work?section=history'); await waitForWork(page);
  await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toHaveCount(1);
  await expect(page.locator('#v2-work-history')).toContainText('No past matters yet.');
  await expect(page.locator('.v2-work-index')).toHaveCount(0);
  unavailable = true; await page.goto('about:blank'); await page.goto('/paralegal-v2.html#/work?section=history');
  await expect(page.getByRole('heading', { level: 1, name: 'History', exact: true })).toHaveCount(1);
  await expect(page.locator('.v2-work-error')).toContainText('These records couldn’t load.');
  await expect(page.locator('.v2-work-error')).not.toContainText('No past matters yet.');
  unavailable = false; await page.locator('.v2-work-error').getByRole('button', { name: 'Try again', exact: true }).click();
  await waitForWork(page); await expect(page.locator('#v2-work-history')).toContainText('No past matters yet.');
});

test("application filters, saved views, pagination, and deep links stay in the persistent shell", async ({ page }) => {
  await installWorkProjection(page);
  await page.goto(`/paralegal-v2.html#/work?applicationId=${APPLICATION_ID}`, { waitUntil: "domcontentloaded" });
  await waitForWork(page);
  await page.evaluate(() => {
    window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.workIdentity = "same-sidebar";
    window.__workNavigationCount = performance.getEntriesByType("navigation").length;
  });

  await expect(page.getByRole("dialog", { name: "Discovery chronology review" })).toBeVisible();
  await page.getByRole("button", { name: "Close application details" }).click();
  await expect(page.getByRole("button", { name: "Delete view", exact: true })).toBeHidden();
  await page.getByLabel("Application saved view").selectOption("saved:saved-litigation");
  await expect(page.getByRole("button", { name: "Delete view", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lease abstraction" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Discovery chronology review" })).toBeVisible();
  await page.getByLabel("Application saved view").selectOption("built:all");
  await expect(page.getByRole("button", { name: "Delete view", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Estate correspondence" })).toBeVisible();

  // Changing focused categories retains the current application page and filters.
  await page.locator('.v2-work-index').getByRole('link', { name: /Invitations/ }).click();
  await waitForWork(page);
  await expect(page.getByRole('heading', { name: 'Probate inventory support' })).toBeVisible();
  await expect(page.getByLabel('Application saved view')).toHaveCount(0);
  await page.locator('.v2-work-index').getByRole('link', { name: /Applications/ }).click();
  await waitForWork(page);
  await expect(page.getByRole('heading', { name: 'Estate correspondence' })).toBeVisible();
  await expect(page.getByLabel('Application date range')).toHaveValue('all');
  await expect(page.getByRole('heading', { name: 'Probate inventory support' })).toHaveCount(0);
  await expect(page.locator('.v2-work-index a[aria-current="page"]')).toContainText('Applications');

  const state = await page.evaluate(() => ({
    sidebar: window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.workIdentity,
    navigationCount: performance.getEntriesByType("navigation").length,
    initialNavigationCount: window.__workNavigationCount,
  }));
  expect(state.sidebar).toBe("same-sidebar");
  expect(state.navigationCount).toBe(state.initialNavigationCount);
});

test("invitation responses and application revocation use existing mutations only after confirmation", async ({ page }) => {
  const state = await installWorkProjection(page);
  let acceptRequests = 0;
  let revokeRequests = 0;
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route(`**/api/cases/${INVITE_CASE_ID}/invite/accept`, async (route) => {
    acceptRequests += 1;
    state.invites = [];
    await json(route, { success: true });
  });
  await page.route(`**/api/applications/${APPLICATION_ID}/revoke`, async (route) => {
    revokeRequests += 1;
    state.applications = state.applications.map((application) => application._id === APPLICATION_ID ? { ...application, status: "withdrawn", preEngagement: null } : application);
    await json(route, { success: true });
  });
  await page.goto("/paralegal-v2.html#/work?section=invitations", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect(page.locator("[data-v2-toast-region]")).toContainText("Invitation accepted.");
  await expect(page.getByRole("heading", { name: "Probate inventory support" })).toHaveCount(0);
  expect(acceptRequests).toBe(1);
  await page.locator(".v2-work-index").getByRole("link", { name: /Applications/ }).click();
  await waitForWork(page);

  await page.getByRole("button", { name: "Provide requested information" }).click();
  await page.getByRole("button", { name: "Withdraw application" }).click();
  const confirmation = page.getByRole("dialog", { name: "Withdraw this application?" });
  await expect(confirmation).toBeVisible();
  expect(revokeRequests).toBe(0);
  await confirmation.getByRole("button", { name: "Withdraw application" }).click();
  await expect(page.locator("[data-v2-toast-region]")).toContainText("Application withdrawn.");
  expect(revokeRequests).toBe(1);
  await page.getByLabel("Application status").selectOption("withdrawn");
  await expect(page.getByRole("heading", { name: "Discovery chronology review" })).toBeVisible();
});

test("invitation acceptance reflects verified payout readiness before using the authoritative mutation", async ({ page }) => {
  const state = { payoutStatus: { readiness: { ready: false, evidenceState: "verified" } } };
  await installWorkProjection(page, state);
  let acceptRequests = 0;
  await page.route(`**/api/cases/${INVITE_CASE_ID}/invite/accept`, async (route) => {
    acceptRequests += 1;
    await json(route, { success: true });
  });
  await page.goto("/paralegal-v2.html#/work?section=invitations", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  await expect(page.getByText("Payout setup is required before accepting.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toHaveCount(0);
  const setup = page.getByRole("link", { name: "Connect Stripe to receive your payouts" });
  await expect(setup).toHaveAttribute("href", "paralegal-v2.html#/settings?tab=security&section=payments");
  expect(acceptRequests).toBe(0);

  state.payoutStatus = { readiness: { ready: true, evidenceState: "verified" } };
  await setup.click();
  await expect(page).toHaveURL(/#\/settings\?tab=security&section=payments/);
});

test("invitation acceptance fails closed when payout readiness is temporarily unavailable", async ({ page }) => {
  await installWorkProjection(page);
  await page.unroute("**/api/payments/connect/status");
  await page.route("**/api/payments/connect/status", (route) => json(route, { error: "Unavailable" }, 503));
  let acceptRequests = 0;
  await page.route(`**/api/cases/${INVITE_CASE_ID}/invite/accept`, async (route) => {
    acceptRequests += 1;
    await json(route, { success: true });
  });
  await page.goto("/paralegal-v2.html#/work?section=invitations", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  await expect(page.getByText("We couldn’t check your payout setup. Please try again before accepting.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check payout status" })).toBeVisible();
  expect(acceptRequests).toBe(0);
});

test("pre-engagement response uses the protected existing form-data endpoint", async ({ page }) => {
  await installWorkProjection(page);
  let submissions = 0;
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async (route) => {
    submissions += 1;
    const body = route.request().postData() || "";
    expect(body).toContain("confidentialityAcknowledged");
    expect(body).toMatch(/name="expectedPreEngagementRevision"\r?\n\r?\n7/);
    expect(body).toContain("none_known");
    await json(route, { success: true, preEngagement: { status: "submitted", revision: 8, requestedParalegalId: "64b000000000000000000001" } });
  });
  await page.goto("/paralegal-v2.html#/work?section=applications", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  await page.getByRole("button", { name: "Provide requested information" }).click();
  const dialog = page.getByRole("dialog", { name: "Discovery chronology review" });
  await dialog.getByText("I reviewed and acknowledge this confidentiality agreement.").click();
  await dialog.getByText("No known conflict").click();
  await dialog.getByRole("button", { name: "Submit to attorney" }).click();
  await expect(page.locator("[data-v2-toast-region]")).toContainText("Information sent to the attorney.");
  expect(submissions).toBe(1);
});

async function captureRequirementsRequest(page) {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = async function(input, options) {
      const selected = String(input?.url || input).includes('/pre-engagement/respond');
      if (selected) {
        const file = options?.body instanceof FormData ? options.body.get('paralegalConfidentialityFile') : null;
        window.__requirementsFile = file instanceof File ? { name: file.name, size: file.size, text: await file.text() } : null;
      }
      const response = await fetch.call(this, input, options);
      if (selected) { const read = response.json.bind(response); response.json = async () => { const body = await read(); window.__requirementsResponseRead = true; return body; }; }
      return response;
    };
  });
}

for (const outcome of ['confirmed', 'lost', 'changed']) test(`V2 in-flight requirements ${outcome} stay single-flight after closing and reopening`, async ({ page }, info) => {
  await captureRequirementsRequest(page);
  const state = await installWorkProjection(page); let writes = 0, release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async route => {
    writes++; expect(route.request().postData()).toContain('signed-pending.pdf'); await held;
    state.applications[0].preEngagement = { ...state.applications[0].preEngagement, status: outcome === 'changed' ? 'requested' : 'submitted', revision: 8, conflictsDetails: 'Review the updated parties.', confidentialityAcknowledged: true, conflictsResponseType: 'none_known' };
    if (outcome === 'lost') return json(route, { error: 'Submission could not be confirmed.' }, 503);
    if (outcome === 'changed') return json(route, { code: 'PRE_ENGAGEMENT_CONFLICT', error: 'The requirements changed.' }, 409);
    return json(route, { success: true, preEngagement: state.applications[0].preEngagement });
  });
  await page.goto('/paralegal-v2.html#/work?section=applications'); await waitForWork(page);
  await page.getByRole('button', { name: 'Provide requested information', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  await dialog.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true }).check();
  await dialog.getByLabel('No known conflict', { exact: true }).check();
  await dialog.getByLabel('Upload signed confidentiality agreement').setInputFiles({ name: 'signed-pending.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic pending bytes') });
  try {
    await dialog.getByRole('button', { name: 'Submit to attorney', exact: true }).click(); await expect.poll(() => writes).toBe(1);
    expect(await page.evaluate(() => window.__requirementsFile)).toEqual({ name: 'signed-pending.pdf', size: Buffer.byteLength('synthetic pending bytes'), text: 'synthetic pending bytes' });
    await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
    await page.getByRole('button', { name: 'Provide requested information', exact: true }).click();
    await expect(dialog.getByRole('button', { name: /^(Submit to attorney|Submitting…)$/ })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Withdraw application', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('No known conflict', { exact: true })).toBeDisabled();
    await expect(dialog.getByText('Selected: signed-pending.pdf', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Review saved requirements', exact: true })).toBeHidden();
    if (outcome === 'confirmed') for (const [width, dark, size] of [[1366, false, '100%'], [320, true, '100%'], [390, true, '200%']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({dark,size}) => { document.documentElement.classList.toggle('theme-dark', dark); document.documentElement.style.fontSize = size; }, {dark,size});
      const root = page.locator('.v2-work-application-dialog');
      await root.getByRole('button', { name: 'Submitting…', exact: true }).scrollIntoViewIfNeeded();
      expect(await root.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include('.v2-work-application-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`requirements-dialog-sending-${width}-${size}.png`) });
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.evaluate(() => { document.documentElement.classList.remove('theme-dark'); document.documentElement.style.fontSize = '100%'; });
    release();
    if (outcome === 'confirmed') await expect(dialog).toBeHidden();
    else {
      await dialog.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
      if (outcome === 'changed') { await expect(dialog).toContainText('updated parties'); await expect(dialog.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true })).not.toBeChecked(); await expect(dialog.getByText('Selected: signed-pending.pdf', { exact: true })).toBeHidden(); }
      else await expect(dialog.getByRole('button', { name: 'Submit to attorney', exact: true })).toHaveCount(0);
    }
    expect(writes).toBe(1);
  } finally { release(); }
});

test('pending requirements document review stays with the displayed revision until saved review', async ({ page }) => {
  const state = await installWorkProjection(page), selected = state.applications[0];
  const notices = [], viewer = (await (await page.request.get('/api/auth/me')).json()).user;
  await installNotificationReads(page, { ownerId: String(viewer.id || viewer._id), getItems: () => notices });
  let release, writes = 0; const held = new Promise(resolve => { release = resolve; });
  const reviewed = [];
  await page.addInitScript(() => { window.__reviewedDocumentLinks = []; window.open = url => { window.__reviewedDocumentLinks.push(url); return null; }; });
  await page.route('**/api/uploads/signed-get?**', route => {
    const url = new URL(route.request().url()); reviewed.push({ caseId: url.searchParams.get('caseId'), key: url.searchParams.get('key') });
    return json(route, { url: 'https://example.invalid/synthetic-document' });
  });
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async route => {
    writes++; await held; return json(route, { code: 'PRE_ENGAGEMENT_CONFLICT', error: 'The requirements changed.' }, 409);
  });
  await page.goto(`/paralegal-v2.html#/work?applicationId=${APPLICATION_ID}`); await waitForWork(page);
  const dialog = page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  await dialog.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true }).check();
  await dialog.getByLabel('No known conflict', { exact: true }).check();
  try {
    await dialog.getByRole('button', { name: 'Submit to attorney', exact: true }).click(); await expect.poll(() => writes).toBe(1);
    selected.preEngagement = { ...selected.preEngagement, revision: 8, conflictsDetails: 'Review the revised parties.', confidentialityDocument: { key: 'safe/revised.pdf', name: 'Revised agreement.pdf' } };
    const readsBefore = state.dashboardReads;
    notices.push({ id: '64b000000000000000001999', message: 'The requested information changed.', read: false, createdAt: '2026-09-13T01:00:00Z', type: 'pre_engagement_requested', caseId: PRE_CASE_ID });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed')));
    await expect(page.locator('[data-v2-notification-badge]')).toHaveText('1');
    await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
    await expect.poll(() => state.dashboardReads).toBeGreaterThan(readsBefore);
    await page.getByRole('button', { name: 'Provide requested information', exact: true }).click();
    await expect(dialog).toContainText('The requirements changed.');
    await expect(dialog).toContainText('Check the listed parties against your current matters.');
    await dialog.getByRole('button', { name: 'Review document', exact: true }).click();
    await expect.poll(() => reviewed.length).toBe(1);
    expect(reviewed[0]).toEqual({ caseId: PRE_CASE_ID, key: 'safe/key.pdf' });
    release();
    await dialog.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
    await expect(dialog).toContainText('Review the revised parties.');
    await expect(dialog.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Review document', exact: true }).click();
    await expect.poll(() => reviewed.length).toBe(2);
    expect(reviewed[1]).toEqual({ caseId: PRE_CASE_ID, key: 'safe/revised.pdf' });
    await expect.poll(() => page.evaluate(() => window.__reviewedDocumentLinks.length)).toBe(2);
    expect(writes).toBe(1);
  } finally { release(); }
});

for (const source of ['canonical', 'earlier', 'invite']) for (const outcome of ['confirmed', 'lost']) test(`V2 ${source} withdrawal ${outcome} blocks a competing requirements response`, async ({ page }) => {
  const state = await installWorkProjection(page), selected = state.applications[0];
  if (source !== 'canonical') Object.assign(selected, { _id: '', id: '', applicationSource: source === 'earlier' ? 'case_applicant' : 'invite_accept', withdrawal: { available: true, revision: 'a'.repeat(64) } });
  let release, writes = 0, responses = 0; const held = new Promise(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/api/applications/my', route => json(route, state.applications));
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, route => { responses++; return json(route, { error: 'Competing response must not be sent.' }, 409); });
  const endpoint = source === 'canonical' ? `/api/applications/${APPLICATION_ID}/revoke` : source === 'invite' ? `/api/cases/${PRE_CASE_ID}/invite/revoke` : `/api/applications/earlier/${PRE_CASE_ID}/revoke`;
  await page.route(`**${endpoint}`, async route => { writes++; await held; Object.assign(selected, { status: 'withdrawn', preEngagement: null, withdrawal: { available: false } }); return outcome === 'lost' ? json(route, { error: 'Withdrawal could not be confirmed.' }, 503) : json(route, { success: true, caseId: PRE_CASE_ID, status: 'withdrawn', alreadyRevoked: false }); });
  await page.goto(`/paralegal-v2.html#/work?jobId=${APPLICATION_JOB_ID}`); await waitForWork(page);
  const details = page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  const confirmation = page.getByRole('dialog', { name: 'Withdraw this application?', exact: true });
  try {
    await details.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Withdraw application', exact: true }).click(); await expect.poll(() => writes).toBe(1);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Provide requested information', exact: true }).click();
    await expect(details.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeDisabled();
    await expect(details.getByLabel('No known conflict', { exact: true })).toBeDisabled();
    release();
    if (outcome === 'lost') {
      await details.getByRole('button', { name: 'Review withdrawal', exact: true }).click();
      await confirmation.getByRole('button', { name: 'Review saved application', exact: true }).click();
      await expect(confirmation).toBeHidden();
    }
    await expect(details).toBeHidden(); expect(writes).toBe(1); expect(responses).toBe(0);
  } finally { release(); }
});

for (const departure of ['other-application', 'account-return']) test(`V2 late requirements response respects ${departure}`, async ({ page }) => {
  await captureRequirementsRequest(page);
  const state = await installWorkProjection(page), selected = state.applications[0];
  selected._id = ''; selected.applicationSource = 'invite_accept'; selected.preEngagement.confidentialityAgreementRequired = false;
  const otherJobId = '64b000000000000000001299';
  const other = { ...selected, caseId: HISTORY_CASE_ID, jobId: { ...selected.jobId, _id: otherJobId, caseId: HISTORY_CASE_ID, title: 'Another invited application' }, preEngagement: { ...selected.preEngagement, revision: 9, conflictsDetails: 'Other Matter parties.' } };
  state.applications = [selected, other]; let release, finished, writes = 0;
  const held = new Promise(resolve => { release = resolve; }), settled = new Promise(resolve => { finished = resolve; });
  const viewer = (await (await page.request.get('/api/auth/me')).json()).user;
  let identity = viewer;
  await installNotificationReads(page, { ownerId: () => String(identity.id || identity._id) });
  await page.route(url => url.pathname === '/api/cases/invited-to', route => json(route, receivedInvitations(String(identity.id || identity._id), state.invites, new URL(route.request().url()).searchParams)));
  await page.route('**/api/auth/me', route => json(route, { user: identity }));
  await page.route('**/api/users/me', route => json(route, identity));
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async route => {
    writes++; await held; selected.preEngagement = { ...selected.preEngagement, status: 'submitted', revision: 8, conflictsResponseType: 'disclosure', conflictsDisclosureText: 'Selected private response.' };
    await json(route, { success: true, preEngagement: selected.preEngagement }); finished();
  });
  await page.goto(`/paralegal-v2.html#/work?jobId=${APPLICATION_JOB_ID}`); await waitForWork(page);
  const selectedDialog = page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  await selectedDialog.getByLabel('Disclose a possible conflict', { exact: true }).check();
  await selectedDialog.getByLabel('Possible conflict details').fill('Selected private response.');
  try {
    await selectedDialog.getByRole('button', { name: 'Submit to attorney', exact: true }).click(); await expect.poll(() => writes).toBe(1);
    await selectedDialog.getByRole('button', { name: 'Close application details', exact: true }).click();
    if (departure === 'account-return') {
      for (const next of [{ ...viewer, id: '64b000000000000000009999', _id: '64b000000000000000009999' }, viewer]) {
        identity = next; const id = String(next.id || next._id);
        await page.evaluate(id => window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue: '{}', newValue: JSON.stringify({ id }) })), id);
        await expect.poll(() => page.evaluate(() => { const user = JSON.parse(localStorage.getItem('lpc_user') || '{}'); return String(user.id || user._id || ''); })).toBe(id);
        await waitForWork(page);
      }
    }
    await page.locator(`[data-work-job-id="${otherJobId}"]`).getByRole('button', { name: 'Provide requested information', exact: true }).click();
    const otherDialog = page.getByRole('dialog', { name: 'Another invited application', exact: true });
    await otherDialog.getByLabel('Disclose a possible conflict', { exact: true }).check();
    const field = otherDialog.getByLabel('Possible conflict details'); await field.fill('Other Matter private draft.'); await field.focus();
    release(); await settled; await expect.poll(() => page.evaluate(() => window.__requirementsResponseRead)).toBe(true);
    await expect(otherDialog).toBeVisible(); await expect(field).toHaveValue('Other Matter private draft.'); await expect(field).toBeFocused();
    await expect(page.locator('[data-v2-toast-region]')).not.toContainText('Information sent'); expect(writes).toBe(1);
  } finally { release(); }
});

for (const status of ['submitted', 'changes_requested']) test(`V2 ${status} requirements retain the saved signed copy without duplicate file text`, async ({ page }) => {
  const state = await installWorkProjection(page); Object.assign(state.applications[0].preEngagement, { status, paralegalConfidentialityDocument: { name: 'saved-agreement.pdf', key: `cases/${PRE_CASE_ID}/pre-engagement/signed.pdf` } });
  await page.goto(`/paralegal-v2.html#/work?applicationId=${APPLICATION_ID}`); await waitForWork(page);
  const dialog = page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  if (status === 'submitted') { await expect(dialog.getByText('Signed copy: saved-agreement.pdf', { exact: true })).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Choose file', exact: true })).toBeHidden(); }
  else {
    await expect(dialog.getByText('Saved: saved-agreement.pdf', { exact: true })).toBeVisible();
    await dialog.getByLabel('Upload signed confidentiality agreement').setInputFiles({ name: 'replacement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('replacement') });
    await expect(dialog.getByText('Selected: replacement.pdf', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove file', exact: true }).click();
    await expect(dialog.getByText('Saved: saved-agreement.pdf', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Selected: replacement.pdf', { exact: true })).toBeHidden();
  }
});

test("unfinished pre-engagement answers and the selected document survive a temporary close", async ({ page }) => {
  await installWorkProjection(page);
  await page.goto("/paralegal-v2.html#/work?section=applications", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  await page.getByRole("button", { name: "Provide requested information" }).click();
  let dialog = page.getByRole("dialog", { name: "Discovery chronology review" });
  await dialog.getByText("I reviewed and acknowledge this confidentiality agreement.").click();
  await dialog.getByText("Disclose a possible conflict").click();
  await dialog.getByLabel("Possible conflict details").fill("A prior engagement may involve one listed party.");
  await dialog.getByLabel("Upload signed confidentiality agreement").setInputFiles({
    name: "signed-confidentiality.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("signed agreement"),
  });
  await dialog.getByRole("button", { name: "Close application details" }).click();

  await page.getByRole("button", { name: "Provide requested information" }).click();
  dialog = page.getByRole("dialog", { name: "Discovery chronology review" });
  await expect(dialog.getByLabel("Possible conflict details")).toHaveValue("A prior engagement may involve one listed party.");
  await expect(dialog.getByText("Selected: signed-confidentiality.pdf", { exact: true })).toBeVisible();
  await expect(dialog.locator('input[type="checkbox"]')).toBeChecked();
  await dialog.getByRole('button', { name: 'Remove file', exact: true }).click();
  await expect(dialog.getByText('Selected: signed-confidentiality.pdf', { exact: true })).toBeHidden();
  const chosen = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose file', exact: true }).click();
  await (await chosen).setFiles({ name: 'replacement-agreement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic replacement') });
  await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
  await page.getByRole('button', { name: 'Provide requested information', exact: true }).click();
  await expect(dialog.getByText('Selected: replacement-agreement.pdf', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Replace file', exact: true })).toBeVisible();
});

for (const outcome of ['changed', 'unconfirmed', 'malformed']) test(`a ${outcome} pre-engagement submission requires a saved review before another attempt`, async ({ page }, info) => {
  test.setTimeout(90000);
  const state = await installWorkProjection(page); let writes = 0;
  await page.route('**/api/csrf', route => json(route, { csrfToken: 'synthetic-csrf' }));
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async route => {
    writes++; expect(route.request().postData()).toMatch(/name="expectedPreEngagementRevision"\r?\n\r?\n7/);
    state.applications[0].preEngagement = { ...state.applications[0].preEngagement, revision: 8, ...(outcome === 'changed' ? { conflictsDetails: 'Review the newly added opposing party.' } : { status: 'submitted', confidentialityAcknowledged: true, conflictsResponseType: 'none_known' }) };
    if (outcome === 'changed') return json(route, { code: 'PRE_ENGAGEMENT_CONFLICT', error: 'The requirements changed since you opened them.' }, 409);
    if (outcome === 'malformed') return json(route, { success: true });
    return route.abort('failed');
  });
  await page.goto('/paralegal-v2.html#/work?section=applications'); await waitForWork(page);
  await page.getByRole('button', { name: 'Provide requested information', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  await dialog.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true }).check();
  await dialog.getByLabel('No known conflict', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
  await page.getByRole('button', { name: 'Provide requested information', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  await expect(dialog.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeDisabled();
  if (outcome === 'changed') {
    for (const [width, dark, size] of [[320, false, '100%'], [390, true, '200%']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({ dark, size }) => { document.documentElement.classList.toggle('theme-dark', dark); document.documentElement.style.fontSize = size; }, { dark, size });
      const action = dialog.getByRole('button', { name: 'Review saved requirements', exact: true }); await action.scrollIntoViewIfNeeded(); await action.focus(); await expect(action).toBeFocused();
      const bounds = await action.boundingBox(); expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
      const overflow = await dialog.evaluate(root => ({ width: root.clientWidth, content: root.scrollWidth, children: [...root.querySelectorAll('*')].filter(node => { const child = node.getBoundingClientRect(), parent = root.getBoundingClientRect(); return child.width && (child.right > parent.right + 1 || child.left < parent.left - 1); }).map(node => ({ tag: node.tagName, className: node.className, width: node.getBoundingClientRect().width })) }));
      expect(overflow.content, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width + 1);
      expect((await new AxeBuilder({ page }).include('.v2-work-application-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`requirements-pending-${width}-${size}.png`) });
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.evaluate(() => { document.documentElement.classList.remove('theme-dark'); document.documentElement.style.fontSize = ''; });
  }
  await dialog.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
  if (outcome === 'changed') {
    await expect(dialog).toContainText('newly added opposing party');
    await expect(dialog.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true })).not.toBeChecked();
    await expect(dialog.getByLabel('No known conflict', { exact: true })).not.toBeChecked();
  } else await expect(dialog.getByRole('button', { name: 'Submit to attorney', exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
  await page.screenshot({ path: info.outputPath(`requirements-${outcome}-recovered.png`) });
});

for (const entry of ['v2', 'current']) test(`${entry} invited pre-engagement recovery keeps the selected Matter when application IDs are empty`, async ({ page }, info) => {
  const state = await installWorkProjection(page); let writes = 0;
  const selected = state.applications[0]; selected._id = ''; selected.applicationSource = 'invite_accept';
  selected.preEngagement.confidentialityAgreementRequired = false;
  const other = { ...selected, caseId: HISTORY_CASE_ID, jobId: { ...selected.jobId, _id: '64b000000000000000001299', caseId: HISTORY_CASE_ID, title: 'Another invited application' }, preEngagement: { ...selected.preEngagement, revision: 9, conflictsDetails: 'A different Matter and different parties.' } };
  state.applications = [other, selected];
  await page.route('**/api/csrf', route => json(route, { csrfToken: 'synthetic-csrf' }));
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async route => {
    writes++; selected.preEngagement = { ...selected.preEngagement, revision: 8, conflictsDetails: 'Updated parties for the selected chronology Matter.' };
    return json(route, { code: 'PRE_ENGAGEMENT_CONFLICT', error: 'The requirements changed since you opened them.' }, 409);
  });
  await page.goto(entry === 'current' ? `/dashboard-paralegal.html?jobId=${APPLICATION_JOB_ID}#cases` : '/paralegal-v2.html#/work?section=applications');
  if (entry === 'v2') {
    await waitForWork(page);
    await page.locator(`[data-work-job-id="${APPLICATION_JOB_ID}"]`).getByRole('button', { name: 'Provide requested information', exact: true }).click();
  }
  const dialog = entry === 'current' ? page.locator('#applicationDetailModal') : page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  await dialog.getByLabel('No known conflict', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeDisabled();
  if (entry === 'current') {
    await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
    await page.getByRole('button', { name: 'Show application filters', exact: true }).click();
    await page.locator('#appliedDateFilter').selectOption('all');
    await page.locator(`[data-application-view][data-job-id="${APPLICATION_JOB_ID}"]`).click();
    await expect(dialog.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Review saved requirements', exact: true })).toBeVisible();
  }
  await dialog.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
  await expect(dialog).toContainText('Updated parties for the selected chronology Matter.');
  await expect(dialog).not.toContainText('A different Matter and different parties.');
  await expect(dialog.getByLabel('No known conflict', { exact: true })).not.toBeChecked();
  expect(writes).toBe(1);
  if (entry === 'current') for (const theme of ['light', 'dark']) for (const [width, size] of [[1366, '100%'], [320, '100%'], [390, '200%']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ theme, size }) => { window.applyThemePreference(theme); document.documentElement.style.fontSize = size; }, { theme, size });
    const close = dialog.getByRole('button', { name: 'Close application details', exact: true });
    await close.scrollIntoViewIfNeeded(); await close.focus(); await expect(close).toBeFocused();
    const box = await close.boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(901);
    expect(await close.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
    const submit = dialog.getByRole('button', { name: 'Submit to attorney', exact: true }); await submit.scrollIntoViewIfNeeded();
    expect((await submit.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await dialog.locator('.note-modal-card').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('#applicationDetailModal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await expect(page.locator('#toastBanner')).not.toContainText('This action has already been taken.');
    await page.screenshot({ path: info.outputPath(`current-requirements-${theme}-${width}-${size}.png`) });
  }
  await page.screenshot({ path: info.outputPath(`${entry}-invited-requirements-recovered.png`) });
});

async function openCurrentApplicationFromList(page, jobId = APPLICATION_JOB_ID) {
  const filter = page.getByRole('button', { name: 'Show application filters', exact: true });
  if (await filter.count()) await filter.click();
  await page.locator('#appliedDateFilter').selectOption('all');
  await page.locator(`[data-application-view][data-job-id="${jobId}"]`).click();
}

test('current pre-engagement keeps unsent answers and the actual file across a temporary close', async ({ page }, info) => {
  const state = await installWorkProjection(page); let writes = 0;
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = async function(input, options) {
      if (String(input).endsWith('/pre-engagement/respond') && options?.body instanceof FormData) {
        const file = options.body.get('paralegalConfidentialityFile');
        window.__retainedAgreementFile = file instanceof File ? { name: file.name, size: file.size, text: await file.text() } : null;
      }
      return fetch.call(this, input, options);
    };
  });
  await page.route('**/api/csrf', route => json(route, { csrfToken: 'synthetic-csrf' }));
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async route => {
    writes++;
    const body = route.request().postData();
    expect(body).toContain('filename="signed-confidentiality.pdf"');
    expect(body).toContain('A prior engagement may involve one listed party.');
    expect(body).toMatch(/name="confidentialityAcknowledged"\r?\n\r?\ntrue/);
    state.applications[0].preEngagement = { ...state.applications[0].preEngagement, revision: 8, status: 'submitted', confidentialityAcknowledged: true, conflictsResponseType: 'disclosure', conflictsDisclosureText: 'A prior engagement may involve one listed party.' };
    await json(route, { success: true, preEngagement: state.applications[0].preEngagement });
  });
  await page.goto(`/dashboard-paralegal.html?applicationId=${APPLICATION_ID}#cases`);
  const dialog = page.locator('#applicationDetailModal');
  await dialog.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true }).check();
  await dialog.locator('[data-preengagement-signed-file]').setInputFiles({ name: 'signed-confidentiality.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic signed file bytes') });
  await dialog.locator('[data-preengagement-card-toggle="conflicts"]').click();
  await dialog.getByLabel('Disclose a possible conflict', { exact: true }).check();
  await dialog.getByLabel('Possible conflict details', { exact: true }).fill('A prior engagement may involve one listed party.');
  await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
  await openCurrentApplicationFromList(page);
  await expect(dialog.getByLabel('Possible conflict details', { exact: true })).toHaveValue('A prior engagement may involve one listed party.');
  await dialog.locator('[data-preengagement-card-toggle="confidentiality"]').click();
  await expect(dialog.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true })).toBeChecked();
  await expect(dialog.getByText('signed-confidentiality.pdf', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Complete', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Required', { exact: true })).toHaveCount(0);
  for (const [width, theme, size] of [[1366, 'light', '100%'], [320, 'dark', '100%'], [390, 'dark', '200%']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({theme,size}) => { window.applyThemePreference(theme); document.documentElement.style.fontSize = size; }, {theme,size});
    await dialog.getByRole('button', { name: 'Submit to attorney', exact: true }).scrollIntoViewIfNeeded();
    expect(await dialog.locator('.note-modal-card').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('#applicationDetailModal').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`current-unsent-requirements-${width}-${size}.png`) });
  }
  await dialog.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
  await expect(dialog.locator('[data-preengagement-submit]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__retainedAgreementFile)).toEqual({ name: 'signed-confidentiality.pdf', size: Buffer.byteLength('synthetic signed file bytes'), text: 'synthetic signed file bytes' });
  expect(writes).toBe(1);
});

for (const outcome of ['submitted', 'unconfirmed', 'account-changed']) test(`current pre-engagement ${outcome} completion stays attached to its application and account`, async ({ page }) => {
  const state = await installWorkProjection(page); let writes = 0, release, finished;
  const gate = new Promise(resolve => { release = resolve; });
  const settled = new Promise(resolve => { finished = resolve; });
  const selected = state.applications[0]; selected._id = ''; selected.applicationSource = 'invite_accept'; selected.preEngagement.confidentialityAgreementRequired = false;
  const otherJobId = '64b000000000000000001299';
  const other = { ...selected, caseId: HISTORY_CASE_ID, jobId: { ...selected.jobId, _id: otherJobId, caseId: HISTORY_CASE_ID, title: 'Another invited application' }, preEngagement: { ...selected.preEngagement, revision: 9, conflictsDetails: 'Other Matter parties.' } };
  state.applications = [selected, other];
  await page.route('**/api/csrf', route => json(route, { csrfToken: 'synthetic-csrf' }));
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async route => {
    writes++; await gate;
    if (outcome !== 'unconfirmed') selected.preEngagement = { ...selected.preEngagement, revision: 8, status: 'submitted', conflictsResponseType: 'disclosure', conflictsDisclosureText: 'Selected Matter disclosure.' };
    await json(route, outcome === 'unconfirmed' ? { success: true } : { success: true, preEngagement: selected.preEngagement });
    finished();
  });
  await page.goto(`/dashboard-paralegal.html?jobId=${APPLICATION_JOB_ID}#cases`);
  const dialog = page.locator('#applicationDetailModal');
  await dialog.getByLabel('Disclose a possible conflict', { exact: true }).check();
  await dialog.getByLabel('Possible conflict details', { exact: true }).fill('Selected Matter disclosure.');
  await dialog.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
  await openCurrentApplicationFromList(page);
  await expect(dialog.getByRole('button', { name: 'Submitting…', exact: true })).toBeDisabled();
  await expect(dialog.locator('[data-application-revoke]')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Review saved requirements', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
  await openCurrentApplicationFromList(page, otherJobId);
  await dialog.getByLabel('Disclose a possible conflict', { exact: true }).check();
  await dialog.getByLabel('Possible conflict details', { exact: true }).fill('Other Matter private draft.');
  if (outcome === 'account-changed') {
    await page.evaluate(() => {
      const raw = localStorage.getItem('lpc_user'), old = JSON.parse(raw);
      localStorage.setItem('lpc_user', JSON.stringify({ ...old, id: '64b000000000000000009999', _id: '64b000000000000000009999' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user' }));
      // Returning to the original account must not revive its discarded operation.
      localStorage.setItem('lpc_user', raw);
    });
    await expect(dialog).toBeHidden();
    await expect(dialog.locator('[data-application-detail]')).toBeEmpty();
  }
  release(); await settled;
  if (outcome === 'account-changed') {
    await expect(dialog).toBeHidden();
    await expect(dialog.locator('[data-application-detail]')).toBeEmpty();
  } else {
    await expect(dialog.getByRole('heading', { name: 'Another invited application', exact: true })).toBeVisible();
    await expect(dialog.getByLabel('Possible conflict details', { exact: true })).toHaveValue('Other Matter private draft.');
    await dialog.getByRole('button', { name: 'Close application details', exact: true }).click();
    await openCurrentApplicationFromList(page);
    if (outcome === 'unconfirmed') {
      await expect(dialog).toContainText('Submission could not be confirmed.');
      await expect(dialog.locator('[data-application-revoke]')).toBeDisabled();
      await dialog.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeEnabled();
      await expect(dialog.getByLabel('Possible conflict details', { exact: true })).toHaveValue('Selected Matter disclosure.');
    } else {
      await expect(dialog.locator('[data-preengagement-submit]')).toHaveCount(0);
      await expect(dialog).toContainText('Selected Matter disclosure.');
    }
  }
  expect(writes).toBe(1);
});

test('current pre-engagement recovery completes during an overlapping background application refresh', async ({ page }) => {
  const state = await installWorkProjection(page); let writes = 0, reads = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const selected = state.applications[0]; selected.preEngagement.confidentialityAgreementRequired = false;
  await page.route('**/api/csrf', route => json(route, { csrfToken: 'synthetic-csrf' }));
  await page.route(`**/api/cases/${PRE_CASE_ID}/pre-engagement/respond`, async route => {
    writes++; selected.preEngagement = { ...selected.preEngagement, revision: 8, status: 'submitted', conflictsResponseType: 'none_known' };
    await json(route, { success: true });
  });
  await page.goto(`/dashboard-paralegal.html?applicationId=${APPLICATION_ID}#cases`);
  const dialog = page.locator('#applicationDetailModal');
  await dialog.getByLabel('No known conflict', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
  await expect(dialog).toContainText('Submission could not be confirmed.');
  await page.route('**/api/applications/my', async route => { reads++; if (reads === 1) await gate; await json(route, state.applications); });
  await dialog.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:paralegal-dashboard-request-refresh')));
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  release();
  await expect(dialog.locator('[data-preengagement-submit]')).toHaveCount(0);
  await expect(dialog).not.toContainText('Saved requirements could not load.');
  expect(writes).toBe(1);
});

test('current notifications stop a queued read on departure and resume on return', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-12T12:00:00Z') });
  await page.addInitScript(() => {
    window.__notificationSources = [];
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = String(url); window.__notificationSources.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() {}
    };
  });
  await installWorkProjection(page); let reads = 0;
  await page.route('**/api/notifications', async route => { reads++; await json(route, []); });
  await page.route('**/api/notifications/stream', route => route.fulfill({ status: 204, body: '' }));
  await page.goto(`/dashboard-paralegal.html?applicationId=${APPLICATION_ID}#cases`);
  await expect(page.locator('#applicationDetailModal')).toBeVisible();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
  await page.clock.runFor(500);
  const before = reads;
  await page.evaluate(() => {
    window.__notificationSources.filter(source => source.url.includes('/api/notifications/stream')).forEach(source => source.dispatchEvent(new MessageEvent('notifications', { data: '{}' })));
    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await page.clock.runFor(1000);
  expect(reads).toBe(before);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.clock.runFor(500);
  await expect.poll(() => reads).toBeGreaterThan(before);
});

test('current notification read is aborted on departure and a late response cannot repaint the returned page', async ({ page }) => {
  await page.addInitScript(() => {
    const fetch = window.fetch;
    window.fetch = function(input, options) {
      if (String(input) === '/api/notifications' && window.__tagNotificationRead) {
        window.__tagNotificationRead = false;
        window.__notificationReadSignal = options?.signal;
        const headers = new Headers(options?.headers);
        headers.set('X-LPC-Test-Held-Notification', 'true');
        options = { ...options, headers };
      }
      return fetch.call(this, input, options);
    };
  });
  await installWorkProjection(page);
  await page.route('**/api/notifications', route => json(route, []));
  await page.route('**/api/notifications/stream', route => route.fulfill({ status: 204, body: '' }));
  await page.goto(`/dashboard-paralegal.html?applicationId=${APPLICATION_ID}#cases`);
  await expect(page.locator('#applicationDetailModal')).toBeVisible();
  let release, finish, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const settled = new Promise(resolve => { finish = resolve; });
  await page.route('**/api/notifications', async route => {
    if (route.request().headers()['x-lpc-test-held-notification'] !== 'true') return json(route, []);
    held = true; await gate;
    await json(route, [{ _id: '64b000000000000000009998', message: 'Late notification from the departed page', read: false }]);
    finish();
  });
  await page.evaluate(async () => { const module = await import('/assets/scripts/utils/notifications.js'); window.__tagNotificationRead = true; void module.loadNotifications(); });
  await expect.poll(() => held).toBe(true);
  await page.evaluate(() => { window.dispatchEvent(new Event('beforeunload')); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); });
  expect(await page.evaluate(() => window.__notificationReadSignal?.aborted)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  release(); await settled;
  await page.evaluate(async () => { await (await import('/assets/scripts/utils/notifications.js')).loadNotifications(); });
  await expect(page.locator('body')).not.toContainText('Late notification from the departed page');
});

test("live notification reconciliation updates immediately without interrupting an open application", async ({ page }) => {
  const state = await installWorkProjection(page);
  const notifications = { unread: 0, items: [] };
  await page.route("**/api/notifications**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/notifications/stream") return route.fulfill({ status: 204, body: "" });
    if (url.pathname === "/api/notifications/unread-count") return json(route, { count: notifications.unread });
    if (url.pathname === "/api/notifications" && request.method() === "GET") return json(route, notifications.items);
    return route.continue();
  });
  await page.goto("/paralegal-v2.html#/work?section=applications", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  await page.getByRole("button", { name: "Provide requested information" }).click();
  const dialog = page.getByRole("dialog", { name: "Discovery chronology review" });
  await expect(dialog).toBeVisible();
  const readsBeforeSignal = state.dashboardReads;
  notifications.unread = 1;
  notifications.items = [{
    id: "64b000000000000000001999",
    message: "Your profile has an update.",
    read: false,
    isRead: false,
    createdAt: "2026-09-04T13:00:00.000Z",
    action: { label: "Review", href: "/profile-settings.html" },
  }];
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:notifications-refreshed")));

  await expect(page.locator("[data-v2-notification-badge]")).toHaveText("1");
  await expect(dialog).toBeVisible();
  expect(state.dashboardReads).toBe(readsBeforeSignal);

  await dialog.getByRole("button", { name: "Close application details" }).click();
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(readsBeforeSignal);
  await expect(page.locator("[data-v2-work]")).toBeVisible();
});

test("withdrawal review and future-interaction block wait for confirmation and server authority", async ({ page }) => {
  const state = await installWorkProjection(page);
  let disputeRequests = 0;
  let blockRequests = 0;
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route("**/api/disputes/64b000000000000000001005", async (route) => {
    disputeRequests += 1;
    expect(route.request().postDataJSON()).toEqual({ message: "Please review the final work allocation." });
    state.history[1] = { ...state.history[1], canDispute: false, isDisputed: true };
    await json(route, { disputeId: "synthetic-dispute", status: "open" });
  });
  await page.route("**/api/blocks", async (route) => {
    blockRequests += 1;
    expect(route.request().postDataJSON()).toEqual({ caseId: HISTORY_CASE_ID });
    state.history[0] = { ...state.history[0], blockStatus: { blocked: true, canBlock: false } };
    await json(route, { ok: true, blocked: true }, 201);
  });
  await page.goto("/paralegal-v2.html#/work?section=history", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  await page.getByRole("button", { name: "Block attorney" }).click();
  expect(blockRequests).toBe(0);
  await page.getByRole("dialog", { name: "Block this attorney?" }).getByRole("button", { name: "Block attorney" }).click();
  await expect(page.locator("[data-v2-toast-region]")).toContainText("Attorney blocked.");
  expect(blockRequests).toBe(1);

  await page.getByRole("button", { name: "Request LPC review" }).click();
  const dialog = page.getByRole("dialog", { name: "Request a withdrawal review" });
  await dialog.getByLabel("Review request details").fill("Please review the final work allocation.");
  await dialog.getByRole("button", { name: "Submit request" }).click();
  await expect(page.locator("[data-v2-toast-region]")).toContainText("Request submitted.");
  expect(disputeRequests).toBe(1);
});

test("Work remains bounded at required widths without remounting the shell", async ({ page }) => {
  await installWorkProjection(page);
  await page.goto("/paralegal-v2.html#/work", { waitUntil: "domcontentloaded" });
  await waitForWork(page);

  for (const width of [320, 360, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(geometry.scrollWidth, `${width}px document overflow`).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.bodyScrollWidth, `${width}px body overflow`).toBeLessThanOrEqual(geometry.viewport + 1);
  }
});

test("usability: invitation exposes full scope before a decision", async ({ page }, testInfo) => {
  const state = { invites: [{ _id: INVITE_CASE_ID, title: "Full invitation", inviteInvitedAt: "2026-09-01T14:00:00.000Z", lockedTotalAmount: null, minimumYearsExperience: 5, briefSummary: "Short summary", details: "Complete scope including the exceptional records.", tasks: [{ title: "Verify every exhibit" }], state: "New York", deadlineDate: "2026-09-20", totalAmount: 80000, attorney: { id: "64b000000000000000001099", firstName: "Avery", lastName: "Counsel" } }] };
  state.invites[0].inviteInvitedAt = null;
  state.invites[0].updatedAt = '2026-09-11T18:00:00.000Z';
  await installWorkProjection(page, state);
  await page.goto("/paralegal-v2.html#/work?section=invitations");
  await waitForWork(page);
  const invite = page.locator(`[data-work-invite-id="${INVITE_CASE_ID}"]`);
  await expect(invite.locator('dl > div').filter({ has: page.getByText('Invited', { exact: true }) }).locator('dd')).toHaveText('Date not recorded');
  await invite.getByText("Review full invitation", { exact: true }).click();
  await expect(invite).toContainText("Complete scope including the exceptional records.");
  await expect(invite).toContainText("Verify every exhibit");
  await expect(invite).toContainText("New York");
  await expect(invite).toContainText("$656.00");
  await expect(invite).toContainText("5+ years required");
  await expect(invite).toContainText("Sep 20, 2026");
  await expect(invite).toContainText("Accepting confirms interest.");
  await expect(invite.getByRole("link", { name: "View attorney profile" })).toHaveAttribute("href", /attorney\//);
  await expect(invite.getByRole("button", { name: "Accept invitation", exact: true })).toBeEnabled();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await invite.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`invitation-${width}.png`) });
  }
});

for (const width of [1280, 390]) {
test(`follow-up: invitation review retains expansion reading position and focus through a live refresh at ${width}px`, async ({ page }) => {
  const state = await installWorkProjection(page);
  state.invites[0].details = 'Full scope for this invitation. '.repeat(60);
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/paralegal-v2.html#/work?section=invitations');
  await waitForWork(page);
  await page.locator(".v2-work-index").getByRole("link", { name: /Applications/ }).click();
  await waitForWork(page);
  await page.getByLabel("Application saved view").selectOption("saved:saved-litigation");
  await page.locator(".v2-work-index").getByRole("link", { name: /Invitations/ }).click();
  await waitForWork(page);
  const invite = page.locator(`[data-work-invite-id="${INVITE_CASE_ID}"]`);
  const scope = invite.locator('details');
  await scope.locator('summary').click();
  const description = invite.locator('.v2-work-invite-description');
  await description.scrollIntoViewIfNeeded();
  await scope.locator('summary').evaluate(el => el.focus({ preventScroll: true }));
  await page.evaluate(() => document.fonts.ready);
  const top = await description.evaluate(el => el.getBoundingClientRect().top);
  const reads = state.dashboardReads;
  state.invites.unshift({ ...state.invites[0], _id: '64b000000000000000001009', caseId: '64b000000000000000001009', title: 'Another invitation', details: 'New scope' });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { sourceId: 'invitation-refresh-test', accessMayChange: true } })));
  await expect.poll(() => state.dashboardReads).toBeGreaterThan(reads);
  await expect(page.getByRole('heading', { name: 'Another invitation', exact: true })).toBeVisible();
  await expect(scope).toHaveAttribute('open', '');
  await expect(scope.locator('summary')).toBeFocused();
  await expect.poll(() => description.evaluate((el, previousTop) => Math.abs(el.getBoundingClientRect().top - previousTop), top)).toBeLessThan(2);
  await scope.locator('summary').click();
  state.invites[0].title = 'Updated invitation';
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { sourceId: 'invitation-refresh-test', accessMayChange: true } })));
  await expect(page.getByRole('heading', { name: 'Updated invitation', exact: true })).toBeVisible();
  await expect(scope).not.toHaveAttribute('open', '');
  state.invites = state.invites.filter(item => item.caseId !== INVITE_CASE_ID);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh', { detail: { sourceId: 'invitation-refresh-test', accessMayChange: true } })));
  await expect(invite).toHaveCount(0);
});

}

test('office polish: assigned work and invitation actions remain readable in both themes', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await installWorkProjection(page);
  await page.goto('/paralegal-v2.html#/work');
  await waitForWork(page);
  await require('./office-polish-review').reviewOffice(page, testInfo, 'work');
  for (const [label, name] of [['Applications', 'work-applications'], ['Invitations', 'work-invitations'], ['History', 'work-history']]) {
    await page.locator('.v2-work-index').getByRole('link', { name: new RegExp(label) }).click();
    await waitForWork(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
    await require('./office-polish-review').reviewOffice(page, testInfo, name, { widths: [1440, 320] });
  }
  await page.getByRole('link', { name: 'Active Matters', exact: true }).click();
  await waitForWork(page);
  await page.locator('.v2-work-index').getByRole('link', { name: /Invitations/ }).click();
  await waitForWork(page);
  await page.locator('.v2-work-invite-scope summary').click();
  await require('./office-polish-review').reviewOffice(page, testInfo, 'work-invitation-scope', { widths: [1440, 320] });
});

test('office polish: invitation confirmation stays readable without making a decision', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await installWorkProjection(page);
  let decisions = 0;
  await page.route(`**/api/cases/${INVITE_CASE_ID}/invite/decline`, route => { decisions++; return json(route, { success: true }); });
  await page.goto('/paralegal-v2.html#/work?section=invitations');
  await waitForWork(page);
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await require('./office-polish-review').reviewOffice(page, testInfo, 'invitation-confirmation', { widths: [1440, 320] });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(decisions).toBe(0);
});

async function reviewEmptyApplications(page, info, name) {
  for (const [width, dark, enlarged] of [[1440, false, false], [390, false, false], [1440, true, false], [768, true, false], [320, true, true]]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(({ dark, enlarged }) => {
      document.documentElement.classList.toggle('theme-dark', dark);
      document.documentElement.style.fontSize = enlarged ? '200%' : '';
      document.querySelector('[data-v2-route-outlet]').scrollTop = 0;
    }, { dark, enlarged });
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.evaluate(() => {
      const outlet = document.querySelector('[data-v2-route-outlet]');
      return document.documentElement.scrollWidth <= innerWidth + 1 && outlet.scrollWidth <= outlet.clientWidth + 1;
    })).toBe(true);
    const controls = page.locator('[data-v2-work] :is(a,button,input,select,summary):visible');
    for (const control of await controls.all()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({ page }).include('[data-v2-work]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${name}-${width}-${dark ? 'dark' : 'light'}-${enlarged ? '200' : '100'}.png`), fullPage: true });
  }
}

test('empty Applications has one content Browse action and no unused filters or view controls', async ({ page }, info) => {
  await installWorkProjection(page, { applications: [], views: [] });
  await page.goto('/paralegal-v2.html#/work?section=applications'); await waitForWork(page);
  const work = page.locator('[data-v2-work]');
  await expect(work.getByRole('link', { name: 'Browse matters', exact: true })).toHaveCount(1);
  await expect(work.getByText('No applications yet.', { exact: true })).toHaveCount(1);
  await expect(work.locator('.v2-work-filter-panel, .v2-work-saved-manager')).toHaveCount(0);
  await expect(work.getByRole('navigation', { name: 'Applications pages' })).toHaveCount(0);
  await reviewEmptyApplications(page, info, 'empty-applications');
  await page.evaluate(() => { window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.emptyWorkIdentity = 'retained'; });
  const origin = new URL(page.url()).origin;
  const browseRead = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === '/api/jobs/open' && url.searchParams.get('view') === 'browse';
  });
  await work.getByRole('link', { name: 'Browse matters', exact: true }).click();
  const response = await browseRead;
  expect(response.ok()).toBe(true);
  const browse = await response.json();
  // Browse canonicalizes the URL with the server-returned account filters.
  // Assert the settled destination instead of racing its initial bare hash.
  await expect(page).toHaveURL(url => url.origin === origin && url.pathname === '/paralegal-v2.html'
    && url.hash.split('?')[0] === '#/browse'
    && (new URLSearchParams(url.hash.split('?')[1]).get('state') || '') === browse.filters.state);
  await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', 'browse');
  await expect(page.getByRole('region', { name: 'Browse matters', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.emptyWorkIdentity)).toBe('retained');
});

test('saved application view selection retains an immediately opened manager', async ({ page }) => {
  await installWorkProjection(page, { applications: [] });
  await page.goto('/paralegal-v2.html#/work?section=applications'); await waitForWork(page);
  const manager = page.locator('.v2-work-saved-manager');
  await expect(manager).toHaveJSProperty('open', false);
  await manager.evaluate(element => {
    element.open = true;
    const select = element.querySelector('select');
    select.focus(); select.value = 'saved:saved-litigation';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(manager).toHaveJSProperty('open', true);
  await expect(page.getByLabel('Application saved view')).toBeFocused();
  await expect(page.getByLabel('Application practice area')).toHaveValue('Civil Litigation');
});

test('empty Applications keeps saved filters editable and restores focus after saving and deleting the last view', async ({ page }, info) => {
  const view = { id: 'saved-litigation', scope: 'paralegal_applications', name: 'Litigation', filters: { search: '', status: 'submitted', practice: 'Civil Litigation', dateRange: 'all', sort: 'oldest' } };
  const state = await installWorkProjection(page, { applications: [], views: [view] });
  let saves = 0, deletes = 0;
  await page.route(url => url.pathname === '/api/account/dashboard-views', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON(); saves++;
    expect(body).toMatchObject({ scope: 'paralegal_applications', name: 'Retained scope', filters: { ...view.filters, sort: 'matter' } });
    const saved = { ...body, id: 'saved-retained' }; state.views.push(saved); return json(route, { view: saved });
  });
  await page.route('**/api/account/dashboard-views/paralegal_applications/*', route => {
    expect(route.request().method()).toBe('DELETE'); deletes++;
    state.views = state.views.filter(view => view.id !== new URL(route.request().url()).pathname.split('/').pop()); return json(route, { ok: true });
  });
  await page.goto('/paralegal-v2.html#/work?section=applications'); await waitForWork(page);
  const manager = page.locator('.v2-work-saved-manager'), selected = page.getByLabel('Application saved view');
  await expect(manager).toHaveJSProperty('open', false); await expect(selected).toBeHidden();
  await manager.locator('summary').focus(); await manager.locator('summary').press('Enter');
  await selected.focus(); await selected.selectOption('saved:saved-litigation');
  await expect(manager).toHaveJSProperty('open', true); await expect(selected).toBeFocused();
  await expect(page.getByLabel('Application status', { exact: true })).toHaveValue('submitted');
  await expect(page.getByLabel('Application practice area')).toHaveValue('Civil Litigation');
  await selected.selectOption('custom'); await expect(selected).toBeFocused();
  await page.getByLabel('Sort applications').selectOption('matter');
  await reviewEmptyApplications(page, info, 'empty-saved-views');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save application view', exact: true });
  const name = dialog.getByRole('textbox', { name: 'Saved view name', exact: true });
  expect(await name.getAttribute('placeholder')).toBeNull(); await name.fill('Retained scope');
  const bounds = await dialog.boundingBox(); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(321);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({ page }).include('.v2-work-save-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath('save-view-320-dark-200.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(selected).toHaveValue('saved:saved-retained'); await expect(selected).toBeFocused(); expect(saves).toBe(1);
  for (const id of ['saved-retained', 'saved-litigation']) {
    await selected.selectOption(`saved:${id}`); await page.getByRole('button', { name: 'Delete view', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete saved view?', exact: true }).getByRole('button', { name: 'Delete view', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  expect(deletes).toBe(2); expect(state.views).toEqual([]);
  await expect(manager).toHaveCount(0); await expect(page.locator('.v2-work-filter-panel')).toHaveCount(0);
  await expect(page.locator('#v2-work-applications')).toBeFocused();
  const query = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
  expect(query.get('appStatus')).toBeNull(); expect(query.get('appPractice')).toBeNull(); expect(query.get('appRange')).toBe('30');
});

test('Applications with unmatched filters keeps working filters and can show the retained records again', async ({ page }, info) => {
  await installWorkProjection(page, { views: [] });
  await page.goto('/paralegal-v2.html#/work?section=applications&appQuery=Unmatched&appRange=all'); await waitForWork(page);
  await expect(page.getByText('No applications match your filters.', { exact: true })).toBeVisible();
  await expect(page.locator('.v2-work-filter-fields')).toBeVisible(); await expect(page.locator('.v2-work-saved-manager')).toHaveCount(0);
  await reviewEmptyApplications(page, info, 'filtered-empty-applications');
  await page.getByRole('searchbox', { name: 'Search applications', exact: true }).fill('');
  await expect(page.getByRole('heading', { name: 'Discovery chronology review', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search applications', exact: true })).toBeFocused();
});

test('empty Applications distinguishes failed application and saved-view reads and recovers each source', async ({ page }) => {
  const state = await installWorkProjection(page, { applications: [], views: [] });
  let failed = '/api/applications/my';
  await page.route(url => ['/api/applications/my', '/api/account/dashboard-views'].includes(url.pathname), route => new URL(route.request().url()).pathname === failed ? json(route, {}, 503) : route.fallback());
  await page.goto('/paralegal-v2.html#/work?section=applications'); await waitForWork(page);
  await expect(page.getByText('Your applications couldn’t load.', { exact: true })).toBeVisible();
  await expect(page.getByText('No applications yet.', { exact: true })).toHaveCount(0);
  failed = '/api/account/dashboard-views'; await page.locator('#v2-work-applications').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No applications yet.', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved views couldn’t load.', { exact: true })).toBeVisible();
  await expect(page.locator('#v2-work-applications')).toBeFocused();
  await expect(page.locator('.v2-work-saved-manager, .v2-work-filter-fields')).toHaveCount(0);
  state.views = [{ id: 'recovered-view', scope: 'paralegal_applications', name: 'Retained view', filters: { search: '', status: 'all', practice: 'all', dateRange: 'all', sort: 'newest' } }];
  failed = ''; await page.locator('#v2-work-applications').getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Saved views couldn’t load.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No applications yet.', { exact: true })).toBeVisible();
  await expect(page.locator('.v2-work-saved-manager')).toHaveJSProperty('open', false);
  await expect(page.locator('.v2-work-saved-manager > summary')).toBeFocused();
});

test('an application arriving after an empty screen restores filters without discarding the retained query', async ({ page }) => {
  const state = await installWorkProjection(page, { applications: [], views: [] });
  await page.goto('/paralegal-v2.html#/work?section=applications&appPractice=Probate&appStatus=submitted&appRange=all'); await waitForWork(page);
  await expect(page.locator('.v2-work-filter-panel')).toHaveCount(0);
  state.applications = [{ _id: APPLICATION_ID, status: 'submitted', createdAt: '2026-09-12T12:00:00Z', jobId: { _id: APPLICATION_JOB_ID, title: 'New probate application', practiceArea: 'Probate', status: 'open', budget: 400 } }];
  await page.evaluate(() => window.dispatchEvent(new MessageEvent('lpc:notifications-refreshed', { data: JSON.stringify({ type: 'application_submitted_refresh' }) })));
  await expect(page.getByRole('heading', { name: 'New probate application', exact: true })).toBeVisible();
  await expect(page.getByLabel('Application practice area')).toHaveValue('Probate'); await expect(page.getByLabel('Application status', { exact: true })).toHaveValue('submitted');
  await expect(page.locator('.v2-work-filter-panel')).toBeVisible(); await expect(page.getByText('No applications yet.', { exact: true })).toHaveCount(0);
});

test('saving an application view preserves navigation focus chosen during its refresh', async ({ page }) => {
  const state = await installWorkProjection(page);
  let release, arrived, saved = false;
  const gate = new Promise(resolve => { release = resolve; }), refreshing = new Promise(resolve => { arrived = resolve; });
  await page.route(url => url.pathname === '/api/account/dashboard-views', async route => {
    if (route.request().method() === 'POST') { const view = { ...route.request().postDataJSON(), id: 'saved-pending' }; state.views.push(view); saved = true; return json(route, { view }); }
    if (saved) { arrived(); await gate; }
    return route.fallback();
  });
  await page.goto('/paralegal-v2.html#/work?section=applications'); await waitForWork(page);
  try {
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Save application view', exact: true }); await dialog.getByRole('textbox').fill('Pending refresh');
    await dialog.getByRole('button', { name: 'Save view', exact: true }).click(); await refreshing;
    await expect(dialog).toHaveCount(0); const home = page.getByRole('link', { name: 'LPC Home', exact: true }); await home.focus(); release();
    await expect(page.getByLabel('Application saved view')).toHaveValue('saved:saved-pending'); await expect(home).toBeFocused();
  } finally { release(); }
});

for (const entry of ['v2', 'current']) for (const outcome of ['confirmed', 'lost', 'stale']) test(`${entry} earlier application withdrawal ${outcome} retains history and requires explicit recovery`, async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = await installWorkProjection(page); let writes = 0, recoveryReads = 0;
  const selected = state.applications[0];
  Object.assign(selected, { _id: '', id: '', applicationSource: 'case_applicant', status: 'submitted', pending: true, preEngagement: null, withdrawal: { available: true, revision: 'a'.repeat(64) } });
  state.applications = [selected];
  await page.route(url => url.pathname === '/api/applications/my', route => { if (new URL(route.request().url()).searchParams.has('expectedOwnerId')) recoveryReads++; return json(route, state.applications); });
  await page.route('**/api/csrf', route => json(route, { csrfToken: 'synthetic-csrf' }));
  const viewer = (await (await page.request.get('/api/auth/me')).json()).user;
  await page.route(`**/api/applications/earlier/${PRE_CASE_ID}/revoke`, async route => {
    writes++; const body = route.request().postDataJSON(); expect(body.expectedOwnerId).toBe(String(viewer.id || viewer._id));
    expect(body.expectedRevision).toBe(writes === 1 ? 'a'.repeat(64) : 'b'.repeat(64));
    if (outcome === 'stale' && writes === 1) {
      selected.withdrawal.revision = 'b'.repeat(64);
      selected.coverLetter = 'Updated saved application details to review before withdrawing.';
      return json(route, { code: 'APPLICATION_CONFLICT', error: 'This application changed.' }, 409);
    }
    Object.assign(selected, { status: 'withdrawn', pending: false, withdrawal: { available: false, revision: null }, statusHistory: [{ from: 'pending', to: 'withdrawn', at: '2026-09-12T12:00:00.000Z' }] });
    return outcome === 'lost' ? json(route, { error: 'The withdrawal result could not be confirmed.' }, 503) : json(route, { success: true, caseId: PRE_CASE_ID, status: 'withdrawn', alreadyRevoked: false });
  });
  await page.goto(entry === 'current' ? `/dashboard-paralegal.html?jobId=${APPLICATION_JOB_ID}#cases` : `/paralegal-v2.html#/work?jobId=${APPLICATION_JOB_ID}`);
  if (entry === 'v2') await waitForWork(page);
  const details = entry === 'current' ? page.locator('#applicationDetailModal') : page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  await expect(details).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Discovery chronology review', exact: true })).toHaveCount(1);
  await expect(details).toContainText('I can complete the requested litigation review on schedule.');
  await details.getByRole('button', { name: 'Withdraw application', exact: true }).click();
  const confirmation = entry === 'current' ? page.locator('#revokeConfirmModal') : page.getByRole('dialog', { name: 'Withdraw this application?', exact: true });
  if (outcome === 'confirmed') for (const theme of ['light', 'dark']) for (const [width, size] of [[1366, '100%'], [320, '100%'], [390, '200%']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ theme, size }) => { if (window.applyThemePreference) window.applyThemePreference(theme); else document.documentElement.classList.toggle('theme-dark', theme === 'dark'); document.documentElement.style.fontSize = size; }, { theme, size });
    const confirm = confirmation.getByRole('button', { name: 'Withdraw application', exact: true });
    await confirm.scrollIntoViewIfNeeded();
    const box = await confirm.boundingBox(); expect(Math.round(box.height * 100) / 100).toBeGreaterThanOrEqual(44); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1); expect(box.y + box.height).toBeLessThanOrEqual(901);
    expect(await confirmation.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include(entry === 'current' ? '#revokeConfirmModal' : '.v2-work-confirm-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`earlier-${entry}-confirmation-${theme}-${width}-${size}.png`) });
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.evaluate(() => { if (window.applyThemePreference) window.applyThemePreference('light'); else document.documentElement.classList.remove('theme-dark'); document.documentElement.style.fontSize = '100%'; });
  await confirmation.getByRole('button', { name: 'Withdraw application', exact: true }).click();
  if (outcome !== 'confirmed') {
    await expect(confirmation.getByRole('button', { name: 'Review saved application', exact: true })).toBeVisible();
    expect(writes).toBe(1); expect(recoveryReads).toBe(0);
    await confirmation.getByRole('button', { name: 'Review saved application', exact: true }).click();
    if (outcome === 'stale') {
      await expect(confirmation).toBeHidden();
      await expect(details).toContainText('Updated saved application details to review before withdrawing.');
      await details.getByRole('button', { name: 'Withdraw application', exact: true }).click();
      await expect(confirmation.getByRole('button', { name: 'Withdraw application', exact: true })).toBeEnabled();
      expect(writes).toBe(1);
      await confirmation.getByRole('button', { name: 'Withdraw application', exact: true }).click();
    }
  }
  await expect(confirmation).toBeHidden(); expect(writes).toBe(outcome === 'stale' ? 2 : 1);
  if (entry === 'current') await openCurrentApplicationFromList(page);
  else {
    await page.locator('.v2-work-index').getByRole('link', { name: /Applications/ }).click();
    await page.getByLabel('Application saved view').selectOption('built:all');
    await page.locator(`[data-work-job-id="${APPLICATION_JOB_ID}"]`).getByRole('button', { name: 'Details', exact: true }).click();
  }
  await expect(details).toBeVisible(); await expect(details).toContainText('Withdrawn');
  await expect(details.getByRole('button', { name: 'Withdraw application', exact: true })).toBeHidden();
  expect(errors).toEqual([]);
  if (outcome === 'confirmed') for (const theme of ['light', 'dark']) for (const [width, size] of [[1366, '100%'], [320, '100%'], [390, '200%']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ theme, size }) => { if (window.applyThemePreference) window.applyThemePreference(theme); else document.documentElement.classList.toggle('theme-dark', theme === 'dark'); document.documentElement.style.fontSize = size; }, { theme, size });
    const close = details.getByRole('button', { name: 'Close application details', exact: true });
    await close.focus(); await expect(close).toBeFocused();
    const box = await close.boundingBox(); expect(Math.round(box.height * 100) / 100).toBeGreaterThanOrEqual(44); expect(Math.round(box.width * 100) / 100).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1); expect(box.y + box.height).toBeLessThanOrEqual(901);
    expect(await details.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include(entry === 'current' ? '#applicationDetailModal' : '.v2-work-application-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`earlier-${entry}-history-${theme}-${width}-${size}.png`) });
  }
  if (entry === 'current' && outcome === 'confirmed') {
    await details.getByText('Matter details', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('earlier-current-history-dark-390-200%-scrolled.png') });
    await details.getByRole('button', { name: 'Close application details', exact: true }).click();
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '100%'; });
    const card = page.locator('.applied-card').filter({ hasText: 'Discovery chronology review' });
    await card.hover();
    const background = await card.evaluate(node => getComputedStyle(node).backgroundColor);
    expect(background).not.toMatch(/rgba?\(\s*2[345]\d,\s*2[345]\d,\s*2[345]\d/);
    expect((await new AxeBuilder({ page }).include('.applied-card').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath('earlier-current-history-dark-highlighted-card.png') });
  }
});

for (const entry of ['current', 'v2']) for (const outcome of ['confirmed', 'unconfirmed']) test(`${entry} earlier application withdrawal ${outcome} keeps its pending decision after closing and reopening`, async ({ page }) => {
  const state = await installWorkProjection(page); const selected = state.applications[0];
  Object.assign(selected, { _id: '', id: '', applicationSource: 'case_applicant', preEngagement: null, withdrawal: { available: true, revision: 'a'.repeat(64) } });
  state.applications = [selected]; let writes = 0, release;
  const held = new Promise(resolve => release = resolve);
  await page.route(url => url.pathname === '/api/applications/my', route => json(route, state.applications));
  await page.route('**/api/csrf', route => json(route, { csrfToken: 'synthetic-csrf' }));
  await page.route(`**/api/applications/earlier/${PRE_CASE_ID}/revoke`, async route => {
    writes++; await held; Object.assign(selected, { status: 'withdrawn', pending: false, withdrawal: { available: false } });
    return outcome === 'unconfirmed' ? json(route, { error: 'The withdrawal result could not be confirmed.' }, 503) : json(route, { success: true, status: 'withdrawn', caseId: PRE_CASE_ID, alreadyRevoked: false });
  });
  await page.goto(entry === 'current' ? `/dashboard-paralegal.html?jobId=${APPLICATION_JOB_ID}#cases` : `/paralegal-v2.html#/work?jobId=${APPLICATION_JOB_ID}`);
  if (entry === 'v2') await waitForWork(page);
  const details = entry === 'current' ? page.locator('#applicationDetailModal') : page.getByRole('dialog', { name: 'Discovery chronology review', exact: true });
  const confirmation = entry === 'current' ? page.locator('#revokeConfirmModal') : page.getByRole('dialog', { name: 'Withdraw this application?', exact: true });
  await details.getByRole('button', { name: 'Withdraw application', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Withdraw application', exact: true }).click(); await expect.poll(() => writes).toBe(1);
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  if (entry === 'v2') await page.locator(`[data-work-job-id="${APPLICATION_JOB_ID}"]`).getByRole('button', { name: 'Details', exact: true }).click();
  await details.getByRole('button', { name: 'Withdraw application', exact: true }).click();
  await expect(confirmation.getByRole('button', { name: 'Checking…', exact: true })).toBeDisabled();
  release();
  if (outcome === 'unconfirmed') await confirmation.getByRole('button', { name: 'Review saved application', exact: true }).click();
  await expect(confirmation).toBeHidden(); expect(writes).toBe(1);
});

for (const width of [1366, 390]) test(`invitation destination selects its exact pending scope in a long list at ${width}px`, async ({ page }, info) => {
  const invites = Array.from({ length: 107 }, (_, index) => ({
    _id: (2000 + index).toString(16).padStart(24, '0'), caseId: (2000 + index).toString(16).padStart(24, '0'),
    title: `Pending filing invitation ${index + 1}`, details: `Review the filing evidence for invitation ${index + 1}.`,
    tasks: [{ title: 'Check the exhibit references' }], practiceArea: 'Immigration', totalAmount: 40000,
    inviteInvitedAt: '2026-09-01T14:00:00.000Z', attorney: { firstName: 'Jordan', lastName: 'Lee' },
  }));
  await installWorkProjection(page, { invites });
  const target = invites.at(-1), errors = [], mutations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET' && /\/api\/(?:cases|applications)\//.test(request.url())) mutations.push(request.url()); });
  await page.setViewportSize({ width, height: 900 });
  for (const alias of ['matterId', 'highlightCase']) {
    await page.goto('about:blank');
    await page.goto(`/paralegal-v2.html#/work?section=invitations&${alias}=${target.caseId}`);
    await waitForWork(page);
    const row = page.locator(`[data-work-invite-id="${target.caseId}"]`);
    await expect(row.locator('details')).toHaveAttribute('open', '');
    await expect(row.getByRole('heading', { name: target.title, exact: true })).toBeFocused();
    await expect(page.locator('[data-work-invite-id] details[open]')).toHaveCount(1);
    const titleBox = await row.getByRole('heading', { name: target.title, exact: true }).boundingBox();
    const outletBox = await page.locator('[data-v2-route-outlet]').boundingBox();
    const rowBox = await row.boundingBox();
    // Start at the requested invitation, allowing the natural end-of-list limit.
    expect(rowBox.y).toBeLessThanOrEqual(Math.max(outletBox.y, outletBox.y + outletBox.height - rowBox.height) + 24);
    expect(titleBox.y).toBeGreaterThanOrEqual(outletBox.y);
    expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(outletBox.y + outletBox.height);
    await expect(row).toContainText(target.details);
    await page.screenshot({ path: info.outputPath(`target-invitation-${width}-${alias}.png`) });
  }
  await page.goto('about:blank');
  await page.goto('/paralegal-v2.html#/work?section=invitations&matterId=000000000000000000999999');
  await waitForWork(page);
  await expect(page.getByRole('status').filter({ hasText: 'This invitation is no longer in your pending invitations.' })).toBeVisible();
  await expect(page.locator('[data-work-invite-id] details[open]')).toHaveCount(0);
  expect(errors).toEqual([]); expect(mutations).toEqual([]);
});

test('original invitation navigation keeps its native transition with a delayed HTML head', async ({ page }, info) => {
  const state = await installWorkProjection(page), errors = [], events = [];
  page.on('pageerror', error => errors.push({ name: error.name, message: error.message }));
  page.on('console', message => { if (message.text().startsWith('INVITATION_NAVIGATION ')) events.push(JSON.parse(message.text().slice('INVITATION_NAVIGATION '.length))); });
  await page.addInitScript(() => {
    const report = (type, extra = {}) => console.debug('INVITATION_NAVIGATION ' + JSON.stringify({ type, at: Date.now(), page: location.href, readyState: document.readyState, styles: [...document.styleSheets].map(sheet => sheet.href), ...extra }));
    for (const type of ['pagereveal', 'pageswap']) addEventListener(type, event => report(type, { transition: !!event.viewTransition }));
    addEventListener('unhandledrejection', event => report('unhandledrejection', { message: String(event.reason) }));
  });
  await page.setViewportSize({ width: 390, height: 900 });
  try {
    await page.goto('/dashboard-paralegal.html#home');
    await expect(page.locator('[data-lpc-universal-header="true"]')).toBeVisible();
    await page.evaluate(destination => location.assign(destination), `/dashboard-paralegal.html?inviteCase=${state.invites[0]._id}&slowHead=1#home`);
    const review = page.locator('#inviteOverlay [role="dialog"]');
    await expect(review).toBeVisible();
    await expect(review).toContainText(state.invites[0].title);
    await page.screenshot({ path: info.outputPath('original-invitation-slow-head.png') });
    expect(errors).toEqual([]);
    expect(events.filter(event => event.type === 'unhandledrejection')).toEqual([]);
    if (info.project.name === 'chromium') expect(events.some(event => event.type === 'pagereveal' && event.page.includes('slowHead=1') && event.transition)).toBe(true);
  } finally {
    await require('node:fs/promises').writeFile(info.outputPath('invitation-navigation.json'), JSON.stringify({ errors, events }, null, 2));
  }
});


test('opening a Matter returns to its inventory page with application filters retained', async ({page})=>{
 await installWorkProjection(page);
 const matters=Array.from({length:7},(_,i)=>({caseId:(1800+i).toString(16).padStart(24,'0'),jobTitle:`Inventory Matter ${i}`,status:'in progress',practiceArea:'Civil Litigation',attorneyName:'Jordan Lee'}));
 await page.route(/\/api\/paralegal\/dashboard(?:\?|$)/,route=>json(route,{metrics:{activeCases:7},activeCases:matters}));
 const chosen=matters[4];
 await page.route(url=>url.pathname===`/api/cases/${chosen.caseId}`,route=>json(route,{_id:chosen.caseId,title:chosen.jobTitle,status:'in progress',matterExperience:{header:{title:chosen.jobTitle,status:{label:'In progress'}},sections:[{id:'overview',label:'Overview'}],overview:{summary:'Review the agreed work.',attorney:'Jordan Lee'},work:{readOnly:false}}}));
 await page.goto('/paralegal-v2.html#/work?section=active&appQuery=discovery&appStatus=submitted&appPage=2');
 await waitForWork(page);
 await page.getByRole('navigation',{name:'Active Matters pages'}).getByRole('button',{name:'Next',exact:true}).click();
 const selected=page.locator(`[data-work-case-id="${chosen.caseId}"]`);
 await expect(selected).toBeVisible();
 await selected.getByRole('link',{name:'Open workspace',exact:true}).click();
 const back=page.getByRole('link',{name:'Back to Matters',exact:true});await expect(back).toBeVisible();
 const query=new URLSearchParams((await back.getAttribute('href')).split('?')[1]);
 expect(query.get('highlightCase')).toBe(chosen.caseId);expect(query.get('appQuery')).toBe('discovery');expect(query.get('appStatus')).toBe('submitted');expect(query.get('appPage')).toBe('2');
 await back.click();await waitForWork(page);
 await expect(selected).toBeVisible();
 await expect(page.getByRole('navigation',{name:'Active Matters pages'})).toContainText('4–6 of 7');
});


test('saved application writes bind the viewed account, reuse a request ID and reject a stale delete',async({page})=>{
 const state=await installWorkProjection(page,{views:[]});
 const viewer=(await (await page.request.get('/api/auth/me')).json()).user;
 const ownerId=String(viewer.id||viewer._id),requests=[];let deletes=0;
 await page.route(url=>url.pathname==='/api/account/dashboard-views',route=>{
  if(route.request().method()!=='POST')return route.fallback();
  const body=route.request().postDataJSON();requests.push(body);
  expect(body.expectedOwnerId).toBe(ownerId);expect(body.revision).toBeNull();expect(body.id).toMatch(/^[a-f0-9-]{36}$/);
  if(requests.length===1)return json(route,{error:'Temporarily unavailable'},503);
  expect(body).toEqual(requests[0]);const view={...body,revision:'b'.repeat(64)};state.views=[view];return json(route,{view});
 });
 await page.route('**/api/account/dashboard-views/paralegal_applications/*',route=>{deletes++;expect(route.request().postDataJSON()).toEqual({expectedOwnerId:ownerId,revision:'b'.repeat(64)});return json(route,{error:'This saved view changed. Refresh before deleting it.',code:'SAVED_VIEW_CONFLICT'},409);});
 await page.goto('/paralegal-v2.html#/work?section=applications');await waitForWork(page);
 await page.getByRole('button',{name:'Save view',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Save application view',exact:true});
 await dialog.getByRole('textbox',{name:'Saved view name',exact:true}).fill('Reviewed filters');
 await dialog.getByRole('button',{name:'Save view',exact:true}).click();await expect(page.locator('[data-v2-toast-region]')).toContainText('Temporarily unavailable');
 await expect(dialog.getByRole('textbox',{name:'Saved view name',exact:true})).toHaveValue('Reviewed filters');
 await dialog.getByRole('button',{name:'Save view',exact:true}).click();await expect(dialog).toHaveCount(0);
 await expect(page.getByLabel('Application saved view')).toHaveValue('saved:'+requests[0].id);
 await page.getByRole('button',{name:'Delete view',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Delete view',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('This saved view changed');expect(deletes).toBe(1);expect(state.views).toHaveLength(1);
});
