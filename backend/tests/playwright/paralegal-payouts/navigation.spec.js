const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { installCurrentHome, USER, json } = require('../paralegal-support/current-home-fixtures');
async function setup(page) {
  await page.route('**/api/**', route => json(route, {}));
  await installCurrentHome(page);
  await page.route(url => url.pathname === '/api/account/dashboard-views', route => json(route, { ownerId: USER, scope: 'paralegal_applications', views: [] }));
  await page.route('**/api/auth/workspace-release', route => json(route, { workspace: { schemaVersion: 1, ownerId: USER, role: 'paralegal', revision: 1, version: 'v2', defaultDestination: '/paralegal-v2.html#/home' } }));
  await page.goto('/paralegal-v2.html#/home?view=work');
  await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading', 'false');
}
const primary = page => page.getByRole('navigation', { name: 'Primary', exact: true });
test('five primary destinations retain every secondary view and select the owning destination', async ({ page }) => {
  await setup(page);
  expect(await primary(page).getByRole('link').allTextContents()).toEqual(['Home','Matters','Messages','Find Work','Payouts']);
  await expect(primary(page).getByRole('link', { name: 'Matters', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-v2-navigation-context] a[aria-current="page"]')).toHaveCount(1);
  const links = await page.locator('[data-v2-navigation-context] a').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')));
  for (const view of ['pulse','inbox','work','reviews','matters','deadlines','board','insights','document']) expect(links).toContain(`paralegal-v2.html#/home?view=${view}`);
  expect(links).toContain('paralegal-v2.html#/work?section=history');
  for(const section of ['active','applications','invitations'])expect(links).toContain(`paralegal-v2.html#/work?section=${section}`);
  await expect(primary(page).getByRole('link',{name:'Matters',exact:true})).toHaveAttribute('href','paralegal-v2.html#/work');
  for (const view of ['reviews','deadlines','board','insights','document']) {
    await page.locator(`[data-desktop-home-view="${view}"]`).click();
    await expect(page).toHaveURL(new RegExp(`view=${view}$`));
    await expect(primary(page).getByRole('link', { name: 'Matters', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-v2-rendered-route="home"]')).toBeVisible();
  }
  await primary(page).getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('[data-v2-navigation-context="home"]')).toBeVisible();
  await expect(page.locator('[data-v2-navigation-context="work"]').first()).toBeHidden();
  await expect(primary(page).getByRole('link', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await primary(page).getByRole('link', { name: 'Payouts' }).click();
  await expect(page.locator('[data-v2-payouts]')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('[data-v2-navigation-context]:visible')).toHaveCount(0);
});
test('mobile navigation preserves destination order, closes after selection and has no overflow', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(primary(page)).toBeVisible();
  expect(await primary(page).getByRole('link').allTextContents()).toEqual(['Home','Matters','Messages','Find Work','Payouts']);
  await page.screenshot({ path: info.outputPath('navigation-phone.png') });
  expect((await new AxeBuilder({ page }).include('#v2-sidebar').analyze()).violations).toEqual([]);
  await primary(page).getByRole('link', { name: 'Payouts' }).click();
  await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-v2-payouts]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('both role shells say Messages while existing conversation and Matter links retain identity', async ({ page }, info) => {
  await setup(page);
  const values = await page.evaluate(async () => {
    const attorney = new DOMParser().parseFromString(await (await fetch('/attorney-v2.html')).text(), 'text/html');
    const para = await import('/assets/scripts/paralegal-v2/router.mjs');
    const attorneyRoutes = await import('/assets/scripts/attorney-v2/routes.mjs');
    return { label: attorney.querySelector('[data-av2-route="conversations"] span').textContent, para: para.parseRouteHash('#/matter/64b000000000000000010001?tab=messages&messageId=64b000000000000000010009'), exports: Object.keys(attorneyRoutes) };
  });
  expect(values.label).toBe('Messages');
  expect(values.para).toMatchObject({ name:'conversations', title:'Messages' });
  const brand = page.locator('.v2-desktop-brand-word');
  await expect(brand).toHaveText('Let’s-ParaConnect');
  expect(await brand.evaluate(node => {
    const text = document.createRange(); text.selectNodeContents(node);
    const box = text.getBoundingClientRect();
    const bounds = node.closest('a').getBoundingClientRect();
    return box.left >= bounds.left && box.right <= bounds.right + 1 && box.height < 30;
  })).toBe(true);
  await page.screenshot({ path: info.outputPath('navigation-desktop.png') });
});


test('Matters opens the full inventory and exposes each lifecycle view directly',async({page},info)=>{
 await setup(page);
 await primary(page).getByRole('link',{name:'Matters',exact:true}).click();
 await expect(page).toHaveURL(/#\/work$/);
 const work=page.locator('[data-v2-work]');await expect(work).toHaveAttribute('data-work-section','active');
 await expect(page.getByRole('heading',{name:'Matters',exact:true,level:1})).toBeVisible();
 const views=page.getByRole('navigation',{name:'Matter views',exact:true});
 await expect(views.getByRole('link',{name:'Active',exact:true})).toHaveAttribute('aria-current','page');
 for(const [name,section] of [['Applications','applications'],['Invitations','invitations'],['History','history'],['Active','active']]){
  await views.getByRole('link',{name,exact:true}).click();
  await expect(work).toHaveAttribute('data-work-section',section);
  await expect(views.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(views.getByRole('link',{name,exact:true})).toHaveAttribute('aria-current','page');
 }
 await page.screenshot({path:info.outputPath('matters-inventory-desktop.png')});
 await page.setViewportSize({width:320,height:900});
 await expect.poll(()=>page.locator('.v2-app-frame').evaluate(el=>Math.abs(el.getBoundingClientRect().left))).toBeLessThan(1);
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await views.getByRole('link',{name:'Applications',exact:true}).click();
 await expect(work).toHaveAttribute('data-work-section','applications');
 await expect(page.getByRole('button',{name:'Open navigation',exact:true})).toHaveAttribute('aria-expanded','false');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await expect(page.getByText('Saved views couldn’t load.', { exact: true })).toHaveCount(0);
 expect(await page.locator('.v2-work-index').evaluate(el=>el.getBoundingClientRect().height)).toBeLessThan(115);
 await page.screenshot({path:info.outputPath('matters-applications-phone.png')});
});
