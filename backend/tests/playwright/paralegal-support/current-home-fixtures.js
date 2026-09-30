const { eventPage } = require("./event-page-fixture");
const { receivedInvitations } = require("./received-invitation-fixture");
const { installNotificationReads } = require("./notification-fixtures");
const { expect } = require("playwright/test");

// Isolated synthetic records. These tests never connect to production or read
// confidential matter detail until an explicit workspace navigation is tested.
const USER = "64b000000000000000000001";
const FIRST = "64b000000000000000010001";
const SECOND = "64b000000000000000010010";
const INVITE = "64b000000000000000010002";
const APPLICATION = "64b000000000000000010003";
const RECOMMENDATION = "64b000000000000000010004";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function active(overrides = {}) {
  return {
    caseId: FIRST, jobId: "64b000000000000000020001", jobTitle: "Discovery response support",
    attorneyName: "Jordan Lee", practiceArea: "Civil Litigation", status: "in progress",
    deadlineDate: "2026-10-01", archived: false, paymentReleased: false,
    escrowStatus: "funded", escrowIntentId: "pi_synthetic_desktop", paralegalId: USER,
    tasksTotal: 5, tasksRemaining: 2, latestUpdate: "Attorney updated the scope",
    latestFileName: "Verified responses.docx", ...overrides,
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
    dashboard: { activeCases: [active(), active({ caseId: SECOND, jobTitle: "Affidavit chronology review", deadlineDate: "2026-10-02" })], metrics: { earnings: 840, earningsTotal: 4820 } },
    recommendations: { hasMatchingProfile: true, items: [{ _id: RECOMMENDATION, caseId: RECOMMENDATION, title: "Contract chronology review", state: "New York", practiceArea: "Civil Litigation", totalAmount: 90000 }] },
    invites: { items: [{ _id: INVITE, caseId: INVITE, title: "Probate inventory support", inviteStatus: "pending", inviteInvitedAt: "2026-09-07T14:00:00Z", briefSummary: "Prepare a verified asset inventory.", practiceArea: "Probate", state: "New York" }] },
    applications: [{ _id: APPLICATION, caseId: APPLICATION, paralegalId: USER, status: "shortlisted", createdAt: "2026-09-06T14:00:00Z", updatedAt: "2026-09-07T14:00:00Z", jobId: { _id: "64b000000000000000020003", caseId: APPLICATION, title: "Employment records review", status: "open", practiceArea: "Civil Litigation" } }],
    events: { items: [] }, threads: { threads: [{ id: FIRST, title: "Discovery response support", unread: 2, updatedAt: "2026-09-08T12:00:00Z" }] }, unread: { count: 2 },
    failures: {}, reads: {}, protectedReads: [], mutations: [], documentResponses: 0, ...overrides,
  };
  await page.clock.setFixedTime(new Date("2026-09-08T16:00:00Z"));
  await page.addInitScript(() => {
    window.__desktopCopiedLinks = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.__desktopCopiedLinks.push(value); } } });
  });
  await page.route("**/api/auth/me", route => json(route, { user: state.profile }));
  await installNotificationReads(page, { ownerId: USER, getItems: () => state.notifications || [], getStatus: () => state.failures.notifications || 200 });
  const endpoints = {
    "/api/users/me": "profile", "/api/paralegal/dashboard": "dashboard", "/api/payments/connect/status": "stripe",
    "/api/jobs/recommended": "recommendations", "/api/cases/invited-to": "invites", "/api/applications/my": "applications",
    "/api/events": "events", "/api/messages/threads?limit=50": "threads", "/api/messages/unread-count": "unread",
  };
  for (const [endpoint, key] of Object.entries(endpoints)) {
    const matcher = ["/api/paralegal/dashboard", "/api/cases/invited-to", "/api/events"].includes(endpoint) ? url => url.pathname === endpoint : `**${endpoint}`;
    await page.route(matcher, route => {
      state.reads[key] = (state.reads[key] || 0) + 1;
      if (key === "events" && state.eventRespond) return state.eventRespond(route);
      return state.failures[key] ? json(route, { error: "Synthetic source unavailable" }, state.failures[key]) : json(route, key === "invites" ? receivedInvitations(USER, state[key], new URL(route.request().url()).searchParams) : key === "events" ? eventPage(USER, state[key], new URL(route.request().url()).searchParams) : state[key]);
    });
  }
  await page.route("**/api/cases/completed", route => json(route, { items: [] }));
  await page.route("**/api/jobs/open", route => json(route, { items: state.recommendations.items }));
  await page.route("**/api/users/me/onboarding", route => json(route, { onboarding: state.profile.onboarding }));
  await page.route("**/api/csrf", route => json(route, { csrfToken: "synthetic-desktop-csrf" }));
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/(?:cases\/[a-f0-9]{24}|uploads\/case\/|messages\/[a-f0-9]{24})/.test(path)) state.protectedReads.push({ path, method: request.method() });
    if (!/^(GET|HEAD|OPTIONS)$/.test(request.method())) state.mutations.push(path);
  });
  page.on("response", response => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && response.status() >= 200 && response.status() < 400) state.documentResponses += 1;
  });
  return state;
}

