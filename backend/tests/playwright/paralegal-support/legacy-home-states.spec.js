const { test, expect } = require('../payment-summary/legacy-fixture');
const AxeBuilder = require('@axe-core/playwright').default;
const { install, OWNER, MATTER, id } = require('./legacy-home-fixture');
const inbox = page => page.locator('[data-paralegal-priority-list]');
const ready = page => expect(inbox(page)).toHaveAttribute('data-state','ready');
const application = (n, extra = {}) => ({ _id:id(1000+n), paralegalId:OWNER, status:'shortlisted', createdAt:'2026-09-01T12:00:00Z', jobId:{ _id:id(2000+n), caseId:id(3000+n), title:`Application ${n} — Supplemental records review`, status:'open', practiceArea:'Civil Litigation' }, ...extra });
function many(state) {
  state.summaries = Array.from({length:53},(_,n)=>({caseId:id(4000+n),title:`Conversation ${n+1} — Supplemental production review`,unread:1}));
  state.invites = Array.from({length:9},(_,n)=>({_id:id(5000+n),caseId:id(5000+n),title:`Invitation ${n+1}`,inviteStatus:'pending',inviteInvitedAt:'2026-09-07T12:00:00Z'}));
  state.applications = Array.from({length:6},(_,n)=>application(n,{preEngagement:{status:'requested',revision:1,requestedParalegalId:OWNER,confidentialityAgreementRequired:true}}));
  for(let n=0;n<7;n++){const caseId=id(6000+n);state.matters.push({...state.matter,caseId,title:`Revision Matter ${n+1}`});state.details[caseId]={_id:caseId,title:`Revision Matter ${n+1}`,tasks:[],files:[{uploadedByRole:'paralegal',status:'attorney_revision'}]};}
}

test('all invitations, information requests, revisions and unread conversations remain reachable beyond old slices', async ({page}) => {
  const state=await install(page,{count:0,setup:many});await ready(page);
  await expect(page.locator('[data-paralegal-priority-count]')).toHaveText('75 items');
  const seen=new Set(), nav=page.getByRole('navigation',{name:'Inbox pages'});
  for(let n=1;n<=19;n++){
    for(const href of await inbox(page).locator('.office-inbox-item a').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')))){expect(seen.has(href)).toBe(false);seen.add(href);}
    if(n<19)await nav.getByRole('button',{name:'Next inbox page'}).click();
  }
  expect(seen.size).toBe(75);expect([...seen]).toContain(`case-detail.html?caseId=${id(4052)}&tab=messages`);await expect(inbox(page)).toBeFocused();
  await page.reload();await ready(page);await expect(nav).toContainText('Page 19 of 19');
  let releaseDetails;state.detailWait=new Promise(resolve=>{releaseDetails=resolve;});
  const readsBefore=state.reads[`/api/cases/${MATTER}`]||0;
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect.poll(()=>state.reads[`/api/cases/${MATTER}`]||0).toBeGreaterThan(readsBefore);
  await expect(inbox(page)).toHaveAttribute('data-state','loading');await expect(nav).toContainText('Page 19 of 19');
  await page.getByRole('button',{name:'Next active Matter'}).click();const selected=await page.locator('#assignmentList [data-case-id]').getAttribute('data-case-id');
  releaseDetails();state.detailWait=null;await ready(page);
  await expect(page.locator('#assignmentList [data-case-id]')).toHaveAttribute('data-case-id',selected);await expect(nav).toContainText('Page 19 of 19');
  expect(state.maxDetails).toBeLessThanOrEqual(4);expect(state.errors).toEqual([]);expect(state.writes).toEqual([]);
});

test('background failures clear current application progress, retain explicit errors and recover without dropping the selected Matter', async ({page}) => {
  const state=await install(page,{count:0,setup:s=>{s.applications=[application(1)];s.matters.push({...s.matter,caseId:id(6000),title:'Selected second Matter'});}});await ready(page);
  await page.getByRole('button',{name:'Next active Matter'}).click();await expect(page.locator('#assignmentList')).toContainText('Selected second Matter');
  state.failure='applications';await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect(inbox(page)).toHaveAttribute('data-state','unavailable');await expect(page.locator('#homeApplicationPipeline')).toContainText('Applications couldn’t load.');await expect(page.locator('#homeApplicationPipeline')).not.toContainText('Shortlisted');
  state.failure='';await page.locator('[data-home-applications-retry]').click();await ready(page);await expect(page.locator('#homeApplicationPipeline')).toContainText('Shortlisted');
  await expect(page.locator('#assignmentList')).toContainText('Selected second Matter');
  state.failure='details';await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));await expect(page.locator('#assignmentList')).toContainText('Work details couldn’t load.');await expect(inbox(page)).not.toContainText('No requests');
  state.failure='';await page.locator('[data-desk-retry]').click();await ready(page);await expect(page.locator('#assignmentList')).not.toContainText('couldn’t load');expect(state.errors).toEqual([]);
});

