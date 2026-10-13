const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const { inventoryFixture } = require('./inventory-fixture');
const json = (route, payload, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
const objectId = (n) => n.toString(16).padStart(24, "0");
const entry = "/attorney-v2.html";
const region = (page, name) => page.locator(`[data-av2-region="${name}"]`);
const loaded = (page, name) => expect(region(page, name)).toHaveAttribute("data-state", "ready");
function matter(n, overrides = {}) {
  return { id: objectId(n), title: `Synthetic Matter ${String(n).padStart(2, "0")}`, status: "open", practiceArea: "Civil Litigation", archived: false, paymentReleased: false, applicantsCount: 0, filesCount: 0, files: [], invites: [], tasks: [], totalAmount: 10005, remainingAmount: 10005, currency: "usd", createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z", details: "Synthetic read-only matter description.", ...overrides };
}
function fixtures() {
  const active = Array.from({ length: 18 }, (_, i) => matter(i + 1));
  active[0] = matter(1, { status: "in progress", paralegal: { id: objectId(500), name: "Parker Test" }, escrowStatus: "funded", escrowIntentId: "pi_synthetic", filesCount: 1, files: [{ status: "pending_review" }], deadlineDate: "2026-09-06" });
  active.push(matter(30, { title: "Applicant Matter", applicantsCount: 2, invites: [{ status: "pending" }] }));
  return {
    active,
    home: { revision: "a".repeat(64), counts: { active: 18, applications: 1, draft: 1, archived: 2 }, postedCount: 21,
      attention: { total: 2, page: 1, pages: 1, pageSize: 5, items: [
        { id: objectId(1), title: "Synthetic Matter 01", label: "In Progress", practiceArea: "Civil Litigation", actions: ["files"] },
        { id: objectId(41), title: "Paused Matter", label: "Paused", practiceArea: "Civil Litigation", actions: ["withdrawal"] },
      ] },
      recent: { total: 0, items: [] }, completed: { total: 0, items: [] },
      week: { start: "2026-08-31", end: "2026-09-06", total: 1, page: 1, pages: 1, pageSize: 3, items: [
        { id: objectId(1), title: "Synthetic Matter 01", label: "In Progress", practiceArea: "Civil Litigation", dueDate: "2026-09-06" },
      ] } },
    archived: [matter(40, { title: "Completed Matter", archived: true, status: "completed", paymentReleased: true }), matter(41, { title: "Paused Matter", status: "paused", pausedReason: "paralegal_withdrew", disputeDeadlineAt: "2026-09-05T12:00:00Z" })],
    drafts: { items: [matter(50, { title: "Draft Matter", status: "draft", description: "Draft description" })] },
    applications: [{ id: objectId(60), caseId: objectId(30), jobTitle: "Applicant Matter", paralegal: { id: objectId(61), name: "Applicant One" }, starred: true }],
    dashboard: { metrics: { activeCases: 1, completedCases: 1, openJobs: 18, weekDeadlines: 1, escrowTotal: 10005 }, week: { start: "2026-08-31", end: "2026-09-06", deadlines: [{ caseId: objectId(1), title: "Synthetic Matter 01", dueDate: "2026-09-06" }] } },
    payments: { revision: "a".repeat(64), currencies: [{ currency: "USD", originalFunding: 10005, activeFunds: 10005, pendingCharges: 0, refunds: 0, fundingNeeded: 0, requiresReview: 0, activeMatters: 1, pendingMatters: 0, unfundedMatters: 0, fundingUnknown: false, balanceUnknown: false, pendingUnknown: false }], requiresReview: 0, unsupportedCurrency: false, totalSpent: 10005, activeFunds: 10005, activeEscrow: 10005, pendingCharges: 0, fundingNeeded: 0 },
    payment: { paymentMethod: { id: "pm_synthetic" } },
    profile: { lawFirm: "Synthetic Firm", role: "attorney" },
    overdue: { total: 2, items: [] },
    unread: { count: 3 },
    summary: { items: [{ caseId: objectId(1), unread: 3 }] },
    threads: { total: 1, threads: [{ id: objectId(1), title: "Synthetic Matter 01", unread: 3, lastMessageSnippet: "Synthetic confidential message preview", updatedAt: "2026-09-04T12:00:00Z" }] },
    saved: { views: [{ id: "saved-deadlines", name: "My deadline view", filters: { view: "active", search: "Synthetic Matter 01", practice: "Civil Litigation", sort: "alphabetical" } }] },
  };
}
async function mock(page, data = fixtures()) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  data.payments.ownerId = user.id || user._id;
  data.home.ownerId = user.id || user._id;
  data.saved = { ...data.saved, ownerId: user.id || user._id, scope: "attorney_matters", views: data.saved.views.map(view => ({ ...view, scope: "attorney_matters", revision: "a".repeat(64) })) };
  const paths = {
    "/api/attorney/dashboard": "dashboard", "/api/cases/inventory/home": "home", "/api/case-drafts": "drafts", "/api/applications/my-postings": "applications",
    "/api/payments/summary": "payments", "/api/payments/payment-method/default": "payment", "/api/users/me": "profile",
    "/api/checklist": "overdue", "/api/messages/unread-count": "unread", "/api/messages/summary": "summary", "/api/messages/threads": "threads", "/api/account/dashboard-views": "saved",
  };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/cases/inventory') {
      const failure = data.inventoryFailures?.[url.searchParams.get('view') || 'active'];
      if (failure) return json(route, { error: 'Synthetic private error never displayed' }, failure);
      return json(route, await inventoryFixture(data, user.id || user._id, url.searchParams));
    }
    const key = url.pathname === "/api/cases/my" ? url.searchParams.get("archived") === "true" ? "archived" : "active" : paths[url.pathname];
    if (!key) return route.continue();
    if (data[key]?.httpError) return json(route, { error: "Synthetic private error never displayed" }, data[key].httpError);
    return json(route, data[key]);
  });
  return data;
}

