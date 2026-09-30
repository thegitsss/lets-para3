const {test}=require('../assistant-completion/shell-fixture');
const {fixture:shell,json,OWNER}=require('../assistant-completion/fixture');
const {expect}=require('playwright/test');
const {inventoryFixture}=require('./inventory-fixture');
const ID='64b000000000000000000011';
test('Matter context menu opens an inline preview once with pointer and keyboard', async({page},info)=>{
 const data={active:[{id:ID,title:'Preview regression',status:'open',archived:false,paymentReleased:false,applicantsCount:0,filesCount:0,files:[],practiceArea:'Litigation',totalAmount:40000,remainingAmount:40000,currency:'usd',updatedAt:'2026-09-01T12:00:00Z'}],archived:[],drafts:{items:[]},applications:[],summary:{items:[]}};
 await shell(page,'attorney',{hash:'/matters',setup:async()=>{
  await page.route('**/api/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/api/auth/workspace-release')return json(route,{workspace:{schemaVersion:1,ownerId:OWNER,role:'attorney',revision:1,version:'v2',defaultDestination:'/attorney-v2.html#/home'}});
   if(url.pathname==='/api/cases/inventory')return json(route,await inventoryFixture(data,OWNER,url.searchParams));
   if(url.pathname==='/api/applications/my-postings')return json(route,[]);
   if(url.pathname==='/api/messages/summary')return json(route,{items:[]});
   return route.fallback();
  });
 }});
 await expect(page.locator('[data-av2-region="matter-list"]')).toHaveAttribute('data-state','ready');
 const row=page.locator('[data-av2-matter]'), preview=row.locator('.av2-matter-inline-preview'), menu=row.locator('.av2-matter-menu > summary');
 await page.evaluate(()=>{
  window.previewEvents=[];
  for(const type of ['mousedown','mouseup','click','focusin','toggle'])document.addEventListener(type,event=>{
   window.previewEvents.push({type,target:event.target.outerHTML?.slice(0,160),open:document.querySelector('.av2-matter-inline-preview')?.open});
  },true);
 });
 try{
  await menu.click();await row.getByRole('button',{name:'Preview matter',exact:true}).click();
  await expect(preview).toHaveAttribute('open','');await expect(preview).toBeFocused();
  await preview.locator('summary').click();await expect(preview).not.toHaveAttribute('open','');
  await menu.focus();await page.keyboard.press('Enter');
  await row.getByRole('button',{name:'Preview matter',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(preview).toHaveAttribute('open','');await expect(preview).toBeFocused();
  await menu.click();await page.getByRole('searchbox',{name:'Search matters',exact:true}).focus();
  await expect(row.locator('.av2-matter-menu')).not.toHaveAttribute('open','');
  await menu.click();await page.getByRole('heading',{name:'Matters',exact:true}).click();
  await expect(row.locator('.av2-matter-menu')).not.toHaveAttribute('open','');
 }finally{await info.attach('preview-events',{body:JSON.stringify(await page.evaluate(()=>window.previewEvents),null,2),contentType:'application/json'});}
});
