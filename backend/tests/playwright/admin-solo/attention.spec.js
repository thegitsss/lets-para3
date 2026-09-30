const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require('../../helpers/financialLifecycleBrowserServer');
let server, contexts = [];
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true, includeDirectors: true }); });
test.beforeEach(async () => server.reset());
test.afterEach(async () => { for (const context of contexts.splice(0)) await context.close(); });
test.afterAll(async () => server?.close());

async function open(browser, actor, viewport = { width: 1366, height: 900 }) {
  const context = await browser.newContext({ viewport }); contexts.push(context);
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage();
  await page.goto(server.origin + '/admin-dashboard.html?view=queue#overview');
  await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
  if (viewport.width <= 760 && await page.locator('[data-flow-select][aria-pressed="true"]').count()) {
    await page.locator('[data-flow-select][aria-pressed="true"]').click();
    await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
  }
  return page;
}
async function question() {
  return require('../../../models/SupportTicket').create({ subject: 'Help with finding my matter', message: 'Where can I find it?', requestKind: 'human', requesterEmail: 'synthetic@example.test', status: 'open' });
}

test('due personal application follow-ups explain why review has returned', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const applicant = await server.createUser('attorney');
  const User = require('../../../models/User');
  await User.updateOne({ _id: applicant.id }, { $set: { status: 'pending' } });
  const row = await User.findById(applicant.id).lean();
  const key = `application:${applicant.id}`;
  await require('../../../models/AdminFollowUp').create({ _id: `${actor.id}:${key}`, owner: actor.id, key, sourceRevision: row.updatedAt, followUpAt: new Date(Date.now() - 60000), revision: 1 });
  const page = await open(browser, actor, { width: 390, height: 844 });
  await expect(page.locator('#adminFlowReason')).toContainText('The follow-up you set is due.');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator(`[data-flow-select="${key}"]`)).toContainText('Follow-up due');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('due-follow-up-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('real decision selection preserves a private draft and the seven workspaces render', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const first = await server.createUser('attorney'), second = await server.createUser('attorney');
  await require('../../../models/User').updateMany({ _id: { $in: [first.id, second.id] } }, { $set: { status: 'pending' } });
  const page = await open(browser, actor), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.admin-queue-item')).toHaveCount(2);
  await page.locator(`[data-flow-select="application:${first.id}"]`).click();
  await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admin-account-id', first.id);
  await page.getByText('Need more information?', { exact: true }).click();
  await page.locator('#adminInformationText').fill('Please confirm your bar number.');
  await page.locator(`[data-flow-select="application:${second.id}"]`).click();
  await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admin-account-id', second.id);
  await page.reload();
  await expect(page.locator('#adminFlow')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admin-account-id', second.id);
  await expect(page.locator('#pendingUserModal')).toHaveClass(/admin-flow-inline/);
  await page.locator(`[data-flow-select="application:${first.id}"]`).click();
  await expect(page.locator('#adminInformationText')).toHaveValue('Please confirm your bar number.');
  await page.screenshot({ path: info.outputPath('live-today-desktop.png'), fullPage: true, animations: 'disabled' });
  for (const [section, name] of [['user-management','people'],['matters','matters'],['support-ops','inbox'],['finance','finance'],['marketing-drafts','growth'],['ai-control-room','system']]) {
    await page.locator(`#sidebarNav nav > [data-section="${section}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#${section}$`));
    await page.screenshot({ path: info.outputPath(`live-${name}-desktop.png`), fullPage: true, animations: 'disabled' });
  }
  await page.locator('#sidebarNav nav > [data-section="overview"]').click();
  await expect(page.locator('#adminInformationText')).toHaveValue('Please confirm your bar number.');
  expect(errors).toEqual([]);
  expect(server.evidence().external.mail).toHaveLength(0);
  await page.evaluate(() => {
    window.adminDecisionEvents = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => window.adminDecisionEvents.push({ type, target: event.target.id, disabled: event.target.disabled }), true);
  });
  await page.locator('#approveUserBtn').click();
  try {
    await expect(page.locator('#pendingUserModal')).toHaveAttribute('data-admin-account-id', second.id);
  } finally {
    await info.attach('application-decision-evidence', { body: JSON.stringify({ requests: server.evidence().requests, accounts: await require('../../../models/User').find({ _id: { $in: [first.id, second.id] } }).select('status').lean(), ui: await page.locator('#adminFlow').evaluate(node => ({ events: window.adminDecisionEvents, busy: node.getAttribute('aria-busy'), status: document.getElementById('adminFlowStatus').textContent, button: document.getElementById('approveUserBtn').outerHTML, modal: document.getElementById('pendingUserModal').className })) }, null, 2), contentType: 'application/json' });
  }
  expect((await require('../../../models/User').findById(first.id)).status).toBe('approved');
  expect((await require('../../../models/User').findById(second.id)).status).toBe('pending');
  await expect(page.locator('.admin-queue-item')).toHaveCount(1);
  await page.goto(server.origin + '/admin-directors.html');
  await expect(page.locator('#recordsBody')).toContainText('No records.');
  await expect(page.locator('#directorAdminStatus')).toHaveText('');
  await page.screenshot({ path: info.outputPath('live-directors-desktop.png'), fullPage: true, animations: 'disabled' });
});

