const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fields = { title: "Synthetic publishing review", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "First paragraph.\n\nSecond paragraph.", tasks: [{ title: "Prepare agreement" }] };
const publication = (page) => page.getByRole("region", { name: "Publication status", exact: true, includeHidden: true });
const postingStatus = (page) => page.getByRole("region", { name: "Posting save status", exact: true });
async function api(page, method, path, data) {
  const csrf = await (await page.request.get("/api/csrf")).json();
  const user = (await (await page.request.get("/api/auth/me")).json()).user;
  const response = await page.request[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function source(page, changes = {}) { return (await api(page, "post", "/api/case-drafts", { ...fields, ...changes })).draft; }
async function navigateEditor(page, path) {
  await page.bringToFront();
  const destination = new URL(path, process.env.PLAYWRIGHT_BASE_URL).href;
  const sameDocument = page.url().split('#')[0] === destination.split('#')[0] && page.url() !== destination;
  const previous = await page.locator(sameDocument ? '[data-av2-outlet] > .av2-view' : 'html').elementHandle();
  // Firefox can leave its protocol navigation promise pending after a second
  // tab's document and private readers have loaded. Use native address
  // navigation, then verify the exact URL and the editor's actual readers.
  await page.evaluate(url => { setTimeout(() => { if (window.location.href === url) window.location.reload(); else window.location.assign(url); }, 0); }, destination);
  await expect(page).toHaveURL(destination);
  // Do not mistake the previous route's already-ready reader for this one.
  if (previous) await expect.poll(() => previous.evaluate(element => element.isConnected).catch(() => false)).toBe(false);
}
async function openDraft(page, draft, current = false) {
  await navigateEditor(page, current ? `/create-case.html?draftId=${draft.id}#review` : `/attorney-v2.html#/matters/new?draftId=${draft.id}&step=review`);
  await expect(publication(page)).toHaveAttribute("data-state", "ready");
  await expect(page.getByRole("region", { name: "Draft save status", exact: true })).toHaveAttribute("data-state", "ready");
}
async function confirm(page, current = false) {
  await (current ? page.locator("#postBtn") : page.getByRole("button", { name: "Review publishing confirmation", exact: true })).click();
  await page.getByRole("button", { name: "Confirm and publish Matter", exact: true }).click();
}
async function published(page) {
  const draft = await source(page);
  const result = await api(page, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  return { draft, receipt: result.publication };
}
const read = async (page, id) => (await api(page, "get", `/api/cases/posting/${id}`)).posting;
async function edit(page, id, current = false) {
  await navigateEditor(page, current ? `/create-case.html?caseId=${id}` : `/attorney-v2.html#/matters/new?caseId=${id}`);
  await expect(postingStatus(page)).toHaveAttribute("data-state", "ready");
}
async function save(page) {
  await page.getByRole("button", { name: "Review posting changes", exact: true }).click();
  await page.getByRole("button", { name: "Save reviewed changes", exact: true }).click();
}

test("publishing success survives draft cleanup failure and reload without another posting", async ({ page }) => {
  const draft = await source(page); let writes = 0;
  await page.route("**/api/cases/posting/publications", (route) => { writes++; return route.continue(); });
  await page.route("**/api/cases/posting/publications/*/cleanup", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Synthetic cleanup failure"}' }));
  await openDraft(page, draft); await confirm(page);
  await expect(publication(page)).toHaveAttribute("data-state", "complete");
  await expect(publication(page)).toContainText("The saved draft couldn’t be removed. It can’t be published again.");
  const result = (await api(page, "get", `/api/cases/posting/drafts/${draft.id}`)).publication;
  expect((await read(page, result.caseId)).values).toEqual({ ...fields, practiceArea: "contract law" });
  await page.reload(); await expect(publication(page)).toHaveAttribute("data-state", "complete"); expect(writes).toBe(1);
  await expect(publication(page)).toContainText("The saved draft couldn’t be removed. It can’t be published again.");
  await page.unroute("**/api/cases/posting/publications/*/cleanup");
  await page.getByRole("button", { name: "Retry draft cleanup", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry draft cleanup", exact: true })).toHaveCount(0);
});

test("a lost publish response resolves from its receipt without a duplicate submit", async ({ page }) => {
  const draft = await source(page); let writes = 0;
  await page.route("**/api/cases/posting/publications", async (route) => { writes++; await route.fetch(); await route.abort("failed"); });
  await openDraft(page, draft); await confirm(page);
  await expect(publication(page)).toHaveAttribute("data-state", "uncertain");
  await page.getByRole("button", { name: "Check publication result", exact: true }).click();
  await expect(publication(page)).toHaveAttribute("data-state", "complete"); expect(writes).toBe(1);
  await page.reload(); await expect(publication(page)).toHaveAttribute("data-state", "complete"); expect(writes).toBe(1);
});

test("two reviewed tabs recover the same posting after source cleanup", async ({ page, context }) => {
  const draft = await source(page); await openDraft(page, draft);
  const second = await context.newPage(); await openDraft(second, draft); await confirm(second);
  await expect(publication(second)).toHaveAttribute("data-state", "complete");
  await page.bringToFront(); await page.reload(); await expect(publication(page)).toHaveAttribute("data-state", "complete");
  expect(await publication(second).getByRole("link", { name: "Open posted Matter" }).getAttribute("href")).toBe(await publication(page).getByRole("link", { name: "Open posted Matter" }).getAttribute("href"));
});

test("unsupported draft practice needs an explicit publishing choice and excessive tasks stay in the draft", async ({ page }) => {
  const draft = await source(page, { practiceArea: "Specific legacy practice", tasks: Array.from({ length: 26 }, (_, i) => ({ title: `Task ${i + 1}` })) });
  await openDraft(page, draft);
  await expect(page.getByRole("button", { name: "Review publishing confirmation", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("Use 25 tasks or fewer before publishing.");
  const saved = (await api(page, "get", `/api/case-drafts/${draft.id}`)).draft; expect(saved.tasks).toHaveLength(26);
  await page.getByRole("button", { name: "Back to description", exact: true }).click();
  await page.getByRole("button", { name: "Remove task 26", exact: true }).click();
  await page.getByRole("button", { name: "Review draft", exact: true }).click();
  await page.getByRole("button", { name: "Review publishing confirmation", exact: true }).click();
  await expect(page.getByLabel("Publishing practice area", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Confirm and publish Matter", exact: true }).click();
  await expect(publication(page)).toContainText("Choose a publishing practice area");
  await page.getByLabel("Publishing practice area", { exact: true }).selectOption("contract law");
  await page.getByRole("button", { name: "Confirm and publish Matter", exact: true }).click();
  await expect(publication(page)).toHaveAttribute("data-state", "complete");
  await expect(publication(page)).toContainText("Matter posted");
});

test("posted edits require review and preserve exact cents, paragraphs and all unchanged fields", async ({ page }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId);
  await page.locator("#av2-posting-title").fill("Reviewed title change");
  await page.locator("#av2-posting-state").fill("California");
  await page.locator("#av2-posting-compAmount").fill("501.23");
  await page.locator("#av2-posting-description").fill("Updated paragraph.\n\nSecond updated paragraph.");
  expect((await read(page, receipt.caseId)).values.title).toBe(fields.title);
  await save(page); await expect(postingStatus(page)).toContainText("Posting changes saved");
  expect((await read(page, receipt.caseId)).values).toEqual({ ...fields, title: "Reviewed title change", practiceArea: "contract law", state: "California", compAmount: "501.23", description: "Updated paragraph.\n\nSecond updated paragraph." });
});

test("two-tab posting recovery keeps edited fields and adopts remote untouched fields", async ({ page, context }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId); await page.locator("#av2-posting-title").fill("My retained title");
  const other = await context.newPage(); await edit(other, receipt.caseId);
  await other.locator("#av2-posting-title").fill("Other title"); await other.locator("#av2-posting-state").fill("California"); await save(other); await expect(postingStatus(other)).toContainText("Posting changes saved");
  await page.bringToFront();
  await page.getByRole("button", { name: "Check saved posting", exact: true }).click();
  await expect(postingStatus(page)).toContainText("Other title");
  await page.getByRole("button", { name: "Keep my edited fields", exact: true }).click();
  await expect(page.locator("#av2-posting-state")).toHaveValue("California"); await save(page); await expect(postingStatus(page)).toContainText("Posting changes saved");
  expect((await read(page, receipt.caseId)).values).toMatchObject({ title: "My retained title", state: "California" });
});

test("lost posted-save response retains later typing and checks without automatic retries", async ({ page }) => {
  const { receipt } = await published(page); let writes = 0;
  await page.route(`**/api/cases/posting/${receipt.caseId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue(); writes++; await route.fetch(); await route.abort("failed");
  });
  await edit(page, receipt.caseId); await page.locator("#av2-posting-title").fill("Saved but response lost"); await save(page);
  await expect(postingStatus(page)).toHaveAttribute("data-state", "uncertain");
  await page.locator("#av2-posting-title").fill("Later typing retained");
  await page.getByRole("button", { name: "Check saved posting", exact: true }).click();
  await expect(postingStatus(page)).toContainText("previous save is confirmed");
  await expect(page.locator("#av2-posting-title")).toHaveValue("Later typing retained"); expect(writes).toBe(1);
  await page.unroute(`**/api/cases/posting/${receipt.caseId}`); await save(page); await expect(postingStatus(page)).toContainText("Posting changes saved");
});

test("a Matter becoming ineligible during editing keeps the text and disables further writes", async ({ page }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId);
  await page.locator("#av2-posting-title").fill("Unsaved before hiring");
  const current = await read(page, receipt.caseId);
  await page.route(`**/api/cases/posting/${receipt.caseId}`, (route) => route.request().method() === "PATCH"
    ? route.fulfill({ status: 409, contentType: "application/json", body: '{"error":"Hiring started"}' })
    : route.fulfill({ contentType: "application/json", body: JSON.stringify({ posting: { ...current, permissions: { ...current.permissions, canEdit: false, canDelete: false, tasksLocked: true, reason: "Hiring has started." } } }) }));
  await save(page); await expect(postingStatus(page)).toHaveAttribute("data-state", "uncertain");
  await page.getByRole("button", { name: "Check saved posting", exact: true }).click();
  await expect(page.locator("#av2-posting-title")).toHaveValue("Unsaved before hiring");
  await expect(page.locator("#av2-posting-title")).toBeDisabled(); await expect(page.getByRole("button", { name: "Review posting changes" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete posting", exact: true })).toBeDisabled();
});

test("deletion requires confirmation and a lost response followed by 404 stays unconfirmed", async ({ page }) => {
  const { draft, receipt } = await published(page); let deletes = 0;
  await page.route(`**/api/cases/posting/${receipt.caseId}`, async (route) => { if (route.request().method() !== "DELETE") return route.continue(); deletes++; await route.fetch(); await route.abort("failed"); });
  await edit(page, receipt.caseId); await page.getByRole("button", { name: "Delete posting", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Permanently delete this posting?" })).toBeVisible();
  await page.getByRole("button", { name: "Delete posting permanently", exact: true }).click(); await expect(postingStatus(page)).toHaveAttribute("data-state", "uncertain");
  await page.getByRole("button", { name: "Check saved posting", exact: true }).click(); await expect(postingStatus(page)).toHaveAttribute("data-state", "uncertain");
  await expect(postingStatus(page)).toContainText("Deletion was not confirmed"); await expect(page.getByRole("heading", { name: "Posting deleted", exact: true })).toHaveCount(0); expect(deletes).toBe(1);
  await page.goto(`/attorney-v2.html#/matters/new?draftId=${draft.id}`); await expect(publication(page)).toContainText("Matter removed");
});

test("a denied posting read cannot confirm a failed delete, and a successful read restores safe controls", async ({ page }) => {
  for (const current of [false, true]) {
    const { receipt } = await published(page); let missing = false, deletes = 0;
    await edit(page, receipt.caseId, current);
    await page.route(`**/api/cases/posting/${receipt.caseId}`, route => {
      if (route.request().method() === 'DELETE') { deletes++; return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); }
      return missing ? route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }) : route.continue();
    });
    await page.getByRole('button', { name: 'Delete posting', exact: true }).click(); await page.getByRole('button', { name: 'Delete posting permanently', exact: true }).click();
    await expect(postingStatus(page)).toHaveAttribute('data-state', 'uncertain'); missing = true;
    await page.getByRole('button', { name: 'Check saved posting', exact: true }).click(); await expect(postingStatus(page)).toContainText('Deletion was not confirmed');
    await expect(page.locator('#av2-posting-title')).toBeHidden(); await expect(page.getByRole('heading', { name: 'Posting deleted', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete posting', exact: true })).toBeDisabled(); expect(deletes).toBe(1);
    missing = false; await page.getByRole('button', { name: 'Check saved posting', exact: true }).click(); await expect(postingStatus(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('#av2-posting-title')).toHaveValue(fields.title); expect(deletes).toBe(1);
    await page.unroute(`**/api/cases/posting/${receipt.caseId}`); await page.getByRole('button', { name: 'Delete posting', exact: true }).click(); await page.getByRole('button', { name: 'Delete posting permanently', exact: true }).click();
    await expect(postingStatus(page)).toHaveAttribute('data-state', 'deleted'); await expect(postingStatus(page).getByRole('heading', { level: 1, name: 'Posting deleted', exact: true })).toBeVisible();
  }
});

test("current editor publishes through the same confirmation and receipt recovery", async ({ page }) => {
  const draft = await source(page); await openDraft(page, draft, true); await confirm(page, true);
  await expect(publication(page)).toHaveAttribute("data-state", "complete");
  const result = (await api(page, "get", `/api/cases/posting/drafts/${draft.id}`)).publication;
  expect((await read(page, result.caseId)).values).toEqual({ ...fields, practiceArea: "contract law" });
});

test("current editor uses revision-checked posted edits without rounding compensation", async ({ page }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId, true);
  await expect(page.locator("#av2-posting-compAmount")).toHaveValue("400.01");
  await page.locator("#av2-posting-title").fill("Current editor revision check"); await save(page);
  await expect(postingStatus(page)).toContainText("Posting changes saved");
  expect((await read(page, receipt.caseId)).values).toMatchObject({ title: "Current editor revision check", compAmount: "400.01", description: fields.description });
});

test("publishing and posted review remain keyboard accessible at small and wide widths", async ({ page }, info) => {
  const draft = await source(page); await openDraft(page, draft);
  await page.getByRole("button", { name: "Review publishing confirmation", exact: true }).click();
  for (const width of [320, 390, 768, 1366, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Keep editing draft", exact: true }).click();
  const { receipt } = await published(page); await edit(page, receipt.caseId); await page.locator("#av2-posting-title").fill("Accessible reviewed change");
  await page.getByRole("button", { name: "Review posting changes", exact: true }).click();
  for (const width of [320, 390, 768, 1366, 1920]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); if ([390, 1366].includes(width)) await page.screenshot({ path: info.outputPath(`posting-review-${width}.png`), fullPage: true }); }
  expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("posting-review.png"), fullPage: true });
});


test("undoing an uncertain posted save preserves the deliberate return to the original value", async ({ page }) => {
  const { receipt } = await published(page);
  await page.route(`**/api/cases/posting/${receipt.caseId}`, async (route) => { if (route.request().method() !== "PATCH") return route.continue(); await route.fetch(); await route.abort("failed"); });
  await edit(page, receipt.caseId); await page.locator("#av2-posting-title").fill("Unconfirmed changed title"); await save(page);
  await expect(postingStatus(page)).toHaveAttribute("data-state", "uncertain");
  await page.locator("#av2-posting-title").fill(fields.title);
  await page.getByRole("button", { name: "Check saved posting", exact: true }).click();
  await expect(page.locator("#av2-posting-title")).toHaveValue(fields.title);
  await expect(page.getByRole("button", { name: "Review posting changes", exact: true })).toBeEnabled();
  await page.unroute(`**/api/cases/posting/${receipt.caseId}`); await save(page);
  await expect(postingStatus(page)).toContainText("Posting changes saved");
  expect((await read(page, receipt.caseId)).values.title).toBe(fields.title);
});

test("offline posted edits remain available across routes and save only after reconnection and review", async ({ page, context }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId);
  await page.locator("#av2-posting-title").fill("Offline text retained");
  await context.setOffline(true); await save(page); await expect(postingStatus(page)).toHaveAttribute("data-state", "uncertain");
  await context.setOffline(false);
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Matters", exact: true }).click();
  await page.evaluate((id) => { location.hash = `/matters/new?caseId=${id}`; }, receipt.caseId);
  await expect(postingStatus(page)).toHaveAttribute("data-state", "ready");
  await expect(page.locator("#av2-posting-title")).toHaveValue("Offline text retained");
  expect((await read(page, receipt.caseId)).values.title).toBe(fields.title);
  await save(page); await expect(postingStatus(page)).toContainText("Posting changes saved");
});


test("session refresh during publication resolves the committed receipt without leaving a busy editor", async ({ page }) => {
  const draft = await source(page); let release, committed;
  const gate = new Promise((resolve) => { release = resolve; }); const saved = new Promise((resolve) => { committed = resolve; });
  await page.route("**/api/cases/posting/publications", async (route) => {
    const response = await route.fetch(); committed(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await openDraft(page, draft); await confirm(page); await saved;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(publication(page)).toHaveAttribute("data-state", "complete"); release();
  await expect(publication(page).getByRole("link", { name: "Open posted Matter" })).toBeVisible();
});

test("session refresh during a posted save resolves the result without leaving a busy editor", async ({ page }) => {
  const { receipt } = await published(page); let release, committed;
  const gate = new Promise((resolve) => { release = resolve; }); const saved = new Promise((resolve) => { committed = resolve; });
  await page.route(`**/api/cases/posting/${receipt.caseId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    const response = await route.fetch(); committed(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await edit(page, receipt.caseId); await page.locator("#av2-posting-title").fill("Refresh-safe saved title"); await save(page); await saved;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(postingStatus(page)).toHaveAttribute("data-state", "ready"); release();
  await expect(page.locator("#av2-posting-title")).toHaveValue("Refresh-safe saved title");
  await expect(page.getByRole("button", { name: "Review posting changes", exact: true })).toBeDisabled();
});

for (const action of ['delete', 'save']) test(`same-account refresh keeps the unchanged posting ${action} confirmation for an explicit final decision`, async ({ page }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId);
  if (action === 'save') await page.locator('#av2-posting-title').fill('Retained reviewed title');
  await page.getByRole('button', { name: action === 'delete' ? 'Delete posting' : 'Review posting changes', exact: true }).click();
  const review = page.getByRole('region', { name: 'Posting confirmation', exact: true });
  await expect(review).toBeVisible(); const previous = await review.elementHandle();
  let writes = 0; page.on('request', request => { if (new URL(request.url()).pathname === `/api/cases/posting/${receipt.caseId}` && ['DELETE', 'PATCH'].includes(request.method())) writes++; });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => previous.evaluate(element => element.isConnected)).toBe(false);
  await expect(postingStatus(page)).toHaveAttribute('data-state', 'ready'); await expect(review).toBeVisible(); expect(writes).toBe(0);
  await expect(review).toBeFocused();
  await review.getByRole('button', { name: action === 'delete' ? 'Delete posting permanently' : 'Save reviewed changes', exact: true }).click();
  await expect(postingStatus(page)).toContainText(action === 'delete' ? 'Posting deleted' : 'Posting changes saved.'); expect(writes).toBe(1);
});

test('a changed posting cancels the retained confirmation during session refresh', async ({ page }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId);
  await page.getByRole('button', { name: 'Delete posting', exact: true }).click();
  const review = page.getByRole('region', { name: 'Posting confirmation', exact: true }); await expect(review).toBeVisible(); const previous = await review.elementHandle();
  const saved = await read(page, receipt.caseId); await api(page, 'patch', `/api/cases/posting/${receipt.caseId}`, { revision: saved.revision, changes: { title: 'Changed elsewhere before deletion' } });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => previous.evaluate(element => element.isConnected)).toBe(false);
  await expect(postingStatus(page)).toHaveAttribute('data-state', 'ready'); await expect(review).toBeHidden();
  await expect(page.locator('#av2-posting-title')).toHaveValue('Changed elsewhere before deletion'); expect((await page.request.get(`/api/cases/${receipt.caseId}`)).ok()).toBe(true);
});

for (const statusCode of [403, 503]) test(`a ${statusCode} refresh clears the posting confirmation and recovery requires a new review`, async ({ page }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId);
  await page.getByRole('button', { name: 'Delete posting', exact: true }).click();
  const review = page.getByRole('region', { name: 'Posting confirmation', exact: true }); await expect(review).toBeVisible(); const previous = await review.elementHandle();
  let denied = true, writes = 0;
  await page.route(`**/api/cases/posting/${receipt.caseId}`, route => {
    if (route.request().method() !== 'GET') { writes++; return route.continue(); }
    return denied ? route.fulfill({ status: statusCode, contentType: 'application/json', body: '{}' }) : route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => previous.evaluate(element => element.isConnected)).toBe(false);
  await expect(postingStatus(page)).toHaveAttribute('data-state', 'uncertain'); await expect(review).toBeHidden(); expect(writes).toBe(0);
  denied = false; await page.getByRole('button', { name: 'Check saved posting', exact: true }).click();
  await expect(postingStatus(page)).toHaveAttribute('data-state', 'ready'); await expect(review).toBeHidden(); expect(writes).toBe(0);
  await page.getByRole('button', { name: 'Delete posting', exact: true }).click(); await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Keep editing', exact: true }).click(); await expect(review).toBeHidden(); expect(writes).toBe(0);
});

test('session failure protects the posting immediately even while the pointer is held', async ({ page }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId);
  const remove = page.getByRole('button', { name: 'Delete posting', exact: true }); await remove.hover();
  await page.route('**/api/auth/me', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  let writes = 0; page.on('request', request => { if (request.method() === 'DELETE') writes++; });
  await page.mouse.down();
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('[data-av2-shell]')).toHaveAttribute('inert', '');
    await expect(page.getByText('We couldn’t verify your session.', { exact: false })).toBeVisible(); expect(writes).toBe(0);
  } finally { await page.mouse.up(); }
});

test('restoring a posting confirmation does not steal focus from workspace navigation', async ({ page }) => {
  const { receipt } = await published(page); await edit(page, receipt.caseId);
  await page.getByRole('button', { name: 'Delete posting', exact: true }).click();
  const review = page.getByRole('region', { name: 'Posting confirmation', exact: true }); await expect(review).toBeVisible(); const previous = await review.elementHandle();
  let arrived, release; const requested = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/cases/posting/${receipt.caseId}`, async route => { if (route.request().method() !== 'GET') return route.continue(); arrived(); await gate; await route.continue(); });
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await requested;
  await expect.poll(() => previous.evaluate(element => element.isConnected)).toBe(false);
  const home = page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Home', exact: true });
  try { await home.focus(); } finally { release(); }
  await expect(postingStatus(page)).toHaveAttribute('data-state', 'ready'); await expect(review).toBeVisible(); await expect(home).toBeFocused();
});
