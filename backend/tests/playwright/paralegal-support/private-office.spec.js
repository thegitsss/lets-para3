const { receivedInvitations } = require("./received-invitation-fixture");
const { eventPage } = require("./event-page-fixture");
const { installNotificationReads } = require("./notification-fixtures");
const financial = require("./financial-fixtures");
const path = require("path");
const fs = require("fs");
const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

const SCREENSHOT_DIR = "/tmp/lpc-private-office-review";
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const USER_ID = "64f000000000000000000101";
const CASE_ONE = "64f000000000000000000201";
const CASE_TWO = "64f000000000000000000202";

function dateFromToday(offset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function profile(overrides = {}) {
  return {
    id: USER_ID,
    _id: USER_ID,
    role: "paralegal",
    status: "approved",
    firstName: "Lauren",
    lastName: "Glass",
    stateExperience: ["NY", "NJ"],
    practiceAreas: ["Commercial Litigation", "Contracts"],
    yearsExperience: 7,
    availability: "Available now",
    availabilityDetails: { status: "available" },
    onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true },
    ...overrides,
  };
}

function activeMatter(id = CASE_ONE, overrides = {}) {
  return {
    caseId: id,
    title: id === CASE_TWO ? "Commercial lease diligence" : "Vendor agreement review",
    jobTitle: id === CASE_TWO ? "Commercial lease diligence" : "Vendor agreement review",
    attorneyName: "Avery Stone",
    practiceArea: id === CASE_TWO ? "Real Estate" : "Contracts",
    status: "in progress",
    deadline: dateFromToday(id === CASE_TWO ? 4 : 2),
    deadlineDate: dateFromToday(id === CASE_TWO ? 4 : 2),
    tasksTotal: 5,
    tasksRemaining: 2,
    latestUpdate: "Draft uploaded",
    latestUpdateAt: new Date().toISOString(),
    archived: false,
    paymentReleased: false,
    escrowStatus: "funded",
    escrowIntentId: `pi_${id}`,
    paralegalId: USER_ID,
    ...overrides,
  };
}

function matterDetail(summary, fileStatus = "approved") {
  return {
    id: summary.caseId,
    title: summary.title,
    status: summary.status,
    practiceArea: summary.practiceArea,
    deadline: summary.deadline,
    files: [
      { id: "64f000000000000000000501", name: "Draft memorandum.docx", status: fileStatus, uploadedByRole: "paralegal" },
      { id: "64f000000000000000000502", name: "Source materials.pdf", status: "pending_review", uploadedByRole: "attorney" },
    ],
    submissionSummary: { totalFiles: 2, awaitingReview: fileStatus === "pending_review" ? 1 : 0, revisions: fileStatus === "attorney_revision" ? 1 : 0, approved: fileStatus === "approved" ? 1 : 0 },
    matterExperience: {
      header: {
        title: summary.title,
        status: { code: "in_progress", label: "In Progress" },
        practiceArea: summary.practiceArea,
        deadline: summary.deadline,
        primaryAction: { code: "continue_work", label: "Continue work", detail: "Complete the remaining work items", tab: "work" },
      },
      overview: {
        summary: "Review the agreement, identify material risk, and prepare the attorney-facing memorandum.",
        taskProgress: { completed: 3, total: 5 },
      },
    },
  };
}

function recommendations(count = 3) {
  return Array.from({ length: count }, (_, index) => ({
    _id: `64f00000000000000000030${index + 1}`,
    title: ["Discovery response support", "Contract abstract project", "Corporate records review"][index],
    practiceArea: index === 0 ? "Commercial Litigation" : "Contracts",
    state: index === 1 ? "NJ" : "NY",
    deadline: dateFromToday(index + 5),
    totalAmount: 85000 + index * 15000,
    minimumYearsExperience: 3,
    status: "open",
    createdAt: new Date(Date.now() - index * 60000).toISOString(),
  }));
}

function application(status = "shortlisted") {
  return {
    _id: "64f000000000000000000401",
    status,
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
    jobId: {
      _id: "64f000000000000000000301",
      title: "Discovery response support",
      practiceArea: "Commercial Litigation",
      status: "open",
    },
  };
}

