const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require('../../helpers/financialLifecycleBrowserServer');
let server, contexts = [];
test.beforeAll(async () => { test.setTimeout(360000); server = await start({ includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true, includeDirectors: true }); });
test.beforeEach(async () => server.reset());
test.afterEach(async () => { for (const context of contexts.splice(0)) await context.close(); });
test.afterAll(async () => server?.close());

async function open(browser, actor, viewport = { width: 1366, height: 900 }, entry = '/admin-dashboard.html?view=queue#overview') {
  const context = await browser.newContext({ viewport }); contexts.push(context);
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage();
  if (entry === null) return page;
  await page.goto(server.origin + entry);
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

test('Assistant reports background work and saves a requested pause', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const Preference = require('../../../models/AutonomyPreference');
  await Preference.create([
    { agentRole: 'CMO', actionType: 'marketing_publish', mode: 'auto' },
    { agentRole: 'CSO', actionType: 'sales_outreach', mode: 'auto' },
  ]);
  const page = await open(browser, actor);
  await page.goto(server.origin + '/admin-dashboard.html#ai-control-room');
  await page.locator('#adminSystemAutomationSettings>summary').click();
  const marketingPolicy = page.locator('#adminSystemPolicies details').filter({ hasText: 'Marketing drafts' });
  await expect(marketingPolicy.locator('summary')).toContainText('Automatic approval');
  await page.locator('.admin-assistant-button').click();
  const drawer = page.locator('#supportDrawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('[data-support-title]')).toHaveText('Admin Assistant');
  await expect(drawer.locator('.support-quick-prompt')).toHaveCount(3);
  await expect(drawer).not.toContainText('account questions, payouts');
  await drawer.getByRole('button', { name: 'What is AI doing?', exact: true }).click();
  await expect(drawer).toContainText('No scheduled automation run has been recorded');
  expect((await Preference.findOne({ agentRole: 'CMO' })).mode).toBe('auto');
  await drawer.locator('[data-support-textarea]').fill('Pause marketing approvals');
  await drawer.locator('[data-support-submit]').click();
  await expect(drawer).toContainText('Automatic approval is paused for marketing drafts');
  await expect(marketingPolicy.locator('summary')).toContainText('Your review');
  expect((await Preference.findOne({ agentRole: 'CMO' })).mode).toBe('manual');
  expect((await Preference.findOne({ agentRole: 'CSO' })).mode).toBe('auto');
  expect(await require('../../../models/AuditLog').countDocuments({ action: 'admin.assistant.approvals_paused' })).toBe(1);
  expect(server.evidence().external.mail).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('assistant-pause-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(drawer.locator('[data-support-textarea]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const iconSizes = await drawer.locator('.support-message-utility svg').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  expect(iconSizes.length).toBeGreaterThan(0);
  expect(iconSizes.every(width => width <= 18)).toBe(true);
  await page.screenshot({ path: info.outputPath('assistant-pause-phone.png'), fullPage: true, animations: 'disabled' });
});

test('dispute review shows one decision at a time and no inactive payment form', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const Case = require('../../../models/Case');
  const common = { details: 'Synthetic review', attorney: actor.id, status: 'disputed', totalAmount: 10000,
    disputes: [{ disputeId: 'synthetic-review', message: 'Please review the completed work.', raisedBy: actor.id, status: 'open' }] };
  await Case.create({ ...common, title: 'Payment recorded dispute', paymentReleased: true });
  const unpaid = await Case.create({ ...common, title: 'Unpaid dispute', disputes: [{ ...common.disputes[0], disputeId: 'synthetic-unpaid' }] });
  const page = await open(browser, actor);
  await page.goto(server.origin + '/admin-dashboard.html#finance');
  const summary = page.locator('.admin-dispute-summary').filter({ hasText: 'Payment recorded dispute' });
  await summary.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.locator('.admin-dispute-detail:not([hidden])');
  await expect(review).toContainText('Payment already recorded. This dispute still needs review.');
  await expect(page.locator('.admin-dispute-summary:visible')).toHaveCount(0);
  await expect(review.locator('[data-dispute-action]')).toHaveCount(0);
  await expect(review.locator('[data-dispute-amount]')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Check payment', exact: true })).toBeVisible();
  await expect(review.getByText('Download evidence', { exact: true })).toBeHidden();
  await page.screenshot({ path: info.outputPath('dispute-recorded-desktop.png'), fullPage: true });
  await review.locator('[data-dispute-back]').click();
  await expect(summary).toBeVisible();
  await page.locator('.admin-dispute-summary').filter({ hasText: 'Unpaid dispute' }).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(review.locator('[data-dispute-action]:visible')).toHaveCount(0);
  await review.getByLabel('Dispute decision').selectOption('release-partial');
  await expect(review.getByLabel('Payout to paralegal in dollars')).toBeVisible();
  await expect(review.locator('[data-dispute-action]:visible')).toHaveCount(1);
  await review.getByLabel('Dispute decision').selectOption('refund');
  await expect(review.getByLabel('Payout to paralegal in dollars')).toBeHidden();
  await expect(review.locator('[data-dispute-action]:visible')).toHaveCount(1);
  for (const width of [1366, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`dispute-review-${width}.png`), fullPage: true });
  }
  await page.goto(server.origin + `/admin-dashboard.html?review=synthetic-unpaid&reviewMatter=${unpaid._id}#finance`);
  await expect(review).toContainText('Unpaid dispute');
  await expect(page.locator('.admin-dispute-summary:visible')).toHaveCount(0);
  await review.locator('[data-dispute-back]').click();
  await expect(page.locator('.admin-dispute-summary:visible')).toHaveCount(2);
  expect(new URL(page.url()).searchParams.has('review')).toBe(false);
  expect(server.evidence().requests.filter(row => row.method === 'POST' && /settle|refund|release/.test(row.path))).toHaveLength(0);
});

