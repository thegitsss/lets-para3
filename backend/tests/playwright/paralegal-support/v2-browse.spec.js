const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const { browsePageFixture } = require("./browse-page-fixture");

const READY_CASE_ID = "64b000000000000000000501";
const READY_JOB_ID = "64b000000000000000000601";
const RESTRICTED_CASE_ID = "64b000000000000000000502";
const APPLIED_CASE_ID = "64b000000000000000000503";
const APPLIED_JOB_ID = "64b000000000000000000603";

async function json(route, payload, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function eligibility(ready, blockers = []) {
  return {
    ready,
    allowed: ready,
    blockers,
    facts: { payoutReadiness: { ready, blockers: [] } },
  };
}

async function installBrowseProjection(page) {
  const listings = [
    {
      _id: READY_CASE_ID,
      caseId: READY_CASE_ID,
      jobId: READY_JOB_ID,
      title: "Discovery response review",
      practiceArea: "Civil Litigation",
      state: "New York",
      description: "Review the discovery response set, prepare a chronology, and identify missing supporting records.",
      totalAmount: 90000,
      minimumYearsExperience: 5,
      deadlineDate: "2026-09-16",
      createdAt: "2026-09-01T14:00:00.000Z",
      applicationEligibility: eligibility(true),
      attorneyId: "64b000000000000000000701",
      attorney: { firstName: "Jordan", lastName: "Lee", lawFirm: "Lee Legal" },
      tasks: [{ title: "Review responses", completed: false }, { title: "Prepare chronology", completed: false }],
    },
    {
      _id: RESTRICTED_CASE_ID,
      caseId: RESTRICTED_CASE_ID,
      title: "Contract abstraction",
      practiceArea: "Contract Law",
      state: "California",
      description: "Abstract a commercial agreement set and prepare a structured issue table for attorney review.",
      totalAmount: 70000,
      deadlineDate: "2026-09-24",
      createdAt: "2026-08-30T14:00:00.000Z",
      applicationEligibility: eligibility(false, ["paralegal_payout_setup_required"]),
    },
    {
      _id: APPLIED_CASE_ID,
      caseId: APPLIED_CASE_ID,
      jobId: APPLIED_JOB_ID,
      title: "Previously applied matter",
      practiceArea: "Civil Litigation",
      state: "New York",
      totalAmount: 80000,
      appliedAt: "2026-08-28T14:00:00.000Z",
      applicationEligibility: eligibility(false, ["duplicate_application"]),
    },
  ];

  await page.route("**/api/users/me", (route) => json(route, {
    _id: "64b000000000000000000001",
    firstName: "Dana",
    lastName: "Young",
    role: "paralegal",
    status: "approved",
    state: "New York",
  }));
  await page.route("**/api/jobs/open?*", (route) => json(route, browsePageFixture(listings, new URL(route.request().url()).searchParams)));
  await page.route("**/api/applications/my", (route) => json(route, [{
    _id: "64b000000000000000000801",
    status: "rejected",
    jobId: { _id: APPLIED_JOB_ID, title: "Previously applied matter" },
  }]));
  return listings;
}

async function waitForBrowse(page) {
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("[data-v2-browse]")).toBeVisible();
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
}