function fixture(name) {
  const first = activeMatter();
  const base = {
    user: profile(),
    stripe: { connected: true, details_submitted: true, payouts_enabled: true },
    activeCases: [first],
    details: { [CASE_ONE]: matterDetail(first) },
    jobs: recommendations(3),
    applications: [application("shortlisted")],
    // Matter deadlines come from the dashboard. This feed contains only the
    // separately owned private reminders, of which this fixture has none.
    events: [],
    threads: [{ id: CASE_ONE, unread: 2, lastMessageSnippet: "Please review the new note." }],
    invites: [],
    unread: 2,
    metrics: { activeCases: 1, earnings: 1250, earningsLast30Days: 2450, earningsTotal: 8900, expectedPayouts: 1800 },
  };
  if (name === "multiple") {
    const second = activeMatter(CASE_TWO);
    base.activeCases.push(second);
    base.details[CASE_TWO] = matterDetail(second);
    base.metrics.activeCases = 2;
  }
  if (name === "payout-setup") base.stripe = { connected: false, details_submitted: false, payouts_enabled: false };
  if (["no-active", "folios", "application", "payout-setup", "incomplete-profile"].includes(name)) {
    base.activeCases = [];
    base.details = {};
    base.events = [];
    base.threads = [];
    base.unread = 0;
    base.metrics.activeCases = 0;
  }
  if (name === "application") base.applications = [application("viewed")];
  if (name === "invitation") {
    base.activeCases = [];
    base.details = {};
    base.events = [];
    base.threads = [];
    base.unread = 0;
    base.metrics.activeCases = 0;
    base.invites = [{ id: CASE_TWO, _id: CASE_TWO, title: "Commercial lease diligence", inviteStatus: "pending" }];
  }
  if (name === "submitted-application") {
    base.activeCases = [];
    base.details = {};
    base.events = [];
    base.applications = [application("submitted")];
    base.metrics.activeCases = 0;
  }
  if (name === "awaiting-approval") base.details[CASE_ONE] = matterDetail(first, "pending_review");
  if (name === "revisions") base.details[CASE_ONE] = matterDetail(first, "attorney_revision");
  if (name === "completed-paid") {
    base.activeCases = [];
    base.details = {};
    base.events = [];
    base.threads = [];
    base.unread = 0;
    base.jobs = [];
    base.applications = [];
    base.metrics = { activeCases: 0, earnings: 3200, earningsLast30Days: 3200, earningsTotal: 12600, expectedPayouts: 0 };
  }
  if (name === "incomplete-profile") base.user = profile({ stateExperience: [], practiceAreas: [], yearsExperience: null });
  if (name === "unavailable") base.user = profile({ availability: "Unavailable", availabilityDetails: { status: "unavailable", nextAvailable: dateFromToday(10) } });
  if (name === "one-recommendation") {
    base.activeCases = [];
    base.details = {};
    base.events = [];
    base.jobs = recommendations(1);
    base.metrics.activeCases = 0;
  }
  if (name === "no-recommendations") {
    base.activeCases = [];
    base.details = {};
    base.jobs = [];
    base.events = [];
    base.metrics.activeCases = 0;
  }
  if (name === "partial-failure") base.jobsFail = true;
  if (name === "complete-failure") {
    base.dashboardFail = true;
    base.jobsFail = true;
    base.activeCases = [];
    base.details = {};
  }
  if (name === "loading") base.dashboardDelay = 900;
  if (name === "access-loss") base.authLost = true;
  return base;
}

