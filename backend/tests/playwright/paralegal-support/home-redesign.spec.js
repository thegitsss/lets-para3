const { eventPage } = require("./event-page-fixture");
const { browsePageFixture } = require("./browse-page-fixture");
const financial = require("./financial-fixtures");
const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const { writeFile } = require("node:fs/promises");

// Every identity and record below is synthetic and scoped to the local harness.
// Unlike the historical Home fixture, auth/me and users/me share one identity.
const USER = "64b000000000000000000001";
const MATTER = "64b000000000000000010001";
const INVITE = "64b000000000000000010002";
const APP = "64b000000000000000010003";
const REC = "64b000000000000000010004";
const NOW = "2026-09-08T16:00:00.000Z";
const json = (route, body, status = 200) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/jobs/open" && url.searchParams.get("view") === "browse" && status === 200) body = browsePageFixture(body.items || body, url.searchParams, USER);
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
};

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return;
  const diagnostic = await page.evaluate(() => ({
    focused: document.activeElement?.outerHTML?.slice(0, 500),
    hovering: [...document.querySelectorAll("[data-v2-home] :hover")].map(element => element.className),
    dialogs: [...document.querySelectorAll("dialog[open], .support-drawer:not([hidden]), [data-v2-search-panel]:not([hidden]), [data-v2-notifications-panel]:not([hidden])")].map(element => ({ class: element.className, hidden: element.hidden })),
    sourceStates: [...document.querySelectorAll("[data-home-source-state]")].map(element => ({ state: element.dataset.homeSourceState, text: element.textContent })),
    loading: document.querySelector("[data-v2-home]")?.dataset.homeLoading,
  })).catch(() => ({}));
  await testInfo.attach("synthetic-home-diagnostics", { body: JSON.stringify({ ...diagnostic, reads: page.__homeFixture?.reads, errors: page.__homeErrors, failedResponses: page.__homeFailedResponses }, null, 2), contentType: "application/json" });
  console.log("Synthetic Home failure diagnostics:", JSON.stringify({ ...diagnostic, reads: page.__homeFixture?.reads, errors: page.__homeErrors, failedResponses: page.__homeFailedResponses }));
});

function active(overrides = {}) {
  return {
    caseId: MATTER, jobId: "64b000000000000000020001", jobTitle: "Discovery response support",
    attorneyName: "Jordan Lee", practiceArea: "Civil Litigation", status: "in progress",
    deadlineDate: "2026-10-01", archived: false, paymentReleased: false,
    escrowStatus: "funded", escrowIntentId: "pi_synthetic_home", paralegalId: USER,
    tasksTotal: 5, tasksRemaining: 2, ...overrides,
  };
}

function invitation(overrides = {}) {
  return {
    _id: INVITE, caseId: INVITE, title: "Probate inventory support", inviteStatus: "pending",
    inviteInvitedAt: "2026-09-07T14:00:00Z", deadlineDate: "2026-09-30",
    briefSummary: "Prepare a verified asset inventory.", details: "Review the complete asset inventory and identify missing source records.",
    practiceArea: "Probate", state: "New York", totalAmount: 80000,
    attorney: { firstName: "Avery", lastName: "Counsel" }, ...overrides,
  };
}

function application(overrides = {}) {
  return {
    _id: APP, caseId: "64b000000000000000010003", paralegalId: USER, status: "shortlisted",
    createdAt: "2026-09-06T14:00:00Z", updatedAt: "2026-09-07T14:00:00Z",
    jobId: { _id: "64b000000000000000020003", caseId: APP, title: "Employment records review", status: "open", practiceArea: "Civil Litigation" },
    ...overrides,
  };
}

