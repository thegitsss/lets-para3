const { test, expect } = require('playwright/test');
const start = require('../../helpers/financialLifecycleBrowserServer');
const AxeBuilder = require('@axe-core/playwright').default;
let server, contexts = [];
test.beforeAll(async () => { test.setTimeout(180000); server = await start({ includeAdminSupport: true, includeDesignPreviews: true }); });
test.beforeEach(async () => server.reset());
test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
  expect(server.evidence().assets.filter(asset => asset.status >= 400)).toEqual([]);
});
test.afterAll(async () => server?.close());
async function pageFor(browser, role = 'admin') {
  const actor = await server.createUser(role);
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(30000);
  contexts.push(context); await context.addCookies([actor.cookie]);
  await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { page, actor, errors };
}
async function adminPage(browser) {
  const value = await pageFor(browser);
  await value.page.goto(server.origin + '/admin-dashboard.html#user-management');
  await value.page.waitForFunction(() => typeof window.Chart?.getChart === 'function' && typeof window.reviewAdminApplicant === 'function' && typeof window.renderAdminAccount === 'function' && typeof window.openSupportTicketInAdmin === 'function');
  return value;
}
test('reopened account review records exactly one internal note through the real route', async ({ browser }, info) => {
  const { page, errors } = await adminPage(browser), account = await server.createUser('paralegal');
  for (let i = 0; i < 3; i++) {
    await page.evaluate(id => window.reviewAdminApplicant(id), account.id);
    await expect(page.locator('#adminDecisionNote')).toBeVisible();
    if (i < 2) await page.locator('#closePendingModal').click();
  }
  const requests = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/accounts/${account.id}/note`)) requests.push(request.postDataJSON()); });
  await page.locator('#adminDecisionNote').fill('Synthetic internal note after repeated account review.');
  await page.getByRole('button', { name: 'Save internal note', exact: true }).click();
  await expect(page.locator('#adminAccountResult')).toHaveText('Internal note saved.');
  expect(requests).toEqual([{ text: 'Synthetic internal note after repeated account review.' }]);
  const notes = await require('../../../models/AuditLog').find({ action: 'admin.user.note_added', targetId: account.id }).lean();
  expect(notes).toHaveLength(1); expect(notes[0].meta.note).toBe(requests[0].text);
  await page.locator('[data-account-tab="history"]').click();
  await expect(page.locator('[data-account-panel="history"]')).toBeVisible();
  await page.screenshot({ path: info.outputPath('account-history.png') });
  expect(errors).toEqual([]);
});
test('reopened inquiry preserves quoted values and submits one ownership update', async ({ browser }, info) => {
  const { page, actor, errors } = await adminPage(browser);
  expect(require('mongoose').connection.name).toBe('financial_lifecycle_browser');
  const Ticket = require('../../../models/SupportTicket');
  const nextAction = 'Review "quoted" <draft> & ownership.';
  const ticket = await Ticket.create({ subject: 'Synthetic inquiry <review>', message: 'Please review the saved follow-up.', requesterRole: 'attorney', nextAction, followUpAt: new Date('2027-03-14T15:30:00Z') });
  for (let i = 0; i < 3; i++) await page.evaluate(id => window.openSupportTicketInAdmin(id), String(ticket._id));
  await page.locator('#adminTriageForm').locator('..').locator('summary').click();
  await expect(page.locator('#adminInquiryNext')).toHaveValue(nextAction);
  await expect(page.locator('#adminInquiryDue')).not.toHaveValue('');
  expect(await page.locator('#adminInboxDetail draft').count()).toBe(0);
  const requests = [];
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith(`/tickets/${ticket._id}/triage`)) requests.push(request.postDataJSON()); });
  await page.locator('#adminInquiryOwner').selectOption(actor.id);
  await page.locator('#adminInquiryNext').fill(nextAction + ' Saved once.');
  await page.getByRole('button', { name: 'Save ownership & follow-up', exact: true }).click();
  await expect(page.locator('#adminTriageResult')).toHaveText('Saved.');
  expect(requests).toHaveLength(1);
  const saved = await Ticket.findById(ticket._id).lean();
  expect(String(saved.assignedTo)).toBe(actor.id); expect(saved.nextAction).toBe(nextAction + ' Saved once.');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('#sidebarNav').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.locator('#adminTriageForm').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('inquiry-follow-up-mobile.png') });
  expect(errors).toEqual([]);
});
test('account status and retained preview expose a keyboard-reachable main landmark', async ({ browser }, info) => {
  const { page, errors } = await pageFor(browser);
  for (const [name, route] of [['account-status', '/account-closure.html'], ['preview', '/previews/lpc-contract/index.html']]) {
    await page.goto(server.origin + route);
    await expect(page.locator('main#main')).toHaveCount(1);
    if (name === 'account-status') await expect(page.getByRole('heading', { name: 'Account check unavailable', exact: true })).toBeVisible();
    await page.keyboard.press(info.project.name === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content', exact: true })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.locator('main#main')).toBeFocused();
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(name + '-main-320.png') });
  }
  expect(errors).toEqual([]);
});
test('browser callback replacement retains currentTarget, order and default cancellation', async ({ browser }) => {
  const { page, errors } = await pageFor(browser); await page.goto(server.origin + '/account-closure.html');
  const result = await page.evaluate(async () => {
    const { replaceEventHandler } = await import('/assets/scripts/utils/event-bindings.mjs');
    const button = document.createElement('button'); button.type = 'button'; document.querySelector('main').append(button);
    const calls = []; let currentTarget = false, receiver = false;
    button.addEventListener('click', () => calls.push('before'));
    replaceEventHandler(button, 'click', () => calls.push('old'));
    button.addEventListener('click', () => calls.push('after'));
    for (let i = 0; i < 5; i++) replaceEventHandler(button, 'click', function(event) { currentTarget = event.currentTarget === button; receiver = this === button; calls.push('current'); return false; });
    const cancelled = !button.dispatchEvent(new MouseEvent('click', { cancelable: true })), first = [...calls];
    calls.length = 0; replaceEventHandler(button, 'click', null); button.click(); button.remove();
    return { first, remaining: calls, cancelled, currentTarget, receiver };
  });
  expect(result).toEqual({ first: ['before', 'current', 'after'], remaining: ['before', 'after'], cancelled: true, currentTarget: true, receiver: true });
  expect(errors).toEqual([]);
});

async function financeShell(browser) {
  const value = await adminPage(browser), { page } = value;
  await page.locator('[data-section="finance"]').click();
  await page.locator('[data-finance-view="reporting"]').click();
  await expect(page.locator('#adminFinanceFrom')).toBeVisible();
  return value;
}
async function mobileShell(page, width = 390, height = 844) {
  await page.setViewportSize({ width, height });
  await expect(page.locator('#sidebarToggle')).toBeVisible();
  await expect.poll(() => page.locator('#sidebarNav').evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
}
test('admin navigation toolbar keeps controls together over scrolled content and enlarged themes', async ({ browser }, info) => {
  const { page, errors } = await financeShell(browser);
  for (const [name, width, height, dark, enlarged] of [['phone-light',390,844,false,false], ['narrow-dark-large',320,900,true,true], ['landscape-dark',740,420,true,false]]) {
    await mobileShell(page, width, height);
    await page.evaluate(({ dark, enlarged }) => { document.documentElement.classList.toggle('theme-dark',dark); document.body.classList.toggle('theme-dark',dark); document.documentElement.style.fontSize=enlarged?'200%':''; }, {dark,enlarged});
    await page.locator('#main').evaluate(main => main.scrollTo({top:300,behavior:'instant'}));
    await expect(page.locator('.admin-topbar #sidebarToggle')).toHaveCount(1);
    const geometry = await page.evaluate(() => {
      const bar=document.querySelector('.admin-topbar').getBoundingClientRect();
      const controls=['sidebarToggle','adminSearchOpen','adminIdentity'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};});
      return { bar:{left:bar.left,right:bar.right,top:bar.top,bottom:bar.bottom},controls,scroll:document.querySelector('#main').scrollTop,overflow:document.documentElement.scrollWidth>innerWidth+1 };
    });
    expect(geometry.scroll).toBeGreaterThan(80); expect(geometry.overflow).toBe(false);
    expect(geometry.bar.top).toBeGreaterThanOrEqual(-1); expect(geometry.bar.bottom).toBeLessThan(height/2);
    for (const control of geometry.controls) { expect(control.width).toBeGreaterThanOrEqual(44);expect(control.height).toBeGreaterThanOrEqual(44);expect(control.top).toBeGreaterThanOrEqual(geometry.bar.top);expect(control.bottom).toBeLessThanOrEqual(geometry.bar.bottom); }
    await page.screenshot({path:info.outputPath(`navigation-toolbar-${name}.png`)});
    const toolbarA11y=await new AxeBuilder({page}).include('.admin-topbar').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
    await require('node:fs/promises').writeFile(info.outputPath(`navigation-toolbar-${name}-a11y.json`),JSON.stringify({passes:toolbarA11y.passes.map(rule=>rule.id),violations:toolbarA11y.violations},null,2));
    expect(toolbarA11y.violations.map(rule=>({id:rule.id,nodes:rule.nodes.map(node=>({target:node.target,summary:node.failureSummary}))}))).toEqual([]);
    await page.locator('#sidebarToggle').click();
    const drawer=page.getByRole('dialog',{name:'Admin navigation',exact:true}); await expect(drawer).toBeVisible();
    const drawerBounds=await drawer.boundingBox(); expect(drawerBounds.x).toBeGreaterThanOrEqual(0);expect(drawerBounds.x+drawerBounds.width).toBeLessThanOrEqual(width);expect(drawerBounds.height).toBeLessThanOrEqual(height);
    expect(await page.locator('#sidebarNav').evaluate(sidebar=>sidebar.scrollWidth<=sidebar.clientWidth+1)).toBe(true);
    const close=page.getByRole('button',{name:'Close navigation',exact:true});
    const closeBounds=await close.boundingBox();expect(closeBounds.x).toBeGreaterThanOrEqual(0);expect(closeBounds.x+closeBounds.width).toBeLessThanOrEqual(width);expect(closeBounds.y+closeBounds.height).toBeLessThanOrEqual(height);
    await page.screenshot({path:info.outputPath(`navigation-drawer-${name}.png`)});
    const drawerA11y=await new AxeBuilder({page}).include('#adminNavigationDialog').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
    await require('node:fs/promises').writeFile(info.outputPath(`navigation-drawer-${name}-a11y.json`),JSON.stringify({passes:drawerA11y.passes.map(rule=>rule.id),violations:drawerA11y.violations},null,2));
    expect(drawerA11y.violations.map(rule=>({id:rule.id,nodes:rule.nodes.map(node=>({target:node.target,summary:node.failureSummary}))}))).toEqual([]);
    await close.click();await expect(page.locator('#sidebarToggle')).toBeFocused();
  }
  expect(errors).toEqual([]);
});
test('admin navigation excludes the closed drawer and contains keyboard focus while open', async ({ browser }, info) => {
  const { page, errors } = await financeShell(browser); await mobileShell(page);
  await page.locator('#adminFinanceFrom').fill('2026-09-01');
  await page.locator('#main').evaluate(main=>main.scrollTo({top:260,behavior:'instant'}));
  const scroll=await page.locator('#main').evaluate(main=>main.scrollTop);
  await page.locator('#sidebarNav [data-section="overview"]').evaluate(button=>button.focus());
  expect(await page.locator('#sidebarNav').evaluate(sidebar=>sidebar.contains(document.activeElement))).toBe(false);
  await page.locator('#sidebarToggle').click();
  const drawer=page.getByRole('dialog',{name:'Admin navigation',exact:true}); await expect(drawer).toBeVisible();
  await expect(page.locator('#sidebarToggle')).toHaveAttribute('aria-expanded','true');
  await page.locator('#adminFinanceFrom').evaluate(input=>input.focus());
  expect(await page.locator('#sidebarNav').evaluate(sidebar=>sidebar.contains(document.activeElement))).toBe(true);
  const close=page.getByRole('button',{name:'Close navigation',exact:true}); await close.focus();
  await page.keyboard.press(info.project.name==='webkit'?'Alt+Shift+Tab':'Shift+Tab'); await expect(page.locator('#logoutBtn')).toBeFocused();
  await page.keyboard.press(info.project.name==='webkit'?'Alt+Tab':'Tab'); await expect(close).toBeFocused();
  await page.mouse.move(380,500); await page.mouse.wheel(0,600);
  expect(await page.locator('#main').evaluate(main=>main.scrollTop)).toBe(scroll);
  await page.screenshot({path:info.outputPath('navigation-open-keyboard.png')});
  await page.keyboard.press('Escape'); await expect(drawer).toBeHidden(); await expect(page.locator('#sidebarToggle')).toBeFocused();
  expect(await page.locator('#main').evaluate(main=>main.scrollTop)).toBe(scroll);
  await expect(page.locator('#adminFinanceFrom')).toHaveValue('2026-09-01');
  await page.locator('#sidebarToggle').click(); await page.mouse.click(380,500); await expect(drawer).toBeHidden(); await expect(page.locator('#sidebarToggle')).toBeFocused();
  expect(errors).toEqual([]);
});
test('admin navigation returns to a usable desktop sidebar through repeated responsive changes', async ({ browser }) => {
  const { page, errors } = await financeShell(browser);
  for (let i=0;i<3;i++) {
    await mobileShell(page); await page.locator('#sidebarToggle').click();
    await expect(page.getByRole('dialog',{name:'Admin navigation',exact:true})).toBeVisible();
    await page.setViewportSize({width:1366,height:900});
    await expect(page.getByRole('dialog',{name:'Admin navigation',exact:true})).toBeHidden();
    await expect(page.locator('#sidebarToggle')).toBeHidden();
    await expect(page.locator('#sidebarNav [data-section="finance"]')).toBeFocused();
    expect(await page.locator('#sidebarNav').evaluate(sidebar=>sidebar.parentElement===document.body)).toBe(true);
    await mobileShell(page); await expect(page.locator('#sidebarToggle')).toBeFocused();
    await page.locator('#sidebarToggle').click(); await page.getByRole('button',{name:'Close navigation',exact:true}).click();
    await expect(page.locator('#sidebarToggle')).toBeFocused();
  }
  expect(errors).toEqual([]);
});
test('admin navigation selection and search retain their existing destinations and modal boundaries', async ({ browser }, info) => {
  const { page, errors } = await financeShell(browser); await mobileShell(page);
  await page.locator('#sidebarToggle').click(); await page.locator('#sidebarNav [data-section="user-management"]').click();
  await expect(page.locator('#section-user-management')).toBeVisible();
  await expect(page.getByRole('dialog',{name:'Admin navigation',exact:true})).toBeHidden();
  await expect(page.locator('#sidebarToggle')).toHaveAttribute('aria-expanded','false');
  await page.locator('#adminSearchOpen').click(); await expect(page.locator('#adminSearchDialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#adminSearchOpen')).toBeFocused();
  const editing=page.locator('#main input:visible').first(); await editing.focus();
  const shortcut=await page.evaluate(()=>/Mac|iPhone|iPad/.test(navigator.platform)?'Meta+k':'Control+k');
  await page.keyboard.press(shortcut); await expect(page.locator('#adminSearchDialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(editing).toBeFocused();
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#sidebarToggle').click(); await expect(page.getByRole('dialog',{name:'Admin navigation',exact:true})).toBeVisible();
  await page.locator('#sidebarNav details').first().locator('summary').click();
  await expect(page.getByRole('dialog',{name:'Admin navigation',exact:true})).toBeVisible();
  await page.keyboard.press(shortcut); await expect(page.getByRole('dialog',{name:'Admin navigation',exact:true})).toBeVisible(); await expect(page.locator('#adminSearchDialog')).toBeHidden();
  await page.screenshot({path:info.outputPath('navigation-expanded-group-reduced-motion.png')});
  await page.keyboard.press('Escape'); await expect(page.locator('#sidebarToggle')).toBeFocused();
  expect(errors).toEqual([]);
});
