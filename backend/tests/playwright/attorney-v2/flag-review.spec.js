const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic flagged posting", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Original public description", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-moderation]");
const feedback = page => panel(page).locator("[data-moderation-feedback]");
const check = page => panel(page).getByRole("button", { name: "Check review status", exact: true }).click();
const review = page => panel(page).getByRole("button", { name: "Review my changes", exact: true }).click();
const submit = page => panel(page).getByRole("button", { name: "Request admin review", exact: true }).click();
let admin;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
const read = (page, id) => api(page.request, "get", `/api/cases/${id}/flags/review`);
const requestMessage = "Clarify the public scope before review.\n\nIdentify the missing exhibit references.";
const flag = (id, message = requestMessage) => api(admin, "post", `/api/cases/${id}/flags/request-edits`, { message });
async function edit(page, id, description = "Clarified public scope") {
  const posting = (await api(page.request, "get", `/api/cases/posting/${id}`)).posting;
  return api(page.request, "patch", `/api/cases/posting/${id}`, { changes: { description }, revision: posting.revision });
}
async function matter(page, changed = true) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  await flag(publication.caseId); if (changed) await edit(page, publication.caseId); return publication.caseId;
}
async function open(page, id, current = false) {
  await page.goto(current ? "/dashboard-attorney.html#cases:active" : `/attorney-v2.html#/matters/${id}/manage`, { waitUntil: "domcontentloaded" });
  if (current) { const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first(); await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "Review admin edit request", exact: true }).click(); }
  await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
test.beforeAll(async ({ playwright, baseURL }) => {
  admin = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { "x-ai-control-room-e2e-secret": process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const bootstrap = await admin.post("/api/admin/ai-control-room/dev/e2e/bootstrap-admin", { headers }); expect(bootstrap.ok()).toBeTruthy(); const payload = await bootstrap.json();
  const csrf = await (await admin.get("/api/csrf")).json();
  const login = await admin.post("/api/auth/login", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { email: payload.admin.email, password: process.env.CONTROL_ROOM_E2E_ADMIN_PASSWORD || "ControlRoomHarness123!" } }); expect(login.ok(), await login.text()).toBeTruthy();
});
test.afterAll(async () => admin?.dispose());

test("the Matter action menu opens feedback, editing qualifies it, and review leaves the flag for admin", async ({ page }, info) => {
  const id = await matter(page, false); await page.goto("/attorney-v2.html#/matters", { waitUntil: "domcontentloaded" });
  const row = page.locator(`[data-av2-matter="${id}"]`); await row.getByText("Matter actions", { exact: true }).click(); await row.getByRole("link", { name: "Review admin edit request and history", exact: true }).click();
  await expect(panel(page)).toContainText("Clarify the public scope"); await expect(panel(page).getByRole("button", { name: "Review my changes" })).toBeDisabled();
  expect((await read(page, id)).feedback).toBe(requestMessage);
  await expect(panel(page).locator('.moderation-feedback-text')).toHaveText(requestMessage);
  await panel(page).locator('.moderation-feedback-text').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('admin-feedback-paragraphs.png') });
  await panel(page).getByRole("link", { name: "Review or edit posting" }).click(); await expect(page.getByRole("region", { name: "Posting save status" })).toHaveAttribute("data-state", "ready");
  await page.locator("#av2-posting-description").fill("Changed public scope from the review flow"); await page.getByRole("button", { name: "Review posting changes", exact: true }).click(); await page.getByRole("button", { name: "Save reviewed changes", exact: true }).click();
  await expect(page.getByRole("region", { name: "Posting save status" })).toContainText("Posting changes saved");
  await open(page, id); await review(page); expect((await read(page, id)).status).toBe("flagged"); await submit(page); await expect(feedback(page)).toContainText("request was recorded");
  expect((await read(page, id)).status).toBe("resolution_requested"); await page.reload({ waitUntil: "domcontentloaded" }); await expect(panel(page)).toContainText("awaiting admin review");
  await api(admin, "post", `/api/cases/${id}/flags/resolve`, { note: "Changes accepted" }); await check(page); await expect(panel(page)).toContainText("no active admin edit request");
});

test("a newer admin request invalidates the confirmation and requires another posting edit", async ({ page }) => {
  const id = await matter(page); await open(page, id); await review(page); await flag(id, "NEW_ADMIN_REQUIREMENTS"); await submit(page);
  await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await check(page); await expect(panel(page)).toHaveAttribute("data-state", "conflict"); await expect(panel(page)).toContainText("NEW_ADMIN_REQUIREMENTS");
  await expect(panel(page).getByRole("button", { name: "Review my changes" })).toBeDisabled(); expect((await read(page, id)).status).toBe("flagged");
});