async function installFixture(page, state) {
  await page.addInitScript(() => {
    window.__SKIP_NOTIFICATIONS__ = true;
    sessionStorage.removeItem("lpc_stripe_connect_status");
  });
  const fulfill = (route, body, status = 200) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  await page.route("**/api/auth/me", (route) => state.authLost
    ? fulfill(route, { error: "Session expired" }, 401)
    : fulfill(route, { user: state.user }));
  await page.route("**/api/auth/workspace-release", route => fulfill(route, { workspace: { schemaVersion: 1, ownerId: String(state.user._id || state.user.id), role: "paralegal", revision: 0, version: "baseline", defaultDestination: "/dashboard-paralegal.html" } }));
  await installNotificationReads(page, { ownerId: () => String(state.user._id || state.user.id) });
  // The legacy header reads its session-bound count without an owner query;
  // the managed notification center above retains its stricter owned contract.
  await page.route(url => url.pathname === "/api/notifications/unread-count" && !url.searchParams.has("expectedOwnerId"), route => fulfill(route, { count: 0 }));
  await page.route("**/api/users/me", (route) => fulfill(route, state.user));
  await page.route("**/api/paralegals/update-availability", async (route) => {
    if (state.availabilitySaveFails) {
      return fulfill(route, { msg: "Availability could not be saved." }, 503);
    }
    const payload = route.request().postDataJSON();
    const status = payload.status === "unavailable" ? "unavailable" : "available";
    state.user = profile({
      ...state.user,
      availability: status === "available" ? "Available now" : "Unavailable",
      availabilityDetails: {
        status,
        nextAvailable: status === "unavailable" ? payload.nextAvailable || null : null,
        updatedAt: new Date().toISOString(),
      },
    });
    return fulfill(route, {
      ownerId: String(state.user._id || state.user.id),
      availability: state.user.availability,
      availabilityDetails: state.user.availabilityDetails,
    });
  });
  await page.route("**/api/csrf", (route) => fulfill(route, { csrfToken: "fixture-token" }));
  await page.route("**/api/payments/connect/status", (route) => fulfill(route, {
    ...state.stripe,
    readiness: {
      ready: state.stripe?.connected === true,
      accountPresent: state.stripe?.connected === true,
      detailsSubmitted: state.stripe?.details_submitted === true,
      payoutsEnabled: state.stripe?.payouts_enabled === true,
      blockers: state.stripe?.connected === true ? [] : ["missing_stripe_account"],
      evidenceState: "verified",
    },
  }));
  await page.route("**/api/paralegal/dashboard**", async (route) => {
    if (state.dashboardDelay) await new Promise((resolve) => setTimeout(resolve, state.dashboardDelay));
    return state.dashboardFail
      ? fulfill(route, { error: "Unavailable" }, 503)
      : fulfill(route, { metrics: { ...state.metrics, earningsReport: financial.earnings(USER_ID, state.metrics), expectedCompensation: financial.expected(USER_ID) }, activeCases: state.activeCases });
  });
  await page.route(url => url.pathname === "/api/events", route => fulfill(route, eventPage(USER_ID, state.events, new URL(route.request().url()).searchParams)));
  await page.route("**/api/messages/threads**", (route) => fulfill(route, { threads: state.threads }));
  await page.route(url => url.pathname === "/api/messages/summary", route => fulfill(route, { items: state.threads.map(thread => ({ caseId: thread.caseId || thread.id, title: state.details[thread.caseId || thread.id]?.title || "Matter conversation", unread: thread.unread })) }));
  await page.route("**/api/messages/unread-count", (route) => fulfill(route, { count: state.unread }));
  await page.route(url => url.pathname === "/api/cases/invited-to", route => fulfill(route, receivedInvitations(USER_ID, state.invites || [], new URL(route.request().url()).searchParams)));
  await page.route(url => url.pathname === "/api/cases/my-completed", route => fulfill(route, financial.history(USER_ID, [], new URL(route.request().url()).searchParams)));
  await page.route("**/api/applications/my", (route) => fulfill(route, state.applications));
  await page.route("**/api/jobs/recommended", (route) => state.jobsFail
    ? fulfill(route, { error: "Unavailable" }, 503)
    : fulfill(route, { hasMatchingProfile: true, items: state.jobs }));
  await page.route("**/api/jobs/open", (route) => state.jobsFail
    ? fulfill(route, { error: "Unavailable" }, 503)
    : fulfill(route, state.jobs));
  await page.route(/\/api\/cases\/[a-f0-9]{24}(?:\?.*)?$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").pop();
    return state.details[id] ? fulfill(route, state.details[id]) : fulfill(route, { error: "Matter not found" }, 404);
  });
}

async function openOffice(page, state) {
  await installFixture(page, state);
  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#homeWorkSection")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#recommendedMattersSection")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#paralegalHomeView")).not.toHaveClass(/is-hydrating/);
}

