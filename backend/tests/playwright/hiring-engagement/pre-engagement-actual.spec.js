const { test, expect } = require("./hiring-session-fixture.cjs");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic pre-engagement review", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic pre-engagement review verification", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-applications]");
const refresh = async page => { await panel(page).locator('[name="applicationSearch"]').press("Enter"); await expect(panel(page)).toHaveAttribute("data-state", "ready"); };
const pattern = id => `**/api/cases/${id}/application-inventory?**`;
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  if(method==='post'&&data&&!data.reviewedRevision&&(/\/pre-engagement\/[a-f0-9]{24}\/request$/.test(path)||/\/pre-engagement\/review$/.test(path))){const caseId=path.match(/\/cases\/([a-f0-9]{24})/)[1],ownerId=user.id||user._id,current=await client.get(`/api/cases/${caseId}/pre-engagement/review/${paraId}?expectedOwnerId=${ownerId}`);expect(current.ok(),await current.text()).toBe(true);data={...data,reviewedRevision:(await current.json()).revision,...(path.endsWith('/review')?{applicantId:paraId}:{})};}
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
  const trigger = actions.locator('[data-case-menu-trigger]');
  await trigger.hover();
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await actions.getByRole('button', { name: 'Review applications', exact: true }).click();
}
async function open(page, id, current = false, ready = true) {
  await page.goto(current ? "/dashboard-attorney.html#cases:inquiries" : `/attorney-v2.html#/matters/${id}/applications`, { waitUntil: "domcontentloaded" });
  if (current) await currentOpen(page, id);
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
test.beforeEach(async ({ playwright, page }) => {
 const server=require('./hiring-session-fixture.cjs').getServer(),actor=await server.createUser('paralegal',{},true);paraId=actor.id;await require('../../../models/User').updateOne({_id:actor.id},{$set:{state:'NY',stateExperience:['NY'],practiceAreas:['Contract Law'],specialties:['Contract Law']}});
 para=await playwright.request.newContext({baseURL:server.origin,storageState:{cookies:[{...actor.cookie,domain:'127.0.0.1',path:'/',expires:-1,secure:false,url:undefined}],origins:[]}});
});
test.afterEach(async()=>para?.dispose());


const pre = page => page.locator("[data-pre-engagement]");
async function reviewRequirements(page) {const application=panel(page).locator(`details[data-application="${paraId}"]`);if(!await application.evaluate(node=>node.open))await application.locator(':scope > summary').click();const process=application.locator('details[data-applicant-section="hiring"]');if(!await process.evaluate(node=>node.open))await process.locator(':scope > summary').click();if(!await pre(page).isVisible()){await process.getByRole('button',{name:'Review pre-engagement requirements',exact:true}).click();await expect(pre(page)).toHaveAttribute('data-state','ready');}else {await pre(page).getByRole('button',{name:/Refresh saved requirements|Check saved requirements|Review pre-engagement requirements/}).click();await expect(pre(page)).toHaveAttribute('data-state','ready');}}
async function compose(page, details = "Synthetic client and opposing party for the conflicts check.") { await pre(page).getByLabel("Require conflicts check", { exact: true }).check(); await pre(page).getByLabel("Parties and details for the conflicts check", { exact: true }).fill(details); await pre(page).getByRole("button", { name: "Review requirements before sending" }).click(); }
const requestPath = id => `/api/cases/${id}/pre-engagement/${paraId}/request`;
async function stored(page, id) { const user = (await (await page.request.get("/api/auth/me")).json()).user; return api(page.request, "get", `/api/cases/${id}/pre-engagement/review/${paraId}?expectedOwnerId=${user.id || user._id}`); }
async function sendRequirements(page) { await pre(page).getByRole("button", { name: "Send requirements", exact: true }).click(); await expect(pre(page)).toHaveAttribute("data-state", "ready"); await expect(pre(page).getByRole("status")).toContainText("Pre-engagement requirements sent."); }




















const current=false;

test("V2 delayed requests cannot restore pre-engagement after an account change",async ({ page }) => {
  const { id } = await matter(page); let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(`**${requestPath(id)}`, async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }); });
  await open(page, id, current); await reviewRequirements(page); await compose(page); await pre(page).getByRole("button", { name: "Send requirements", exact: true }).click();
  try { await waiting;
    await replaceActualOwner(page);
    await expect(panel(page)).toHaveCount(0);
  } finally { release(); }
  await expect(pre(page)).toHaveCount(0);
});

