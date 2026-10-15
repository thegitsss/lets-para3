const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(360000); server = await start({ port: Number(process.env.LPC_ADMIN_LEGACY_PORT || 5169), includeDirectors: true }); });
test.beforeEach(async () => server.reset()); test.afterAll(async () => server?.close());
test('Samantha sees unconfirmed delivery and accepted email history repair in existing Director records without a resend control or private claim data', async ({ browser }, info) => {
  const admin = await server.createUser('admin'), director = await server.createUser('director');
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } }); await context.addCookies([admin.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const Record = require('../../../models/DirectorOutreachRecord'), User = require('../../../models/User');
  const directorUser = await User.findById(director.id).lean(), now = new Date();
  const states = [
    { name: 'Unconfirmed synthetic referral', stage: 'follow_up_failed', followUpSentAt: null, metadata: { automaticFollowUp: { status: 'unknown', claimId: 'private-ui-unknown-claim' }, lastFollowUpError: 'Delivery could not be confirmed. Samantha must check the provider before another attempt.' }, label: 'Delivery unconfirmed; owner review' },
    { name: 'Accepted synthetic referral history', stage: 'follow_up_sent', followUpSentAt: now, metadata: { automaticFollowUp: { status: 'accepted', claimId: 'private-ui-accepted-claim', eventRecorded: false } }, label: 'Email accepted; history needs repair' },
    { name: 'Earlier synthetic referral', stage: 'follow_up_sent', followUpSentAt: now, metadata: {}, label: 'Follow-Up Auto Sent' },
  ];
  const records = await Record.insertMany(states.map((row, index) => ({ directorUserId: director.id, directorEmail: directorUser.email, attorneyEmail: `director-status-${index}@example.test`, attorneyName: row.name, stage: row.stage, followUpSentAt: row.followUpSentAt, metadata: row.metadata })));
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const response = await context.request.get(server.origin + '/api/admin/directors/overview'); expect(response.status()).toBe(200);
    const payload = await response.json(); expect(payload.ownerId).toBe(String(admin.id)); expect(payload.records).toHaveLength(3);
    expect(JSON.stringify(payload)).not.toContain('private-ui-'); for (const row of payload.records) expect(row).not.toHaveProperty('metadata');
    for (const state of states) expect(payload.records.find(row => row.attorneyName === state.name).stageLabel).toBe(state.label);
    const sessionResponse = await context.request.get(server.origin + '/api/auth/me'); expect(sessionResponse.status()).toBe(200);
    const sessionUser = (await sessionResponse.json()).user;
    expect(String(sessionUser.id || sessionUser._id)).toBe(String(admin.id)); expect(sessionUser.role).toBe('admin'); expect(sessionUser.status).toBe('approved');
    // This is the original renderer scope with a first-document, cookie-only
    // entry. No cached public projection grants or substitutes for authority.
    await context.addInitScript(() => { window.__directorEntryWithoutCache = localStorage.getItem('lpc_user') === null; });
    await page.goto(server.origin + '/admin-directors.html');
    await page.getByRole('combobox', { name: 'Director view', exact: true }).selectOption({ label: 'All records' });
    await expect(page.locator('#recordsBody tr')).toHaveCount(3);
    expect(await page.evaluate(() => window.__directorEntryWithoutCache)).toBe(true);
    const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('lpc_user')));
    expect(cached.id).toBe(String(admin.id)); expect(cached.role).toBe('admin'); expect(cached.status).toBe('approved');
    for (const key of ['email', 'pendingEmail', 'state', 'stateExperience', 'pendingHire', 'authVersion']) expect(cached).not.toHaveProperty(key);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const state of states) {
        const row = page.locator('#recordsBody tr').filter({ hasText: state.name });
        const label = row.locator('[data-label="Stage"]'); await label.scrollIntoViewIfNeeded(); await expect(label).toHaveText(state.label); await expect(label).toBeVisible();
        await page.screenshot({ path: info.outputPath(`director-status-${states.indexOf(state)}-${width}.png`), animations: 'disabled' });
        const visibility = await label.locator('.badge').evaluate(el => {
          let left = 0, right = innerWidth;
          for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            if (getComputedStyle(parent).overflowX !== 'visible') { const bounds = parent.getBoundingClientRect(); left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
          }
          const range = document.createRange(); range.selectNodeContents(el);
          const lines = [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
          return { left, right, lines, visible: lines.length > 0 && lines.every(rect => rect.left >= left - 1 && rect.right <= right + 1 && rect.top >= 0 && rect.bottom <= innerHeight) };
        });
        await info.attach(`status-lines-${states.indexOf(state)}-${width}.json`, { body: Buffer.from(JSON.stringify(visibility)), contentType: 'application/json' });
        expect(visibility.visible, JSON.stringify(visibility)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.getByRole('combobox', { name: 'Director view', exact: true }).selectOption({ label: 'Failed follow-ups' });
    await expect(page.locator('#failedFollowUpsBody')).toBeVisible(); await expect(page.locator('#failedFollowUpsBody')).toContainText(states[0].label);
    expect(await page.getByRole('button', { name: /retry|resend/i }).count()).toBe(0);
    for (let index = 0; index < records.length; index++) {
      const saved = await Record.findById(records[index]._id).lean(); expect(saved.stage).toBe(states[index].stage); expect(saved.followUpSentAt).toEqual(states[index].followUpSentAt); expect(saved.metadata).toEqual(states[index].metadata);
    }
    expect(await require('../../../models/DirectorOutreachEvent').countDocuments()).toBe(0);
    expect(server.evidence().requests.filter(row => !['GET', 'HEAD', 'OPTIONS'].includes(row.method))).toHaveLength(0);
    expect(server.evidence().external.mail).toHaveLength(0); expect(server.evidence().external.storage).toHaveLength(0); expect(errors).toEqual([]);
  } finally { await context.close(); }
});
