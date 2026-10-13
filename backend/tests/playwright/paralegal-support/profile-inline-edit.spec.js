const { test, expect } = require('../support-session-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { installSettingsProjection, json } = require('./settings-fixtures');
for (const width of [1440,390]) {
 test(`profile editors ${width}`,async({page},info)=>{
  test.setTimeout(180000); await page.setViewportSize({width,height:1000});
  const options={rejectProfilePatches:false};const state=await installSettingsProjection(page,options);
  await page.route('**/api/users/me', async route => { if(route.request().method()==='PATCH') await new Promise(resolve=>setTimeout(resolve,350)); await route.fallback(); });
  await page.goto('/paralegal-v2.html#/settings?tab=profile');
  const panel=page.locator('#v2-settings-profile'); await expect(panel).toBeVisible();
  const fields=[['name','First name','Dani'],['name','Last name','Reed'],['residence','Residence','California'],['years of experience','Years of experience','9'],['about','Bio','Updated litigation and trial support.'],['practice areas','Select a practice area','Family Law'],['skills','Add skill','Trial preparation'],['states of experience','Select a state','CA — California'],['linkedin','Profile URL','https://linkedin.com/in/dani-young'],['email','Email','dani@example.com']];
  for(const [label,inputLabel,value] of fields){
   const trigger=panel.getByRole('button',{name:`Edit ${label}`,exact:true}), control=panel.getByLabel(inputLabel,{exact:true});
   const positions=()=>panel.locator('.v2-profile-editor-list').evaluate(list=>[...list.children].map(card=>({title:card.querySelector('h2')?.textContent,y:card.getBoundingClientRect().top-list.getBoundingClientRect().top})));
   const geometry=await positions();await trigger.press('Enter'); const active=panel.locator('.is-row-editing');
   const opened=await positions();for(let i=0;i<geometry.length;i++)expect(Math.abs(opened[i].y-geometry[i].y)).toBeLessThan(1);
   await expect(active).toHaveCount(1); await expect(control).toBeVisible();
   await active.screenshot({path:info.outputPath(`${label}-editing.png`)});
   const before=JSON.stringify(state.user), patches=state.profilePatches.length;
   const fill=async()=>{if(['Residence','Select a practice area','Select a state'].includes(inputLabel))await control.selectOption({label:value});else await control.fill(value);if(label==='skills')await control.press('Enter');};
   await fill(); await active.getByRole('button',{name:'Cancel',exact:true}).click();
   expect(JSON.stringify(state.user)).toBe(before); expect(state.profilePatches.length).toBe(patches); await expect(trigger).toBeFocused();await trigger.locator('..').screenshot({path:info.outputPath(`${label}-cancelled.png`)});
   await trigger.click(); await fill(); options.rejectProfilePatches=true;
   await active.getByRole('button',{name:'Save',exact:true}).click();
   await expect(active).toContainText('Profile save temporarily unavailable');
   await active.screenshot({path:info.outputPath(`${label}-server-error.png`)});
   options.rejectProfilePatches=false;
   const saving=active.getByRole('button',{name:'Save',exact:true}).click();
   await expect(active.getByRole('button',{name:'Saving…',exact:true})).toBeDisabled();
   await active.screenshot({path:info.outputPath(`${label}-saving.png`)});await saving;
   await expect(active).toHaveCount(0); await expect.poll(()=>state.profilePatches.length).toBeGreaterThan(patches);
   await page.reload(); await expect(trigger).toBeVisible();
  }
  await panel.getByRole('button',{name:'Edit linkedin',exact:true}).click();
  await panel.getByLabel('Profile URL').fill('not-a-link'); await panel.getByRole('button',{name:'Save',exact:true}).click();
  await expect(panel.getByLabel('Profile URL')).toHaveAttribute('aria-invalid','true'); await expect(panel.getByLabel('Profile URL')).toBeFocused();
  await panel.locator('.is-row-editing').screenshot({path:info.outputPath('validation-error.png')});
  await panel.getByLabel('Profile URL').press('Escape'); await expect(panel.locator('.is-row-editing')).toHaveCount(0);
  for(const [section,label,value] of [['education','School','New College'],['education','Degree','LL.B.'],['education','Field of study','Law'],['languages','Language','Spanish'],['languages','Proficiency','Professional']]){
   const card=panel.locator(`[data-profile-section="${section}"]`),trigger=card.getByRole('button',{name:`Edit ${label.toLowerCase()}, ${section} entry 1`,exact:true});
   const fill=async()=>{const control=card.getByLabel(label,{exact:true});if(label==='Proficiency')await control.selectOption({label:value});else await control.fill(value);}; await trigger.press('Enter'); await fill(); await card.screenshot({path:info.outputPath(`${section}-editing.png`)});
   await card.getByRole('button',{name:'Cancel',exact:true}).click();
   await expect(trigger).toBeFocused(); await trigger.click(); await fill(); options.rejectProfilePatches=true; await card.getByRole('button',{name:'Save',exact:true}).click(); await expect(card).toContainText('Profile save temporarily unavailable'); await card.screenshot({path:info.outputPath(`${section}-${label}-error.png`)}); options.rejectProfilePatches=false; await card.getByRole('button',{name:'Save',exact:true}).click();
   await expect.poll(()=>state.user[section][0][({'School':'school','Degree':'degree','Field of study':'fieldOfStudy','Language':'name','Proficiency':'proficiency'})[label]]).toBe(value);
   await page.reload(); await expect(card).toContainText(value);
  }
  expect((await new AxeBuilder({page}).include('#v2-settings-profile').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.locator('[data-v2-route-outlet]').evaluate(el=>{el.scrollTop=0;}); await expect(panel.locator('.v2-settings-recovery')).toBeHidden(); const photo=await panel.locator('[data-profile-section=profile-photo] h2').boundingBox(),name=await panel.getByRole('heading',{name:'Name',exact:true}).boundingBox(); expect(Math.abs(photo.x-name.x)).toBeLessThan(1); await page.setViewportSize({width,height:width===390?2000:1400});await page.screenshot({path:info.outputPath('profile-view.png')});
 });
 test(`profile documents ${width}`,async({page},info)=>{
  await page.setViewportSize({width,height:1000}); const state=await installSettingsProjection(page,{user:{resumeURL:'',certificateURL:'',writingSampleURL:''}});
  await page.goto('/paralegal-v2.html#/settings?tab=profile'); for(const [key,label,endpoint] of [['resumeURL','Résumé','paralegal-resume'],['certificateURL','Certificate','paralegal-certificate'],['writingSampleURL','Writing sample','paralegal-writing-sample']]) { const lower=label.toLowerCase(); const row=page.locator(`[data-document-field="${key}"]`); await expect(row).toBeVisible();
  let uploads=0,failUpload=true;await page.route(`**/api/uploads/${endpoint}`,route=>{uploads++;if(failUpload)return json(route,{error:'Upload temporarily unavailable'},503);state.user[key]=`users/synthetic/new-${key}-${uploads}.pdf`;return json(route,{url:state.user[key]});});
  const choose=async()=>row.getByLabel(`Choose ${label} PDF`).setInputFiles({name:'sample.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic PDF')});
  await row.getByRole('button',{name:`Edit ${lower}`,exact:true}).click();
  await row.getByLabel(`Choose ${label} PDF`).setInputFiles({name:'not-a-pdf.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')});await expect(row).toContainText('must be a PDF');await row.screenshot({path:info.outputPath(`${key}-document-validation-error.png`)});
  await choose(); expect(uploads).toBe(0);
  await row.getByRole('button',{name:`Cancel ${lower} edit`,exact:true}).click(); expect(state.user[key]).toBe('');
  await row.getByRole('button',{name:`Edit ${lower}`,exact:true}).click(); await choose();await row.screenshot({path:info.outputPath(`${key}-document-selected.png`)});
  await row.getByRole('button',{name:`Save ${lower}`,exact:true}).click();await expect(row).toContainText('change was not confirmed');await row.screenshot({path:info.outputPath(`${key}-document-server-error.png`)});failUpload=false;await row.getByRole('button',{name:'Retry upload',exact:true}).click();await expect.poll(()=>uploads).toBe(2);await expect(row.getByRole('button',{name:`Open ${label}`,exact:true})).toBeVisible();
  const saved=state.user[key];await row.getByRole('button',{name:`Edit ${lower}`,exact:true}).click();await choose();await row.getByRole('button',{name:`Cancel ${lower} edit`,exact:true}).click();expect(state.user[key]).toBe(saved);await row.getByRole('button',{name:`Edit ${lower}`,exact:true}).click();await choose();await row.getByRole('button',{name:`Save ${lower}`,exact:true}).click();await expect.poll(()=>uploads).toBe(3);await page.reload();await expect(row.getByRole('button',{name:`Open ${label}`,exact:true})).toBeVisible();await row.getByRole('button',{name:`Edit ${lower}`,exact:true}).click();await row.getByRole('button',{name:`Remove ${label}`,exact:true}).click();await expect(row).toContainText('will be removed when you save');
  await row.getByRole('button',{name:`Cancel ${lower} edit`,exact:true}).click();expect(state.user[key]).toBeTruthy();
  await row.getByRole('button',{name:`Edit ${lower}`,exact:true}).click();await row.getByRole('button',{name:`Remove ${label}`,exact:true}).click();await row.getByRole('button',{name:`Save ${lower}`,exact:true}).click();await expect.poll(()=>state.user[key]).toBe('');
  await row.screenshot({path:info.outputPath(`${key}-document-view.png`)}); }
 });
 test(`profile photo ${width}`,async({page},info)=>{
  await page.setViewportSize({width,height:1000}); const state=await installSettingsProjection(page);
  await page.goto('/paralegal-v2.html#/settings?tab=profile');const panel=page.locator('#v2-settings-profile');
  const image=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=32;c.height=32;const x=c.getContext('2d');x.fillStyle='#6495ed';x.fillRect(0,0,32,32);return c.toDataURL('image/png').split(',')[1];}),'base64');
  const choose=()=>panel.getByLabel('Choose profile photo',{exact:true}).setInputFiles({name:'profile.png',mimeType:'image/png',buffer:image});
  await choose();const editor=panel.getByRole('region',{name:'Edit profile photo'});await expect(editor).toBeVisible();await expect(page.locator('dialog[open]')).toHaveCount(0);
  await editor.getByLabel('Photo zoom',{exact:true}).focus();await editor.getByLabel('Photo zoom',{exact:true}).press('ArrowRight');await editor.getByLabel('Profile photo crop area',{exact:true}).press('ArrowLeft');
  await editor.screenshot({path:info.outputPath('photo-editing.png')});await editor.getByRole('button',{name:'Cancel profile photo edit',exact:true}).click();await expect(editor).toHaveCount(0);await expect(panel.getByRole('button',{name:'Open profile photo actions',exact:true})).toBeFocused();
  let fail=true,uploads=0;await page.route('**/api/uploads/profile-photo',route=>{uploads++;if(fail)return json(route,{error:'Photo unavailable'},503);state.user.profilePhotoRevision='b'.repeat(64);state.user.profilePhotoStatus='pending_review';return json(route,{profilePhotoRevision:state.user.profilePhotoRevision,status:'pending_review'});});
  await choose();await editor.getByRole('button',{name:'Save profile photo',exact:true}).click();await expect(editor).toContainText('saved photo changed');await editor.screenshot({path:info.outputPath('photo-error.png')});fail=false;await editor.getByRole('button',{name:'Save profile photo',exact:true}).click();await expect(editor).toHaveCount(0);expect(uploads).toBe(2);await page.reload();expect(state.user.profilePhotoStatus).toBe('pending_review');await expect(panel).toContainText('photo is approved');await panel.getByRole('button',{name:'Open profile photo actions',exact:true}).click();await panel.getByRole('menuitem',{name:'Remove photo',exact:true}).click();await expect(page.locator('dialog[open]')).toHaveCount(0);await panel.getByRole('button',{name:'Cancel photo removal',exact:true}).press('Enter');expect(state.user.profileImage).toBeTruthy();
 });

 test(`education detail editors ${width}`,async({page},info)=>{
  await page.setViewportSize({width,height:1000});const options={rejectProfilePatches:false};const state=await installSettingsProjection(page,options);await page.goto('/paralegal-v2.html#/settings?tab=profile');const card=page.locator('[data-profile-section=education]');
  for(const [key,label,value] of [['grade','Grade','Honors'],['startMonth','Start month','Jan'],['startYear','Start year','2020'],['endMonth','End month','May'],['endYear','End year','2024'],['activities','Activities','Legal clinic']]){
   const add=card.getByLabel('Add detail to education entry 1',{exact:true});await add.selectOption(key);const control=card.getByLabel(label,{exact:true});const fill=()=>key.endsWith('Month')?control.selectOption(value):control.fill(value);
   await expect(card.locator('[data-entry-property]:visible')).toHaveCount(1);await fill();await card.screenshot({path:info.outputPath(`${key}-editing.png`)});await control.press('Escape');await expect(add).toBeFocused();expect(state.user.education[0][key]||'').toBe('');
   await add.selectOption(key);await fill();options.rejectProfilePatches=true;await card.getByRole('button',{name:'Save',exact:true}).click();await expect(card).toContainText('Profile save temporarily unavailable');await card.screenshot({path:info.outputPath(`${key}-error.png`)});options.rejectProfilePatches=false;await card.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>state.user.education[0][key]).toBe(value);await page.reload();await expect(card).toContainText(value);
  }
  await card.getByRole('button',{name:'Add education',exact:true}).click();await card.getByLabel('School',{exact:true}).last().fill('Draft school');await card.getByRole('button',{name:'Cancel',exact:true}).click();expect(state.user.education.length).toBe(1);
 });

}

