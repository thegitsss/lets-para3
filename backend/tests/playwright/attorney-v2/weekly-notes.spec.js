const { test, expect } = require("../support-session-fixture");
const { enterSecondaryDocument } = require("../secondary-document-entry");
const AxeBuilder = require("@axe-core/playwright").default;
const { SUPPORTED_VIEWPORTS } = require("../../../playwright.browser-matrix");
const entry = "/attorney-v2.html";
const weekly = (page) => page.locator('[data-av2-region="weekly-notes"]');
const ready = (page) => expect(weekly(page)).toHaveAttribute("data-state", "ready");
const note = (page, date) => page.locator(`[data-av2-note-day="${date}"]`);
const read = async (page, key) => { const res = await page.request.get(`/api/users/me/weekly-notes?weekStart=${key}`); expect(res.status()).toBe(200); const body = await res.json(); expect(body.weekStart).toBe(key); return body; };
async function write(page, key, notes) {
  const snapshot = await read(page, key); const csrf = await (await page.request.get("/api/csrf")).json();
  const res = await page.request.put("/api/users/me/weekly-notes", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { weekStart: key, notes, revision: snapshot.revision } });
  expect(res.status()).toBe(200); return res.json();
}
function currentWeek() { const date = new Date(); date.setDate(date.getDate() - (date.getDay() + 6) % 7); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

test("real weekly save, month preview, date focus and unsaved recovery work across year boundaries", async ({ page }, info) => {
  const key = "2027-12-27";
  await write(page, key, Array(7).fill(""));
  await enterSecondaryDocument(page, new URL(`${entry}#/tasks?week=${key}`, test.info().project.use.baseURL).href); await ready(page);
  await note(page, "2028-01-02").fill("Synthetic Sunday across the year\n\nRetain the exhibit references.");
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
  await expect(weekly(page)).toContainText("Weekly notes saved.");
  await note(page, key).fill("Unsaved Monday calendar draft");
  await page.getByRole("link", { name: "Month view", exact: true }).click();
  const month = page.getByRole("region", { name: "Monthly private notes", exact: true });
  await expect(month).toHaveAttribute("data-state", "ready");
  await expect(month.locator(`[data-note-date="${key}"]`)).toHaveAccessibleName(/week has unsaved edits/);
  await page.getByRole("link", { name: "Next month", exact: true }).click();
  await expect(month).toHaveAttribute("data-state", "ready");
  await expect(month).toContainText("January 2028");
  await month.locator('[data-note-date="2028-01-02"]').click();
  await ready(page); await expect(note(page, "2028-01-02")).toBeFocused();
  await expect(note(page, key)).toHaveValue("Unsaved Monday calendar draft");
  await expect(note(page, "2028-01-02")).toHaveValue("Synthetic Sunday across the year\n\nRetain the exhibit references.");
  expect((await read(page, key)).notes[0]).toBe("");
  expect((await read(page, key)).notes[6]).toBe("Synthetic Sunday across the year\n\nRetain the exhibit references.");
  await note(page, "2028-01-02").scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('weekly-note-paragraphs.png') });
});

test("two V2 tabs saving after the same preflight cannot silently overwrite each other", async ({ page, context, baseURL }) => {
  const key = "2027-01-04"; await write(page, key, Array(7).fill(""));
  const other = await context.newPage();
  await enterSecondaryDocument(page, new URL(`${entry}#/tasks?week=${key}`, baseURL).href); await enterSecondaryDocument(other, new URL(`${entry}#/tasks?week=${key}`, baseURL).href); await ready(page); await ready(other);
  await note(page, key).fill("First tab draft"); await note(other, key).fill("Second tab draft");
  let release; const gate = new Promise((resolve) => { release = resolve; }); let count = 0;
  await context.route("**/api/users/me/weekly-notes", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    count += 1; if (count === 2) release(); await gate; await route.continue();
  });
  const responses = [page, other].map((tab) => tab.waitForResponse((res) => res.url().endsWith("/api/users/me/weekly-notes") && res.request().method() === "PUT"));
  await Promise.all([page, other].map((tab) => tab.getByRole("button", { name: "Save weekly notes", exact: true }).click()));
  const saved = await Promise.all(responses); expect(saved.map((res) => res.status()).sort()).toEqual([200, 409]);
  const loser = saved[0].status() === 409 ? page : other; const winnerText = saved[0].status() === 200 ? "First tab draft" : "Second tab draft";
  await expect(loser.getByRole("heading", { name: "These notes changed elsewhere" })).toBeVisible();
  await expect(note(loser, key)).toHaveValue(saved[0].status() === 409 ? "First tab draft" : "Second tab draft");
  expect((await read(page, key)).notes[0]).toBe(winnerText);
  await loser.getByRole("button", { name: "Use saved notes", exact: true }).click();
  await expect(note(loser, key)).toHaveValue(winnerText); await expect(loser.getByRole("button", { name: "Save weekly notes", exact: true })).toBeDisabled();
});