test("V2 lost request responses show current saved requirements without resubmitting",async ({ page }) => {
  const { id } = await matter(page); let writes = 0;
  await page.route(`**${requestPath(id)}`, async route => { writes++; const result = await route.fetch(); expect(result.status()).toBe(200); await route.abort("failed"); });
  await open(page, id, current); await reviewRequirements(page); await compose(page); await pre(page).getByRole("button", { name: "Send requirements", exact: true }).click(); await expect(pre(page)).toHaveAttribute("data-state", "uncertain");
  await refresh(page);await reopenUncertainRequirements(page); await expect(pre(page)).toHaveAttribute("data-state", "uncertain"); await reviewRequirements(page); expect(writes).toBe(1); await expect(pre(page)).toContainText("does not confirm the result of the earlier request"); expect((await stored(page, id)).request.status).toBe("requested");
});

test("V2 requests, returns and approves real conflicts responses without hiring",async ({ page }) => {
  const { id } = await matter(page); await open(page, id, current); await reviewRequirements(page); await compose(page); await sendRequirements(page);
  let value = await stored(page, id); expect(value.request).toMatchObject({ status: "requested", conflictsRequired: true });
  await api(para, "post", `/api/cases/${id}/pre-engagement/respond`, { revision: value.request.revision, conflictsResponseType: "disclosure", conflictsDisclosureText: "I previously assisted on an unrelated matter for the named party." });
  await reviewRequirements(page); await expect(pre(page)).toContainText("I previously assisted on an unrelated matter");
  await pre(page).getByRole("button", { name: "Ask for response changes", exact: true }).click(); await pre(page).getByRole("button", { name: "Request response changes", exact: true }).click(); await expect(pre(page)).toHaveAttribute("data-state", "ready");
  value = await stored(page, id); expect(value.request.status).toBe("changes_requested");
  await api(para, "post", `/api/cases/${id}/pre-engagement/respond`, { revision: value.request.revision, conflictsResponseType: "disclosure", conflictsDisclosureText: "The earlier work ended two years ago. Synthetic details supplied for attorney review." });
  await reviewRequirements(page); await pre(page).getByRole("button", { name: "Approve pre-engagement response", exact: true }).click(); await expect(pre(page)).toContainText("Hiring and funding are separate actions.");
  await pre(page).getByRole("button", { name: "Confirm pre-engagement approval", exact: true }).click(); await expect(pre(page)).toHaveAttribute("data-state", "ready"); await expect(pre(page)).toContainText("Pre-engagement response approved."); expect((await stored(page, id)).request.status).toBe("approved");
  const applications = await dto(page, id); expect(applications.caseStatus).toBe("open"); expect(applications.applications[0].status).toBe("submitted");
});

