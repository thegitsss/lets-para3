const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {installSettingsProjection}=require('./settings-fixtures');
const AxeBuilder=require('@axe-core/playwright').default;

test('rebuilt settings header, explicit profile save and security retain their owners',async({page},info)=>{
 const state=await installSettingsProjection(page);
 await page.goto('/paralegal-v2.html#/settings?tab=profile');
 const heading=page.getByRole('heading',{name:'Profile Settings',exact:true});
 await expect(heading).toBeVisible();
 expect(await heading.evaluate(el=>el.getBoundingClientRect().height<=parseFloat(getComputedStyle(el).lineHeight)+1)).toBe(true);
 const panel=page.locator('#v2-settings-profile');
 const editName=panel.getByRole('button',{name:'Edit name',exact:true});
 await editName.click();
 const first=panel.getByRole('textbox',{name:'First name',exact:true});
 await first.fill('Danielle');await first.blur();
 expect(state.user.firstName).toBe('Dana');
 expect(state.profilePatches).toEqual([]);
 await panel.locator('.is-row-editing').getByRole('button',{name:'Save',exact:true}).click();
 await expect.poll(()=>state.user.firstName).toBe('Danielle');
 expect(state.profilePatches).toEqual([{firstName:'Danielle'}]);
 await page.getByRole('tab',{name:'Security',exact:true}).click();
 await expect(page.locator('#v2-settings-security')).toBeVisible();
 await expect.poll(()=>state.securityReads).toBeGreaterThan(0);
 expect(state.securityMutations).toEqual([]);
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`settings-security-${width}.png`),fullPage:true});
 }
 await page.getByRole('tab',{name:'Profile',exact:true}).click();
 await expect(editName).toContainText('Danielle');
 await page.setViewportSize({width:1440,height:1000});
 const photoActions=panel.getByRole('button',{name:'Open profile photo actions',exact:true});
 await expect(photoActions).toBeVisible();
 await photoActions.click();
 await expect(page.getByRole('menuitem',{name:'Edit crop'})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('menuitem',{name:'Edit crop'})).toBeHidden();
 await expect(page.getByRole('tab',{name:'Profile',exact:true})).toHaveAttribute('aria-selected','true');
 await editName.click();
 await expect(first).toHaveValue('Danielle');
 const personal=panel.locator('.v2-settings-personal-fields > .v2-settings-field');
 const desktopFirst=await personal.nth(0).boundingBox(), desktopLast=await personal.nth(1).boundingBox();
 expect(Math.abs(desktopFirst.y-desktopLast.y)).toBeLessThan(2);
 await page.screenshot({path:info.outputPath('settings-profile.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('settings-profile-mobile.png'),fullPage:true});
 expect((await new AxeBuilder({page}).include('[data-v2-settings]').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
});

test('Help uses readable disclosures and keeps navigation and Assistant available',async({page},info)=>{
 await require('./alignment-fixture').fixture(page);
 await page.goto('/paralegal-v2.html#/help');
 const answer=page.locator('.v2-help-answer').first();
 const summary=answer.locator('summary');await expect(summary).toBeVisible();
 expect((await summary.boundingBox()).height).toBeGreaterThanOrEqual(44);
 await summary.focus();await page.keyboard.press('Enter');await expect(answer).toHaveAttribute('open','');
 await expect(answer.locator('p')).toBeVisible();
 await page.getByRole('button',{name:'Ask LPC Assistant',exact:true}).click();
 await expect(page.locator('.support-drawer')).toHaveAttribute('aria-hidden','false');
 await page.getByRole('navigation',{name:'Primary',exact:true}).getByRole('link',{name:'Home',exact:true}).click();
 await expect(page.locator('[data-v2-home]')).toBeVisible();
 await expect(page.locator('.support-drawer')).toHaveAttribute('aria-hidden','false');
 await page.screenshot({path:info.outputPath('help-assistant-navigation.png')});
 expect(page.__homeErrors).toEqual([]);
});
