const { test, expect } = require("../support-session-fixture");
const { enterSecondaryDocument } = require("../secondary-document-entry");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic note management", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic notes browser fixture.", tasks: [{ title: "Prepare agreement" }] };
const panel = (page) => page.getByRole("region", { name: "Matter notes", exact: true });
const input = (page) => panel(page).getByRole("textbox", { name: /^(Matter notes|Notes)$/ });
const feedback = (page) => panel(page).locator("[data-note-feedback]");
async function api(page, method, path, data) {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  const result = await page.request[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(result.ok(), `${method} ${path}: ${await result.text()}`).toBeTruthy(); return result.json();
}
async function matter(page, note = "Original\n\nSaved note") {
  const draft = (await api(page, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  const saved = await read(page, publication.caseId); await api(page, "put", `/api/cases/${publication.caseId}/notes`, { note, revision: saved.revision }); return publication.caseId;
}
const read = (page, id) => api(page, "get", `/api/cases/${id}/notes`);
async function open(page, id, current = false, secondaryBaseURL) {
  const target = current ? "/dashboard-attorney.html#cases:active" : `/attorney-v2.html#/matters/${id}/manage`;
  if (secondaryBaseURL) await enterSecondaryDocument(page, new URL(target, secondaryBaseURL).href);
  else await page.goto(target, { waitUntil: "domcontentloaded" });
  if (current) {
    const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first();
    await actions.locator("[data-case-menu-trigger]").click();
    await actions.getByRole("button", { name: "Edit Matter note", exact: true }).click();
  }
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(input(page)).toBeEnabled();
}
const save = (page) => panel(page).getByRole("button", { name: "Save Matter note", exact: true }).click();
const check = (page) => panel(page).getByRole("button", { name: "Check saved note", exact: true }).click();

test("Matter actions open private notes and history with exact saved paragraphs", async ({ page }) => {
  const id = await matter(page); await page.goto(`/attorney-v2.html#/matters?previewCaseId=${id}`);
  const row = page.locator(`[data-av2-matter="${id}"]`);
  await row.getByText("Matter actions", { exact: true }).click();
  await row.getByRole("link", { name: "Notes and status history", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(input(page)).toHaveValue("Original\n\nSaved note");
  await expect(page.getByRole("heading", { name: "Synthetic note management", exact: true })).toBeVisible();
  await input(page).fill("  First paragraph.\n\nSecond paragraph.  "); await save(page); await expect(feedback(page)).toHaveText("Matter note saved.");
  expect((await read(page, id)).note).toBe("  First paragraph.\n\nSecond paragraph.  ");
  await page.reload(); await expect(input(page)).toHaveValue("  First paragraph.\n\nSecond paragraph.  ");
});

test("two tabs review a conflicting note without losing either version", async ({ page, context, baseURL }) => {
  const id = await matter(page); await open(page, id); await input(page).fill("My first-tab edit");
  const other = await context.newPage(); await open(other, id, false, baseURL); await input(other).fill("Other tab saved note"); await save(other); await expect(feedback(other)).toHaveText("Matter note saved.");
  await page.bringToFront(); await check(page); await expect(panel(page)).toHaveAttribute("data-state", "conflict");
  await expect(input(page)).toHaveValue("My first-tab edit"); await expect(panel(page).locator("pre")).toHaveText("Other tab saved note");
  await panel(page).getByRole("button", { name: "Keep my edits for review", exact: true }).click();
  expect((await read(page, id)).note).toBe("Other tab saved note"); await save(page); await expect(feedback(page)).toHaveText("Matter note saved."); expect((await read(page, id)).note).toBe("My first-tab edit");
});

test("lost save responses retain later typing and never retry automatically", async ({ page }) => {
  const id = await matter(page); await open(page, id); let writes = 0;
  await page.route(`**/api/cases/${id}/notes`, async (route) => { if (route.request().method() !== "PUT") return route.continue(); writes++; await route.fetch(); await route.abort("failed"); });
  await input(page).fill("Submitted note"); await save(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain");
  await input(page).fill("Later typing retained"); await check(page); await expect(feedback(page)).toContainText("submitted note is saved"); await expect(input(page)).toHaveValue("Later typing retained"); expect(writes).toBe(1);
  await page.unroute(`**/api/cases/${id}/notes`); await save(page); await expect(feedback(page)).toHaveText("Matter note saved.");
});

test("an undo during a delayed save survives route navigation and recovery", async ({ page }) => {
  const id = await matter(page, "Original"); await open(page, id);
  let release; const gate = new Promise((resolve) => { release = resolve; }); let committed; const done = new Promise((resolve) => { committed = resolve; });
  await page.route(`**/api/cases/${id}/notes`, async (route) => { if (route.request().method() !== "PUT") return route.continue(); const response = await route.fetch(); committed(); await gate; await route.fulfill({ response }).catch(() => {}); });
  await input(page).fill("Submitted"); await save(page); await done; await input(page).fill("Original");
  await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); release();
  await page.evaluate((id) => { location.hash = `/matters/${id}/manage`; }, id);
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(input(page)).toHaveValue("Original");
  expect((await read(page, id)).note).toBe("Submitted"); await expect(panel(page).getByRole("button", { name: "Save Matter note", exact: true })).toBeEnabled();
});

test("initial read failures cannot enable an empty overwrite and history fails independently", async ({ page }) => {
  const id = await matter(page);
  await page.route(`**/api/cases/${id}/notes`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"synthetic unavailable"}' }));
  await page.goto(`/attorney-v2.html#/matters/${id}/manage`); await expect(panel(page)).toHaveAttribute("data-state", "error");
  await expect(input(page)).toBeDisabled(); await expect(panel(page).getByRole("button", { name: "Save Matter note", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Status history", exact: true })).toHaveAttribute("data-state", "ready");
  await page.unroute(`**/api/cases/${id}/notes`); await check(page); await expect(input(page)).toHaveValue("Original\n\nSaved note");
  await page.route(`**/api/cases/${id}/status-history`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{}' }));
  await page.getByRole("button", { name: "Refresh status history", exact: true }).click(); await expect(page.getByRole("region", { name: "Status history", exact: true })).toHaveAttribute("data-state", "error"); await expect(input(page)).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Synthetic note management", exact: true })).toBeVisible();
});

test("an offline save can be checked before an explicit retry", async ({ page, context }) => {
  const id = await matter(page); await open(page, id); await input(page).fill("Offline retained text");
  await context.setOffline(true); await save(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain");
  await expect(input(page)).toHaveValue("Offline retained text"); await context.setOffline(false); await check(page);
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await save(page); await expect(feedback(page)).toHaveText("Matter note saved.");
});

test("empty saves require confirmation and oversize edits remain recoverable", async ({ page }) => {
  const id = await matter(page); await open(page, id); await input(page).fill("x".repeat(10001));
  await expect(panel(page)).toContainText("exceeds the save limit"); await expect(panel(page).getByRole("button", { name: "Save Matter note", exact: true })).toBeDisabled();
  await input(page).fill(""); await save(page); await expect(panel(page).getByRole("heading", { name: "Save an empty note?" })).toBeVisible(); expect((await read(page, id)).note).toBe("Original\n\nSaved note");
  await panel(page).getByRole("button", { name: "Confirm empty note", exact: true }).click(); await expect(feedback(page)).toHaveText("Matter note saved."); expect((await read(page, id)).note).toBe("");
});

test("Matter access loss clears private text and a mismatched response cannot replace it", async ({ page }) => {
  const id = await matter(page); await open(page, id); await input(page).fill("PRIVATE_ACCESS_SENTINEL");
  await page.route(`**/api/cases/${id}/notes`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ caseId: "0".repeat(24), note: "WRONG_MATTER", revision: "a".repeat(64) }) }));
  await check(page); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(input(page)).toHaveValue("PRIVATE_ACCESS_SENTINEL");
  await page.unroute(`**/api/cases/${id}/notes`); await page.route(`**/api/cases/${id}/notes`, (route) => route.fulfill({ status: 403, contentType: "application/json", body: '{}' }));
  await check(page); await expect(panel(page)).toHaveAttribute("data-state", "restricted"); await expect(input(page)).toHaveValue(""); await expect(input(page)).toBeDisabled();
});

test("the current dashboard uses the same revision and conflict review as V2", async ({ page, context, baseURL }, testInfo) => {
  const id = await matter(page); await open(page, id, true); await input(page).fill("Current dashboard edit");
  const other = await context.newPage(); await open(other, id, false, baseURL); await input(other).fill("V2 saved change"); await save(other); await expect(feedback(other)).toHaveText("Matter note saved.");
  await page.bringToFront(); await check(page); await expect(panel(page)).toHaveAttribute("data-state", "conflict"); await expect(input(page)).toHaveValue("Current dashboard edit");
  await panel(page).getByRole("button", { name: "Keep my edits for review", exact: true }).click(); await save(page); await expect(feedback(page)).toHaveText("Matter note saved."); expect((await read(page, id)).note).toBe("Current dashboard edit");
  if (testInfo.project.name === "chromium") for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await page.locator("#caseNoteModal .note-modal-card").boundingBox(); expect(bounds.width).toBeLessThanOrEqual(width);
    const close = await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).boundingBox(); expect(close.y + close.height).toBeLessThanOrEqual(890);
    const accessibility = await new AxeBuilder({ page }).include("#caseNoteModal").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(accessibility.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`current-matter-notes-${width}.png`), fullPage: true });
  }
  await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click(); await expect(panel(page)).toHaveCount(0);
});

test("current dashboard clears notes on account change", async ({ page }) => {
  const id = await matter(page); await open(page, id, true); await input(page).fill("PRIVATE_CURRENT_SENTINEL");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lpc:user-updated", { detail: { id: "0".repeat(24), role: "attorney" } })));
  await expect(page.locator("#caseNoteModal")).toBeHidden(); await expect(panel(page)).toHaveCount(0);
  expect(await page.evaluate(() => [...document.querySelectorAll("textarea")].some((el) => el.value.includes("PRIVATE_CURRENT_SENTINEL")))).toBe(false);
});

test("notes and partial history remain accessible on mobile and desktop", async ({ page }, testInfo) => {
  const id = await matter(page); await page.route(`**/api/cases/${id}/status-history`, async (route) => { const response = await route.fetch(), body = await response.json(); await route.fulfill({ response, json: { ...body, complete: false } }); });
  await open(page, id); await expect(page.getByRole("region", { name: "Status history", exact: true })).toContainText("Some history could not be loaded. Refresh to try again.");
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 900 }); await panel(page).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const result = await new AxeBuilder({ page }).include("[data-matter-notes]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze(); expect(result.violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`matter-notes-${width}.png`), fullPage: true });
  }
});


