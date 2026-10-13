const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const panel = page => page.locator("[data-matter-receipt]"), history = page => page.locator("[data-receipt-history]"), hash = n => n.toString(16).padStart(64, "0");
const json = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
const choice = n => n === 0 ? { id: "payment", type: "payment", at: null, decision: null, amount: null, paralegalName: null, needsReview: false } : { id: hash(n), type: "withdrawal", at: new Date(1700000000000 + n * 86400000).toISOString(), decision: "partial_attorney", amount: 10000 + n, paralegalName: `Earlier paralegal ${n}`, needsReview: false };
async function fixture(page) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id, csrf = (await (await page.request.get("/api/csrf")).json()).csrfToken;
  const send = async (path, data) => { const result = await page.request.post(path, { headers: { "X-CSRF-Token": csrf }, data: { ...data, expectedOwnerId: ownerId } }); expect(result.ok(), await result.text()).toBeTruthy(); return result.json(); };
  const draft = (await send("/api/case-drafts", { title: "River Street lease review", practiceArea: "Contract Law", state: "New York", compAmount: "400", experience: "3+ years", deadline: "2027-03-14", description: "Review the retained lease records.", tasks: [{ title: "Review lease exhibits" }] })).draft;
  const caseId = (await send("/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" })).publication.caseId;
  const state = { entries: [choice(0), choice(1)], reads: [], reviews: [], downloads: [], historyStatus: 200, revision: "a".repeat(64), mismatch: false, defaultSelection: "payment" };
  const historyPath = `**/api/payments/receipt/attorney/${caseId}/history?**`;
  await page.route(historyPath, route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams); state.reads.push(query); if (state.historyStatus !== 200) return json(route, {}, state.historyStatus);
    const offset = Number(query.cursor || 0), entries = state.entries.slice(offset, offset + 25), selected = query.receiptId ? state.entries.find(item => item.id === query.receiptId) : null;
    return json(route, { caseId, ownerId, currency: "USD", revision: state.revision, total: state.entries.length, entries, nextCursor: offset + entries.length < state.entries.length ? String(offset + entries.length) : null, selected: selected || null, selection: !query.receiptId ? "none" : selected ? "found" : "unavailable" });
  });
  await page.route(`**/api/payments/receipt/attorney/${caseId}/review?**`, route => {
    const query = Object.fromEntries(new URL(route.request().url()).searchParams); state.reviews.push(query); const selected = state.entries.find(item => item.id === (query.receiptId || state.defaultSelection)); if (!selected) return json(route, { code: "RECEIPT_SELECTION_UNAVAILABLE" }, 404);
    const withdrawal = selected.type === "withdrawal";
    return json(route, { caseId, ownerId, caseTitle: "River Street lease review", reason: "available", revision: "b".repeat(64), selectionId: state.mismatch ? "wrong" : selected.id, receipt: { type: selected.type, id: withdrawal ? `tr_${selected.id}` : "pi_funding", currency: "USD", issuedAt: selected.at, dateLabel: withdrawal ? "Payout recorded" : "Payment date", status: withdrawal ? "payout_recorded" : "received", method: withdrawal ? "Stripe transfer" : "Visa ending 4242", lines: [{ label: withdrawal ? "Paralegal payout" : "Matter amount", amount: withdrawal ? 8100 : 40000 }], total: { label: withdrawal ? "Total released from Matter" : "Total paid", amount: withdrawal ? selected.amount : 48800 }, partyName: "Avery Lane", filename: withdrawal ? "River Street-withdrawal-receipt.pdf" : "River Street-payment-receipt.pdf" } });
  });
  await page.route(`**/api/payments/receipt/attorney/${caseId}?**`, route => { const query = Object.fromEntries(new URL(route.request().url()).searchParams); state.downloads.push(query); return route.fulfill({ contentType: "application/pdf", body: Buffer.from(`%PDF-1.4\nChosen receipt: ${query.receiptId || "default"}\n%%EOF\n`) }); });
  const open = async (current = false, query = "") => {
    await page.goto(current ? "/dashboard-attorney.html#cases:active" : `/attorney-v2.html#/matters/${caseId}/receipt${query}`, { waitUntil: "domcontentloaded" });
    if (current) { const actions = page.locator(`.case-actions[data-case-id="${caseId}"]:visible`).first(); await actions.locator("[data-case-menu-trigger]").click(); await actions.getByRole("button", { name: "View receipt", exact: true }).click(); }
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
  };
  const list = async () => { await history(page).getByRole("button", { name: "Choose another receipt", exact: true }).click(); await expect(history(page)).toHaveAttribute("data-state", "ready"); };
  return { state, caseId, ownerId, historyPath, open, list };
}
test("both attorney screens page receipt choices without treating decision amounts as paid", async ({ page }) => {
  const { state, open, list, ownerId } = await fixture(page); state.entries = Array.from({ length: 61 }, (_, i) => choice(i));
  for (const current of [false, true]) { await open(current); const before = state.reads.length; await list(); await expect(history(page)).toContainText("25 of 61 receipt choices shown"); await expect(history(page).getByText("Decision amounts do not confirm payouts.", { exact: true })).toHaveCount(1); await history(page).getByRole("button", { name: "More receipt choices" }).click(); await expect(history(page)).toContainText("50 of 61 receipt choices shown"); await history(page).getByRole("button", { name: "More receipt choices" }).click(); await expect(history(page)).toContainText("61 of 61 receipt choices shown"); expect(state.reads.length).toBe(before + 3); expect(state.reads.at(-1)).toMatchObject({ expectedOwnerId: ownerId, revision: "a".repeat(64), cursor: "50" }); }
  expect(state.downloads).toEqual([]);
});
test('selecting a retained receipt preserves its Matter-list return through reload', async ({ page }) => {
  const { open, list } = await fixture(page);
  const back = '#/matters?' + new URLSearchParams({ view: 'active', q: 'River Street', matterSort: 'alphabetical' });
  await open(false, '?' + new URLSearchParams({ returnTo: back })); await list();
  await history(page).locator(`[data-receipt-choice="${hash(1)}"]`).getByRole('button', { name: 'Review this receipt', exact: true }).click(); await expect(panel(page)).toHaveAttribute('data-state', 'ready');
  let query = new URLSearchParams(new URL(page.url()).hash.split('?')[1]); expect(query.get('receiptId')).toBe(hash(1)); expect(query.get('returnTo')).toBe(back);
  await page.reload(); await expect(panel(page)).toHaveAttribute('data-state', 'ready');
  await page.getByRole('link', { name: 'Back to Matters', exact: true }).click(); await expect(page.locator('[data-av2-region="matter-list"]')).toHaveAttribute('data-state', 'ready'); expect(new URL(page.url()).hash).toBe(back);
});
test("an earlier choice keeps an exact URL through refresh and downloads that receipt's actual bytes", async ({ page }) => {
  const { state, caseId, open, list } = await fixture(page); state.entries = Array.from({ length: 61 }, (_, i) => choice(i)); await open(); await list(); await history(page).getByRole("button", { name: "More receipt choices" }).click(); await expect(history(page)).toContainText("50 of 61 receipt choices shown"); await history(page).locator(`[data-receipt-choice="${hash(49)}"]`).getByRole("button", { name: "Review this receipt" }).click(); await expect(page).toHaveURL(new RegExp(`receipt\\?receiptId=${hash(49)}$`)); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("$100.49");
  await page.reload(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); expect(state.reviews.at(-1).receiptId).toBe(hash(49)); const pending = page.waitForEvent("download"); await panel(page).getByRole("button", { name: "Download receipt", exact: true }).click(); const download = await pending, stream = await download.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk); expect(Buffer.concat(chunks).toString()).toContain(`Chosen receipt: ${hash(49)}`); expect(download.suggestedFilename()).toBe("River Street-withdrawal-receipt.pdf"); expect(state.downloads.at(-1)).toMatchObject({ receiptId: hash(49), revision: "b".repeat(64) });
  await list(); await expect(history(page)).toContainText("26 of 61 receipt choices shown"); expect(await history(page).locator(`[data-receipt-choice="${hash(49)}"]`).count()).toBe(1); expect(page.url()).toContain(caseId);
});
test("the current receipt dialog can choose original funding after a withdrawal without leaving the dialog", async ({ page }) => {
  const { state, open, list } = await fixture(page); state.defaultSelection = hash(1); await open(true); await expect(page.locator("#caseNoteModalTitle")).toHaveText("Withdrawal receipt"); await list(); await history(page).locator('[data-receipt-choice="payment"]').getByRole("button", { name: "Review this receipt" }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("Total paid"); await expect(page.locator("#caseNoteModal")).toBeVisible(); expect(state.reviews.at(-1).receiptId).toBe("payment");
});
test("a different receipt response cannot be adopted for the exact link", async ({ page }) => {
  const { state, caseId } = await fixture(page); state.mismatch = true; await page.goto(`/attorney-v2.html#/matters/${caseId}/receipt?receiptId=${hash(1)}`); await expect(panel(page)).toHaveAttribute("data-state", "error"); await expect(panel(page).getByRole("button", { name: "Download receipt", exact: true })).toBeHidden(); expect(state.downloads).toEqual([]);
});
test("failed or changed history pages clear choices and preserve an explicit recovery", async ({ page }) => {
  const { state, open, list } = await fixture(page); state.entries = Array.from({ length: 31 }, (_, i) => choice(i)); await open(); await list(); state.revision = "f".repeat(64); await history(page).getByRole("button", { name: "More receipt choices" }).click(); await expect(history(page)).toContainText("changed or needs review"); await expect(history(page).locator("[data-receipt-choice]")).toHaveCount(0);
  state.historyStatus = 503; await history(page).getByRole("button", { name: "Refresh receipt history" }).click(); await expect(history(page)).toContainText("Receipt history couldn’t load"); await expect(history(page)).not.toContainText("No receipt"); state.historyStatus = 200; await history(page).getByRole("button", { name: "Refresh receipt history" }).click(); await expect(history(page)).toContainText("25 of 31 receipt choices shown");
});
test("unknown and malformed exact links recover through the actual receipt choices", async ({ page }) => {
  const { caseId, list } = await fixture(page);
  for (const receiptId of [hash(99), "invalid"]) { await page.goto(`/attorney-v2.html#/matters/${caseId}/receipt?receiptId=${receiptId}`); await expect(panel(page)).toContainText("linked receipt choice is no longer recorded"); await list(); await history(page).locator('[data-receipt-choice="payment"]').getByRole("button", { name: "Review this receipt" }).click(); await expect(panel(page)).toHaveAttribute("data-state", "ready"); await expect(panel(page)).toContainText("$488.00"); }
});
test("an account change while history arrives clears both its choices and the earlier receipt", async ({ page }) => {
  const { historyPath, open } = await fixture(page); await open(); let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(historyPath, async route => { arrived(); await gate; await route.fallback().catch(() => {}); }); await history(page).getByRole("button", { name: "Choose another receipt" }).click();
  try { await waiting; await page.route("**/api/auth/me", route => json(route, { user: { id: "f".repeat(24), role: "attorney", status: "approved" } })); } finally { release(); }
  await expect(panel(page)).toHaveCount(0);
});
test("canceling and leaving receipt history discards a delayed response", async ({ page }) => {
  const { historyPath, open } = await fixture(page); await open(); let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route(historyPath, async route => { arrived(); await gate; await route.fallback().catch(() => {}); }); await history(page).getByRole("button", { name: "Choose another receipt" }).click();
  try { await waiting; await history(page).getByRole("button", { name: "Cancel receipt history request" }).click(); await expect(history(page)).toContainText("Receipt history request canceled"); await page.getByRole("link", { name: "Back to Matters", exact: true }).click(); } finally { release(); }
  await expect(panel(page)).toHaveCount(0);
});
for (const current of [false, true]) test(`receipt-history labels and controls fit phone and desktop layouts and remain keyboard accessible: ${current ? "current" : "v2"}`, async ({ page }, testInfo) => {
  const { state, open, list } = await fixture(page); state.entries[1].paralegalName = '<img src=x onerror="window.receiptHistoryXss=true"> Long retained paralegal name '.repeat(4);
  await open(current); await list(); for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); await history(page).scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => window.receiptHistoryXss)).toBeUndefined(); expect((await new AxeBuilder({ page }).include("[data-receipt-history]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await page.screenshot({ path: testInfo.outputPath(`${current ? "current" : "v2"}-receipt-history-${width}.png`), fullPage: true }); } await history(page).getByRole("button", { name: "Refresh receipt history" }).focus(); await page.keyboard.press("Enter"); await expect(history(page)).toHaveAttribute("data-state", "ready");
});
