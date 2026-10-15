const { test, expect } = require("../support-session-fixture");
const AxeBuilder = require("@axe-core/playwright").default;
const fulfill = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const payment = page => page.getByRole("region", { name: "Payment card details", exact: true });
const savedReturn = page => page.locator("[data-hiring-return]");
let para, paraId;
async function api(client, method, path, data) {
  const csrf = await (await client.get("/api/csrf")).json(), user = (await (await client.get("/api/auth/me")).json()).user;
  const response = await client[method](path, { headers: { "X-CSRF-Token": csrf.csrfToken }, ...(data ? { data: { ...data, expectedOwnerId: user.id || user._id } } : {}) });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy(); return response.json();
}
async function application(page) {
  const fields = { title: "Synthetic card setup return", practiceArea: "Contract Law", state: "New York", compAmount: "400.01", experience: "3+ years", deadline: "2027-03-14", description: "Synthetic payment return verification", tasks: [{ title: "Prepare agreement" }] };
  const draft = (await api(page.request, "post", "/api/case-drafts", fields)).draft;
  const { publication } = await api(page.request, "post", "/api/cases/posting/publications", { draftId: draft.id, revision: draft.revision, requestId: require("crypto").randomUUID(), practiceArea: "contract law" });
  await api(page.request, "post", `/api/cases/${publication.caseId}/invite/${paraId}`, {}); await api(para, "post", `/api/cases/${publication.caseId}/invite/accept`, {}); return publication.caseId;
}
test.beforeAll(async ({ playwright, baseURL }) => {
  para = await playwright.request.newContext({ baseURL });
  const headers = process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET ? { "x-ai-control-room-e2e-secret": process.env.AI_CONTROL_ROOM_E2E_HARNESS_SECRET } : {};
  const bootstrap = await para.post("/api/admin/ai-control-room/dev/e2e/bootstrap-paralegal", { headers }); expect(bootstrap.ok()).toBeTruthy(); const payload = await bootstrap.json();
  const csrf = await (await para.get("/api/csrf")).json();
  const login = await para.post("/api/auth/login", { headers: { "X-CSRF-Token": csrf.csrfToken }, data: { email: payload.paralegal.email, password: process.env.CONTROL_ROOM_E2E_SUPPORT_PARALEGAL_PASSWORD || "ControlRoomSupport123!" } }); expect(login.ok(), await login.text()).toBeTruthy();
  const user = (await (await para.get("/api/auth/me")).json()).user; paraId = user.id || user._id;
});
test.afterAll(async () => para?.dispose());


