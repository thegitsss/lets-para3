const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {fixture,json}=require('./alignment-fixture');
const CASE='64b000000000000000055001',JOB='64b000000000000000055002';
test('rebuilt Find Work rows preserve full posting access and the canonical application target',async({page},info)=>{
 const listing={_id:CASE,caseId:CASE,jobId:JOB,title:'Trial chronology',practiceArea:'Litigation',state:'New York',totalAmount:80000,deadlineDate:'2026-10-01',createdAt:'2026-09-07',briefSummary:'Organize the medical records and prepare a source-linked chronology.',tasks:[{title:'Prepare chronology',completed:false}],attorney:{firstName:'Jordan',lastName:'Lee'}};
 const state=await fixture(page,{recommendations:{hasMatchingProfile:true,items:[listing]}});
 const writes=[];
 await page.route(`**/api/jobs/${JOB}/apply`,async route=>{writes.push(route.request().postDataJSON());state.recommendations.items[0].appliedAt='2026-09-08';await json(route,{success:true});});
 await page.goto('/paralegal-v2.html#/browse');
 const card=page.locator('.v2-browse-card');await expect(card).toHaveCount(1);
 await expect(card.getByRole('link',{name:'Details',exact:true})).toHaveCount(0);
 for(const width of [1440,390]) {
  await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`browse-${width}.png`),fullPage:true});
 }
 await page.setViewportSize({width:1440,height:1000});
 await card.getByRole('link',{name:'Trial chronology',exact:true}).click();
 await expect(page.getByRole('heading',{level:1,name:'Trial chronology',exact:true})).toBeVisible();
 await expect(page.getByText('Prepare chronology',{exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('posting-detail.png'),fullPage:true});
 await page.getByRole('link',{name:'Back to Browse Matters',exact:true}).click();
 await expect(card.getByRole('link',{name:'Trial chronology',exact:true})).toBeFocused();
 await card.getByRole('button',{name:'Apply',exact:true}).click();
 const letter=page.getByRole('dialog').getByRole('textbox');
 await letter.fill('I can prepare the chronology and source references.');
 expect(writes).toEqual([]);
 await page.getByRole('button',{name:'Submit application',exact:true}).click();
 await expect.poll(()=>writes.length).toBe(1);
 expect(writes[0]).toEqual({coverLetter:'I can prepare the chronology and source references.'});
 expect(page.__homeErrors).toEqual([]);
});
