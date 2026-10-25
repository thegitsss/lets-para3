const { test: base, expect } = require('playwright/test');
const http = require('node:http'), fs = require('node:fs/promises'), path = require('node:path');
const root = path.join(path.resolve(process.env.LPC_HELP_SOURCE_ROOT || path.join(__dirname, '../../../..')), 'frontend');
const mime = { '.html': 'text/html', '.mjs': 'application/javascript', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const test = base.extend({
  shellServer: async ({}, use) => {
    const server = http.createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        const vendor = { '/assets/vendor/simplewebauthn-13.3.0.js': '@simplewebauthn/browser/dist/bundle/index.umd.min.js', '/assets/vendor/web-vitals-6.1.1.js': 'web-vitals/dist/web-vitals.js', '/assets/vendor/chart-4.5.1.js': 'chart.js/dist/chart.umd.js' }[pathname];
        const file = vendor ? path.resolve(__dirname, '../../../node_modules', vendor) : path.resolve(root, `.${pathname}`);
        if (req.method !== 'GET' || pathname.startsWith('/api/') || !vendor && !file.startsWith(`${root}${path.sep}`)) { res.writeHead(404); return res.end(); }
        const bytes = await fs.readFile(file); res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try { await use(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  },
  baseURL: async ({ shellServer }, use) => use(shellServer),
});
test.beforeEach(async ({ context, shellServer }) => { await context.route('**/*', route => new URL(route.request().url()).origin === shellServer ? route.continue() : route.abort('blockedbyclient')); });
const id = n => n.toString(16).padStart(24, '0'), OWNER = '111111111111111111111111', REVISION = 'a'.repeat(64);
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const row = (n, patch = {}) => ({ id: id(n), caseId: id(n), caseName: `Matter ${String(n).padStart(4, '0')}`, paralegalId: id(9999), paralegalName: 'Priya Ng', caseStatus: 'in progress', archived: false, currency: 'USD', amountHeld: 30000, amountDue: null, status: 'active', fundedAt: '2026-01-03T00:00:00.000Z', ...patch });
async function fixture(page, { count = 3, secondPageFailure = false, replaceAfterFirst = false, theme = 'light', setup = async () => {} } = {}) {
  const user = { id: OWNER, _id: OWNER, role: 'attorney', status: 'approved', emailVerified: true, firstName: 'Dana', lastName: 'Reporter', email: 'synthetic@example.test', preferences: { theme, fontSize: 'md' }, onboarding: { attorneyTourCompleted: true } };
  const state = { user, pages: [], posts: [], rows: Array.from({ length: count }, (_, index) => row(index + 1)), secondPageFailure, replaceAfterFirst };
  state.rows[1] = row(2, { amountHeld: 20000, currency: 'EUR' }); state.rows[2] = row(3, { amountHeld: null, status: 'needs_review', fundedAt: null, caseStatus: 'closed' });
  await page.addInitScript(value => { localStorage.setItem('lpc_user', JSON.stringify(value)); window.EventSource = class extends EventTarget { close() {} }; }, user);
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (req.method() !== 'GET') { state.posts.push(p); return json(route, { error: 'Outside private read fixture' }, 501); }
    if (p === '/api/auth/me') return json(route, { user: state.user });
    if (p === '/api/users/me') return json(route, state.user);
    if (p === '/api/payments/escrow/active') {
      expect(url.searchParams.get('expectedOwnerId')).toBe(OWNER); const cursor = Number(url.searchParams.get('cursor') || 0); state.pages.push(cursor);
      if (cursor && state.secondPageFailure) return json(route, { code: 'PAYMENT_SUMMARY_CHANGED' }, 409);
      const items = state.rows.slice(cursor, cursor + 500);
      if (!cursor && state.replaceAfterFirst) state.user = { ...user, id: '222222222222222222222222', _id: '222222222222222222222222' };
      return json(route, { ownerId: OWNER, revision: REVISION, items, count: state.rows.length, total: null, currencies: [], currency: 'USD', nextCursor: cursor + items.length < state.rows.length ? String(cursor + items.length) : null });
    }
    if (p === '/api/payments/payment-method/default') return json(route, { hasDefault: false, paymentMethod: null });
    if (p === '/api/payments/history') return json(route, { items: [], totalSpent: 0, averageJobCost: 0, count: 0 });
    if (p === '/api/csrf') return json(route, { csrfToken: 'private-unused-csrf' });
    if (p.includes('unread-count')) return json(route, { count: 0 });
    if (p === '/api/notifications/page') return json(route, { items: [], nextCursor: null, hasMore: false });
    if (p === '/api/notifications' || p === '/api/cases/my' || p === '/api/applications/my-postings') return json(route, []);
    if (p === '/api/account/preferences') return json(route, user.preferences);
    return json(route, { items: [], total: 0, threads: [] });
  });
  await setup(state);
  await page.goto('/dashboard-attorney.html#funds');
  await expect(page.locator('[data-billing-surface]')).toBeVisible();
  return { state, body: page.locator('#activeEscrowsBody') };
}
module.exports = { test, expect, fixture };