async function mockCards(page, { lost = false, status = "succeeded", defaultFailure = false } = {}) {
  const user = (await (await page.request.get("/api/auth/me")).json()).user, ownerId = user.id || user._id;
  const card = { id: "pm_synthetic", type: "card", brand: "visa", last4: "4242", exp_month: 12, exp_year: 2029 };
  const record = { saves: 0, starts: 0, defaultCard: null, status, ownerId };
  await page.route("**/api/payments/config", route => fulfill(route, { publishableKey: "pk_test_synthetic" }));
  await page.route("**/api/payments/payment-method/default**", route => {
    if (route.request().method() === "POST") { record.saves++; record.defaultCard = card; return lost ? route.abort("failed") : fulfill(route, { ok: true, paymentMethod: card }); }
    return defaultFailure ? fulfill(route, { error: "Synthetic provider unavailable" }, 502) : fulfill(route, { hasDefault: !!record.defaultCard, paymentMethod: record.defaultCard });
  });
  await page.route("**/api/payments/payment-method/setup-intent", route => { record.starts++; expect(route.request().headers()["idempotency-key"]).toBeTruthy(); return fulfill(route, { clientSecret: "seti_synthetic_secret_synthetic", intentId: "seti_synthetic" }); });
  await page.route("**/api/payments/payment-method/setup-intent/seti_synthetic?**", route => fulfill(route, { ownerId, intentId: "seti_synthetic", status: record.status, paymentMethod: record.status === "succeeded" ? card : null }));
  await page.addInitScript(() => {
    window.syntheticStripe = { confirmations: 0, destroyed: 0 };
    window.Stripe = () => ({ elements: () => ({ create: () => {
      const events = {}; let host;
      return { on: (type, handler) => { events[type] = handler; }, mount: target => { host = target; const label = document.createElement("label"), input = document.createElement("input"); label.textContent = "Synthetic provider card entry"; label.append(input); input.addEventListener("input", () => events.change?.({ complete: input.value === "4242", empty: !input.value })); host.append(label); events.ready?.(); }, destroy: () => { window.syntheticStripe.destroyed++; host?.replaceChildren(); } };
    } }), confirmSetup: async options => { window.syntheticStripe.confirmations++; window.syntheticStripe.returnUrl = options.confirmParams.return_url; return { setupIntent: { id: "seti_synthetic", status: "succeeded" } }; } });
  });
  return record;
}
async function open(page, url = "/attorney-v2.html#/payments/setup") { await page.goto(url, { waitUntil: "domcontentloaded" }); await expect(payment(page)).toHaveAttribute("data-state", "ready"); }
async function verify(page) { await payment(page).getByRole("button", { name: "Add a payment card", exact: true }).click(); await page.getByLabel("Synthetic provider card entry").fill("4242"); await payment(page).getByRole("button", { name: "Verify card", exact: true }).click(); await expect(payment(page)).toHaveAttribute("data-state", "ready"); }

