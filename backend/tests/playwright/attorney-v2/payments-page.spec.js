const { test, expect } = require("../support-session-fixture"), AxeBuilder = require("@axe-core/playwright").default;
const id = n => n.toString(16).padStart(24, "0"), records = page => page.locator("[data-payment-records]"), root = page => page.locator("[data-payments-page]");
const fulfill = (route, value, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
async function fixture(page, count = 3, { openReceipts = true } = {}) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const card = { id: "pm_synthetic", type: "card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 };
  const state = { reads: [], writes: [], status: 200, cardStatus: 200, card, pending: null, portalStatus: 200, portalUrl: "https://billing.stripe.com/p/session/test_synthetic", rows: [] };
  state.rows = Array.from({ length: count }, (_, n) => ({ id: id(count - n), title: `River Street lease ${count - n}`, paralegalName: "Priya Ng", matterStatus: "in progress", archived: false, currency: "USD", matterAmount: 60001 + n, funding: "recorded", fundingVerifiedAt: "2026-01-02T00:00:00.000Z", release: n % 2 ? "recorded" : "not_recorded", releasedAt: n % 2 ? "2026-02-02T00:00:00.000Z" : null, withdrawal: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }));
  await page.route("**/api/payments/payment-method/default?**", route => fulfill(route, state.cardStatus === 200 ? { hasDefault: Boolean(state.card), customerId: "cus_synthetic", paymentMethod: state.card } : {}, state.cardStatus));
  await page.route("**/api/users/me/pending-hire?**", route => fulfill(route, { ownerId, revision: "a".repeat(64), pending: state.pending }));
  await page.route("**/api/payments/attorney-records?**", route => {
    const query = new URL(route.request().url()).searchParams; state.reads.push(Object.fromEntries(query)); if (state.status !== 200) return fulfill(route, {}, state.status);
    const view = query.get("view") || "all", q = query.get("q") || ""; let rows = state.rows.filter(row => row.title.toLowerCase().includes(q.toLowerCase()) && (view === "released" ? row.release === "recorded" : view === "unreleased" ? row.release !== "recorded" : view === "withdrawal" ? Boolean(row.withdrawal) : true)); const total = rows.length;
    if (query.get("cursor")) rows = rows.filter(row => row.id < query.get("cursor")); const selected = state.rows.find(row => row.id === query.get("caseId")) || null;
    return fulfill(route, { ownerId, view, q, total, items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null, selected, selection: !query.has("caseId") ? "none" : selected ? "found" : "unavailable" });
  });
  await page.route("**/api/payments/portal/attorney", route => { state.writes.push(route.request().postDataJSON()); return state.portalStatus === 0 ? route.abort("failed") : fulfill(route, { ownerId, url: state.portalUrl }, state.portalStatus); });
  await page.goto("/attorney-v2.html#/payments", { waitUntil: "domcontentloaded" }); await expect(records(page)).toHaveAttribute("data-state", "ready");
  await expect(records(page).locator('details')).not.toHaveAttribute('open', '');
  if (openReceipts) await records(page).locator('summary').click();
  return { state, ownerId };
}
test('receipt lookup starts closed, opens by keyboard, preserves filters and exposes unavailable reads', async ({ page }) => {
  const { state } = await fixture(page, 125, { openReceipts: false });
  const lookup = records(page), summary = lookup.locator('summary');
  await expect(lookup.getByRole('heading', { name: 'Receipts by Matter', exact: true })).toHaveCount(1);
  await expect(lookup.locator('form')).toBeHidden();
  await summary.focus(); await summary.press('Enter'); await expect(lookup.locator('form')).toBeVisible();
  await lookup.getByLabel('Matter title', { exact: true }).fill('lease 125');
  await lookup.getByRole('button', { name: 'Filter payment records' }).click();
  await expect(lookup).toContainText('1 of 1 Matter shown');
  await summary.click(); await expect(lookup.locator('form')).toBeHidden();
  await summary.press('Space'); await expect(lookup.getByLabel('Matter title', { exact: true })).toHaveValue('lease 125');
  await expect(lookup.locator('[data-payment-case]')).toHaveCount(1);
  state.status = 503; await page.reload();
  await expect(records(page)).toHaveAttribute('data-state', 'error');
  await expect(records(page).locator('[role=status]')).toBeVisible();
  await expect(records(page).locator('[data-payment-case]')).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
test("Payments has actual card controls and exact Matter and receipt destinations", async ({ page }) => {
  const { state } = await fixture(page); await expect(root(page)).toContainText("visa ending in 4242"); await expect(root(page)).not.toContainText("Navigation preview"); await expect(records(page)).toContainText("$600.01"); const first = records(page).locator(`[data-payment-case="${id(3)}"]`); await expect(first.getByRole("link", { name: "Review Matter receipts", exact: true })).toHaveAttribute("href", `#/matters/${id(3)}/receipt`); await expect(first.getByRole("link", { name: "Open Matter", exact: true })).toHaveAttribute("href", `#/matters/${id(3)}/overview`);
  await root(page).getByRole("link", { name: "Manage card" }).click(); await expect(page.locator("[data-payment-setup]")).toBeVisible(); await page.getByRole("link", { name: "Return to Payments", exact: true }).click(); await expect(records(page)).toHaveAttribute("data-state", "ready"); expect(state.writes).toEqual([]);
});
test("payment lists page beyond 100 Matters and preserve exact earlier highlight links", async ({ page }) => {
  await fixture(page, 125); await expect(records(page)).toContainText("125 Matters"); await expect(records(page).locator("[data-payment-case]")).toHaveCount(50); await records(page).getByRole("button", { name: "Show more payment records" }).click(); await expect(records(page).locator("[data-payment-case]")).toHaveCount(100); await records(page).getByRole("button", { name: "Show more payment records" }).click(); await expect(records(page).locator("[data-payment-case]")).toHaveCount(125);
  await page.goto(`/attorney-v2.html#/payments?highlightCase=${id(1)}`, { waitUntil: "domcontentloaded" }); await expect(records(page)).toHaveAttribute("data-state", "ready"); await expect(records(page).locator(`[data-payment-case="${id(1)}"]`)).toBeFocused(); await expect(records(page)).toContainText("Linked Matter");
});
test("filters have honest counts and unavailable reads remove earlier payment amounts", async ({ page }) => {
  const { state } = await fixture(page, 125); await records(page).getByLabel("Payment records", { exact: true }).selectOption("released"); await records(page).getByRole("button", { name: "Filter payment records" }).click(); await expect(records(page)).toContainText("62 Matters"); await records(page).getByLabel("Matter title", { exact: true }).fill("NO_MATCH"); await records(page).getByRole("button", { name: "Filter payment records" }).click(); await expect(records(page)).toContainText("No Matters match");
  state.status = 503; await records(page).getByRole("button", { name: "Filter payment records" }).click(); await expect(records(page)).toHaveAttribute("data-state", "error"); await expect(records(page)).not.toContainText("No Matters match"); await expect(records(page).locator("[data-payment-case]")).toHaveCount(0);
});
test("recorded payout reversals, withdrawal amounts and unknown amounts never become a paid-in-full total", async ({ page }) => {
  const { state } = await fixture(page); state.rows[0] = { ...state.rows[0], release: "reversed", earlierWithdrawals: 2, withdrawal: { at: "2026-03-01T00:00:00.000Z", amount: 15001, decision: "partial_attorney" } }; state.rows[1] = { ...state.rows[1], currency: null, matterAmount: null }; await records(page).getByRole("button", { name: "Filter payment records" }).click(); await expect(records(page)).toContainText("Payout reversed"); await expect(records(page)).toContainText("$150.01"); await expect(records(page)).toContainText("2 earlier withdrawal decisions recorded"); await expect(records(page)).toContainText("Amount needs review"); await expect(records(page)).not.toContainText("Paid in full");
});
test("the saved application return appears only when one is actually saved", async ({ page }) => {
  const { state } = await fixture(page); await expect(root(page).locator("[data-payment-hiring-return]")).toBeHidden(); state.pending = { state: "available", caseId: id(12), paralegalId: id(13), caseTitle: "Original hiring Matter", paralegalName: "Priya Ng" }; await page.reload(); await expect(root(page).getByRole("link", { name: "Return to this application", exact: true })).toHaveAttribute("href", `#/matters/${id(12)}/applications?applicantId=${id(13)}`);
});
test("billing requires its explicit handoff and returns to the actual Payments page", async ({ page }) => {
  const { state, ownerId } = await fixture(page); const returnUrl = page.url().replace("#/payments", "#/payments?billing=return"); await page.route(state.portalUrl, route => route.fulfill({ status: 200, contentType: "text/html", body: `<title>Synthetic Stripe billing</title><a href="${returnUrl}">Return to Payments</a>` }));
  await root(page).getByRole("button", { name: "Open Stripe billing", exact: true }).click(); expect(state.writes).toEqual([]); await root(page).getByRole("button", { name: "Stay in Payments" }).click(); expect(state.writes).toEqual([]); await root(page).getByRole("button", { name: "Open Stripe billing", exact: true }).click(); await root(page).getByRole("button", { name: "Continue to Stripe", exact: true }).click(); await expect(page).toHaveURL(state.portalUrl); expect(state.writes).toHaveLength(1); expect(state.writes[0].expectedOwnerId).toBe(ownerId); await page.getByRole("link", { name: "Return to Payments" }).click(); await expect(records(page)).toHaveAttribute("data-state", "ready"); await expect(root(page)).toContainText("current saved card");
});
test("unknown billing outcomes retry the same request and unsafe redirects stay on Payments", async ({ page }) => {
  const { state } = await fixture(page); state.portalStatus = 0; await root(page).getByRole("button", { name: "Open Stripe billing", exact: true }).click(); await root(page).getByRole("button", { name: "Continue to Stripe", exact: true }).click(); await expect(root(page)).toContainText("Stripe billing couldn’t open"); state.portalStatus = 200; state.portalUrl = "https://outside.test/private"; await root(page).getByRole("button", { name: "Try opening billing again" }).click(); await expect(root(page)).toContainText("Stripe billing couldn’t open"); expect(state.writes).toHaveLength(2); expect(state.writes[1].requestId).toBe(state.writes[0].requestId); await expect(page).toHaveURL(/#\/payments$/);
});
test("account protection discards a late payment list and card failure is not an empty saved card", async ({ page }) => {
  const { state } = await fixture(page); state.cardStatus = 503; await page.reload(); await expect(records(page)).toHaveAttribute("data-state", "ready"); await records(page).locator("summary").click(); await expect(root(page)).toContainText("saved card couldn’t be checked"); await expect(root(page)).not.toContainText("No default payment card is saved");
  let arrived, release; const waiting = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; }); await page.route("**/api/payments/attorney-records?**", async route => { arrived(); await gate; await fulfill(route, { privateData: "PRIVATE_LATE_PAYMENT" }).catch(() => {}); }); await records(page).getByRole("button", { name: "Filter payment records" }).click();
  try { await waiting; await page.route("**/api/auth/me", route => fulfill(route, { user: { id: id(777), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(root(page)).toHaveCount(0); } finally { release(); } await expect(page.locator("body")).not.toContainText("PRIVATE_LATE_PAYMENT");
});
test("payment filters and long Matter records remain safe and accessible at phone and desktop widths", async ({ page }, testInfo) => {
  const { state } = await fixture(page); state.rows[0].title = '<img src=x onerror="window.paymentXss=true"> River Street lease '.repeat(4); await records(page).getByRole("button", { name: "Filter payment records" }).click(); await expect(records(page)).toHaveAttribute("data-state", "ready");
  for (const width of [320, 390, 768, 1366]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect(await page.evaluate(() => window.paymentXss)).toBeUndefined(); expect((await new AxeBuilder({ page }).include("[data-payments-page]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await records(page).getByLabel("Matter title", { exact: true }).focus(); await expect(records(page).getByLabel("Matter title", { exact: true })).toBeFocused(); await page.screenshot({ path: testInfo.outputPath(`payments-${width}.png`), fullPage: true }); }
});