test("real server summaries agree with the new Home, complete Matters and current V1 reads", async ({ page }) => {
  await page.goto(`${entry}#/home`);
  await loaded(page, "overview");
  const owner = (await (await page.request.get('/api/auth/me')).json()).user;
  const homeResponse = await page.request.get(`/api/cases/inventory/home?expectedOwnerId=${owner.id || owner._id}`);
  expect(homeResponse.status()).toBe(200);
  const home = await homeResponse.json();
  for (const [index, key] of ['active', 'applications', 'draft', 'archived'].entries()) {
    await expect(region(page, "overview").locator("dd").nth(index)).toHaveText(String(home.counts[key]));
  }
  const dashboard = await (await page.request.get("/api/attorney/dashboard")).json();
  const payments = await (await page.request.get("/api/payments/summary")).json();
  expect(dashboard.metrics.escrowTotal).toBe(payments.activeFunds);
  await loaded(page, "messages");
  const [unread, summary] = await Promise.all([page.request.get("/api/messages/unread-count"), page.request.get("/api/messages/summary")]);
  const unreadValue = await unread.json();
  expect(unreadValue.count).toBe((await summary.json()).items.reduce((sum, item) => sum + item.unread, 0));
  const inventoryResponse = await page.request.get(`/api/cases/inventory?expectedOwnerId=${owner.id || owner._id}`);
  expect(inventoryResponse.status()).toBe(200); const inventory = await inventoryResponse.json();
  await page.goto(`${entry}#/matters`); await loaded(page, 'matter-list');
  expect(await page.locator('[data-av2-matter]').evaluateAll(rows => rows.map(row => row.dataset.av2Matter))).toEqual(inventory.items.map(item => item.id));
  if (inventory.total) await expect(region(page, 'matter-list')).toContainText(`${inventory.total} matching`);
  else await expect(region(page, 'matter-list')).toContainText('No matters match this view');
  await page.goto("/dashboard-attorney.html");
  await expect(page.locator("#overviewMattersBody")).toHaveAttribute('data-state', 'ready');
  await expect(page.locator("#overviewMattersBody")).toHaveText(home.recent.total ? `${home.recent.total} current` : "No current Matters.");
});