async function expectNoOverflow(page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
}

function contrastRatio(foreground, background) {
  const luminance = (value) => {
    const channels = value.match(/[\d.]+/g).slice(0, 3).map((channel) => Number(channel) / 255);
    const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

test("legacy application deep links retain the submitted scope after withdrawal and listing closure", async ({ page }) => {
  const state = fixture("application");
  const record = application("withdrawn");
  record.jobId.status = "closed";
  record.jobId.caseId = CASE_ONE;
  record.scopeSnapshot = { title: "Original application scope", description: "Retained original brief", state: "NY", deadlineDate: "2026-09-15", tasks: ["Prepare chronology"], totalAmount: 90000, capturedAt: "2026-08-30T12:00:00Z" };
  record.coverLetter = "My original submitted message";
  state.applications = [record];
  await installFixture(page, state);
  await page.goto(`/dashboard-paralegal.html?applicationId=${record._id}#cases`);
  const modal = page.locator("#applicationDetailModal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("Original application scope");
  await expect(modal).toContainText("Retained original brief");
  await expect(modal).toContainText("My original submitted message");
  await modal.locator("summary").filter({ hasText: "Matter details" }).click();
  await expect(modal).toContainText("Prepare chronology");
  await expect(modal).toContainText("Sep 15, 2026");
  await expect(modal.locator("[data-application-revoke]")).toBeDisabled();
  await expect(page).toHaveURL(new RegExp(`applicationId=${record._id}#cases$`));
});

test("private office renders authoritative zones, cycles Matters, and remains accessible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.__privateOfficeDeskTitles = [];
    document.addEventListener("DOMContentLoaded", () => {
      const desk = document.getElementById("assignmentList");
      if (!desk) return;
      new MutationObserver(() => {
        queueMicrotask(() => {
          const title = desk.querySelector(".desk-matter h3")?.textContent?.trim();
          if (title && window.__privateOfficeDeskTitles.at(-1) !== title) {
            window.__privateOfficeDeskTitles.push(title);
          }
        });
      }).observe(desk, { childList: true, subtree: true, characterData: true });
    }, { once: true });
  });
  await openOffice(page, fixture("multiple"));

  await expect(page.locator(".private-office-context")).toHaveCount(0);
  await expect(page.locator(".private-office-greeting, #welcomeGreeting, #user-name-heading")).toHaveCount(0);
  await expect(page.getByText("On your desk", { exact: true })).toBeVisible();
  await expect(page.locator(".desk-matter h3")).toHaveText("Vendor agreement review");
  await expect(page.locator("#deskMatterPosition")).toHaveText("1 / 2");
  await expect(page.locator(".desk-matter h3")).toHaveCSS("font-family", /Cormorant Garamond/);
  expect(await page.evaluate(() => window.__privateOfficeDeskTitles)).toEqual(["Vendor agreement review"]);
  await page.getByRole("button", { name: "Next active Matter" }).click();
  await expect(page.locator(".desk-matter h3")).toHaveText("Commercial lease diligence");
  await expect(page.locator(".matter-folio")).toHaveCount(3);
  await expect(page.locator(".application-current-status")).toHaveText("Shortlisted");
  await expect(page.locator("#deadlineList a")).toHaveCount(2);
  await expect(page.locator(".private-office-compensation")).not.toContainText(/escrow|chargeback/i);
  const compensationColors = await page.locator("#privateOfficeCompensationTitle").evaluate((heading) => ({
    foreground: getComputedStyle(heading).color,
    background: getComputedStyle(heading.closest(".private-office-compensation")).backgroundColor,
  }));
  expect(contrastRatio(compensationColors.foreground, compensationColors.background)).toBeGreaterThanOrEqual(4.5);
  const availabilityButton = page.getByRole("button", { name: "Update availability" });
  await availabilityButton.click();
  const availabilityDialog = page.getByRole("dialog", { name: "Update Availability" });
  await expect(availabilityDialog).toBeVisible();
  await expect(availabilityDialog).toHaveCSS("border-radius", "3px");
  await expect(availabilityDialog).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#saveAvailabilityBtn")).toHaveCSS("background-color", "rgb(13, 38, 63)");
  await page.locator("#cancelAvailabilityBtn").click();
  await expect(availabilityDialog).toBeHidden();
  await expect(availabilityButton).toBeFocused();
  await expectNoOverflow(page);

  const results = await new AxeBuilder({ page })
    .include("#paralegalHomeView")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
    .analyze();
  expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `multiple-${testInfo.project.name}.png`) });
});

