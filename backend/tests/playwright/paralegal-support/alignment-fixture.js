const { expect } = require("playwright/test");
const { eventPage } = require("./event-page-fixture");
const { browsePageFixture } = require("./browse-page-fixture");
const financial = require("./financial-fixtures");
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
  await page.route(url => url.pathname === "/api/account/dashboard-views", route => json(route, {ownerId: ownerId(),scope:"paralegal_applications",views:[]}));
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



module.exports={USER,MATTER,INVITE,APP,REC,NOW,json,active,invitation,application,fixture,home,settled};