async function fixture(page, overrides = {}) {
  const state = {
    profile: {
      _id: USER, id: USER, firstName: "Dana", lastName: "Young", role: "paralegal", status: "approved",
      stateExperience: ["New York"], practiceAreas: ["Civil Litigation"], yearsExperience: 6,
      profileImage: "/assets/avatar-placeholder.svg", profilePhotoStatus: "approved",
      preferences: { theme: "light", fontSize: "md" },
      onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true },
      availability: "Available now", availabilityDetails: { status: "available", nextAvailable: null },
    },
    stripe: { readiness: { ready: true, evidenceState: "verified" } },
    dashboard: { activeCases: [], metrics: { activeCases: 0, earnings: 0, earningsLast30Days: 0, earningsTotal: 0, expectedPayouts: 0 } },
    recommendations: { hasMatchingProfile: true, items: [] },
    invites: { items: [] }, applications: [], events: { items: [] }, threads: { threads: [] }, unread: { count: 0 },
    failures: {}, reads: {}, protectedReads: [], mutations: [], ...overrides,
  };
  page.__homeFixture = state;
  page.__homeErrors = [];
  page.__homeFailedResponses = [];
  page.on("pageerror", error => page.__homeErrors.push(error.message));
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/api/") && response.status() >= 400) page.__homeFailedResponses.push({ path, status: response.status() });
  });
  const ownerId = () => String(state.profile._id || state.profile.id);
  await page.clock.setFixedTime(new Date(NOW));
  await page.route("**/api/auth/me", route => json(route, { user: state.profile }));
  await page.route("**/api/auth/workspace-release", route => json(route, { workspace: { schemaVersion: 1, ownerId: ownerId(), role: "paralegal", revision: 1, version: "v2", defaultDestination: "/paralegal-v2.html#/home" } }));
  const endpoints = {
    "/api/users/me": "profile", "/api/paralegal/dashboard": "dashboard", "/api/payments/connect/status": "stripe",
    "/api/jobs/recommended": "recommendations", "/api/cases/invited-to": "invites", "/api/applications/my": "applications",
    "/api/events": "events", "/api/messages/threads?limit=50": "threads", "/api/messages/unread-count": "unread",
  };
  for (const [endpoint, key] of Object.entries(endpoints)) {
    await page.route(["/api/paralegal/dashboard", "/api/cases/invited-to", "/api/events"].includes(endpoint) ? url => url.pathname === endpoint : `**${endpoint}`, async route => {
      state.reads[key] = (state.reads[key] || 0) + 1;
      if (state.gates?.[key]) await state.gates[key];
      return state.failures[key] ? json(route, { error: "Synthetic source unavailable" }, state.failures[key]) : json(route, key === "dashboard" ? {...state.dashboard,metrics:{...state.dashboard.metrics,earningsReport:financial.earnings(ownerId(),state.dashboard.metrics),expectedCompensation:financial.expected(ownerId())}} : key === "invites" ? require('./received-invitation-fixture').receivedInvitations(ownerId(), state[key], new URL(route.request().url()).searchParams) : key === "events" ? eventPage(ownerId(), state[key], new URL(route.request().url()).searchParams) : state[key]);
    });
  }
  await page.route("**/api/cases/completed", route => json(route, { items: [] }));
  await page.route(url => url.pathname === "/api/cases/my-completed", route => json(route, financial.history(ownerId(), [], new URL(route.request().url()).searchParams)));
  await page.route("**/api/account/dashboard-views?scope=paralegal_applications", route => json(route, { scope: "paralegal_applications", views: [] }));
  await page.route("**/api/notifications", route => state.failures.notifications
    ? json(route, { error: "Synthetic Home updates unavailable" }, state.failures.notifications)
    : json(route, state.notifications || []));
  // Home now reads authorized submission metadata for its work/review counts.
  // Missing fixtures must not become real 403s that remove synthetic Matters.
  await page.route("**/api/uploads/case/*?presentation=matter", route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    return state.failures.files ? json(route, { error: "Synthetic files unavailable" }, state.failures.files)
      : json(route, { files: state.files?.[id] || [] });
  });
  await page.route(url => /^\/api\/cases\/[a-f0-9]{24}$/.test(url.pathname), route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const matter = state.dashboard.activeCases.find(item => item.caseId === id);
    return matter ? json(route, { id, title: matter.jobTitle, details: "Review the authorized discovery scope.", tasks: [], matterExperience: { sections: [{ id: "work" }, { id: "files" }, { id: "messages" }] } })
      : json(route, { error: "Synthetic Matter unavailable" }, 404);
  });
  await page.route("**/api/jobs/open?*", route => json(route, { items: state.recommendations.items.map(item => ({ ...item, description: "Review the verified chronology.", applicationEligibility: { ready: true, allowed: true, blockers: [] } })) }));
  await page.route("**/api/users/me/onboarding", route => json(route, { onboarding: state.profile.onboarding }));
  await page.route("**/api/csrf", route => json(route, { csrfToken: "synthetic-home-csrf" }));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(?:cases\/[a-f0-9]{24}|uploads\/case\/|messages\/[a-f0-9]{24})/.test(path)) state.protectedReads.push({ path, method: request.method() });
    if (!/^(GET|HEAD|OPTIONS)$/.test(request.method())) state.mutations.push(path);
  });
  await require('./notification-fixtures').installNotificationReads(page, {
    ownerId, getItems: () => state.notifications || [], getStatus: () => state.failures.notifications || 200,
  });
  return state;
}

async function home(page, view = "") {
  await page.goto(`/paralegal-v2.html#/home${view ? `?view=${view}` : ""}`, { waitUntil: "domcontentloaded" });
  await settled(page);
}

async function settled(page) {
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("[data-v2-home]")).toBeVisible();
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("[data-v2-home]")).toHaveAttribute("data-home-loading", "false");
}

const region = (page, name) => page.getByRole("region", { name, exact: true });
const homeText = page => page.locator("[data-v2-home]");
const workTab = (page, name) => page.getByRole("tab", { name: new RegExp(`^${name}(?: |$)`) });
const detail = page => region(page, "Record details");
async function view(page, name) {
  const destination = page.locator(`[data-desktop-home-view="${name}"]`);
  if (!await destination.isVisible()) await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await destination.click();
  await expect(page.locator("[data-desktop-view]")).toHaveAttribute("data-desktop-view", name);
}
async function signal(page, accessMayChange = false) {
  await page.evaluate(accessMayChange => window.dispatchEvent(new CustomEvent("lpc:lifecycle-refresh", { detail: { sourceId: "synthetic-home-redesign", accessMayChange } })), accessMayChange);
}