test('mobile navigation, record cards and search work without horizontal overflow', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  await server.createUser('attorney');
  await question();
  const page = await open(browser, actor, { width: 390, height: 844 });
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('.admin-queue-item')).toBeVisible();
  for (const [section, name] of [['overview','today'],['user-management','people'],['matters','matters'],['support-ops','inbox'],['finance','finance'],['marketing-drafts','growth'],['ai-control-room','system']]) {
    await page.locator('.sidebar-toggle').click();
    await page.locator(`#sidebarNav nav > [data-section="${section}"]`).click();
    await expect(page.locator('#adminNavigationDialog')).not.toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: name[0].toUpperCase() + name.slice(1), exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), name).toBe(false);
    if (name === 'people') {
      await page.getByRole('button', { name: 'All users', exact: true }).click();
      await expect(page.locator('#approvedUsersBody .admin-record-row').first()).toBeVisible();
      await expect(page.locator('#approvedUsersBody .admin-record-row').first()).toHaveCSS('display', 'grid');
    }
    await page.screenshot({ path: info.outputPath(`live-${name}-mobile.png`), fullPage: true, animations: 'disabled' });
  }
  await page.locator('#adminSearchOpen').click();
  await expect(page.locator('#adminSearchDialog')).toBeVisible();
  await expect(page.locator('#adminGlobalSearch')).toBeFocused();
  await page.locator('#adminGlobalSearch').fill('River');
  await expect(page.locator('#adminGlobalResults')).toContainText('River');
  await page.keyboard.press('Escape');
  await expect(page.locator('#adminSearchDialog')).not.toBeVisible();
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('a saved follow-up survives a fresh browser session and can be brought back', async ({ browser }, info) => {
  const actor = await server.createUser('admin'); const row = await question();
  const page = await open(browser, actor);
  await expect(page.locator('#adminFlowContext')).toContainText(row.subject);
  await page.getByRole('button', { name: 'Choose follow-up', exact: true }).click();
  await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(page.locator('#adminFlowTitle')).toHaveText('You’re up to date here.');
  await expect(page.locator('#adminFlowStatus')).toContainText('Follow-up saved.');
  const second = await open(browser, actor);
  await expect(second.locator('#adminFlowContext')).toContainText('1 item is set for later');
  await second.getByRole('button', { name: 'Waiting', exact: true }).click();
  await second.locator('#adminFlowSaved summary').click();
  await expect(second.locator('#adminFlowSaved')).toContainText(row.subject);
  await second.screenshot({ path: info.outputPath('saved-follow-up.png'), fullPage: true, animations: 'disabled' });
  await second.locator('[data-resume-follow-up]').click();
  await expect(second.locator('#adminFlowContext')).toContainText(row.subject);
  await expect(second.locator('#adminFlowSaved')).toBeHidden();
  expect((await require('../../../models/SupportTicket').findById(row._id)).status).toBe('open');
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('new information restores deferred work, and the follow-up form fits a narrow screen', async ({ browser }, info) => {
  const actor = await server.createUser('admin'); const row = await question();
  const page = await open(browser, actor, { width: 320, height: 680 });
  await page.getByRole('button', { name: 'Choose follow-up', exact: true }).click();
  const form = page.locator('#adminFlowFollowUpForm');
  await expect(form).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('#adminFlow').analyze();
  expect(accessibility.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: info.outputPath('follow-up-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Save follow-up', exact: true }).click();
  await expect(page.locator('#adminFlowTitle')).toHaveText('You’re up to date here.');
  await require('../../../models/SupportTicket').updateOne({ _id: row._id }, { $set: { latestUserMessage: 'There is a new problem.', updatedAt: new Date(row.updatedAt.getTime() + 1000) } }, { timestamps: false });
  await page.getByRole('button', { name: 'Refresh queue', exact: true }).click();
  await expect(page.locator('#adminFlowContext')).toContainText(row.subject);
  await expect(page.locator('#adminFlowSaved')).toBeHidden();
});

test('a payment exception leads the queue and a failed refresh never reports everything handled', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const applicant = await server.createUser('attorney');
  await require('../../../models/User').updateOne({ _id: applicant.id }, { $set: { status: 'pending', createdAt: new Date('2020-01-01') } });
  const matter = await require('../../../models/Case').create({ title: 'Payment check for River', details: 'Synthetic browser matter', attorney: applicant.id, status: 'open', totalAmount: 10000 });
  await require('../../../models/PaymentOperation').create({ operationKey: 'browser-attention', fingerprint: 'synthetic', kind: 'funding', caseId: matter._id, status: 'failed' });
  const page = await open(browser, actor);
  await expect(page.locator('#adminFlowTitle')).toHaveText('Check a payment');
  await expect(page.locator('#adminSignupBadge')).toBeHidden();
  await expect(page.locator('#adminFlowReason')).toContainText('payment records need checking');
  await page.screenshot({ path: info.outputPath('payment-priority.png'), fullPage: true, animations: 'disabled' });
  await page.route('**/api/admin/workspace/flow?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Your queue is temporarily unavailable. Please try again.' }) }));
  await page.getByRole('button', { name: 'Refresh queue', exact: true }).click();
  await expect(page.locator('#adminFlowStatus')).toContainText('temporarily unavailable');
  await expect(page.locator('#adminFlowTitle')).not.toHaveText('You’re up to date here.');
});

