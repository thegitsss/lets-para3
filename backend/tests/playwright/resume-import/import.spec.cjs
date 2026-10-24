const {test,expect}=require('playwright/test');
const AxeBuilder=require('@axe-core/playwright').default;
const fixture=require('../../fixtures/resume-import/synthetic.cjs');
test.beforeEach(async({request})=>{await request.post('/preview-reset',{data:{}});});
const state=async request=>(await request.get('/preview-state')).json();
const dialog=page=>page.getByRole('dialog');
async function review(page){await page.getByRole('button',{name:'Autofill from my résumé',exact:true}).click();await expect(dialog(page).getByRole('heading',{name:'A head start. Your final say.'})).toBeVisible();}
for(const width of [1280,390]){
 test(`existing résumé: consent, edit, apply, preservation, repeat import ${width}`,async({page,request},info)=>{
  await page.setViewportSize({width,height:900});await page.goto('/');const before=await state(request);
  await expect(dialog(page)).toContainText('Your résumé has a head start.');await expect(dialog(page)).toContainText('Use the résumé you submitted to fill in your experience, education, and skills. You’ll review everything before it’s saved.');
  expect(before.counts.extracts).toBe(0);await page.screenshot({path:info.outputPath('intro.png')});await review(page);
  const d=dialog(page);await expect(d.getByLabel('Apply About suggestion 10')).not.toBeChecked();
  expect((await state(request)).counts.patches).toBe(0);
  await d.getByLabel('Description',{exact:true}).first().fill('Prepared discovery indexes and trial binders. Reviewed.');
  await d.getByLabel('Apply Skills / tools suggestion 6').uncheck();
  await d.getByText('From your résumé',{exact:true}).first().click();await expect(d).toContainText('Prepared discovery indexes');
  const axe=await new AxeBuilder({page}).include('.ri-dialog').withTags(['wcag2a','wcag2aa']).analyze();expect(axe.violations).toEqual([]);
  expect(await d.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);await d.screenshot({path:info.outputPath('review.png')});
  await d.getByRole('button',{name:'Apply selected changes'}).click();await expect(d).toHaveCount(0);const after=await state(request);
  expect(after.user.experience).toHaveLength(2);expect(after.user.experience[0].description).toContain('Reviewed.');expect(after.user.education).toHaveLength(1);expect(after.user.skills).not.toContain('Clio');
  for(const field of ['bio','email','resumeURL','status','yearsExperience','state','stateExperience'])expect(after.user[field]).toEqual(before.user[field]);
  expect(after.user.languages.find(x=>x.name==='Spanish').proficiency).toBe('');await expect(page.getByRole('button',{name:'Fill from résumé'})).toBeFocused();
  await page.reload();await expect(dialog(page)).toHaveCount(0);await page.getByRole('button',{name:'Fill from résumé'}).click();await review(page);
  await expect(dialog(page).getByLabel('Apply Education suggestion 3')).toBeDisabled();
  await expect(dialog(page).getByLabel('Apply Experience suggestion 1')).toBeDisabled();
  await expect(dialog(page).getByLabel('Apply Experience suggestion 2')).toBeDisabled();
  await dialog(page).getByRole('button',{name:'Apply selected changes'}).click();await expect(dialog(page)).toHaveCount(0);const repeated=await state(request);expect(repeated.user.experience).toHaveLength(2);expect(repeated.user.education).toHaveLength(1);
 });
 test(`dismiss and cancel leave saved profile intact ${width}`,async({page,request})=>{
  await page.setViewportSize({width,height:850});await page.goto('/');const before=await state(request);await expect(dialog(page)).toBeVisible();await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);expect((await state(request)).counts.extracts).toBe(0);
  await page.reload();await expect(dialog(page)).toHaveCount(0);await page.getByRole('button',{name:'Fill from résumé'}).press('Enter');await review(page);await dialog(page).getByRole('button',{name:'Cancel',exact:true}).click();expect((await state(request)).user).toEqual(before.user);
 });
 test(`empty profile and explicit About replacement ${width}`,async({page,request})=>{
  await request.post('/preview-reset',{data:{empty:true}});await page.setViewportSize({width,height:900});await page.goto('/');await review(page);
  const about=dialog(page).locator('.ri-suggestion').filter({has:page.getByRole('textbox',{name:'About',exact:true})});await expect(about.getByRole('checkbox')).toBeChecked();await about.getByRole('textbox').fill('Reviewed: paralegal supporting discovery.');
  await dialog(page).getByRole('button',{name:'Apply selected changes'}).click();await expect(dialog(page)).toHaveCount(0);const after=await state(request);expect(after.user.bio).toBe('Reviewed: paralegal supporting discovery.');expect(after.user.skills).toHaveLength(3);expect(after.user.experience).toHaveLength(2);
 });
 test(`save failure retains draft and retry succeeds ${width}`,async({page,request})=>{
  await page.setViewportSize({width,height:900});await page.goto('/');await review(page);const before=await state(request);
  await page.route('**/api/users/me',route=>route.request().method()==='PATCH'?route.fulfill({status:503,json:{error:'Synthetic save failure'}}):route.continue());
  await dialog(page).getByRole('button',{name:'Apply selected changes'}).click();await expect(dialog(page)).toContainText('Synthetic save failure');expect((await state(request)).user).toEqual(before.user);
  await page.unroute('**/api/users/me');await dialog(page).getByRole('button',{name:'Apply selected changes'}).click();await expect(dialog(page)).toHaveCount(0);expect((await state(request)).user.education).toHaveLength(1);
 });
 test(`different résumé validates files and never replaces attachment ${width}`,async({page,request})=>{
  await page.setViewportSize({width,height:900});await page.goto('/');const before=await state(request);await page.getByRole('button',{name:'Use a different résumé',exact:true}).click();const input=dialog(page).getByLabel('Choose résumé');
  await input.setInputFiles({name:'resume.rtf',mimeType:'application/rtf',buffer:Buffer.from('unsupported')});await expect(dialog(page).getByRole('button',{name:'Read this résumé'})).toBeDisabled();
  await input.setInputFiles({name:'damaged.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 damaged')});await dialog(page).getByRole('button',{name:'Read this résumé'}).click();await expect(dialog(page)).toContainText('could not be read');expect((await state(request)).user).toEqual(before.user);
  await dialog(page).getByRole('button',{name:'Use a different résumé',exact:true}).click();await dialog(page).getByLabel('Choose résumé').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:fixture.pdf()});await dialog(page).getByRole('button',{name:'Read this résumé'}).click();await expect(dialog(page)).toContainText('A head start. Your final say.');await dialog(page).getByRole('button',{name:'Apply selected changes'}).click();await expect(dialog(page)).toHaveCount(0);expect((await state(request)).user.resumeURL).toBe(before.user.resumeURL);
 });
}
test('reduced motion and keyboard dismissal',async({page,request})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto('/');await expect(dialog(page)).toBeVisible();expect(await dialog(page).locator('.ri-piece').first().evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
 await page.getByRole('button',{name:'Autofill from my résumé',exact:true}).focus();await page.keyboard.press('Shift+Tab');expect(await page.evaluate(()=>!!document.activeElement.closest('dialog'))).toBe(true);await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Fill from résumé'})).toBeFocused();expect((await state(request)).counts.extracts).toBe(0);
});
test('no saved résumé offers upload; extraction cancellation ignores late results',async({page,request})=>{
 await request.post('/preview-reset',{data:{noResume:true}});await page.goto('/');await expect(dialog(page)).toContainText('Your experience. Already written.');await page.getByRole('button',{name:'Choose résumé',exact:true}).click();await dialog(page).getByLabel('Choose résumé').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:fixture.pdf()});
 let release;const wait=new Promise(resolve=>release=resolve);await page.route('**/api/users/me/resume-import',async route=>{if(route.request().method()==='POST'){await wait;await route.continue().catch(()=>{});}else await route.continue();});
 await dialog(page).getByRole('button',{name:'Read this résumé'}).click();await expect(dialog(page)).toContainText('Extracting readable text');await dialog(page).getByRole('button',{name:'Cancel',exact:true}).click();release();await expect(dialog(page)).toHaveCount(0);expect((await state(request)).counts.patches).toBe(0);
});
test('provider/read failure is truthful and keeps saved profile',async({page,request})=>{
 await page.goto('/');const before=await state(request);await page.route('**/api/users/me/resume-import',route=>route.request().method()==='POST'?route.fulfill({status:503,json:{error:'Reading temporarily unavailable'}}):route.continue());
 await page.getByRole('button',{name:'Autofill from my résumé',exact:true}).click();await expect(dialog(page)).toContainText('Reading temporarily unavailable');expect((await state(request)).user).toEqual(before.user);await dialog(page).getByRole('button',{name:'Enter manually',exact:true}).click();
});

