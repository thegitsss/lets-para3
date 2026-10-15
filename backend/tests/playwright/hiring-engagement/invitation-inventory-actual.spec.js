'use strict';
const {test,expect,getServer}=require('./hiring-session-fixture.cjs');
const AxeBuilder=require('@axe-core/playwright').default,fs=require('node:fs');
const panel=page=>page.locator('[data-matter-invitations]'),ready=page=>expect(panel(page)).toHaveAttribute('data-state','ready'),rows=page=>panel(page).locator('.matter-invitation');
let MATTER,OWNER;
const dataSet=()=>Array.from({length:107},(_,i)=>({paralegal:{id:(i+1).toString(16).padStart(24,'0'),name:`Paralegal ${String(i+1).padStart(3,'0')}`,available:true,profileImage:null},status:i%5?'pending':'accepted',invitedAt:new Date(Date.UTC(2026,0,i+1)).toISOString(),respondedAt:null}));
async function install(page,hash){
 const server=getServer(),mongoose=require('mongoose'),User=require('../../../models/User'),Case=require('../../../models/Case'),state={items:dataSet(),status:200,complete:true,errors:[]};OWNER=page.hiringActor.id;
 const csrf=await(await page.request.get('/api/csrf')).json(),headers={'X-CSRF-Token':csrf.csrfToken};
 const draft=await page.request.post('/api/case-drafts',{headers,data:{expectedOwnerId:OWNER,title:'Contract review invitations',practiceArea:'Contract Law',state:'New York',compAmount:'400.01',experience:'3+ years',deadline:'2027-03-14',description:'Synthetic actual invitation inventory.',tasks:[{title:'Prepare agreement'}]}});expect(draft.ok(),await draft.text()).toBe(true);const saved=(await draft.json()).draft;
 const publication=await page.request.post('/api/cases/posting/publications',{headers,data:{expectedOwnerId:OWNER,draftId:saved.id,revision:saved.revision,requestId:require('crypto').randomUUID(),practiceArea:'contract law'}});expect(publication.ok(),await publication.text()).toBe(true);MATTER=(await publication.json()).publication.caseId;
 await User.collection.insertMany(state.items.map(item=>({_id:new mongoose.Types.ObjectId(item.paralegal.id),firstName:'Paralegal',lastName:item.paralegal.name.split(' ').at(-1),email:item.paralegal.id+'@example.test',role:'paralegal',status:'approved',disabled:false,deleted:false,emailVerified:true,preferences:{theme:'light',fontSize:'md'}})));
 const sync=async()=>{for(const item of state.items)await User.collection.updateOne({_id:new mongoose.Types.ObjectId(item.paralegal.id)},{$set:{firstName:item.paralegal.name,lastName:'',disabled:!item.paralegal.available}});await Case.collection.updateOne({_id:new mongoose.Types.ObjectId(MATTER)},{$set:{pendingParalegalId:null,pendingParalegalInvitedAt:null,invites:[...state.items.map(item=>({paralegalId:new mongoose.Types.ObjectId(item.paralegal.id),status:item.status,invitedAt:new Date(item.invitedAt),respondedAt:item.respondedAt})),...(state.complete?[]:[{paralegalId:'invalid-fixture-record'}])]}});};
 await sync();page.on('pageerror',error=>state.errors.push(error.message));await page.route(`**/api/cases/${MATTER}/invites?**`,async route=>{if(state.status!==200)return route.fulfill({status:state.status,contentType:'application/json',body:JSON.stringify({error:'Synthetic invitation read unavailable.'})});await sync();return route.continue();});
 const suffix=hash?.includes('?')?'?'+hash.split('?')[1]:'';await page.goto(`/attorney-v2.html#/matters/${MATTER}/invitations${suffix}`);await ready(page);return state;
}

