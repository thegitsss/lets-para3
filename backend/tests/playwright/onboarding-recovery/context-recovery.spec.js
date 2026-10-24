'use strict';
const { test, expect } = require('playwright/test');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
let server, origin;
test.beforeAll(async () => {
  const frontend = path.resolve(__dirname, '../../../../frontend');
  const files = new Map(['/assets/scripts/paralegal-v2/onboarding-controller.mjs', '/assets/scripts/utils/document-navigation.mjs'].map(p => [p, path.join(frontend, p)]));
  server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://fixture.invalid').pathname;
    if (p === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Isolated onboarding component test</title><style>dialog{max-height:90vh;overflow:auto}svg{width:24px;height:24px}</style><main data-v2-route-outlet><h1>Component fixture</h1></main>'); }
    if (!files.has(p)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(files.get(p)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
async function launch(page, mode, navigation = "ok") {
  await page.goto(origin);
  await page.evaluate(async ({ origin, mode, navigation }) => {
    const { createOnboardingController } = await import(origin + '/assets/scripts/paralegal-v2/onboarding-controller.mjs');
    let identity = { id: 'a'.repeat(24), onboarding: {} }; const toasts = [], mutations = [];
    let reject, rejectNavigation, resolveNavigation; const navigationHeld = new Promise((ok, fail) => { resolveNavigation = ok; rejectNavigation = fail; }); let navigationStarted = false, navigationSettled = false;
    const held = new Promise((_ok, fail) => { reject = fail; });
    const host = document.createElement('div'); document.body.append(host);
    const controller = createOnboardingController({ dialogHost: host, api: { get: async () => ({ onboarding: {} }), request: async (...args) => { mutations.push(args); if (mode !== 'normal') throw Error('Unexpected completion write'); return { onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } }; } }, getIdentity: () => identity, updateIdentity: value => { identity = value; }, showToast: value => toasts.push(value), getRoute: () => null, navigateTour: async (_route, options = {}) => { if (options.preview) return; navigationStarted = true; if (navigation === 'held') { try { return await navigationHeld; } finally { navigationSettled = true; } } if (navigation === 'reject') throw Error('Synthetic next-page failure'); }, getTourContext: () => { if (mode === 'normal') return null; if (mode === 'sync') throw Error('Synthetic synchronous context failure'); return mode === 'held' ? held : Promise.reject(Error('Synthetic asynchronous context failure')); } });
    await controller.start(identity); window.probe = { controller, toasts, mutations, reject, rejectNavigation, resolveNavigation, state: () => ({ identity, navigationStarted, navigationSettled }), switchOwner: () => { controller.stop(); identity = { id: 'b'.repeat(24) }; } }; controller.replay();
  }, { origin, mode, navigation });
}
for (const mode of ['async', 'sync']) test(`${mode} next-step failure reports recovery and retains the Home destination without saving completion`, async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await launch(page, mode);
  await expect.poll(() => page.evaluate(() => window.probe.toasts)).toEqual(['We couldn’t load your next step. You can finish the tour and go to Home.']);
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  for (const name of ['Find my fit', 'See my Matters', 'Keep in touch', 'Bring it home']) await dialog.getByRole('button', { name, exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Go to Home', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.probe.mutations)).toEqual([]); expect(errors).toEqual([]);
});
test('a late context failure cannot notify or reopen the replacement owner', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await launch(page, 'held');
  await page.evaluate(() => { window.probe.switchOwner(); window.probe.reject(Error('Synthetic late failure')); });
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await page.evaluate(() => window.probe.toasts)).toEqual([]); expect(await page.evaluate(() => window.probe.mutations)).toEqual([]); expect(errors).toEqual([]);
});

async function finalStep(page) {
  const dialog = page.getByRole('dialog');
  for (const name of ['Find my fit', 'See my Matters', 'Keep in touch', 'Bring it home']) await dialog.getByRole('button', { name, exact: true }).click();
}
test('a failed next page after confirmed completion reports the saved outcome without a second write', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await launch(page, 'normal', 'reject'); await finalStep(page);
  await page.getByRole('button', { name: 'Go to Home', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.probe.toasts)).toEqual(['Your tour progress was saved, but the next page couldn’t load. Try opening it again.']);
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await page.evaluate(() => window.probe.mutations.length)).toBe(1); expect(await page.evaluate(() => window.probe.state().identity.onboarding)).toEqual({ paralegalTourCompleted: true, paralegalProfileTourCompleted: true }); expect(errors).toEqual([]);
});
test('a failed return after skipping reports navigation recovery without saving completion', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await launch(page, 'normal', 'reject'); await page.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.probe.toasts)).toEqual(['The tour is closed, but the page couldn’t load. Try opening it again.']);
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(await page.evaluate(() => window.probe.mutations)).toEqual([]); expect(errors).toEqual([]);
});
test('a late navigation failure cannot notify the replacement owner', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await launch(page, 'normal', 'held'); await page.getByRole('button', { name: 'Skip tour', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.probe.state().navigationStarted)).toBe(true);
  await page.evaluate(() => { window.probe.switchOwner(); window.probe.rejectNavigation(Error('Synthetic late navigation failure')); });
  await expect.poll(() => page.evaluate(() => window.probe.state().navigationSettled)).toBe(true); expect(await page.evaluate(() => window.probe.toasts)).toEqual([]); expect(await page.evaluate(() => window.probe.mutations)).toEqual([]); expect(errors).toEqual([]);
});

test('a late successful navigation after saved completion cannot notify the replacement owner', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await launch(page, 'normal', 'held'); await finalStep(page);
  await page.getByRole('button', { name: 'Go to Home', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.probe.state().navigationStarted)).toBe(true);
  await page.evaluate(() => { window.probe.switchOwner(); window.probe.resolveNavigation(); });
  await expect.poll(() => page.evaluate(() => window.probe.state().navigationSettled)).toBe(true);
  expect(await page.evaluate(() => window.probe.toasts)).toEqual([]); expect(await page.evaluate(() => window.probe.state().identity.id)).toBe('b'.repeat(24)); expect(await page.evaluate(() => window.probe.mutations.length)).toBe(1); expect(errors).toEqual([]);
});