test("A: opportunities dominate an approved empty workspace and preserve the recommendation destination", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page, { recommendations: { hasMatchingProfile: true, items: [{ _id: REC, caseId: REC, jobId: "64b000000000000000020004", title: "Contract chronology review", state: "New York", practiceArea: "Civil Litigation", totalAmount: 90000 }] } });
  await home(page);
  await page.screenshot({ path: testInfo.outputPath("home-opportunities.png"), animations: "disabled" });
  await expect(page.locator("[data-home-matter-id]")).toHaveCount(0);
  const row = page.locator(`[data-home-recommendation-id="${REC}"]`);
  await expect(row).toContainText("Contract chronology review");
  await expect(page.getByRole('tab', { name: /^Recommended/ })).toHaveAttribute('aria-selected', 'true');
  await row.click();
  const preview = page.getByRole("link", { name: "Review listing and apply", exact: true });
  await expect(preview).toHaveAttribute("href", new RegExp(`/browse\\?matterId=${REC}`));
  await preview.click();
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "browse");
  await expect(page.getByRole("heading", { level: 1, name: "Contract chronology review", exact: true })).toBeVisible();
});

test("B: invitation decision stays separate from hiring through the existing contextual Work action", async ({ page }) => {
  const state = await fixture(page, { invites: { items: [invitation()] } });
  await page.route(`**/api/cases/${INVITE}/invite/accept`, async route => {
    state.invites.items = [];
    state.applications = [application({ caseId: INVITE, status: "submitted" })];
    return json(route, { ok: true, inviteStatus: "accepted" });
  });
  await home(page);
  await expect(workTab(page, "Invitations")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-home-matter-id]")).toHaveCount(0);
  await page.locator(`[data-home-invitation-id="${INVITE}"]`).click();
  const invite = page.locator(`[data-work-invite-id="${INVITE}"]`);
  await expect(invite).toBeVisible();
  await expect(invite).toContainText("Review the complete asset inventory");
  await expect(invite).toContainText("Accepting confirms interest. Work starts after any requested checks, hiring, and funding.");
  await invite.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect.poll(() => state.mutations.filter(path => path.endsWith("/invite/accept")).length).toBe(1);
  await view(page, "work");
  await settled(page);
  await expect(page.locator("[data-home-invitation-id]")).toHaveCount(0);
  await expect(page.locator("[data-home-matter-id]")).toHaveCount(0);
  await expect(homeText(page)).not.toContainText("You’re hired");
});

test("C: application movement opens the exact record and retains its canonical application destination", async ({ page }) => {
  await fixture(page, { applications: [application({ coverLetter: "The retained letter for application 10003." })] });
  await home(page);
  const row = page.locator(`[data-home-application-id="${APP}"]`);
  await expect(row).toContainText("Shortlisted");
  await expect(row).toHaveAttribute("data-desktop-record", `application:${APP}`);
  await row.click();
  await expect(detail(page)).toContainText("The retained letter for application 10003.");
  await expect(detail(page)).toContainText("Shortlisted");
  await expect(page.locator("[data-home-matter-id]")).toHaveCount(0);
  await expect(homeText(page)).not.toContainText("Since your last visit");
  await page.goto(`/paralegal-v2.html#/work?applicationId=${APP}`);
  const retained = page.getByRole("dialog", { name: "Employment records review", exact: true });
  await expect(retained).toContainText("The retained letter for application 10003.");
  await expect(retained).toContainText("Shortlisted");
});

test("D/F: funded work loads authorized metadata and scope only on selection without message read acknowledgements", async ({ page }) => {
  const state = await fixture(page, {
    dashboard: { activeCases: [active({ latestFileName: "Verified responses.docx", latestUpdate: "Attorney updated the scope" })], metrics: {} },
    threads: { threads: [{ id: MATTER, title: "Discovery response support", unread: 2, updatedAt: "2026-09-08T12:00:00Z" }] }, unread: { count: 2 },
  });
  await home(page);
  const row = page.locator(`[data-home-matter-id="${MATTER}"]`);
  await expect(row).toContainText("Discovery response support");
  await expect(homeText(page)).not.toContainText(/Needs a response|Since your last visit|left off|New files|Payment released/);
  expect(state.protectedReads).toEqual([{ path: `/api/uploads/case/${MATTER}`, method: "GET" }]);
  await row.click();
  await expect(detail(page)).toContainText("Review the authorized discovery scope.");
  await expect(detail(page).getByRole("link", { name: "Open full workspace", exact: true })).toHaveAttribute("href", `paralegal-v2.html#/matter/${MATTER}?tab=work`);
  expect(state.protectedReads.filter(read => read.path === `/api/cases/${MATTER}`)).toEqual([{ path: `/api/cases/${MATTER}`, method: "GET" }]);
  await view(page, "document");
  await expect(homeText(page)).toContainText("Verified responses.docx");
  await expect(homeText(page)).toContainText("Attorney updated the scope");
  await view(page, "matters");
  await expect(page.getByRole("row").filter({ hasText: "Discovery response support" })).toContainText("2 unread");
  expect(state.mutations.filter(path => /\/read$/.test(path))).toEqual([]);
});