test('explicit replacement is reviewed; concurrent values block apply',async({page,request})=>{
 await page.goto('/');await review(page);const before=await state(request);const d=dialog(page);
 await d.getByLabel('Apply About suggestion 10').check();await d.getByRole('textbox',{name:'About',exact:true}).fill('Reviewed résumé summary.');
 await page.route(/\/api\/users\/me\?expectedOwnerId=/,route=>route.fulfill({json:{...before.user,bio:'Changed in another tab'}}));
 await d.getByRole('button',{name:'Apply selected changes'}).click();await expect(d).toContainText('Your profile changed');expect((await state(request)).counts.patches).toBe(0);
 await page.unroute(/\/api\/users\/me\?expectedOwnerId=/);await d.getByRole('button',{name:'Apply selected changes'}).click();await expect(d).toHaveCount(0);expect((await state(request)).user.bio).toBe('Reviewed résumé summary.');
});
test('a lost save response is reconciled without a duplicate write',async({page,request})=>{
 await page.goto('/');await review(page);await page.route('**/api/users/me',async route=>{if(route.request().method()==='PATCH'){await route.fetch();await route.fulfill({status:503,json:{error:'Synthetic lost response'}});}else await route.continue();});
 await dialog(page).getByRole('button',{name:'Apply selected changes'}).click();await expect(dialog(page)).toHaveCount(0);const after=await state(request);expect(after.counts.patches).toBe(1);expect(after.user.experience).toHaveLength(2);
});
