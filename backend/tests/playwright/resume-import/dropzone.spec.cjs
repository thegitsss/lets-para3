const {test,expect}=require('playwright/test');
const fs=require('node:fs'),path=require('node:path');
const AxeBuilder=require('@axe-core/playwright').default;
for(const width of [1280,390])test(`résumé drop zone supports keyboard browse, Word drops and safe validation ${width}`,async({page,request},info)=>{
 await request.post('/preview-reset',{data:{}});await page.setViewportSize({width,height:900});await page.goto('/');await page.getByRole('button',{name:'Use a different résumé',exact:true}).click();const d=page.getByRole('dialog'),zone=d.getByRole('button',{name:'Drop résumé or browse files',exact:true});
 await expect(zone).toContainText('Drop your résumé here');await expect(zone).toContainText('PDF or DOC, up to 10 MB.');await expect(d.getByLabel('Choose résumé')).toBeHidden();
 const chooserPromise=page.waitForEvent('filechooser');await zone.press('Enter');const chooser=await chooserPromise;await chooser.setFiles({name:'bad.rtf',mimeType:'application/rtf',buffer:Buffer.from('invalid')});await expect(d.getByRole('button',{name:'Read this résumé'})).toBeDisabled();await expect(d.getByRole('status')).toContainText('Choose one PDF or DOC');
 await d.screenshot({path:info.outputPath('drop-zone.png')});
 for(const extension of ['doc','docx']){
  const bytes=fs.readFileSync(path.join(__dirname,'../../fixtures/resume-import',`synthetic.${extension}`));
  const transfer=await page.evaluateHandle(({bytes,extension})=>{const dt=new DataTransfer();dt.items.add(new File([new Uint8Array(bytes)],`synthetic.${extension}`,{type:extension==='doc'?'application/msword':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));return dt;},{bytes:[...bytes],extension});
  await d.locator('.ri-dropzone').dispatchEvent('dragenter',{dataTransfer:transfer});await expect(d.locator('.ri-dropzone')).toHaveClass(/is-dragging/);await d.locator('.ri-dropzone').dispatchEvent('drop',{dataTransfer:transfer});await transfer.dispose();await expect(d.locator('.ri-dropzone')).not.toHaveClass(/is-dragging/);await expect(d.locator('.ri-dropzone')).toContainText(`synthetic.${extension}`);
  expect(await d.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);expect((await new AxeBuilder({page}).include('.ri-dialog').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
  await d.getByRole('button',{name:'Read this résumé'}).click();await expect(d).toContainText('A head start. Your final say.');await expect(d.getByLabel('Role / employer',{exact:true}).first()).toHaveValue('Paralegal | Example Legal');
  await d.getByRole('button',{name:'Cancel',exact:true}).click();expect((await (await request.get('/preview-state')).json()).counts.patches).toBe(0);
  await page.getByRole('button',{name:'Fill from résumé',exact:true}).click();await page.getByRole('button',{name:'Use a different résumé',exact:true}).click();
 }
 await d.getByLabel('Choose résumé').setInputFiles({name:'too-large.doc',mimeType:'application/msword',buffer:Buffer.alloc(10*1024*1024+1)});await expect(d.getByRole('button',{name:'Read this résumé'})).toBeDisabled();
});