test("E/G: authoritative overdue work precedes active work with deterministic Matter tie breaks", async ({ page }) => {
  const first = active({ caseId: "64b000000000000000010010", jobTitle: "First tied deadline", deadlineDate: "2026-09-07" });
  const second = active({ caseId: "64b000000000000000010011", jobTitle: "Second tied deadline", deadlineDate: "2026-09-07" });
  await fixture(page, { dashboard: { activeCases: [second, active(), first], metrics: {} }, invites: { items: [invitation()] }, threads: { threads: [{ id: MATTER, unread: 7 }] }, unread: { count: 7 } });
  await home(page);
  await expect(workTab(page, "Assigned")).toHaveAttribute("aria-selected", "true");
  await expect(region(page, "Needs your action")).toContainText("Unresolved matter deadline is past due");
  await expect(region(page, "Needs your action")).toContainText(/Sep 7|September 7/);
  expect(await page.locator("[data-home-matter-id]").evaluateAll(rows => rows.map(row => row.dataset.homeMatterId))).toEqual([first.caseId, second.caseId, MATTER]);
  await expect(homeText(page)).not.toContainText(/Needs a response|urgent invitation/i);
  await page.locator(`[data-home-matter-id="${first.caseId}"]`).click();
  await expect(detail(page).getByRole("link", { name: "Open full workspace", exact: true })).toHaveAttribute("href", `paralegal-v2.html#/matter/${first.caseId}?tab=work`);
});

test("a verified pre-hiring request is counted separately and opens its exact application requirements", async ({ page }) => {
  await fixture(page, {
    dashboard: { activeCases: [active()], metrics: {} },
    applications: [application({ status: "submitted", preEngagement: { status: "requested", requestedParalegalId: USER, requestedAt: "2026-09-07T16:00:00Z", conflictsCheckRequired: true } })],
    threads: { threads: [{ id: MATTER, unread: 4 }] }, unread: { count: 4 },
  });
  await home(page);
  await expect(page.locator(`[data-home-matter-id="${MATTER}"]`)).toBeVisible();
  await expect(workTab(page, "Applications")).toContainText("1 need action");
  await workTab(page, "Applications").click();
  const request = page.locator(`[data-home-application-id="${APP}"]`);
  await expect(request).toContainText("The attorney needs to verify conflicts before hiring.");
  await request.click();
  await expect(detail(page)).toContainText("Before hiring");
  await expect(detail(page).getByRole("radio", { name: "No known conflict", exact: true })).toBeVisible();
});

test("completed status does not create a payment release and history uses only verified payout groups", async ({ page }) => {
  await fixture(page, { dashboard: { activeCases: [active({ status: "completed", paymentReleased: false })], metrics: { earnings: 840, earningsLast30Days: 1120, earningsTotal: 4820, expectedPayouts: 640 } } });
  await home(page);
  await expect(page.locator("[data-home-matter-id]")).toHaveCount(0);
  await view(page, "history");
  await expect(region(page, "History")).toContainText("$840.00");
  await expect(region(page, "History")).toContainText("$4,820.00");
  await expect(region(page, "History")).not.toContainText("$640.00");
  await expect(homeText(page)).not.toContainText("Payment released");
});

for (const gate of ["profile", "payout"]) {
  test(`${gate === "profile" ? "H" : "I"}: ${gate} readiness affects applications without obscuring permitted active work`, async ({ page }) => {
    const state = await fixture(page, { dashboard: { activeCases: [active()], metrics: {} }, recommendations: { hasMatchingProfile: true, items: [{ _id: REC, caseId: REC, title: "Contract chronology review", totalAmount: 90000 }] } });
    if (gate === "profile") Object.assign(state.profile, { profileImage: "", profilePhotoStatus: "missing" });
    else state.stripe = { readiness: { ready: false, evidenceState: "verified" } };
    await home(page);
    await expect(page.locator(`[data-home-matter-id="${MATTER}"]`)).toBeVisible();
    await workTab(page, "Recommended").click();
    await expect(homeText(page)).toContainText(gate === "profile" ? /profile|photo/i : /payout|Stripe/i);
    await workTab(page, "Assigned").click();
    await expect(page.locator(`[data-home-matter-id="${MATTER}"]`)).toBeVisible();
    await expect(homeText(page)).not.toContainText(/Get paid|Complete your profile/);
  });
}

test("J: quiet successful sources stay compact and do not invent urgency or payment history", async ({ page }, testInfo) => {
  await fixture(page);
  await home(page);
  await expect(page.locator("[data-home-matter-id], [data-home-invitation-id], [data-home-application-id], [data-home-recommendation-id]")).toHaveCount(0);
  await expect(homeText(page)).not.toContainText(/Needs a response|Payment released|Since your last visit|You’re clear|New files/);
  const emptyHeight = await homeText(page).evaluate(element => element.getBoundingClientRect().height);
  expect(emptyHeight).toBeLessThan(1100);
  await page.screenshot({ path: testInfo.outputPath("home-quiet.png"), animations: "disabled" });
  await view(page, "deadlines");
  await expect(page.locator("[data-home-timeline]")).toContainText("No deadlines in this period.");
});

