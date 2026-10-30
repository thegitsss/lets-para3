const { test, expect } = require('../workspace-paired-observation.cjs');
const start = require('../../helpers/financialLifecycleBrowserServer');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const inspectBrowserDiagnostics = require('./browser-diagnostics');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeAdminSupport: true, includeAdminWorkspaces: true }); });
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
  let paralegalOwnerId, releaseDecisionResponse = () => {};
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
  const email = `admission-${randomUUID()}@example.com`, password = 'A synthetic professional passphrase!';
  try {
    await page.goto(`${server.origin}/signup.html?role=paralegal`);
    await page.locator('#fullName').fill('Morgan Admission'); await page.locator('#email').fill(email); await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('#signupState').selectOption('CA'); await page.locator('#paralegalExperience').fill('6');
    await page.locator('#resumeUpload').setInputFiles({ name: 'Resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF') });


    await page.waitForFunction(() => window.LPCSignupPolicy?.read());

    const acceptedPolicy = await page.evaluate(() => window.LPCSignupPolicy.read());
    expect(acceptedPolicy).toMatchObject({ termsHash: expect.stringMatching(/^[a-f0-9]{64}$/), privacyHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    // The disposable test environment bypasses the external challenge provider;
    // the real form and registration API still validate and persist the account.
    await page.evaluate(() => { const input = document.createElement('input'); input.name = 'cf-turnstile-response'; input.type = 'hidden'; input.value = 'synthetic-admission-challenge'; document.querySelector('#signupForm').append(input); });
    await page.getByRole('button', { name: 'Submit application', exact: true }).click();
    await expect(page.locator('#signupConfirmation')).toBeVisible();
    await expect(page.locator('#signupConfirmationTitle')).toHaveText('Application submitted.');
    await expect(page.locator('#signupConfirmationEmail')).toContainText(`We’ve sent a verification email to ${email}. Once your application has been reviewed, we’ll email you with a decision.`);
    const User = require('../../../models/User');
    const applicant = await User.findOne({ email }).select('+policyAcknowledgements').lean();
    expect(applicant).toMatchObject({ role: 'paralegal', status: 'pending', emailVerified: false, yearsExperience: 6 });
    expect(applicant).toMatchObject({ termsAccepted: true, termsAcceptedAt: expect.any(Date), privacyAcknowledgedAt: expect.any(Date), termsDocumentHash: acceptedPolicy.termsHash, privacyDocumentHash: acceptedPolicy.privacyHash });
    expect(applicant.policyAcknowledgements).toEqual([expect.objectContaining({ source: 'signup', ...acceptedPolicy, acceptedAt: expect.any(Date) })]);
    const id = String(applicant._id);
    paralegalOwnerId = id;
    const verification = server.evidence().external.mail.find(call => call[0] === email && call[1] === 'Verify your email'); expect(verification).toBeTruthy();
    const token = decodeURIComponent(verification[2].match(/token=([^&\s"'<>]+)/i)[1]);
    await page.goto(`${server.origin}/verify-email.html?token=${encodeURIComponent(token)}`);
    await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state', 'ready');
    expect((await User.findById(id).lean()).emailVerified).toBe(false);
    await page.getByRole('button', { name: 'Verify email', exact: true }).click();
    await expect(page.locator('#verificationPanel')).toHaveAttribute('data-state', 'success');
    expect((await User.findById(id).lean()).emailVerified).toBe(true);
    await login(page, email, password);
    const pendingApproval = page.locator('#loginApprovalDialog');
    await expect(pendingApproval).toBeVisible();
    await expect(pendingApproval.getByRole('heading')).toHaveText('Your sign-up request was sent and is pending approval.');
    await expect(pendingApproval.locator('.verification-note')).not.toBeVisible();
    await expect(pendingApproval.locator('details')).not.toBeVisible();
    await pendingApproval.getByRole('button', { name: 'Got it', exact: true }).click();
    await expect(pendingApproval).not.toBeVisible();
    await expect(page.locator('#email')).toBeFocused();
    expect((await page.request.get(`${server.origin}/api/paralegal/dashboard`)).status()).toBe(401);
    checkpoints.push('registered, verified, and denied workspace access while pending');
    const information = await api(adminContext, 'post', `/api/admin/workspace/accounts/${id}/information-request`, { requestId: randomUUID(), text: 'Please confirm your contract review experience.' });
    expect(information.ok).not.toBe(false); expect((await User.findById(id).lean()).status).toBe('pending');
    const adminPage = await adminContext.newPage();
    await adminPage.goto(`${server.origin}/admin-dashboard.html`);
    await adminPage.waitForFunction(() => typeof window.reviewAdminApplicant === 'function');
    await adminPage.evaluate(id => window.reviewAdminApplicant(id), id);
    const approve = adminPage.locator('#approveUserBtn');
    await expect(adminPage.locator('.admin-qualification-review')).toHaveCount(0);
    await expect(approve).toBeEnabled();
    await adminPage.screenshot({ path: info.outputPath('admin-qualification-review.png') });
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await approve.scrollIntoViewIfNeeded();
    await adminPage.screenshot({ path: info.outputPath('admin-qualification-review-phone.png') });
    expect(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Keep the real committed response in flight while the owner reopens the
    // same account. Its earlier review must not close or reset the new one.
    const decisionGate = new Promise(resolve => { releaseDecisionResponse = resolve; });
    let reportDecision;
    const committedDecision = new Promise(resolve => { reportDecision = resolve; });
    const receivedDecision = adminPage.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/users/${id}/approve` && response.request().method() === 'POST');
    let approvalWrites = 0;
    await adminPage.route(url => url.pathname === `/api/admin/users/${id}/approve`, async route => {
      approvalWrites++; expect(new URL(route.request().url()).searchParams.get('expectedOwnerId')).toBe(admin.id);
      const response = await route.fetch();
      reportDecision(response);
      await decisionGate;
      await route.fulfill({ response });
    });
    await approve.click();
    expect((await committedDecision).ok()).toBe(true);
    await expect.poll(async () => (await User.findById(id).lean()).status).toBe('approved');
    await adminPage.evaluate(id => window.reviewAdminApplicant(id), id);
    await expect(approve).toBeDisabled();
    const modal = adminPage.locator('#pendingUserModal'), accountFacts = adminPage.locator('#adminAccountContext .admin-facts');
    const reopenedRevision = await modal.getAttribute('data-admission-revision');
    expect(reopenedRevision).toMatch(/^[a-f0-9]{64}$/);
    releaseDecisionResponse();
    const deliveredDecision = await receivedDecision; expect(deliveredDecision.ok()).toBe(true); await deliveredDecision.finished();
    await expect(accountFacts.locator('div').filter({has:adminPage.getByText('Application',{exact:true})}).locator('strong')).toHaveText('approved');
    await expect(accountFacts.locator('div').filter({has:adminPage.getByText('Account access',{exact:true})}).locator('strong')).toHaveText('Enabled');
    await expect(modal).toHaveAttribute('data-admission-owner-id',admin.id);
    await expect(modal).toHaveAttribute('data-admission-user-id',id);
    await expect(modal).toHaveAttribute('data-admission-revision',reopenedRevision);
    await expect(adminPage.getByRole('status').filter({hasText:'User approved.'})).toHaveCount(0);
    await expect(adminPage.locator('#pendingUserModal')).toBeVisible();
    await expect(approve).toHaveText('Approve');
    await adminPage.locator('[data-account-tab="history"]').click();
    const admissionHistory = adminPage.locator('[data-account-panel="history"]');
    await expect(admissionHistory.locator('strong').filter({ hasText: /^approved$/ })).toHaveCount(1);
    await expect(admissionHistory).not.toContainText('Qualification verified:');
    expect(approvalWrites).toBe(1);
    expect(await require('../../../models/AuditLog').countDocuments({action:'admin.user.approved',targetId:applicant._id})).toBe(1);
    await expect(modal).toHaveAttribute('data-admission-revision',reopenedRevision);
    await expect(adminPage.getByRole('status').filter({hasText:'User approved.'})).toHaveCount(0);
    await admissionHistory.screenshot({ path: info.outputPath('admin-qualification-history-phone.png') });
    await adminPage.close();
    expect(await User.findById(id).lean()).toMatchObject({ status: 'approved', preferences: { hideProfile: true } });
    await login(page, email, password); await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    const welcome = page.locator('[data-v2-onboarding-dialog="welcome-v1"]');
    await expect(welcome).toBeVisible();
    await expect(page.locator('.lpc-boot-screen[open]')).toHaveCount(0);
    await expect(welcome.getByRole('button', { name: 'Explore first', exact: true })).toBeVisible();
    await expect(welcome.getByRole('button', { name: 'Set up my account', exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: info.outputPath('welcome-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(welcome.getByRole('button', { name: 'Set up my account', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: info.outputPath('welcome-mobile.png') });
    let failedWrites = 0;
    await page.route('**/api/users/me/onboarding', route => {
      if (route.request().method() === 'PATCH') {
        expect(route.request().postDataJSON().expectedOwnerId).toBe(id);
        if (failedWrites++ === 0) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Tour progress could not be saved.' }) });
      }
      return route.continue();
    });
    await welcome.getByRole('button', { name: 'Explore first', exact: true }).click();
    await expect(welcome).toHaveCount(0);
    await expect(page.locator('[data-v2-toast-region]')).toContainText('Progress couldn’t sync');
    expect((await User.findById(id).lean()).onboarding.paralegalTourCompleted).toBe(false);
    const outboxKey = `lpc_portal_tour_pending_v1:${id}`;
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), outboxKey)).toEqual({ 'welcome-v1': 'dismissed' });
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    await expect.poll(async () => (await User.findById(id).lean()).onboarding.paralegalTours['welcome-v1']).toBe('dismissed');
    expect((await User.findById(id).lean()).onboarding.paralegalTourCompleted).toBe(true);
    expect(failedWrites).toBe(2);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), outboxKey)).toBeNull();
    await expect(welcome).toHaveCount(0);
    for (const route of ['browse', 'work', 'home']) {
      await page.goto(`${server.origin}/paralegal-v2.html#/${route}`);
      await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', route);
      await expect(page.locator('[data-v2-route-outlet]')).toBeVisible();
    }
    await page.getByRole('button', { name: 'Replay tour', exact: true }).click();
    await expect(welcome).toBeVisible();
    await welcome.getByRole('button', { name: 'Set up my account', exact: true }).click();
    const resumeIntro = page.locator('dialog.ri-dialog[open]');
    await expect(resumeIntro).toBeVisible();
    await expect(resumeIntro).toContainText('Your résumé has a head start.');
    await page.screenshot({ animations: 'disabled', path: info.outputPath('setup-resume-mobile.png') });
    await resumeIntro.getByRole('button', { name: 'I’ll enter it myself', exact: true }).click();
    await expect(resumeIntro).toHaveCount(0);
    await expect(page.locator('#v2-settings-profile')).toBeVisible();
    await expect.poll(async () => (await User.findById(id).lean()).onboarding.paralegalTours['welcome-v1']).toBe('dismissed');
    await page.unroute('**/api/users/me/onboarding');
    await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-v2-session', 'ready');
    await expect(page.locator('html')).toHaveAttribute('data-lpc-v2-committed-route', 'settings');
    await expect(page.getByRole('button', { name: 'Edit personal details name', exact: true })).toContainText('Morgan Admission');
    await expect(page.locator('[data-v2-onboarding-dialog][open]')).toHaveCount(0);
    await page.screenshot({ animations: 'disabled', path: info.outputPath('approved-first-workspace.png') });
    checkpoints.push('approved and signed into V2; current welcome and setup flow persisted owner-bound progress; failed sync recovered on reload; normal routes remained available');
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
            || /^page\.reload: net::ERR_ABORTED(?:; maybe frame was detached\?)?$/.test(message)
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
    await page.screenshot({ animations: 'disabled', path: info.outputPath('reinstated-workspace.png') });
    checkpoints.push('suspension revoked session and blocked sign-in; reinstatement required fresh sign-in and retained completed tours');
    expect(diagnostics().documentFailures).toEqual([]);
    expect(diagnostics().unexplainedPageErrors).toEqual([]);
    expect(server.evidence().provider).toEqual([]);
  } finally {
    releaseDecisionResponse();
    await fs.writeFile(info.outputPath('admission-evidence.json'), JSON.stringify({ checkpoints, errors, browserEvents, navigationInterruptions, browserDiagnostics: diagnostics(), requests: server.evidence().requests, storage: server.evidence().external.storage, provider: server.evidence().provider, mailSubjects: server.evidence().external.mail.map(call => call[1]) }, null, 2));
    await context.close(); await adminContext.close();
  }
});
