const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const { SUPPORTED_VIEWPORTS } = require("../../../playwright.browser-matrix");
const entry = "/attorney-v2.html#/matters/new";
const status = (page) => page.getByRole("region", { name: "Draft save status", exact: true });
const ready = (page) => expect(status(page)).toHaveAttribute("data-state", "ready");
const save = (page) => status(page).getByRole("button", { name: "Save draft", exact: true }).click();
const fields = { title: "Synthetic contract draft", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "First paragraph.\n\nSecond paragraph.", tasks: [{ title: "Prepare agreement" }, { title: "Organize exhibits" }] };
async function request(page, method, path, data) {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const response = await page.request[method](`/api/case-drafts${path}`, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.ok()).toBeTruthy(); return response.json();
}
const create = async (page) => (await request(page, "post", "", fields)).draft;
const read = async (page, id) => (await request(page, "get", `/${id}`)).draft;
const title = (page) => page.locator("#av2-draft-title");
async function openDraftPage(page, path = entry) {
  const destination = new URL(path, test.info().project.use.baseURL);
  await page.evaluate(url => { setTimeout(() => location.assign(url), 0); }, destination.href);
  await expect(page).toHaveURL(destination.href);
}

test("create, autosave, resume, publishing review and current-editor compatibility preserve every draft field", async ({ page }) => {
  await openDraftPage(page); await ready(page);
  await page.getByRole("button", { name: "Continue to description", exact: true }).click();
  await expect(title(page)).toHaveAttribute("aria-invalid", "true");
  await title(page).fill(fields.title);
  await page.locator("#av2-draft-practiceArea").selectOption(fields.practiceArea);
  await page.locator("#av2-draft-state").selectOption(fields.state);
  await page.locator("#av2-draft-compAmount").fill(fields.compAmount);
  await page.locator("#av2-draft-experience").selectOption(fields.experience);
  await page.locator("#av2-draft-deadline").fill(fields.deadline);
  await page.getByRole("button", { name: "Continue to description", exact: true }).click();
  await page.locator("#av2-draft-description").fill(fields.description);
  for (let index = 0; index < fields.tasks.length; index++) { await page.getByRole("button", { name: "Add task", exact: true }).click(); await page.getByRole("textbox", { name: `Task ${index + 1}`, exact: true }).fill(fields.tasks[index].title); }
  await expect(status(page)).toContainText("Draft saved.");
  const url = page.url(); const id = new URLSearchParams(url.split("?")[1]).get("draftId"); expect(id).toMatch(/^[a-f0-9]{24}$/);
  expect(await read(page, id)).toMatchObject(fields);
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await expect(page.locator(".av2-draft-review")).toContainText("$400.01 compensation + $88.00 platform fee (22%) = $488.01");
  await page.reload(); await ready(page); await expect(page.locator(".av2-draft-review")).toContainText(fields.description);
  await page.getByRole("button", { name: "Review publishing confirmation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm and publish Matter", exact: true })).toBeVisible();
  await page.goto(`/create-case.html?draftId=${id}#review`); await ready(page);
  await expect(page.locator("#reviewSummary")).toContainText("$400.01");
  await expect(page.locator("#caseTitleInput")).toHaveValue(fields.title);
  await expect(page.locator("#caseDescription")).toHaveValue(fields.description);
  expect(await read(page, id)).toMatchObject(fields);
});

test("a lost creation response is resolved without a duplicate and retains later typing", async ({ page }) => {
  let creates = 0;
  await page.route("**/api/case-drafts", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    creates++; await route.fetch(); await route.abort("failed");
  });
  await openDraftPage(page); await ready(page); await title(page).fill("Creation response lost"); await save(page);
  await expect(status(page)).toHaveAttribute("data-state", "uncertain");
  await title(page).fill("Later typing retained");
  await expect(status(page).getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await status(page).getByRole("button", { name: "Check saved draft", exact: true }).click(); await ready(page);
  await expect(title(page)).toHaveValue("Later typing retained"); expect(creates).toBe(1);
  await save(page); await expect(status(page)).toContainText("Draft saved."); expect(creates).toBe(1);
  const id = new URLSearchParams(page.url().split("?")[1]).get("draftId"); expect((await read(page, id)).title).toBe("Later typing retained");
});

