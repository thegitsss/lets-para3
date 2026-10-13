const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic application review", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic application review verification", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-applications]");
const refresh = page => panel(page).getByRole("button", { name: "Refresh applications", exact: true }).click();
const pattern = id => `**/api/cases/${id}/application-inventory?**`;
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function matter(page) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  const id = publication.caseId;
  const application = await api(para, "post", `/api/cases/${id}/apply`, { coverLetter: "I can prepare the agreement and organize the supporting exhibits.\nMy application includes contract review experience." });
  return { id, applicationId: application.applicationId || application._id || application.id };
}
async function dto(page, id) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  return api(page.request, "get", `/api/cases/${id}/application-inventory?expectedOwnerId=${user.id || user._id}`);
}
async function currentOpen(page, id) {
  const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first();
  const trigger = actions.locator("[data-case-menu-trigger]");
  // Establish the hover target before the click: the captured Firefox misses
  // changed their pointer center while entering the row's hover treatment.
  await trigger.hover();
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await actions.getByRole("button", { name: "Review applications", exact: true }).click();
}
async function open(page, id, current = false, ready = true) {
  await page.goto(current ? "/dashboard-attorney.html#cases:inquiries" : `/attorney-v2.html#/matters/${id}/applications`, { waitUntil: "domcontentloaded" });
  if (current) await currentOpen(page, id);
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
test.beforeAll(async ({ playwright, baseURL }) => {
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { "x-ai-control-room-e2e-secret": process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const bootstrap = await para.post("/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal", { headers }); expect(bootstrap.ok()).toBeTruthy(); const payload = await bootstrap.json();
  const csrf = await (await para.get("/api/csrf")).json();
  const login = await para.post("/api/auth/login", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { email: payload.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || "ControlRoomSupport123!" } }); expect(login.ok(), await login.text()).toBeTruthy();
  const user = (await (await para.get("/api/auth/me")).json()).user; paraId = user.id || user._id;
});
test.afterAll(async () => para?.dispose());

test("both dashboards read a real application; viewing preserves status and withdrawal remains in history", async ({ page }) => {
  const { id, applicationId } = await matter(page), before = await dto(page, id);
  await page.goto("/attorney-v2.html#/matters?view=applications", { waitUntil: "domcontentloaded" }); const row = page.locator(`[data-av2-matter="${id}"]`);
  await row.getByText(/applicants? on this matter/).click(); await row.getByRole("link", { name: "Review applicants", exact: true }).click();
  await expect(panel(page)).toContainText("I can prepare the agreement"); expect(await dto(page, id)).toEqual(before);
  await open(page, id, true); await expect(panel(page)).toContainText("My application includes contract review experience."); expect(await dto(page, id)).toEqual(before);
  await api(para, "post", `/api/applications/${applicationId}/revoke`, {}); await refresh(page); await expect(panel(page)).toContainText("Withdrawn by paralegal");
  await open(page, id); await expect(panel(page)).toContainText("Withdrawn by paralegal"); await expect(panel(page)).toContainText("Recorded status history");
});
test("current profile navigation returns to the exact applicant and refresh/back preserve the review route", async ({ page }) => {
  const { id } = await matter(page); await open(page, id);
  await panel(page).getByRole("link", { name: "View current profile and documents", exact: true }).click();
  await page.getByRole("link", { name: "Back to applications", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(page).toHaveURL(new RegExp(`applications\\?applicantId=${paraId}$`));
  await expect(panel(page).locator("details")).toHaveAttribute("open", ""); await page.reload(); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); await page.goBack(); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await panel(page).getByRole("button", { name: "Return to all applications", exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/matters/${id}/applications$`)); await page.reload(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page).getByRole("button", { name: "Return to all applications", exact: true })).toBeHidden();
});
test("failed and malformed refreshes remove old letters; missing records never look like successful empty reads", async ({ page }) => {
  const { id } = await matter(page), value = await dto(page, id); let body = value, status = 200;
  await page.route(pattern(id), route => fulfill(route, body, status));
  for (const current of [false, true]) {
    body = value; status = 200; await open(page, id, current); await expect(panel(page)).toContainText("I can prepare the agreement");
    status = 503; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText("I can prepare the agreement");
    status = 200;
    for (const bad of [{ ...value, ownerId: "0".repeat(24) }, { ...value, caseId: "0".repeat(24) }, { ...value, applications: null }]) { body = bad; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); }
    body = { ...value, applications: [], total: 0, counts: Object.fromEntries(Object.keys(value.counts).map(key => [key, 0])), complete: false, warnings: ["posting_missing"] }; await refresh(page); await expect(panel(page)).toContainText("No readable applications"); await expect(panel(page)).not.toContainText("No applications have been recorded");
    body = { ...body, warnings: [], complete: true }; await refresh(page); await expect(panel(page)).toContainText("No applications have been recorded");
  }
});
test("paging reads each page afresh and a failed next page cannot retain a previous letter", async ({ page }) => {
  const { id } = await matter(page), value = await dto(page, id); let fail = false;
  await page.route(pattern(id), route => {
    const number = Number(new URL(route.request().url()).searchParams.get("page"));
    const applications = Array.from({ length: number === 1 ? 25 : 1 }, (_, i) => ({ ...value.applications[0], applicantId: (i + 1000 + number * 100).toString(16).padStart(24, '0'), coverLetter: number === 2 ? "SECOND_PAGE_PRIVATE_LETTER" : "FIRST_PAGE_PRIVATE_LETTER" }));
    return fulfill(route, fail && number === 2 ? {} : { ...value, filters: { ...value.filters, page: number }, page: number, pages: 2, total: 26, counts: { ...value.counts, submitted: 26 }, applications }, fail && number === 2 ? 503 : 200);
  });
  for (const current of [false, true]) {
    fail = false; await open(page, id, current); await panel(page).getByRole("button", { name: "Next applications", exact: true }).click(); await expect(panel(page)).toContainText("SECOND_PAGE_PRIVATE_LETTER"); await expect(panel(page)).not.toContainText("FIRST_PAGE_PRIVATE_LETTER");
    await panel(page).getByRole("button", { name: "Previous applications", exact: true }).click(); await expect(panel(page)).toContainText("FIRST_PAGE_PRIVATE_LETTER");
    fail = true; await panel(page).getByRole("button", { name: "Next applications", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText("FIRST_PAGE_PRIVATE_LETTER");
    fail = false; await refresh(page); await expect(panel(page)).toContainText("SECOND_PAGE_PRIVATE_LETTER");
  }
});
test("closing the current review or leaving V2 discards delayed private letters", async ({ page }) => {
  const { id } = await matter(page), value = await dto(page, id); value.applications[0].coverLetter = "PRIVATE_DELAYED_APPLICATION";
  for (const current of [false, true]) {
    let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
    await page.route(pattern(id), async route => { arrived(); await gate; await fulfill(route, value).catch(() => {}); });
    await open(page, id, current, false); await waiting;
    if (current) await page.keyboard.press("Escape"); else await page.getByRole("link", { name: "Back to Matters", exact: true }).click();
    release(); await expect(panel(page)).toHaveCount(0); await expect(page.locator("body")).not.toContainText("PRIVATE_DELAYED_APPLICATION"); await page.unroute(pattern(id));
  }
});
test("a changed account clears both application surfaces before another account's data can load", async ({ page }) => {
  const { id } = await matter(page);
  for (const current of [false, true]) {
    await open(page, id, current); let reads = 0, ownerReads = 0, releaseOwner;
    const ownerGate = new Promise(resolve => { releaseOwner = resolve; });
    await page.route(pattern(id), route => { reads++; return route.continue(); });
    // Background ownership checks can clear the review before a native click.
    // Hold the changed-owner response until this deliberate refresh is sent.
    await page.route("**/api/auth/me", async route => {
      ownerReads++; await ownerGate;
      return fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } });
    });
    try {
      await refresh(page); await expect.poll(() => ownerReads).toBeGreaterThan(0); releaseOwner();
      await expect(panel(page)).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("I can prepare the agreement");
      expect(reads).toBe(0);
    } finally {
      releaseOwner(); await page.unroute("**/api/auth/me"); await page.unroute(pattern(id));
    }
  }
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} long letters and unavailable profiles remain readable, keyboard accessible and contained on mobile and desktop`, async ({ page }, testInfo) => {
  const { id } = await matter(page), value = await dto(page, id);
  value.applications[0] = { ...value.applications[0], name: '<img src=x onerror="alert(1)">', profileAvailable: false, coverLetter: "Synthetic long cover letter. ".repeat(75), warnings: ["records_differ"], status: "accepted", matterStatus: "submitted", invitations: [{ status: "accepted", invitedAt: null, respondedAt: null }] };
  value.counts = { ...value.counts, submitted: 0, accepted: 1 };
  await page.route(pattern(id), route => fulfill(route, value));
  {
    await open(page, id, current); await expect(panel(page)).toContainText("The current profile is unavailable."); await expect(panel(page)).toContainText("does not confirm funding"); expect(await panel(page).locator("img").count()).toBe(0);
    for (const width of [320, 390, 1366]) {
      await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (current) { const box = await page.locator("#caseNoteModal [data-note-cancel]").boundingBox(); expect(box.y + box.height).toBeLessThanOrEqual(890); }
      if (width !== 320) { const result = await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-applications]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]); }
      await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-applications-${width}.png`), fullPage: true });
    }
    await panel(page).locator("summary").focus(); await page.keyboard.press("Enter"); await expect(panel(page).locator("details")).not.toHaveAttribute("open", "");
    if (current) { await page.keyboard.press("Escape"); await expect(panel(page)).toHaveCount(0); }
  }
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain("Synthetic long cover letter");
});

test("invalid applicant links show an error instead of loading unrelated applications", async ({ page }) => {
  const { id } = await matter(page); let reads = 0;
  await page.route(pattern(id), route => { reads++; return route.continue(); });
  await page.goto(`/attorney-v2.html#/matters/${id}/applications?applicantId=invalid`, { waitUntil: "domcontentloaded" });
  await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText("I can prepare the agreement"); expect(reads).toBe(0);
  await panel(page).getByRole("button", { name: "Return to all applications", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("I can prepare the agreement");
});

test("original application profile returns to the same active or withdrawn record without a mutation", async ({ page }, info) => {
  const { id, applicationId } = await matter(page);
  const mutations=[],errors=[],events=[];
  page.on('pageerror',error=>errors.push({name:error.name,message:error.message,stack:error.stack,page:page.url()}));
  page.on('console',message=>{const prefix='APPLICATION_RETURN ';if(message.text().startsWith(prefix))events.push(JSON.parse(message.text().slice(prefix.length)));});
  await page.addInitScript(()=>{
    const report=(type,extra={})=>console.debug('APPLICATION_RETURN '+JSON.stringify({type,page:location.href,...extra}));
    for(const type of ['pageswap','pagereveal'])addEventListener(type,event=>report(type,{transition:!!event.viewTransition}));
    addEventListener('unhandledrejection',event=>report('unhandledrejection',{message:String(event.reason)}));
  });
  await open(page,id,true);
  page.on('request',request=>{if(request.method()!=='GET' && /\/api\/(?:cases|applications|payments)\//.test(request.url()))mutations.push(request.url());});
  for(const status of ['submitted','withdrawn']){
    if(status==='withdrawn'){await api(para,'post',`/api/applications/${applicationId}/revoke`,{});await refresh(page);}
    const before=await dto(page,id);expect(before.applications[0].status).toBe(status);
    const current=panel(page).locator(`details[data-application="${paraId}"]`);
    await expect(current).toHaveAttribute('open','');
    await current.getByRole('link',{name:'View current profile and documents',exact:true}).click();
    await expect(page.locator('#profileName')).toHaveText(before.applications[0].name);
    const profileUrl=page.url();await page.locator('#backBtn').click();
    await expect(panel(page)).toHaveAttribute('data-state','ready');
    await expect(panel(page).locator(`details[data-application="${paraId}"]`)).toHaveAttribute('open','');
    await expect(panel(page)).toContainText('I can prepare the agreement and organize the supporting exhibits.');
    expect(await dto(page,id)).toEqual(before);
    await page.screenshot({path:info.outputPath(`original-application-return-${status}.png`)});
    await require('node:fs/promises').writeFile(info.outputPath(`original-application-return-${status}.json`),JSON.stringify({profileUrl,returnUrl:page.url(),caseId:id,applicantId:paraId,status,mutations,errors,events},null,2));
  }
  expect(mutations).toEqual([]);expect(errors).toEqual([]);
  expect(events.filter(event=>event.type==='unhandledrejection')).toEqual([]);
  if(info.project.name==='chromium'){
    for(const path of ['/profile-paralegal.html','/dashboard-attorney.html'])expect(events.filter(event=>event.type==='pagereveal'&&event.transition&&new URL(event.page).pathname===path)).toHaveLength(2);
  }
});