test("K: failed feeds remain unavailable while independent invitations survive, and retry reconciles them", async ({ page }) => {
  const state = await fixture(page, { invites: { items: [invitation()] }, failures: { events: 503, threads: 503, notifications: 503 } });
  await home(page);
  await expect(page.locator(`[data-home-invitation-id="${INVITE}"]`)).toBeVisible();
  await view(page, "deadlines");
  await expect(page.locator('[data-home-deadline-state="unavailable"]')).toContainText("Reminders for this period could not be loaded.");
  await expect(page.locator("[data-home-timeline]")).not.toContainText("No deadlines in this period.");
  await view(page, "inbox");
  await expect(homeText(page)).toContainText("These records could not be loaded.");
  await expect(homeText(page)).not.toContainText("No recorded updates in this view.");
  state.failures = {};
  await homeText(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect(homeText(page)).toContainText("No recorded updates in this view.");
  await view(page, "deadlines");
  await expect(page.locator("[data-home-timeline]")).toContainText("No deadlines in this period.");
  await expect.poll(() => state.reads.events).toBeGreaterThan(1);
  await view(page, "work");
  await expect(page.locator(`[data-home-invitation-id="${INVITE}"]`)).toBeVisible();
});

test("K: a slow source keeps its local loading state while funded work remains available", async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await fixture(page, { dashboard: { activeCases: [active()], metrics: {} }, gates: { events: gate } });
  await page.goto("/paralegal-v2.html#/home", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`[data-home-matter-id="${MATTER}"]`)).toBeVisible();
  await page.locator(`[data-home-matter-id="${MATTER}"]`).click();
  await expect(detail(page).getByRole("link", { name: "Open full workspace", exact: true })).toBeVisible();
  await view(page, "deadlines");
  await expect(page.locator('[data-home-deadline-state="loading"]')).toContainText("Loading reminders for this period");
  await expect(page.locator("[data-home-timeline]")).not.toContainText("No deadlines in this period.");
  release();
  await settled(page);
  await expect(page.locator('[data-home-deadline-state="loading"]')).toHaveCount(0);
  await expect(page.locator("[data-home-timeline]")).toContainText("Discovery response support");
});

test("K: refresh preserves a focused record and an open availability dialog until an explicit safe boundary", async ({ page }) => {
  const state = await fixture(page, { dashboard: { activeCases: [active()], metrics: {} }, notifications: [{ id: "64b000000000000000070001", type: "case_work_updated", message: "The attorney updated the scope.", context: { caseId: MATTER }, action: { label: "Review scope", href: `/case-detail.html?caseId=${MATTER}&tab=work` }, createdAt: NOW, isRead: false }] });
  await home(page, "pulse");
  const trigger = page.locator("[data-v2-availability-trigger]");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /availability/i });
  await expect(dialog).toBeVisible();
  await page.getByLabel("Availability", { exact: true }).selectOption("unavailable");
  const date = page.getByLabel("Available again");
  await date.fill("2026-09-18");
  await date.focus();
  state.dashboard.activeCases[0].jobTitle = "Confirmed refreshed title";
  await signal(page);
  await expect(dialog).toBeVisible();
  await expect(date).toHaveValue("2026-09-18");
  await expect(date).toBeFocused();
  await expect(homeText(page)).toContainText("Discovery response support");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  const refresh = page.getByRole("button", { name: /Refresh Home|Review updates|Show updates|Update Home/i });
  if (await refresh.isVisible()) await refresh.click();
  else await page.locator("[data-v2-route-outlet]").focus();
  await expect(homeText(page)).toContainText("Confirmed refreshed title");
});