test("current dashboard retains a failed save after closing and reopening its note", async ({ page }) => {
  const id = await matter(page); await open(page, id, true); await input(page).fill("Current retained draft");
  await page.route(`**/api/cases/${id}/notes`, (route) => route.request().method() === "PUT" ? route.fulfill({ status: 503, contentType: "application/json", body: '{}' }) : route.continue());
  await save(page); await expect(panel(page)).toHaveAttribute("data-state", "uncertain");
  await page.locator("#caseNoteModal").getByRole("button", { name: "Close", exact: true }).click();
  const actions = page.locator(`.case-actions[data-case-id="${id}"]:visible`).first(); await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "Edit Matter note", exact: true }).click();
  await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(input(page)).toHaveValue("Current retained draft");
  await page.unroute(`**/api/cases/${id}/notes`); await save(page); await expect(feedback(page)).toHaveText("Matter note saved.");
});

test("V2 clears a note when the server reports an account change during a save", async ({ page }) => {
  const id = await matter(page); await open(page, id); await input(page).fill("PRIVATE_V2_SENTINEL");
  await page.route(`**/api/cases/${id}/notes`, (route) => route.request().method() === "PUT" ? route.fulfill({ status: 403, contentType: "application/json", body: '{"code":"NOTE_ACCOUNT_CHANGED"}' }) : route.continue());
  await save(page); await expect(panel(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/login\.html$/);
  await page.waitForLoadState('domcontentloaded');
  expect(await page.evaluate(() => [...document.querySelectorAll("textarea")].some((el) => el.value.includes("PRIVATE_V2_SENTINEL")))).toBe(false);
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join(" "))).not.toContain("PRIVATE_V2_SENTINEL");
});
