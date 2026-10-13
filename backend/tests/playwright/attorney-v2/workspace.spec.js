const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const workspace = page => page.locator("[data-matter-workspace]");
const objectId = n => n.toString(16).padStart(24, "0");
const fields = { title: "River Street lease — document review", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and organize its exhibits.\n\nRetain the original document names.", tasks: [{ title: "Review the lease" }, { title: "Organize exhibits" }] };
async function api(page, method, path, data) {
  const csrf = await (await page.request.get("/api/csrf")).json(), user = (await (await page.request.get("/api/auth/me")).json()).user;
  const response = await page.request[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) }); expect(response.ok(), await response.text()).toBeTruthy(); return response.json();
}
async function matter(page, overrides = {}) {
  const draft = (await api(page, "post", "/api/case-drafts", { ...fields, ...overrides })).draft;
  const { publication } = await api(page, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  return { id: publication.caseId, value: await api(page, "get", `/api/cases/${publication.caseId}`) };
}
async function open(page, id, tab = "overview", query = "") { await page.goto(`/attorney-v2.html#/matters/${id}/${tab}${query}`); await expect(workspace(page)).toHaveAttribute("data-state", "ready"); }

test("Matter switcher preserves the inventory return and recovers failed searches", async ({ page }) => {
  const secondTitle = `Switcher destination ${require('crypto').randomUUID()}`;
  const first = await matter(page), second = await matter(page, { title: secondTitle });
  await open(page, first.id, "overview", "?returnTo=%23%2Fmatters%3Fview%3Dactive");
  let fail = true;
  await page.route('**/api/cases/inventory/choices?**', route => fail ? fulfill(route, { error: 'Unavailable' }, 503) : route.continue());
  const trigger = page.getByRole('button', { name: 'Switch Matter', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Switch Matter', exact: true });
  await expect(dialog).toHaveAttribute('data-state', 'error');
  fail = false; await dialog.getByRole('button', { name: 'Retry search' }).click();
  await expect(dialog).toHaveAttribute('data-state', 'ready');
  await expect(dialog.locator('[aria-current="true"]')).toBeDisabled();
  await dialog.getByLabel('Search Matters', { exact: true }).fill(secondTitle);
  await expect(dialog).toHaveAttribute('data-state', 'ready');
  await dialog.locator('.av2-matter-choice').filter({ hasText: secondTitle }).click();
  await expect(workspace(page)).toHaveAttribute('data-matter-workspace', second.id);
  await expect(workspace(page)).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('link', { name: 'Back to Matters', exact: true })).toHaveAttribute('href', '#/matters?view=active');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Matter sections' }).getByRole('link', { name: 'Work', exact: true }).click();
  await expect(workspace(page)).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.av2-matter-next-action').getByRole('link', { name: 'View posting', exact: true })).toHaveAttribute('href', new RegExp(`/matters/${second.id}/overview\\?returnTo=`));
});

test("a real posted Matter opens every section with its title, scope and original context", async ({ page }) => {
  const { id, value } = await matter(page); await open(page, id); await expect(page.getByRole("heading", { level: 1 })).toHaveText(value.title); await expect(workspace(page)).toContainText(fields.description);
  for (const tab of ["Work", "Applications", "Files", "Messages", "Activity", "Financials", "Overview"]) {
    await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: tab, exact: true }).click(); await expect(workspace(page)).toHaveAttribute("data-state", "ready"); await expect(page.getByRole("heading", { level: 1 })).toHaveText(value.title); await expect(page).toHaveURL(new RegExp(`/matters/${id}/${tab.toLowerCase()}$`));
    await expect(page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await page.reload(); await expect(workspace(page)).toHaveAttribute("data-state", "ready"); await page.goBack(); await expect(page).toHaveURL(/\/financials$/); await expect(workspace(page)).toHaveAttribute("data-state", "ready");
});
test("Matter text renders as text and long titles remain readable with accessible section navigation", async ({ page }, testInfo) => {
  const { id, value } = await matter(page); value.title = "Lease review for the River Street property and its existing tenants ".repeat(3); value.details = '<img src=x onerror="window.syntheticXss=true">\nRetain these words.'; value.matterExperience.header.title = value.title;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => fulfill(route, value)); await open(page, id); await expect(workspace(page)).toContainText(value.details); expect(await page.evaluate(() => window.syntheticXss)).toBeUndefined();
  await expect(page.locator('.av2-matter-header-facts')).toHaveText('Due Mar 14, 2027');
  await expect(page.locator('.av2-matter-next-action')).toBeHidden();
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect((await new AxeBuilder({ page }).include("[data-matter-workspace]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); const work = page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }); await work.focus(); await expect(work).toBeFocused(); expect((await work.boundingBox()).height).toBeGreaterThanOrEqual(44); await page.screenshot({ path: testInfo.outputPath(`matter-${width}.png`), fullPage: true }); }
});
test("conversation deep links expose their exact earlier message and preserve attachment text safely", async ({ page }) => {
  const { id } = await matter(page), messages = Array.from({ length: 50 }, (_, index) => ({ _id: objectId(index + 100), caseId: id, type: "text", revision: "d".repeat(64), readBy: [], reactions: {}, text: `Recorded message ${index + 1}`, senderId: { _id: objectId(3), firstName: "Priya", lastName: "Ng" }, createdAt: new Date(Date.UTC(2026, 8, 1, 12, index)).toISOString() }));
  messages[0] = { ...messages[0], type: "audio", transcript: "The exhibit list is ready.", fileName: "Review notes.webm", fileKey: "javascript:alert(1)", hasAttachment: false, audioMimeType: null };
  await page.route(`**/api/messages/${id}?**`, route => fulfill(route, { caseId: id, messages, nextCursor: null, writable: true, targetMissing: false })); await page.route(`**/api/messages/${id}/read`, route => fulfill(route, { updatedLegacy: 0, updatedReceipts: 0 })); await open(page, id, "messages", `?messageId=${objectId(100)}`); const conversation = page.locator("[data-workspace-messages]"); await expect(conversation).toHaveAttribute("data-state", "ready"); const selected = conversation.locator(`[data-message-id="${objectId(100)}"]`); await expect(selected).toBeFocused(); await expect(selected).toContainText("The exhibit list is ready."); await expect(selected).toContainText("Review notes.webm"); await expect(conversation.locator("a[href^='javascript:']")).toHaveCount(0); await expect(selected).toContainText("No attachment is available for this message."); await expect(selected.getByRole("button", { name: "Load audio" })).toHaveCount(0); await expect(selected.getByRole("button", { name: "Download attachment" })).toHaveCount(0);
});
test("message load failures and deleted deep links do not become an empty conversation", async ({ page }) => {
  const { id } = await matter(page); await page.route(`**/api/messages/${id}?**`, route => fulfill(route, {}, 503)); await open(page, id, "messages"); const conversation = page.locator("[data-workspace-messages]"); await expect(conversation).toHaveAttribute("data-state", "error"); await expect(conversation).toContainText("Messages couldn’t load"); await expect(conversation).not.toContainText("No messages have been recorded");
  await page.route(`**/api/messages/${id}?**`, route => fulfill(route, { caseId: id, messages: [], nextCursor: null, writable: true, targetMissing: true })); await page.goto(`/attorney-v2.html#/matters/${id}/messages?messageId=${objectId(99)}`); await expect(conversation).toContainText("The linked message is no longer available");
});
test("paused, completed and archived Matters name the restriction without implying a settled payment", async ({ page }) => {
  const { id, value } = await matter(page); await open(page, id);
  for (const patch of [{ status: "paused", pausedReason: "paralegal_withdrew" }, { status: "completed", readOnly: true }, { status: "completed", archived: true }]) { await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => fulfill(route, { ...value, ...patch })); await workspace(page).getByRole("button", { name: "Refresh Matter", exact: true }).click(); await expect(workspace(page)).toHaveAttribute("data-state", "ready"); await expect(workspace(page)).toContainText(patch.archived ? "This Matter is archived" : patch.status === "paused" ? "The paralegal withdrew" : "closed to further work"); await expect(workspace(page)).not.toContainText("Paid in full"); }
});
test("a failed refresh removes confidential Matter details instead of leaving an apparently current record", async ({ page }) => {
  const { id } = await matter(page); await open(page, id); await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => fulfill(route, {}, 403)); await workspace(page).getByRole("button", { name: "Refresh Matter", exact: true }).click(); await expect(workspace(page)).toHaveAttribute("data-state", "error"); await expect(workspace(page)).not.toContainText(fields.title); await expect(workspace(page)).not.toContainText(fields.description); await expect(workspace(page)).toContainText("no longer available to your account");
});
test("the periodic access check clears a Matter after access is revoked", async ({ page }) => {
  const { id } = await matter(page); await page.clock.install(); await open(page, id); await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => fulfill(route, {}, 404)); await page.clock.fastForward(16000); await expect(workspace(page)).toHaveAttribute("data-state", "error"); await expect(workspace(page)).not.toContainText(fields.description);
});
for (const phase of ['initial', 'background']) test(`a single snapshot conflict during the ${phase} read rechecks the Matter once`, async ({ page }) => {
  const { id, value } = await matter(page);
  if (phase === 'background') await open(page, id);
  let reads = 0;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => ++reads === 1 ? fulfill(route, { code: 'WORKSPACE_CHANGED' }, 409) : fulfill(route, value));
  if (phase === 'initial') await open(page, id);
  else await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => reads).toBe(2);
  await expect(workspace(page)).toHaveAttribute('data-state', 'ready');
  await expect(workspace(page)).toContainText(fields.description);
});
for (const status of [409, 403, 503]) test(`a persistent ${status} Matter read stops without an unbounded retry`, async ({ page }) => {
  const { id } = await matter(page); let reads = 0;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => { reads++; return fulfill(route, { code: status === 409 ? 'WORKSPACE_CHANGED' : 'WORKSPACE_UNAVAILABLE' }, status); });
  await page.goto(`/attorney-v2.html#/matters/${id}/overview`);
  await expect(workspace(page)).toHaveAttribute('data-state', 'error');
  expect(reads).toBe(status === 409 ? 2 : 1);
  await expect(workspace(page)).not.toContainText(fields.description);
  await expect(workspace(page).getByRole('button', { name: 'Refresh Matter', exact: true })).toBeEnabled();
});
test("switching accounts while a Matter is loading discards its late confidential response", async ({ page }) => {
  const { id, value } = await matter(page); await open(page, id); let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; }); await page.route(`**/api/cases/${id}?expectedOwnerId=*`, async route => { arrived(); await gate; await fulfill(route, value).catch(() => {}); });
  await workspace(page).getByRole("button", { name: "Refresh Matter", exact: true }).click();
  try { await waiting; await page.route("**/api/auth/me", route => fulfill(route, { user: { id: objectId(999), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(workspace(page)).toHaveCount(0); } finally { release(); } await expect(workspace(page)).toHaveCount(0);
});


for (const phase of ['initial', 'background']) test(`an application snapshot conflict during the ${phase} read rechecks the Matter once`, async ({ page }) => {
  const { id, value } = await matter(page);
  if (phase === 'background') await open(page, id);
  let reads = 0;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => ++reads === 1 ? fulfill(route, { code: 'APPLICATION_REVIEW_CHANGED' }, 409) : fulfill(route, value));
  if (phase === 'initial') await open(page, id);
  else await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => reads).toBe(2);
  await expect(workspace(page)).toHaveAttribute('data-state', 'ready');
  await expect(workspace(page)).toContainText(fields.description);
});

