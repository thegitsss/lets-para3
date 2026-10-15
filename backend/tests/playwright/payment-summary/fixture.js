const { test } = require('../assistant-completion/shell-fixture');
const { expect } = require('playwright/test');
const { fixture: shell, OWNER } = require('../assistant-completion/fixture');
const id = n => n.toString(16).padStart(24, '0'), revision = 'a'.repeat(64);
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const group = (patch = {}) => ({ currency: 'USD', originalFunding: 48800, refunds: 0, activeFunds: 40000, pendingCharges: 0, fundingNeeded: 0, fundedMatterCosts: 40000, fundedMatters: 1, requiresReview: 0, activeMatters: 1, pendingMatters: 0, unfundedMatters: 0, fundingUnknown: false, balanceUnknown: false, pendingUnknown: false, ...patch });
function summary(currencies = [group()], patch = {}) {
  const usd = currencies.find(row => row.currency === 'USD') || { originalFunding: 0, activeFunds: 0, pendingCharges: 0, fundingNeeded: 0 };
  return { ownerId: OWNER, revision, currencies, requiresReview: currencies.reduce((sum, row) => sum + row.requiresReview, 0), unsupportedCurrency: false, totalSpent: usd.originalFunding, activeFunds: usd.activeFunds, activeEscrow: usd.activeFunds, pendingCharges: usd.pendingCharges, fundingNeeded: usd.fundingNeeded, completedJobsCount: 0, pendingJobsCount: 0, averageJobCost: 40000, ...patch };
}
async function fixture(page, { view = 'home', theme = 'light', value = summary() } = {}) {
  const state = { value, status: 200, reads: 0, respond: null, posts: [] };
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/')) state.posts.push(request.url()); });
  const result = await shell(page, 'attorney', { hash: `/${view}`, setup: async account => {
    account.user.preferences.theme = theme; account.user.onboarding.attorneyTourCompleted = true;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), p = url.pathname;
      if (p === '/api/payments/summary') { state.reads++; expect(url.searchParams.get('expectedOwnerId')).toBe(OWNER); return state.respond ? state.respond(route) : json(route, state.value, state.status); }
      if (p === '/api/attorney/dashboard') return json(route, { metrics: { activeCases: 1, completedCases: 0, openJobs: 0, pendingApplications: 0, weekDeadlines: 0, escrowTotal: state.value.activeFunds }, week: { start: '2026-09-07', end: '2026-09-13', deadlines: [] } });
      if (p === '/api/cases/my' || p === '/api/applications/my-postings') return json(route, []);
      if (p === '/api/checklist') return json(route, { items: [], total: 0 });
      if (p === '/api/messages/summary') return json(route, { items: [], totalThreads: 0 });
      if (p === '/api/messages/threads') return json(route, { threads: [], total: 0 });
      if (p === '/api/payments/payment-method/default') return json(route, { hasDefault: false, paymentMethod: null });
      if (p === '/api/users/me/pending-hire') return json(route, { ownerId: OWNER, revision, pending: null });
      if (p === '/api/payments/attorney-records') {
        const items = state.value.currencies.map((g, index) => ({ id: id(index + 10), title: `River Street matter ${index + 1}`, paralegalName: 'Priya Ng', matterStatus: 'in progress', archived: false, currency: g.currency, matterAmount: 40000, funding: g.originalFunding ? 'recorded' : g.requiresReview ? 'needs_review' : 'not_recorded', fundingVerifiedAt: g.originalFunding ? '2026-01-03T00:00:00.000Z' : null, release: 'not_recorded', releasedAt: null, withdrawal: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' }));
        return json(route, { ownerId: OWNER, view: 'all', q: '', total: items.length, items, nextCursor: null, selected: null, selection: 'none' });
      }
      if (p === '/api/payments/attorney-financial-history') {
        const entries = state.value.currencies.map((g, index) => ({ id: String(index + 100).padStart(64, '0'), caseId: id(index + 10), caseTitle: `River Street matter ${index + 1}`, type: 'funding', state: g.originalFunding ? 'recorded' : g.requiresReview ? 'needs_review' : g.pendingCharges ? 'pending' : 'unconfirmed', amount: g.originalFunding || g.pendingCharges || g.fundingNeeded || 48800, currency: g.currency, recordedAt: g.originalFunding ? '2026-01-03T00:00:00.000Z' : null, basis: g.originalFunding ? 'original_payment' : 'funding_to_verify', receiptId: 'payment', paralegalName: null }));
        return json(route, { ownerId: OWNER, revision, view: 'all', q: '', caseId: null, total: entries.length, entries, nextCursor: null, summary: { currencies: state.value.currencies.map(g => ({ currency: g.currency, originalFunding: g.originalFunding || 0, paralegalPayouts: 0, refunds: 0, refundRecords: 0, refundsUnverified: 0, fundingRecords: g.originalFunding ? 1 : 0, payoutRecords: 0, fundingUnverified: g.originalFunding ? 0 : 1, payoutsUnverified: 0 })), requiresReview: entries.filter(row => ['needs_review', 'unconfirmed'].includes(row.state)).length, pending: entries.filter(row => row.state === 'pending').length, undated: entries.filter(row => !row.recordedAt).length } });
      }
      return route.fallback();
    });
  } });
  const panel = page.locator(`[data-av2-region="${view === 'home' ? 'payments' : 'payment-summary'}"]`);
  await expect(panel).toHaveAttribute('data-state', 'ready');
  return { ...result, state, panel, refresh: panel.getByRole('button', { name: `Refresh ${view === 'home' ? 'payments' : 'matter funds'}`, exact: true }) };
}
module.exports = { test, expect, fixture, group, summary, json, OWNER };
