const { test: base, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
const test = base.extend({
  recoveryServer: [async ({}, use) => {
    const server = await start();
    try { await use(server); } finally { await server.close(); }
  }, { scope: 'worker', timeout: 180000 }],
});

for (const role of ['attorney', 'paralegal']) test(`${role} malformed session response stays recoverable without signing out`, async ({ browser, recoveryServer: server }) => {
  await server.reset();
  const actor = await server.createUser(role);
  const context = await browser.newContext();
  try {
    await context.addCookies([actor.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    const page = await context.newPage();let malformed=true,reads=0;
    await page.route('**/api/auth/me', route => { reads++;return malformed ? route.fulfill({contentType:'application/json',body:'{}'}) : route.continue(); });
    await page.goto(server.origin + `/${role}-v2.html#/home`);
    await expect(page.getByRole('button',{name:'Try again',exact:true})).toBeVisible();
    expect(reads).toBe(1);
    await expect(page).toHaveURL(new RegExp(`${role}-v2\\.html`));
    expect(await page.locator(role === 'attorney' ? '[data-av2-shell]' : '[data-v2-persistent=sidebar]').evaluate(element => element.inert)).toBe(true);
    malformed=false;
    await page.getByRole('button',{name:'Try again',exact:true}).click();
    await expect(page.locator(role === 'attorney' ? '[data-attorney-state]' : 'body')).toHaveAttribute(role === 'attorney' ? 'data-attorney-state' : 'data-v2-session','ready');
  } finally { await context.close(); }
});

for (const role of ['attorney', 'paralegal']) for (const failures of [1, 2]) test(`${role} session read handles ${failures} temporary failures`, async ({ browser, recoveryServer: server }) => {
  await server.reset();
  const actor = await server.createUser(role);
  const context = await browser.newContext();
  try {
    await context.addCookies([actor.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    const page = await context.newPage();
    let reads = 0;const readTimes=[];
    await page.route('**/api/auth/me', route => {
      readTimes.push(Date.now());
      return ++reads <= failures
        ? route.fulfill({ status: 503, headers: failures === 1 ? { 'Retry-After': '1' } : {}, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic temporary failure' }) })
        : route.continue();
    });
    await page.goto(server.origin + `/${role}-v2.html#/home`);
    if (failures === 2) {
      await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
      expect(reads).toBe(2);
      expect(await page.locator(role === 'attorney' ? '[data-av2-shell]' : '[data-v2-persistent=sidebar]').evaluate(element => element.inert)).toBe(true);
      if (role === 'attorney') expect(await page.evaluate(() => window.__LPC_ATTORNEY_V2__.health().lastSessionFailure)).toEqual({ phase: 'session', kind: 'unavailable', status: 503 });
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
    }
    await expect(page.locator(role === 'attorney' ? '[data-attorney-state]' : 'body')).toHaveAttribute(role === 'attorney' ? 'data-attorney-state' : 'data-v2-session', 'ready');
    await expect(page.locator(role === 'attorney' ? '[data-av2-gate]' : '[data-v2-session-recovery]').getByRole('button', { name: 'Try again', exact: true })).not.toBeVisible();
    if (failures === 1) expect(readTimes[1] - readTimes[0]).toBeGreaterThanOrEqual(800);
    // Once open, owner-bound dashboard tools perform their own session reads.
    expect(reads).toBeGreaterThanOrEqual(failures + 1);
    if (role === 'attorney') expect(await page.evaluate(() => window.__LPC_ATTORNEY_V2__.health().lastSessionFailure)).toBeNull();
  } finally { await context.close(); }
});
