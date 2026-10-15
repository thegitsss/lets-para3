const { eventPage } = require('./event-page-fixture');
const financial = require('./financial-fixtures');
const { receivedInvitations } = require('./received-invitation-fixture');
const OWNER = '111111111111111111111111', MATTER = '222222222222222222222222';
const id = n => n.toString(16).padStart(24, '0');
const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
async function install(page, { count = 203, failure = '', empty = false, setup = () => {} } = {}) {
  const profile = { id: OWNER, _id: OWNER, role: 'paralegal', status: 'approved', emailVerified: true, firstName: 'Dana', lastName: 'Young', email: 'calendar@example.test', stateExperience: ['New York'], practiceAreas: ['Civil Litigation'], yearsExperience: 6, preferences: { theme: 'light', fontSize: 'md' }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } };
  const matter = { caseId: MATTER, title: 'Matter deadline — Review the complete supplemental production chronology and attorney-approved exhibits', paralegalId: OWNER, status: 'in progress', archived: false, paymentReleased: false, escrowStatus: 'funded', escrowIntentId: 'pi_synthetic', deadlineDate: '2026-09-10', tasksTotal: 1, tasksRemaining: 1 };
  const events = Array.from({ length: count }, (_, n) => ({ id: id(n+1), owner: OWNER, title: `Reminder ${String(n+1).padStart(3,'0')} — Private review of supplemental records and citation discrepancies`, start: '2026-09-09T12:00:00Z', type: 'deadline', isAllDay: true }));
  const state = { profile, matter, events, failure, empty, pages: [], errors: [], writes: [], held: [], hold: false, matters: [matter], applications: [], summaries: [], invites: [], details: {}, reads: {}, activeDetails: 0, maxDetails: 0 };
  setup(state);
  if (!Object.hasOwn(state.profile, 'availability')) Object.assign(state.profile, { availability: 'Available now', availabilityDetails: { status: 'available', nextAvailable: null, updatedAt: '2026-09-01T12:00:00Z' } });
  await page.clock.setFixedTime(new Date('2026-09-08T16:00:00Z'));
  await page.addInitScript(user => { localStorage.setItem('lpc_user', JSON.stringify(user)); window.EventSource = class extends EventTarget { close() {} }; }, profile);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), p = url.pathname; state.reads[p] = (state.reads[p] || 0) + 1;
    if (route.request().method() !== 'GET') { state.writes.push(p); return json(route, {}); }
    if (p === '/api/auth/me') return json(route, { user: state.profile });
    if (p === '/api/users/me') return state.failure === 'profile' ? json(route, {}, 503) : json(route, state.profile);
    if (p === '/api/csrf') return json(route, { csrfToken: 'synthetic-calendar-unused' });
    if (p === '/api/account/preferences') return json(route, state.profile.preferences);
    if (p === '/api/payments/connect/status') return json(route, { readiness: { ready: true, evidenceState: 'verified' } });
    if (p === '/api/paralegal/dashboard') return state.failure === 'dashboard' ? json(route, {}, 503) : json(route, { activeCases: state.empty ? [] : state.matters, metrics: { activeCases: state.empty ? 0 : state.matters.length, earningsReport: financial.earnings(OWNER), expectedCompensation: financial.expected(OWNER) } });
    if (/^\/api\/cases\/[a-f0-9]{24}$/i.test(p)) {
      const caseId = p.split('/').at(-1); state.activeDetails++; state.maxDetails = Math.max(state.maxDetails, state.activeDetails);
      try {
        if (state.detailWait) await state.detailWait;
        if (state.failure === 'details') return await json(route, {}, 503);
        if (state.restrictedId === caseId) return await json(route, {}, 403);
        return await json(route, state.details[caseId] || { _id: caseId, title: matter.title, tasks: [{ title: 'Review records', completed: false }], files: [], matterExperience: {} });
      } finally { state.activeDetails--; }
    }
    if (p === '/api/events') {
      const n = Number(url.searchParams.get('page') || 1); state.pages.push(n);
      if (state.hold) await new Promise(resolve => state.held.push(resolve));
      if (state.failure === 'events' && n === 2) return json(route, {}, 503);
      return json(route, eventPage(OWNER, state.empty ? [] : state.events, url.searchParams));
    }
    if (p === '/api/cases/invited-to') return json(route, receivedInvitations(OWNER, { items: state.invites }, url.searchParams));
    if (p === '/api/applications/my') return state.failure === 'applications' ? json(route, {}, 503) : json(route, state.applications);
    if (p === '/api/jobs/recommended') return state.failure === 'recommendations' ? json(route, {}, 503) : json(route, { items: state.recommendations || [], hasMatchingProfile: true });
    if (p === '/api/messages/threads') return json(route, { threads: [], total: 0 });
    if (p === '/api/messages/summary') return state.failure === 'messages' ? json(route, {}, 503) : json(route, { items: state.summaries });
    if (p === '/api/messages/unread-count') return json(route, { count: state.unreadOverride ?? state.summaries.reduce((n,row)=>n+row.unread,0) });
    if (p.includes('unread-count')) return json(route, { count: 0 });
    if (p === '/api/notifications/page') return json(route, { items: [], nextCursor: null, hasMore: false });
    if (p === '/api/notifications') return json(route, []);
    return json(route, { items: [], total: 0 });
  });
  await page.goto('/dashboard-paralegal.html#home');
  return state;
}
module.exports = { install, OWNER, MATTER, id, json };
