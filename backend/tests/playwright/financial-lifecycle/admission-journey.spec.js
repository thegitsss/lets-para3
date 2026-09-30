const { test, expect } = require('playwright/test');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const start = require('../../helpers/financialLifecycleBrowserServer');
const inspectBrowserDiagnostics = require('./browser-diagnostics');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeAdminSupport: true }); });
test.beforeEach(async () => server.reset());
test.afterAll(async () => server?.close());
async function api(context, method, path, data) {
  const csrf = await (await context.request.get(`${server.origin}/api/csrf`)).json();
  const response = await context.request[method](`${server.origin}${path}`, { headers: { 'X-CSRF-Token': csrf.csrfToken }, ...(data ? { data } : {}) });
  expect(response.headers()['x-lpc-test-server']).toBe('financial-lifecycle-browser');
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function login(page, email, password) {
  await page.goto(`${server.origin}/login.html?next=${encodeURIComponent('/paralegal-v2.html#/home')}`);
  await page.locator('#email').fill(email); await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('actual paralegal admission reaches the first workspace, retains tour recovery, and enforces suspension and reinstatement', async ({ browser }, info) => {
  const admin = await server.createUser('admin');
  const adminContext = await browser.newContext(); await adminContext.addCookies([admin.cookie]);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
  const page = await context.newPage(), errors = [], checkpoints = [], browserEvents = [], navigationInterruptions = [];
  let paralegalOwnerId;
  const diagnostics = () => inspectBrowserDiagnostics({ engine: info.project.name, origin: server.origin, paralegalOwnerId, errors, events: browserEvents });
  await context.addInitScript(() => {
    const documentId = crypto.randomUUID();
    const report = (type, detail = {}) => console.debug('LPC_ADMISSION_DEPARTURE ' + JSON.stringify({ documentId, type, page: location.href, at: Date.now(), ...detail }));
    for (const type of ['beforeunload', 'pagehide', 'pageshow']) addEventListener(type, event => report(type, { persisted: event.persisted }));
    addEventListener('error', event => report('windowerror', { message: event.message, filename: event.filename, stack: event.error?.stack }));
    addEventListener('unhandledrejection', event => report('unhandledrejection', { message: String(event.reason), stack: event.reason?.stack }));
  });
  page.on('pageerror', error => errors.push({ role: 'paralegal', name: error.name, message: error.message, stack: error.stack, page: page.url(), at: Date.now() }));
  page.on('console', message => {
    const prefix = 'LPC_ADMISSION_DEPARTURE ';
    if (message.text().startsWith(prefix)) browserEvents.push({ role: 'paralegal', ...JSON.parse(message.text().slice(prefix.length)) });
  });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) browserEvents.push({ role: 'paralegal', type: 'navigation', page: page.url(), at: Date.now() }); });
  const email = `admission-${randomUUID()}@example.test`, password = 'A synthetic professional passphrase!';
  try {
    await page.goto(`${server.origin}/signup.html?role=paralegal`);
    await page.locator('#fullName').fill('Morgan Admission'); await page.locator('#email').fill(email); await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('#signupState').selectOption('CA'); await page.locator('#paralegalExperience').fill('6'); await page.locator('#paralegalQualification').selectOption('law_firm_experience');
    await page.locator('#resumeUpload').setInputFiles({ name: 'Resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF') });
    // The disposable test environment bypasses the external challenge provider;
    // the real form and registration API still validate and persist the account.
    await page.evaluate(() => { const input = document.createElement('input'); input.name = 'cf-turnstile-response'; input.type = 'hidden'; input.value = 'synthetic-admission-challenge'; document.querySelector('#signupForm').append(input); });
    await page.getByRole('button', { name: 'Submit application', exact: true }).click();
    await expect(page.locator('#signupConfirmation')).toBeVisible();
    await expect(page.locator('#signupConfirmation')).toContainText('under review');
    const User = require('../../../models/User');
    const applicant = await User.findOne({ email }).lean();
    expect(applicant).toMatchObject({ role: 'paralegal', status: 'pending', emailVerified: false, yearsExperience: 6 });
    const id = String(applicant._id);
    paralegalOwnerId = id;
    const verification = server.evidence().external.mail.find(call => call[0] === email && call[1] === 'Verify your email'); expect(verification).toBeTruthy();
    const token = decodeURIComponent(verification[2].match(/token=([^&\s"'<>]+)/i)[1]);
    await page.goto(`${server.origin}/verify-email.html?token=${encodeURIComponent(token)}`);
    await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state', 'success');
    expect((await User.findById(id).lean()).emailVerified).toBe(true);
    await login(page, email, password); await expect(page.locator('body')).toContainText('Your account is still under review.');
    expect((await page.request.get(`${server.origin}/api/paralegal/dashboard`)).status()).toBe(401);
    checkpoints.push('registered, verified, and denied workspace access while pending');
    const information = await api(adminContext, 'post', `/api/admin/workspace/accounts/${id}/information-request`, { requestId: randomUUID(), text: 'Please confirm your contract review experience.' });
    expect(information.ok).not.toBe(false); expect((await User.findById(id).lean()).status).toBe('pending');
    await api(adminContext, 'post', `/api/admin/users/${id}/approve`, { note: 'Synthetic qualification review complete.' });
    expect(await User.findById(id).lean()).toMatchObject({ status: 'approved', preferences: { hideProfile: true } });
    await login(page, email, password); await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    const workspaceTour = page.locator('[data-v2-onboarding-dialog="workspace"]'); await expect(workspaceTour).toBeVisible();
    await workspaceTour.getByRole('button', { name: 'Next', exact: true }).click();
    await workspaceTour.getByRole('button', { name: 'Next', exact: true }).click();
    await workspaceTour.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect.poll(async () => (await User.findById(id).lean()).onboarding.paralegalTourCompleted).toBe(true);
    let failedWrites = 0;
    await page.route('**/api/users/me/onboarding', route => {
      if (route.request().method() === 'PATCH' && failedWrites++ === 0) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Tour progress could not be saved.' }) });
      return route.continue();
    });
    await page.getByRole('link', { name: 'Profile Settings', exact: true }).click();
    const profileTour = page.locator('[data-v2-onboarding-dialog="profile"]'); await expect(profileTour).toBeVisible();
    await profileTour.getByRole('button', { name: 'Skip tour', exact: true }).click();
    await expect(page.locator('body')).toContainText('Tour progress could not be saved.');
    expect((await User.findById(id).lean()).onboarding.paralegalProfileTourCompleted).toBe(false);
    await page.getByRole('link', { name: 'LPC Home', exact: true }).click();
    await page.getByRole('link', { name: 'Profile Settings', exact: true }).click();
    await expect(profileTour).toBeVisible(); await profileTour.getByRole('button', { name: 'Skip tour', exact: true }).click();
    await expect.poll(async () => (await User.findById(id).lean()).onboarding.paralegalProfileTourCompleted).toBe(true);
    expect(failedWrites).toBe(2); await page.unroute('**/api/users/me/onboarding');
    await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', 'settings');
    await expect(page.locator('[data-profile-field="firstName"]')).toHaveValue('Morgan');
    await expect(page.locator('[data-v2-onboarding-dialog][open]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('approved-first-workspace.png') });
    checkpoints.push('approved and signed into V2; both tours persisted; failed save required deliberate retry');
    await api(adminContext, 'post', `/api/admin/disable/${id}`, { reason: 'Synthetic access restriction check.' });
    try { await page.reload(); } catch (error) {
      // Suspension can start the sign-in redirect before this explicit reload.
      // Preserve observed native cancellations and still require the actual
      // same-origin sign-in destination, removed workspace and access denial.
      const message = String(error.message).split('\n')[0];
      const suspendedNavigation = info.project.name === 'firefox'
        ? /^page\.reload: NS_BINDING_ABORTED(?:; maybe frame was detached\?)?$/.test(message)
        : info.project.name === 'chromium'
          ? message === 'page.reload: Protocol error (Page.reload): Not attached to an active page'
          : info.project.name === 'webkit' && message === 'page.reload: Navigation canceled by policy check';
      if (!suspendedNavigation) throw error;
      navigationInterruptions.push({ action: 'suspension reload', engine: info.project.name, message, at: Date.now() });
    }
    await expect(page).toHaveURL(url => url.origin === server.origin && url.pathname === '/login.html');
    await expect(page.locator('[data-v2-route-outlet]')).toHaveCount(0);
    await login(page, email, password); await expect(page.locator('body')).toContainText(/deactivated|suspended/i);
    const denied = await page.request.get(`${server.origin}/api/paralegal/dashboard`);
    expect(denied.status()).toBe(403); expect(await denied.json()).toEqual({ error: 'This account has been deactivated.', msg: 'This account has been deactivated.' });
    await api(adminContext, 'post', `/api/admin/enable/${id}`, { reason: 'Synthetic review resolved.' });
    await login(page, email, password); await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', 'home');
    await expect(page.locator('[data-v2-home]')).not.toHaveAttribute('data-home-loading', 'true');
    await expect(page.locator('[data-v2-onboarding-dialog][open]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('reinstated-workspace.png') });
    checkpoints.push('suspension revoked session and blocked sign-in; reinstatement required fresh sign-in and retained completed tours');
    expect(diagnostics().documentFailures).toEqual([]);
    expect(diagnostics().unexplainedPageErrors).toEqual([]);
    expect(server.evidence().provider).toEqual([]);
  } finally {
    await fs.writeFile(info.outputPath('admission-evidence.json'), JSON.stringify({ checkpoints, errors, browserEvents, navigationInterruptions, browserDiagnostics: diagnostics(), requests: server.evidence().requests, storage: server.evidence().external.storage, provider: server.evidence().provider, mailSubjects: server.evidence().external.mail.map(call => call[1]) }, null, 2));
    await context.close(); await adminContext.close();
  }
});
