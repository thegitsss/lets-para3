const { expect } = require('playwright/test');
const { test } = require('../workspace-search/shell-fixture');
const { browsePageFixture } = require('../paralegal-support/browse-page-fixture');
const { receivedInvitations } = require('../paralegal-support/received-invitation-fixture');
const OWNER = '111111111111111111111111', MATTER = '222222222222222222222222', JOB = '333333333333333333333333';
const MESSAGE = 'Your résumé changed. Review your current profile before submitting again.';
const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
async function setup(page, kind, theme = 'light') {
  const user = { _id: OWNER, id: OWNER, role: 'paralegal', status: 'approved', firstName: 'Dana', lastName: 'Young', state: 'New York', preferences: { theme, fontSize: 'md' }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } };
  const listing = { _id: MATTER, caseId: MATTER, jobId: JOB, title: 'Retained résumé matter', description: 'Prepare the discovery chronology for attorney review.', practiceArea: 'Civil Litigation', state: 'New York', totalAmount: 90000, applicationEligibility: { ready: true, allowed: true, blockers: [], facts: { payoutReadiness: { ready: true, blockers: [] } } } };
  const calls = [];
  await page.addInitScript(identity => { localStorage.setItem('lpc_user', JSON.stringify(identity)); window.EventSource = class extends EventTarget { close() {} }; }, user);
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') {
      if (path === `/api/jobs/${JOB}/apply` || path === `/api/cases/${MATTER}/invite/accept`) { calls.push({ path, body: req.postDataJSON() }); return json(route, { error: MESSAGE }, 409); }
      if (path === '/api/users/me/onboarding') return json(route, { onboarding: user.onboarding });
      throw new Error(`Unexpected mutation ${path}`);
    }
    if (path === '/api/auth/me') return json(route, { user });
    if (path === '/api/users/me') return json(route, user);
    if (path === '/api/csrf') return json(route, { csrfToken: 'synthetic-document-conflict-token' });
    if (path === '/api/jobs/open') return json(route, browsePageFixture([listing], new URL(req.url()).searchParams, OWNER));
    if (path === '/api/cases/invited-to') return json(route, receivedInvitations(OWNER, kind === 'work' ? [{ _id: MATTER, caseId: MATTER, title: listing.title, totalAmount: 90000, currency: 'usd', inviteStatus: 'pending', inviteInvitedAt: '2026-09-01T14:00:00Z', attorney: { firstName: 'Jordan', lastName: 'Lee' } }] : [], new URL(req.url()).searchParams));
    if (path === '/api/applications/my' || path === '/api/cases/my-completed' || path === '/api/cases/my' || path === '/api/applications/recommendation-exclusions') return json(route, []);
    if (path === '/api/account/dashboard-views') return json(route, { scope: 'paralegal_applications', views: [] });
    if (path === '/api/paralegal/dashboard') return json(route, { activeCases: [], completedCases: [] });
    if (path === '/api/payments/connect/status') return json(route, { readiness: { ready: true, accountPresent: true, evidenceState: 'verified' } });
    if (path === '/api/users/me/onboarding') return json(route, { onboarding: user.onboarding });
    if (path === '/api/account/preferences') return json(route, user.preferences);
    if (path.endsWith('/unread-count')) return json(route, { count: 0 });
    if (path === '/api/notifications/page') return json(route, { items: [], nextCursor: null, hasMore: false });
    if (path === '/api/notifications') return json(route, []);
    if (path === '/api/support/conversation') return json(route, { conversation: { id: 'synthetic-document-support', status: 'open' }, messages: [] });
    return json(route, { items: [], total: 0 });
  });
  await page.goto(`/paralegal-v2.html#/${kind === 'work' ? 'work?section=invitations' : 'browse'}`);
  await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
  await expect(page.locator('[data-v2-route-outlet]')).not.toHaveAttribute('aria-busy', 'true');
  return calls;
}