test("all invitation pages and status counts remain reachable and profile return retains page and filters",async({page})=>{
 const state=await install(page,`/matters/${MATTER}/invitations?invPage=5`);
 await expect(rows(page)).toHaveCount(7);await expect(panel(page)).toContainText('101–107 of 107 invitations');await expect(rows(page).last()).toContainText('Paralegal 001');
 await page.reload();await ready(page);await page.reload();await ready(page);await expect(rows(page)).toHaveCount(7);
 const href=await rows(page).last().getByRole('link').getAttribute('href');expect(new URLSearchParams(href.split('?')[1]).get('returnTo')).toContain('invPage=5');await rows(page).last().getByRole('link').click();await page.getByRole('link',{name:'← Back to invitations',exact:true}).click();await ready(page);await expect(rows(page)).toHaveCount(7);
 await openFilters(page);await panel(page).getByRole('combobox',{name:'Status',exact:true}).selectOption('accepted');await ready(page);await openFilters(page);await panel(page).getByRole('combobox',{name:'Sort',exact:true}).selectOption('oldest');await ready(page);await panel(page).getByRole('button',{name:'Search',exact:true}).click();await ready(page);await expect(rows(page)).toHaveCount(22);await expect(rows(page).first()).toContainText('Paralegal 001');
 await page.reload();await ready(page);await openFilters(page);await expect(panel(page).getByRole('combobox',{name:'Status',exact:true})).toHaveValue('accepted');await expect(panel(page)).toContainText('does not confirm a hire');
 expect(state.errors).toEqual([]);
});

test("failed changed empty and filtered invitation reads remove old records and recover without stale counts",async({page})=>{
 const state=await install(page);state.status=503;await page.reload();await expect(panel(page)).toHaveAttribute('data-state','error');await expect(rows(page)).toHaveCount(0);await expect(panel(page)).not.toContainText('of 107');
 state.status=200;await panel(page).getByRole('button',{name:'Search',exact:true}).click();await ready(page);await expect(rows(page)).toHaveCount(25);
 await panel(page).getByRole('searchbox').fill('No matching name');await panel(page).getByRole('button',{name:'Search',exact:true}).click();await ready(page);await expect(panel(page).getByText('No invitations match these filters.',{exact:true})).toHaveCount(1);
 await openFilters(page);await panel(page).getByRole('button',{name:'Clear filters'}).click();await ready(page);state.items=[];state.complete=false;await page.reload();await ready(page);await expect(panel(page)).toContainText('No readable invitations');await expect(panel(page)).not.toContainText('No invited paralegals yet');
 state.complete=true;await page.reload();await ready(page);await expect(panel(page).getByText('No invited paralegals yet.',{exact:true})).toHaveCount(1);
});

test("invitation controls and long identities remain contained accessible and usable across themes and large text",async({page},testInfo)=>{
 const state=await install(page);state.items[106].paralegal.name='A long invited paralegal name with multiple professional credentials';state.items[106].paralegal.available=false;state.items[105].paralegal.name='A long invited paralegal name with multiple professional credentials';
 await page.reload();await ready(page);await expect(rows(page).filter({hasText:'A long invited paralegal name with multiple professional credentials'})).toHaveCount(1);await expect(panel(page)).toContainText('Profile unavailable');const scans=[];
 for(const theme of ['light','dark'])for(const width of [320,390,1366]){
  await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.classList.toggle('theme-dark',theme==='dark'),theme);await page.locator('main').evaluate(node=>{node.scrollTop=0;});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await openFilters(page);for(const control of await panel(page).locator('form input:visible,form select:visible,form button:visible,form summary:visible').all())expect(Math.round((await control.boundingBox()).height * 1000) / 1000).toBeGreaterThanOrEqual(44);
  const result=await new AxeBuilder({page}).include('[data-matter-invitations]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(result.violations).toEqual([]);scans.push({theme,width,violations:result.violations});await page.screenshot({path:testInfo.outputPath(`invitations-${theme}-${width}.png`)});
 }
 await page.setViewportSize({width:390,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='200%');await panel(page).getByRole('button',{name:'Search',exact:true}).focus();await page.keyboard.press('Enter');await ready(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await rows(page).first().scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('invitations-large-text.png')});
 fs.writeFileSync(testInfo.outputPath('accessibility.json'),JSON.stringify(scans,null,2));fs.writeFileSync(testInfo.outputPath('browser-errors.json'),JSON.stringify(state.errors));expect(state.errors).toEqual([]);
});

test("removed invitation pages return to the first available page and pending rows avoid redundant response text",async({page})=>{
 const state=await install(page,`/matters/${MATTER}/invitations?invPage=5`);state.items=state.items.filter(item=>item.status==='pending').slice(0,3);
 await page.reload();await ready(page);await expect(rows(page)).toHaveCount(0);await expect(panel(page)).toContainText('This page no longer has invitations');
 await panel(page).getByRole('button',{name:'Return to first page'}).click();await ready(page);await expect(rows(page)).toHaveCount(3);await expect(panel(page)).not.toContainText('No response date');await expect(panel(page)).not.toContainText('does not confirm a hire');
});

async function openFilters(page){const detail=panel(page).locator('details.av2-filter-disclosure');if(!await detail.evaluate(node=>node.open))await detail.locator(':scope > summary').click();}
