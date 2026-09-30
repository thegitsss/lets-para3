const { eventPage } = require("./event-page-fixture");
const { receivedInvitations } = require("./received-invitation-fixture");
const { installNotificationReads } = require("./notification-fixtures");
const financial = require("./financial-fixtures");
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

async function home(page, query = "") {
  await page.goto(`/paralegal-v2.html${query === "__default" ? "" : "#/home"+query}`, { waitUntil: "domcontentloaded" });
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
const shot=async(page,name)=>{await page.mouse.move(0,0);await page.screenshot({path:test.info().outputPath(name+'.png')});};

test('default entry, counts, authority and selected scope retain the work list',async({page})=>{
 const state=await contractFixture(page);await page.setViewportSize({width:1440,height:1000});await home(page,'__default');expect(state.protectedReads.some(read=>/^\/api\/cases\//.test(read.path))).toBe(false);await expect(page).toHaveURL(/#\/home\?view=work$/);await expect(tab(page,'Assigned')).toHaveAttribute('aria-selected','true');await expect(tab(page,'Invitations')).toContainText('1');await expect(page.locator('.lc-group')).toHaveCount(2);await expect(page.locator('.lc-group').first()).toContainText('Needs your action');await expect(page.locator('.lc-workspace')).not.toContainText('LPC-');
 const geometry=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {width:r.width,height:r.height}};return {sidebar:box('.v2-sidebar'),header:box('.lc-heading'),toolbar:box('.lc-toolbar'),nav:box('.v2-desktop-primary .v2-nav-link')}});expect(geometry.sidebar.width).toBe(230);expect(geometry.header.height).toBeCloseTo(84,1);expect(geometry.toolbar.height).toBe(52);expect(geometry.nav.height).toBeGreaterThanOrEqual(36);
 await shot(page,'1440-my-work');await page.locator('[data-home-matter-id]').first().click();await expect(page.locator('.lc-context')).toContainText('Prepare a verified chronology');await expect(page.locator('.lc-list')).toBeVisible();expect((await page.locator('.lc-context').boundingBox()).width).toBe(480);await expect(page.locator('[data-home-detail-title]')).toHaveText(LONG);await shot(page,'1440-my-work-context');await page.getByRole('button',{name:'Close details',exact:true}).click();await expect(page.locator('.lc-context')).toHaveCount(0);await expect(page.locator('[data-home-matter-id]').first()).toBeFocused();
});

