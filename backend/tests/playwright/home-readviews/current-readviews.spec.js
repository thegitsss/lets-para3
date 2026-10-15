const { test, expect } = require("../posting-refresh-actual-fixture.cjs");
const AxeBuilder = require("@axe-core/playwright").default;
const { inventoryFixture } = require('../attorney-v2/inventory-fixture');
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
  data.profile = { ...user, ...data.profile };
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


const tour=page=>page.locator('.av2-workspace-guide');
async function home(page){await page.goto(`${entry}#/home`);for(const key of ['overview','attention','applications','messages','onboarding'])await loaded(page,key);}
async function awayAndBack(page){await page.getByRole('navigation',{name:'Help',exact:true}).getByRole('link',{name:'Help',exact:true}).click();await expect(page.getByRole('heading',{name:'Help for Attorneys',exact:true})).toBeVisible();await page.goBack();}
function watchWrites(page){const writes=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')&&!['GET','HEAD'].includes(r.method()))writes.push({method:r.method(),path:new URL(r.url()).pathname,body:r.postDataJSON()});});return writes;}
async function financial(page,{invalid=false}={}){
 const user=(await(await page.request.get('/api/auth/me')).json()).user,ownerId=user.id||user._id,state={invalid,reads:[]};
 await page.route('**/api/payments/attorney-financial-history?**',route=>{
  const q=new URL(route.request().url()).searchParams;state.reads.push(Object.fromEntries(q));
  return json(route,{ownerId,revision:'a'.repeat(64),view:q.get('view')||'all',q:q.get('q')||'',caseId:q.get('caseId'),total:1,nextCursor:null,entries:[{id:'1'.padStart(64,'0'),caseId:objectId(1),caseTitle:'Synthetic Matter 01',type:'funding',state:'recorded',amount:state.invalid?99999:10005,currency:'USD',recordedAt:'2026-09-04T12:00:00Z',basis:'original_payment',receiptId:'payment',paralegalName:null}],summary:{currencies:[{currency:'USD',originalFunding:10005,paralegalPayouts:0,refunds:0,fundingRecords:1,payoutRecords:0,refundRecords:0,fundingUnverified:0,payoutsUnverified:0,refundsUnverified:0}],requiresReview:0,pending:0,undated:0}});
 });return state;
}

test("first-login tour resumes four targets and persists only explicit confirmed completion",async({page},info)=>{
 const data=await mock(page);data.profile.onboarding={attorneyTourCompleted:false};
 const session=(await(await page.request.get('/api/auth/me')).json());session.user.isFirstLogin=true;
 await page.route('**/api/auth/me',route=>json(route,session));
 const actualCsrf=(await(await page.request.get('/api/csrf')).json()).csrfToken,patches=[];
 await page.route('**/api/csrf',route=>json(route,{csrfToken:actualCsrf}));
 await page.route('**/api/users/me/onboarding',async route=>{
  patches.push({method:route.request().method(),headers:route.request().headers(),body:route.request().postDataJSON()});
  await route.continue();
 });
 await home(page);await expect(tour(page)).toBeVisible();await expect(tour(page)).toContainText('Tour · 1 of 4');
 expect((await region(page,'onboarding').boundingBox()).y).toBeLessThan(600);
 await expect(page.locator('.av2-home-primary > :first-child')).toHaveAttribute('data-av2-region','onboarding');await tour(page).locator('summary').focus();await page.keyboard.press('Tab');await expect(tour(page).getByRole('link',{name:'Open profile',exact:true})).toBeFocused();
 for(const [width,scale] of [[1440,1],[390,2]]){await page.setViewportSize({width,height:900});await page.evaluate(scale=>document.documentElement.style.fontSize=`${16*scale}px`,scale);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth+1)).toBe(true);expect((await new AxeBuilder({page}).include('.av2-workspace-guide').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);await page.screenshot({path:info.outputPath(`active-guide-${width}-${scale}.png`),fullPage:true});}
 await page.evaluate(()=>document.documentElement.style.fontSize='16px');await page.setViewportSize({width:1280,height:720});
 expect(patches).toEqual([]);
 for(let i=0;i<3;i++)await tour(page).getByRole('button',{name:'Next',exact:true}).click();
 await expect(tour(page).getByRole('link',{name:'Browse paralegals',exact:true})).toHaveAttribute('href','#/paralegals');
 const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/users/me/onboarding'&&r.request().method()==='PATCH');
 await tour(page).getByRole('button',{name:'Finish tour',exact:true}).click();expect((await saved).status()).toBe(200);
 await expect(tour(page)).toHaveCount(0);await expect(page.getByRole('heading',{name:'Today',exact:true})).toBeFocused();
 expect(patches).toHaveLength(1);expect(patches[0].method).toBe('PATCH');expect(patches[0].body).toEqual({attorneyTourCompleted:true});expect(patches[0].headers['x-csrf-token']).toBe(actualCsrf);
 expect(await page.evaluate(()=>sessionStorage.getItem('lpc_attorney_tour_completed'))).toBe('1');
 data.profile.onboarding.attorneyTourCompleted=true;session.user.isFirstLogin=false;await page.reload();await loaded(page,'onboarding');await expect(tour(page)).toHaveCount(0);await expect(page.locator('.av2-home-primary > :first-child')).toHaveClass('av2-home-review');
 await page.goto(`${entry}?replayTour=1#/home`);await loaded(page,'onboarding');await expect(tour(page)).toContainText('Tour · 1 of 4');await expect(page).not.toHaveURL(/replayTour/);
 const ownerId=session.user.id||session.user._id;expect(JSON.parse(await page.evaluate(key=>sessionStorage.getItem(key),`lpc_attorney_v2_onboarding:${ownerId}`)).tour).toBe(0);expect(patches).toHaveLength(1);
 await require('node:fs/promises').writeFile(info.outputPath('onboarding-patch-receipt.json'),JSON.stringify({patches:patches.map(p=>({method:p.method,body:p.body,csrfMatched:p.headers['x-csrf-token']===actualCsrf})),actualProtectedHandler:true,firstLoginIdentityProjection:true,priorCoreFourTargetReload503CreditRetained:true},null,2));
});