test("lost response recovery survives route navigation without another review submission", async ({ page }) => {
  const id = await matter(page); await open(page, id); let writes = 0;
  await page.route(`**/api/cases/${id}/flags/mark-resolved`, async route => { writes++; await route.fetch(); await route.abort("failed"); });
  await review(page); await submit(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain");
  await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); await page.evaluate(id => { location.hash = `/matters/${id}/manage`; }, id);
  await expect(feedback(page)).toContainText("request was recorded"); expect(writes).toBe(1); expect((await read(page, id)).status).toBe("resolution_requested");
});

test("failed requests require a status check and a fresh confirmation before explicit retry", async ({ page }) => {
  const id = await matter(page); await open(page, id); let writes = 0;
  await page.route(`**/api/cases/${id}/flags/mark-resolved`, route => { writes++; return route.fulfill({ status: 503, contentType: "application/json", body: '{}' }); });
  await review(page); await submit(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await check(page);
  await expect(panel(page).getByRole("button", { name: "Request admin review", exact: true })).toHaveCount(0); expect(writes).toBe(1);
  await page.unroute(`**/api/cases/${id}/flags/mark-resolved`); await review(page); await submit(page); await expect(feedback(page)).toContainText("request was recorded");
});

test("initial read failure blocks submission and a full note gives a recoverable explanation", async ({ page }) => {
  const id = await matter(page);
  await page.route(`**/api/cases/${id}/flags/review?**`, route => route.fulfill({ status: 503, contentType: "application/json", body: '{}' }));
  await page.goto(`/attorney-v2.html#/matters/${id}/manage`, { waitUntil: "domcontentloaded" }); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page).getByRole("button", { name: "Review my changes" })).toBeDisabled();
  await page.unroute(`**/api/cases/${id}/flags/review?**`); await check(page);
  const note = await api(page.request, "get", `/api/cases/${id}/notes`); await api(page.request, "put", `/api/cases/${id}/notes`, { note: "x".repeat(10000), revision: note.revision });
  await review(page); await submit(page); await expect(feedback(page)).toContainText("note has reached its limit"); expect((await read(page, id)).status).toBe("flagged");
});

test("the current dashboard retains an interrupted request across modal reopening and V2 sees its result", async ({ page }) => {
  const id = await matter(page); await open(page, id, true); let writes = 0;
  await page.route(`**/api/cases/${id}/flags/mark-resolved`, async route => { writes++; await route.fetch(); await route.abort("failed"); });
  await review(page); await submit(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click();
  const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first(); await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "Review admin edit request", exact: true }).click();
  await expect(feedback(page)).toContainText("request was recorded"); expect(writes).toBe(1);
  await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click(); await open(page, id); await expect(panel(page)).toContainText("awaiting admin review");
});

test("an account change during a delayed current-dashboard submission clears private admin feedback", async ({ page }) => {
  const id = await matter(page); await flag(id, "PRIVATE_REVIEW_SENTINEL"); await edit(page, id, "Edited after private feedback"); await open(page, id, true);
  let release; const gate = new Promise(resolve => { release = resolve; }); let arrived; const done = new Promise(resolve => { arrived = resolve; });
  await page.route(`**/api/cases/${id}/flags/mark-resolved`, async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await review(page); await submit(page); await done; await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } }))); release();
  await expect(panel(page)).toHaveCount(0); await expect(page.locator("#caseNoteModal")).toBeHidden(); expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain("PRIVATE_REVIEW_SENTINEL");
});

test("a request receipt remains recoverable after the admin already clears the flag", async ({ page }) => {
  const id = await matter(page); await open(page, id);
  await page.route(`**/api/cases/${id}/flags/mark-resolved`, async route => { await route.fetch(); await api(admin, "post", `/api/cases/${id}/flags/resolve`, { note: "Resolved before response arrived" }); await route.abort("failed"); });
  await review(page); await submit(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await check(page); await expect(feedback(page)).toContainText("request was recorded"); await expect(panel(page)).toContainText("no active admin edit request");
});

test("review confirmations are accessible and fit mobile and desktop in both dashboards", async ({ page }, testInfo) => {
  const id = await matter(page);
  for (const current of [false, true]) {
    await open(page, id, current); await review(page);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 900 }); await panel(page).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (current) { const close = await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).boundingBox(); expect(close.y + close.height).toBeLessThanOrEqual(880); }
      const result = await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-moderation]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-flag-review-${width}.png`), fullPage: true });
    }
    await panel(page).getByRole("button", { name: "Keep editing", exact: true }).click();
    if (current) await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click();
  }
});