test("populated Home uses exact cents, counts, readiness, and contextual destinations without writes", async ({ page }) => {
  await mock(page);
  const writes = [];
  page.on("request", (request) => { if (request.url().includes("/api/") && request.method() !== "GET") writes.push(request.url()); });
  await page.goto(`${entry}#/home`);
  for (const key of ["overview", "attention", "applications", "messages", "payments", "onboarding"]) await loaded(page, key);
  await expect(region(page, "payments").getByText("$100.05", { exact: true })).toBeVisible();
  await expect(region(page, "messages")).toContainText("3 unread messages");
  await expect(region(page, "attention")).toContainText("2 overdue private tasks");
  await expect(region(page, "applications").locator('.av2-summary-row')).toHaveCount(1);
  await expect(region(page, "applications")).not.toContainText("Some applicant counts differ");
  await expect(region(page, "applications").getByRole("link", { name: "Applicant One" })).toHaveAttribute("href", `#/matters/${objectId(30)}/applications?applicantId=${objectId(61)}&applicationId=${objectId(60)}`);
  await expect(region(page, "attention").getByRole("link", { name: "Review submitted files" })).toHaveAttribute("href", `#/matters/${objectId(1)}/files`);
  await expect(region(page, "attention").getByRole("link", { name: "Review withdrawal and response deadline" })).toHaveAttribute("href", `#/matters/${objectId(41)}/financials`);
  await expect(region(page, "deadlines").getByRole("link", { name: "Synthetic Matter 01" })).toHaveAttribute("href", `#/matters/${objectId(1)}/activity`);
  await expect(region(page, "onboarding")).toContainText("Setup complete.");
  await expect(region(page, "deadlines")).toContainText("Sep 6, 2026");
  expect(writes).toEqual([]);
});

test("matter pagination, filters, saved-view reads, drafts, archive preview and history retain context", async ({ page }) => {
  await mock(page);
  await page.goto(`${entry}#/matters`);
  await loaded(page, "matter-list");
  await expect(page.locator("[data-av2-matter]")).toHaveCount(15);
  await page.getByRole("link", { name: "Next page" }).click();
  await loaded(page, "matter-list");
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator("[data-av2-matter]")).toHaveCount(3);
  await page.reload();
  await loaded(page, "matter-list");
  await expect(page.locator("[data-av2-matter]")).toHaveCount(3);
  await page.getByRole("combobox", { name: "Saved views", exact: true }).selectOption("saved:saved-deadlines");
  await loaded(page, "matter-list");
  await expect(page.locator("[data-av2-matter]")).toHaveCount(1);
  await expect(page.getByRole("searchbox", { name: "Search matters" })).toHaveValue("Synthetic Matter 01");
  await page.goBack();
  await loaded(page, "matter-list");
  await expect(page.locator("[data-av2-matter]")).toHaveCount(3);
  await page.goto(`${entry}#/matters?view=draft`);
  await loaded(page, "matter-list");
  await expect(page.getByRole("link", { name: "Draft Matter", exact: true })).toHaveAttribute("href", `#/matters/new?draftId=${objectId(50)}&step=description&returnTo=${encodeURIComponent("#/matters?view=draft")}`);
  await page.goto(`${entry}#/matters?view=archived&highlightCase=${objectId(40)}&previewCaseId=${objectId(40)}`);
  await loaded(page, "matter-list");
  await expect(page.locator(".av2-highlighted details").filter({ has: page.getByText("Preview matter", { exact: true }) })).toHaveAttribute("open", "");
  await expect(page.getByRole("group", { name: "Actions for Completed Matter", exact: true })).not.toHaveAttribute("open", "");
  await expect(page.locator(".av2-highlighted")).toContainText("Synthetic read-only matter description.");
  await page.getByRole("combobox", { name: "Archive status", exact: true }).selectOption("paused");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await loaded(page, "matter-list");
  await expect(page.locator("[data-av2-matter]")).toHaveCount(1);
  await expect(page.locator("[data-av2-matter]")).toContainText("Paused Matter");
});

test("zero, complete and missing-target lists remain honest and filterable", async ({ page }) => {
  const data = await mock(page);
  data.active = []; data.archived = []; data.drafts = { items: [] }; data.applications = [];
  await page.goto(`${entry}#/matters?previewCaseId=${objectId(99)}`);
  await loaded(page, "matter-list");
  await expect(region(page, "matter-list")).toContainText("No matters match this view");
  await expect(region(page, "matter-list")).toContainText("The linked matter is not on this page");
  data.active = Array.from({ length: 100 }, (_, index) => matter(index + 1));
  await page.getByRole("button", { name: "Refresh matters", exact: true }).click();
  await loaded(page, "matter-list");
  await expect(region(page, "matter-list")).toContainText("100 matching matters");
  await expect(region(page, "matter-list")).not.toContainText("more records may exist");
  await page.getByRole("searchbox", { name: "Search matters" }).fill("No match");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await loaded(page, "matter-list");
  await expect(page.locator("[data-av2-matter]")).toHaveCount(0);
  await expect(region(page, "matter-list")).toContainText("No matters match this view");
});