test("card setup preserves the exact application until the attorney returns and clears it", async ({ page }) => {
  const record = await mockCards(page), id = await application(page);
  await page.goto(`/attorney-v2.html#/matters/${id}/applications?applicantId=${paraId}`); await savedReturn(page).getByRole("button", { name: "Review card setup", exact: true }).click(); await expect(savedReturn(page)).toHaveAttribute('data-state', 'ready');
  if (await savedReturn(page).getByRole('button', { name: 'Add payment card', exact: true }).count()) await savedReturn(page).getByRole('button', { name: 'Add payment card', exact: true }).click();
  else {
    await expect(savedReturn(page)).toContainText('Another application is saved for card setup.');
    await savedReturn(page).getByRole('button', { name: 'Continue with this applicant', exact: true }).click(); await savedReturn(page).getByRole('button', { name: 'Continue to card setup', exact: true }).click();
  }
  await expect(payment(page)).toHaveAttribute("data-state", "ready");
  await expect(savedReturn(page)).toContainText("Synthetic card setup return"); await verify(page); expect(record.saves).toBe(0); await expect(payment(page)).toContainText("ending in 4242");
  await payment(page).getByRole("button", { name: "Set this card as default", exact: true }).click(); await expect(payment(page)).toHaveAttribute("data-state", "ready"); expect(record.saves).toBe(1); expect(record.starts).toBe(1);
  await expect(savedReturn(page).getByRole("link", { name: "Return to this application", exact: true })).toHaveAttribute("href", `#/matters/${id}/applications?applicantId=${paraId}`);
  await savedReturn(page).getByRole("link", { name: "Return to this application", exact: true }).click(); await expect(page.locator(`[data-application="${paraId}"]`)).toHaveAttribute("open", ""); await savedReturn(page).getByRole("button", { name: "Review card setup", exact: true }).click(); await expect(savedReturn(page)).toHaveAttribute("data-state", "ready");
  await savedReturn(page).getByRole("button", { name: "Clear saved application", exact: true }).click(); await savedReturn(page).getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(savedReturn(page).getByRole("button", { name: "Add payment card", exact: true })).toBeVisible(); await expect(savedReturn(page).getByRole("button", { name: "Clear saved application", exact: true })).toHaveCount(0);
  expect((await api(page.request, 'get', '/api/users/me/pending-hire?expectedOwnerId=' + (await (await page.request.get('/api/auth/me')).json()).user.id)).pending).toBeNull();
});
test("an unavailable provider read cannot become an empty card state or a new setup", async ({ page }) => {
  const record = await mockCards(page, { defaultFailure: true }); await page.goto("/attorney-v2.html#/payments/setup"); await expect(payment(page)).toHaveAttribute("data-state", "error"); await expect(payment(page)).not.toContainText("No default payment card is saved."); await expect(payment(page).getByRole("button", { name: "Add a payment card", exact: true })).toBeHidden(); expect(record.starts).toBe(0);
});
test("a lost default-card response is checked without sending the save again", async ({ page }) => {
  const record = await mockCards(page, { lost: true }); await open(page); await verify(page); await payment(page).getByRole("button", { name: "Set this card as default", exact: true }).click(); await expect(payment(page)).toHaveAttribute("data-state", "uncertain");
  await page.getByRole("link", { name: "Home", exact: true }).click(); await page.goBack(); await expect(payment(page)).toHaveAttribute("data-state", "ready"); await expect(payment(page).getByText(/ending in 4242/)).toHaveCount(1); await expect(payment(page).getByRole("button", { name: "Set this card as default", exact: true })).toHaveCount(0); expect(record.saves).toBe(1); expect(record.starts).toBe(1);
});
test("provider returns discard URL credentials and require explicit default-card selection", async ({ page }) => {
  const record = await mockCards(page); const requests = []; page.on("request", req => { if (req.url().includes("/api/")) requests.push(req.headers().referer || ""); });
  await open(page, "/attorney-v2.html?setup_intent=seti_synthetic&setup_intent_client_secret=synthetic-private&redirect_status=succeeded#/home"); expect(new URL(page.url()).search).toBe(""); await expect(payment(page).getByRole("button", { name: "Set this card as default", exact: true })).toBeVisible(); expect(record.saves).toBe(0); expect(record.starts).toBe(0); expect(requests.some(value => value.includes("synthetic-private"))).toBe(false);
});
test("an incomplete provider setup cannot become a saved card", async ({ page }) => {
  const record = await mockCards(page, { status: "processing" }); await open(page, "/attorney-v2.html?setup_intent=seti_synthetic&redirect_status=succeeded#/payments/setup"); await expect(payment(page)).toContainText("still processing"); await expect(payment(page).getByRole("button", { name: "Set this card as default", exact: true })).toHaveCount(0); expect(record.saves).toBe(0);
});
test("account replacement destroys card entry before leaving the protected page", async ({ page }) => {
  await mockCards(page); await open(page); await payment(page).getByRole("button", { name: "Add a payment card", exact: true }).click(); await page.getByLabel("Synthetic provider card entry").fill("4242");
  await page.route("**/api/auth/me", route => fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); const destroyed = await page.evaluate(() => { window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" })); return window.syntheticStripe.destroyed; }); await expect(page.locator("[data-payment-setup]")).toHaveCount(0); expect(destroyed).toBeGreaterThan(0);
});
test("verified card and default choice remain readable with keyboard controls at narrow and wide widths", async ({ page }, testInfo) => {
  await mockCards(page); await open(page); await verify(page);
  for (const width of [320, 1366]) { await page.setViewportSize({ width, height: 900 }); const control = payment(page).getByRole("button", { name: "Set this card as default", exact: true }); await control.scrollIntoViewIfNeeded(); await control.focus(); await expect(control).toBeFocused(); expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); expect((await new AxeBuilder({ page }).include("[data-payment-setup]").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]); await page.screenshot({ path: testInfo.outputPath(`payment-card-${width}.png`), fullPage: true }); }
});
test("closing incomplete card entry destroys the form without verifying or saving a card", async ({ page }) => {
  const record = await mockCards(page, { status: "requires_payment_method" }); await open(page); await payment(page).getByRole("button", { name: "Add a payment card", exact: true }).click(); await page.getByLabel("Synthetic provider card entry").fill("42"); await expect(payment(page).getByRole("button", { name: "Verify card", exact: true })).toBeDisabled(); await payment(page).getByRole("button", { name: "Close card form", exact: true }).click(); await expect(payment(page)).toHaveAttribute("data-state", "ready"); await expect(page.getByLabel("Synthetic provider card entry")).toHaveCount(0); expect(await page.evaluate(() => window.syntheticStripe.confirmations)).toBe(0); expect(record.saves).toBe(0);
});
test("a setup verification response received after account loss cannot show a default-card action", async ({ page }) => {
  await mockCards(page); let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route("**/api/payments/payment-method/setup-intent/seti_synthetic?**", async route => { arrived(); await gate; await route.fulfill({ status: 502, contentType: "application/json", body: "{}" }).catch(() => {}); });
  await open(page); await payment(page).getByRole("button", { name: "Add a payment card", exact: true }).click(); await page.getByLabel("Synthetic provider card entry").fill("4242"); await payment(page).getByRole("button", { name: "Verify card", exact: true }).click();
  try { await waiting; await page.route("**/api/auth/me", route => fulfill(route, { user: { id: "0".repeat(24), role: "attorney", status: "approved" } })); await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "lpc_user" }))); await expect(page.locator("[data-payment-setup]")).toHaveCount(0); } finally { release(); }
  await expect(page.getByRole("button", { name: "Set this card as default", exact: true })).toHaveCount(0);
});
test("stopping an unconfirmed setup waits for an explicit saved-card check before another setup", async ({ page }) => {
  const record = await mockCards(page); let arrived, release; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  await page.route("**/api/payments/payment-method/setup-intent", async route => { record.starts++; arrived(); await gate; await fulfill(route, { clientSecret: "seti_synthetic_secret_synthetic", intentId: "seti_synthetic" }).catch(() => {}); });
  await open(page); await payment(page).getByRole("button", { name: "Add a payment card", exact: true }).click();
  try { await waiting; await payment(page).getByRole("button", { name: "Stop waiting", exact: true }).click(); await expect(payment(page)).toHaveAttribute("data-state", "uncertain"); await expect(payment(page).getByRole("button", { name: "Add a payment card", exact: true })).toBeHidden(); } finally { release(); }
  await payment(page).getByRole("button", { name: "Check saved card and setup", exact: true }).click(); await expect(payment(page)).toHaveAttribute("data-state", "ready"); expect(record.starts).toBe(1); expect(record.saves).toBe(0);
});