test("matter pagination, filters, saved-view reads, drafts, archive preview and history retain context",async({page})=>{
 await mock(page);const writes=watchWrites(page);await page.goto(`${entry}#/matters`);await loaded(page,'matter-list');
 await expect(page.locator('[data-av2-matter]')).toHaveCount(15);await page.getByRole('link',{name:'Next page',exact:true}).click();await loaded(page,'matter-list');await expect(page).toHaveURL(/page=2/);await expect(page.locator('[data-av2-matter]')).toHaveCount(3);
 await page.reload();await loaded(page,'matter-list');await expect(page.locator('[data-av2-matter]')).toHaveCount(3);
 await page.getByRole('combobox',{name:'Saved views',exact:true}).selectOption('saved:saved-deadlines');await loaded(page,'matter-list');await expect(page.locator('[data-av2-matter]')).toHaveCount(1);await expect(page.getByRole('searchbox',{name:'Search matters',exact:true})).toHaveValue('Synthetic Matter 01');
 await page.goBack();await loaded(page,'matter-list');await expect(page.locator('[data-av2-matter]')).toHaveCount(3);
 await page.goto(`${entry}#/matters?view=draft`);await loaded(page,'matter-list');await expect(page.getByRole('link',{name:'Draft Matter',exact:true})).toHaveAttribute('href',`#/matters/new?draftId=${objectId(50)}&step=description&returnTo=${encodeURIComponent('#/matters?view=draft')}`);
 await page.goto(`${entry}#/matters?view=archived&highlightCase=${objectId(40)}&previewCaseId=${objectId(40)}`);await loaded(page,'matter-list');
 const row=page.locator(`[data-av2-matter="${objectId(40)}"]`);await expect(row.locator('.av2-matter-inline-preview')).toHaveAttribute('open','');await expect(row.locator('.av2-matter-menu')).not.toHaveAttribute('open','');await expect(row).toContainText('Synthetic read-only matter description.');
 await page.getByRole('button',{name:/^Filters(?: · \d+ active)?$/}).click();await page.getByRole('combobox',{name:'Archive status',exact:true}).selectOption('paused');await loaded(page,'matter-list');await expect(page.locator('[data-av2-matter]')).toHaveCount(1);await expect(page.locator('[data-av2-matter]')).toContainText('Paused Matter');expect(writes).toEqual([]);
});