test("errors and restricted categories never masquerade as empty data and can recover", async ({ page }) => {
  const data = await mock(page);
  const originalActive = data.active;
  data.active = { httpError: 403 };
  data.unread = { httpError: 503 };
  await page.goto(`${entry}#/home`);
  await expect(region(page, "messages")).toHaveAttribute("data-state", "error");
  await loaded(page, "overview");
  await expect(region(page, "messages")).not.toContainText("caught up");
  await expect(page.getByText("Synthetic private error never displayed")).toHaveCount(0);
  data.active = originalActive; data.inventoryFailures = { active: 403 };
  await page.goto(`${entry}#/matters`);
  await expect(region(page, "matter-list")).toHaveAttribute('data-state', 'error');
  await expect(region(page, "matter-list")).toContainText("no longer available to your account");
  await expect(region(page, "matter-list")).not.toContainText("0 matching");
  await page.getByRole("navigation", { name: "Matter categories" }).getByRole("link", { name: /Archived/ }).click();
  await loaded(page, "matter-list");
  await expect(page.locator("[data-av2-matter]")).toHaveCount(2);
  data.inventoryFailures = {};
  await page.getByRole("navigation", { name: "Matter categories" }).getByRole("link", { name: /Active/ }).click();
  await loaded(page, "matter-list");
  await expect(page.locator("[data-av2-matter]")).toHaveCount(15);
});

test("unread and financial disagreements suppress an unverified aggregate", async ({ page }) => {
  const data = await mock(page);
  data.unread.count = 99; data.payments.activeFunds = 99999;
  await page.goto(`${entry}#/home`);
  await loaded(page, "messages"); await expect(region(page, "payments")).toHaveAttribute("data-state", "error");
  await expect(region(page, "messages")).toContainText("Unread counts are updating");
  await expect(region(page, "messages")).not.toContainText("99 unread");
  await expect(region(page, "payments")).toContainText("couldn’t be loaded");
  await expect(region(page, "payments").getByText("$999.99")).toHaveCount(0);
  data.unread.count = 3; data.payments.activeFunds = 10005;
  await page.getByRole("button", { name: "Refresh messages", exact: true }).click();
  await loaded(page, "messages");
  await expect(region(page, "messages")).toContainText("3 unread messages");
  await page.getByRole("button", { name: "Refresh payments", exact: true }).click();
  await loaded(page, "payments");
  await expect(region(page, "payments").getByText("$100.05", { exact: true })).toBeVisible();
});

test("onboarding skip, replay, navigation and refreshed completion preserve progress", async ({ page }) => {
  const data = await mock(page);
  data.profile = {}; data.payment = { paymentMethod: null }; data.active = []; data.archived = [];
  data.home = { ...data.home, counts: { active: 0, applications: 0, draft: 1, archived: 0 }, postedCount: 0,
    attention: { ...data.home.attention, total: 0, items: [] }, week: { ...data.home.week, total: 0, items: [] } };
  await page.goto(`${entry}#/home`);
  await loaded(page, "onboarding");
  await expect(region(page, "onboarding")).toContainText("3 setup steps remaining");
  await region(page, "onboarding").getByRole("button", { name: "Walk through setup" }).click();
  await region(page, "onboarding").getByRole("button", { name: "Next step" }).click();
  await expect(region(page, "onboarding")).toContainText("Guide step 2 of 4");
  await page.evaluate(() => sessionStorage.setItem("lpc_attorney_onboarding_step", "payment"));
  await region(page, "onboarding").getByRole("button", { name: "Skip for now" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("lpc_attorney_onboarding_step"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("lpc_attorney_onboarding_dismissed"))).toBe("1");
  await page.reload(); await loaded(page, "onboarding");
  await expect(region(page, "onboarding").getByRole("button", { name: "Show setup guide" })).toBeVisible();
  await region(page, "onboarding").getByRole("button", { name: "Show setup guide" }).click();
  await expect(region(page, "onboarding").getByRole("link", { name: "Complete your profile" })).toHaveAttribute("href", "#/settings");
  data.profile = { lawFirm: "Firm" }; data.payment = { paymentMethod: { id: "pm_test" } }; data.active = [matter(1)];
  data.home.counts.active = 1; data.home.postedCount = 1;
  await region(page, "onboarding").getByRole("button", { name: "Refresh getting started" }).click();
  await loaded(page, "onboarding");
  await expect(region(page, "onboarding")).toContainText("Setup complete.");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Matters", exact: true }).click();
  await loaded(page, "matter-list");
});

test("slow reads do not block navigation or reappear after session protection", async ({ page }) => {
  const data = await mock(page);
  let release, started;
  const pending = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { started = resolve; });
  await page.route("**/api/cases/inventory/home?**", async (route) => { started(); await pending; await json(route, data.home); });
  await page.goto(`${entry}#/home`); await requested;
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  await expect(region(page, "overview")).toHaveAttribute("data-state", "loading");
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Matters", exact: true }).click();
  await loaded(page, "matter-list"); release();
  await expect(region(page, "overview")).toHaveCount(0);
  await page.route("**/api/auth/me", (route) => json(route, { error: "Unavailable" }, 503));
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" })));
  await expect(page.locator("main")).toBeEmpty();
  await expect(page.getByText("Synthetic Matter 01", { exact: true })).toHaveCount(0);
});