test("an explicit retry cannot replace an availability draft when its late source finishes", async ({ page }) => {
  const state = await fixture(page, { failures: { notifications: 503 } });
  await home(page, "pulse");
  let release;
  state.failures = {};
  state.gates = { events: new Promise(resolve => { release = resolve; }) };
  await homeText(page).getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => state.reads.events).toBeGreaterThan(1);
  // Begin editing after the retry's initial partial redraw has committed,
  // while the late event response is still held by the fixture.
  await expect(homeText(page)).toHaveAttribute("data-home-freshness", "current");
  await expect(homeText(page)).toHaveAttribute("data-home-loading", "true");
  await page.locator("[data-v2-availability-trigger]").click();
  await expect(page.getByRole("dialog", { name: /availability/i })).toBeVisible();
  await page.getByLabel("Availability", { exact: true }).selectOption("unavailable");
  const date = page.getByLabel("Available again");
  await date.fill("2026-09-18");
  await date.focus();
  release();
  await expect(page.getByRole("dialog", { name: /availability/i })).toBeVisible();
  await expect(date).toHaveValue("2026-09-18");
  await expect(date).toBeFocused();
  await expect(page.locator("[data-home-refresh-notice]")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("availability mutation prevents duplicate submission, preserves recoverable input, and retains shell nodes", async ({ page }) => {
  const state = await fixture(page);
  let release;
  let attempts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/paralegals/update-availability", async route => {
    attempts += 1;
    if (attempts === 1) { await gate; return json(route, { error: "Synthetic retryable availability failure" }, 503); }
    state.profile.availabilityDetails = { status: "unavailable", nextAvailable: "2026-09-18", updatedAt: "2026-09-08T18:00:00Z" };
    state.profile.availability = "Unavailable";
    return json(route, { ownerId: String(state.profile._id || state.profile.id), availability: state.profile.availability, availabilityDetails: state.profile.availabilityDetails });
  });
  await home(page, "pulse");
  await page.evaluate(() => {
    window.__homeShellNodes = { header: document.querySelector('[data-v2-persistent="header"]'), sidebar: document.querySelector('[data-v2-persistent="sidebar"]') };
  });
  await page.locator("[data-v2-availability-trigger]").click();
  await page.getByLabel("Availability", { exact: true }).selectOption("unavailable");
  await page.getByLabel("Available again").fill("2026-09-18");
  const save = page.locator("[data-v2-availability-save]");
  await save.click();
  await expect(save).toBeDisabled();
  await expect.poll(() => attempts).toBe(1);
  release();
  await expect(save).toBeEnabled();
  await expect(page.getByLabel("Available again")).toHaveValue("2026-09-18");
  expect(attempts).toBe(1);
  await save.click();
  await expect(page.locator("[data-v2-availability-label]")).toContainText(/Not available|Unavailable/);
  expect(attempts).toBe(2);
  await page.locator("[data-v2-availability-trigger]").click();
  await expect(page.getByLabel("Availability", { exact: true })).toHaveValue("unavailable");
  await expect(page.getByLabel("Available again")).toHaveValue("2026-09-18");
  await expect(page.locator("[data-v2-availability-summary]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator(".v2-nav").getByRole("link", { name: "Help", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "help");
  await view(page, "pulse");
  await settled(page);
  expect(await page.evaluate(() => window.__homeShellNodes.header === document.querySelector('[data-v2-persistent="header"]') && window.__homeShellNodes.sidebar === document.querySelector('[data-v2-persistent="sidebar"]'))).toBe(true);
});

test("confirmed availability refreshes another synthetic V2 tab through the existing shared signal", async ({ page, context }) => {
  const state = await fixture(page);
  const second = await context.newPage();
  await fixture(second, state);
  await page.route("**/api/paralegals/update-availability", async route => {
    Object.assign(state.profile, { availability: "Unavailable", availabilityDetails: { status: "unavailable", nextAvailable: "2026-09-18", updatedAt: "2026-09-08T18:00:00Z" } });
    return json(route, { ownerId: String(state.profile._id || state.profile.id), availability: state.profile.availability, availabilityDetails: state.profile.availabilityDetails });
  });
  await Promise.all([home(page, "pulse"), home(second, "pulse")]);
  await page.locator("[data-v2-availability-trigger]").click();
  await page.getByLabel("Availability", { exact: true }).selectOption("unavailable");
  await page.getByLabel("Available again").fill("2026-09-18");
  await page.locator("[data-v2-availability-save]").click();
  await expect(second.locator("[data-v2-availability-label]")).toHaveText("Not available");
  await expect(second.locator("[data-home-matter-id]")).toHaveCount(0);
});

test("L: authorization loss removes prior Home matter content and its continuation action", async ({ page }) => {
  const state = await fixture(page, { dashboard: { activeCases: [active()], metrics: {} } });
  await home(page);
  await expect(page.locator(`[data-home-matter-id="${MATTER}"]`)).toBeVisible();
  state.failures.dashboard = 403;
  await signal(page, true);
  await expect(page.locator(`[data-home-matter-id="${MATTER}"]`)).toHaveCount(0);
  await expect(homeText(page)).not.toContainText("Discovery response support");
  await expect(homeText(page)).toContainText(/restricted|unavailable|access/i);
});

test("L: expired session leaves the protected shell instead of turning the failed source into empty work", async ({ page }) => {
  await fixture(page, { failures: { dashboard: 401 } });
  await page.route("**/login.html?**", route => route.fulfill({ contentType: "text/html", body: "<h1>Sign in</h1>" }));
  await page.goto("/paralegal-v2.html#/home");
  await expect(page).toHaveURL(/login\.html/);
  await expect(page.locator("[data-v2-home]")).toHaveCount(0);
});

test("L: a synthetic identity replacement cannot restore the previous user's late Home response", async ({ page }) => {
  const state = await fixture(page, { dashboard: { activeCases: [active()], metrics: {} } });
  await home(page);
  let release;
  let delayed = false;
  await page.route(/\/api\/paralegal\/dashboard(?:\?|$)/, async route => {
    if (!delayed) {
      delayed = true;
      await new Promise(resolve => { release = resolve; });
      return json(route, { activeCases: [active({ jobTitle: "Previous user delayed private title" })], metrics: {} });
    }
    return json(route, { activeCases: [], metrics: {} });
  });
  await signal(page, true);
  await expect.poll(() => delayed).toBe(true);
  const previous = state.profile;
  state.profile = { ...previous, _id: "64b000000000000000000002", id: "64b000000000000000000002", firstName: "Morgan" };
  await page.evaluate(({ previous, next }) => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user", oldValue: JSON.stringify(previous), newValue: JSON.stringify(next) })), { previous, next: state.profile });
  await expect(page.locator("[data-v2-profile-name]")).toContainText("Morgan");
  release();
  await expect(page.locator("[data-home-matter-id]")).toHaveCount(0);
  await expect(homeText(page)).not.toContainText(/Previous user|Discovery response support/);
});

test("Home keeps the stored dark theme and shared Assistant behavior at desktop and mobile", async ({ page }, testInfo) => {
  const state = await fixture(page, { dashboard: { activeCases: [active()], metrics: {} } });
  state.profile.preferences.theme = "dark";
  await page.addInitScript(profile => localStorage.setItem("lpc_user", JSON.stringify(profile)), state.profile);
  await page.route("**/api/support/conversation**", route => {
    expect(route.request().method()).toBe("GET");
    return json(route, { conversation: { id: "64b000000000000000080001", status: "open" }, messages: [] });
  });
  await home(page);
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
  await expect(page.locator(".lc-list")).toHaveCSS("background-color", "rgb(17, 27, 42)");
  for (const width of [1440, 768]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.getByRole("button", { name: "Open LPC Assistant", exact: true }).click();
    const drawer = page.locator('[data-v2-persistent="assistant"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
    const colors = await drawer.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, sendBackground: getComputedStyle(element.querySelector(".support-send")).backgroundColor, sendColor: getComputedStyle(element.querySelector(".support-send")).color, sendOpacity: getComputedStyle(element.querySelector(".support-send")).opacity }));
    expect(colors).toEqual({ background: "rgb(17, 27, 42)", sendBackground: "rgb(55, 105, 177)", sendColor: "rgb(255, 255, 255)", sendOpacity: "0.45" });
    const composer = drawer.getByRole("textbox", { name: "Ask Assistant a question", exact: true });
    await composer.fill("Synthetic unsent draft");
    await expect(drawer.locator(".support-send")).toBeEnabled();
    expect(await drawer.locator(".support-send").evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color }))).toEqual({ background: "rgb(55, 105, 177)", color: "rgb(255, 255, 255)" });
    await composer.fill("");
    await expect(drawer.locator(".support-send")).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`home-assistant-${width}.png`), animations: "disabled" });
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations).toEqual([]);
    await drawer.getByRole("button", { name: "Close assistant", exact: true }).click();
    await expect(drawer).toHaveAttribute("aria-hidden", "true");
  }
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.locator(".v2-nav").getByRole("link", { name: "Help", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "help");
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
  expect(await page.locator('[data-v2-route-outlet]').evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgb(255, 255, 255)");
});

