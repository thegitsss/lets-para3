const { eventPage } = require("./event-page-fixture");
const { receivedInvitations } = require("./received-invitation-fixture");
const { installNotificationReads } = require("./notification-fixtures");
const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;

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
  await page.route("**/api/auth/workspace-release", route => json(route, { workspace: { schemaVersion: 1, ownerId: String(state.profile._id || state.profile.id), role: "paralegal", revision: 1, version: "v2", defaultDestination: "/paralegal-v2.html#/home" } }));
  await installNotificationReads(page, { ownerId: () => String(state.profile._id || state.profile.id), getItems: () => state.notifications || [], getStatus: () => state.failures.notifications || 200 });
  const endpoints = {
    "/api/users/me": "profile", "/api/paralegal/dashboard": "dashboard", "/api/payments/connect/status": "stripe",
    "/api/jobs/recommended": "recommendations", "/api/cases/invited-to": "invites", "/api/applications/my": "applications",
    "/api/events": "events", "/api/messages/threads?limit=50": "threads", "/api/messages/unread-count": "unread",
  };
  for (const [endpoint, key] of Object.entries(endpoints)) {
    const matcher = ["/api/paralegal/dashboard", "/api/cases/invited-to", "/api/events"].includes(endpoint) ? url => url.pathname === endpoint : `**${endpoint}`;
    await page.route(matcher, route => {
      state.reads[key] = (state.reads[key] || 0) + 1;
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
  await page.route('**/api/uploads/case/*?presentation=matter', route => json(route, {files: []}));
  await page.route(/\/api\/cases\/[a-f0-9]{24}$/, route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    const row = state.dashboard.activeCases.find(row => row.caseId === id);
    return row ? json(route, {id, title: row.jobTitle, details: 'Prepare the verified matter scope.', matterExperience: {sections: [{id:'work'},{id:'files'}]}}) : json(route, {error:'Unavailable'}, 403);
  });
  await page.route('**/api/notifications', route => json(route, state.dashboard.activeCases.length ? [{id:'64b000000000000000070001',type:'case_work_updated',message:'Scope revised for supplemental production.',context:{caseId:FIRST},action:{href:`/case-detail.html?caseId=${FIRST}&tab=work`},createdAt:'2026-09-08T13:00:00Z',isRead:false}] : []));
  return state;
}

async function home(page, query = "") {
  await page.goto(`/paralegal-v2.html#/home${query}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("body")).toHaveAttribute("data-v2-session", "ready");
  await expect(page.locator("[data-v2-home]")).toHaveAttribute("data-home-loading", "false");
  await expect(page.locator("[data-v2-route-outlet]")).not.toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => { window.__desktopOriginalDocument = document; window.__desktopOriginalSidebar = document.querySelector("[data-v2-persistent='sidebar']"); });
}

async function expectSameDocument(page, state) {
  // WebKit may emit a cancelled document request for a prevented anchor. Count
  // actual document responses and verify the exact document and shell nodes.
  expect(state.documentResponses).toBe(1);
  expect(await page.evaluate(() => window.__desktopOriginalDocument === document && window.__desktopOriginalSidebar === document.querySelector("[data-v2-persistent='sidebar']"))).toBe(true);
}

const fs=require('node:fs');
const shot=(page,info,name)=>page.screenshot({path:info.outputPath(`${info.project.name}-${name}.png`)});
const openView=async(page,view)=>{await page.locator(`[data-desktop-home-view="${view}"]`).click();await expect(page.locator('.ld-desktop')).toHaveAttribute('data-desktop-view',view);};
const rich=()=>({dashboard:{activeCases:Array.from({length:9},(_,i)=>active({caseId:(BigInt('0x'+FIRST)+BigInt(i)).toString(16),jobTitle:['Discovery response support','Affidavit chronology review','Prepare deposition exhibits','Review employment records','Organize production index','Verify document citations','Draft research memorandum','Review contract chronology','Prepare hearing materials'][i],status:i<3?'reviewing':i<6?'in progress':'awaiting_documents',tasksTotal:5+i,tasksRemaining:2,latestUpdateAt:'2026-09-08T12:00:00Z'})),metrics:{earnings:840,earningsTotal:4820}}});
const views=['pulse','inbox','work','reviews','matters','deadlines','board','insights','document'];
test('full-window geometry and persistent desktop destinations',async({page},info)=>{
 const state=await fixture(page,rich()),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setViewportSize({width:1440,height:900});await home(page);await expect(page.locator('[data-home-detail-title]')).toHaveCount(0);
 const geometry=await page.evaluate(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}};return{sidebar:r('.v2-sidebar'),frame:r('.v2-app-frame'),row:r('.v2-desktop-primary .v2-nav-link'),heading:r('.lc-heading'),tools:r('.lc-toolbar')}});
 fs.writeFileSync(info.outputPath(`${info.project.name}-geometry.json`),JSON.stringify(geometry,null,2));
 expect(geometry.sidebar.width).toBe(230);expect(geometry.row.width).toBe(201);expect(geometry.row.height).toBe(36);expect(geometry.frame.x).toBe(230);expect(geometry.frame.y).toBe(0);expect(geometry.frame.width).toBe(1210);expect(geometry.frame.height).toBe(900);expect(geometry.heading.height).toBeCloseTo(84,1);expect(geometry.tools.height).toBeCloseTo(52,1);
 await shot(page,info,'default-work');for(const view of views){await openView(page,view);await shot(page,info,view);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.locator('.ld-desktop')).not.toContainText('null');}
 expect(errors).toEqual([]);expect(state.protectedReads.every(read=>read.method==='GET' && read.path.startsWith('/api/uploads/case/'))).toBe(true);expect(state.mutations).toEqual([]);await expectSameDocument(page,state);
});

test('filter, contextual return and the existing board preserve real records',async({page})=>{
 const state=await fixture(page,rich());await home(page,'?view=work');await page.getByRole('button',{name:'Filter records',exact:true}).click();await page.getByRole('searchbox',{name:'Filter records'}).fill('Affidavit');await expect(page.locator('.lc-row')).toHaveCount(1);await page.locator('.lc-row').click();await expect(page.locator('[data-home-detail-title]')).toHaveText('Affidavit chronology review');await expect(page.locator('.lc-context')).toContainText('Prepare the verified matter scope.');await page.getByRole('button',{name:'Close details',exact:true}).click();await expect(page.locator('.lc-row')).toBeFocused();await expect(page.getByRole('searchbox',{name:'Filter records'})).toHaveValue('Affidavit');await page.getByRole('searchbox',{name:'Filter records'}).fill('');await openView(page,'board');await expect(page.locator('.ld-card')).toHaveCount(9);await openView(page,'inbox');await expect(page.locator('.lc-list')).toBeVisible();await expect(page.locator('.lc-context')).toBeVisible();await page.getByRole('tab',{name:/^Unread/}).click();await expect(page.locator('.lc-event')).toHaveCount(1);await page.goBack();await expect(page.locator('.ld-desktop')).toHaveAttribute('data-desktop-view','board');expect(state.mutations).toEqual([]);await expectSameDocument(page,state);
});

test('mobile navigation and all views fit',async({page},info)=>{
 await fixture(page,rich());await page.setViewportSize({width:375,height:812});await home(page);await expect(page.locator('.lc-row').first()).toBeVisible();await shot(page,info,'mobile-work');for(const view of views){await page.getByRole('button',{name:'Open navigation'}).click();await openView(page,view);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}await page.setViewportSize({width:320,height:760});await shot(page,info,'mobile-document');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('empty and failed records remain honest',async({page})=>{
 const state=await fixture(page,{dashboard:{activeCases:[],metrics:{}},invites:{items:[]},applications:[],recommendations:{hasMatchingProfile:true,items:[]},threads:{threads:[]},unread:{count:0}});await home(page);await expect(page.locator('[data-home-detail-title]')).toHaveCount(0);await expect(page.locator('.lc-list .lc-empty')).toContainText('No records in this view');await openView(page,'inbox');await expect(page.locator('.lc-list .lc-empty')).toContainText('No recorded updates');state.failures.dashboard=503;await page.goto('/paralegal-v2.html#/home?view=work');await page.reload();await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading','false');await expect(page.locator('.lc-source')).toContainText('could not be loaded');
});

test('accessible main compositions use LPC type and colors',async({page})=>{
 await fixture(page,rich());await home(page);for(const view of ['overview','work','inbox','insights']){if(view!=='overview')await openView(page,view);const result=await new AxeBuilder({page}).include('[data-v2-route-outlet]').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);}const styles=await page.locator('.ld-desktop').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,font:getComputedStyle(el).fontFamily}));expect(styles.background).toBe('rgb(255, 255, 255)');expect(styles.color).toBe('rgb(26, 31, 54)');expect(styles.font).toContain('Sarabun');
});

test('workspace menu, search, collapse and original Assistant retain their owners',async({page},info)=>{
 await fixture(page,rich());await page.setViewportSize({width:1440,height:900});
 await page.route('**/api/support/conversation**',route=>json(route,{conversation:{id:'linear-local',status:'open'},messages:[]}));
 await home(page);
 await page.locator('[data-v2-profile-trigger]').click();await expect(page.locator('[data-v2-profile-menu]')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('[data-v2-profile-menu]')).toBeHidden();
 await page.locator('[data-v2-search-input]').fill('Discovery');await expect(page.locator('[data-v2-search-panel]')).toBeVisible();await page.keyboard.press('Escape');
 await page.locator('[data-v2-sidebar-grip]').click();await expect(page.locator('body')).toHaveClass(/v2-sidebar-collapsed/);await page.locator('[data-v2-sidebar-grip]').click();
 await page.locator('[data-v2-assistant-trigger]').click();const drawer=page.locator('#supportDrawer');await expect(drawer).toBeVisible();
 const dimensions=await drawer.boundingBox();expect(dimensions.width).toBe(420);expect(dimensions.height).toBe(900);
 await drawer.locator('[data-support-textarea]').fill('Review this matter');await shot(page,info,'assistant');await page.keyboard.press('Escape');await expect(drawer).toBeHidden();
 await page.locator('[data-v2-assistant-trigger]').click();await expect(drawer.locator('[data-support-textarea]')).toHaveValue('Review this matter');
});

test('source access loss clears selected detail and the protected favorite',async({page})=>{
 const state=await fixture(page,rich());await home(page);await page.locator('.lc-row').first().click();await expect(page.locator('[data-home-detail-title]')).toBeVisible();state.failures.dashboard=403;
 await page.mouse.move(0,0);await page.evaluate(()=>{document.activeElement?.blur();window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh',{detail:{sourceId:'linear-test',accessMayChange:true}}));});
 await expect(page.locator('[data-home-detail-title]')).toHaveCount(0);await expect(page.locator('[data-v2-desktop-matters]')).not.toContainText('Discovery response support');await expect(page.locator('.lc-source')).toContainText('no longer available');
});

test('availability stays confirmed and duplicate saves are prevented',async({page})=>{
 const state=await fixture(page);let calls=0,release;
 await page.route('**/api/paralegals/update-availability',async route=>{calls++;await new Promise(resolve=>release=resolve);Object.assign(state.profile,{availability:'Unavailable',availabilityDetails:{status:'unavailable',nextAvailable:'2026-09-18',updatedAt:'2026-09-08T18:00:00Z'}});return json(route,{...state.profile,ownerId:String(state.profile._id||state.profile.id)});});
 try {
  await home(page,'?view=pulse');await page.locator('[data-v2-availability-trigger]').click();
  await page.getByLabel('Availability',{exact:true}).selectOption('unavailable');await page.getByLabel('Available again').fill('2026-09-18');
  await page.locator('[data-v2-availability-save]').click();
  // Save locks immediately, before the owner preflight and guarded request arrive.
  await expect.poll(()=>calls).toBe(1);
  await expect(page.locator('[data-v2-availability-save]')).toBeDisabled();
  await expect(page.locator('[data-v2-availability-label]')).toHaveText('Available now');
  release();await expect(page.getByRole('dialog',{name:'Update availability'})).toHaveCount(0);
  await expect(page.locator('[data-v2-availability-label]')).toHaveText('Not available');expect(calls).toBe(1);
 } finally { release?.(); }
});

test('application and invitation selections cannot open a similarly named matter',async({page})=>{
 const state=await fixture(page,{applications:[{_id:APPLICATION,caseId:'64b000000000000000019999',paralegalId:USER,status:'shortlisted',jobId:{_id:'64b000000000000000029999',title:'Discovery response support',status:'open'}}]});await home(page,'?view=work');await page.getByRole('tab',{name:/^Applications/}).click();await page.locator('[data-home-application-id]').click();await expect(page.locator('[data-home-desktop-detail]')).toContainText('Shortlisted');await expect(page.locator('.lc-context')).not.toContainText('Prepare the verified matter scope.');expect(state.protectedReads.some(read=>read.path.includes('019999'))).toBe(false);expect(state.mutations).toEqual([]);
});

test('document controls and timeline periods change the requested content',async({page})=>{
 const state=await fixture(page,rich());
 const selected=state.dashboard.activeCases.find(row=>row.jobTitle==='Affidavit chronology review');
 await home(page,'?view=document');
 await page.getByRole('button',{name:'Choose matter',exact:true}).click();
 await page.getByRole('navigation',{name:'Choose matter'}).getByRole('button',{name:selected.jobTitle,exact:true}).click();
 const overview=page.locator('.ld-document'),properties=overview.locator('.ld-document-facts');
 await expect(overview.getByRole('heading',{level:2})).toHaveText(selected.jobTitle);
 await expect(properties).toContainText('Jordan Lee');
 await page.getByRole('button',{name:'Show properties',exact:true}).click();
 await expect(properties).toBeHidden();
 await expect(page.getByRole('button',{name:'Show properties',exact:true})).toHaveAttribute('aria-pressed','false');
 await page.getByRole('button',{name:'Show properties',exact:true}).click();
 await expect(properties).toBeVisible();
 await expect(page.getByRole('button',{name:'Show properties',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(overview.locator('section').filter({has:page.getByRole('heading',{name:'Latest file',exact:true})})).toContainText('Verified responses.docx');
 await expect(overview.getByRole('navigation',{name:'Matter workspace'}).getByRole('link',{name:'Files & submissions',exact:true})).toHaveAttribute('href',`paralegal-v2.html#/matter/${selected.caseId}?tab=files`);
 await openView(page,'deadlines');await expect(page.locator('.ld-months span')).toHaveCount(6);const months=await page.locator('.ld-months').innerText();await page.getByRole('button',{name:'Next three months',exact:true}).click();await expect(page.locator('.ld-months')).not.toHaveText(months);await page.getByRole('button',{name:'Today',exact:true}).click();expect(await page.locator('.ld-months').innerText()).toBe(months);
});

test('large viewport and forced colors preserve the full-window workspace',async({page},info)=>{
 const state=await fixture(page,rich());await page.setViewportSize({width:1920,height:1080});await home(page,'?view=work');const frame=await page.locator('.v2-app-frame').boundingBox();expect(frame.x).toBe(230);expect(frame.y).toBe(0);expect(frame.width).toBe(1690);expect(frame.height).toBe(1080);await shot(page,info,'large-work');
 await page.emulateMedia({reducedMotion:'reduce',forcedColors:'active'});await expect(page.locator('.ld-row').first()).toBeVisible();await page.emulateMedia({forcedColors:'none'});
 await page.locator('.v2-desktop-more summary').click();
 await expect(page.locator('.v2-desktop-more-menu').getByRole('link',{name:'Browse matters',exact:true})).toBeVisible();
 await expect(page.locator('.v2-desktop-more-menu').getByRole('link',{name:'My Matters & Applications',exact:true})).toBeVisible();
 await page.locator('.v2-desktop-more summary').click();
 await page.getByRole('navigation',{name:'Account and help',exact:true}).getByRole('link',{name:'Help',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route','help');await openView(page,'work');await expectSameDocument(page,state);
});

test('keyboard tabs retain focus and larger text remains readable',async({page},info)=>{
 await fixture(page,rich());await home(page,'?view=work');const assigned=page.getByRole('tab',{name:/^Assigned/});await assigned.focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');await expect(page.getByRole('tab',{name:/^Invitations/})).toBeFocused();await page.keyboard.press('ArrowRight');await page.keyboard.press('Enter');await expect(page.getByRole('tab',{name:/^Applications/})).toBeFocused();
 await page.getByRole('button',{name:'Filter records',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('searchbox',{name:'Filter records'})).toBeFocused();
 await assigned.click();await page.evaluate(()=>{document.documentElement.style.fontSize='20px';});expect(await page.locator('.ld-row').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(14);await expect(page.locator('.ld-row').first()).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(page,info,'larger-text');
});