test("V2 requirements and confirmation fit mobile and desktop with keyboard access",async ({ page }, testInfo) => {
  const { id } = await matter(page); await open(page, id, current); await reviewRequirements(page); await compose(page);
  for (const width of [320, 1366]) {
    await page.setViewportSize({ width, height: 900 }); const confirm = pre(page).getByRole("button", { name: "Send requirements", exact: true }); await confirm.scrollIntoViewIfNeeded(); await confirm.focus();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect((await confirm.boundingBox()).height).toBeGreaterThanOrEqual(44); await expect(confirm).toBeFocused();
    expect((await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-applications]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-pre-engagement-${width}.png`), fullPage: true });
  }
});

test("a newer submitted response cannot be approved from an older displayed response",async ({ page }) => {
  const { id } = await matter(page); await api(page.request, "post", requestPath(id), { conflictsCheckRequired: true, conflictsDetails: "Synthetic parties." });
  await api(para, "post", `/api/cases/${id}/pre-engagement/respond`, { conflictsResponseType: "none_known" });
  await open(page, id); await reviewRequirements(page); await pre(page).getByRole("button", { name: "Approve pre-engagement response", exact: true }).click();
  await api(page.request, "post", `/api/cases/${id}/pre-engagement/review`, { action: "request_changes" });
  await api(para, "post", `/api/cases/${id}/pre-engagement/respond`, { conflictsResponseType: "disclosure", conflictsDisclosureText: "Newly disclosed connection requiring a fresh review." });
  await pre(page).getByRole("button", { name: "Confirm pre-engagement approval", exact: true }).click(); await expect(pre(page)).toHaveAttribute("data-state", "uncertain"); await reviewRequirements(page); await expect(pre(page)).toContainText("Newly disclosed connection requiring a fresh review."); expect((await stored(page, id)).request.status).toBe("submitted");
});

test("a single snapshot conflict during engagement rechecks the saved Matter without discarding an unsent response review",async ({ page }) => {
  const { id } = await matter(page); await open(page, id); await reviewRequirements(page);
  await pre(page).getByLabel('Require conflicts check', { exact: true }).check();
  await pre(page).getByLabel('Parties and details for the conflicts check', { exact: true }).fill('Retain this unsent review while another response is recorded.');
  let reads = 0;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => ++reads === 1 ? fulfill(route, { code: 'WORKSPACE_CHANGED' }, 409) : route.continue());
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('[data-matter-workspace]')).toHaveAttribute('data-state', 'ready');
  await expect(pre(page).getByLabel('Parties and details for the conflicts check', { exact: true })).toHaveValue('Retain this unsent review while another response is recorded.');
});

test("an application snapshot conflict preserves the focused unsent pre-engagement review",async ({ page }) => {
  const { id } = await matter(page); await open(page, id); await reviewRequirements(page);
  await pre(page).getByLabel('Require conflicts check', { exact: true }).check();
  const details = pre(page).getByLabel('Parties and details for the conflicts check', { exact: true });
  await details.fill('Retain this unsent review while another response is recorded.');
  let reads = 0;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => ++reads === 1 ? fulfill(route, { code: 'APPLICATION_REVIEW_CHANGED' }, 409) : route.continue());
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => reads).toBe(2);
  await expect(page.locator('[data-matter-workspace]')).toHaveAttribute('data-state', 'ready');
  await expect(details).toBeFocused();
  await expect(details).toHaveValue('Retain this unsent review while another response is recorded.');
});

test("document security failures yield no link and approved access expires",async ({ page }) => {
  const { id } = await matter(page); const value = await stored(page, id), key = `cases/${id}/pre-engagement/synthetic.pdf`;
  value.request = { status: "requested", revision: 1, applicantId: paraId, confidentialityRequired: true, conflictsRequired: false, conflictsDetails: "", acknowledged: false, acknowledgedAt: null, conflictsResponse: null, disclosure: "", requestedAt: new Date().toISOString(), submittedAt: null, reviewedAt: null, documents: [{ kind: "attorney", key, name: "synthetic.pdf", mimeType: "application/pdf", size: 50, uploadedAt: null }] }; value.selectedRequest = true;
  await page.route(`**/api/cases/${id}/pre-engagement/review/${paraId}?**`, route => fulfill(route, value));
  await page.route("**/api/uploads/signed-get?**", route => fulfill(route, { code: "FILE_SCAN_PENDING" }, 423));
  await open(page, id); await reviewRequirements(page); await pre(page).getByRole("button", { name: "Prepare requested agreement" }).click(); await expect(pre(page)).toContainText("awaiting its security check"); await expect(pre(page).getByRole("link", { name: /Open synthetic/ })).toHaveCount(0);
  await page.unroute("**/api/uploads/signed-get?**"); await page.route("**/api/uploads/signed-get?**", route => fulfill(route, { url: "https://synthetic-document.test/synthetic.pdf" }));
  await page.clock.install(); await pre(page).getByRole("button", { name: "Prepare requested agreement" }).click(); const link = pre(page).getByRole("link", { name: "Open synthetic.pdf (new tab)" }); await expect(link).toHaveAttribute("rel", "noopener noreferrer"); await expect(link).toHaveAttribute("referrerpolicy", "no-referrer"); await page.clock.fastForward(60000); await expect(link).toHaveCount(0);
});

test("request validation and cancellation preserve the saved request",async ({ page }) => {
  const { id } = await matter(page); await open(page, id); await reviewRequirements(page);
  await pre(page).getByRole("button", { name: "Review requirements before sending" }).click(); await expect(pre(page)).toContainText("Choose a confidentiality agreement, a conflicts check, or both.");
  await compose(page); await pre(page).getByRole("button", { name: "Return to review", exact: true }).click(); expect((await stored(page, id)).request).toBeNull();
  await pre(page).getByRole("button", { name: "Discard unsent requirements" }).click(); await expect(pre(page).getByLabel("Parties and details for the conflicts check", { exact: true })).toHaveValue("");
});

async function replaceActualOwner(page){const server=require('./hiring-session-fixture.cjs').getServer(),other=await server.createUser('attorney');await page.context().addCookies([other.cookie]);const sibling=await page.context().newPage();await sibling.goto(server.origin+'/terms.html');const response=await sibling.request.get('/api/auth/me');expect(response.status()).toBe(200);const user=(await response.json()).user;expect(user.id).toBe(other.id);await sibling.evaluate(user=>localStorage.setItem('lpc_user',JSON.stringify(user)),user);await page.bringToFront();await expect(page.locator('[data-matter-applications]')).toHaveCount(0);await sibling.close();}

async function reopenUncertainRequirements(page){const application=panel(page).locator(`details[data-application="${paraId}"]`);if(!await application.evaluate(node=>node.open))await application.locator(':scope > summary').click();const process=application.locator('details[data-applicant-section="hiring"]');if(!await process.evaluate(node=>node.open))await process.locator(':scope > summary').click();if(!await pre(page).isVisible())await process.getByRole('button',{name:'Review pre-engagement requirements',exact:true}).click();}