test('inconsistent or failed message counts are not shown as zero or as current conversations', async ({page}) => {
  const state=await install(page,{count:0,setup:s=>{s.summaries=[{caseId:MATTER,title:'Known conversation',unread:2}];s.unreadOverride=3;}});
  await expect(inbox(page)).toHaveAttribute('data-state','unavailable');await expect(inbox(page)).toContainText('Messages couldn’t load.');await expect(inbox(page)).not.toContainText('No requests');await expect(inbox(page)).not.toContainText('unread messages');
  state.unreadOverride=2;await page.locator('[data-inbox-retry]').click();await ready(page);await expect(inbox(page)).toContainText('2 unread messages');
  state.failure='messages';await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));await expect(inbox(page)).toHaveAttribute('data-state','unavailable');await expect(inbox(page)).not.toContainText('Known conversation');expect(state.errors).toEqual([]);
});

test('revoked details and a server-side account swap cannot retain private Home content', async ({page}) => {
  const state=await install(page,{count:0});await ready(page);
  state.restrictedId=MATTER;await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect(inbox(page)).toHaveAttribute('data-state','unavailable');await expect(page.locator('#assignmentList')).not.toContainText('Matter deadline —');
  state.profile={...state.profile,id:id(9900),_id:id(9900)};await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect(page.locator('#paralegalHomeView')).toHaveAttribute('data-state','account-changed');await expect(page.locator('#paralegalHomeView')).toContainText('Your account changed.');await expect(page.locator('#paralegalHomeView')).not.toContainText('Matter deadline —');expect(state.errors).toEqual([]);
});

test('a failed profile read does not invent availability or missing setup requirements', async ({page}) => {
  const state=await install(page,{count:0,empty:true,failure:'profile'});
  await expect(page.locator('#assignmentList')).toContainText('Account details couldn’t load');
  await expect(page.locator('#assignmentList')).not.toContainText('Complete your matching profile');
  await expect(page.locator('#availabilityStatus')).toHaveText('Not loaded');await expect(page.locator('[data-action="availability"]')).toBeDisabled();
  state.failure='';await page.reload();await ready(page);await expect(page.locator('[data-action="availability"]')).toBeEnabled();expect(state.errors).toEqual([]);
});

test('failed background recommendations are explicit and recover without claiming no matches', async ({page}) => {
  const state=await install(page,{count:0,setup:s=>{s.recommendations=[{_id:id(8000),title:'Verified recommendation',totalAmount:40000}];}});await ready(page);
  await expect(page.locator('#recommendedMattersList')).toContainText('Verified recommendation');
  state.failure='recommendations';await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect(page.locator('#recommendedMattersList')).toContainText('Recommendations are unavailable');await expect(page.locator('#recommendedMattersList')).not.toContainText('Verified recommendation');
  state.failure='';await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));
  await expect(page.locator('#recommendedMattersList')).toContainText('Verified recommendation');expect(state.errors).toEqual([]);
});

