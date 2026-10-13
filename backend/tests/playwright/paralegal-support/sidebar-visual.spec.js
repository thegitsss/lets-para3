const { test, expect } = require('../support-session-fixture');
const { installSettingsProjection } = require('./settings-fixtures');
for(const width of [1440,390]) test(`sidebar presentation ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:1000});await installSettingsProjection(page);await page.goto('/paralegal-v2.html#/settings?tab=profile');await expect(page.locator('#v2-settings-profile')).toBeVisible();
 const sidebar=page.locator('#v2-sidebar'),toggle=page.locator('[data-v2-mobile-menu]');
 if(width===390)await toggle.click();
 const links=sidebar.locator('.v2-desktop-primary > a,.v2-matters-heading > a');await expect(links).toHaveText(['Home','Matters','Messages','Find Work','Payouts']);expect(await links.locator('svg').count()).toBe(5);await page.screenshot({path:info.outputPath('expanded.png'),animations:'disabled'});
 if(width===1440){await toggle.click();await page.mouse.move(800,500);await expect(sidebar).toHaveCSS('width','76px');await page.screenshot({path:info.outputPath('collapsed.png')});const canvas=await page.locator('.v2-app-frame').boundingBox();await sidebar.hover();await expect(sidebar).toHaveCSS('width','216px');await expect(links.first().locator('span')).toBeVisible();expect((await page.locator('.v2-app-frame').boundingBox()).x).toBe(canvas.x);await page.screenshot({path:info.outputPath('hover.png')});await links.first().focus();await page.mouse.move(800,500);await expect(sidebar).toHaveCSS('width','216px');await page.locator('#main').focus();await expect(sidebar).toHaveCSS('width','76px');}
 else {await expect(page.locator('#v2-navigation-dialog')).toBeVisible();await sidebar.getByRole('button',{name:'Close navigation'}).click();await expect(page.locator('#v2-navigation-dialog')).not.toBeVisible();}
 await page.emulateMedia({reducedMotion:'reduce'});expect(await sidebar.evaluate(el=>Math.max(...getComputedStyle(el).transitionDuration.split(',').map(parseFloat)))).toBeLessThanOrEqual(.00001);
});
