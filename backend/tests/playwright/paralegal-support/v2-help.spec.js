const { test, expect } = require('../support-session-fixture');
const { reviewOffice } = require('./office-polish-review');
const path = require('node:path');
const AxeBuilder = require('@axe-core/playwright').default;

const ACCOUNT_A = '64b000000000000000000001';
const ACCOUNT_B = '64b000000000000000000002';
const report = { summary: 'Browse filters do not update', description: 'After choosing a practice area, the visible list keeps the earlier filter.' };
const success = { ok: true, incident: { publicId: 'INC-20260909-000204', userVisibleStatus: 'received' }, reporterAccessToken: 'synthetic-help-reporter-token' };

async function json(route, payload, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
}

async function installHelpSession(page) {
  const state = { user: {
    _id: ACCOUNT_A, id: ACCOUNT_A, firstName: 'Dana', lastName: 'Young', role: 'paralegal', status: 'approved',
    email: 'dana@example.com', profileImage: '/assets/avatar-placeholder.svg', profilePhotoStatus: 'approved',
    yearsExperience: 8, practiceAreas: ['Litigation'], stateExperience: ['NY'], location: 'NY',
    resumeURL: `users/${ACCOUNT_A}/resume/current.pdf`, availability: 'Available',
    preferences: { theme: 'light', fontSize: 'md', hideProfile: false },
    onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true },
  } };
  await page.addInitScript(() => {
    window.EventSource = class extends EventTarget { constructor(url) { super(); this.url = url; this.readyState = 1; } close() { this.readyState = 2; } };
  });
  await page.route('**/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const responses = {
      '/api/auth/me': { user: state.user }, '/api/users/me': state.user,
      '/api/users/me/onboarding': { onboarding: state.user.onboarding }, '/api/csrf': { csrfToken: 'synthetic-help-csrf' },
      '/api/account/preferences': state.user.preferences, '/api/paralegal/dashboard': { activeCases: [], completedCases: [] },
      '/api/jobs/recommended': [], '/api/jobs/open': [], '/api/applications/my': [], '/api/cases/invited-to': [],
      '/api/cases/my-completed': { items: [] }, '/api/notifications': [], '/api/notifications/page': { items: [], hasMore: false, nextCursor: null }, '/api/notifications/unread-count': { count: 0, unreadCount: 0 },
      '/api/messages/threads': { items: [] }, '/api/messages/unread-count': { count: 0, unreadCount: 0 },
      '/api/events': { items: [] }, '/api/payments/connect/status': { readiness: { ready: true, accountPresent: true, evidenceState: 'verified' } },
      '/api/support/conversation': { conversation: { id: 'help-conversation', status: 'open' }, messages: [] },
    };
    return json(route, responses[pathname] || {});
  });
  return state;
}

async function openHelp(page, viewport = { width: 1440, height: 1000 }) {
  await page.setViewportSize(viewport);
  await page.goto('/paralegal-v2.html#/help');
  await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
  await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', 'help');
  await expect(page.getByRole('heading', { level: 1, name: 'Help for Paralegals' })).toBeVisible();
  return {
    summary: page.getByLabel('Short summary'), description: page.getByLabel('What happened?'),
    submit: page.locator('.v2-help-submit'), status: page.locator('.v2-help-report-status'),
  };
}

async function fillReport(fields, values = report) {
  await fields.summary.fill(values.summary);
  await fields.description.fill(values.description);
}

async function expectCleanStatus(status) {
  await expect(status).not.toContainText(/\b(?:null|undefined)\b/);
  expect(await status.evaluate(element => [...element.childNodes].every(child => child.nodeType === Node.ELEMENT_NODE))).toBe(true);
}

async function changeRoute(page, route) {
  await page.evaluate(hash => { window.location.hash = hash; }, route);
  await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', route.startsWith('/help') ? 'help' : 'home');
}

test('Help validates with keyboard focus and no absent metadata text', async ({ page }) => {
  await installHelpSession(page);
  let requests = 0;
  await page.route('**/api/incidents', route => { requests++; return json(route, success, 201); });
  const fields = await openHelp(page);
  await fields.submit.focus();
  await fields.submit.press('Enter');
  await expect(fields.summary).toBeFocused();
  await expect(fields.status).toContainText('More detail needed');
  await expectCleanStatus(fields.status);
  await fields.summary.fill(report.summary);
  await fields.summary.press('Enter');
  await expect(fields.description).toBeFocused();
  await expectCleanStatus(fields.status);
  expect(requests).toBe(0);
});

