const { test, expect } = require('../shared-strict-observation.cjs');
const fs = require('node:fs/promises');
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(240000); server = await start({ port: 0 }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
async function setup(browser) {
  const people = {};
  for (const role of ['attorney', 'paralegal']) {
    const user = await server.createUser(role, {}, true), context = await browser.newContext();
    await context.addCookies([user.cookie]);
    await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
    people[role] = { ...user, context, page: await context.newPage() };
  }
  async function api(role, method, path, data) {
    const req = people[role].context.request, csrf = await (await req.get(server.origin + '/api/csrf')).json();
    const res = await req[method](server.origin + path, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
    expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true); return res.json();
  }
  const published = await api('attorney', 'post', '/api/cases', { title: 'River Street snapshot recovery', practiceArea: 'immigration', state: 'CA', totalAmount: 400, experience: '5+ years', deadline: '2027-03-14', description: 'Private exhibit instructions retained for the current participants.', tasks: [{ title: 'Prepare exhibit index' }] });
  const id = String(published.case?._id || published._id || published.id);
  await api('paralegal', 'post', `/api/jobs/${published.jobId}/apply`, { coverLetter: 'I can prepare the exhibit index.' });
  await api('attorney', 'post', '/api/payments/payment-method/default', { paymentMethodId: 'pm_browser_card' });
  const review = await api('attorney', 'get', `/api/cases/${id}/hiring-review/${people.paralegal.id}?expectedOwnerId=${people.attorney.id}`);
  await api('attorney', 'post', `/api/cases/${id}/hire/${people.paralegal.id}`, { expectedOwnerId: people.attorney.id, reviewedRevision: review.revision });
  return { people, id, close: () => Promise.all(Object.values(people).map(p => p.context.close())) };
}
const url = (role, id) => `${server.origin}/${role}-v2.html${role === 'attorney' ? `#/matters/${id}/overview` : `#/matter/${id}?tab=overview`}`;
const conflict = route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'MATTER_FINANCIAL_CHANGED', error: 'Snapshot changed during the read.' }) });

for (const role of ['attorney', 'paralegal']) {
  test(`${role} initial and background financial snapshot races recover through the same owner`, async ({ browser }, info) => {
    const fixture = await setup(browser), { id, people } = fixture, person = people[role], page = person.page, phases = [];
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
      let remaining = 1, reads = 0;
      await page.route(`**/api/cases/${id}?expectedOwnerId=*`, async route => {
        expect(new URL(route.request().url()).searchParams.get('expectedOwnerId')).toBe(person.id);
        reads++; if (remaining-- > 0) return conflict(route); return route.fallback();
      });
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      await page.goto(url(role, id));
      const panel = page.locator(role === 'attorney' ? '[data-matter-workspace]' : '[data-v2-matter]');
      await expect(panel).toContainText('River Street snapshot recovery');
      await expect(panel).toContainText('Private exhibit instructions');
      expect(reads).toBeGreaterThanOrEqual(2); phases.push({ phase: 'initial', reads });
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
      if (role === "attorney") { await panel.evaluate(element => element.readiness); await expect(panel).toHaveAttribute("data-state", "ready"); }
      reads = 0; remaining = 1;
      if (role === 'attorney') await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      else require('../../../utils/caseEvents').publishCaseEvent(id, 'case', { at: new Date().toISOString() });
      await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
      await expect(panel).toContainText('Private exhibit instructions');
      await expect(page.getByRole('heading', { name: /Matter unavailable|Matter temporarily unavailable/ })).toHaveCount(0);
      phases.push({ phase: 'background', reads }); expect(errors).toEqual([]);
      await fs.writeFile(info.outputPath('snapshot-recovery.json'), JSON.stringify({ role, phases, errors, requests: server.evidence().requests }, null, 2));
    } finally { await fixture.close(); }
  });
  for (const outcome of ['persistent conflict', 'revoked access']) test(`${role} financial snapshot ${outcome} stops after one recheck and clears Matter details`, async ({ browser }, info) => {
    const fixture = await setup(browser), { id, people } = fixture, page = people[role].page; let reads = 0;
    try {
      await page.route(`**/api/cases/${id}?expectedOwnerId=*`, route => {
        reads++;
        if (reads === 1 || outcome === 'persistent conflict') return conflict(route);
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: 'MATTER_RESTRICTED', error: 'Access revoked.' }) });
      });
      await page.goto(url(role, id));
      await expect(page.getByRole('heading', { name: role === 'attorney' ? 'Matter unavailable' : outcome === 'persistent conflict' ? 'Matter temporarily unavailable' : 'You no longer have access to this matter', exact: true })).toBeVisible();
      expect(reads).toBe(2);
      await expect(page.locator('main')).not.toContainText('Private exhibit instructions');
      await expect(page.locator('main')).not.toContainText('River Street snapshot recovery');
      await fs.writeFile(info.outputPath('snapshot-recovery.json'), JSON.stringify({ role, outcome, reads }, null, 2));
    } finally { await fixture.close(); }
  });
}
