const { expect } = require('playwright/test');
const { test } = require('../workspace-search/shell-fixture');
const { installCurrentHome, home } = require('../paralegal-support/current-home-fixtures');
const outlet = page => page.locator('[data-v2-route-outlet]');
const rail = page => page.locator('[data-v2-persistent="sidebar"]');
async function start(page, width = 1440) {
  await page.setViewportSize({width,height:900});
  await page.addInitScript(() => {window.EventSource=class extends EventTarget {close(){}};});
  await installCurrentHome(page); await home(page);
  await page.addStyleTag({content:'[data-v2-route-outlet] > :first-child {min-height:2200px!important;}'});
}
test('desktop sidebar forwards vertical wheel movement while long navigation scrolls itself first', async ({page}) => {
  await start(page); const view=outlet(page), navigation=page.locator('.v2-desktop-primary');
  await rail(page).hover({position:{x:90,y:40}}); await page.mouse.wheel(0,300);
  await expect.poll(() => view.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  await view.evaluate(el=>{el.scrollTop=0;});
  await navigation.evaluate(el=>{el.style.height='160px';el.style.flex='0 0 160px';const probe=document.createElement('div');probe.style.height='500px';probe.setAttribute('aria-hidden','true');el.append(probe);});
  await navigation.hover({position:{x:90,y:30}});await page.mouse.wheel(0,180);
  await expect.poll(() => navigation.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);expect(await view.evaluate(el=>el.scrollTop)).toBe(0);
  await page.mouse.wheel(0,-100);await expect.poll(() => navigation.evaluate(el=>el.scrollTop)).toBeLessThan(180);expect(await view.evaluate(el=>el.scrollTop)).toBe(0);
  await navigation.evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.mouse.wheel(0,200);
  await expect.poll(() => view.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  await view.evaluate(el=>{el.scrollTop=300;});await navigation.evaluate(el=>{el.scrollTop=0;});await page.mouse.wheel(0,-100);
  await expect.poll(() => view.evaluate(el=>el.scrollTop)).toBeLessThan(300);
});
test('mobile navigation scroll does not move the obscured workspace', async ({page}) => {
  await start(page,390);const view=outlet(page);await view.evaluate(el=>{el.scrollTop=260;});
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();await expect(page.getByRole('dialog',{name:'Workspace navigation',exact:true})).toBeVisible();
  const navigation=page.locator('.v2-desktop-primary');await navigation.evaluate(el=>{el.style.height='160px';el.style.flex='0 0 160px';const probe=document.createElement('div');probe.style.height='500px';el.append(probe);});
  await navigation.hover({position:{x:90,y:30}});await page.mouse.wheel(0,200);await expect.poll(() => navigation.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  expect(await view.evaluate(el=>el.scrollTop)).toBe(260);
  await navigation.evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.mouse.wheel(0,200);expect(await view.evaluate(el=>el.scrollTop)).toBe(260);
  await page.keyboard.press('Escape');expect(await view.evaluate(el=>el.scrollTop)).toBe(260);
});
test('horizontal and zoom wheel gestures are not intercepted by the sidebar', async ({page}) => {
  await start(page);await outlet(page).evaluate(el=>{el.scrollTop=200;});
  const prevented=await rail(page).evaluate(el=>[
    !el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:300,deltaY:20})),
    !el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:200,ctrlKey:true}))
  ]);expect(prevented).toEqual([false,false]);expect(await outlet(page).evaluate(el=>el.scrollTop)).toBe(200);
});
