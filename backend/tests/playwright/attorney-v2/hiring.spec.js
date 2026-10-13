const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const panel = page => page.locator("[data-hiring]");
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function application(page) {
  const fields = { title: "Synthetic card setup return", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic payment return verification", tasks: [{ title: "Prepare agreement" }] };
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  await api(page.request, "post", `/api/cases/${publication.caseId}/invite/${paraId}`, {}); await api(para, "post", `/api/cases/${publication.caseId}/invite/accept`, {}); return publication.caseId;
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



async function fixture(page, { mode = "hire_and_fund", lost = false, reason = "ready" } = {}) {
  const id = await application(page), user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const state = { writes: 0, assigned: false, changed: false };
  const value = () => ({ ownerId, caseId: id, applicantId: paraId, caseTitle: "Synthetic card setup return", name: "Synthetic selected paralegal", revision: (state.assigned ? "e" : state.changed ? "f" : "d").repeat(64), reason: state.assigned ? "assigned" : mode === "finish_hire" ? "reconciliation" : reason, canHire: !state.assigned && mode !== "finish_hire" && reason === "ready", canResume: !state.assigned && mode === "finish_hire", relisted: mode === "replacement", assigned: state.assigned, fundingVerified: state.assigned || mode !== "hire_and_fund", budgetCents: 40001, feeCents: mode === "replacement" ? 0 : 8800, chargeCents: mode === "replacement" ? 0 : 48801, remainingCents: mode === "replacement" ? 12000 : null, currency: "usd", card: !state.assigned && mode === "hire_and_fund" && reason === "ready" ? { id: "pm_synthetic", type: "card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 } : null });
  await page.route(`**/api/cases/${id}/hiring-review/${paraId}?**`, route => fulfill(route, value()));
  await page.route(`**/api/cases/${id}/application-inventory?**`, async route => { const response = await route.fetch(), body = await response.json(); if (state.assigned) { body.caseStatus = "in progress"; body.applications.forEach(item => { item.status = item.applicantId === paraId ? "accepted" : "rejected"; item.assigned = item.applicantId === paraId; }); Object.keys(body.counts).forEach(key => { body.counts[key] = body.applications.filter(item => item.status === key).length; }); } await fulfill(route, body); });
  await page.route(`**/api/cases/${id}/hire/${paraId}`, async route => {
    state.writes++; const body = route.request().postDataJSON(); expect(body.expectedOwnerId).toBe(ownerId);
    if (body.reviewedRevision !== value().revision) return fulfill(route, { code: "HIRING_CHANGED" }, 409);
    const reviewed = value(); state.assigned = true;
    if (lost) return route.abort("failed");
    return fulfill(route, { hiringConfirmation: { caseId: id, applicantId: paraId, reviewedRevision: reviewed.revision, mode, chargeCents: mode === "finish_hire" ? 0 : reviewed.chargeCents, budgetCents: 40001, remainingCents: reviewed.remainingCents } });
  });
  await page.goto(`/attorney-v2.html#/matters/${id}/applications?applicantId=${paraId}`); await expect(panel(page)).toBeVisible(); return { state, id, value };
}
async function review(page) { await panel(page).getByRole("button", { name: /^(Review hiring and funding|Refresh hiring review|Check saved hiring details)$/ }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); }
async function confirm(page) { await panel(page).getByRole("button", { name: "Review hiring confirmation", exact: true }).click(); }

test("the attorney reviews the exact applicant, card, fee and charge before submitting one hire", async ({ page }) => {
  const { state } = await fixture(page); await review(page); await expect(panel(page)).toContainText("Total card charge: $488.01"); await expect(panel(page)).toContainText("Attorney platform fee: $88.00"); await expect(panel(page)).toContainText("visa ending in 4242"); await confirm(page); await expect(panel(page)).toContainText("Other applicants will not be selected"); expect(state.writes).toBe(0);
  await panel(page).getByRole("button", { name: "Hire and charge $488.01", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("This paralegal is assigned, and the Matter's funding is verified."); expect(state.writes).toBe(1);
});
test("canceling the confirmation performs no hire or charge request", async ({ page }) => {
  const { state } = await fixture(page); await review(page); await confirm(page); await panel(page).getByRole("button", { name: "Return to hiring review", exact: true }).click(); await expect(panel(page).getByRole("button", { name: "Hire and charge $488.01", exact: true })).toHaveCount(0); expect(state.writes).toBe(0);
});
test("a changed review cannot be submitted as a current hiring charge", async ({ page }) => {
  const { state } = await fixture(page); await review(page); await confirm(page); state.changed = true; await panel(page).getByRole("button", { name: "Hire and charge $488.01", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await review(page); expect(state.assigned).toBe(false); expect(state.writes).toBe(1);
});
test("a lost hire response recovers the current assignment without resending", async ({ page }) => {
  const { state } = await fixture(page, { lost: true }); await review(page); await confirm(page); await panel(page).getByRole("button", { name: "Hire and charge $488.01", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await page.getByRole("link", { name: "Home", exact: true }).click(); await page.goBack(); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await review(page); await expect(panel(page)).toContainText("current hiring and funding records"); await expect(panel(page)).toContainText("This paralegal is assigned"); expect(state.writes).toBe(1);
});
test("verified earlier funding requires an explicit finish-hire confirmation with no new charge", async ({ page }) => {
  const { state } = await fixture(page, { mode: "finish_hire" }); await review(page); await expect(panel(page)).toContainText("Earlier charge verified: $488.01"); await panel(page).getByRole("button", { name: "Review recorded charge and hire", exact: true }).click(); await expect(panel(page)).toContainText("No new card charge will be made."); await panel(page).getByRole("button", { name: "Finish hire using recorded charge", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); expect(state.writes).toBe(1);
});
test("replacement confirmation names the remaining funding and does not show a new card charge", async ({ page }) => {
  const { state } = await fixture(page, { mode: "replacement" }); await review(page); await confirm(page); await expect(panel(page)).toContainText("Remaining amount for replacement work: $120.00"); await expect(panel(page)).toContainText("No new card charge."); await expect(panel(page).getByRole("button", { name: "Hire and charge $488.01", exact: true })).toHaveCount(0); await panel(page).getByRole("button", { name: "Hire replacement paralegal", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); expect(state.writes).toBe(1);
});
test("unverified funding and missing cards prevent a hiring confirmation", async ({ page }) => {
  const { state, value, id } = await fixture(page, { reason: "reconciliation" }); await review(page); await expect(panel(page).getByRole("button", { name: "Review hiring confirmation", exact: true })).toHaveCount(0); await expect(panel(page)).toContainText("Funding needs review");
  await page.route(`**/api/cases/${id}/hiring-review/${paraId}?**`, route => fulfill(route, { ...value(), reason: "card_required", canHire: false, canResume: false })); await review(page); await expect(panel(page)).toContainText("Save a payment card"); expect(state.writes).toBe(0);
});
test("account replacement erases a pending confirmation and ignores its late response", async ({ page }) => {
  const { id } = await fixture(page); let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }); await page.route(`**/api/cases/${id}/hire/${paraId}`, async route => { arrived(); await gate; await fulfill(route, {}).catch(() => {}); });
  await review(page); await confirm(page); await panel(page).getByRole("button", { name: "Hire and charge $488.01", exact: true }).click();
  try { await waiting; await page.route("**/api/auth/me", route => fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(panel(page)).toHaveCount(0); } finally { release(); } await expect(panel(page)).toHaveCount(0);
});
test("hiring confirmation keeps amounts, keyboard focus and touch controls readable at narrow and wide widths", async ({ page }, testInfo) => {
  await fixture(page); await review(page); await confirm(page);
  await expect(panel(page).getByText("Total card charge: $488.01", { exact: true })).toHaveCount(1);
  await expect(panel(page).getByText("Attorney platform fee: $88.00", { exact: true })).toHaveCount(1);
  for (const width of [320, 1366]) { await page.setViewportSize({ width, height: 900 }); const control = panel(page).getByRole("button", { name: "Hire and charge $488.01", exact: true }); await control.scrollIntoViewIfNeeded(); await control.focus(); await expect(control).toBeFocused(); expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect((await new AxeBuilder({ page }).include("[data-hiring]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await page.screenshot({ path: testInfo.outputPath(`hiring-${width}.png`), fullPage: true }); }
});

test("an earlier withdrawal blocker is readable once and links to this Matter's Help", async ({ page }, testInfo) => {
  const { state, id } = await fixture(page, { mode: "replacement", reason: "withdrawal_review_required" }); await review(page);
  const explanation = panel(page).getByText("The earlier withdrawal or payout needs review before you can hire a replacement.", { exact: true });
  await expect(explanation).toHaveCount(1);
  await expect(panel(page).getByRole("button", { name: "Review hiring confirmation", exact: true })).toHaveCount(0);
  const help = panel(page).getByRole("link", { name: "Help with this Matter", exact: true });
  await expect(help).toHaveAttribute("href", `#/help?caseId=${id}`);
  for (const { width, dark, large } of [{ width: 1366, dark: false, large: false }, { width: 390, dark: true, large: false }, { width: 320, dark: false, large: true }]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(({ dark, large }) => { document.documentElement.classList.toggle("theme-dark", dark); document.documentElement.style.fontSize = large ? "125%" : "100%"; }, { dark, large });
    await help.scrollIntoViewIfNeeded(); await help.focus(); await expect(help).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include("[data-hiring]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    const name = `withdrawal-blocker-${width}${dark ? "-dark" : ""}${large ? "-large" : ""}`;
    await panel(page).getByRole("heading", { name: "Hiring and funding", exact: true }).evaluate(el => el.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: testInfo.outputPath(`${name}-top.png`) });
    await help.evaluate(el => el.scrollIntoView({ block: "center" })); await help.focus();
    expect(await help.evaluate(el => { const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${name}-action.png`) });
  }
  expect(state.writes).toBe(0);
});
