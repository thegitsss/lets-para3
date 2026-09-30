const { test, expect } = require("../support-session-fixture");
const { enterSecondaryDocument } = require("../secondary-document-entry");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic archive Matter", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic archive and restore verification", tasks: [{ title: "Prepare agreement" }] };
const panel = page => page.locator("[data-matter-archive]");
const feedback = page => panel(page).locator("[data-archive-feedback]");
const check = page => panel(page).getByRole("button", { name: "Check archive status", exact: true }).click();
const review = page => panel(page).getByRole("button", { name: "Review archive change", exact: true }).click();
const confirm = (page, name = "Archive Matter") => panel(page).getByRole("button", { name, exact: true }).click();
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
const read = (page, id) => api(page.request, "get", `/api/cases/${id}/archive`);
async function change(page, id) { const value = await read(page, id); return api(page.request, "patch", `/api/cases/${id}/archive`, { revision: value.revision, archived: value.targetArchived, requestId: require("crypto").randomUUID() }); }
async function matter(page) {
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  return (await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" })).publication.caseId;
}
async function currentOpen(page, id, action = "Archive Matter") {
  const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first(); await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: action, exact: true }).click();
}
async function open(page, id, current = false, ready = true) {
  await page.goto(current ? "/dashboard-attorney.html#cases:active" : `/attorney-v2.html#/matters/${id}/archive`, { waitUntil: "domcontentloaded" });
  if (current) await currentOpen(page, id);
  if (ready) await expect(panel(page)).toHaveAttribute("data-state", "ready");
}
const close = page => page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click();
const readPattern = id => `**/api/cases/${id}/archive?**`;
const writePattern = id => `**/api/cases/${id}/archive`;
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

test("the existing admin Archive post action confirms the reviewed request and can check a lost response without repeating it", async ({ page, browser, baseURL }) => {
  const ids = [await matter(page), await matter(page)], context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { "x-ai-control-room-e2e-secret": process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
    const bootstrap = await context.request.post("/api/admin/ai-control-room/dev/e2e/bootstrap-admin", { headers }); expect(bootstrap.ok()).toBeTruthy(); const payload = await bootstrap.json();
    const admin = await context.newPage();
    await enterSecondaryDocument(admin, new URL("/login.html", baseURL).href);
    await expect(admin.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await admin.locator("#email").fill(payload.admin.email); await admin.locator("#password").fill(process.env.CONTROL_ROOM_E2E_ADMIN_PASSWORD || "ControlRoomHarness123!");
    await admin.locator("#loginForm button[type='submit']").click(); await expect(admin).toHaveURL(/admin-dashboard\.html/);
    await admin.getByText("System & tools", { exact: true }).click();
    await admin.getByRole("button", { name: "Posting moderation", exact: true }).click();
    const writes = []; admin.on("request", request => { if (request.method() === "PATCH" && ids.some(id => request.url().endsWith(`/api/cases/${id}/archive`))) writes.push(request.postDataJSON()); });
    const action = async id => { const row = admin.locator(`#postsList tr[data-case-id="${id}"]`); await row.getByRole("button", { name: "Actions ▾", exact: true }).click(); await row.getByRole("button", { name: "Archive", exact: true }).click(); };
    await action(ids[0]); const dialog = admin.getByRole("dialog", { name: "Archive this post?", exact: true }); await expect(dialog).toContainText(fields.title); await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); expect(writes).toHaveLength(0);
    await action(ids[0]); await dialog.getByRole("button", { name: "Archive post", exact: true }).click(); await expect(admin.getByText("Post archived.", { exact: true })).toBeVisible(); expect((await read(page, ids[0])).archived).toBe(true);
    await admin.route(writePattern(ids[1]), async route => { await route.fetch(); await route.abort("failed"); });
    await action(ids[1]); await dialog.getByRole("button", { name: "Archive post", exact: true }).click(); await expect(admin.getByText("The archive result was not confirmed.", { exact: false })).toBeVisible();
    await admin.unroute(writePattern(ids[1])); await action(ids[1]); await expect(admin.getByText("This post is already archived.", { exact: true })).toBeVisible();
    expect(writes).toHaveLength(2); expect(writes.every(write => write.expectedOwnerId && write.revision && write.requestId && write.archived === true && !Object.hasOwn(write, "status"))).toBe(true);
  } finally { await context.close(); }
});