test('Help shows pending, reports receipt and retains reporter access after one confirmed submit', async ({ page }) => {
  await installHelpSession(page);
  const requests = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/incidents', async route => { requests.push(route.request().postDataJSON()); await gate; await json(route, success, 201); });
  const fields = await openHelp(page);
  await fillReport(fields);
  await fields.submit.click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(fields.submit).toBeDisabled();
  await expect(fields.status).toContainText('Sending your report to LPC.');
  await expectCleanStatus(fields.status);
  await fields.summary.press('Enter');
  expect(requests).toHaveLength(1);
  release();
  await expect(fields.status).toContainText('Report received');
  await expect(fields.status).toContainText('Reference: INC-20260909-000204');
  await expect(fields.status).not.toContainText('Status: received');
  await expect(fields.status.getByRole('link', { name: 'View report', exact: true })).toHaveAttribute('href', '#/help?incident=INC-20260909-000204');
  await expectCleanStatus(fields.status);
  await expect(fields.summary).toHaveValue('');
  await expect(fields.description).toHaveValue('');
  await expect(fields.submit).toBeEnabled();
  expect(requests[0]).toMatchObject({ ...report, reporterId: ACCOUNT_A, featureKey: 'paralegal-v2-help', routePath: '/paralegal-v2.html' });
  expect(requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[0].diagnostics.pageUrl).toContain('#/help');
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('incident-access:INC-20260909-000204')))).toMatchObject({
    publicId: 'INC-20260909-000204', reporterAccessToken: success.reporterAccessToken,
  });
});

test('Help retains a failed draft and retries the exact payload, then accepts corrected input', async ({ page }) => {
  await installHelpSession(page);
  const requests = [];
  await page.route('**/api/incidents', route => {
    requests.push(route.request().postDataJSON());
    return requests.length === 1 ? json(route, { error: 'Issue intake is temporarily unavailable.' }, 503)
      : requests.length === 2 ? json(route, { error: 'Check the report.', fields: { summary: 'Add the affected section to the summary.' } }, 422)
        : json(route, success, 201);
  });
  const fields = await openHelp(page, { width: 390, height: 844 });
  await fillReport(fields);
  await fields.submit.click();
  await expect(fields.status).toContainText('Receipt unconfirmed');
  await expect(fields.status).toContainText('check this submission before sending another report');
  await expectCleanStatus(fields.status);
  await expect(fields.summary).toHaveValue(report.summary);
  await expect(fields.description).toHaveValue(report.description);
  await expect(fields.submit).toHaveText('Try again');
  await fields.submit.press('Enter');
  await expect(fields.status).toContainText('Add the affected section to the summary.');
  await expectCleanStatus(fields.status);
  expect(requests[1]).toEqual(requests[0]);
  await fields.summary.fill('Browse Matters: practice filter does not update');
  await fields.submit.click();
  await expect(fields.status).toContainText('Report received');
  expect(requests[2].summary).toBe('Browse Matters: practice filter does not update');
  expect(requests[2].description).toBe(report.description);
});

test('Help preserves edits made while a report is pending', async ({ page }) => {
  await installHelpSession(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/incidents', async route => { await gate; await json(route, success, 201); });
  const fields = await openHelp(page);
  await fillReport(fields);
  await fields.submit.click();
  await expect(fields.submit).toBeDisabled();
  await fields.description.fill('New details added after the initial report was sent.');
  release();
  await expect(fields.status).toContainText('Report received');
  await expect(fields.description).toHaveValue('New details added after the initial report was sent.');
  await expect(fields.summary).toHaveValue(report.summary);
  await expect(fields.status).toContainText('Your newer edits are still in the form.');
});

test('Help preserves navigation drafts and keyboard disclosure state on mobile', async ({ page }) => {
  await installHelpSession(page);
  const fields = await openHelp(page, { width: 390, height: 844 });
  const answer = page.locator('.v2-help-answer').filter({ hasText: 'How do I respond to a revision request?' });
  await answer.locator('summary').focus();
  await answer.locator('summary').press('Enter');
  await expect(answer).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Report an issue', exact: true }).focus();
  await page.getByRole('button', { name: 'Report an issue', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Report an issue', exact: true })).toBeFocused();
  await fillReport(fields);
  await changeRoute(page, '/home?view=work');
  await changeRoute(page, '/help');
  await expect(fields.summary).toHaveValue(report.summary);
  await expect(fields.description).toHaveValue(report.description);
  await expect(answer).toHaveAttribute('open', '');
  for (const [name, href] of [['Reset password', '/forgot-password.html'], ['Privacy Policy', '/privacy.html'], ['Terms of Service', '/terms.html'], ['Accessibility', '/accessibility.html']]) {
    await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  }
});

test('Help ignores a completed old-account report after identity replacement', async ({ page }) => {
  const state = await installHelpSession(page);
  await page.route('**/api/incidents', route => json(route, success, 201));
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]) === '/api/incidents' && !window.__heldHelpResponse) {
        window.__heldHelpResponse = true;
        const body = await response.clone().text();
        await new Promise(resolve => { window.__releaseHelpResponse = resolve; });
        window.__releasedHelpResponse = true;
        return new Response(body, { status: response.status, headers: response.headers });
      }
      return response;
    };
  });
  const fields = await openHelp(page);
  await fillReport(fields);
  await fields.submit.click();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseHelpResponse)).toBe('function');
  state.user = { ...state.user, _id: ACCOUNT_B, id: ACCOUNT_B, firstName: 'Blair', email: 'blair@example.com' };
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'lpc_user', oldValue: 'account-a', newValue: 'account-b' })));
  await expect(page.locator('[data-v2-profile-name]')).toContainText('Blair');
  await expect(fields.summary).toHaveValue('');
  await fillReport(fields, { summary: 'Blair unsent report', description: 'New account draft must be retained.' });
  await page.evaluate(() => window.__releaseHelpResponse());
  await expect.poll(() => page.evaluate(() => window.__releasedHelpResponse)).toBe(true);
  await expect(fields.status).toBeHidden();
  await expect(fields.description).toHaveValue('New account draft must be retained.');
  expect(await page.evaluate(() => sessionStorage.getItem('incident-access:INC-20260909-000204'))).toBeNull();
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
});

