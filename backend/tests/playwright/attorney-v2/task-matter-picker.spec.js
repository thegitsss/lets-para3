const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {fixture:shell,json,OWNER}=require('../assistant-completion/fixture');
const AxeBuilder=require('@axe-core/playwright').default;
const id=n=>n.toString(16).padStart(24,'0');
const choice=(n,extra={})=>({id:id(n),title:`Matter ${String(n).padStart(3,'0')}`,status:'open',archived:false,practiceArea:'Litigation',...extra});
async function install(page,options={}){
 const data={items:Array.from({length:23},(_,i)=>choice(i+1)),queries:[],tasks:[],writes:[],fail:false,delay:null,...options};
 await shell(page,'attorney',{hash:'/tasks',setup:async()=>{
  await page.route('**/api/cases/inventory/choices?**',async route=>{
   const q=new URL(route.request().url()).searchParams,search=q.get('q')||'',number=Number(q.get('page')||1),selectedId=q.get('selectedId')||'';
   data.queries.push({search,page:number,selectedId,owner:q.get('expectedOwnerId')});
   if(data.delay&&search==='old'){const hold=data.delay;await hold;}
   if(data.fail)return json(route,{},503);
   const items=data.items.filter(item=>item.title.toLowerCase().includes(search.toLowerCase()));
   return json(route,{ownerId:OWNER,revision:'a'.repeat(64),filters:{search,page:number,selectedId},total:items.length,page:number,pages:Math.max(1,Math.ceil(items.length/10)),pageSize:10,items:items.slice((number-1)*10,number*10),selected:data.items.find(item=>item.id===selectedId)||null});
  });
  await page.route('**/api/users/me/weekly-notes**',route=>json(route,{weekStart:new URL(route.request().url()).searchParams.get('weekStart'),notes:Array(7).fill(''),revision:'a'.repeat(64),updatedAt:null}));
  await page.route('**/api/checklist**',route=>{
   const req=route.request(),q=new URL(req.url()).searchParams;
   if(req.method()==='POST'){const body=req.postDataJSON();data.writes.push(body);if(data.rejectMissing&&body.caseId&&!data.items.some(item=>item.id===body.caseId))return json(route,{error:'Case not found'},404);const task={...body,id:id(1000+data.tasks.length),done:false};data.tasks.push(task);return json(route,{id:task.id},201);}
   const items=data.tasks.filter(task=>!q.get('caseId')||task.caseId===q.get('caseId'));
   return json(route,{items,total:items.length,page:1,limit:20,pages:items.length?1:0});
  });
 }});
 await expect(page.locator('[data-av2-region="private-tasks"]')).toHaveAttribute('data-state','ready');
 await page.getByText('New private task',{exact:true}).click();
 const form=page.getByRole('form',{name:'New private task'}),opener=()=>form.getByRole('button',{name:/^Matter \(optional\)/});
 return {data,form,opener,dialog:()=>page.getByRole('dialog',{name:'Choose a Matter',exact:true})};
}

