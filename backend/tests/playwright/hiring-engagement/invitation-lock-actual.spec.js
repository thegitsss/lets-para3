const { test, expect } = require("./hiring-session-fixture.cjs");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic invitation review", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic invitation review verification", tasks: [{ title: "Prepare agreement" }] };
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
  return { id };
}
async function dto(page, id) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  return api(page.request, "get", `/api/cases/${id}/application-inventory?expectedOwnerId=${user.id || user._id}`);
}
async function currentOpen(page, id) {
  const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first();
  await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "Review applications", exact: true }).click();
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

const invitations = page => page.locator("[data-invitation-actions]");
async function candidate(page, id) { await page.goto(`/attorney-v2.html#/paralegals/${paraId}${id ? `?caseId=${id}` : ""}`, { waitUntil: "domcontentloaded" }); await page.locator(".av2-profile-invite > summary").click(); await expect(invitations(page)).toBeVisible(); }
async function reviewInvitation(page) { if (!await page.locator(".av2-profile-invite").getAttribute("open").then(value => value !== null)) await page.locator(".av2-profile-invite > summary").click(); await invitations(page).getByRole("button", { name: /Review invitation$|Refresh invitation review$|Check saved invitation$/ }).click(); await expect(invitations(page)).toHaveAttribute("data-state", "ready"); }
async function sendInvitation(page) { await invitations(page).getByRole("button", { name: "Review invitation before sending" }).click(); await invitations(page).getByRole("button", { name: "Send invitation", exact: true }).click(); await expect(invitations(page)).toHaveAttribute("data-state", "ready"); await expect(invitations(page).getByRole("status")).toContainText("Invitation sent."); }
async function storedInvitation(page, id) { const user = (await (await page.request.get("/api/auth/me")).json()).user; return api(page.request, "get", `/api/cases/${id}/invitation-review/${paraId}?expectedOwnerId=${user.id || user._id}`); }
const writePattern = id => `**/api/cases/${id}/invite/${paraId}`;

test("an invitation locks the shown amount and acceptance becomes an application without hiring", async ({ page }) => {
  const { id } = await matter(page); await candidate(page, id); await reviewInvitation(page); await expect(invitations(page)).toContainText("Matter amount: $400.01"); await expect(invitations(page)).toContainText("locks the Matter amount shown above");
  await sendInvitation(page); let value = await storedInvitation(page, id); expect(value).toMatchObject({ canInvite: false, amountLocked: true, amountCents: 40001, invitation: { status: "pending" } });
  await api(para, "post", `/api/cases/${id}/invite/accept`, {}); await reviewInvitation(page); await expect(invitations(page)).toContainText("accepted the invitation");
  const applications = await dto(page, id); expect(applications.caseStatus).toBe("open"); expect(applications.applications[0].status).toBe("submitted");
  await invitations(page).getByRole("link", { name: "Review this Matter's applications" }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await panel(page).locator(`details[data-application="${paraId}"] > summary`).click();await panel(page).getByText('Recorded status history',{exact:true}).click();await expect(panel(page)).toContainText("Accepted invitation");
});