test("committed Home keeps its stored theme during delayed navigation and after returning", async ({ page }) => {
  const state = await fixture(page);
  state.profile.preferences.theme = "dark";
  await page.addInitScript(profile => localStorage.setItem("lpc_user", JSON.stringify(profile)), state.profile);
  await home(page);
  await expect(page.locator(".lc-list")).toHaveCSS("background-color", "rgb(17, 27, 42)");
  const originalCanvas = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  let releaseBrowse;
  let browsing = false;
  const browseGate = new Promise(resolve => { releaseBrowse = resolve; });
  await page.route("**/api/jobs/open?*", async route => { browsing = true; await browseGate; return json(route, { items: [] }); });
  await page.locator(".v2-desktop-more > summary").click();
  await page.locator(".v2-nav").getByRole("link", { name: "Browse matters", exact: true }).click();
  await expect.poll(() => browsing).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-route", "browse");
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "home");
  await expect(homeText(page)).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(originalCanvas);
  await expect(page.locator(".lc-list")).toHaveCSS("background-color", "rgb(17, 27, 42)");
  releaseBrowse();
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "browse");
  await expect(homeText(page)).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  let releaseHome;
  state.gates = { dashboard: new Promise(resolve => { releaseHome = resolve; }) };
  await page.clock.setFixedTime(new Date(new Date(NOW).getTime() + 31000));
  await view(page, "work");
  await expect.poll(() => state.reads.dashboard).toBeGreaterThan(1);
  await expect(page.locator("html")).toHaveAttribute("data-lpc-v2-committed-route", "home");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(originalCanvas);
  await expect(page.locator(".lc-list")).toHaveCSS("background-color", "rgb(17, 27, 42)");
  await expect(workTab(page, "Assigned")).toContainText("…");
  await workTab(page, "Assigned").click();
  await expect(workTab(page, "Assigned")).toHaveAttribute("aria-selected", "true");
  await expect(homeText(page)).toContainText("Loading records…");
  await expect(homeText(page)).not.toContainText("No records in this view.");
  releaseHome();
  const updates = page.locator("[data-home-refresh-notice]");
  await expect(updates).toContainText("Updates available.");
  await updates.getByRole("button", { name: "Refresh Home", exact: true }).click();
  await settled(page);
  await expect(page.locator("html")).toHaveClass(/theme-dark/);
});