test('picker pages through all choices, selects an older archived Matter and creates then filters a private task without losing text',async({page})=>{
 const x=await install(page,{items:[...Array.from({length:22},(_,n)=>choice(n+1)),choice(300,{title:'Older archived (estate) [NY]',status:'completed',archived:true})]});
 await x.form.getByLabel('Task title',{exact:true}).fill('Prepare private chronology');await x.form.getByLabel('Private details (optional)',{exact:true}).fill('Keep this confidential planning text.');
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await expect(x.dialog().getByLabel('Search Matters',{exact:true})).toBeFocused();
 await x.dialog().getByRole('button',{name:'Next Matters',exact:true}).click();await expect(x.dialog()).toContainText('Page 2 of 3');await expect(x.dialog().getByRole('status')).toBeFocused();
 await x.dialog().getByRole('button',{name:'Next Matters',exact:true}).click();await expect(x.dialog()).toContainText('Page 3 of 3');
 await x.dialog().getByRole('button',{name:'Older archived (estate) [NY] Completed · Litigation',exact:true}).click();await expect(x.dialog()).toBeHidden();await expect(x.opener()).toBeFocused();await expect(x.opener()).toContainText('Older archived (estate) [NY]');
 await expect(x.form.getByLabel('Private details (optional)',{exact:true})).toHaveValue('Keep this confidential planning text.');
 await x.form.getByRole('button',{name:'Create private task',exact:true}).click();await expect(page.locator('[data-av2-region="private-tasks"]')).toContainText('Prepare private chronology');expect(x.data.writes).toEqual([expect.objectContaining({title:'Prepare private chronology',caseId:id(300),notes:'Keep this confidential planning text.'})]);await expect(x.opener()).toContainText('No Matter');
 const filter=page.getByRole('button',{name:/^Filter by Matter/});await filter.click();await x.dialog().getByLabel('Search Matters',{exact:true}).fill('(estate) [NY]');await expect(x.dialog()).toHaveAttribute('data-state','ready');await x.dialog().getByRole('button',{name:'Older archived (estate) [NY] Completed · Litigation',exact:true}).click();await page.getByRole('button',{name:'Apply task filters'}).click();await expect(page).toHaveURL(new RegExp(`caseId=${id(300)}`));await expect(page.getByRole('button',{name:/^Filter by Matter/})).toContainText('Older archived (estate) [NY]');await expect(page.locator('[data-av2-region="private-tasks"]')).toContainText('Prepare private chronology');
 expect(x.data.queries.every(q=>q.owner===OWNER)).toBe(true);
});

test('search failures and empty results preserve the selected Matter and task draft until explicitly cleared',async({page})=>{
 const x=await install(page);await x.form.getByLabel('Task title',{exact:true}).fill('Unsaved work');await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await x.dialog().getByRole('button',{name:'Matter 001 Posted · Litigation',exact:true}).click();
 x.data.fail=true;await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','error');await expect(x.dialog()).not.toContainText('No Matters');await expect(x.dialog().locator('.av2-matter-choice')).toHaveCount(0);
 await x.dialog().getByRole('button',{name:'Close',exact:true}).click();await expect(x.opener()).toContainText('Matter 001');await expect(x.form.getByLabel('Task title',{exact:true})).toHaveValue('Unsaved work');
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','error');x.data.fail=false;await x.dialog().getByRole('button',{name:'Retry search'}).click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await expect(x.dialog().getByRole('status')).toBeFocused();
 await x.dialog().getByLabel('Search Matters',{exact:true}).fill('No matching name');await expect(x.dialog()).toHaveAttribute('data-state','ready');await expect(x.dialog()).toContainText('No Matters match this search.');await x.dialog().getByRole('button',{name:'Close',exact:true}).click();await expect(x.opener()).toContainText('Matter 001');
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await x.dialog().getByRole('button',{name:'No Matter',exact:true}).click();await expect(x.opener()).toContainText('No Matter');expect(x.data.writes).toEqual([]);
});

