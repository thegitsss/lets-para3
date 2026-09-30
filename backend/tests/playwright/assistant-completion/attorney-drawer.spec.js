const {test}=require('./shell-fixture');
const {expect}=require('playwright/test');
const {prepare,ui}=require('./visual-fixture');
for(const width of [1440,1024,390])test(`Attorney Assistant stays open while browsing at ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});
 const {open}=await prepare(page,'attorney',{hash:'/home'});await open();
 await expect(ui(page).drawer).toHaveAttribute('aria-modal','false');
 await ui(page).composer.fill('Keep these notes');
 await page.getByRole('button',{name:'Search your workspace',exact:true}).click();
 await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');
 await page.keyboard.press('Escape');await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');
 await page.locator('[data-av2-open="notifications"]').click();await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');
 await page.keyboard.press('Escape');
 if(width<=900){await page.getByRole('button',{name:'Minimize Assistant',exact:true}).click();await expect(ui(page).drawer).toHaveAttribute('aria-hidden','true');await page.getByRole('button',{name:'Resume LPC Assistant',exact:true}).click();await expect(ui(page).composer).toHaveValue('Keep these notes');}

 if(width>900){
  const alignment=await page.evaluate(()=>{const a=document.querySelector('.av2-header').getBoundingClientRect(),b=document.querySelector('.support-drawer-header').getBoundingClientRect();return {top:Math.abs(a.top-b.top),bottom:Math.abs(a.bottom-b.bottom)};});
  expect(alignment.top).toBeLessThan(2);expect(alignment.bottom).toBeLessThan(2);
 }else await page.locator('[data-av2-nav-toggle]').click();
 await page.locator('[data-av2-route="matters"]').click();
 await expect(page).toHaveURL(/#\/matters/);await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');await expect(ui(page).composer).toHaveValue('Keep these notes');
 await page.screenshot({path:info.outputPath('assistant.png')});
});

test('Enlarged mobile Assistant stays below the reflowed header',async({page})=>{
 await page.setViewportSize({width:320,height:900});const {open}=await prepare(page,'attorney',{hash:'/home'});
 await page.evaluate(()=>document.documentElement.style.fontSize='200%');await open();
 await expect.poll(()=>page.evaluate(()=>Math.abs(document.querySelector('.av2-header').getBoundingClientRect().bottom-document.querySelector('#supportDrawer').getBoundingClientRect().top))).toBeLessThan(2);
 await expect(page.getByRole('button',{name:'Minimize Assistant',exact:true})).toBeInViewport();
});