test('Home uses one current status and one work action with readable desktop and phone layouts', async ({page},testInfo) => {
  const state=await install(page,{count:2,setup:s=>{s.applications=[application(1)];s.recommendations=Array.from({length:3},(_,n)=>({_id:id(8000+n),caseId:id(8000+n),title:`Recommended Matter ${n+1} — Supplemental production review`,practiceArea:'Civil Litigation',state:'New York',totalAmount:40000}));s.summaries=Array.from({length:6},(_,n)=>({caseId:id(4000+n),title:`Long conversation ${n+1} — Supplemental production chronology and attorney-approved exhibits`,unread:1}));}});await ready(page);
  await expect(page.locator('#assignmentList').getByText('Continue work',{exact:true})).toHaveCount(1);await expect(page.locator('#assignmentList')).not.toContainText('Next action');
  await expect(page.locator('#homeApplicationPipeline')).toContainText('Shortlisted');await expect(page.locator('.application-progress')).toHaveCount(0);
  for(const [width,theme,scale] of [[1440,'light',1],[1440,'dark',1],[390,'light',1],[390,'dark',1],[320,'light',2],[320,'dark',2]]){
    await page.setViewportSize({width,height:1000});await page.evaluate(({theme,scale})=>{document.documentElement.classList.toggle('theme-dark',theme==='dark');document.body.classList.toggle('theme-dark',theme==='dark');document.documentElement.style.fontSize=`${16*scale}px`;},{theme,scale});
    const scan=await new AxeBuilder({page}).include('#paralegalHomeView').analyze();expect(scan.violations).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);
    const clipped=await page.locator('.desk-matter h3, .desk-slip strong, .office-inbox-item p, .application-motion__matter strong').evaluateAll(nodes=>nodes.filter(n=>n.scrollWidth>n.clientWidth+2||n.scrollHeight>n.clientHeight+2||n.getBoundingClientRect().right>n.parentElement.getBoundingClientRect().right+2).map(n=>({html:n.outerHTML,width:n.clientWidth,scrollWidth:n.scrollWidth,height:n.clientHeight,scrollHeight:n.scrollHeight,right:n.getBoundingClientRect().right,parentRight:n.parentElement.getBoundingClientRect().right})));expect(clipped).toEqual([]);
    const actions=await page.locator('.application-current-status, .application-motion__action').evaluateAll(nodes=>nodes.map(n=>({left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom})));
    expect(actions[0].right<=actions[1].left+1 || actions[0].bottom<=actions[1].top+1).toBe(true);
    await expect(page.locator('.private-office-desk__header')).toHaveCSS('height','0px');
    if(width===1440){
      const geometry=await page.evaluate(()=>{const a=document.querySelector('#homeWorkSection').getBoundingClientRect(),b=document.querySelector('#recommendedMattersSection').getBoundingClientRect();return {display:getComputedStyle(document.querySelector('#paralegalHomeView')).display,gap:b.top-a.bottom};});
      expect(geometry.display).toBe('grid');expect(geometry.gap).toBeLessThanOrEqual(48);
    }
    for(const [part,selector] of [['work','#assignmentList'],['inbox','[aria-label="Inbox pages"]'],['applications','#homeApplicationPipeline']]){await page.locator(selector).scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath(`${width}-${theme}-${scale}-${part}.png`)});}
  }
  expect(state.errors).toEqual([]);
});

test('one or two recommendations use the available row without leaving empty card columns', async ({page},testInfo) => {
  const state=await install(page,{count:0,setup:s=>{s.recommendations=[{_id:id(8000),title:'Recommended review of supplemental production records',practiceArea:'Civil Litigation',state:'NY',totalAmount:40000}];}});await ready(page);
  for(const total of [1,2]){
    if(total===2){state.recommendations.push({...state.recommendations[0],_id:id(8001),title:'Recommended chronology review'});await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lpc:lifecycle-refresh')));await expect(page.locator('.matter-folio')).toHaveCount(2);}
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      await page.evaluate(()=>document.fonts.ready);
      const geometry=await page.locator('#recommendedMattersList').evaluate(container=>({width:container.clientWidth,children:[...container.children].map(node=>({width:node.getBoundingClientRect().width,right:node.getBoundingClientRect().right,top:node.getBoundingClientRect().top})),right:container.getBoundingClientRect().right}));
      expect(Math.abs(geometry.children.at(-1).right-geometry.right)).toBeLessThanOrEqual(2);
      if(total===1||width===390)expect(geometry.children[0].width).toBeGreaterThan(geometry.width-2);
      else expect(Math.abs(geometry.children[0].top-geometry.children[1].top)).toBeLessThanOrEqual(1);
      await page.locator('#recommendedMattersSection').scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath(`${total}-recommendations-${width}.png`)});
    }
  }
  expect(state.errors).toEqual([]);
});
