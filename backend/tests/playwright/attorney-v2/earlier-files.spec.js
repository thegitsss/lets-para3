const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const root = page => page.locator("[data-earlier-files]"), hash = n => n.toString(16).padStart(64, "0");
const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const entry = (n, patch = {}) => ({ id: hash(n), revision: "b".repeat(64), name: `Earlier lease exhibit ${n}.txt`, kind: "earlier_attachment", recordedAt: null, size: null, version: null, available: true, ...patch });
async function fixture(page) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id, csrf = (await (await page.request.get("/api/csrf")).json()).csrfToken;
  const send = async (path, data) => { const response = await page.request.post(path, { headers: { "X-CSRF-Token": csrf }, data: { ...data, expectedOwnerId: ownerId } }); expect(response.ok(), await response.text()).toBeTruthy(); return response.json(); };
  const draft = (await send("/api/case-drafts", { title: "River Street lease records", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Review the lease and retained exhibits.", tasks: [{ title: "Review the lease" }] })).draft;
  const published = await send("/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" }), caseId = published.publication.caseId;
  const state = { entries: [entry(1), entry(2, { kind: "removed_document_history" })], reads: [], downloads: [], readStatus: 200, downloadStatus: 200, revision: "a".repeat(64), access: "available" };
  await page.route(`**/api/cases/${caseId}/files/review?**`, route => json(route, { caseId, ownerId, caseTitle: "River Street lease records", access: "available", files: [], nextCursor: null, selectedFile: null, selection: "none", canUpload: false, legacyAttachments: true }));
  await page.route(`**/api/cases/${caseId}/earlier-files?**`, route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams); state.reads.push(query); if (state.readStatus !== 200) return json(route, {}, state.readStatus);
    const cursor = Number(query.cursor || 0), available = state.access === "available", entries = available ? state.entries.slice(cursor, cursor + 50) : [], selected = available && query.referenceId ? state.entries.find(entry => entry.id === query.referenceId) : null;
    return json(route, { caseId, ownerId, access: state.access, revision: state.revision, total: available ? state.entries.length : 0, entries, nextCursor: available && cursor + entries.length < state.entries.length ? String(cursor + entries.length) : null, selected: selected || null, selection: !query.referenceId ? "none" : selected ? "found" : "unavailable" });
  });
  await page.route(`**/api/cases/${caseId}/earlier-files/*/download?**`, route => { state.downloads.push(Object.fromEntries(new URL(route.request().url()).searchParams)); return state.downloadStatus === 200 ? route.fulfill({ contentType: "application/octet-stream", body: "Earlier legal document\n" }) : json(route, {}, state.downloadStatus); });
  await page.goto(`/attorney-v2.html#/matters/${caseId}/files`, { waitUntil: "domcontentloaded" }); await expect(page.locator("[data-workspace-files]")).toHaveAttribute("data-state", "ready");
  const open = async () => { await root(page).getByRole("button", { name: "View earlier files", exact: true }).click(); await expect(root(page)).toHaveAttribute("data-state", "ready"); };
  return { state, caseId, ownerId, open };
}
test("earlier attachment and removal history are clearly identified without fabricated versions or immediate storage requests", async ({ page }) => {
  const { state, open } = await fixture(page); expect(state.reads).toEqual([]); await open(); await expect(root(page)).toContainText("2 of 2 earlier file records shown"); await expect(root(page)).toContainText("History retained after document removal"); await expect(root(page)).toContainText("original filename, size and version number may not have been recorded"); await expect(root(page)).not.toContainText("Version 1"); expect(state.downloads).toEqual([]);
});
test("earlier files page against the same inventory revision and preserve exact selected download bytes", async ({ page }) => {
  const { state, open, ownerId } = await fixture(page); state.entries = Array.from({ length: 65 }, (_, i) => entry(i + 1)); await open(); await root(page).getByRole("button", { name: "More earlier files" }).click(); await expect(root(page).locator("[data-earlier-file]")).toHaveCount(65); expect(state.reads.at(-1)).toMatchObject({ cursor: "50", revision: "a".repeat(64), expectedOwnerId: ownerId });
  const transfer = page.waitForEvent("download"); await root(page).locator("[data-earlier-file]").last().getByRole("button", { name: "Download earlier file" }).click(); const result = await transfer, stream = await result.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk); expect(Buffer.concat(chunks).toString()).toBe("Earlier legal document\n"); expect(result.suggestedFilename()).toBe("Earlier lease exhibit 65.txt"); expect(state.downloads).toEqual([{ expectedOwnerId: ownerId, revision: "b".repeat(64) }]);
});
test("an exact older link opens beyond the first page and a removed reference has a clear unavailable result", async ({ page }) => {
  const { state, caseId } = await fixture(page); state.entries = Array.from({ length: 65 }, (_, i) => entry(i + 1)); await page.goto(`/attorney-v2.html#/matters/${caseId}/files?earlierFileId=${hash(65)}`); await expect(root(page)).toHaveAttribute("data-state", "ready"); await expect(root(page).locator(`[data-earlier-file="${hash(65)}"]`)).toBeVisible(); await expect(root(page)).toContainText("Earlier lease exhibit 65.txt"); await expect(root(page)).toContainText("51 of 65 earlier file records shown");
  await page.goto(`/attorney-v2.html#/matters/${caseId}/files?earlierFileId=${hash(99)}`); await expect(root(page)).toContainText("linked earlier file is no longer available");
});
test("unverified references offer an explanation while terminal Matters point to the retained archive", async ({ page }) => {
  const { state, open, caseId } = await fixture(page); state.entries = [entry(1, { available: false })]; await open(); await expect(root(page)).toContainText("stored reference needs review"); await expect(root(page).getByRole("button", { name: "Download earlier file" })).toHaveCount(0);
  state.access = "archive_only"; await root(page).getByRole("button", { name: "Refresh earlier files" }).click(); await expect(root(page).getByRole("link", { name: "Review Matter archive" })).toHaveAttribute("href", `#/matters/${caseId}/export`); await expect(root(page)).not.toContainText("No separate earlier attachments"); expect(state.downloads).toEqual([]);
});
test("read and page conflicts clear outdated selections and never report an empty history", async ({ page }) => {
  const { state, open } = await fixture(page); await open(); state.readStatus = 503; await root(page).getByRole("button", { name: "Refresh earlier files" }).click(); await expect(root(page)).toContainText("Earlier Matter files couldn’t load"); await expect(root(page).locator("[data-earlier-file]")).toHaveCount(0); await expect(root(page)).not.toContainText("No separate earlier attachments");
  state.readStatus = 200; state.entries = Array.from({ length: 65 }, (_, i) => entry(i + 1)); await root(page).getByRole("button", { name: "Refresh earlier files" }).click(); await expect(root(page)).toContainText("50 of 65 earlier file records shown"); await expect(root(page)).toHaveAttribute("data-state", "ready"); state.revision = "f".repeat(64); await root(page).getByRole("button", { name: "More earlier files" }).click(); await expect(root(page)).toContainText("records changed or need review"); await expect(root(page).locator("[data-earlier-file]")).toHaveCount(0);
});
test("changed download references require a refreshed list before another transfer", async ({ page }) => {
  const { state, open } = await fixture(page); await open(); state.downloadStatus = 409; await root(page).locator("[data-earlier-file]").first().getByRole("button", { name: "Download earlier file" }).click(); await expect(root(page)).toContainText("records changed or need review"); await expect(root(page).getByRole("button", { name: "Download earlier file" })).toHaveCount(0); expect(state.downloads).toHaveLength(1);
});
test("account changes clear earlier metadata before a download request", async ({ page }) => {
  const { state, open } = await fixture(page); await open(); await page.route("**/api/auth/me", route => json(route, { user: { id: "f".repeat(24), role: "attorney", status: "approved" } })); await root(page).locator("[data-earlier-file]").first().getByRole("button", { name: "Download earlier file" }).click(); await expect(root(page)).toHaveCount(0); expect(state.downloads).toEqual([]);
});
test("cancellation and navigation prevent late earlier-file responses from returning to the page", async ({ page }) => {
  const { caseId } = await fixture(page); let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/cases/${caseId}/earlier-files?**`, async route => { arrived(); await gate; await route.fallback().catch(() => {}); });
  await root(page).getByRole("button", { name: "View earlier files" }).click();
  try { await waiting; await root(page).getByRole("button", { name: "Cancel earlier-file request" }).click(); await expect(root(page)).toContainText("Earlier-file request canceled"); await page.getByRole("navigation", { name: "Matter sections" }).getByRole("link", { name: "Work", exact: true }).click(); } finally { release(); }
  await expect(root(page)).toHaveCount(0);
});
test("long retained labels, downloads and error text fit phone and desktop widths without injecting markup", async ({ page }, testInfo) => {
  const { state, open } = await fixture(page); state.entries[0].name = '<img src=x onerror="window.earlierFileXss=true"> Lease exhibits '.repeat(6); await open();
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => window.earlierFileXss)).toBeUndefined(); expect((await new AxeBuilder({ page }).include("[data-earlier-files]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await page.screenshot({ path: testInfo.outputPath(`earlier-files-${width}.png`), fullPage: true }); }
});