test('invitation decision and application withdrawal use existing handlers and reconcile counts',async({page})=>{
 const state=await contractFixture(page);await page.setViewportSize({width:1440,height:1000});await page.route(`**/api/cases/${INVITE}/invite/accept`,route=>{state.invites.items=[];state.applications.push({_id:'64b000000000000000060001',caseId:INVITE,paralegalId:USER,status:'submitted',applicationSource:'invite_accept',jobId:{_id:'64b000000000000000060002',title:'Probate inventory support',status:'open'}});return json(route,{success:true});});
 await page.route(`**/api/applications/${APPLICATION}/revoke`,route=>{state.applications=state.applications.filter(a=>a._id!==APPLICATION);return json(route,{success:true});});
 await home(page);await tab(page,'Invitations').click();await page.locator('[data-home-invitation-id]').click();await expect(page.locator('.lc-context')).toContainText('Prepare a verified asset inventory');await shot(page,'invitation-decision');await page.getByRole('button',{name:'Accept invitation',exact:true}).click();await expect(tab(page,'Invitations')).toContainText('0');await expect(tab(page,'Invitations')).toHaveAttribute('aria-selected','true');await expect(tab(page,'Assigned')).toContainText('2');
 await tab(page,'Applications').click();await page.locator(`[data-home-application-id="${APPLICATION}"]`).click();await page.getByRole('button',{name:'Withdraw application',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await shot(page,'application-withdraw-confirmation');await page.getByRole('dialog').getByRole('button',{name:'Withdraw application',exact:true}).click();await expect(tab(page,'Applications')).toContainText('1');expect(state.mutations.filter(p=>p.endsWith('/invite/accept'))).toHaveLength(1);expect(state.mutations.filter(p=>p.endsWith('/revoke'))).toHaveLength(1);
});

test('Inbox and Updates open real event-specific scope and file context; Reviews separates responsibility',async({page})=>{
 const state=await contractFixture(page);await page.setViewportSize({width:1440,height:1000});await home(page);await view(page,'inbox');await expect(page.locator('.lc-context')).toContainText('Select an update');expect((await page.locator('.lc-event-body .lc-list').boundingBox()).width).toBe(352);await page.locator('.lc-event').first().click();await expect(page.locator('.lc-context')).toContainText('Prepare a verified chronology');await shot(page,'1440-inbox-context');await page.locator('.lc-event').nth(1).click();await expect(page.locator('.lc-context')).toContainText('Discovery response.docx');await expect(page.getByRole('button',{name:'Download file',exact:true})).toBeVisible();await expect(page.locator('.lc-context a').last()).toHaveAttribute('href',new RegExp('fileId='+FILE));
 await view(page,'reviews');await expect(tab(page,'Needs your action')).toContainText('1');await expect(tab(page,'Awaiting attorney')).toContainText('1');await page.locator('.lc-event').click();await expect(page.locator('.lc-context')).toContainText('Correct citations on pages 3–5');await expect(page.getByRole('link',{name:'Upload revision'})).toHaveAttribute('href',new RegExp('fileId='+FILE));await shot(page,'1440-revision-request');await tab(page,'Awaiting attorney').click();await expect(page.locator('.lc-list')).toContainText('Affidavit chronology');await view(page,'pulse');await expect(page.locator('.lc-list')).toContainText('2026-09-08');await expect(page.locator('.lc-list')).not.toContainText('Attorney updated the scope');await shot(page,'1440-updates');
});

test('responsive layout, long text, zoom and palette remain usable',async({page})=>{
 await contractFixture(page);await home(page);expect(await page.locator('.lc-record-title').first().evaluate(el=>getComputedStyle(el).fontSize)).toBe('15.9375px');expect(await page.locator('.lc-heading h1').evaluate(el=>getComputedStyle(el).fontSize)).toBe('38.25px');for(const width of [1920,768,375]){await page.setViewportSize({width,height:1000});await shot(page,width+'-my-work');await page.locator('[data-home-matter-id]').first().click();await expect(page.locator('[data-home-detail-title]')).toHaveText(LONG);await expect(page.locator('.lc-context')).toContainText('Prepare a verified chronology');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if(width<=768){for(const control of await page.locator('.lc-context :is(button,a), [data-v2-mobile-menu], .v2-global-tools .v2-tool-button, .v2-global-tools .v2-profile-trigger').all())expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);}await shot(page,width+'-context');await page.getByRole('button',{name:width<=1100?'Back to list':'Close details',exact:true}).click();}
 await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.style.fontSize='34px');await expect(page.locator('[data-home-matter-id]').first()).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.locator('.lc-record-title').first().evaluate(el=>parseFloat(getComputedStyle(el).lineHeight)>=parseFloat(getComputedStyle(el).fontSize))).toBe(true);await shot(page,'200-percent-text');await page.evaluate(()=>document.documentElement.style.fontSize='17px');const styles=await page.locator('.lc-workspace').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,font:getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/["']/g,''),loaded:document.fonts.check('14px Sarabun')&&[...document.fonts].some(face=>face.family.replace(/["']/g,'')==='Sarabun'&&face.status==='loaded')}));expect(styles).toEqual({background:'rgb(255, 255, 255)',color:'rgb(26, 31, 54)',font:'Sarabun',loaded:true});
 const result=await new AxeBuilder({page}).include('.lc-workspace').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
});

