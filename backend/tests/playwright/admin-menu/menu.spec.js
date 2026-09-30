const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const start = require('../../helpers/financialLifecycleBrowserServer');
let server;
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeAdminSupport: true, includeAdminAutomation: true, includeAdminWorkspaces: true }); });
test.afterAll(async () => server?.close());
test.beforeEach(async () => server.reset());
for (const width of [1366, 820, 390]) test(`simple menu opens one category at a time at ${width}px`, async ({ browser }, info) => {
  const actor = await server.createUser('admin');
  for (let index = 0; index < 3; index++) {
    const user = await server.createUser('paralegal');
    await require('../../../models/User').updateOne({ _id: user.id }, { $set: { status: 'pending' } });
  }
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const home = server.origin + '/admin-dashboard.html#overview';
    await page.goto(home);
    const menu = page.getByRole('navigation', { name: 'Admin tasks', exact: true });
    await expect(menu.getByRole('link')).toHaveCount(5);
    await expect(page.locator('#adminFlow')).toHaveCount(0);
    await expect(page.locator('#adminSimpleMenu')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await expect(page.locator('#adminCardCount-signups')).toHaveText('3');
    if (width > 1024) await expect(page.locator('#sidebarNav')).toBeVisible();
    else {
      await page.locator('#sidebarToggle').click();
      await expect(page.locator('#sidebarNav')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect((await new AxeBuilder({ page }).include('#adminSimpleMenu').analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath('menu.png'), fullPage: true });
    await menu.getByRole('link', { name: 'View new user signups', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New user signups', exact: true })).toBeVisible();
    await expect(page.locator('#pendingUsersPanel')).toBeVisible();
    await expect(page.locator('#section-support-ops')).not.toBeVisible();
    await expect(page.getByRole('group', { name: 'User workspace' })).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const headingBox = await page.getByRole('heading', { name: 'New user signups', exact: true }).boundingBox();
    const panelBox = await page.locator('#pendingUsersPanel').boundingBox();
    expect(headingBox.y).toBeLessThan(panelBox.y);
    await page.screenshot({ path: info.outputPath('signups.png'), fullPage: true });
    await page.locator('#adminMenuBack').click();
    await expect(menu).toBeVisible();
    await menu.getByRole('link', { name: 'View human requests', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Human requests', exact: true })).toBeVisible();
    await expect(page.locator('[data-inbox-source="human"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#pendingUsersPanel')).not.toBeVisible();
    await page.locator('#adminMenuBack').click();
    await menu.getByRole('link', { name: 'View photos', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Photos', exact: true })).toBeVisible();
    await expect(page.locator('[data-user-view="photos"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#pendingUsersPanel')).not.toBeVisible();
    await page.locator('#adminMenuBack').click();
    await menu.getByRole('link', { name: 'View finances', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
    await expect(page.locator('#adminFinanceDestination')).toHaveValue('disputes');
    await expect(page.getByRole('group', {name:'Finance workspace',exact:true})).not.toBeVisible();
    await expect(page.locator('#disputeSearch')).not.toBeVisible();
    await page.locator('#adminFinanceDestination').selectOption('chargebacks');
    await expect(page.locator('#chargebackPanel')).toBeVisible();
    await page.locator('#adminFinanceDestination').selectOption('reporting');
    await expect(page.locator('#section-revenue')).toBeVisible();
    await page.locator('#adminFinanceDestination').selectOption('reconcile');
    await expect(page.locator('[data-admin-finance-panel="reconcile"]')).toBeVisible();
    await page.locator('#adminFinanceDestination').selectOption('disputes');
    await page.screenshot({path:info.outputPath('finance.png'),fullPage:true});
    await page.locator('#adminMenuBack').click();
    await expect(menu.getByRole('link', { name: 'View security', exact: true })).toHaveAttribute('href', 'profile-settings.html#security');
    await page.route('**/api/admin/pending-users?status=pending&limit=1', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.reload();
    await expect(page.locator('#adminCardCaption-signups')).toHaveText('Count unavailable');
    await expect(page.locator('#adminCardCount-signups')).toHaveText('—');
    expect(errors).toEqual([]);
    expect(server.evidence().external.mail).toHaveLength(0);
  } finally { await context.close(); }
});

for (const width of [1366, 390]) test(`requests are a list then a single conversation at ${width}px`, async ({browser}, info) => {
  const actor = await server.createUser('admin');
  const ticket = await require('../../../models/SupportTicket').create({subject:'Help with my account', message:'How can I update my profile?', requesterEmail:'visitor@example.test', contextSnapshot:{requesterName:'Taylor'}, requestKind:'human', status:'open'});
  await require('../../../models/SupportTicket').create({subject:'Test record', message:'Synthetic', requesterEmail:'test@example.test', requestKind:'human', status:'open', sourceLabel:'Control Room e2e harness'});
  const context = await browser.newContext({viewport:{width,height:900}});
  await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
  const page = await context.newPage(); const errors=[];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(server.origin + '/admin-dashboard.html?area=requests&inbox=human#support-ops');
    await expect(page.locator('[data-inbox-ticket]')).toHaveCount(1);
    await expect(page.locator('#adminInboxDetail')).not.toBeVisible();
    await expect(page.locator('#adminInboxAssignment')).not.toBeVisible();
    await page.screenshot({path:info.outputPath('request-list.png'),fullPage:true});
    await page.locator('[data-inbox-ticket]').click();
    await expect(page.locator('#adminReplyText')).toBeVisible();
    await expect(page.locator('.admin-inbox-queue')).not.toBeVisible();
    await expect(page.locator('#adminInquiryOwner')).not.toBeVisible();
    await expect(page.locator('#adminReplyTemplate')).not.toBeVisible();
    await expect(page.locator('#adminReplyStatus')).not.toBeVisible();
    await expect(page.locator('#adminResolveRequest')).toBeVisible();
    await page.locator('#adminReplyText').fill('An unsent draft.');
    await page.locator('#adminInboxBack').click();
    await expect(page.locator('.admin-inbox-queue')).toBeVisible();
    await page.locator('[data-inbox-ticket]').click();
    await expect(page.locator('#adminReplyText')).toHaveValue('An unsent draft.');
    await page.screenshot({path:info.outputPath('single-request.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    expect((await new AxeBuilder({page}).include('#adminInboxDetail').analyze()).violations).toEqual([]);
    await page.locator('#adminResolveRequest').click();
    await expect(page.locator('#adminResolveResult')).toHaveText('Marked resolved.');
    expect((await require('../../../models/SupportTicket').findById(ticket._id)).status).toBe('resolved');
    await page.locator('#adminInboxBack').click();
    await expect(page.locator('[data-inbox-ticket]')).toHaveCount(0);
    await page.screenshot({path:info.outputPath('empty-inbox.png'),fullPage:true});
    await page.evaluate(() => window.activateAdminSection('ai-control-room'));
    await page.locator('.admin-support-tools > summary').click();
    await page.locator('#adminInboxIncludeTests').check();
    await page.evaluate(() => window.activateAdminSection('support-ops'));
    await expect(page.locator('[data-inbox-ticket]')).toHaveCount(1);
    expect(errors).toEqual([]);
    expect(server.evidence().external.mail).toHaveLength(0);
  } finally {await context.close();}
});

for (const width of [1366,390]) test(`System stays concise and its tools remain reachable at ${width}px`, async ({browser},info) => {
 const actor=await server.createUser('admin');
 const context=await browser.newContext({viewport:{width,height:900}});
 await context.addCookies([actor.cookie]);
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
 const page=await context.newPage();const errors=[];
 page.on('pageerror',error=>{errors.push(error.message); console.error(error.stack);});
 try {
  await page.goto(server.origin+'/admin-dashboard.html#ai-control-room');
  await expect(page.locator('#adminSystemPolicies')).toContainText('Marketing drafts');
  await expect(page.locator('#adminSystemConnections')).toContainText('Support email');
  await expect(page.locator('#aiRoomCardGrid')).not.toBeVisible();
  await expect(page.locator('.admin-system-policy p').first()).not.toBeVisible();
  await page.screenshot({path:info.outputPath('system.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  expect((await new AxeBuilder({page}).include('.admin-system-overview').analyze()).violations).toEqual([]);
  for(const view of ['engineering','activity-logs','settings','ai-control-room']) {
   await page.locator('#adminSystemView').selectOption(view);
   await expect(page.locator('#section-'+view)).toBeVisible();
   await expect(page.locator('#adminSystemView')).toBeVisible();
  }
  await page.locator('.admin-support-tools>summary').click();
  await expect(page.locator('#adminInboxIncludeTests')).toBeVisible();
  expect(errors).toEqual([]);
  expect(server.evidence().external.mail).toHaveLength(0);
 } finally {await context.close();}
});

for (const width of [1366,390]) test(`admin audit: named payment checks and workspace paths at ${width}px`, async ({browser}, info) => {
  const actor=await server.createUser('admin'), attorney=await server.createUser('attorney');
  const matter=await require('../../../models/Case').create({attorney:attorney.id,attorneyId:attorney.id,title:'Contract review',details:'Private synthetic audit matter.'});
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.addCookies([actor.cookie]);
  await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
  const page=await context.newPage(), errors=[], mutations=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().includes('/api/payments/reconcile/') && request.method()==='POST')mutations.push(request.url());});
  try {
    await page.goto(server.origin+'/admin-dashboard.html#finance');
    await page.locator('#adminFinanceDestination').selectOption('reconcile');
    await expect(page.getByRole('heading',{name:'Check payment',exact:true})).toBeVisible();
    await expect(page.locator('#reconcileCaseId')).not.toBeVisible();
    await expect(page.locator('#reconcileCaseBtn')).toBeDisabled();
    await page.locator('#adminPaymentSearch').fill('Contract');
    await page.getByRole('button',{name:'Contract review'}).click();
    await expect(page.locator('#reconcileCaseId')).toHaveValue(String(matter._id));
    await expect(page.locator('#reconcileCaseBtn')).toBeEnabled();
    await expect(page.locator('#adminPaymentReference')).not.toBeVisible();
    await page.screenshot({path:info.outputPath('payment-check.png'),fullPage:true});
    await page.locator('#adminPaymentSearch').fill('Nonexistent');
    await expect(page.locator('#reconcileCaseBtn')).toBeDisabled();
    await expect(page.locator('#reconcileCaseId')).toHaveValue('');
    for(const destination of ['reporting','payouts','pending','income','commissions']) {
      await page.locator('#adminFinanceDestination').selectOption(destination);
      await expect(page.locator('#section-revenue')).toBeVisible();
      await expect(page.locator('#adminFinanceDestination')).toHaveValue(destination);
      await expect(page.locator('[aria-label="Financial record source"]')).not.toBeVisible();
    }
    for(const section of ['matters','user-management','marketing-drafts','sales-workspace','ai-control-room','engineering','activity-logs','settings']) {
      await page.evaluate(section=>window.activateAdminSection(section),section);
      await expect(page.locator('#section-'+section)).toBeVisible();
      await page.screenshot({path:info.outputPath(section+'.png'),fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    }
    await page.evaluate(id=>window.openAdminFinance(id),String(matter._id));
    await expect(page.locator('#adminPaymentSearch')).toHaveValue('Contract review');
    await expect(page.locator('#adminFinanceDestination')).toHaveValue('reconcile');
    expect((await new AxeBuilder({page}).include('#section-escrow').analyze()).violations).toEqual([]);
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
    expect(server.evidence().external.mail).toHaveLength(0);
  } finally {await context.close();}
});

test('admin security excludes client profile and deactivation controls', async ({browser},info) => {
  const actor=await server.createUser('admin');
  const context=await browser.newContext({viewport:{width:1366,height:900}});
  await context.addCookies([actor.cookie]);
  await context.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
  const page=await context.newPage();
  try {
    await page.goto(server.origin+'/profile-settings.html#security');
    await expect(page.locator('body')).toHaveClass(/admin-security/);
    await expect(page.locator('[data-deactivate-account]')).toHaveCount(0);
    await expect(page.locator('#navProfile')).not.toBeVisible();
    await expect(page.locator('#securitySection')).toBeVisible();
    await expect(page.locator('#adminSecurityBack')).toBeVisible();
    await expect(page.locator('#adminSecurityBack')).toHaveAttribute('href','admin-dashboard.html#overview');
    await page.screenshot({path:info.outputPath('admin-security.png'),fullPage:true});
  } finally {await context.close();}
});