test('Today reaches prepared decisions and contextual tools while keeping the seven destinations', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  await require('../../../models/ApprovalTask').create({ taskType: 'marketing_review', targetType: 'marketing_draft_packet', targetId: String(new (require('mongoose').Types.ObjectId)()), title: 'Weekly marketing review', summary: 'Check this prepared draft before use.' });
  const page = await open(browser, actor);
  await expect(page.locator('#adminFlowTitle')).toHaveText('Review prepared content');
  await expect(page.locator('#adminFlowContext')).toContainText('Weekly marketing review');
  await expect(page.locator('#sidebarNav nav > button')).toHaveText(['Today', 'People', 'Matters', 'Inbox', 'Finance', 'Growth', 'System']);
  await page.locator('#adminFlowOpenReview').click();
  await expect(page).toHaveURL(/#approvals-workspace$/);
  await page.goto(server.origin + '/admin-dashboard.html#posts');
  await expect(page.locator('#section-posts')).toBeVisible();
  await expect(page.locator('#sidebarNav [data-section="matters"]')).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Back to Matters', exact: true }).click();
  await page.getByRole('button', { name: 'Posting moderation', exact: true }).click();
  await expect(page.locator('#section-posts')).toBeVisible();
  await page.goto(server.origin + '/admin-dashboard.html#ai-control-room');
  await expect(page.locator('#adminAutomationPolicies')).toContainText('Marketing drafts');
  await expect(page.locator('#adminAutomationPolicies')).toContainText('Publishing is a separate step');
  await expect(page.locator('.admin-automation-technical')).not.toHaveAttribute('open', '');
  await page.screenshot({ path: info.outputPath('automation-controls.png'), fullPage: true, animations: 'disabled' });
  expect((await new AxeBuilder({ page }).include('.admin-automation-controls').analyze()).violations).toEqual([]);
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('waiting and activity failures stay explicit on a narrow Today screen', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  await question();
  const page = await open(browser, actor, { width: 320, height: 680 });
  await expect(page.locator('#adminTodayEvidence')).toContainText('Updated');
  await page.getByRole('button', { name: 'Waiting', exact: true }).click();
  await expect(page.locator('#adminTodayWaiting')).toContainText('No inquiries are waiting');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.locator('#adminTodayHandled')).toContainText('No automation actions were recorded');
  await page.screenshot({ path: info.outputPath('today-details-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  expect((await new AxeBuilder({ page }).include('.admin-today-details').analyze()).violations).toEqual([]);
  await page.route('**/api/admin/workspace/activity', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Background work unavailable.' }) }));
  await page.getByRole('button', { name: 'Refresh queue', exact: true }).click();
  await expect(page.locator('#adminTodayEvidence')).toContainText('could not be checked');
  await expect(page.locator('#adminTodayHandled')).toHaveText('Recent activity is unavailable.');
});

test('an application request is prepared from missing details and saved only when chosen', async ({ browser }, info) => {
  const actor = await server.createUser('admin'); const applicant = await server.createUser('attorney');
  await require('../../../models/User').updateOne({ _id: applicant.id }, { $set: { status: 'pending', state: '', barNumber: '', termsAccepted: false } });
  const page = await open(browser, actor);
  await expect(page.locator('#adminFlowTitle')).toHaveText('Review application');
  await page.getByText('Need more information?', { exact: true }).click();
  await expect(page.locator('#adminInformationText')).toHaveValue('');
  await page.getByRole('button', { name: 'Use prepared request', exact: true }).click();
  await expect(page.locator('#adminInformationText')).toHaveValue(/Add your bar number/);
  await expect(page.locator('[data-draft-state]').first()).toContainText('Draft saved privately');
  await page.screenshot({ path: info.outputPath('prepared-application-request.png'), fullPage: true, animations: 'disabled' });
  await page.reload();
  await expect(page.locator('#adminInformationText')).toHaveValue(/Add your bar number/);
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('opening Automation only reads status and pausing saves through the existing policy handler', async ({ browser }) => {
  const actor = await server.createUser('admin');
  const Preference = require('../../../models/AutonomyPreference');
  await Preference.create({ agentRole: 'CMO', actionType: 'marketing_publish', mode: 'auto' });
  const page = await open(browser, actor);
  const reads = [];
  page.on('request', request => { if (/\/api\/admin\/(?:ai\/control-room\/(?:founder|summary)|ai-control-room)/.test(request.url())) reads.push(request.url()); });
  await page.locator('#sidebarNav [data-section="ai-control-room"]').click();
  await expect(page.getByRole('button', { name: 'Pause marketing drafts' })).toBeVisible();
  expect(reads).toEqual([]);
  await page.getByRole('button', { name: 'Pause marketing drafts' }).click();
  await expect(page.locator('#adminAutomationStatus')).toContainText('Automatic approval is paused');
  expect((await Preference.findOne({ agentRole: 'CMO' })).mode).toBe('manual');
  await expect(page.getByRole('button', { name: 'Pause marketing drafts' })).toHaveCount(0);
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('default admin workspaces retain inquiry navigation and readable phone layouts', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const inquiry = await question();
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } }); contexts.push(context);
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.origin + '/admin-dashboard.html#overview');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview', exact: true })).toBeVisible();
  const sessions = await (await page.request.get(server.origin + '/api/account/sessions')).json();
  await expect(page.locator('#adminCardCount-security')).toHaveText(String(sessions.sessions.length));
  await expect(page.locator('#adminCardCaption-security')).toHaveText('Your active sessions');
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [section, name] of [['overview','overview'],['user-management','people'],['matters','matters'],['support-ops','inbox'],['finance','finance'],['marketing-drafts','growth'],['ai-control-room','system']]) {
      if (width < 760) await page.locator('.sidebar-toggle').click();
      await page.locator(`#sidebarNav nav > [data-section="${section}"]`).click();
      await expect(page.getByRole('heading', { level: 1, name: name[0].toUpperCase() + name.slice(1), exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name).toBe(true);
      if (name === 'inbox') {
        await page.locator('#adminInboxSearch').fill('finding my matter');
        const row = page.locator(`[data-inbox-ticket="${inquiry.id}"]`);
        await expect(row).toBeVisible();
        await row.click();
        await expect(page.locator('#adminReplyText')).toBeVisible();
        await expect(page.locator('.admin-request-name')).toHaveText('synthetic@example.test');
        await expect(page.locator('#adminReplyForm > p.small').filter({ hasText: 'To synthetic@example.test' })).toBeVisible();
        await expect(page.locator('#adminReplyForm > p.small').filter({ hasText: 'To synthetic@example.test' })).toContainText('To synthetic@example.test');
        await page.locator('#adminReplyText').fill('Private draft for this inquiry.');
        await page.screenshot({ path: info.outputPath(`default-inquiry-${width}.png`), fullPage: true });
        await page.locator('#adminInboxBack').click();
        await expect(row).toBeVisible();
      }
      await page.screenshot({ path: info.outputPath(`default-${name}-${width}.png`), fullPage: true });
    }
  }
  expect(errors).toEqual([]);
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('default System distinguishes configured mail from execution and pauses only the selected category', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const Preference = require('../../../models/AutonomyPreference');
  await Preference.create([{ agentRole: 'CMO', actionType: 'marketing_publish', mode: 'auto' }, { agentRole: 'CSO', actionType: 'sales_outreach', mode: 'auto' }]);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage();
  await page.route('**/api/admin/workspace/activity', async route => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ json: { ...data, mailbox: { configured: true, lastCompletedAt: null, lastWorkerAt: new Date(Date.now() + 3600000).toISOString(), error: null } } });
  });
  await page.goto(server.origin + '/admin-dashboard.html#ai-control-room');
  const connections = page.locator('#adminSystemConnections');
  await expect(connections).toContainText('Not yet checked');
  await expect(connections).toContainText('No recent check-in');
  await expect(connections).toContainText('No scheduled automation run has been recorded.');
  await expect(connections).not.toContainText('Running');
  const marketing = page.locator('#adminSystemPolicies details').filter({ hasText: 'Marketing drafts' });
  await marketing.locator('summary').click();
  await marketing.getByRole('button', { name: 'Pause approvals', exact: true }).click();
  await expect(page.locator('#adminSystemError')).toContainText('Automatic approval is paused for this category');
  await expect(marketing.locator('summary')).toContainText('Your review');
  expect((await Preference.findOne({ agentRole: 'CMO' })).mode).toBe('manual');
  expect((await Preference.findOne({ agentRole: 'CSO' })).mode).toBe('auto');
  expect(server.evidence().external.mail).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('system-paused-mobile.png'), fullPage: true });
});
