const {test,expect,setup,OTHER}=require('./fixture');
const AxeBuilder=require('@axe-core/playwright').default;
const recovery=page=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('lpc_attorney_card_setup_v1')));
async function entry(page,panel){await panel.getByRole('button',{name:'Add a payment card',exact:true}).click();await page.getByLabel('Synthetic provider card entry').fill('4242');await panel.getByRole('button',{name:'Verify card',exact:true}).click();await expect(panel).toHaveAttribute('data-state','ready');}
test('a verified card survives reload as a reference, appears once after saving, and never causes another setup or default write',async({page})=>{
 const {state,panel}=await setup(page,{saved:false});await entry(page,panel);expect(await recovery(page)).toMatchObject({intentId:'seti_synthetic'});expect(JSON.stringify(await recovery(page))).not.toMatch(/secret|4242|visa/);
 await page.reload();await expect(panel).toHaveAttribute('data-state','ready');await expect(panel.getByRole('button',{name:'Set this card as default',exact:true})).toBeVisible();expect(state.starts).toHaveLength(1);expect(state.saves).toHaveLength(0);
 await panel.getByRole('button',{name:'Set this card as default',exact:true}).click();await expect(panel).toHaveAttribute('data-state','ready');await expect(panel.getByText(/ending in 4242/)).toHaveCount(1);expect(await recovery(page)).toBeNull();expect(state.saves).toHaveLength(1);
 await page.reload();await expect(panel).toHaveAttribute('data-state','ready');await expect(panel.getByText(/ending in 4242/)).toHaveCount(1);expect(state.starts).toHaveLength(1);expect(state.saves).toHaveLength(1);
});
test('a setup with an unknown start response retries the same request after reload and an explicit record check',async({page})=>{
 const {state,panel}=await setup(page,{saved:false});state.startRespond=route=>route.abort('failed');await panel.getByRole('button',{name:'Add a payment card',exact:true}).click();await expect(panel).toHaveAttribute('data-state','uncertain');expect(await recovery(page)).toMatchObject({requestId:state.starts[0].key,pending:true});
 page.on('dialog',dialog=>dialog.accept());await page.reload();await expect(panel).toHaveAttribute('data-state','ready');state.startRespond=null;await panel.getByRole('button',{name:'Add a payment card',exact:true}).click();await expect(panel).toHaveAttribute('data-state','entry');expect(state.starts).toHaveLength(2);expect(state.starts[1].key).toBe(state.starts[0].key);
});
test('closed authentication has one explicit new-setup action and stale provider callbacks cannot change a replacement form',async({page})=>{
 const {state,panel}=await setup(page,{saved:false});state.status='requires_action';await panel.getByRole('button',{name:'Add a payment card',exact:true}).click();await panel.getByRole('button',{name:'Close card form',exact:true}).click();await expect(panel).toHaveAttribute('data-state','ready');await expect(panel.getByRole('button',{name:'Add a payment card',exact:true})).toBeHidden();
 await panel.getByRole('button',{name:'Start a new card setup',exact:true}).click();const verify=panel.getByRole('button',{name:'Verify card',exact:true});await expect(verify).toBeDisabled();
 await page.evaluate(()=>{const old=window.syntheticCards.entries[0];old.events.change({complete:true,empty:false});old.events.ready();old.events.loaderror();});await expect(panel).toHaveAttribute('data-state','entry');await expect(verify).toBeDisabled();await page.getByLabel('Synthetic provider card entry').fill('4242');await expect(verify).toBeEnabled();expect(state.starts).toHaveLength(2);
});
test('another account cannot adopt a saved card setup reference',async({page})=>{
 const {state,panel}=await setup(page,{saved:false});await entry(page,panel);state.account.user={...state.account.user,id:OTHER,_id:OTHER};await panel.getByRole('button',{name:'Check saved card and setup',exact:true}).click();await expect(page).toHaveURL(/\/login.html/);expect(await recovery(page)).toBeNull();expect(state.saves).toHaveLength(0);
});
test('signing out from a different page clears recovery even when setup was not mounted after reload',async({page})=>{
 const {panel}=await setup(page,{saved:false});await entry(page,panel);await page.goto('/attorney-v2.html#/home');expect(await recovery(page)).toMatchObject({intentId:'seti_synthetic'});await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page).toHaveURL(/\/login.html/);expect(await recovery(page)).toBeNull();
});
for(const theme of ['light','dark'])test(`setup ${theme} has one verified-card choice and responsive accessible controls`,async({page},info)=>{
 const {state,panel}=await setup(page,{saved:false,theme});await entry(page,panel);await expect(page.locator('[data-hiring-return]')).toBeHidden();expect(await page.evaluate(()=>window.syntheticCards.appearances[0].theme)).toBe(theme==='dark'?'night':'stripe');
 for(const width of [320,390,1440]){await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.documentElement.style.fontSize='20px');await panel.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await expect(panel.getByText(/ending in 4242/)).toHaveCount(1);for(const control of await panel.locator('button:visible,a:visible').all())expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(43.5);
 const result=await new AxeBuilder({page}).include('[data-payment-setup]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(result.violations).toEqual([]);await page.evaluate(()=>{for(const el of document.querySelectorAll('*'))if(el.scrollTop)el.scrollTop=0;});await page.screenshot({path:info.outputPath(`setup-${theme}-${width}.png`),fullPage:true});}
 await panel.getByRole('button',{name:'Use a different card',exact:true}).click();await expect(panel).toHaveAttribute('data-state','entry');expect(state.saves).toHaveLength(0);expect(state.starts).toHaveLength(2);
});