test("V1 reviews a V2 change before saving its retained edit and preserves other days", async ({ page, context, baseURL }, info) => {
  const key = currentWeek(); await write(page, key, Array(7).fill(""));
  await page.goto("/dashboard-attorney.html#tasks", { waitUntil: "domcontentloaded" });
  const card = page.locator('#weeklyNotesGrid').getByRole('button', { name: /^Weekly note for / }).first(); await expect(card).toBeVisible(); await card.click();
  const modal = page.locator("#weeklyNoteModal"); await expect(modal).toBeVisible();
  await modal.locator("textarea").fill("V1 retained Monday edit\n\nKeep these paragraphs.");
  const newer = await context.newPage(); await enterSecondaryDocument(newer, new URL(`${entry}#/tasks?week=${key}`, baseURL).href); await ready(newer);
  await note(newer, key).fill("V2 newer Monday"); await newer.locator("[data-av2-note-day]").nth(1).fill("V2 Tuesday must survive");
  await newer.getByRole("button", { name: "Save weekly notes", exact: true }).click(); await expect(weekly(newer)).toContainText("Weekly notes saved.");
  await modal.getByRole("button", { name: "Save Note", exact: true }).click();
  await expect(modal).toContainText("changed elsewhere"); await expect(modal.locator("textarea")).toHaveValue("V1 retained Monday edit\n\nKeep these paragraphs.");
  await modal.getByRole("button", { name: "Review saved note", exact: true }).click(); await expect(modal).toContainText("V2 newer Monday");
  await modal.getByRole("button", { name: "Keep my edit", exact: true }).click();
  await modal.getByRole("button", { name: "Save Note", exact: true }).click(); await expect(modal).toBeHidden();
  const saved = await read(page, key); expect(saved.notes[0]).toBe("V1 retained Monday edit\n\nKeep these paragraphs."); expect(saved.notes[1]).toBe("V2 Tuesday must survive");
  await page.reload(); await expect(page.locator('#weeklyNotesGrid').getByRole('button', { name: /^Weekly note for / }).first()).toContainText("V1 retained Monday edit\n\nKeep these paragraphs.");
  await page.locator('#weeklyNotesGrid').getByRole('button', { name: /^Weekly note for / }).first().click();
  await expect(modal.locator('textarea')).toHaveValue("V1 retained Monday edit\n\nKeep these paragraphs.");
  await page.screenshot({ path: info.outputPath('current-weekly-note-paragraphs.png') });
});

test("V1 keeps failed saves visible and requires a saved-version review before retry", async ({ page }) => {
  const key = currentWeek(); await write(page, key, Array(7).fill(""));
  await page.goto("/dashboard-attorney.html#tasks", { waitUntil: "domcontentloaded" }); await page.locator('#weeklyNotesGrid').getByRole('button', { name: /^Weekly note for / }).first().click();
  const modal = page.locator("#weeklyNoteModal"); await modal.locator("textarea").fill("Recoverable V1 note");
  await page.route("**/api/users/me/weekly-notes", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic unavailable" }) }));
  await modal.getByRole("button", { name: "Save Note", exact: true }).click(); await expect(modal).toContainText("Saving wasn’t confirmed");
  await expect(modal.getByRole("button", { name: "Save Note", exact: true })).toBeDisabled(); await expect(modal.locator("textarea")).toHaveValue("Recoverable V1 note");
  await page.unroute("**/api/users/me/weekly-notes");
  await modal.getByRole("button", { name: "Review saved note", exact: true }).click(); await modal.getByRole("button", { name: "Keep my edit", exact: true }).click();
  await modal.getByRole("button", { name: "Save Note", exact: true }).click(); await expect(modal).toBeHidden(); expect((await read(page, key)).notes[0]).toBe("Recoverable V1 note");
});

test("month view is accessible at supported widths and failures clear stale previews", async ({ page }, testInfo) => {
  await write(page, "2028-02-28", ["PRIVATE_MONTH_SENTINEL", "", "", "", "", "", ""]);
  await enterSecondaryDocument(page, new URL(`${entry}#/tasks?calendar=month&month=2028-02`, test.info().project.use.baseURL).href);
  const month = page.getByRole("region", { name: "Monthly private notes", exact: true }); await expect(month).toHaveAttribute("data-state", "ready");
  await expect(month.locator("[data-note-date]")).toHaveCount(35); await expect(month.locator('[data-note-date="2028-02-29"]')).toBeVisible();
  for (const viewport of [{ width: 320, height: 800 }, ...SUPPORTED_VIEWPORTS]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const cell = await month.locator('[data-note-date="2028-02-29"]').boundingBox(); expect(cell.width).toBeGreaterThanOrEqual(24); expect(cell.height).toBeGreaterThanOrEqual(44);
    if (testInfo.project.name === "chromium" && [390, 1440].includes(viewport.width)) { await month.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`monthly-notes-${viewport.width}.png`), fullPage: true }); }
  }
  const result = await new AxeBuilder({ page }).include('[data-av2-region="monthly-notes"]').withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(result.violations).toEqual([]);
  await page.route("**/api/users/me/weekly-notes?**", (route) => route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Synthetic denied"}' }));
  await month.getByRole("button", { name: "Refresh monthly notes", exact: true }).click(); await expect(month).toHaveAttribute("data-state", "error");
  await expect(month.locator("[data-note-date]")).toHaveCount(0); expect(await page.content()).not.toContain("PRIVATE_MONTH_SENTINEL");
});