test("onboarding skip, replay, navigation and refreshed completion preserve progress",async({page})=>{
 const data=await mock(page);data.profile={lawFirm:'',practiceDescription:'',bio:'',practiceAreas:[],linkedInURL:'',firmWebsite:'',publications:[],onboarding:{attorneyTourCompleted:false,attorneyProfileCompleted:false}};data.payment={paymentMethod:null};data.active=[];data.archived=[];
 data.home={...data.home,counts:{active:0,applications:0,draft:1,archived:0},postedCount:0,attention:{...data.home.attention,total:0,items:[]},week:{...data.home.week,total:0,items:[]}};
 const writes=watchWrites(page);await home(page);await tour(page).locator('summary').click();await tour(page).getByRole('button',{name:'Start workspace guide',exact:true}).click();await tour(page).getByRole('button',{name:'Next',exact:true}).click();await expect(tour(page)).toContainText('Tour · 2 of 4');
 await page.evaluate(()=>sessionStorage.setItem('lpc_attorney_onboarding_step','payment'));await tour(page).getByRole('button',{name:'Close',exact:true}).click();
 expect(await page.evaluate(()=>sessionStorage.getItem('lpc_attorney_onboarding_step'))).toBeNull();expect(await page.evaluate(()=>sessionStorage.getItem('lpc_attorney_onboarding_dismissed'))).toBe('1');
 await page.reload();await loaded(page,'onboarding');await expect(tour(page)).toHaveCount(0);
 await page.getByRole('navigation',{name:'Help',exact:true}).getByRole('link',{name:'Help',exact:true}).click();await page.getByRole('link',{name:'Replay workspace guide',exact:true}).click();await loaded(page,'onboarding');await expect(tour(page)).toContainText('Tour · 1 of 4');await expect(tour(page).getByRole('link',{name:'Open profile',exact:true})).toHaveAttribute('href','#/settings');await expect(page).not.toHaveURL(/replayTour/);
 await page.locator('.av2-brand-menu > summary').click();await expect(page.locator('[data-av2-finish-setup]')).toHaveAttribute('href','attorney-v2.html#/settings');await expect(page.locator('[data-av2-finish-setup]')).toBeVisible();await page.locator('.av2-brand-menu > summary').click();
 data.profile={lawFirm:'Firm',onboarding:{attorneyTourCompleted:false}};await page.locator('.av2-brand-menu > summary').click();await expect(page.locator('[data-av2-finish-setup]')).toHaveAttribute('href','attorney-v2.html#/payments/setup');await expect(page.locator('[data-av2-finish-setup]')).toBeVisible();await page.locator('.av2-brand-menu > summary').click();
 await tour(page).getByRole('button',{name:'Close',exact:true}).click();await expect(tour(page)).toHaveCount(0);data.profile.onboarding.attorneyTourCompleted=true;data.payment={paymentMethod:{id:'pm_test'}};data.active=[matter(1)];data.home.counts.active=1;data.home.postedCount=1;
 await page.getByRole('navigation',{name:'Help',exact:true}).getByRole('link',{name:'Help',exact:true}).click();await page.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Home',exact:true}).click();await loaded(page,'onboarding');await expect(tour(page)).toHaveCount(0);
 await page.locator('.av2-brand-menu > summary').click();await expect(page.locator('[data-av2-finish-setup]')).toBeHidden();await page.locator('.av2-brand-menu > summary').click();
 await page.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Matters',exact:true}).click();await loaded(page,'matter-list');expect(writes).toEqual([]);
});