test("first-login tour resumes four targets and persists only explicit confirmed completion", async ({ page }) => {
  const data = await mock(page);
  data.profile.onboarding = { attorneyTourCompleted: false };
  const sessionResponse = await page.request.get('/api/auth/me');
  expect(sessionResponse.ok()).toBe(true);
  const session = await sessionResponse.json();
  session.user.isFirstLogin = true;
  await page.route("**/api/auth/me", route => json(route, session));
  let fail = true;
  const patches = [];
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route("**/api/users/me/onboarding", (route) => {
    patches.push(route.request().postDataJSON());
    expect(route.request().headers()["x-csrf-token"]).toBe("synthetic-csrf");
    if (fail) return json(route, { error: "Synthetic unavailable" }, 503);
    data.profile.onboarding.attorneyTourCompleted = true;
    return json(route, { onboarding: { attorneyTourCompleted: true } });
  });
  await page.goto(`${entry}#/home`); await loaded(page, "onboarding");
  await expect(region(page, "onboarding")).toContainText("Guide step 1 of 4");
  expect((await region(page, "onboarding").boundingBox()).y).toBeLessThan(600);
  expect(patches).toEqual([]);
  await region(page, "onboarding").getByRole("button", { name: "Next step" }).click();
  await page.reload(); await loaded(page, "onboarding");
  await expect(region(page, "onboarding")).toContainText("Guide step 2 of 4");
  await region(page, "onboarding").getByRole("button", { name: "Next step" }).click();
  await region(page, "onboarding").getByRole("button", { name: "Next step" }).click();
  await expect(region(page, "onboarding").getByRole("link", { name: "Browse paralegals" })).toHaveAttribute("href", "#/paralegals");
  await region(page, "onboarding").getByRole("button", { name: "Finish guide" }).click();
  await expect(region(page, "onboarding")).toContainText("Tour completion couldn’t be confirmed");
  expect(patches).toEqual([{ attorneyTourCompleted: true }]);
  fail = false;
  await region(page, "onboarding").getByRole("button", { name: "Finish guide" }).click();
  await expect(region(page, "onboarding")).toContainText("Guide completed.");
  expect(await page.evaluate(() => sessionStorage.getItem("lpc_attorney_tour_completed"))).toBe("1");
  expect(patches).toHaveLength(2);
  await page.reload(); await loaded(page, "onboarding");
  await expect(region(page, "onboarding")).not.toContainText("Guide step");
  await page.goto(`${entry}?replayTour=1#/home`); await loaded(page, "onboarding");
  await expect(region(page, "onboarding")).toContainText("Guide step 1 of 4");
  await expect(page).not.toHaveURL(/replayTour/);
});

test("populated views and expanded previews pass AA and fit narrow, tablet, dock and enlarged text", async ({ page }) => {
  await mock(page);
  await page.goto(`${entry}#/matters?view=applications&caseId=${objectId(30)}&openApplicants=1`);
  await loaded(page, "matter-list");
  await page.getByText("Preview matter", { exact: true }).click();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth + 1)).toBe(true);
  }
  let results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("matters-desktop.png"), fullPage: true });
  await page.goto(`${entry}#/home`); await loaded(page, "onboarding");
  results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("home-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath("home-mobile.png"), fullPage: true });
  await page.evaluate(() => document.documentElement.style.fontSize = "200%");
  expect(await page.evaluate(() => document.querySelector("main").scrollWidth <= document.querySelector("main").clientWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("home-mobile-enlarged.png"), fullPage: true });
});