test("V1 reviews a V2 change before saving and includes changes to untouched fields", async ({ page, context }) => {
  const draft = await create(page);
  await page.goto(`/create-case.html?draftId=${draft.id}#details`); await ready(page);
  const newer = await context.newPage();
  // The editor's owner-verified ready state is the prerequisite for this conflict;
  // background telemetry or notification streams must not gate the second tab.
  await openDraftPage(newer, `${entry}?draftId=${draft.id}`); await ready(newer);
  await title(newer).fill("V2 newer title"); await newer.locator("#av2-draft-state").selectOption("California");
  // Let the normal autosave settle before testing the other editor's conflict.
  await expect.poll(() => read(newer, draft.id)).toMatchObject({ title: "V2 newer title", state: "California" });
  await expect(status(newer)).toContainText("Draft saved.");
  await page.locator("#caseTitleInput").fill("V1 retained title"); await save(page);
  await expect(status(page)).toHaveAttribute("data-state", "uncertain"); await expect(page.locator("#caseTitleInput")).toHaveValue("V1 retained title");
  await status(page).getByRole("button", { name: "Check saved draft", exact: true }).click();
  await expect(status(page)).toContainText("V2 newer title");
  await status(page).getByRole("button", { name: "Keep my edits", exact: true }).click();
  await expect(page.locator("#state")).toHaveValue("California"); await save(page); await expect(status(page)).toContainText("Draft saved.");
  expect(await read(page, draft.id)).toMatchObject({ title: "V1 retained title", state: "California", description: fields.description, compAmount: fields.compAmount });
});

test("V2 conflict recovery can use the saved version without writing", async ({ page }) => {
  const draft = await create(page); await openDraftPage(page, `${entry}?draftId=${draft.id}`); await ready(page);
  const remote = await request(page, "put", `/${draft.id}`, { ...fields, title: "Remote title", revision: draft.revision });
  await title(page).fill("Local title"); await save(page); await expect(status(page)).toHaveAttribute("data-state", "uncertain");
  await status(page).getByRole("button", { name: "Check saved draft", exact: true }).click();
  await status(page).getByRole("button", { name: "Use saved draft", exact: true }).click(); await ready(page);
  await expect(title(page)).toHaveValue("Remote title"); expect((await read(page, draft.id)).revision).toBe(remote.draft.revision);
});