test('a repeated application snapshot conflict stops after one recheck and removes old Matter details', async ({ page }) => {
  const { id } = await matter(page); await open(page, id); let reads = 0;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => { reads++; return fulfill(route, { code: 'APPLICATION_REVIEW_CHANGED' }, 409); });
  await workspace(page).getByRole('button', { name: 'Refresh Matter', exact: true }).click();
  await expect(workspace(page)).toHaveAttribute('data-state', 'error');
  expect(reads).toBe(2);
  await expect(workspace(page)).not.toContainText(fields.description);
  await expect(workspace(page)).not.toContainText(fields.title);
  await expect(workspace(page).getByRole('button', { name: 'Refresh Matter', exact: true })).toBeEnabled();
});

test('revoked access on an application snapshot recheck clears the Matter without another attempt', async ({ page }) => {
  const { id } = await matter(page); await open(page, id); let reads = 0;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => ++reads === 1 ? fulfill(route, { code: 'APPLICATION_REVIEW_CHANGED' }, 409) : fulfill(route, { code: 'WORKSPACE_RESTRICTED' }, 403));
  await workspace(page).getByRole('button', { name: 'Refresh Matter', exact: true }).click();
  await expect(workspace(page)).toHaveAttribute('data-state', 'error');
  expect(reads).toBe(2);
  await expect(workspace(page)).not.toContainText(fields.description);
  await expect(workspace(page)).not.toContainText(fields.title);
  await expect(workspace(page)).toContainText('no longer available to your account');
});