test("V1 access loss removes private modal and calendar text", async ({ page }) => {
  const key = currentWeek(); await write(page, key, ["PRIVATE_V1_STORED", "", "", "", "", "", ""]);
  await page.goto("/dashboard-attorney.html#tasks", { waitUntil: "domcontentloaded" }); await page.locator('#weeklyNotesGrid').getByRole('button', { name: /^Weekly note for / }).first().click();
  const modal = page.locator("#weeklyNoteModal"); await modal.locator("textarea").fill("PRIVATE_V1_DRAFT");
  await page.route("**/api/users/me/weekly-notes", (route) => route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Synthetic access loss"}' }));
  await modal.getByRole("button", { name: "Save Note", exact: true }).click();
  await expect(modal).toBeHidden(); await expect(page.locator("#weeklyNotesGrid")).toContainText("no longer available");
  await expect(modal.locator("textarea")).toHaveValue(""); expect(await page.content()).not.toContain("PRIVATE_V1_STORED");
});

test("V2 access loss during conflict recovery clears its retained draft", async ({ page }) => {
  const key = "2027-02-01"; await write(page, key, Array(7).fill(""));
  await enterSecondaryDocument(page, new URL(`${entry}#/tasks?week=${key}`, test.info().project.use.baseURL).href); await ready(page); await note(page, key).fill("PRIVATE_RECOVERY_DRAFT");
  let saving = false;
  await page.route("**/api/users/me/weekly-notes**", (route) => {
    if (route.request().method() === "PUT") { saving = true; return route.fulfill({ status: 409, contentType: "application/json", body: '{"error":"Synthetic conflict"}' }); }
    return saving ? route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Synthetic denied"}' }) : route.continue();
  });
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
  await expect(weekly(page)).toContainText("no longer available"); await expect(weekly(page).locator("textarea")).toHaveCount(0);
  expect(await page.content()).not.toContain("PRIVATE_RECOVERY_DRAFT");
});

test("month read failure exposes retry instead of an empty calendar and supports six-week months", async ({ page }) => {
  await page.route("**/api/users/me/weekly-notes?**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Synthetic unavailable"}' }));
  await enterSecondaryDocument(page, new URL(`${entry}#/tasks?calendar=month&month=2026-08`, test.info().project.use.baseURL).href);
  const month = page.getByRole("region", { name: "Monthly private notes", exact: true }); await expect(month).toHaveAttribute("data-state", "error");
  await expect(month.locator("[data-note-date]")).toHaveCount(0);
  await page.unroute("**/api/users/me/weekly-notes?**"); await month.getByRole("button", { name: "Refresh monthly notes", exact: true }).click();
  await expect(month).toHaveAttribute("data-state", "ready"); await expect(month.locator("[data-note-date]")).toHaveCount(42);
  await month.getByLabel("Choose a month for private notes", { exact: true }).fill("2027-02"); await month.getByRole("button", { name: "Go to month", exact: true }).click();
  await expect(month).toHaveAttribute("data-state", "ready"); await expect(month.locator("[data-note-date]")).toHaveCount(28);
});

test("V1 long-note conflict review remains labeled, accessible and usable on mobile", async ({ page }, testInfo) => {
  const key = currentWeek(); await write(page, key, Array(7).fill(""));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/dashboard-attorney.html#tasks", { waitUntil: "domcontentloaded" });
  await page.locator('#weeklyNotesGrid').getByRole('button', { name: /^Weekly note for / }).first().click(); const modal = page.locator("#weeklyNoteModal");
  await modal.getByRole("textbox").fill("Retained mobile edit");
  await write(page, key, ["Saved review context ".repeat(80), "", "", "", "", "", ""]);
  await modal.getByRole("button", { name: "Save Note", exact: true }).click(); await modal.getByRole("button", { name: "Review saved note", exact: true }).click();
  await expect(modal.getByLabel("Saved note", { exact: true })).toBeFocused();
  const choices = modal.getByRole("button", { name: "Keep my edit", exact: true }); await expect(choices).toBeVisible();
  const bounds = await choices.boundingBox(); expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
  const audit = await new AxeBuilder({ page }).include("#weeklyNoteModal").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(audit.violations).toEqual([]);
  if (testInfo.project.name === "chromium") await page.screenshot({ path: testInfo.outputPath("legacy-note-review-mobile.png") });
  await choices.click(); await expect(modal.getByRole("textbox")).toBeFocused(); await expect(modal.getByRole("textbox")).toHaveValue("Retained mobile edit");
});

test("V1 will not move a private draft to a different signed-in account", async ({ page }) => {
  await page.goto("/dashboard-attorney.html#tasks", { waitUntil: "domcontentloaded" }); await page.locator('#weeklyNotesGrid').getByRole('button', { name: /^Weekly note for / }).first().click();
  const modal = page.locator("#weeklyNoteModal"); await modal.getByRole("textbox").fill("PRIVATE_ORIGINAL_OWNER_DRAFT");
  const session = await (await page.request.get("/api/auth/me")).json(); const user = session.user || session;
  await page.route("**/api/auth/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { ...user, id: "f".repeat(24), _id: "f".repeat(24) } }) }));
  let writes = 0; page.on("request", (req) => { if (req.method() === "PUT" && req.url().endsWith("/api/users/me/weekly-notes")) writes += 1; });
  await modal.getByRole("button", { name: "Save Note", exact: true }).click();
  await expect(modal).toBeHidden(); await expect(modal.getByRole("textbox", { includeHidden: true })).toHaveValue("");
  expect(writes).toBe(0); await expect(page.locator("#weeklyNotesGrid")).toContainText("no longer available");
});

test("keeping V2 edits merges newer saved notes on days the attorney did not edit", async ({ page }) => {
  const key = "2027-03-01"; await write(page, key, Array(7).fill(""));
  await enterSecondaryDocument(page, new URL(`${entry}#/tasks?week=${key}`, test.info().project.use.baseURL).href); await ready(page);
  await note(page, key).fill("My Monday edit");
  await write(page, key, ["Newer Monday to compare", "Newer Tuesday to preserve", "", "", "", "", ""]);
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
  await expect(page.getByRole("heading", { name: "These notes changed elsewhere", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep my edits for review", exact: true }).click();
  await expect(note(page, key)).toHaveValue("My Monday edit"); await expect(note(page, "2027-03-02")).toHaveValue("Newer Tuesday to preserve");
  await page.getByRole("button", { name: "Save weekly notes", exact: true }).click(); await expect(weekly(page)).toContainText("Weekly notes saved.");
  const saved = await read(page, key); expect(saved.notes[0]).toBe("My Monday edit"); expect(saved.notes[1]).toBe("Newer Tuesday to preserve");
});

for (const timing of ["before", "during", "none"]) test(`session refresh preserves the weekly editor before its first input: ${timing}`, async ({ page }) => {
  const key = "2027-01-04";
  await write(page, key, Array(7).fill(""));
  await enterSecondaryDocument(page, new URL(`${entry}#/tasks?week=${key}`, test.info().project.use.baseURL).href);
  await page.bringToFront(); await ready(page);
  await expect(page.locator("html")).toHaveAttribute("data-attorney-state", "ready");
  const input = note(page, key);
  const original = await input.elementHandle();
  if (timing === "none") await write(page, key, ["Updated saved note", "", "", "", "", "", ""]);
  await page.evaluate(() => {
    window.__weeklySessionCompletions = 0;
    new MutationObserver(records => {
      if (records.some(record => record.attributeName === "data-attorney-state") && document.documentElement.dataset.attorneyState === "ready") window.__weeklySessionCompletions++;
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-attorney-state"] });
  });
  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/auth/me", async route => { held = true; await gate; await route.continue().catch(() => {}); });
  try {
    if (timing === "before") await input.focus();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => held).toBe(true);
    if (timing === "during") await input.focus();
    release();
    await expect.poll(() => page.evaluate(() => window.__weeklySessionCompletions)).toBeGreaterThan(0);
    await ready(page);
    if (timing === "none") {
      await expect(input).toHaveValue("Updated saved note");
      await expect(page.getByRole("button", { name: "Save weekly notes", exact: true })).toBeDisabled();
      return;
    }
    expect(await original.evaluate(control => control.isConnected && document.activeElement === control)).toBe(true);
    await page.keyboard.type("Draft after verified session");
    await expect(input).toHaveValue("Draft after verified session");
    await page.getByRole("button", { name: "Save weekly notes", exact: true }).click();
    await expect(weekly(page)).toContainText("Weekly notes saved.");
    expect((await read(page, key)).notes[0]).toBe("Draft after verified session");
  } finally { release(); }
});