test('refresh preserves chosen subview and list position; failed and revoked data stay explicit',async({page})=>{
 const state=await contractFixture(page);await home(page);await tab(page,'Applications').click();state.invites.items.push({...state.invites.items[0],_id:'64b000000000000000010099',caseId:'64b000000000000000010099'});await page.mouse.move(0,0);await page.evaluate(()=>{document.activeElement.blur();window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh',{detail:{sourceId:'contract-test'}}));});await expect(tab(page,'Applications')).toHaveAttribute('aria-selected','true');
 state.failures.notifications=503;await view(page,'inbox');await page.reload();await expect(page.locator('[data-home-loading]')).toHaveAttribute('data-home-loading','false');await expect(page.locator('.lc-source')).toContainText('could not be loaded');await expect(page.locator('.lc-list')).not.toContainText('caught up');await shot(page,'notifications-unavailable');
 delete state.failures.notifications;state.failures.files=403;await page.goto('/paralegal-v2.html#/home?view=work');await expect(page.locator('[data-home-loading]')).toHaveAttribute('data-home-loading','false');await expect(page.locator('[data-home-matter-id]')).toHaveCount(0);await expect(page.locator('.lc-source')).toContainText('no longer available');await view(page,'reviews');await expect(page.locator('.lc-source')).toContainText('no longer available');await expect(tab(page,'Needs your action')).toContainText('0+');await expect(page.locator('.lc-list')).not.toContainText('No submissions');await shot(page,'submission-access-unavailable');
});

test('deep links and contextual return preserve selection and long-list scroll',async({page})=>{
 const state=await contractFixture(page);state.dashboard.activeCases.push(...Array.from({length:45},(_,i)=>active({caseId:(BigInt('0x'+SECOND)+BigInt(i+1)).toString(16),jobTitle:'Long-list matter '+i})));await home(page,'?view=work');await page.setViewportSize({width:1440,height:800});const list=page.locator('.lc-list');await list.evaluate(el=>el.scrollTop=500);const row=page.locator('[data-home-matter-id]').nth(15);await row.click();const before=await list.evaluate(el=>el.scrollTop);await page.getByRole('button',{name:'Close details',exact:true}).click();expect(await list.evaluate(el=>el.scrollTop)).toBe(before);
 await page.setViewportSize({width:375,height:800});await list.evaluate(el=>el.scrollTop=500);await row.scrollIntoViewIfNeeded();const mobileBefore=await list.evaluate(el=>el.scrollTop);await row.click();await page.getByRole('button',{name:'Back to list',exact:true}).click();expect(await list.evaluate(el=>el.scrollTop)).toBe(mobileBefore);
 await page.goto('/paralegal-v2.html#/home?view=work&item=application%3A'+APPLICATION);await expect(page.locator('.lc-context')).toContainText('Employment records review');await expect(tab(page,'Applications')).toHaveAttribute('aria-selected','true');
});

test('temporary failures retain actions and do not claim confirmed success',async({page})=>{
 const state=await contractFixture(page);let calls=0;await page.route(`**/api/cases/${INVITE}/invite/accept`,route=>{calls++;return json(route,{error:'Invitation changed. Refresh before responding.'},409);});await home(page,'?view=invitations');await page.locator('[data-home-invitation-id]').click();await page.getByRole('button',{name:'Accept invitation',exact:true}).click();await expect(page.getByRole('button',{name:'Accept invitation',exact:true})).toBeEnabled();await expect(tab(page,'Invitations')).toContainText('1');expect(calls).toBe(1);
 await view(page,'inbox');await page.locator('.lc-event').nth(1).click();await page.route(`**/api/uploads/case/${FIRST}/${FILE}/download`,route=>json(route,{error:'This file was deleted.'},404));await page.getByRole('button',{name:'Download file',exact:true}).click();await expect(page.locator('.lc-context')).toContainText('This file was deleted.');await expect(page.getByRole('button',{name:'Download file',exact:true})).toBeEnabled();
});

test('message event preserves its exact conversation destination without a second composer',async({page})=>{
 const state=await contractFixture(page);const messageId='64b000000000000000090001';state.notifications=[{id:'64b000000000000000070099',type:'message',message:'Jordan sent a message',context:{caseId:FIRST,messageId},action:{label:'Read message',href:`/case-detail.html?caseId=${FIRST}&tab=messages&messageId=${messageId}`},createdAt:'2026-09-08T13:00:00Z',available:true,isRead:false}];await home(page,'?view=inbox');await page.locator('.lc-event').click();await expect(page).toHaveURL(new RegExp(`/matter/${FIRST}\\?tab=messages&messageId=${messageId}`));await expect(page.locator('.lc-workspace textarea')).toHaveCount(0);
});

test('account access loss removes the list, scope, and retained selection',async({page})=>{
 const state=await contractFixture(page);await home(page);await page.locator('[data-home-matter-id]').first().click();await expect(page.locator('.lc-context')).toContainText('Prepare a verified chronology');state.profile.status='suspended';await page.mouse.move(0,0);await page.evaluate(()=>{document.activeElement.blur();window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh',{detail:{sourceId:'contract-access',accessMayChange:true}}));});await expect(page.locator('[data-home-detail-title]')).toHaveCount(0);await expect(page.locator('[data-home-matter-id]')).toHaveCount(0);
});

test('inline application requests preserve drafts and visible obligations during refresh',async({page})=>{
 const state=await contractFixture(page);
 state.applications[0].statusHistory=[{to:'submitted',at:'2026-09-06T14:00:00Z'},{from:'submitted',to:'shortlisted',at:'2026-09-07T14:00:00Z'}];
 state.applications[0].preEngagement={status:'requested',requestedParalegalId:USER,confidentialityAgreementRequired:true,conflictsCheckRequired:true,conflictsDetails:'Check the listed parties.',requestedAt:'2026-09-07T12:00:00Z'};
 await home(page);await expect(tab(page,'Applications')).toContainText('1 need action');await expect(page.locator('[data-desktop-home-view="work"] [data-workspace-count]')).toContainText('2');await tab(page,'Applications').click();await page.locator('[data-home-application-id]').click();
 await expect(page.locator('.lc-context')).toContainText('Recorded activity');await expect(page.locator('.lc-context ol')).toContainText('Shortlisted');await page.getByText('Disclose a possible conflict',{exact:true}).click();await page.getByLabel('Possible conflict details').fill('Retain this draft while another record changes.');await page.getByLabel('Upload signed confidentiality agreement').setInputFiles({name:'signed-test.pdf',mimeType:'application/pdf',buffer:Buffer.from('synthetic draft')});
 await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh',{detail:{sourceId:'contract-draft'}})));await expect(page.getByLabel('Possible conflict details')).toHaveValue('Retain this draft while another record changes.');await page.getByRole('button',{name:'Close details',exact:true}).click();await page.locator('[data-home-application-id]').click();await expect(page.getByLabel('Possible conflict details')).toHaveValue('Retain this draft while another record changes.');await expect(page.getByText('Selected: signed-test.pdf',{exact:true})).toBeVisible();await shot(page,'application-request-draft');
 let submissions=0;await page.route(`**/api/cases/${APPLICATION}/pre-engagement/respond`,route=>{submissions++;expect(route.request().postData()).toContain('confidentialityAcknowledged');state.applications[0].preEngagement={...state.applications[0].preEngagement,status:'submitted',revision:1,confidentialityAcknowledged:true,conflictsResponseType:'disclosure',conflictsDisclosureText:'Retain this draft while another record changes.'};return json(route,{success:true,preEngagement:state.applications[0].preEngagement});});await page.getByText('I reviewed and acknowledge this confidentiality agreement.',{exact:true}).click();await page.getByRole('button',{name:'Submit to attorney',exact:true}).click();await expect(tab(page,'Applications')).not.toContainText('need action');await expect(page.getByRole('button',{name:'Submit to attorney',exact:true})).toHaveCount(0);expect(submissions).toBe(1);
});

for (const outcome of ['confirmed', 'lost', 'changed']) test(`inline in-flight requirements ${outcome} stay single-flight after closing and reopening`, async ({ page }, info) => {
 const state=await contractFixture(page); let writes=0, release; const held=new Promise(resolve=>{release=resolve;});
 await page.route(url => url.pathname === '/api/cases/my-completed', route => json(route, financial.history(USER, [], new URL(route.request().url()).searchParams)));
 await page.route('**/api/account/dashboard-views?scope=paralegal_applications', route => json(route, { scope: 'paralegal_applications', views: [] }));
 state.applications[0].preEngagement={revision:7,status:'requested',requestedParalegalId:USER,confidentialityAgreementRequired:true,conflictsCheckRequired:true,conflictsDetails:'Check the listed parties.'};
 await page.route(`**/api/cases/${APPLICATION}/pre-engagement/respond`,async route=>{
  writes++;await held;state.applications[0].preEngagement={...state.applications[0].preEngagement,status:outcome==='changed'?'requested':'submitted',revision:8,conflictsDetails:'Review the updated parties.',confidentialityAcknowledged:true,conflictsResponseType:'none_known'};
  if(outcome==='lost')return json(route,{error:'Submission could not be confirmed.'},503);
  if(outcome==='changed')return json(route,{code:'PRE_ENGAGEMENT_CONFLICT',error:'The requirements changed.'},409);
  return json(route,{success:true,preEngagement:state.applications[0].preEngagement});
 });
 await home(page);await tab(page,'Applications').click();await page.locator('[data-home-application-id]').click();
 await page.getByLabel('I reviewed and acknowledge this confidentiality agreement.',{exact:true}).check();await page.getByLabel('No known conflict',{exact:true}).check();
 try {
  await page.getByRole('button',{name:'Submit to attorney',exact:true}).click();await expect.poll(()=>writes).toBe(1);
  await page.getByRole('button',{name:'Close details',exact:true}).click();await page.locator('[data-home-application-id]').click();
  await expect(page.getByRole('button',{name:/^(Submit to attorney|Submitting…)$/})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Withdraw application',exact:true})).toBeDisabled();
  await expect(page.getByLabel('No known conflict',{exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Review saved requirements',exact:true})).toBeHidden();
    if (outcome === 'confirmed') for (const [width, dark, size] of [[1366, false, '100%'], [320, true, '100%'], [390, true, '200%']]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(({dark,size}) => { document.documentElement.classList.toggle('theme-dark', dark); document.documentElement.style.fontSize = size; }, {dark,size});
      const root = page.locator('.lc-context');
      const content = root.locator('.lc-context-content');
      await content.focus(); await expect(content).toBeFocused();
      if (await content.evaluate(node => node.scrollHeight > node.clientHeight + 1)) {
        await content.press('Home'); await content.press('PageDown');
        await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      }
      await root.getByRole('button', { name: 'Submitting…', exact: true }).scrollIntoViewIfNeeded();
      expect(await root.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect((await new AxeBuilder({ page }).include('.lc-context').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
      await page.screenshot({ path: info.outputPath(`requirements-inline-sending-${width}-${size}.png`) });
    }
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.evaluate(() => { document.documentElement.classList.remove('theme-dark'); document.documentElement.style.fontSize = '100%'; });
  release();
  if(outcome!=='confirmed')await page.getByRole('button',{name:'Review saved requirements',exact:true}).click();
  if(outcome==='changed'){await expect(page.locator('.lc-context')).toContainText('updated parties');await expect(page.getByLabel('I reviewed and acknowledge this confidentiality agreement.',{exact:true})).not.toBeChecked();}
  else await expect(page.getByRole('button',{name:/^(Submit to attorney|Submitting…)$/})).toHaveCount(0);
  expect(writes).toBe(1);
 } finally {release();}
});

test('inline late requirements response preserves the newly selected private application draft', async ({ page }) => {
 const state=await contractFixture(page), selected=state.applications[0];let release,finished,writes=0;
 const held=new Promise(resolve=>{release=resolve;}),settled=new Promise(resolve=>{finished=resolve;});
 selected.preEngagement={revision:7,status:'requested',requestedParalegalId:USER,conflictsCheckRequired:true,conflictsDetails:'Selected parties.'};
 const otherId='64b000000000000000010099';state.applications.push({...selected,_id:otherId,caseId:otherId,jobId:{...selected.jobId,_id:'64b000000000000000020099',caseId:otherId,title:'Another private application'},preEngagement:{...selected.preEngagement,revision:9,conflictsDetails:'Other parties.'}});
 await page.route(`**/api/cases/${APPLICATION}/pre-engagement/respond`,async route=>{writes++;await held;selected.preEngagement={...selected.preEngagement,status:'submitted',revision:8,conflictsResponseType:'none_known'};await json(route,{success:true,preEngagement:selected.preEngagement});finished();});
 await home(page);await tab(page,'Applications').click();await page.locator(`[data-home-application-id="${APPLICATION}"]`).click();await page.getByLabel('No known conflict',{exact:true}).check();
 try {
  await page.getByRole('button',{name:'Submit to attorney',exact:true}).click();await expect.poll(()=>writes).toBe(1);
  await page.getByRole('button',{name:'Close details',exact:true}).click();await page.locator(`[data-home-application-id="${otherId}"]`).click();
  await page.getByLabel('Disclose a possible conflict',{exact:true}).check();const field=page.getByLabel('Possible conflict details');await field.fill('Retain the newly selected private draft.');await field.focus();
  release();await settled;await expect(page.locator('.lc-context')).toContainText('Another private application');await expect(field).toHaveValue('Retain the newly selected private draft.');await expect(field).toBeFocused();await expect(page.locator('[data-v2-toast-region]')).not.toContainText('Information sent');expect(writes).toBe(1);
 } finally {release();}
});

test('inline changed requirements recover through a verified saved review without carrying an old acknowledgement', async ({ page }) => {
 const state = await contractFixture(page); let writes = 0;
 await page.route(url => url.pathname === '/api/cases/my-completed', route => json(route, financial.history(USER, [], new URL(route.request().url()).searchParams)));
 await page.route('**/api/account/dashboard-views?scope=paralegal_applications', route => json(route, { scope: 'paralegal_applications', views: [] }));
 state.applications[0].preEngagement = { revision: 7, status: 'requested', requestedParalegalId: USER, confidentialityAgreementRequired: true, conflictsCheckRequired: true, conflictsDetails: 'The original parties.', requestedAt: '2026-09-07T12:00:00Z' };
 await home(page); await tab(page, 'Applications').click(); await page.locator('[data-home-application-id]').click();
 await page.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true }).check();
 await page.getByLabel('No known conflict', { exact: true }).check();
 await page.route(`**/api/cases/${APPLICATION}/pre-engagement/respond`, route => {
  writes++; expect(route.request().postData()).toMatch(/name="expectedPreEngagementRevision"\r?\n\r?\n7/);
  state.applications[0].preEngagement = { ...state.applications[0].preEngagement, revision: 8, conflictsDetails: 'Review the newly added party.' };
  return json(route, { code: 'PRE_ENGAGEMENT_CONFLICT', error: 'The requirements changed since you opened them.' }, 409);
 });
 await page.getByRole('button', { name: 'Submit to attorney', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Submit to attorney', exact: true })).toBeDisabled();
 expect((await page.getByRole('button', { name: 'Review saved requirements', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(44);
 await page.getByRole('button', { name: 'Review saved requirements', exact: true }).click();
 await expect(page.locator('.lc-context')).toContainText('newly added party');
 await expect(page.getByLabel('I reviewed and acknowledge this confidentiality agreement.', { exact: true })).not.toBeChecked();
 await expect(page.getByLabel('No known conflict', { exact: true })).not.toBeChecked();
 expect(writes).toBe(1);
});

test('confirmed file changes reconcile review responsibility, history and selected view',async({page})=>{
 const state=await contractFixture(page);await home(page,'?view=reviews');await expect(tab(page,'Needs your action')).toContainText('1');
 const original=state.files[FIRST][0];original.revisionResolution={approvedAt:'2026-09-08T15:00:00Z',fileId:'64b000000000000000050010'};state.files[FIRST].push({id:'64b000000000000000050010',caseId:FIRST,originalName:'Corrected discovery response.pdf',mimeType:'application/pdf',uploadedByRole:'paralegal',status:'approved',securityStatus:'clean',approvedAt:'2026-09-08T15:00:00Z',revisionOfFileId:FILE,revisionRequestAt:original.revisionRequestedAt});
 await page.mouse.move(0,0);await page.evaluate(()=>{document.activeElement.blur();const channel=new BroadcastChannel('lpc-v2-files');channel.postMessage({matterId:'64b000000000000000010001'});channel.close();});await expect(tab(page,'Needs your action')).toHaveText('Needs your action0');await expect(tab(page,'Needs your action')).toHaveAttribute('aria-selected','true');await expect(page.locator('[data-desktop-home-view="reviews"] [data-workspace-count]')).toHaveCount(0);await tab(page,'History').click();await expect(page.locator('.lc-event')).toHaveCount(2);await page.locator('.lc-event').filter({hasText:'Corrected discovery response.pdf'}).click();await expect(page.getByRole('link',{name:'Open file preview'})).toHaveAttribute('href',new RegExp('050010/download\\?preview=true'));await shot(page,'review-resolved-history');
 await view(page,'work');await expect(page.locator('.lc-list')).not.toContainText('Needs your action');await expect(page.locator('.lc-list')).toContainText('Active work');
});


test('recommended listing context retains its identity and original apply destination',async({page})=>{
 const state=await contractFixture(page);state.dashboard.activeCases=[];state.invites.items=[];state.applications=[];await home(page,'__default');await expect(tab(page,'Recommended')).toHaveAttribute('aria-selected','true');await page.locator('[data-home-recommendation-id]').click();await expect(page.locator('.lc-context-heading')).toContainText('Listing');await expect(page.getByRole('link',{name:'Review listing and apply'})).toHaveAttribute('href',new RegExp('/browse.*'+RECOMMENDATION));expect(state.protectedReads).toEqual([]);
});
