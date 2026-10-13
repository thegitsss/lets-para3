const {expect}=require('playwright/test');
const {test}=require('./shell-fixture');
const {fixture,json,OWNER,MATTER,workspaceMatter}=require('./fixture');
const CONVERSATION='555555555555555555555555';
const conversation={id:CONVERSATION,status:'open',escalation:{requested:false}};
const oldUser={id:'666666666666666666666666',sender:'user',text:'My earlier private question',createdAt:'2026-09-09T10:00:00.000Z'};
const oldAnswer={id:'777777777777777777777777',sender:'assistant',text:'Earlier verified account guidance',metadata:{},createdAt:'2026-09-09T10:00:01.000Z'};
const ui=page=>({drawer:page.locator('#supportDrawer'),composer:page.locator('[data-support-textarea]'),thread:page.locator('[data-support-thread]'),status:page.locator('[data-support-status]')});
async function prepare(page,role,{hash='/help',history=[oldUser,oldAnswer],historyStatus=200}={}){
 const result=await fixture(page,role,{hash,setup:s=>{s.matterRespond=route=>json(route,{...workspaceMatter(),id:MATTER});}});
 const calls=[];const state={history,historyStatus,restart:null,send:null};
 await page.evaluate(owner=>sessionStorage.setItem('lpc_support_session_user',owner),OWNER);
 await page.route('**/api/support/**',async route=>{
  const req=route.request(),url=new URL(req.url());calls.push({path:url.pathname,method:req.method(),query:Object.fromEntries(url.searchParams),body:req.postData()?req.postDataJSON():null});
  if(url.pathname==='/api/support/conversation')return json(route,{ok:true,conversation});
  if(url.pathname===`/api/support/conversation/${CONVERSATION}/messages`&&req.method()==='GET')return json(route,{ok:state.historyStatus===200,conversation,messages:state.history},state.historyStatus);
  if(url.pathname.endsWith('/restart'))return state.restart?state.restart(route):json(route,{ok:true,request:{id:req.postDataJSON().requestId,action:'restart',state:'succeeded'},conversation:{...conversation,id:'888888888888888888888888'},messages:[]},201);
  if(url.pathname.endsWith('/messages')&&req.method()==='POST')return state.send?state.send(route):json(route,{ok:true,request:{id:req.postDataJSON().requestId,action:'send',state:'succeeded'},conversation,userMessage:{...oldUser,text:req.postDataJSON().text},assistantMessage:oldAnswer},201);
  return json(route,{ok:true});
 });
 const open=async()=>{await page.locator(role==='attorney'?'[data-av2-assistant]':'[data-v2-assistant-trigger]').click();await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');};
 return {...result,sessionState:result.state,state,calls,open};
}
async function restart(page){await page.getByRole('button',{name:'Open assistant options',exact:true}).click();await page.getByRole('menuitem',{name:'Start new conversation',exact:true}).click();}
for(const role of ['attorney','paralegal']){
 test(`${role}: failed history stays visible as unavailable and can be explicitly retried`,async({page})=>{
  const {state,open,calls}=await prepare(page,role,{historyStatus:503});await open();
  await expect.poll(()=>calls.filter(x=>x.path.endsWith('/messages')).length).toBe(1);
  await expect(ui(page).status).toContainText(/load|unavailable|available/i);
  await expect(ui(page).status.getByRole('button',{name:/try again|retry|reload/i})).toBeVisible();
  state.historyStatus=200;await ui(page).status.getByRole('button').click();await expect(ui(page).thread).toContainText(oldAnswer.text);
 });
 test(`${role}: rejected restart retains known conversation and draft`,async({page})=>{
  const {state,open}=await prepare(page,role);await open();await expect(ui(page).thread).toContainText(oldAnswer.text);await ui(page).composer.fill('Unsent private draft');
  state.restart=route=>json(route,{error:'unavailable'},503);await restart(page);
  await expect(ui(page).status).toContainText("We couldn't confirm the result");
  await expect(ui(page).status.getByRole('button',{name:'Check result',exact:true})).toBeVisible();
  await expect(ui(page).thread).toContainText(oldAnswer.text);await expect(ui(page).composer).toHaveValue('Unsent private draft');
 });
 test(`${role}: delayed successful restart prevents overlapping edits and restores usable composer`,async({page})=>{
  const {state,open,calls}=await prepare(page,role);await open();await expect(ui(page).thread).toContainText(oldAnswer.text);let release;const gate=new Promise(r=>release=r);
  state.restart=async route=>{await gate;return json(route,{ok:true,request:{id:route.request().postDataJSON().requestId,action:'restart',state:'succeeded'},conversation:{...conversation,id:'888888888888888888888888'},messages:[]},201);};
  try {
   await restart(page);await expect.poll(()=>calls.filter(x=>x.path.endsWith('/restart')).length).toBe(1);
   await expect(ui(page).composer).toBeDisabled();await expect(page.locator('[data-support-restart]')).toBeDisabled();
  } finally { release(); }
  await expect(page.locator('[data-support-restart]')).toBeEnabled();await expect(ui(page).composer).toHaveValue('');
  await ui(page).composer.fill('New details after restarting');await expect(ui(page).composer).toHaveValue('New details after restarting');
 });
}
test('attorney: verified open Matter supplies current tab context and clears it after navigation',async({page})=>{
 const {open,calls,state}=await prepare(page,'attorney',{hash:`/matters/${MATTER}/overview`});
 await page.evaluate(owner=>sessionStorage.setItem('lpc_support_session_user',owner),OWNER);
 await expect(page.getByRole('heading',{name:'Litigation review',exact:true})).toBeVisible();await open();await expect(ui(page).thread).toContainText(oldAnswer.text);
 await ui(page).composer.fill('What is the status of this Matter?');await ui(page).composer.press('Enter');
 await expect.poll(()=>calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages')).length).toBe(1);
 const sent=calls.find(x=>x.method==='POST'&&x.path.endsWith('/messages')).body.pageContext;
 expect(sent.caseId).toBe(MATTER);expect(sent.currentTab).toBe('overview');expect(sent.availableMatterTabs).toContain('overview');
 await page.locator('[data-support-close]').click();await page.evaluate(()=>location.hash='/help');await expect(page.getByRole('heading',{name:'Help for Attorneys',exact:true})).toBeVisible();await open();
 await ui(page).composer.fill('What can I do here?');await ui(page).composer.press('Enter');await expect.poll(()=>calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages')).length).toBe(2);
 expect(calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages'))[1].body.pageContext.caseId).toBe('');
});

for(const role of ['attorney','paralegal']) {
 test(`${role}: unavailable Matter read clears earlier context and a URL alone cannot restore it`,async({page})=>{
  const hash=role==='attorney'?`/matters/${MATTER}/overview`:`/matter/${MATTER}`;
  const {open,calls,sessionState}=await prepare(page,role,{hash});
  await expect(page.getByRole('heading',{name:'Litigation review',exact:true})).toBeVisible();await open();await expect(ui(page).thread).toContainText(oldAnswer.text);
  await ui(page).composer.fill('Which Matter is open?');await ui(page).composer.press('Enter');
  await expect.poll(()=>calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages')).length).toBe(1);
  expect(calls.find(x=>x.method==='POST'&&x.path.endsWith('/messages')).body.pageContext).toMatchObject({caseId:MATTER,currentTab:'overview'});
  await page.locator('[data-support-close]').click();await page.evaluate(()=>location.hash='/help');await expect(page.getByRole('heading',{name:role==='attorney'?'Help for Attorneys':'Help for Paralegals',exact:true})).toBeVisible();
  sessionState.matterRespond=route=>json(route,{error:'unavailable'},503);await page.evaluate(value=>location.hash=value,hash);
  await expect(page.getByRole('heading',{name:role==='attorney'?'Matter unavailable':'Matter temporarily unavailable',exact:true})).toBeVisible();await open();
  await ui(page).composer.fill('What is the status now?');await ui(page).composer.press('Enter');await expect.poll(()=>calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages')).length).toBe(2);
  const body=calls.filter(x=>x.method==='POST'&&x.path.endsWith('/messages'))[1].body;expect(body.pageContext.caseId).toBe('');expect(body.pageContext.availableMatterTabs).toEqual([]);
 });
 test(`${role}: opening a fresh tab retains the active conversation without an implicit restart`,async({page})=>{
  const {open,calls}=await prepare(page,role);
  await page.evaluate(()=>sessionStorage.removeItem('lpc_support_session_user'));await open();
  await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  await expect(ui(page).thread).toContainText(oldAnswer.text);
  expect(calls.filter(x=>x.method==='POST'&&x.path.endsWith('/restart'))).toEqual([]);
 });
}

for(const role of ['attorney','paralegal']) {
 test(`${role}: Assistant Matter action stays in V2 and preserves the current conversation`,async({page})=>{
  const linked={...oldAnswer,metadata:{actions:[{label:'Open Matter overview',href:`/case-detail.html?caseId=${MATTER}&tab=overview`}]}};
  const {open}=await prepare(page,role,{history:[oldUser,linked]});await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  await ui(page).composer.fill('Unsent follow-up retained during navigation');
  await ui(page).thread.getByRole('button',{name:'Open Matter overview',exact:true}).click();
  const target=role==='attorney'?`#/matters/${MATTER}/overview`:`#/matter/${MATTER}?tab=overview`;
  await expect.poll(()=>new URL(page.url()).pathname+new URL(page.url()).hash).toBe(`/${role}-v2.html${target}`);
  await expect(page.getByRole('heading',{name:'Litigation review',exact:true})).toBeVisible();
  await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');await expect(ui(page).thread).toContainText(oldAnswer.text);await expect(ui(page).composer).toHaveValue('Unsent follow-up retained during navigation');
 });
}