async function home(page, query = "?view=work") {
  await page.goto(`/paralegal-v2.html${query === "__default" ? "" : "#/home"+query}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  if (query === "?view=history") await expect(page.locator("[data-v2-payouts]")).not.toHaveAttribute("data-state", "loading");
  else await expect(page.locator("[data-v2-home]")).toHaveAttribute("data-home-loading", "false");
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => { window.__desktopOriginalDocument = document; window.__desktopOriginalSidebar = document.querySelector("[data-v2-persistent='sidebar']"); });
}

async function expectSameDocument(page, state) {
  // WebKit may emit a cancelled document request for a prevented anchor. Count
  // actual document responses and verify the exact document and shell nodes.
  expect(state.documentResponses).toBe(1);
  expect(await page.evaluate(() => window.__desktopOriginalDocument === document && window.__desktopOriginalSidebar === document.querySelector("[data-v2-persistent='sidebar']"))).toBe(true);
}


const FILE='64b000000000000000050001', WAIT='64b000000000000000050002';
const LONG='Discovery response support — prepare and verify the complete chronology of supplemental production, disputed exhibits, and attorney instructions across multiple jurisdictions without shortening this title';
async function contractFixture(page,overrides={}) {
 const state=await fixture(page,{dashboard:{activeCases:[active({jobTitle:LONG}),active({caseId:SECOND,jobTitle:'Affidavit chronology review',tasksRemaining:0})],metrics:{}},...overrides});
 state.files={[FIRST]:[{id:FILE,caseId:FIRST,originalName:'Discovery response.docx',uploadedByRole:'paralegal',status:'attorney_revision',revisionNotes:'Correct citations on pages 3–5 and replace exhibit 4.',revisionRequestedAt:'2026-09-07T12:00:00Z',securityStatus:'clean',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',size:15000}], [SECOND]:[{id:WAIT,caseId:SECOND,originalName:'Affidavit chronology.pdf',uploadedByRole:'paralegal',status:'pending_review',uploadedAt:'2026-09-08T10:00:00Z',securityStatus:'clean'}]};
 state.notifications=[{id:'64b000000000000000070001',type:'case_work_updated',message:'Scope revised to include supplemental production.',actorFirstName:'Jordan',context:{caseId:FIRST},action:{label:'View scope',href:`/case-detail.html?caseId=${FIRST}&tab=work`},createdAt:'2026-09-08T13:00:00Z',isRead:false,available:true},{id:'64b000000000000000070002',type:'case_file_uploaded',message:'Jordan shared a revised discovery response.',context:{caseId:FIRST,fileId:FILE},action:{label:'View file',href:`/case-detail.html?caseId=${FIRST}&tab=files&fileId=${FILE}`},createdAt:'2026-09-07T13:00:00Z',isRead:false,available:true}];
 await page.route('**/api/notifications',route=>state.failures.notifications?json(route,{error:'Unavailable'},503):json(route,state.notifications));
 await page.route('**/api/notifications/unread-count',route=>json(route,{count:state.notifications.filter(n=>!n.isRead).length}));
 await page.route('**/api/notifications/*/read',route=>{const id=new URL(route.request().url()).pathname.split('/').at(-2);const item=state.notifications.find(n=>n.id===id);if(item)item.isRead=true;return json(route,{success:true});});
 await page.route('**/api/uploads/case/*?presentation=matter',route=>{const id=new URL(route.request().url()).pathname.split('/').at(-1);return state.failures.files?json(route,{error:'Files unavailable'},state.failures.files):json(route,{files:state.files[id]||[]});});
 await page.route(url => url.pathname === `/api/cases/${FIRST}`,route=>json(route,{id:FIRST,title:LONG,details:'Prepare a verified chronology of supplemental production. Include the attorney-approved exhibits and identify citation discrepancies.',tasks:[{title:'Verify citations against the production index',completed:false}],matterExperience:{sections:[{id:'work'},{id:'files'},{id:'messages'}]}}));
 await page.route('**/api/support/conversation**',route=>json(route,{conversation:{id:'synthetic',status:'open'},messages:[]}));
 return state;
}
const tab=(page,name)=>page.getByRole('tab',{name:new RegExp('^'+name+'(?: |$)')});
const view=async(page,name)=>{await page.locator(`[data-desktop-home-view="${name}"]`).click();await expect(page.locator('.lc-workspace')).toHaveAttribute('data-workspace-view',name);};

async function installCurrentHome(page, overrides = {}) {
 const state = await contractFixture(page, overrides);
 const financial = require('./financial-fixtures');
 state.dashboard.metrics = { ...state.dashboard.metrics, earningsReport: financial.earnings(USER, state.dashboard.metrics), expectedCompensation: financial.expected(USER) };
 await page.route(url => url.pathname === `/api/cases/${SECOND}`, route => json(route, { id: SECOND, title: 'Affidavit chronology review', details: 'Review the verified affidavit chronology.', tasks: [], matterExperience: { sections: [{ id: 'work' }, { id: 'files' }] } }));
 return state;
}
module.exports = { USER, FIRST, SECOND, INVITE, APPLICATION, RECOMMENDATION, FILE, WAIT, LONG, json, active, installCurrentHome, home, expectSameDocument, tab, view };
