const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {installSettingsProjection}=require('./settings-fixtures');
const {openProfileScope}=require('./profile-editor-fixture');
const {populated,incomplete}=require('./profile-hierarchy-fixture');
for(const width of [1440,390,320]) {
 test(`Profile hierarchy and existing experience contract ${width}`,async({page})=>{
  const options={user:populated,rejectProfilePatches:false};const state=await installSettingsProjection(page,options);
  await page.setViewportSize({width,height:1045});await page.goto('/paralegal-v2.html#/settings?tab=profile');const panel=page.locator('#v2-settings-profile');
  await expect(panel.getByRole('heading',{name:'Languages',exact:true})).toBeVisible();await expect(panel.locator('.v2-profile-language-summary').getByText('English',{exact:true})).toHaveCount(1);await expect(panel.getByRole('heading',{name:'Best for',exact:true})).toHaveCount(0);
  await expect(panel.locator('.v2-profile-skills-summary')).toHaveText('Discovery · Legal research · Document review · Relativity · Microsoft Excel · Trial preparation · Document-intensive matters · Deadline coordination');
  await expect(panel.locator('.v2-profile-work-summary')).toContainText('Example Legal Group');await expect(panel.locator('.v2-profile-work-summary')).toContainText('2020–present');
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  if(width===1440){const a=await panel.locator('.v2-profile-background').boundingBox(),b=await panel.locator('[data-profile-group="professional"]').boundingBox();expect(a.x).toBeGreaterThan(b.x+b.width);}
  await openProfileScope(page,'experience');const card=panel.locator('[data-profile-section="experience"]');await card.getByRole('button',{name:'Edit role / title, work experience entry 1',exact:true}).press('Enter');
  await card.getByLabel('Role / title',{exact:true}).first().fill('Lead litigation paralegal');options.rejectProfilePatches=true;await card.getByRole('button',{name:'Save',exact:true}).click();await expect(card).toContainText('temporarily unavailable');expect(state.user.experience[0].title).toBe(populated.experience[0].title);
  options.rejectProfilePatches=false;await card.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>state.user.experience[0].title).toBe('Lead litigation paralegal');expect(state.user.experience[0].description).toBe(populated.experience[0].description);expect(state.user.experience[0].years).toBe(populated.experience[0].years);expect(state.user.experience[1]).toEqual(populated.experience[1]);expect(state.user.bestFor).toEqual(populated.bestFor);
  await card.getByRole('button',{name:'Edit organization & description, work experience entry 2',exact:true}).click();await card.getByLabel('Organization & description',{exact:true}).last().fill('Discard this');await card.getByRole('button',{name:'Cancel',exact:true}).click();expect(state.user.experience[1]).toEqual(populated.experience[1]);
  await card.getByRole('button',{name:'Add work experience',exact:true}).click();await card.getByLabel('Role / title',{exact:true}).last().fill('Unsaved role');await card.getByRole('button',{name:'Cancel',exact:true}).click();expect(state.user.experience).toHaveLength(2);
  expect(state.profilePatches.filter(p=>Object.hasOwn(p,'experience')).every(p=>Object.keys(p).length===1)).toBe(true);
 });
 test(`Incomplete Profile remains actionable ${width}`,async({page})=>{
  await installSettingsProjection(page,{user:incomplete});await page.setViewportSize({width,height:1045});await page.goto('/paralegal-v2.html#/settings?tab=profile');const panel=page.locator('#v2-settings-profile');await expect(panel.getByText('No work experience added',{exact:true})).toBeVisible();await expect(panel.getByText('No education added',{exact:true})).toBeVisible();await expect(panel.getByText('No languages added',{exact:true})).toBeVisible();await expect(panel.getByText('Not uploaded',{exact:true})).toHaveCount(3);await expect(panel.getByRole('button',{name:'Edit résumé',exact:true})).toBeVisible();
  expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await openProfileScope(page,'experience');await expect(panel.getByRole('button',{name:'Add work experience',exact:true})).toBeVisible();
 });
}
