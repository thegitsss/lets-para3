const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const panel = page => page.locator("[data-workspace-work]");
async function fixture(page, { lost = false, locked = false, reason = "ready" } = {}) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const csrf = await (await page.request.get("/api/csrf")).json(), fields = { title: "River Street lease — scope review", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and identify missing exhibits.", tasks: [{ title: "Review the lease" }, { title: "Review the lease" }] };
  const draftResponse = await page.request.post("/api/case-drafts", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { ...fields, expectedOwnerId: ownerId } }); expect(draftResponse.ok()).toBeTruthy(); const draft = (await draftResponse.json()).draft;
  const publication = await page.request.post("/api/cases/posting/publications", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law", expectedOwnerId: ownerId } }); expect(publication.ok()).toBeTruthy(); const caseId = (await publication.json()).publication.caseId;
  const state = { writes: [], denied: false, conflict: false, lost, value: { caseId, title: fields.title, revision: "d".repeat(64), taskRevision: 0, status: "in progress", canToggle: reason === "ready", canEditScope: false, completedLocked: locked, reason, items: [{ id: null, index: 0, title: "Review the lease", completed: locked, canToggle: reason === "ready" && !locked }, { id: null, index: 1, title: "Review the lease", completed: false, canToggle: reason === "ready" }] } };
  await page.route(`**/api/cases/${caseId}/work-review?**`, route => state.denied ? fulfill(route, { code: "WORKSPACE_RESTRICTED" }, 403) : fulfill(route, state.value));
  await page.route(`**/api/cases/${caseId}/work-review`, route => {
    const body = route.request().postDataJSON(); state.writes.push(body); expect(body.expectedOwnerId).toBe(ownerId);
    if (state.conflict || body.reviewedRevision !== state.value.revision) return fulfill(route, { code: "WORKSPACE_WORK_CHANGED" }, 409);
    state.value.items[body.index].completed = body.completed; state.value.taskRevision++; state.value.revision = require("crypto").randomBytes(32).toString("hex");
    if (state.value.completedLocked && body.completed) state.value.items[body.index].canToggle = false;
    return state.lost ? route.abort("failed") : fulfill(route, { work: state.value, changed: true });
  });
  await page.goto(`/attorney-v2.html#/matters/${caseId}/work`, { waitUntil: "domcontentloaded" }); await expect(panel(page)).toHaveAttribute("data-state", "ready"); return { state, caseId, ownerId };
}
test("marking one duplicate-title work item changes only that position and restores keyboard focus", async ({ page }) => {
  const { state } = await fixture(page), inputs = panel(page).getByRole("checkbox"); await inputs.nth(1).focus(); await inputs.nth(1).press("Space"); await expect(panel(page)).toContainText("1 of 2 work items complete"); await expect(inputs.nth(1)).toBeChecked(); await expect(inputs.nth(0)).not.toBeChecked(); await expect(inputs.nth(1)).toBeFocused(); expect(state.writes).toHaveLength(1); expect(state.writes[0].index).toBe(1);
});
test("recorded work can be reopened before withdrawal without changing its scope", async ({ page }) => {
  const { state } = await fixture(page); await panel(page).getByRole("checkbox").first().click(); await expect(panel(page)).toContainText("1 of 2 work items complete"); await panel(page).getByRole("checkbox").first().click(); await expect(panel(page)).toContainText("0 of 2 work items complete"); expect(state.writes.map(write => write.completed)).toEqual([true, false]); expect(state.value.items.map(item => item.title)).toEqual(["Review the lease", "Review the lease"]);
});
test("completed work remains locked after withdrawal and rehire", async ({ page }) => {
  const { state } = await fixture(page, { locked: true }); const inputs = panel(page).getByRole("checkbox"); await expect(inputs.first()).toBeChecked(); await expect(inputs.first()).toBeDisabled(); await expect(panel(page)).toContainText("Completed work is locked after a withdrawal and rehire."); await inputs.nth(1).click(); await expect(panel(page)).toContainText("2 of 2 work items complete"); await expect(inputs.nth(1)).toBeDisabled(); expect(state.writes).toHaveLength(1);
});
test("a stale work review cannot report a save and requires the current list before another decision", async ({ page }) => {
  const { state } = await fixture(page); state.conflict = true; await panel(page).getByRole("checkbox").first().click(); await expect(panel(page)).toContainText("The work or Matter status changed."); await expect(panel(page).getByRole("checkbox").first()).not.toBeChecked(); await expect(panel(page).getByRole("checkbox").first()).toBeDisabled(); expect(state.writes).toHaveLength(1); state.conflict = false;
  await panel(page).getByRole("button", { name: "Check saved work" }).click(); await expect(panel(page)).toContainText("Current saved status"); await expect(panel(page).getByRole("checkbox").first()).toBeEnabled();
});
test("a lost work response is checked by a fresh read without automatically repeating the update", async ({ page }) => {
  const { state } = await fixture(page, { lost: true }); await panel(page).getByRole("checkbox").first().click(); await expect(panel(page)).toContainText("could not be confirmed"); expect(state.writes).toHaveLength(1); await panel(page).getByRole("button", { name: "Check saved work" }).click(); await expect(panel(page).getByRole("checkbox").first()).toBeChecked(); await expect(panel(page)).toContainText("Current saved status"); expect(state.writes).toHaveLength(1);
});
test("closed and pending-decision work is readable without offering changes", async ({ page }) => {
  const { state } = await fixture(page, { reason: "closed" }); await expect(panel(page).getByRole("checkbox").first()).toBeDisabled(); await expect(panel(page)).toContainText("retained for reference"); state.value.reason = "decision_pending"; await panel(page).getByRole("button", { name: "Refresh work", exact: true }).click(); await expect(panel(page)).toContainText("A hiring or completion decision is being recorded."); expect(state.writes).toHaveLength(0);
});
test("access loss removes the work list and failed reads do not become an empty scope", async ({ page }) => {
  const { state, caseId } = await fixture(page); await page.route(`**/api/cases/${caseId}/work-review?**`, route => fulfill(route, {}, 503)); await panel(page).getByRole("button", { name: "Refresh work", exact: true }).click(); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page)).toContainText("Work couldn’t load."); await expect(panel(page)).not.toContainText("No work items are recorded.");
  await page.unroute(`**/api/cases/${caseId}/work-review?**`); await page.route(`**/api/cases/${caseId}/work-review?**`, route => fulfill(route, { code: "WORKSPACE_RESTRICTED" }, 403)); state.denied = true; await panel(page).getByRole("button", { name: "Refresh work", exact: true }).click(); await expect(panel(page).getByRole("checkbox")).toHaveCount(0); await expect(panel(page)).toContainText("no longer available");
});
test("background updates preserve focus and a current work decision can cancel a delayed background read", async ({ page }) => {
  await page.clock.install(); const { caseId, state } = await fixture(page); const input = () => panel(page).getByRole("checkbox").first(); await input().focus(); let release, arrived;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route(`**/api/cases/${caseId}/work-review?**`, async route => { const captured = structuredClone(state.value); arrived(); await gate; await fulfill(route, captured).catch(() => {}); });
  await page.clock.fastForward(16000);
  try { await waiting; await expect(input()).toBeEnabled(); await input().press("Space"); await expect(panel(page)).toContainText("1 of 2 work items complete"); }
  finally { release(); }
  await expect(input()).toBeChecked(); await expect(input()).toBeFocused(); expect(state.writes).toHaveLength(1);
});
test("a task link without a retained scope identifier is explicit and private tasks remain a separate destination", async ({ page }) => {
  const { caseId } = await fixture(page); await page.goto(`/attorney-v2.html#/matters/${caseId}/work?taskId=${"a".repeat(24)}`, { waitUntil: "domcontentloaded" }); await expect(panel(page)).toContainText("linked work item couldn’t be identified"); await expect(panel(page).getByRole("link", { name: "Private tasks for this Matter" })).toHaveAttribute("href", `#/tasks?caseId=${caseId}`);
});
test("long work titles and review controls remain accessible at narrow and wide widths", async ({ page }, testInfo) => {
  const { state } = await fixture(page); state.value.items[0].title = "Review the lease, its existing tenants and the original signed exhibits ".repeat(3); await panel(page).getByRole("button", { name: "Refresh work", exact: true }).click();
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect((await new AxeBuilder({ page }).include("[data-workspace-work]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); expect((await panel(page).locator("label").first().boundingBox()).height).toBeGreaterThanOrEqual(44); await page.screenshot({ path: testInfo.outputPath(`work-${width}.png`), fullPage: true }); }
});
