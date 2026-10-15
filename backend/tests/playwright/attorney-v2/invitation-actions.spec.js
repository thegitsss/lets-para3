const { test, expect } = require("../support-session-fixture");
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
test.beforeAll(async ({ playwright, baseURL }) => {
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { "x-ai-control-room-e2e-secret": process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const bootstrap = await para.post("/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal", { headers }); expect(bootstrap.ok()).toBeTruthy(); const payload = await bootstrap.json();
  const csrf = await (await para.get("/api/csrf")).json();
  const login = await para.post("/api/auth/login", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { email: payload.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || "ControlRoomSupport123!" } }); expect(login.ok(), await login.text()).toBeTruthy();
  const user = (await (await para.get("/api/auth/me")).json()).user; paraId = user.id || user._id;
});
test.afterAll(async () => para?.dispose());

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
  await invitations(page).getByRole("link", { name: "Review this Matter's applications" }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("Accepted invitation");
});

test("decline and accepted-invitation revocation remain visible and are not treated as hires", async ({ page }) => {
  const { id } = await matter(page); await candidate(page, id); await reviewInvitation(page); await sendInvitation(page);
  await api(para, "post", `/api/cases/${id}/invite/decline`, {}); await reviewInvitation(page); await expect(invitations(page)).toContainText("Declined invitation"); await sendInvitation(page);
  await api(para, "post", `/api/cases/${id}/invite/accept`, {}); await api(para, "post", `/api/cases/${id}/invite/revoke`, {}); await reviewInvitation(page);
  const value = await storedInvitation(page, id); expect(value.invitation.status).toBe("declined"); const applications = await dto(page, id); expect(applications.applications[0].status).toBe("withdrawn"); expect(applications.caseStatus).toBe("open");
});

test("canceling invitation confirmation does not lock or change the Matter amount", async ({ page }) => {
  const { id } = await matter(page); await candidate(page, id); await reviewInvitation(page); await invitations(page).getByRole("button", { name: "Review invitation before sending" }).click(); await expect(invitations(page)).toContainText("Accepting an invitation does not hire the paralegal or fund the Matter.");
  await expect(invitations(page).getByRole("button", { name: "Review invitation before sending" })).toBeHidden();
  await expect(invitations(page).getByRole("button", { name: "Choose a Matter", exact: true })).toBeHidden();
  await invitations(page).getByRole("button", { name: "Return to invitation review" }).click();
  await expect(invitations(page).getByRole("button", { name: "Review invitation before sending" })).toBeFocused();
  await expect(invitations(page).getByRole("button", { name: "Choose a Matter", exact: true })).toBeVisible();
  expect((await storedInvitation(page, id)).amountLocked).toBe(false); expect((await storedInvitation(page, id)).invitation).toBeNull();
});

test("a changed displayed invitation cannot overwrite a send from another tab", async ({ page }) => {
  const { id } = await matter(page); await candidate(page, id); await reviewInvitation(page); await invitations(page).getByRole("button", { name: "Review invitation before sending" }).click();
  await api(page.request, "post", `/api/cases/${id}/invite/${paraId}`, {}); await invitations(page).getByRole("button", { name: "Send invitation", exact: true }).click(); await expect(invitations(page)).toHaveAttribute("data-state", "uncertain"); await reviewInvitation(page); await expect(invitations(page)).toContainText("already awaiting this paralegal's response");
});

test("lost invitation responses recover the actual status without resending", async ({ page }) => {
  const { id } = await matter(page); let writes = 0;
  await page.route(writePattern(id), async route => { writes++; const result = await route.fetch(); expect(result.status()).toBe(200); await route.abort("failed"); });
  await candidate(page, id); await reviewInvitation(page); await invitations(page).getByRole("button", { name: "Review invitation before sending" }).click(); await invitations(page).getByRole("button", { name: "Send invitation", exact: true }).click(); await expect(invitations(page)).toHaveAttribute("data-state", "uncertain");
  await page.getByRole("link", { name: "Home", exact: true }).click(); await page.goBack(); await expect(invitations(page)).toHaveAttribute("data-state", "uncertain"); await reviewInvitation(page); expect(writes).toBe(1); await expect(invitations(page)).toContainText("does not confirm the result of the earlier request"); expect((await storedInvitation(page, id)).invitation.status).toBe("pending");
});