test('Help recovers a lost receipt after reload before sending newer edits as a separate report', async ({ page }, testInfo) => {
  await installHelpSession(page);
  const requests = [];
  await page.route('**/api/incidents', route => {
    requests.push(route.request().postDataJSON());
    // The browser cannot distinguish this lost response from a committed report.
    // The companion Mongo-backed route tests prove durable replay semantics.
    return requests.length === 1 ? route.abort('failed') : json(route, success, requests.length === 2 ? 200 : 201);
  });
  let fields = await openHelp(page, { width: 390, height: 844 });
  await fillReport(fields);
  await fields.submit.click();
  await expect(fields.status).toContainText('Receipt unconfirmed');
  await expect(fields.submit).toHaveText('Try again');
  await fields.description.fill('Further investigation: the filter returns after navigating back.');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
  fields = { summary: page.getByLabel('Short summary'), description: page.getByLabel('What happened?'), submit: page.locator('.v2-help-submit'), status: page.locator('.v2-help-report-status') };
  await expect(fields.submit).toHaveText('Check report');
  await expect(fields.summary).toHaveValue(report.summary);
  await expect(fields.description).toHaveValue('Further investigation: the filter returns after navigating back.');
  expect(requests).toHaveLength(1);
  await fields.submit.press('Enter');
  await expect(fields.status).toContainText('Report received');
  expect(requests[1]).toEqual(requests[0]);
  await expect(fields.description).toHaveValue('Further investigation: the filter returns after navigating back.');
  await expect(fields.status).toContainText('Your newer edits are still in the form.');
  await fields.status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(process.env.LPC_DESIGN_REVIEW_DIR, `${testInfo.project.name}-help-recovered-receipt-mobile.png`) });
  await fields.submit.click();
  await expect(fields.description).toHaveValue('');
  expect(requests[2].requestId).not.toBe(requests[0].requestId);
  expect(requests[2].description).toBe('Further investigation: the filter returns after navigating back.');
  expect(await page.evaluate(owner => sessionStorage.getItem(`lpc:v2:help-draft:${owner}`), ACCOUNT_A)).toBeNull();
  await page.reload();
  await expect(fields.summary).toHaveValue('');
  await expect(fields.description).toHaveValue('');
  await expect(fields.status).toBeHidden();
});

test('Help keeps an unconfirmed report recoverable even when current inputs are cleared', async ({ page }) => {
  await installHelpSession(page);
  const requests = [];
  await page.route('**/api/incidents', route => {
    requests.push(route.request().postDataJSON());
    return requests.length === 1 ? json(route, { ok: true }, 200) : json(route, success, 200);
  });
  const fields = await openHelp(page);
  await fillReport(fields);
  await fields.submit.click();
  await expect(fields.status).toContainText('Receipt unconfirmed');
  await expect(fields.summary).toHaveValue(report.summary);
  await fields.summary.fill('');
  await fields.description.fill('');
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await page.reload();
  await expect(fields.submit).toHaveText('Check report');
  await fields.submit.click();
  await expect(fields.status).toContainText('Report received');
  expect(requests[1]).toEqual(requests[0]);
  await expect(fields.summary).toHaveValue('');
  await expect(fields.description).toHaveValue('');
});