test('an account change after an application snapshot conflict prevents the second Matter read', async ({ page }) => {
  const { id } = await matter(page); await open(page, id);
  let changed = false, reads = 0, changedOwnerChecks = 0;
  await page.route('**/api/auth/me', route => {
    if (!changed) return route.continue();
    changedOwnerChecks++;
    return fulfill(route, { user: { id: objectId(999), role: 'attorney', status: 'approved' } });
  });
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => { reads++; changed = true; return fulfill(route, { code: 'APPLICATION_REVIEW_CHANGED' }, 409); });
  await workspace(page).getByRole('button', { name: 'Refresh Matter', exact: true }).click();
  await expect.poll(() => changedOwnerChecks).toBeGreaterThan(0);
  await expect(page.locator('body')).not.toContainText(fields.description);
  await expect(page.locator('body')).not.toContainText(fields.title);
  expect(reads).toBe(1);
});

test('an unrecognized Matter conflict does not gain an automatic recheck', async ({ page }) => {
  const { id } = await matter(page); let reads = 0;
  await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => { reads++; return fulfill(route, { code: 'UNRECOGNIZED_CONFLICT' }, 409); });
  await page.goto(`/attorney-v2.html#/matters/${id}/overview`);
  await expect(workspace(page)).toHaveAttribute('data-state', 'error');
  expect(reads).toBe(1);
  await expect(workspace(page)).not.toContainText(fields.description);
});