async function readability(locator) {
  return locator.evaluate(element => {
    const rgb = value => (value.match(/[0-9.]+/g) || []).slice(0, 3).map(Number);
    const luminance = color => rgb(color).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const style = getComputedStyle(element); let parent = element, background;
    while (parent) { const color = getComputedStyle(parent).backgroundColor; if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; } parent = parent.parentElement; }
    background ||= 'rgb(255, 255, 255)'; const a = luminance(style.color), b = luminance(background);
    return { color: style.color, background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), opacity: style.opacity, outline: { color: style.outlineColor, width: style.outlineWidth, style: style.outlineStyle }, focused: document.activeElement === element, focusVisible: element.matches(':focus-visible') };
  });
}

for (const theme of ['light', 'dark']) test(`a résumé conflict preserves the application draft and readable recovery in ${theme}`, async ({ page }, info) => {
  const calls = await setup(page, 'browse', theme);
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/theme-dark/);
  const card = page.getByRole('heading', { name: 'Retained résumé matter' }).locator('xpath=ancestor::article');
  await card.getByRole('button', { name: 'Apply', exact: true }).click();
  const note = 'My original cover letter remains available after a résumé changed in another tab.';
  await page.getByRole('textbox', { name: 'Cover letter', exact: true }).fill(note);
  await page.getByRole('button', { name: 'Submit application', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(MESSAGE);
  await expect(page.getByRole('textbox', { name: 'Cover letter', exact: true })).toHaveValue(note);
  await expect(page.getByRole('button', { name: 'Submit application', exact: true })).toBeEnabled();
  expect(calls).toHaveLength(1); expect(calls[0].body.coverLetter).toBe(note);
  const geometry = await page.getByRole('button', { name: 'Submit application', exact: true }).evaluate(button => ({ text: button.textContent, rect: button.getBoundingClientRect().toJSON(), chain: [button, button.parentElement, button.parentElement.parentElement, button.closest('dialog')].map(element => { const s = getComputedStyle(element); return { tag: element.tagName, class: element.className, color: s.color, background: s.backgroundColor, opacity: s.opacity, visibility: s.visibility, display: s.display, border: s.borderColor }; }) }));
  await info.attach('submit-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
  const submit = page.getByRole('button', { name: 'Submit application', exact: true });
  await page.getByRole('textbox', { name: 'Cover letter', exact: true }).focus();
  const advance = info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.keyboard.press(advance); await page.keyboard.press(advance);
  await expect(submit).toBeFocused();
  const recovery = { submit: await readability(submit), feedback: await readability(page.locator('.v2-browse-dialog-status')) };
  await info.attach('recovery-contrast', { body: JSON.stringify(recovery, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('browse-conflict.png'), fullPage: true });
  expect(recovery.submit.contrast).toBeGreaterThanOrEqual(4.5);
  expect(recovery.feedback.contrast).toBeGreaterThanOrEqual(4.5);
  expect(recovery.submit.focusVisible).toBe(true);
  expect(Number.parseFloat(recovery.submit.outline.width)).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Close application', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Cover letter', exact: true })).toHaveValue(note);
  expect(calls).toHaveLength(1);
  await page.getByRole('button', { name: 'Submit application', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(MESSAGE); expect(calls).toHaveLength(2);
});

test('a résumé conflict keeps the pending invitation and restores its accept control without success feedback', async ({ page }, info) => {
  const calls = await setup(page, 'work');
  await page.locator('.v2-work-index').getByRole('link', { name: /Invitations/ }).click();
  const card = page.getByRole('heading', { name: 'Retained résumé matter' }).locator('xpath=ancestor::article');
  const accept = card.getByRole('button', { name: /Accept invitation|Accept$/, exact: false });
  await expect(accept).toBeEnabled(); await accept.click();
  await expect(page.getByText(MESSAGE, { exact: true })).toBeVisible();
  await expect(accept).toBeVisible(); await expect(accept).toBeEnabled();
  await expect(page.getByText('Invitation accepted.', { exact: true })).toHaveCount(0);
  expect(calls).toHaveLength(1);
  await page.screenshot({ path: info.outputPath('invitation-conflict.png'), fullPage: true });
  await accept.click(); await expect(page.getByText(MESSAGE, { exact: true })).toBeVisible(); expect(calls).toHaveLength(2);
});