test("typing during an in-flight save is retained and the next save completes before exit", async ({ page }) => {
  const draft = await create(page); await openDraftPage(page, `${entry}?draftId=${draft.id}`); await ready(page);
  let release, started; const gate = new Promise((resolve) => { release = resolve; }); const began = new Promise((resolve) => { started = resolve; }); let writes = 0;
  await page.route(`**/api/case-drafts/${draft.id}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++; if (writes === 1) { started(); await gate; } await route.continue();
  });
  await title(page).fill("First pending title"); await save(page); await began;
  await title(page).fill("Final title while saving"); release();
  await expect(status(page)).toContainText("Draft saved."); expect(writes).toBe(2);
  await page.getByRole("button", { name: "Save and return to drafts", exact: true }).click();
  await expect(page).toHaveURL(/#\/matters\?view=draft$/); expect((await read(page, draft.id)).title).toBe("Final title while saving");
});

test("failed saves remain in memory across routes and require a check before retry", async ({ page }) => {
  const draft = await create(page); await openDraftPage(page, `${entry}?draftId=${draft.id}`); await ready(page);
  await page.route(`**/api/case-drafts/${draft.id}`, (route) => route.request().method() === "PUT" ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Synthetic unavailable"}' }) : route.continue());
  await title(page).fill("Unsaved route recovery"); await save(page); await expect(status(page)).toHaveAttribute("data-state", "uncertain");
  await page.getByRole("link", { name: "Return to drafts", exact: true }).first().click();
  await page.evaluate((hash) => { location.hash = hash; }, `/matters/new?draftId=${draft.id}`); await ready(page);
  await expect(title(page)).toHaveValue("Unsaved route recovery"); expect((await read(page, draft.id)).title).toBe(fields.title);
  await page.unroute(`**/api/case-drafts/${draft.id}`); await save(page); await expect(status(page)).toContainText("Draft saved.");
});

test("deletion is confirmed, refuses a stale revision and keeps a lost delete response unconfirmed", async ({ page }) => {
  const draft = await create(page); await openDraftPage(page, `${entry}?draftId=${draft.id}`); await ready(page);
  await request(page, "put", `/${draft.id}`, { ...fields, title: "Changed before deletion", revision: draft.revision });
  await page.getByRole("button", { name: "Delete draft", exact: true }).click();
  await page.getByRole("button", { name: "Keep draft", exact: true }).click(); expect((await read(page, draft.id)).title).toBe("Changed before deletion");
  await page.getByRole("button", { name: "Delete draft", exact: true }).click(); await page.getByRole("button", { name: "Delete draft permanently", exact: true }).click();
  await expect(status(page)).toHaveAttribute("data-state", "uncertain");
  await status(page).getByRole("button", { name: "Check saved draft", exact: true }).click(); await ready(page); await expect(title(page)).toHaveValue("Changed before deletion");
  await page.route(`**/api/case-drafts/${draft.id}`, async (route) => { if (route.request().method() !== "DELETE") return route.continue(); await route.fetch(); await route.abort("failed"); });
  await page.getByRole("button", { name: "Delete draft", exact: true }).click(); await page.getByRole("button", { name: "Delete draft permanently", exact: true }).click();
  await expect(status(page)).toHaveAttribute("data-state", "uncertain"); await status(page).getByRole("button", { name: "Check saved draft", exact: true }).click();
  await expect(status(page)).toHaveAttribute("data-state", "uncertain"); await expect(status(page)).toContainText("Deletion was not confirmed");
  await expect(page.getByRole("heading", { name: "Draft deleted", exact: true })).toBeHidden(); await expect(title(page)).toHaveValue("Changed before deletion");
  await expect(page.getByRole("button", { name: "Delete draft", exact: true })).toBeDisabled(); expect((await page.request.get(`/api/case-drafts/${draft.id}`)).status()).toBe(404);
});

test("missing and malformed draft links never create replacement drafts", async ({ page }) => {
  let writes = 0; page.on("request", (req) => { if (req.method() !== "GET" && req.url().includes("/api/case-drafts")) writes++; });
  await openDraftPage(page, `${entry}?draftId=000000000000000000000001`); await expect(status(page)).toHaveAttribute("data-state", "uncertain");
  await expect(title(page)).toBeDisabled(); await expect(status(page)).toContainText("has not been recreated");
  await openDraftPage(page, `${entry}?draftId=invalid`); await expect(page.getByRole("alert")).toContainText("draft link is invalid"); expect(writes).toBe(0);
});

test("drafts are erased on an account change before a write can leave the page", async ({ page }) => {
  await openDraftPage(page); await ready(page); await title(page).fill("PRIVATE_DRAFT_ACCOUNT_SENTINEL");
  let writes = 0; page.on("request", (req) => { if (req.method() !== "GET" && req.url().includes("/api/case-drafts")) writes++; });
  await page.route("**/api/auth/me", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { id: "b".repeat(24), role: "attorney", status: "approved" } }) }));
  await save(page); await expect(page).toHaveURL(/\/login.html/); expect(writes).toBe(0);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("PRIVATE_DRAFT_ACCOUNT_SENTINEL");
  await expect(page.locator("body")).not.toContainText("PRIVATE_DRAFT_ACCOUNT_SENTINEL");
});

test("draft details and review remain accessible across the supported screen widths", async ({ page }, testInfo) => {
  const draft = await create(page); await openDraftPage(page, `${entry}?draftId=${draft.id}`); await ready(page);
  for (const viewport of [{ width: 320, height: 800 }, ...SUPPORTED_VIEWPORTS]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.locator(".av2-main").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).include("[data-av2-outlet]").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("draft-details-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "3. Review", exact: true }).click();
  expect((await new AxeBuilder({ page }).include("[data-av2-outlet]").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("draft-review-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: testInfo.outputPath("draft-review-desktop.png"), fullPage: true });
});

test("V1 Save and Exit stays on an unconfirmed save and exits only after recovery", async ({ page }) => {
  const draft = await create(page); await page.goto(`/create-case.html?draftId=${draft.id}#details`); await ready(page);
  await page.route(`**/api/case-drafts/${draft.id}`, (route) => route.request().method() === "PUT" ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Synthetic unavailable"}' }) : route.continue());
  await page.locator("#caseTitleInput").fill("V1 save exit recovery");
  await page.locator('[data-step="details"] [data-step-link="review"]').click();
  await expect(status(page)).toHaveAttribute("data-state", "uncertain");
  await page.getByRole("button", { name: "Save & Exit", exact: true }).click(); await expect(page).toHaveURL(/create-case.html.*#review$/);
  await page.unroute(`**/api/case-drafts/${draft.id}`); await status(page).getByRole("button", { name: "Check saved draft", exact: true }).click(); await ready(page);
  await page.getByRole("button", { name: "Save & Exit", exact: true }).click();
  await expect(page).toHaveURL(/dashboard-attorney.html#cases:draft$/); expect((await read(page, draft.id)).title).toBe("V1 save exit recovery");
});

test("empty existing drafts and unfamiliar stored values are preserved without defaults", async ({ page }) => {
  const draft = (await request(page, "post", "", { ...fields, title: "", practiceArea: "Legacy Practice", state: "Legacy State", experience: "Legacy Experience", deadline: "Legacy deadline label" })).draft;
  await openDraftPage(page, `${entry}?draftId=${draft.id}`); await ready(page); await expect(title(page)).toHaveValue("");
  await expect(page.locator("#av2-draft-deadline")).toHaveValue("Legacy deadline label");
  await title(page).fill("Updated title only"); await save(page); await expect(status(page)).toContainText("Draft saved.");
  expect(await read(page, draft.id)).toMatchObject({ practiceArea: "Legacy Practice", state: "Legacy State", experience: "Legacy Experience", deadline: "Legacy deadline label" });
  await title(page).fill(""); await save(page); await expect(status(page)).toContainText("Draft saved.");
  await page.reload(); await ready(page); await expect(title(page)).toHaveValue("");
  await page.goto(`/create-case.html?draftId=${draft.id}#details`); await ready(page); await expect(page.locator("#caseTitleInput")).toHaveValue(""); await expect(page.locator("#caseDeadline")).toHaveValue("Legacy deadline label");
});

test("a failed initial draft read blocks editing until a successful reload", async ({ page }) => {
  const draft = await create(page);
  await page.route(`**/api/case-drafts/${draft.id}`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Synthetic unavailable"}' }));
  await openDraftPage(page, `${entry}?draftId=${draft.id}`); await expect(status(page)).toHaveAttribute("data-state", "uncertain"); await expect(title(page)).toBeDisabled();
  await page.unroute(`**/api/case-drafts/${draft.id}`); await status(page).getByRole("button", { name: "Check saved draft", exact: true }).click(); await ready(page); await expect(title(page)).toHaveValue(fields.title);
});

for (const [editor, path, selector] of [["V2", entry, "#av2-draft-title"], ["V1", "/create-case.html", "#caseTitleInput"]]) {
  test(`${editor} clears draft text when the server detects an account switch after preflight`, async ({ page }) => {
    const me = (await (await page.request.get("/api/auth/me")).json()).user; const ownerId = String(me.id || me._id);
    if (editor === "V2") await openDraftPage(page); else await page.goto(path); await ready(page); let writes = 0;
    await page.route("**/api/case-drafts", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      writes++; expect(route.request().postDataJSON().expectedOwnerId).toBe(ownerId);
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "DRAFT_ACCOUNT_CHANGED", error: "The signed-in account changed." }) });
    });
    await page.locator(selector).fill("PRIVATE_POST_PREFLIGHT_SENTINEL"); await save(page);
    await expect(page).toHaveURL(/\/login.html/); expect(writes).toBe(1);
    await expect(page.locator("body")).not.toContainText("PRIVATE_POST_PREFLIGHT_SENTINEL");
  });
}