test("Browse renders the authorized catalog and keeps applied matters out of the result list", async ({ page }) => {
  await installBrowseProjection(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/browse", { waitUntil: "domcontentloaded" });
  await waitForBrowse(page);

  await expect(page.getByRole("heading", { level: 1, name: "Browse matters" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Discovery response review" })).toBeVisible();
  await expect(page.locator('[data-filter-category="state"]')).toHaveAttribute("aria-label", "State: New York");
  await expect(page.getByRole("heading", { name: "Contract abstraction" })).toHaveCount(0);
  await expect(page.getByText("Previously applied matter")).toHaveCount(0);
  await expect(page.getByText("1 open matter")).toBeVisible();

  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Contract abstraction" })).toBeVisible();
  await expect(page.getByText("2 open matters")).toBeVisible();

  const violations = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations.violations).toEqual([]);
});

test("filters and details update inside the same document while the shell stays mounted", async ({ page }) => {
  await installBrowseProjection(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/paralegal-v2.html#/browse", { waitUntil: "domcontentloaded" });
  await waitForBrowse(page);
  await page.evaluate(() => {
    window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.browseIdentity = "same-sidebar";
    window.__browseNavigationEntries = performance.getEntriesByType("navigation").length;
  });

  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("button", { name: /^Practice area:/ }).click();
  await page.getByRole("radio", { name: "Contract Law", exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator(".v2-browse-filter").getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page).toHaveURL(/practice=contract(?:\+|%20)law/);
  await expect(page.getByRole("heading", { name: "Contract abstraction" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Discovery response review" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await page.getByRole("link", { name: "Details" }).first().click();
  await expect(page).toHaveURL(new RegExp(`matterId=${READY_CASE_ID}`));
  await expect(page.getByRole("heading", { level: 1, name: "Discovery response review" })).toBeVisible();
  await expect(page.getByText("5+ years required")).toBeVisible();

  const state = await page.evaluate(() => ({
    sidebar: window.__LPC_PARALEGAL_V2__.shell.sidebar.dataset.browseIdentity,
    navigations: performance.getEntriesByType("navigation").length,
    initial: window.__browseNavigationEntries,
  }));
  expect(state.sidebar).toBe("same-sidebar");
  expect(state.navigations).toBe(state.initial);
});

test("server-projected application restrictions explain themselves and ready applications submit once", async ({ page }) => {
  const listings = await installBrowseProjection(page);
  let applicationRequests = 0;
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route(`**/api/jobs/${READY_JOB_ID}/apply`, async (route) => {
    applicationRequests += 1;
    expect(route.request().postDataJSON()).toEqual({
      coverLetter: "I have the requested litigation experience and can complete this work on schedule.",
    });
    listings[0].appliedAt = "2026-09-13T14:00:00.000Z";
    await json(route, { _id: "64b000000000000000000901", status: "submitted" }, 201);
  });
  await page.goto("/paralegal-v2.html#/browse", { waitUntil: "domcontentloaded" });
  await waitForBrowse(page);

  await page.getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  const restrictedCard = page.getByRole("heading", { name: "Contract abstraction" }).locator("xpath=ancestor::article");
  await restrictedCard.getByRole("button", { name: "Apply" }).click({ force: true });
  await expect(page.locator("[data-v2-toast-region]")).toContainText("Complete your payout setup before applying to matters.");

  const readyCard = page.getByRole("heading", { name: "Discovery response review" }).locator("xpath=ancestor::article");
  await readyCard.getByRole("button", { name: "Apply" }).click();
  await page.getByLabel("Cover letter").fill("I have the requested litigation experience and can complete this work on schedule.");
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page).toHaveURL(/#\/browse/);
  const confirmation = page.getByRole("dialog", { name: "Discovery response review" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText("Application submitted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: "Discovery response review" })).toHaveCount(0);
  expect(applicationRequests).toBe(1);
});

test("an unfinished application remains available after its dialog is temporarily closed", async ({ page }) => {
  await installBrowseProjection(page);
  await page.goto("/paralegal-v2.html#/browse", { waitUntil: "domcontentloaded" });
  await waitForBrowse(page);

  const card = page.getByRole("heading", { name: "Discovery response review" }).locator("xpath=ancestor::article");
  await card.getByRole("button", { name: "Apply" }).click();
  await page.getByLabel("Cover letter").fill("A retained application draft with litigation details.");
  await page.getByRole("button", { name: "Close application" }).click();
  await card.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByLabel("Cover letter")).toHaveValue("A retained application draft with litigation details.");
});

test("a confirmed application from full details remains visible after the Browse destination commits", async ({ page }) => {
  const listings = await installBrowseProjection(page);
  await page.route("**/api/csrf", route => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route(`**/api/jobs/${READY_JOB_ID}/apply`, route => {
    listings[0].appliedAt = "2026-09-13T14:00:00.000Z";
    return json(route, { _id: "64b000000000000000000901", status: "submitted" }, 201);
  });
  await page.goto(`/paralegal-v2.html#/browse?matterId=${READY_CASE_ID}`);
  await page.locator(".v2-browse-detail").getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByLabel("Cover letter").fill("I can prepare this discovery chronology for attorney review.");
  await page.getByRole("button", { name: "Submit application", exact: true }).click();
  await waitForBrowse(page);
  const confirmation = page.getByRole("dialog", { name: "Discovery response review", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await confirmation.getByRole("link", { name: "View my applications" }).click();
  await expect(page).toHaveURL(/#\/work\?section=applications$/);
  await expect(confirmation).toHaveCount(0);
});

test("a direct matter link stays authorization-bound and reporting uses the existing case flag route", async ({ page }) => {
  await installBrowseProjection(page);
  let reportRequests = 0;
  await page.route("**/api/csrf", (route) => json(route, { csrfToken: "synthetic-csrf" }));
  await page.route(`**/api/cases/${READY_CASE_ID}/flag`, async (route) => {
    reportRequests += 1;
    expect(route.request().postDataJSON()).toEqual({ reason: "spam", details: "The description appears misleading." });
    await json(route, { ok: true, flagCount: 1 });
  });
  await page.goto(`/paralegal-v2.html#/browse?matterId=${READY_CASE_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.getByRole("heading", { level: 1, name: "Discovery response review" })).toBeVisible();

  await page.getByRole("button", { name: "Report" }).click();
  await page.getByLabel("Spam or misleading").check();
  await page.getByLabel("Additional details").fill("The description appears misleading.");
  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(page.locator("[data-v2-toast-region]")).toContainText("Thanks for letting us know");
  expect(reportRequests).toBe(1);

  const violations = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(violations.violations).toEqual([]);
});

test("filter categories keep draft choices, support search, and apply existing URL filters", async ({ page }, testInfo) => {
  const listings = await installBrowseProjection(page);
  for (let i = 0; i < 9; i += 1) listings.push({ ...listings[0], _id: `64c${String(i).padStart(21, "0")}`, caseId: `64c${String(i).padStart(21, "0")}`, jobId: `64d${String(i).padStart(21, "0")}`, practiceArea: `Additional practice ${i}` });
  await page.goto("/paralegal-v2.html#/browse?state=&sort=payHigh", { waitUntil: "domcontentloaded" });
  await waitForBrowse(page);
  await page.getByRole("button", { name: /^Filters/ }).click();
  const panel = page.locator(".v2-browse-filter");
  await expect(panel.locator("select, input")).toHaveCount(0);
  await expect(panel.locator("[data-filter-category]")).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath("filter-categories.png") });
  await panel.getByRole("button", { name: /^Practice area:/ }).click();
  await panel.getByRole("searchbox", { name: "Search practice area" }).fill("Contract");
  await expect(panel.getByRole("radio")).toHaveCount(1);
  await panel.getByRole("radio", { name: "Contract Law", exact: true }).check();
  await page.screenshot({ path: testInfo.outputPath("filter-choices.png") });
  await panel.getByRole("button", { name: "Back to filters" }).click();
  await expect(panel.getByRole("button", { name: "Practice area: Contract Law", exact: true })).toBeFocused();
  await expect(page).not.toHaveURL(/practice=/);

  for (const [category, option] of [["Minimum matter amount", "$700"], ["Deadline", "Within 30 days"], ["Date posted", "Past 7 days"]]) {
    await panel.getByRole("button", { name: new RegExp(`^${category}:`) }).click();
    await panel.getByRole("radio", { name: option, exact: true }).check();
    await panel.getByRole("button", { name: "Done", exact: true }).click();
  }
  await panel.getByRole("button", { name: /^Deadline:/ }).click();
  await panel.getByRole("button", { name: "Clear deadline", exact: true }).click();
  await expect(panel.getByRole("radio", { name: "Any deadline", exact: true })).toBeChecked();
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  await panel.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await expect(page.getByRole("button", { name: /^Filters/ })).toBeFocused();
  const query = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
  expect(Object.fromEntries(query)).toEqual({ practice: "contract law", state: "", minPay: "700", posted: "7_days", sort: "payHigh" });
  await page.getByRole("button", { name: /^Filters/ }).click();
  await expect(panel.getByRole("button", { name: "Minimum matter amount: $700", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page).toHaveURL(/#\/browse\?state=$/);
});

test("Browse keeps filters hidden until opened at desktop and mobile widths", async ({ page }) => {
  await installBrowseProjection(page);
  await page.goto("/paralegal-v2.html#/browse", { waitUntil: "domcontentloaded" });
  await waitForBrowse(page);

  for (const width of [320, 360, 375, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 812 : 900 });
    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(geometry.scrollWidth, `${width}px horizontal overflow`).toBeLessThanOrEqual(geometry.viewport + 1);
    {
      await expect(page.locator(".v2-browse-filter")).not.toBeVisible();
      await page.getByRole("button", { name: /^Filters/ }).click();
      await expect(page.locator(".v2-browse")).toHaveClass(/is-filter-open/);
      const panel = await page.locator(".v2-browse-filter").boundingBox();
      expect(panel.width).toBeCloseTo(280, 3);
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width);
      await page.keyboard.press("Escape");
      await expect(page.locator(".v2-browse-filter")).not.toBeVisible();
      await expect(page.getByRole("button", { name: /^Filters/ })).toBeFocused();
      await page.getByRole("button", { name: /^Filters/ }).click();
      await page.getByRole("button", { name: "Close filters" }).click();
      await expect(page.locator(".v2-browse")).not.toHaveClass(/is-filter-open/);
      await page.getByRole("button", { name: /^Filters/ }).click();
      await page.getByRole("heading", { name: "Browse matters", exact: true }).click();
      await expect(page.locator(".v2-browse-filter")).not.toBeVisible();
    }
  }
});

test("usability: details preserves filters page scroll and keyboard focus", async ({ page }) => {
  const listings = await installBrowseProjection(page);
  for (let i = 0; i < 15; i += 1) listings.push({ ...listings[0], _id: `64e${String(i).padStart(21, "0")}`, caseId: `64e${String(i).padStart(21, "0")}`, jobId: `64f${String(i).padStart(21, "0")}`, title: `Extra matter ${i}` });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/paralegal-v2.html#/browse?state=New+York&practice=Civil+Litigation&page=2&sort=payHigh");
  await waitForBrowse(page);
  const link = page.locator('.v2-browse-details').last();
  await link.focus();
  await link.scrollIntoViewIfNeeded();
  const title = await link.locator('xpath=ancestor::article').getByRole('heading').textContent();
  const scroll = await page.locator('[data-v2-route-outlet]').evaluate(el => el.scrollTop);
  await link.press('Enter');
  await expect(page.locator('.v2-browse-detail')).toBeVisible();
  await page.getByRole('link', { name: 'Back to Browse Matters' }).click();
  await waitForBrowse(page);
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('[data-filter-category="practice"]')).toHaveAttribute('aria-label', 'Practice area: Civil Litigation');
  await expect(page.locator('[data-filter-category="state"]')).toHaveAttribute('aria-label', 'State: New York');
  const returned = page.locator('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('link', { name: 'Details' });
  await expect(returned).toBeFocused();
  await expect.poll(() => page.locator('[data-v2-route-outlet]').evaluate(el => el.scrollTop)).toBeCloseTo(scroll, 0);
});

test("usability: unavailable details returns to the same Browse filters", async ({ page }) => {
  await installBrowseProjection(page);
  await page.goto('/paralegal-v2.html#/browse?state=&sort=payHigh&matterId=64b000000000000000009999');
  await page.getByRole('link', { name: 'Return to Browse Matters' }).click();
  await waitForBrowse(page);
  await expect(page.locator('[data-filter-category="state"]')).toHaveAttribute('aria-label', 'State: All');
  await expect(page).toHaveURL(/sort=payHigh/);
  await expect(page.getByRole('heading', { name: 'Contract abstraction' })).toBeVisible();
});

test("approved copy: an empty catalog does not blame filters", async ({ page }) => {
  const listings = await installBrowseProjection(page);
  listings.length = 0;
  await page.goto("/paralegal-v2.html#/browse", { waitUntil: "domcontentloaded" });
  await waitForBrowse(page);
  await expect(page.getByRole("heading", { name: "No open matters right now." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear filters", exact: true })).toHaveCount(0);
});

test('office polish: count sits beside filters and details retain scope in both themes', async ({ page }, testInfo) => {
  await installBrowseProjection(page);
  await page.goto('/paralegal-v2.html#/browse');
  await waitForBrowse(page);
  await expect(page.locator('.v2-browse-result-controls .v2-browse-result-count')).toBeVisible();
  await expect(page.getByText('Explore open matters.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Before platform fee', { exact: true })).toHaveCount(0);
  await require('./office-polish-review').reviewOffice(page, testInfo, 'browse');
  await page.locator('.v2-browse-details').first().click();
  await expect(page.locator('.v2-browse-detail')).toBeVisible();
  const applyPaint = await page.locator('.v2-browse-detail .v2-browse-apply').evaluate(button => {
    const style = getComputedStyle(button); return { text: style.color, background: style.backgroundColor };
  });
  expect(applyPaint.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(applyPaint.text).not.toBe(applyPaint.background);
  await require('./office-polish-review').reviewOffice(page, testInfo, 'browse-detail', { widths: [1440, 320] });
});

test("server pages retain complete totals and return keyboard focus after Next and Back", async ({ page }) => {
  const listings = await installBrowseProjection(page);
  for (let i = 0; i < 24; i += 1) listings.push({ ...listings[0], _id: `64e${String(i).padStart(21, "0")}`, caseId: `64e${String(i).padStart(21, "0")}`, jobId: null, title: `Page matter ${i}` });
  await page.goto("/paralegal-v2.html#/browse?state=");
  await waitForBrowse(page);
  await expect(page.getByText("26 open matters", { exact: true })).toBeVisible();
  await expect(page.locator(".v2-browse-list article")).toHaveCount(12);
  await page.getByRole("button", { name: "Next", exact: true }).press("Enter");
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator("#v2-browse-title")).toBeFocused();
  await expect(page.locator(".v2-browse-pagination")).toContainText("2 / 3");
  await expect(page.getByRole("heading", { name: "Page matter 10", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator(".v2-browse-pagination")).toContainText("3 / 3");
  await expect(page.locator(".v2-browse-list article")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.locator(".v2-browse-pagination")).toContainText("2 / 3");
  await expect(page.locator("#v2-browse-title")).toBeFocused();
});

test("failed and malformed pages stay unavailable until a verified retry succeeds", async ({ page }) => {
  const listings = await installBrowseProjection(page);
  let mode = "failed";
  const reads = [];
  await page.route("**/api/jobs/open?*", async route => {
    reads.push(mode);
    if (mode === "failed") return json(route, { error: "Unavailable" }, 503);
    const result = browsePageFixture(listings, new URL(route.request().url()).searchParams);
    if (mode === "malformed") result.total = 999;
    return json(route, result);
  });
  await page.goto("/paralegal-v2.html#/browse");
  for (const nextMode of ["malformed", "verified"]) {
    await expect(page.getByRole("heading", { name: "Open matters could not be loaded" })).toBeVisible();
    await expect(page.getByText("No open matters right now.")).toHaveCount(0);
    mode = nextMode;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
  }
  await waitForBrowse(page);
  await expect(page.getByRole("heading", { name: "Discovery response review" })).toBeVisible();
  expect(new Set(reads)).toEqual(new Set(["failed", "malformed", "verified"]));
});

test("a slower earlier filter response cannot replace the current page", async ({ page }) => {
  const listings = await installBrowseProjection(page);
  let release, requested;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  await page.route("**/api/jobs/open?*", async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("state") === "CA") { requested(); await gate; }
    await json(route, browsePageFixture(listings, params));
  });
  await page.goto("/paralegal-v2.html#/browse?state=NY");
  await waitForBrowse(page);
  await page.evaluate(() => { location.hash = "/browse?state=CA"; });
  await started;
  await page.evaluate(() => { location.hash = "/browse?state="; });
  await expect(page.getByText("2 open matters")).toBeVisible();
  const returned = page.waitForResponse(response => new URL(response.url()).searchParams.get("state") === "CA");
  release(); await returned;
  await expect(page).toHaveURL(/#\/browse\?state=$/);
  await expect(page.getByText("2 open matters")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Discovery response review" })).toBeVisible();
});