test('People stays quiet when empty and preserves filtered application review', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const page = await open(browser, actor);
  await page.goto(server.origin + '/admin-dashboard.html#user-management');
  const pending = page.locator('#pendingUsersPanel');
  await expect(pending).toHaveClass(/admin-people-unfiltered-empty/);
  await expect(page.locator('#pendingSearch')).toBeHidden();
  await expect(pending.locator('thead')).toBeHidden();
  await expect(page.locator('#pendingUsersCountLabel')).toBeHidden();
  await expect(page.locator('#adminPeopleReports')).toBeHidden();
  await expect(page.locator('.admin-topbar #adminIdentity')).toHaveCount(0);
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: info.outputPath(`people-empty-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.getByLabel('People view', { exact:true }).selectOption('reports');
  await expect(page.locator('#adminPeopleReports')).toBeVisible();
  await expect(pending).toBeHidden();
  await page.getByLabel('People view', { exact:true }).selectOption('applications');
  const applicant = await server.createUser('attorney');
  await require('../../../models/User').updateOne({ _id: applicant.id }, { $set: { status: 'pending' } });
  await pending.locator('.admin-people-empty-refresh').click();
  await expect(page.locator('#pendingSearch')).toBeVisible();
  await expect(page.locator('#pendingUsersBody')).toContainText('River');
  await page.locator('#pendingSearch').fill('No matching applicant');
  await expect(pending).toHaveClass(/admin-people-empty/);
  await expect(page.locator('#pendingSearch')).toBeVisible();
  await page.locator('#pendingSearch').fill('');
  expect(await page.locator('#pendingSearch').isVisible()).toBe(true);
  await expect(page.locator('#pendingUsersBody')).toContainText('River');
  await page.screenshot({ path: info.outputPath('people-applications-phone.png'), fullPage:true });
  await page.goto(server.origin + '/admin-dashboard.html?area=signups#user-management');
  await expect(page.locator('#section-user-management h1')).toHaveText('New user signups');
  await page.getByLabel('People view', { exact:true }).selectOption('directory');
  await expect(page.locator('#section-user-management h1')).toHaveText('People');
  expect(new URL(page.url()).searchParams.has('area')).toBe(false);
  await page.goto(server.origin + '/admin-dashboard.html#ai-control-room');
  await expect(page.locator('.admin-system-navigation #adminIdentity')).toBeVisible();
});

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
  expect(new URL(page.url()).searchParams.has('account')).toBe(false);
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
      await page.getByLabel('People view', { exact: true }).selectOption('directory');
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
  await page.goto(server.origin + '/admin-dashboard.html?view=queue#posts');
  await expect(page.locator('#section-posts')).toBeVisible();
  await expect(page.locator('#sidebarNav [data-section="matters"]')).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Back to Matters', exact: true }).click();
  await page.getByRole('button', { name: 'Posting moderation', exact: true }).click();
  await expect(page.locator('#section-posts')).toBeVisible();
  await page.goto(server.origin + '/admin-dashboard.html?view=queue#ai-control-room');
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
  for (const width of [1366, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.locator('.admin-topbar').evaluate(bar => [...bar.children].filter(node => node.getClientRects().length).every(node => node.getBoundingClientRect().bottom <= bar.getBoundingClientRect().bottom + 1))).toBe(true);
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
  await expect(connections).toContainText('Needs checking');
  await expect(connections).not.toContainText('Current and completing work');
  await expect(connections).toContainText('No scheduled automation run has been recorded.');
  await expect(connections).not.toContainText('Running');
  await page.locator('#adminSystemAutomationSettings>summary').click();
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

test('compact workspaces keep inbox and finance tools available without competing panels', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  await question();
  const page = await open(browser, actor);
  await page.goto(server.origin + '/admin-dashboard.html#support-ops');
  await expect(page.locator('[data-inbox-ticket]')).toHaveCount(1);
  await expect(page.locator('.admin-request-toolbar #adminInboxRefresh')).toBeVisible();
  await page.locator('[data-inbox-ticket]').click();
  await expect(page.locator('#adminInboxSearch')).toBeHidden();
  await expect(page.locator('#adminReplyText')).toBeVisible();
  await page.locator('#adminInboxBack').click();
  await expect(page.locator('[data-inbox-ticket]')).toBeVisible();
  await page.locator('#adminInboxSearch').fill('No such message');
  await expect(page.locator('#adminInboxList')).toContainText('No messages in this view');
  await expect(page.locator('.admin-mail-columns')).toBeHidden();
  await page.locator('#adminInboxSearch').fill('');
  await expect(page.locator('[data-inbox-ticket]')).toHaveCount(1);
  await page.locator('#adminInboxRefresh').click();
  await expect(page.locator('[data-inbox-ticket]')).toHaveCount(1);
  for (const width of [1366, 390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({path:info.outputPath(`inbox-compact-${width}.png`),fullPage:true});
  }
  await page.goto(server.origin + '/admin-dashboard.html#finance');
  await expect(page.locator('#disputesBody')).toContainText('No');
  await expect(page.locator('.admin-dispute-table thead')).toBeHidden();
  await expect(page.locator('#adminDisputePager')).toBeHidden();
  await page.getByLabel('Finance view', {exact:true}).selectOption('reporting');
  await expect(page.locator('#adminFinanceRecordStatus')).not.toContainText('Loading');
  await expect(page.locator('#adminFinanceFrom')).toBeHidden();
  await page.locator('#adminFinanceFilters>summary').click();
  await page.locator('#adminFinanceFrom').fill('2026-01-01');
  await expect(page.locator('#adminFinanceFilters>summary')).toContainText('Dates selected');
  await page.locator('#adminFinanceApply').click();
  await expect(page.locator('#adminFinanceExport')).toBeEnabled();
  await page.locator('#adminFinanceFilters>summary').click();
  for (const width of [1366,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({path:info.outputPath(`finance-compact-${width}.png`),fullPage:true});
  }
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('contextual reply help stays private until chosen and Growth has one refresh', async ({browser},info)=>{
  const actor=await server.createUser('admin');
  const ticket=await question();
  const page=await open(browser,actor);
  await page.route('**/api/admin/workspace/inquiries/*/preparation',route=>route.fulfill({json:{sourceRevision:ticket.updatedAt.toISOString(),reason:'Prepared from an approved answer.',text:'Open Matters to find your saved matter.',sources:[{title:'Finding your matter'}]}}));
  await page.goto(server.origin+'/admin-dashboard.html#support-ops');
  await page.locator('[data-inbox-ticket]').click();
  await expect(page.locator('#adminPreparedReply [data-prepared-text]')).toContainText('Open Matters');
  await expect(page.locator('#adminReplyText')).toHaveValue('');
  await expect(page.locator('#adminPreparedReply')).toContainText('Finding your matter');
  await page.locator('#adminUsePreparedReply').click();
  await expect(page.locator('#adminReplyText')).toHaveValue('Open Matters to find your saved matter.');
  for(const width of [1366,390]){
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath(`contextual-reply-${width}.png`),fullPage:true});
  }
  expect(server.evidence().external.mail).toHaveLength(0);
  await page.goto(server.origin+'/admin-dashboard.html#marketing-drafts');
  for(const value of ['brief','posting','research','contact','contacts']){
    await page.getByLabel('Growth view',{exact:true}).selectOption(value);
    await expect(page.locator('.section.visible button:visible').filter({hasText:/^Refresh/})).toHaveCount(1);
  }
  await page.goto(server.origin+'/admin-dashboard.html#posts');
  await expect(page.locator('#postsList')).toBeVisible();
  await expect(page.locator('#postStateChart')).toBeHidden();
});

test('compact System surfaces failed and unavailable checks while settings stay tucked away', async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  const page = await open(browser, actor);
  let failing = false;
  await page.route('**/api/admin/workspace/activity', route => route.fulfill({
    status: failing ? 503 : 200, contentType:'application/json', body:JSON.stringify(failing ? {error:'System checks unavailable. Try again.'} : {
      mailbox:{configured:true,lastWorkerAt:new Date().toISOString(),lastCompletedAt:new Date().toISOString(),workerHealth:{ok:true,message:'Synthetic current successful work evidence.'}},
      automation:{status:'failed',message:'Scheduled reminders need attention.'},
      recovery:{blocked:1}, policies:[], unavailable:[]
    })
  }));
  await page.goto(server.origin + '/admin-dashboard.html#ai-control-room');
  await expect(page.locator('#adminSystemAttention')).toContainText('Scheduled reminders need attention.');
  await expect(page.locator('#adminSystemAttention')).toContainText('1 recorded decisions need technical follow-up');
  await expect(page.locator('#adminSystemConnections')).toBeHidden();
  await expect(page.locator('#adminSystemPolicies')).toBeHidden();
  await page.locator('#adminSystemConnectionDetails>summary').click();
  await expect(page.locator('#adminSystemConnections')).toContainText('Current and completing work');
  await page.locator('#adminSystemConnectionDetails>summary').click();
  for (const width of [1366,390]) {
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({path:info.outputPath(`system-compact-${width}.png`),fullPage:true});
  }
  failing = true;
  await page.locator('#adminSystemRefresh').click();
  await expect(page.locator('#adminSystemError')).toContainText('System checks unavailable');
  await expect(page.locator('#adminSystemAttention')).toBeEmpty();
  await expect(page.locator('#adminSystemError')).not.toContainText('No issues');
});

test('review inventory covers every default admin destination and subview', async ({ browser }, info) => {
  test.setTimeout(240000);
  const actor=await server.createUser('admin');
  const page=await open(browser,actor,{width:1366,height:900},null), errors=[], inventory=[], pendingReads=new Set(), browserEvents=[];
  await page.addInitScript(() => {
    const documentId=crypto.randomUUID();
    const report=(type,detail={})=>console.debug('LPC_ADMIN_NAVIGATION '+JSON.stringify({documentId,type,page:location.href,at:Date.now(),...detail}));
    for(const type of ['beforeunload','pagehide','pageshow'])addEventListener(type,event=>report(type,{persisted:event.persisted}));
    addEventListener('error',event=>report('windowerror',{message:event.message,stack:event.error?.stack}));
    addEventListener('unhandledrejection',event=>report('unhandledrejection',{message:String(event.reason),stack:event.reason?.stack}));
  });
  page.on('console',message=>{const prefix='LPC_ADMIN_NAVIGATION ';if(message.text().startsWith(prefix))browserEvents.push(JSON.parse(message.text().slice(prefix.length)));});
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())browserEvents.push({type:'navigation',page:frame.url(),at:Date.now()});});
  page.on('requestfailed',request=>browserEvents.push({type:'requestfailed',url:request.url(),method:request.method(),error:request.failure()?.errorText,page:page.url(),at:Date.now()}));
  page.on('pageerror',error=>errors.push({name:error.name,message:error.message,stack:error.stack,page:page.url(),at:Date.now()}));
  page.on('request',request=>{if(request.url().includes('/api/') && ['fetch','xhr'].includes(request.resourceType()))pendingReads.add(request);});
  page.on('requestfinished',request=>pendingReads.delete(request));
  page.on('requestfailed',request=>pendingReads.delete(request));
  const capture=async name=>{
    await page.locator('main').waitFor({state:'visible'});
    await expect.poll(()=>pendingReads.size,{timeout:20000}).toBe(0);
    await page.screenshot({path:info.outputPath(`${name}.png`),fullPage:true});
    const scrollArea=page.locator('main');
    if(await scrollArea.evaluate(node=>node.scrollHeight>node.clientHeight+80)){
      await scrollArea.evaluate(node=>node.scrollTop=node.scrollHeight);
      await page.screenshot({path:info.outputPath(`${name}-bottom.png`),fullPage:true});
      await scrollArea.evaluate(node=>node.scrollTop=0);
    }
    const state=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,text:document.querySelector('main')?.innerText||document.body.innerText}));
    inventory.push({name,...state});
    expect(state.scrollWidth, name).toBeLessThanOrEqual(state.width+1);
  };
  for(const width of [1366,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto(server.origin+'/admin-dashboard.html#overview');
    await expect(page.locator('#adminCardCount-signups')).not.toHaveText('—');
    await capture(`overview-${width}`);
    await page.goto(server.origin+'/admin-dashboard.html#user-management');
    for(const value of ['applications','directory','photos','deactivated','reports','outreach']) {
      await page.getByLabel('People view',{exact:true}).selectOption(value);
      await capture(`people-${value}-${width}`);
    }
    await page.goto(server.origin+'/admin-dashboard.html#finance');
    for(const value of ['disputes','chargebacks','reporting','payouts','pending','income','commissions','reconcile']) {
      await page.getByLabel('Finance view',{exact:true}).selectOption(value);
      await capture(`finance-${value}-${width}`);
    }
    await page.goto(server.origin+'/admin-dashboard.html#marketing-drafts');
    for(const value of ['drafts','batches','research','posting','brief','summary','contacts','outreach','contact']) {
      await page.getByLabel('Growth view',{exact:true}).selectOption(value);
      await expect(page.locator('[data-growth-view]:visible')).toHaveCount(1);
      await capture(`growth-${value}-${width}`);
    }
    await page.goto(server.origin+'/admin-dashboard.html#ai-control-room');
    for(const value of ['ai-control-room','engineering','activity-logs','settings']) {
      await page.getByLabel('System view',{exact:true}).selectOption(value);
      await capture(`system-${value}-${width}`);
    }
    for(const section of ['matters','support-ops','approvals-workspace','knowledge-studio','posts']) {
      await page.goto(server.origin+`/admin-dashboard.html#${section}`);
      await capture(`${section}-${width}`);
      if(section==='knowledge-studio')for(const view of ['knowledgeItemList','knowledgeApprovalList','knowledgeSourceList']){await page.getByLabel('Knowledge view',{exact:true}).selectOption(view);await capture(`${section}-${view}-${width}`);}
    }
    await page.goto(server.origin+'/profile-settings.html#security');
    await expect(page.locator('body')).toHaveClass(/admin-security/);
    await expect(page.locator('[data-deactivate-account]:visible')).toHaveCount(0);
    for(const view of ['devices','password','verification','passkeys']){
      await page.getByLabel('Security view',{exact:true}).selectOption(view);
      if(view==='password')await expect(page.locator('#currentPassword')).toBeVisible();else await expect(page.locator('#currentPassword')).toBeHidden();
      await capture(`security-${view}-${width}`);
    }
    await page.goto(server.origin+'/admin-directors.html');
    for(const view of ['replyQueueBody','failedFollowUpsBody','commissionPayablesBody','duplicateBody','recordsBody','directorList']){await page.getByLabel('Director view',{exact:true}).selectOption(view);await capture(`directors-${view}-${width}`);}
  }
  await require('node:fs/promises').writeFile(info.outputPath('inventory.json'),JSON.stringify({inventory,errors,browserEvents,requests:server.evidence().requests},null,2));
  expect(errors).toEqual([]);
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('Growth keeps one selected record visible and distinguishes failures from empty lists', async({browser},info)=>{
  const actor=await server.createUser('admin');
  await require('../../../models/SalesAccount').create({name:'Review contact',primaryEmail:'review@example.test',audienceType:'attorney'});
  const page=await open(browser,actor);
  await page.goto(server.origin+'/admin-dashboard.html#sales-workspace');
  await expect(page.getByLabel('Growth view',{exact:true})).toHaveValue('contacts');
  await expect(page.locator('[data-sales-account-id]')).toHaveCount(1);
  await expect(page.locator('#salesAccountDetail')).toBeHidden();
  await page.locator('[data-sales-account-id]').click();
  await expect(page.locator('#salesAccountDetail')).toBeVisible();
  await expect(page.locator('#salesAccountList')).toBeHidden();
  await page.locator('[data-growth-view="contacts"] .admin-growth-back').click();
  await expect(page.locator('#salesAccountList')).toBeVisible();
  await page.route('**/api/admin/sales/accounts',route=>route.fulfill({status:503,json:{error:'Contacts could not be loaded.'}}));
  await page.locator('#adminGrowthRefresh').click();
  await expect(page.locator('#salesAccountList [role="alert"]')).toContainText('Contacts could not be loaded.');
  await page.unroute('**/api/admin/sales/accounts');
  await page.locator('#adminGrowthRefresh').click();
  await expect(page.locator('[data-sales-account-id]')).toHaveCount(1);
  await page.getByLabel('Growth view',{exact:true}).selectOption('drafts');
  await page.route('**/api/admin/marketing/draft-packets',route=>route.fulfill({status:503,json:{error:'Drafts could not be loaded.'}}));
  await page.locator('#adminGrowthRefresh').click();
  await expect(page.locator('#marketingPacketList [role="alert"]')).toContainText('Drafts could not be loaded.');
  await page.screenshot({path:info.outputPath('growth-failure.png'),fullPage:true});
  expect(server.evidence().external.mail).toHaveLength(0);
});

test('Knowledge read failures remain visible and recover without syncing sources',async({browser})=>{
 const actor=await server.createUser('admin'), page=await open(browser,actor);
 await page.route('**/api/admin/knowledge/overview',route=>route.fulfill({status:503,json:{error:'Knowledge is unavailable.'}}));
 await page.goto(server.origin+'/admin-dashboard.html#knowledge-studio');
 await expect(page.locator('#knowledgeItemList [role="alert"]')).toContainText('Knowledge is unavailable.');
 await page.unroute('**/api/admin/knowledge/overview');
 await page.locator('#adminKnowledgeRefresh').click();
 await expect(page.locator('#knowledgeItemList [role="alert"]')).toHaveCount(0);
 expect(server.evidence().requests.filter(r=>r.method==='POST' && r.path.includes('/knowledge/sync'))).toHaveLength(0);
});