test("Matter selection follows server pages and keeps the chosen Matter in the confirmation", async ({ page }) => {
  const { id } = await matter(page), user = (await (await page.request.get("/api/auth/me")).json()).user, next = "e".repeat(24); const pages = [];
  await page.route(`**/api/cases/invitation-options/${paraId}?**`, route => { const cursor = new URL(route.request().url()).searchParams.get("cursor") || ""; pages.push(cursor); return fulfill(route, { ownerId: user.id || user._id, paralegalId: paraId, cursor, next: cursor ? null : next, matters: cursor ? [{ caseId: id, title: "Synthetic invitation review" }] : [{ caseId: next, title: "Earlier page entry" }] }); });
  await candidate(page); await invitations(page).getByRole("button", { name: "Choose a Matter", exact: true }).click(); await expect(invitations(page)).toHaveAttribute("data-state", "choosing"); await invitations(page).getByRole("button", { name: "Next Matters" }).click(); await invitations(page).getByRole("button", { name: "Synthetic invitation review", exact: true }).click(); await expect(invitations(page)).toHaveAttribute("data-state", "ready"); expect(pages).toEqual(["", next]); await expect(invitations(page)).toContainText("Matter amount: $400.01");
});

test("account changes erase a late invitation response and its confirmation", async ({ page }) => {
  const { id } = await matter(page); let release, arrived; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(writePattern(id), async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await candidate(page, id); await reviewInvitation(page); await invitations(page).getByRole("button", { name: "Review invitation before sending" }).click(); await invitations(page).getByRole("button", { name: "Send invitation", exact: true }).click();
  try { await waiting; await page.route("**/api/auth/me", route => fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(invitations(page)).toHaveCount(0); } finally { release(); }
  await expect(invitations(page)).toHaveCount(0);
});

test("invitation confirmation retains the amount and keyboard controls at mobile and desktop widths", async ({ page }, testInfo) => {
  const { id } = await matter(page); await candidate(page, id); await reviewInvitation(page);
  for (const [width, dark, font] of [[320, false, ""], [1366, false, ""], [390, true, "32px"]]) {
    await page.evaluate(({ dark, font }) => { for (const element of [document.documentElement, document.body]) element.classList.toggle("theme-dark", dark); document.documentElement.style.fontSize = font; }, { dark, font });
    await invitations(page).getByRole("button", { name: "Review invitation before sending" }).click();
    await page.setViewportSize({ width, height: 900 }); const confirm = invitations(page).getByRole("button", { name: "Send invitation", exact: true }); await confirm.scrollIntoViewIfNeeded(); await confirm.focus(); await expect(confirm).toBeFocused(); expect((await confirm.boundingBox()).height).toBeGreaterThanOrEqual(44); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(invitations(page).getByText("Matter amount: $400.01", { exact: true })).toBeHidden();
    await expect(invitations(page).getByText("Recorded Matter amount: $400.01", { exact: true })).toBeVisible();
    await expect(invitations(page).getByRole("link", { name: "View this Matter's invitations" })).toBeHidden();
    expect((await new AxeBuilder({ page }).include("[data-invitation-actions]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await page.screenshot({ path: testInfo.outputPath(`invitation-${width}.png`), fullPage: true });
    await confirm.press(testInfo.project.name === "webkit" ? "Alt+Tab" : "Tab");
    const back = invitations(page).getByRole("button", { name: "Return to invitation review" });
    await expect(back).toBeFocused(); await back.press("Enter");
    await expect(invitations(page).getByRole("button", { name: "Review invitation before sending" })).toBeFocused();
  }
});
test("replacement-work confirmation distinguishes the remaining amount from recorded history", async ({ page }) => {
  const { id } = await matter(page), value = await storedInvitation(page, id); Object.assign(value, { relisted: true, remainingCents: 12000, amountLocked: true });
  await page.route(`**/api/cases/${id}/invitation-review/${paraId}?**`, route => fulfill(route, value));
  await candidate(page, id); await reviewInvitation(page); await expect(invitations(page)).toContainText("Remaining Matter amount: $120.00");
  await invitations(page).getByRole("button", { name: "Review invitation before sending" }).click(); await expect(invitations(page)).toContainText("Recorded Matter amount: $400.01"); await expect(invitations(page)).toContainText("Remaining Matter amount for replacement work: $120.00");
  await invitations(page).getByRole("button", { name: "Return to invitation review" }).click();
});