test("populated Home uses exact cents, counts, readiness, and contextual destinations without writes",async({page})=>{
 await mock(page);await financial(page);const writes=watchWrites(page);await home(page);
 await expect(region(page,'overview').getByRole('link',{name:'Active Matters: 18',exact:true})).toBeVisible();await expect(region(page,'messages').getByText('3 unread',{exact:true})).toBeVisible();
 await expect(region(page,'attention').getByRole('link',{name:'Private tasks — 2 overdue. View overdue tasks',exact:true})).toHaveAttribute('href','#/tasks?status=overdue');
 await expect(region(page,'applications').locator('.av2-summary-row')).toHaveCount(1);await expect(region(page,'applications')).not.toContainText('Some applicant counts differ');
 await expect(region(page,'applications').getByRole('link',{name:'Applicant Matter — Applicant One applied. View application',exact:true})).toHaveAttribute('href',`#/matters/${objectId(30)}/applications?applicantId=${objectId(61)}&applicationId=${objectId(60)}`);
 await expect(region(page,'attention').getByRole('link',{name:/Synthetic Matter 01.*Review files/})).toHaveAttribute('href',`#/matters/${objectId(1)}/files`);await expect(region(page,'attention').getByRole('link',{name:/Paused Matter.*Review withdrawal/})).toHaveAttribute('href',`#/matters/${objectId(41)}/financials`);
 await expect(region(page,'deadlines').getByRole('link',{name:/Synthetic Matter 01/})).toHaveAttribute('href',`#/matters/${objectId(1)}/deadlines`);await expect(region(page,'deadlines').locator('time[datetime="2026-09-06"]')).toHaveAttribute('aria-label','Sep 6, 2026');await expect(tour(page)).toHaveCount(0);
 await page.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Payments',exact:true}).click();const history=page.locator('[data-financial-history]');await expect(history).toHaveAttribute('data-state','ready');await expect(history.locator('[data-financial-record]').getByText('$100.05',{exact:true})).toBeVisible();await history.locator('.av2-secondary-disclosure > summary').click();await expect(history.locator('dl')).toContainText('$100.05');expect(writes).toEqual([]);
});