async function rollbackPolicy(page, record, version = 'legacy') {
  await page.route('**/api/auth/workspace-release', route => fulfill(route, { workspace: { schemaVersion: 1, ownerId: record.ownerId, role: 'attorney', revision: 1, version, defaultDestination: version === 'v2' ? '/attorney-v2.html#/home' : '/dashboard-attorney.html' } }));
}
const originalSetup = '/dashboard-attorney.html?cardSetup=1&workspace=legacy#funds';
test('rollback retains a returned card setup in the original Payments form without selecting it', async ({ page }, info) => {
  const record = await mockCards(page); await rollbackPolicy(page, record);
  await open(page, '/attorney-v2.html?setup_intent=seti_synthetic&setup_intent_client_secret=synthetic-private&redirect_status=succeeded#/home');
  await expect(page).toHaveURL(new RegExp('/dashboard-attorney\\.html\\?cardSetup=1&workspace=legacy#funds$'));
  const choose = payment(page).getByRole('button', { name: 'Set this card as default', exact: true });
  await expect(choose).toBeVisible(); expect(record.saves).toBe(0); expect(record.starts).toBe(0);
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.evaluate(theme => { document.documentElement.classList.remove('theme-light', 'theme-dark'); document.body.classList.remove('theme-light', 'theme-dark'); document.documentElement.classList.add('theme-' + theme); document.body.classList.add('theme-' + theme); }, theme);
    await choose.scrollIntoViewIfNeeded(); await choose.focus(); await expect(choose).toBeFocused();
    expect((await choose.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('[data-payment-setup]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`original-card-${theme}-320.png`), fullPage: true });
  }
  await choose.click(); await expect(payment(page)).toHaveAttribute('data-state', 'ready');
  expect(record.saves).toBe(1); expect(record.starts).toBe(0); await expect(choose).toHaveCount(0);
});
test('original card callbacks strip provider credentials before authenticated requests', async ({ page }) => {
  const record = await mockCards(page), referers = []; await rollbackPolicy(page, record, 'v2');
  page.on('request', request => { if (request.url().includes('/api/')) referers.push(request.headers().referer || ''); });
  await open(page, '/dashboard-attorney.html?setup_intent=seti_synthetic&setup_intent_client_secret=synthetic-private&redirect_status=succeeded#funds');
  expect(new URL(page.url()).pathname).toBe('/dashboard-attorney.html');
  expect(new URL(page.url()).searchParams.has('setup_intent')).toBe(false);
  await expect(payment(page).getByRole('button', { name: 'Set this card as default', exact: true })).toBeVisible();
  expect(referers.some(value => value.includes('synthetic-private'))).toBe(false); expect(record.saves).toBe(0); expect(record.starts).toBe(0);
});
test('the original Manage card entry remains usable during rollback and recovers a lost save', async ({ page }) => {
  const record = await mockCards(page, { lost: true }); await rollbackPolicy(page, record);
  await page.goto('/dashboard-attorney.html?workspace=legacy#funds');
  await page.getByRole('link', { name: 'Manage card', exact: true }).click();
  await expect(payment(page)).toHaveAttribute('data-state', 'ready'); await verify(page);
  expect(await page.evaluate(() => window.syntheticStripe.returnUrl)).toBe(new URL(originalSetup, page.url()).href);
  await payment(page).getByRole('button', { name: 'Set this card as default', exact: true }).click();
  await expect(payment(page)).toHaveAttribute('data-state', 'uncertain');
  page.once('dialog', dialog => dialog.accept()); await page.reload(); await expect(payment(page)).toHaveAttribute('data-state', 'ready');
  await expect(payment(page).getByRole('button', { name: 'Set this card as default', exact: true })).toHaveCount(0);
  expect(record.saves).toBe(1); expect(record.starts).toBe(1);
});
test('an active card form survives rollback until verification and then returns for explicit selection', async ({ page }) => {
  const record = await mockCards(page); await open(page);
  await payment(page).getByRole('button', { name: 'Add a payment card', exact: true }).click(); await page.getByLabel('Synthetic provider card entry').fill('4242');
  await rollbackPolicy(page, record); await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('[data-workspace-release-notice]')).toBeVisible();
  await expect(page.getByLabel('Synthetic provider card entry')).toHaveValue('4242');
  await payment(page).getByRole('button', { name: 'Verify card', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/dashboard-attorney\\.html\\?cardSetup=1&workspace=legacy#funds$'));
  await expect(payment(page).getByRole('button', { name: 'Set this card as default', exact: true })).toBeVisible();
  expect(record.starts).toBe(1); expect(record.saves).toBe(0);
});
test('account replacement clears the original card form and its owner-bound recovery', async ({ page }) => {
  const record = await mockCards(page); await open(page, originalSetup);
  await payment(page).getByRole('button', { name: 'Add a payment card', exact: true }).click(); await page.getByLabel('Synthetic provider card entry').fill('42');
  const result = await page.evaluate(() => { localStorage.removeItem('lpc_user'); window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user' })); return { destroyed: window.syntheticStripe.destroyed, recovery: sessionStorage.getItem('lpc_attorney_card_setup_v1'), form: document.querySelector('[data-payment-setup]') !== null }; });
  expect(result.destroyed).toBeGreaterThan(0); expect(result.recovery).toBeNull(); expect(result.form).toBe(false); expect(record.saves).toBe(0);
});
