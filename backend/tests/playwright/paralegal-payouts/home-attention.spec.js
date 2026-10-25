const { test, expect } = require('playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { installCurrentHome, USER, json } = require('../paralegal-support/current-home-fixtures');
async function setup(page, overrides = {}) {
  await page.route('**/api/**', route => json(route, {}));
  const state = await installCurrentHome(page, overrides);
  await page.route('**/api/auth/workspace-release', route => json(route, { workspace: { schemaVersion: 1, ownerId: USER, role:'paralegal', revision:1, version:'v2', defaultDestination:'/paralegal-v2.html#/home' } }));
  await page.goto('/paralegal-v2.html');
  await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading','false');
  return state;
}
const home = page => page.locator('[data-home-summary]');
test('default Home prioritizes exact revision and invitation actions and keeps full work under Matters', async ({ page }) => {
  await setup(page);
  await expect(page).toHaveURL(/#\/home$/);
  await expect(page.getByRole('heading',{ name:'Home',exact:true })).toBeVisible();
  await expect(home(page).getByRole('region',{ name:'Needs your attention' })).toContainText('Correct citations');
  await expect(home(page).locator('a[href*="fileId="]')).toHaveCount(1);
  await expect(home(page).getByRole('region',{ name:'Current Matters' }).locator('article')).toHaveCount(2);
  const target=await home(page).getByRole('region',{name:'Current Matters'}).locator('article a').first().getAttribute('href');
  expect(new URLSearchParams(target.split('?')[1]).get('returnTo')).toBe('/home');
  await expect(home(page).getByRole('region',{ name:'Messages' })).toBeVisible();
  await expect(page.getByRole('tab',{ name:/Assigned/ })).toHaveCount(0);
  const setupPanel = home(page).getByRole('region', { name: 'Account setup' });
  await setupPanel.locator('summary').click();
  await expect(setupPanel).toContainText('Choose your primary state');
  await expect(setupPanel.getByRole('link', { name: 'Update profile' }).first()).toHaveAttribute('href', /settings.*tab=profile/);
  await page.getByRole('navigation',{ name:'Primary',exact:true }).getByRole('link',{ name:'Matters',exact:true }).click();
  await expect(page.locator('[data-v2-work]')).toHaveAttribute('data-work-section','active');
  await page.goBack();
  await expect(home(page)).toBeVisible();
  await page.goto('/paralegal-v2.html#/home?view=work');
  await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading','false');
  await expect(page.getByRole('complementary', { name: 'Profile to-dos' })).toHaveCount(0);
});
test('failed reads remain unavailable rather than claiming no actions or messages', async ({ page }) => {
  await setup(page,{ failures:{ dashboard:503, threads:503, unread:503, invites:503, applications:503 } });
  await expect(home(page)).toContainText('Some attention items could not be checked');
  await expect(home(page)).toContainText('Message activity could not be checked');
  await expect(home(page)).not.toContainText('No action items');
  await expect(home(page)).not.toContainText('No unread messages');
  await expect(home(page)).not.toContainText('No active Matters');
});
test('Home is readable and keyboard accessible on desktop and phone', async ({ page }, info) => {
  await setup(page);
  for(const width of [1440,390,320]) {
    await page.setViewportSize({ width,height:900 });
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await home(page).evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await page.screenshot({ path:info.outputPath(`home-attention-${width}.png`), fullPage:true });
  }
  expect((await new AxeBuilder({page}).include('[data-v2-home]').analyze()).violations).toEqual([]);
});

test('message summary stays unavailable when Matter access cannot be checked', async ({page}) => {
 await setup(page,{failures:{dashboard:503}});
 await expect(home(page)).toContainText('Message activity could not be checked.');
 await expect(home(page)).not.toContainText('No unread messages.');
 await expect(home(page).getByRole('region',{name:'Messages'}).locator('article')).toHaveCount(0);
});


test('workspace check failures use a compact notice and recover without replacing Home',async({page},info)=>{
 await setup(page);
 let failed=true;
 await page.route('**/api/auth/workspace-release',route=>json(route,failed?{error:'Unavailable'}:{workspace:{schemaVersion:1,ownerId:USER,role:'paralegal',revision:1,version:'v2',defaultDestination:'/paralegal-v2.html#/home'}},failed?503:200));
 await page.reload();
 await expect(page.locator('[data-v2-home]')).toHaveAttribute('data-home-loading','false');
 await page.evaluate(()=>window.__retainedHome=document.querySelector('[data-v2-home]'));
 const notice=page.locator('[data-workspace-release-notice]');await expect(notice).toBeVisible();
 for(const width of [1440,320]){
  await page.setViewportSize({width,height:900});
  await expect.poll(async()=> (await notice.boundingBox()).height).toBeLessThan(230);
  if(width===320)await expect.poll(()=>page.locator('.v2-app-frame').evaluate(el=>Math.abs(el.getBoundingClientRect().left))).toBeLessThan(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(home(page)).toBeVisible();
  const frame=await page.locator('[data-v2-home]').boundingBox();expect(frame.y+frame.height).toBeLessThanOrEqual(901);
  if(width===1440){const toolbar=await page.locator('.v2-global-tools').boundingBox();expect((await notice.boundingBox()).y).toBeGreaterThanOrEqual(toolbar.y+toolbar.height);}
  await page.screenshot({path:info.outputPath(`release-notice-${width}.png`)});
 }
 await expect(notice.getByRole('button',{name:'Check again',exact:true})).toBeEnabled();
 failed=false;await notice.getByRole('button',{name:'Check again',exact:true}).click();await expect(notice).toHaveCount(0);
 expect(await page.evaluate(()=>window.__retainedHome===document.querySelector('[data-v2-home]'))).toBe(true);
});