test("populated views and expanded previews pass AA and fit narrow, tablet, dock and enlarged text",async({page},info)=>{
 await mock(page);await page.goto(`${entry}#/matters?view=applications&caseId=${objectId(30)}&openApplicants=1`);await loaded(page,'matter-list');const row=page.locator(`[data-av2-matter="${objectId(30)}"]`);await row.locator('.av2-matter-menu > summary').click();await row.getByRole('button',{name:'Preview matter',exact:true}).click();await expect(row.locator('.av2-matter-inline-preview')).toHaveAttribute('open','');
 for(const width of [320,390,768,1024,1440]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth+1)).toBe(true);}
 let results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(results.violations).toEqual([]);await page.screenshot({path:info.outputPath('matters-desktop.png'),fullPage:true});
 await home(page);results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();expect(results.violations).toEqual([]);await page.screenshot({path:info.outputPath('home-desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:info.outputPath('home-mobile.png'),fullPage:true});await page.evaluate(()=>document.documentElement.style.fontSize='200%');expect(await page.evaluate(()=>document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth+1)).toBe(true);await page.screenshot({path:info.outputPath('home-mobile-enlarged.png'),fullPage:true});
});

test("unread and financial disagreements suppress an unverified aggregate",async({page})=>{
 const data=await mock(page);data.unread.count=99;const finances=await financial(page,{invalid:true});const writes=watchWrites(page);await home(page);await expect(region(page,'messages')).toContainText('Unread counts are updating');await expect(region(page,'messages')).not.toContainText('99 unread');data.unread.count=3;await awayAndBack(page);await loaded(page,'messages');await expect(region(page,'messages').getByText('3 unread',{exact:true})).toBeVisible();
 await page.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Payments',exact:true}).click();const history=page.locator('[data-financial-history]');await expect(history).toHaveAttribute('data-state','error');await expect(history).toContainText('Financial history couldn’t load. Try again.');await expect(history.getByText('$999.99')).toHaveCount(0);await expect(history.locator('dl')).toHaveCount(0);await expect(history.locator('[data-financial-record]')).toHaveCount(0);
 finances.invalid=false;await history.getByRole('button',{name:'Retry financial history',exact:true}).click();await expect(history).toHaveAttribute('data-state','ready');await expect(history.locator('[data-financial-record]').getByText('$100.05',{exact:true})).toBeVisible();expect(writes).toEqual([]);
});

test("zero, complete and missing-target lists remain honest and filterable",async({page})=>{
 const data=await mock(page);data.active=[];data.archived=[];data.drafts={items:[]};data.applications=[];const writes=watchWrites(page);await page.goto(`${entry}#/matters?previewCaseId=${objectId(99)}`);await loaded(page,'matter-list');await expect(region(page,'matter-list')).toContainText('No active Matters.');await expect(region(page,'matter-list')).toContainText('The linked matter is not on this page');
 data.active=Array.from({length:100},(_,index)=>matter(index+1));await awayAndBack(page);await loaded(page,'matter-list');await expect(region(page,'matter-list').getByLabel('Matter pages')).toContainText('91–100 of 100 results');await expect(page.locator(`[data-av2-matter="${objectId(99)}"]`)).toBeVisible();await expect(region(page,'matter-list')).not.toContainText('more records may exist');await page.getByRole('searchbox',{name:'Search matters',exact:true}).fill('No match');await loaded(page,'matter-list');await expect(page.locator('[data-av2-matter]')).toHaveCount(0);await expect(region(page,'matter-list')).toContainText('No Matters match these filters.');expect(writes).toEqual([]);
});

test('Home offers Retry only for a failed source and restores focus after recovery',async({page})=>{
 const data=await mock(page);data.applications={httpError:503};const writes=watchWrites(page);await page.goto(`${entry}#/home`);await expect(page.getByRole('button',{name:/^Refresh\b/})).toHaveCount(0);const panel=region(page,'applications');await expect(panel).toHaveAttribute('data-state','error');await loaded(page,'recent');await expect(page.getByRole('button',{name:/^Retry/})).toHaveCount(1);data.applications=[];const retry=panel.getByRole('button',{name:'Retry',exact:true});await retry.focus();await retry.press('Enter');await expect(panel).toHaveAttribute('data-state','ready');await expect(panel.getByRole('button')).toHaveCount(0);await expect(page.getByRole('heading',{name:'For your review',exact:true})).toBeFocused();await expect(panel).toBeHidden();await expect(panel).toContainText('No applications to review.');expect(writes).toEqual([]);
});

test('background failure clears stale values and exposes working recovery', async ({ page }) => {
  await page.route('**/attorney-v2.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><style>[hidden]{display:none!important}</style></head><body></body></html>'}));await page.goto('/attorney-v2.html');
  await page.evaluate(async () => {
    const { region } = await import('/assets/scripts/attorney-v2/dom.mjs'); window.failed = false;
    window.panel = region('Records', { signal: new AbortController().signal, load: async () => { if (window.failed) throw Error('unavailable'); return 'Current record'; }, render: value => { const a = document.createElement('a'); a.href = '#record'; a.textContent = value; return [a]; } });
    document.body.append(window.panel); await window.panel.readiness;
  });
  await page.getByRole('link', { name: 'Current record' }).focus();
  await page.evaluate(async () => { window.failed = true; await window.panel.refresh({ background: true }); });
  await expect(page.getByRole('link')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Retry records' })).toBeFocused();
  await page.evaluate(() => { window.failed = false; }); await page.getByRole('button', { name: 'Retry records' }).click();
  await expect(page.getByRole('link', { name: 'Current record' })).toBeVisible(); await expect(page.getByRole('button')).toHaveCount(0);await expect(page.getByRole('heading',{name:'Records',exact:true})).toBeFocused();
});