test("current archive and V2 restore each require confirmation and only write the reviewed archive operation", async ({ page }) => {
  const id = await matter(page), writes = [];
  page.on("request", req => { if (req.method() === "PATCH" && req.url().includes(`/api/cases/${id}`)) writes.push({ url: new URL(req.url()).pathname, body: req.postDataJSON() }); });
  await open(page, id, true); expect(writes).toEqual([]); await review(page); await panel(page).getByRole("button", { name: "Cancel", exact: true }).click(); expect((await read(page, id)).archived).toBe(false);
  await review(page); await confirm(page); await expect(feedback(page)).toContainText("change was recorded"); await expect(panel(page)).toContainText("Lifecycle status: Open"); await close(page);
  await page.goto(`/attorney-v2.html#/matters?view=archived&highlightCase=${id}`, { waitUntil: "domcontentloaded" });
  const row = page.locator(`[data-av2-matter="${id}"]`); await row.getByText("Matter actions", { exact: true }).click(); await row.getByRole("link", { name: "Archive and restore", exact: true }).click();
  await expect(panel(page)).toContainText("manually archived"); await review(page); await confirm(page, "Restore Matter"); await expect(feedback(page)).toContainText("change was recorded");
  await panel(page).getByRole("link", { name: "View current Matter list", exact: true }).click(); await expect(page.locator(`[data-av2-matter="${id}"]`)).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes.map(write => write.url)).toEqual([`/api/cases/${id}/archive`, `/api/cases/${id}/archive`]); expect(writes.map(write => write.body.archived)).toEqual([true, false]); expect(writes.every(write => !Object.hasOwn(write.body, "status") && write.body.requestId && write.body.revision && write.body.expectedOwnerId)).toBe(true);
  expect((await read(page, id)).status).toBe("open"); await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.locator(`[data-av2-matter="${id}"]`)).toBeVisible();
});

test("lost acknowledgements recover the exact request after navigation or modal reopening with no automatic retry", async ({ page }) => {
  for (const current of [false, true]) {
    const id = await matter(page); await open(page, id, current); let writes = 0;
    await page.route(writePattern(id), async route => { writes++; await route.fetch(); await route.abort("failed"); });
    await review(page); await confirm(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain");
    // An unconfirmed response does not move the current dashboard's cached row.
    // Reopening that row must recover the receipt before refreshing the lists.
    if (current) { await close(page); await currentOpen(page, id); }
    else { await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); await page.evaluate(id => { location.hash = `#/matters/${id}/archive`; }, id); }
    await expect(feedback(page)).toContainText("change was recorded"); await expect(panel(page)).toContainText("has been manually archived"); expect(writes).toBe(1); await page.unroute(writePattern(id));
  }
});

test("a failed request with no saved receipt requires a new review and never claims success", async ({ page }) => {
  const id = await matter(page); await open(page, id); let writes = 0;
  await page.route(writePattern(id), route => { writes++; return fulfill(route, {}, 503); });
  await review(page); await confirm(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await check(page);
  await expect(feedback(page)).toContainText("earlier request could not be confirmed"); await expect(panel(page).getByRole("button", { name: "Archive Matter", exact: true })).toHaveCount(0); expect(writes).toBe(1); expect((await read(page, id)).archived).toBe(false);
  await page.unroute(writePattern(id)); await review(page); await confirm(page); await expect(feedback(page)).toContainText("change was recorded");
});

test("another tab's archive invalidates the original confirmation without silently reversing it", async ({ page }) => {
  const id = await matter(page); await open(page, id); await review(page); await change(page, id); await confirm(page);
  await expect(panel(page)).toHaveAttribute("data-state", "uncertain"); await check(page); await expect(feedback(page)).toContainText("review it before choosing another change");
  await expect(panel(page).getByRole("button", { name: "Restore Matter", exact: true })).toHaveCount(0); expect((await read(page, id)).archived).toBe(true); await review(page); await confirm(page, "Restore Matter"); await expect(feedback(page)).toContainText("change was recorded");
});

test("initial failures and malformed projections disable archive controls, and a later read can recover", async ({ page }) => {
  const id = await matter(page), value = await read(page, id); let body = {}, status = 503;
  await page.route(readPattern(id), route => fulfill(route, body, status)); await open(page, id, false, false);
  await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page).getByRole("button", { name: "Review archive change", exact: true })).toBeDisabled();
  status = 200;
  for (const invalid of [{ ...value, caseId: "0".repeat(24) }, { ...value, targetArchived: false }, { ...value, receipt: { requestId: "bad" } }]) { body = invalid; await check(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); }
  body = value; await check(page); await expect(panel(page)).toHaveAttribute("data-state", "ready");
});