for(const width of [1440,390]) test(`profile control geometry ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:1000});const state=await installSettingsProjection(page);await page.route('**/api/users/me',async route=>{if(route.request().method()==='PATCH')await new Promise(resolve=>setTimeout(resolve,350));await route.fallback();});await page.goto('/paralegal-v2.html#/settings?tab=profile');const panel=page.locator('#v2-settings-profile');
 let standardWidth;
 for(const [title,label] of [['residence','Residence'],['years of experience','Years of experience'],['education','School']]){
  const trigger=title==='education'?panel.getByRole('button',{name:'Edit school, education entry 1',exact:true}):panel.getByRole('button',{name:`Edit ${title}`,exact:true});await trigger.press('Enter');const control=panel.getByLabel(label,{exact:true}),active=panel.locator('.is-row-editing');const box=await control.boundingBox();standardWidth??=box.width;expect(Math.abs(box.width-standardWidth)).toBeLessThan(1);await active.screenshot({path:info.outputPath(`${title}-final-controls.png`)});await active.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 await panel.getByRole('button',{name:'Edit residence',exact:true}).press('Enter');const tabKey=info.project.name==='webkit'&&process.platform==='darwin'?'Alt+Tab':'Tab';await panel.getByLabel('Residence',{exact:true}).press(tabKey);await expect(panel.locator('.is-row-editing').getByRole('button',{name:'Save',exact:true})).toBeFocused();await page.keyboard.press(tabKey);await expect(panel.locator('.is-row-editing').getByRole('button',{name:'Cancel',exact:true})).toBeFocused();await page.keyboard.press('Enter');
 await panel.getByRole('button',{name:'Edit name',exact:true}).press('Enter');await panel.getByLabel('First name',{exact:true}).fill('Keyboard');const save=panel.locator('.is-row-editing').getByRole('button',{name:'Save',exact:true}),before=await save.boundingBox();await save.press('Enter');const busy=panel.getByRole('button',{name:'Saving…',exact:true});await expect(busy).toBeDisabled();const during=await busy.boundingBox();expect(during.width).toBe(before.width);expect(during.height).toBe(before.height);await panel.locator('.is-row-editing').screenshot({path:info.outputPath('saving-final-controls.png')});await expect(panel.locator('.is-row-editing')).toHaveCount(0);expect(state.user.firstName).toBe('Keyboard');await page.reload();await expect(panel.getByRole('button',{name:'Edit name',exact:true})).toContainText('Keyboard');await page.setViewportSize({width,height:width===390?2000:1400});await page.screenshot({path:info.outputPath('profile-final-whole.png')});
 expect(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});