test('Help keeps a refused account submission out of the success state and clears old account storage', async ({ page }) => {
  const state = await installHelpSession(page);
  const requests = [];
  await page.route('**/api/incidents', route => {
    requests.push(route.request().postDataJSON());
    return json(route, { code: 'HELP_REPORTER_CHANGED', error: 'Your signed-in account changed. Return to Help in the correct account before sending this report.' }, 403);
  });
  const fields = await openHelp(page);
  await page.evaluate(token => sessionStorage.setItem('incident-access:EARLIER-REPORT', JSON.stringify({ reporterAccessToken: token })), 'synthetic-old-access');
  await fillReport(fields);
  await fields.submit.click();
  await expect(page).toHaveURL(/\/login\.html(?:[?#]|$)/);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('body')).not.toContainText('Report received');
  expect(requests).toHaveLength(1);
  expect(requests[0].reporterId).toBe(ACCOUNT_A);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('incident-access:') || key.startsWith('lpc:v2:help-draft:')))).toEqual([]);
  state.user = { ...state.user, _id: ACCOUNT_B, id: ACCOUNT_B, firstName: 'Blair', email: 'blair@example.com' };
  await openHelp(page);
  await expect(page.locator('[data-v2-profile-name]')).toContainText('Blair');
  await expect(fields.summary).toHaveValue('');
  await expect(fields.description).toHaveValue('');
  await expect(fields.status).toBeHidden();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('incident-access:') || key.startsWith('lpc:v2:help-draft:')))).toEqual([]);
});

test('Help remains usable with unavailable draft storage and protects unfinished input', async ({ page }) => {
  await installHelpSession(page);
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (String(key).startsWith('lpc:v2:help-draft:') || String(key).startsWith('incident-access:')) throw new DOMException('Storage unavailable', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await page.route('**/api/incidents', route => json(route, success, 201));
  const fields = await openHelp(page);
  await fillReport(fields);
  await changeRoute(page, '/home?view=work');
  await changeRoute(page, '/help');
  await expect(fields.description).toHaveValue(report.description);
  expect(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })).toBe(true);
  await fields.submit.click();
  await expect(fields.status).toContainText('Report received');
  await expect(fields.description).toHaveValue('');
});

test('Help and report states remain readable and operable in supported layouts', async ({ page }, testInfo) => {
  await installHelpSession(page);
  const fields = await openHelp(page);
  await fields.submit.click();
  await expect(fields.status).toContainText('More detail needed');
  await reviewOffice(page, testInfo, 'help-validation');
});

test('Help pending, error and receipt feedback stays readable at the form in both themes', async ({ page }, testInfo) => {
  await installHelpSession(page);
  let release;
  let requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/incidents', async route => {
    requests++;
    if (requests === 1) { await gate; await json(route, { error: 'Intake is temporarily unavailable.' }, 503); }
    else await json(route, success, 200);
  });
  const fields = await openHelp(page);
  await fillReport(fields);
  await fields.submit.click();
  for (const state of ['pending', 'error', 'receipt']) {
    if (state === 'error') { release(); await expect(fields.status).toContainText('Receipt unconfirmed'); }
    if (state === 'receipt') { await fields.submit.click(); await expect(fields.status).toContainText('Report received'); }
    for (const [theme, width] of [['light', 1440], ['dark', 390]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(theme => document.documentElement.classList.toggle('theme-dark', theme === 'dark'), theme);
      await fields.status.scrollIntoViewIfNeeded();
      const result = await new AxeBuilder({ page }).include('.v2-help-report').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(result.violations, `${state} ${theme}: form accessibility`).toEqual([]);
      await page.screenshot({ path: path.join(process.env.LPC_DESIGN_REVIEW_DIR, `${testInfo.project.name}-help-${state}-${theme}-${width}.png`) });
    }
  }
});


test('Help receipt opens the current report and preserves a newer form draft on return', async ({ page }) => {
  await installHelpSession(page);
  let writes = 0;
  await page.route('**/api/incidents', route => { writes++; return json(route, success, 201); });
  await page.route('**/api/incidents/INC-20260909-000204?*', route => json(route, { ok: true, incident: { publicId: success.incident.publicId, summary: report.summary, userVisibleStatus: 'investigating', createdAt: '2026-09-09T12:00:00.000Z', updatedAt: '2026-09-09T12:00:00.000Z', resolution: null } }));
  const fields = await openHelp(page);
  await fillReport(fields); await fields.submit.click();
  await expect(fields.status).toContainText('Report received');
  await fillReport(fields, { summary: 'A separate report draft', description: 'These newer details must remain in the form.' });
  await fields.status.getByRole('link', { name: 'View report', exact: true }).click();
  await expect(page.locator('.lpc-report-status').getByText('Under review', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/help\?incident=INC-20260909-000204$/);
  await page.getByRole('link', { name: 'Back to Help', exact: true }).click();
  await expect(fields.summary).toHaveValue('A separate report draft');
  await expect(fields.description).toHaveValue('These newer details must remain in the form.');
  expect(writes).toBe(1);
});
