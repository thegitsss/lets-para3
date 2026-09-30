const { fixture: shell, json, OWNER } = require('../assistant-completion/fixture');
const { expect } = require('playwright/test');
const objectId = n => n.toString(16).padStart(24, '0');
const matter = (n, values = {}) => ({ id: objectId(n), title: `Matter ${n}`, status: 'in progress', paralegal: { id: objectId(99) }, escrowIntentId: 'pi_synthetic', escrowStatus: 'funded', archived: false, paymentReleased: false, files: [], applicantsCount: 0, practiceArea: 'Litigation', updatedAt: '2026-09-11T10:00:00Z', ...values });
const region = (page, key) => page.locator(`[data-av2-region="${key}"]`);
const keys = ['attention', 'applications', 'messages', 'deadlines', 'recent'];
function emptyHome() {
  return { ownerId: OWNER, revision: 'a'.repeat(64), counts: { active: 0, applications: 0, draft: 0, archived: 0 }, postedCount: 0,
    attention: { total: 0, page: 1, pages: 1, pageSize: 5, items: [] }, recent: { total: 0, items: [] }, completed: { total: 0, items: [] },
    week: { start: '2026-09-07', end: '2026-09-13', total: 0, page: 1, pages: 1, pageSize: 3, items: [] } };
}
function fixtures() {
  return { home: emptyHome(), homePages: {}, applications: [], overdue: { total: 0, items: [] },
    unread: { count: 0 }, summary: { items: [] }, threads: { total: 0, threads: [] } };
}
async function install(page, data = fixtures(), requiredKeys = keys) {
  const writes = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await shell(page, 'attorney', { hash: '/home', setup: async state => {
    state.user.onboarding.attorneyTourCompleted = true;
    await page.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (path === '/api/auth/workspace-release') return json(route, { workspace: { schemaVersion: 1, ownerId: OWNER, role: 'attorney', revision: 1, version: 'v2', defaultDestination: '/attorney-v2.html#/home' } });
      if (request.method() !== 'GET') writes.push({ path, method: request.method() });
      const paths = { '/api/cases/inventory/home': 'home', '/api/applications/my-postings': 'applications', '/api/checklist': 'overdue', '/api/messages/unread-count': 'unread', '/api/messages/summary': 'summary', '/api/messages/threads': 'threads' };
      const key = paths[path];
      if (key) {
        let value = data[key];
        if (key === 'home' && !value.httpError) value = data.homePages[`${url.searchParams.get('attentionPage') || '1'}:${url.searchParams.get('deadlinePage') || '1'}`] || value;
        return json(route, value?.httpError ? {} : value, value?.httpError || 200);
      }
      if (path === '/api/users/me') return json(route, { ...state.user, lawFirm: 'Ellis Legal' });
      if (path === '/api/payments/payment-method/default') return json(route, { paymentMethod: { id: 'pm_synthetic' } });
      if (path === '/api/payments/summary') return json(route, { ownerId: OWNER, revision: 'a'.repeat(64), currencies: [], requiresReview: 0, unsupportedCurrency: false, totalSpent: 0, activeFunds: 0, activeEscrow: 0, pendingCharges: 0, fundingNeeded: 0 });
      return route.fallback();
    });
  } });
  for (const key of requiredKeys) await expect(region(page, key)).not.toHaveAttribute('data-state', 'loading');
  return { data, writes, errors };
}
module.exports = { emptyHome, fixtures, install, matter, objectId, region, keys };