test("private office deterministic states remain composed without invented progress", async ({ page }, testInfo) => {
  const states = [
    ["payout-setup", /Complete payout setup/],
    ["no-active", /Ready for the next Matter/],
    ["folios", /Recommended Matters/],
    ["application", /Viewed/],
    ["invitation", /Matter invitation/],
    ["submitted-application", /Submitted/],
    ["awaiting-approval", /awaiting attorney review/i],
    ["revisions", /revision/i],
    ["completed-paid", /Ready for the next Matter/],
    ["incomplete-profile", /Complete your matching profile/],
    ["unavailable", /Not available/],
    ["one-recommendation", /Discovery response support/],
    ["no-recommendations", /Ready for the next Matter/],
  ];
  for (const [name, expected] of states) {
    await page.unrouteAll({ behavior: "wait" });
    await openOffice(page, fixture(name));
    await expect(page.locator("#paralegalHomeView")).toContainText(expected);
    if (["no-active", "one-recommendation"].includes(name)) {
      await expect(page.locator("#assignmentList")).toContainText("Ready for the next Matter");
      await expect(page.locator("#assignmentList")).not.toContainText("Discovery response support");
      await expect(page.locator("#recommendedMattersList")).toContainText("Discovery response support");
    }
    if (name === "incomplete-profile") {
      await expect(page.locator("#assignmentList")).toContainText("Office setup");
      await expect(page.locator("#assignmentList")).not.toContainText("Vendor agreement review");
      await expect(page.locator("#recommendedMattersSection")).toBeHidden();
    }
    if (name === "payout-setup") {
      await expect(page.locator("#assignmentList")).toContainText("Required before applying to Matters or receiving payment.");
      const setupDeskHeight = await page.locator("#homeWorkSection").evaluate((node) => node.getBoundingClientRect().height);
      expect(setupDeskHeight).toBeLessThanOrEqual(360);
    }
    if (name === "completed-paid") {
      await expect(page.locator("#recommendedMattersList")).toContainText("No recommendations right now.");
      await expect(page.locator("#recommendedMattersSection")).toContainText("Browse Matters");
      await expect(page.locator("#homeApplicationsSection")).toContainText("No applications in progress");
      await expect(page.locator("#homeApplicationsSection")).toContainText("All applications");
      await expect(page.locator("#homeApplicationsSection")).toHaveClass(/\bis-empty\b/);
      await expect(page.locator("#homeApplicationsSection > header")).toBeHidden();
    }
    await expectNoOverflow(page);
    if (name === "folios") await page.locator("#recommendedMattersSection").scrollIntoViewIfNeeded();
    if (["application", "submitted-application"].includes(name)) await page.locator("#homeApplicationsSection").scrollIntoViewIfNeeded();
    if (name === "completed-paid") await page.locator(".private-office-compensation").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}-${testInfo.project.name}.png`) });
  }
});

test("availability remains server-authoritative across failed saves and cross-tab signals", async ({ page }) => {
  const state = fixture("no-active");
  state.availabilitySaveFails = true;
  await openOffice(page, state);

  const availabilityButton = page.getByRole("button", { name: "Update availability" });
  await expect(page.locator("#availabilityStatus")).toHaveText("Available now");
  await availabilityButton.click();
  await page.locator("#availabilityStatusInput").selectOption("unavailable");
  await page.locator("#saveAvailabilityBtn").click();
  await expect(page.locator("#availabilityError")).toContainText("Availability could not be saved.");
  await expect(page.locator("#availabilityStatus")).toHaveText("Available now");
  await page.keyboard.press("Escape");
  await expect(page.locator("#availabilityModal")).toHaveAttribute("aria-hidden", "true");

  state.availabilitySaveFails = false;
  state.user = profile({
    availability: "Unavailable",
    availabilityDetails: { status: "unavailable", nextAvailable: dateFromToday(10) },
  });
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "lpc_user",
    oldValue: JSON.stringify({ availability: "Available now" }),
    newValue: JSON.stringify({ availability: "Available now" }),
  })));
  await expect(page.locator("#availabilityStatus")).toHaveText("Not available");
  await expect(page.locator("#availabilityNext")).toContainText("Available on");
});

test("Home owns the sole initial dashboard request and seeds My Matters from that snapshot", async ({ page }) => {
  const state = fixture("multiple");
  await installFixture(page, state);
  let initialDashboardRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/paralegal/dashboard" && !url.searchParams.has("ts")) {
      initialDashboardRequests += 1;
    }
  });

  await page.goto("/dashboard-paralegal.html#cases", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#homeWorkSection")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#filesContainer .file-card")).toHaveCount(2);
  await expect(page.locator("#completedCasesContainer")).toContainText("No past matters yet.");
  expect(initialDashboardRequests).toBe(1);
});

test("a queued Home refresh cannot paint an older dashboard snapshot", async ({ page }) => {
  const stale = activeMatter(CASE_ONE, { title: "Stale Matter", jobTitle: "Stale Matter" });
  const current = activeMatter(CASE_TWO, { title: "Current Matter", jobTitle: "Current Matter" });
  const state = fixture("no-active");
  state.details = { [CASE_ONE]: matterDetail(stale), [CASE_TWO]: matterDetail(current) };
  await openOffice(page, state);
  await page.unroute("**/api/paralegal/dashboard**");
  let requests = 0;
  let releaseFirst;
  let announceFirst;
  const firstArrived = new Promise((resolve) => { announceFirst = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  await page.route("**/api/paralegal/dashboard**", async (route) => {
    requests += 1;
    if (requests === 1) {
      announceFirst();
      await firstReleased;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ metrics: { activeCases: 1 }, activeCases: [stale] }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ metrics: { activeCases: 1 }, activeCases: [current] }),
    });
  });
  await page.evaluate(() => {
    window.__phaseTwoDeskTitles = [];
    const desk = document.getElementById("assignmentList");
    new MutationObserver(() => {
      const title = desk?.querySelector(".desk-matter h3")?.textContent?.trim();
      if (title) window.__phaseTwoDeskTitles.push(title);
    }).observe(desk, { childList: true, subtree: true, characterData: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await firstArrived;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  releaseFirst();

  await expect(page.locator("#assignmentList .desk-matter h3")).toHaveText("Current Matter");
  expect(requests).toBe(2);
  expect(await page.evaluate(() => window.__phaseTwoDeskTitles)).not.toContain("Stale Matter");
});

test("private office distinguishes loading, partial failure, complete failure, and access loss", async ({ page }) => {
  await installFixture(page, fixture("loading"));
  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#assignmentList")).toContainText("Preparing your desk");
  await expect(page.locator("#homeWorkSection")).not.toHaveAttribute("aria-busy", "true");

  // Leave the previous synthetic account page before replacing its readers.
  // Otherwise a late refresh can reach the real session during the gap.
  await page.goto("about:blank", { waitUntil: "commit" });
  await page.unrouteAll({ behavior: "wait" });
  await openOffice(page, fixture("partial-failure"));
  await expect(page.locator(".desk-matter h3")).toContainText("Vendor agreement review");
  await expect(page.locator("#recommendedMattersList")).toContainText("Recommendations are unavailable");

  // Leave the previous synthetic account page before replacing its readers.
  // Otherwise a late refresh can reach the real session during the gap.
  await page.goto("about:blank", { waitUntil: "commit" });
  await page.unrouteAll({ behavior: "wait" });
  await openOffice(page, fixture("complete-failure"));
  await expect(page.locator("#assignmentList")).toContainText("Your work could not be loaded");

  // Leave the previous synthetic account page before replacing its readers.
  // Otherwise a late refresh can reach the real session during the gap.
  await page.goto("about:blank", { waitUntil: "commit" });
  await page.unrouteAll({ behavior: "wait" });
  await installFixture(page, fixture("access-loss"));
  await page.goto("/dashboard-paralegal.html", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/login\.html/);
});

test("private office has no overflow at every required responsive width", async ({ page }, testInfo) => {
  await openOffice(page, fixture("populated"));
  const widths = [320, 360, 375, 390, 430, 768, 1024, 1440, 1920];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width <= 430 ? 900 : 1100 });
    await expectNoOverflow(page);
    await expect(page.locator("#homeWorkSection")).toBeVisible();
    const touchTargets = await page.locator("#paralegalHomeView button, #paralegalHomeView a").evaluateAll((nodes) => nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((node) => ({ label: node.getAttribute("aria-label") || node.textContent.trim(), box: node.getBoundingClientRect().toJSON() })));
    touchTargets.forEach(({ label, box }) => {
      expect(box.height, `${label} at ${width}px`).toBeGreaterThanOrEqual(43.5);
    });
    if (width <= 430) {
      const headerGeometry = await page.locator(".private-office-header").evaluate((header) => {
        const title = header.querySelector(".private-office-header__title")?.getBoundingClientRect();
        const actions = header.querySelector(".private-office-header__actions")?.getBoundingClientRect();
        return {
          titleRight: title?.right || 0,
          titleBottom: title?.bottom || 0,
          titleMidpoint: title ? title.top + (title.height / 2) : 0,
          actionsLeft: actions?.left || 0,
          actionsTop: actions?.top || 0,
          actionsMidpoint: actions ? actions.top + (actions.height / 2) : 0,
        };
      });
      if (width <= 360) {
        expect(headerGeometry.actionsTop, `stacked header actions at ${width}px`).toBeGreaterThanOrEqual(headerGeometry.titleBottom);
      } else {
        expect(headerGeometry.actionsLeft, `header spacing at ${width}px`).toBeGreaterThanOrEqual(headerGeometry.titleRight);
        expect(Math.abs(headerGeometry.actionsMidpoint - headerGeometry.titleMidpoint), `header alignment at ${width}px`).toBeLessThanOrEqual(1);
      }
    }
    if ([390, 768, 1440].includes(width)) {
      const kind = width === 390 ? "mobile" : width === 768 ? "tablet" : "desktop";
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `populated-${kind}-${testInfo.project.name}.png`) });
    }
  }
});

test("dashboard tabs retain the shell while rechecking current Matter records", async ({ page }) => {
  await openOffice(page, fixture("no-active"));
  await expect(page.locator("#completedCasesContainer")).toContainText("No past matters yet.");

  let dashboardRequests = 0;
  let completedRequests = 0;
  const requestOwners = [];
  page.on("request", (request) => {
    const url = new URL(request.url()), pathname = url.pathname;
    if (pathname === "/api/paralegal/dashboard") dashboardRequests += 1;
    if (pathname === "/api/cases/my-completed") completedRequests += 1;
    if (["/api/paralegal/dashboard", "/api/cases/my-completed"].includes(pathname)) requestOwners.push(url.searchParams.get("expectedOwnerId"));
  });

  const main = page.locator("#main");
  await main.evaluate(element => { window.__tabReturnMain = element; });
  await expect(main).toHaveCSS("opacity", "1");
  await page.locator('[data-view-link="cases"]').click();
  await expect(page.locator("#paralegalCasesView")).toBeVisible();
  await expect(page.locator("#paralegalHomeView")).toBeHidden();
  await expect(page.locator("#paralegalCasesView")).not.toContainText(/Loading (?:completed )?matters/i);
  await expect(main).toHaveCSS("opacity", "1");

  await page.locator('[data-view-link="home"]').click();
  await expect(page.locator("#paralegalHomeView")).toBeVisible();
  await expect(page.locator("#paralegalCasesView")).toBeHidden();
  await expect(main).toHaveCSS("opacity", "1");

  await page.locator('[data-view-link="cases"]').click();
  await expect(page.locator("#paralegalCasesView")).toBeVisible();
  await expect(page.locator("#completedCasesContainer")).toContainText("No past matters yet.");
  expect(dashboardRequests).toBeGreaterThanOrEqual(2);
  expect(completedRequests).toBeGreaterThanOrEqual(2);
  expect(requestOwners.every(owner => owner === USER_ID)).toBe(true);
  expect(await main.evaluate(element => element === window.__tabReturnMain)).toBe(true);
});