test("visual contract: required widths, long content, loaded Sarabun, white surfaces, keyboard and reduced motion", async ({ page }, testInfo) => {
  test.setTimeout(180000);
  await fixture(page, {
    dashboard: { activeCases: [active({ jobTitle: "Discovery response support for a complex consolidated matter with several exceptionally long party names", attorneyName: "Jordan Alexandra Lee and Associates" })], metrics: { earnings: 840, earningsTotal: 4820, expectedPayouts: 640 } },
    invites: { items: [invitation()] }, applications: [application()],
    recommendations: { hasMatchingProfile: true, items: [{ _id: REC, caseId: REC, title: "Contract chronology review", totalAmount: 90000 }] },
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await home(page);
  for (const width of [375, 768, 1440, 1920, 320]) {
    await page.setViewportSize({ width, height: width < 600 ? 900 : 1080 });
    await page.evaluate(() => document.fonts.ready);
    await page.locator("[data-v2-route-outlet]").evaluate(element => { element.scrollTop = 0; });
    const rendered = await page.evaluate(() => {
      const outlet = document.querySelector("[data-v2-route-outlet]");
      const root = document.querySelector("[data-v2-home]");
      const surfaces = [document.documentElement, document.body, outlet, root, document.querySelector('[data-v2-persistent="sidebar"]'), document.querySelector('[data-v2-persistent="header"]')].filter(Boolean);
      const background = element => {
        for (let node = element; node; node = node.parentElement) {
          const value = getComputedStyle(node).backgroundColor;
          if (value !== "rgba(0, 0, 0, 0)" && value !== "transparent") return value;
        }
        return "rgb(255, 255, 255)";
      };
      const luminance = color => {
        const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      const textSamples = [...root.querySelectorAll("*")].filter(element => element.getBoundingClientRect().width && element.getBoundingClientRect().height && [...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())).map(element => {
        const foreground = getComputedStyle(element).color;
        const surface = background(element);
        const values = [luminance(foreground), luminance(surface)].sort((a, b) => b - a);
        return { text: element.textContent.trim().slice(0, 70), color: foreground, background: surface, contrast: (values[0] + .05) / (values[1] + .05) };
      });
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, outletWidth: outlet.clientWidth, outletScrollWidth: outlet.scrollWidth, backgrounds: surfaces.map(background), font: getComputedStyle(root).fontFamily, sarabunLoaded: [...document.fonts].some(face => /Sarabun/i.test(face.family) && face.status === "loaded"), textSamples, nonWhiteSurfaces: [...root.querySelectorAll("section, article, details, input, select, dialog")].filter(element => background(element) !== "rgb(255, 255, 255)").map(element => ({ tag: element.tagName, class: element.className, color: background(element) })) };
    });
    expect(rendered.documentWidth, `${width}px document overflow`).toBeLessThanOrEqual(rendered.viewport + 1);
    expect(rendered.outletScrollWidth, `${width}px workspace overflow`).toBeLessThanOrEqual(rendered.outletWidth + 1);
    expect(rendered.backgrounds).toEqual(rendered.backgrounds.map(() => "rgb(255, 255, 255)"));
    expect(rendered.nonWhiteSurfaces).toEqual([]);
    expect(rendered.font).toContain("Sarabun");
    expect(rendered.sarabunLoaded).toBe(true);
    expect(rendered.textSamples.filter(sample => !["rgb(26, 31, 54)", "rgb(71, 114, 188)", "rgb(102, 112, 133)", "rgb(255, 255, 255)"].includes(sample.color))).toEqual([]);
    expect(rendered.textSamples.filter(sample => sample.contrast < 4.5)).toEqual([]);
    const evidencePath = testInfo.outputPath(`rendered-home-${width}.json`);
    await writeFile(evidencePath, JSON.stringify(rendered, null, 2));
    await testInfo.attach(`rendered-home-${width}`, { path: evidencePath, contentType: "application/json" });
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(axe.violations, `${width}px accessibility`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 375, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
  await view(page, "pulse");
  const trigger = page.locator("[data-v2-availability-trigger]");
  // Establish keyboard modality before focusing this specific control; the
  // engines do not share a next/previous Tab order around browser chrome.
  await page.keyboard.press("Tab");
  await trigger.focus();
  await expect(trigger).toBeFocused();
  const focusStyle = await trigger.evaluate(element => ({ style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth }));
  expect(focusStyle.style).not.toBe("none");
  expect(parseFloat(focusStyle.width)).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /availability/i });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    // Native modal dialogs may cycle to browser chrome (body is activeElement)
    // but must never focus an application control behind the modal.
    expect(await dialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.emulateMedia({ forcedColors: "active" });
  expect(await homeText(page).evaluate(element => getComputedStyle(element).forcedColorAdjust)).not.toBe("none");
});