test("paused and legacy restore copy is explicit, and restricted states never enable a confirmation", async ({ page }) => {
  const id = await matter(page), value = await read(page, id); let body = value;
  await page.route(readPattern(id), route => fulfill(route, body)); await open(page, id);
  for (const reason of ["retention", "final", "unsupported", "assigned", "processing", "history"]) { body = { ...value, canChange: false, reason }; await check(page); await expect(panel(page).getByRole("button", { name: "Review archive change", exact: true })).toBeDisabled(); }
  body = { ...value, archived: true, targetArchived: false, status: "paused", restoredView: "archived", readOnly: true }; await check(page); await expect(panel(page)).toContainText("paused status and read-only restrictions"); await review(page); await expect(panel(page).getByRole("button", { name: "Remove manual archive", exact: true })).toBeVisible(); await panel(page).getByRole("button", { name: "Cancel", exact: true }).click();
  body = { ...body, status: "draft", legacyReopen: false, restoredView: "draft" }; await check(page); await review(page); await expect(panel(page).getByRole("button", { name: "Restore draft", exact: true })).toBeVisible(); await expect(panel(page)).toContainText("stay private"); expect((await read(page, id)).archived).toBe(false);
});

for (const current of [false, true]) test(`${current ? "current" : "V2"} account changes during a delayed mutation clear the dashboard and never restore late private content`, async ({ page }) => {
    const id = await matter(page); await open(page, id, current); let release, arrived;
    const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
    await page.route(writePattern(id), async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
    await review(page); await confirm(page); await waiting;
    if (current) await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } })));
    else {
      await page.route("**/api/auth/me", route => fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } }));
      await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" })));
      await expect(page).toHaveURL(/dashboard-attorney\.html/);
    }
    release();
    await expect(panel(page)).toHaveCount(0); if (current) await expect(page.locator("#caseNoteModal")).toBeHidden();
    await page.unroute(writePattern(id)); await page.unroute("**/api/auth/me");
});

test("navigation cancels slow reads and access loss removes the saved review", async ({ page }) => {
  const id = await matter(page), value = await read(page, id); value.caseTitle = "PRIVATE_DELAYED_ARCHIVE"; let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(readPattern(id), async route => { arrived(); await gate; await fulfill(route, value).catch(() => {}); }); await open(page, id, false, false); await waiting;
  await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); release(); await expect(panel(page)).toHaveCount(0); await expect(page.locator("body")).not.toContainText("PRIVATE_DELAYED_ARCHIVE");
  await page.unroute(readPattern(id)); await open(page, id); await review(page); await page.route(readPattern(id), route => fulfill(route, {}, 404)); await check(page);
  await expect(panel(page)).toHaveAttribute("data-state", "restricted"); await expect(panel(page)).not.toContainText(fields.title); await expect(panel(page).getByRole("button", { name: "Archive Matter", exact: true })).toHaveCount(0);
});

test("archive confirmations fit mobile and desktop, pass accessibility checks and remain keyboard operable", async ({ page }, testInfo) => {
  const id = await matter(page);
  for (const current of [false, true]) {
    await open(page, id, current); await review(page);
    for (const width of [390, 1366]) {
      await page.setViewportSize({ width, height: 900 }); await panel(page).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (current) { const box = await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).boundingBox(); expect(box.y + box.height).toBeLessThanOrEqual(880); }
      const action = panel(page).getByRole("button", { name: "Archive Matter", exact: true }); await action.scrollIntoViewIfNeeded();
      const actionBox = await action.boundingBox(); expect(actionBox.y).toBeGreaterThanOrEqual(0); expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(900);
      if (current) { const closeBox = await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).boundingBox(); expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(closeBox.y); }
      const result = await new AxeBuilder({ page }).include(current ? "#caseNoteModal" : "[data-matter-archive]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-archive-${width}.png`), fullPage: true });
    }
    await panel(page).getByRole("button", { name: "Cancel", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(panel(page).getByRole("button", { name: "Archive Matter", exact: true })).toHaveCount(0);
    if (current) { await page.keyboard.press("Escape"); await expect(page.locator("#caseNoteModal")).toBeHidden(); }
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain(fields.title);
  }
});
