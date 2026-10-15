const { test, expect } = require("./hiring-session-fixture.cjs");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic invitation Matter", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic invitation verification", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-invitations]");
const refresh=async page=>{if(await panel(page).getAttribute('data-state')==='error'){await panel(page).getByRole('button',{name:'Retry invited paralegals',exact:true}).click();}else if(await panel(page).getByRole('searchbox').isVisible()){await panel(page).getByRole('searchbox').press('Enter');}else {const current=page.url().includes('/dashboard-attorney.html');await page.reload();if(current)await currentOpen(page,page.hiringInvitationCaseId);}};
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function matter(page) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  await api(page.request, "post", `/api/cases/${publication.caseId}/invite/${paraId}`, {});
  return publication.caseId;
}
async function currentOpen(page, id) {
  const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first();
  await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "View Invited Paralegals", exact: true }).click();
}
async function open(page, id, current = false, ready = true, currentView = "active") {page.hiringInvitationCaseId=id;
  await page.goto(current ? `/dashboard-attorney.html?workspace=legacy#cases:${currentView}` : `/attorney-v2.html#/matters/${id}/invitations`, { waitUntil: "domcontentloaded" });
  if (current) await currentOpen(page, id);
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
const close = page => page.locator("#caseInvitesModal").getByRole("button", { name: "Close", exact: true }).click();
const pattern = id => `**/api/cases/${id}/invites?**`;
const dto = (page, id) => api(page.request, "get", `/api/cases/${id}/invites`);
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
test.beforeEach(async ({ playwright, page }) => {
 const server=require('./hiring-session-fixture.cjs').getServer(),actor=await server.createUser('paralegal',{},true);paraId=actor.id;await require('../../../models/User').updateOne({_id:actor.id},{$set:{state:'NY',stateExperience:['NY'],practiceAreas:['Contract Law'],specialties:['Contract Law']}});
 para=await playwright.request.newContext({baseURL:server.origin,storageState:{cookies:[{...actor.cookie,domain:'127.0.0.1',path:'/',expires:-1,secure:false,url:undefined}],origins:[]}});
});
test.afterEach(async()=>para?.dispose());


















const current=false;

test("a changed session during refresh clears both invitation surfaces without reading another account",async({page})=>{const id=await matter(page),server=require('./hiring-session-fixture.cjs').getServer(),original=page.hiringActor,other=await server.createUser('attorney');for(const current of [false,true]){await page.context().addCookies([original.cookie]);await open(page,id,current);let reads=0,ownerReads=0,releaseOwner;const gate=new Promise(resolve=>releaseOwner=resolve);await page.route(pattern(id),route=>{reads++;return route.continue();});await page.route('**/api/auth/me',async route=>{ownerReads++;await gate;return route.continue();});await page.context().addCookies([other.cookie]);try{await refresh(page);await expect.poll(()=>ownerReads).toBeGreaterThan(0);releaseOwner();await expect(panel(page)).toHaveCount(0);expect(reads).toBe(0);}finally{releaseOwner();await page.unroute('**/api/auth/me');await page.unroute(pattern(id));}expect((await api(para,'get','/api/auth/me')).user.id).toBe(paraId);}});

test("both dashboards distinguish initial errors, empty lists and unreadable records",async ({ page }) => {
  const id = await matter(page), value = await dto(page, id); let body = {}, status = 503;
  await page.route(pattern(id), route => fulfill(route, body, status));
  for (const current of [false, true]) {
    body = {}; status = 503; await open(page, id, current, false); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText("No invited paralegals yet");
    body = { ...value, invites: [] }; status = 200; await refresh(page); await expect(panel(page)).toContainText("No invited paralegals yet.");
    body = { ...body, complete: false }; await refresh(page); await expect(panel(page)).toContainText("may be incomplete"); await expect(panel(page)).toContainText("No readable invitations");
  }
});

test("both menus show real recorded responses, and V2 profile navigation returns to invitations",async ({ page }) => {
  const id = await matter(page); const before = await dto(page, id);
  await page.goto("/attorney-v2.html#/matters", { waitUntil: "domcontentloaded" }); const row = page.locator(`[data-av2-matter="${id}"]`);
  await row.locator('summary[aria-label="Actions for Synthetic invitation Matter"]').click(); await row.getByRole("link", { name: "View invited paralegals", exact: true }).click();
  await expect(panel(page)).toContainText("Awaiting response"); expect(await dto(page, id)).toEqual(before);
  const profile = panel(page).getByRole("link").first(); const href = await profile.getAttribute("href");
  const back = new URLSearchParams(href.split("?")[1]).get("returnTo"); expect(back.split("?")[0]).toBe(`#/matters/${id}/invitations`); expect(new URLSearchParams(back.split("?")[1]).get("returnTo")).toBe("#/matters");
  await profile.click(); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await page.getByRole("link", { name: "← Back to invitations", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  await api(para, "post", `/api/cases/${id}/respond-invite`, { decision: "accept" });
  await refresh(page); await expect(panel(page)).toContainText("Accepted invitation"); await expect(panel(page)).toContainText("does not confirm a hire");
  await open(page, id, true, true, "inquiries"); await expect(panel(page)).toContainText("Accepted invitation"); await expect(panel(page)).toContainText("Responded");
});

test("failed refresh removes previous names, retries safely and rejects foreign or malformed responses",async ({ page }) => {
  const id = await matter(page), value = await dto(page, id); let response = value, status = 200;
  await page.route(pattern(id), route => fulfill(route, response, status));
  for (const current of [false, true]) {
    response = value; status = 200; await open(page, id, current); const name = value.invites[0].paralegal.name; await expect(panel(page)).toContainText(name);
    status = 503; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText(name);
    status = 200;
    for (const invalid of [{ ...value, caseId: "0".repeat(24) }, { ...value, ownerId: "0".repeat(24) }, { ...value, invites: [{ ...value.invites[0], invitedAt: "broken" }] }]) {
      response = invalid; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).not.toContainText(name);
    }
    response = value; await refresh(page); await expect(panel(page)).toHaveAttribute("data-state", "ready");
  }
});