test('native modal keyboard wrap, escape, backdrop and navigation cleanup restore focus without submitting the task form',async({page})=>{
 const x=await install(page);await x.form.getByLabel('Task title',{exact:true}).fill('Keep task');await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');
 await x.dialog().getByRole('button',{name:'Close',exact:true}).focus();await page.keyboard.press('Shift+Tab');await expect(x.dialog().getByRole('button',{name:'No Matter',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(x.dialog().getByRole('button',{name:'Close',exact:true})).toBeFocused();
 await x.dialog().getByLabel('Search Matters',{exact:true}).fill('Matter 001');await page.keyboard.press('Enter');await expect(x.dialog()).toHaveAttribute('data-state','ready');expect(x.data.writes).toEqual([]);await page.keyboard.press('Escape');await expect(x.dialog()).toBeHidden();await expect(x.opener()).toBeFocused();
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await page.mouse.click(2,2);await expect(x.dialog()).toBeHidden();await expect(x.opener()).toBeFocused();
 await x.opener().click();await page.evaluate(()=>location.hash='#/home');await expect(page.locator('.av2-matter-choice-dialog')).toHaveCount(0);expect(x.data.writes).toEqual([]);
});

test('superseded search cannot replace newer results or choose a stale Matter',async({page})=>{
 let release;const delayed=new Promise(resolve=>release=resolve);const x=await install(page,{items:[choice(1,{title:'Old Matter'}),choice(2,{title:'New Matter'})],delay:delayed});
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await x.dialog().getByLabel('Search Matters',{exact:true}).fill('old');await expect.poll(()=>x.data.queries.some(q=>q.search==='old')).toBe(true);
 await x.dialog().getByLabel('Search Matters',{exact:true}).fill('new');await expect(x.dialog()).toHaveAttribute('data-state','ready');release();await expect(x.dialog().locator('.av2-matter-choice')).toHaveCount(1);await expect(x.dialog().locator('.av2-matter-choice')).toContainText('New Matter');await expect(x.dialog()).not.toContainText('Old Matter');
});

test('long titles and controls remain readable and reachable across both themes, phone widths and enlarged text',async({page},info)=>{
 const x=await install(page,{items:[choice(1,{title:'Multijurisdictional estate administration and document review — Amélie’s inherited Matter '.repeat(3)})]});
 for(const theme of ['light','dark'])for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:960});await page.evaluate(({theme,width})=>{document.documentElement.style.fontSize=width===320?'200%':'';for(const element of [document.documentElement,document.body]){element.classList.remove('theme-light','theme-dark');element.classList.add('theme-'+theme);}}, {theme,width});
  await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await expect(x.dialog().getByLabel('Search Matters',{exact:true})).toBeFocused();
  expect(await x.dialog().evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);expect((await new AxeBuilder({page}).include('.av2-matter-choice-dialog').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:info.outputPath(`picker-${theme}-${width}.png`)});await x.dialog().locator('.av2-matter-choice').click();await expect(x.opener()).toBeFocused();expect(await page.locator('.av2-main').evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await page.screenshot({path:info.outputPath(`selected-${theme}-${width}.png`)});
 }
 expect(x.data.writes).toEqual([]);
});


test('a removed selected Matter stays explicit and creation recovers only after the user clears its link',async({page})=>{
 const x=await install(page,{rejectMissing:true});await x.form.getByLabel('Task title',{exact:true}).fill('Keep this private draft');await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await x.dialog().getByRole('button',{name:'Matter 001 Posted · Litigation',exact:true}).click();
 x.data.items=[];await x.form.getByRole('button',{name:'Create private task',exact:true}).click();await expect(x.form).toContainText('The linked Matter is unavailable. Choose another Matter or remove the link.');await expect(x.form).not.toContainText('This task is no longer available');await expect(x.form.getByLabel('Task title',{exact:true})).toHaveValue('Keep this private draft');expect(x.data.tasks).toHaveLength(0);expect(x.data.writes).toHaveLength(1);
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await expect(x.dialog()).toContainText('No Matters to choose from.');await x.dialog().getByRole('button',{name:'Close',exact:true}).click();await expect(x.form).toContainText('The selected Matter is unavailable. Choose another or remove the link.');
 await x.opener().click();await expect(x.dialog()).toHaveAttribute('data-state','ready');await x.dialog().getByRole('button',{name:'No Matter',exact:true}).click();await x.form.getByRole('button',{name:'Create private task',exact:true}).click();await expect(page.locator('[data-av2-region="private-tasks"]')).toContainText('Keep this private draft');expect(x.data.tasks).toHaveLength(1);expect(x.data.tasks[0].caseId).toBeNull();expect(x.data.writes).toHaveLength(2);
});
