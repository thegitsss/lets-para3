const {test}=require('./shell-fixture');
const {expect}=require('playwright/test');
const {prepare,ui,conversation,CONVERSATION}=require('./flows-fixture');
const {OWNER}=require('./fixture');
const json=(route,value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
const result=body=>({ok:true,request:{id:body.requestId,action:'send',state:'succeeded'},conversation,userMessage:{id:'999999999999999999999999',sender:'user',text:body.text},assistantMessage:{id:'aaaaaaaaaaaaaaaaaaaaaaaa',sender:'assistant',text:'Your saved response is ready.',metadata:{}}});
const check=page=>page.getByRole('button',{name:'Check result',exact:true});
const submit=page=>page.locator('[data-support-submit]');
for(const role of ['attorney','paralegal']) {
 test(`${role}: a competing send discovers the interrupted request without reloading the page`,async({page})=>{
  const f=await prepare(page,role);const activeId='98765432-1234-4234-8234-123456789012';let blocked=false,posts=0;
  const record={version:1,ownerId:OWNER,role,conversationId:CONVERSATION,requestId:activeId,action:'send',createdAt:Date.now(),body:{text:'Earlier interrupted question',sourcePage:'',pageContext:{},promptAction:null}};
  await page.route('**/api/support/conversation?*',route=>json(route,{ok:true,conversation,...(blocked?{recoveryRequest:record}:{})}));
  await page.route('**/api/support/conversation/*/requests/*',route=>new URL(route.request().url()).pathname.endsWith(activeId)
    ? json(route,{ok:true,request:{id:activeId,action:'send',state:'retryable'},result:null})
    : json(route,{code:'SUPPORT_REQUEST_UNKNOWN'},404));
  f.state.send=route=>{posts++;if(!blocked){blocked=true;return json(route,{code:'SUPPORT_CONVERSATION_BUSY'},409);}expect(route.request().postDataJSON()).toMatchObject({requestId:activeId,text:record.body.text});return json(route,result(route.request().postDataJSON()),201);};
  await f.open();await ui(page).composer.fill('My later draft');await submit(page).click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('lpc_support_pending_request')).requestId)).toBe(activeId);
  await expect(page.getByRole('button',{name:'Retry request',exact:true})).toBeVisible();await expect(ui(page).composer).toHaveValue('My later draft');expect(posts).toBe(1);
  await page.getByRole('button',{name:'Retry request',exact:true}).click();await expect(ui(page).thread).toContainText('Your saved response is ready.');expect(posts).toBe(2);await expect(ui(page).composer).toHaveValue('My later draft');
 });
 test(`${role}: a fresh tab recovers the servers interrupted question without an automatic send`,async({page})=>{
  const f=await prepare(page,role);const requestId='12345678-1234-4234-8234-123456789012';let posts=0;
  const body={text:'Question from the closed tab',sourcePage:'',pageContext:{},promptAction:null};
  const record={version:1,ownerId:OWNER,role,conversationId:CONVERSATION,requestId,action:'send',createdAt:Date.now(),body};
  await page.route('**/api/support/conversation?*',route=>json(route,{ok:true,conversation,recoveryRequest:record}));
  await page.route('**/api/support/conversation/*/requests/*',route=>json(route,{ok:true,request:{id:requestId,action:'send',state:'retryable'},result:null}));
  f.state.send=route=>{posts++;expect(route.request().postDataJSON()).toMatchObject({...body,requestId});return json(route,result(route.request().postDataJSON()),201);};
  await f.open();const retry=page.getByRole('button',{name:'Retry request',exact:true});await expect(retry).toBeVisible();
  await expect(ui(page).composer).toHaveValue(body.text);expect(posts).toBe(0);await retry.click();
  await expect(ui(page).thread).toContainText('Your saved response is ready.');expect(posts).toBe(1);
 });
 test(`${role}: another tab's active request is recovered while retaining the rejected local draft`,async({page})=>{
  const f=await prepare(page,role);const localId='12345678-1234-4234-8234-123456789012',activeId='98765432-1234-4234-8234-123456789012';
  const record=(requestId,text)=>({version:1,ownerId:OWNER,role,conversationId:CONVERSATION,requestId,action:'send',createdAt:Date.now(),body:{text,sourcePage:'',pageContext:{},promptAction:null}});
  await page.evaluate(value=>sessionStorage.setItem('lpc_support_pending_request',JSON.stringify(value)),record(localId,'My later draft'));
  await page.route('**/api/support/conversation?*',route=>json(route,{ok:true,conversation,recoveryRequest:record(activeId,'Earlier active question')}));
  await page.route('**/api/support/conversation/*/requests/*',route=>json(route,{ok:true,request:{id:new URL(route.request().url()).pathname.split('/').at(-1),action:'send',state:'retryable'},result:null}));
  const bodies=[];f.state.send=route=>{bodies.push(route.request().postDataJSON());return json(route,result(bodies.at(-1)),201);};
  await f.open();await expect(page.getByRole('button',{name:'Retry request',exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('lpc_support_pending_request')).requestId)).toBe(activeId);
  await expect(ui(page).composer).toHaveValue('My later draft');expect(bodies).toHaveLength(0);
  await page.getByRole('button',{name:'Retry request',exact:true}).click();await expect(ui(page).thread).toContainText('Your saved response is ready.');
  expect(bodies[0]).toMatchObject({requestId:activeId,text:'Earlier active question'});await expect(ui(page).composer).toHaveValue('My later draft');
 });
 test(`${role}: unresolved request disables feedback until its result is checked`,async({page})=>{
  const f=await prepare(page,role);let receipt;
  f.state.send=route=>{receipt=result(route.request().postDataJSON());return route.abort('failed');};
  await page.route('**/api/support/conversation/*/requests/*',route=>json(route,{ok:true,request:receipt.request,result:receipt}));
  await f.open();await ui(page).composer.fill('Original question');await submit(page).click();await expect(check(page)).toBeVisible();
  await expect(page.getByRole('button',{name:'Helpful',exact:true}).first()).toBeDisabled();
  await check(page).click();
  await expect(ui(page).composer).toHaveValue('');
  await expect(submit(page)).toBeDisabled();
  await expect(page.getByRole('button',{name:'Helpful',exact:true}).first()).toBeEnabled();
 });
 test(`${role}: restoring an earlier send preserves the current successor conversation`,async({page})=>{
  const f=await prepare(page,role);let receipt,posts=0;
  f.state.send=route=>{posts++;receipt=result(route.request().postDataJSON());return route.abort('failed');};
  await page.route('**/api/support/conversation/*/requests/*',route=>json(route,{ok:true,request:receipt.request,result:receipt}));
  await f.open();await ui(page).composer.fill('Original question');await submit(page).click();await expect(check(page)).toBeVisible();
  const successor={...conversation,id:'888888888888888888888888'};
  await page.route('**/api/support/conversation?*',route=>json(route,{ok:true,conversation:successor}));
  await page.route('**/api/support/conversation/888888888888888888888888/messages?*',route=>route.request().method()==='GET'?json(route,{ok:true,conversation:successor,messages:[{id:'bbbbbbbbbbbbbbbbbbbbbbbb',sender:'assistant',text:'Current successor guidance',metadata:{}}]}):route.fallback());
  await page.reload();await f.open();
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem('lpc_support_pending_request'))).toBeNull();
  await expect(ui(page).thread).toContainText('Current successor guidance');
  await expect(ui(page).thread).not.toContainText('Your saved response is ready.');
  f.state.send=route=>{posts++;return json(route,{...result(route.request().postDataJSON()),conversation:successor},201);};
  await ui(page).composer.fill('Question for the current conversation');await submit(page).click();
  await expect.poll(()=>posts).toBe(2);
  expect(f.calls.filter(call=>call.method==='POST').at(-1).path).toBe('/api/support/conversation/888888888888888888888888/messages');
 });
 test(`${role}: lost send acknowledgment checks saved reply once and preserves a newer draft`,async({page})=>{
  const f=await prepare(page,role);let receipt,posts=0,reads=0;
  f.state.send=async route=>{posts++;receipt=result(route.request().postDataJSON());return route.abort('failed');};
  await page.route('**/api/support/conversation/*/requests/*',route=>{reads++;return json(route,{ok:true,request:receipt.request,result:receipt});});
  await f.open();await ui(page).composer.fill('Original question');await submit(page).click();
  await expect(check(page)).toBeVisible();await expect(ui(page).composer).toHaveValue('Original question');
  await ui(page).composer.fill('A newer draft');await check(page).click();
  await expect(ui(page).thread.getByText('Your saved response is ready.',{exact:true})).toHaveCount(1);
  await expect(ui(page).composer).toHaveValue('A newer draft');expect(posts).toBe(1);expect(reads).toBe(1);
  expect(receipt.request.id).toMatch(/^[a-f\d]{8}-/i);await expect(submit(page)).toBeEnabled();
 });
 test(`${role}: reload restores a lost request without another POST`,async({page})=>{
  const f=await prepare(page,role);let receipt,posts=0,reads=0;
  f.state.send=async route=>{posts++;receipt=result(route.request().postDataJSON());return route.abort('failed');};
  await page.route('**/api/support/conversation/*/requests/*',route=>{reads++;return json(route,{ok:true,request:receipt.request,result:receipt});});
  await f.open();await ui(page).composer.fill('Original question');await submit(page).click();await expect(check(page)).toBeVisible();
  await page.reload();await f.open();await expect(ui(page).thread.getByText('Your saved response is ready.',{exact:true})).toHaveCount(1);
  expect(posts).toBe(1);expect(reads).toBe(1);expect(await page.evaluate(()=>sessionStorage.getItem('lpc_support_pending_request'))).toBeNull();
 });
 test(`${role}: unknown outcome only retries the exact original request after an explicit action`,async({page})=>{
  const f=await prepare(page,role);const bodies=[];
  f.state.send=route=>{const body=route.request().postDataJSON();bodies.push(body);return bodies.length===1?route.abort('failed'):json(route,result(body),201);};
  await page.route('**/api/support/conversation/*/requests/*',route=>json(route,{error:'not found'},404));
  await f.open();await ui(page).composer.fill('Original question');await submit(page).click();await expect(check(page)).toBeVisible();await check(page).click();
  await expect(page.getByRole('button',{name:'Retry request',exact:true})).toBeVisible();expect(bodies).toHaveLength(1);
  await ui(page).composer.fill('A newer draft');await page.getByRole('button',{name:'Retry request',exact:true}).click();
  await expect(ui(page).thread.getByText('Your saved response is ready.',{exact:true})).toHaveCount(1);expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);await expect(ui(page).composer).toHaveValue('A newer draft');
 });
 test(`${role}: stop waiting keeps recovery and rejects a delayed reply`,async({page})=>{
  const f=await prepare(page,role);let release,receipt,posts=0;const held=new Promise(resolve=>{release=resolve});
  f.state.send=async route=>{posts++;receipt=result(route.request().postDataJSON());await held;return json(route,receipt,201);};
  await page.route('**/api/support/conversation/*/requests/*',route=>json(route,{ok:true,request:receipt.request,result:receipt}));
  try {
   await f.open();await ui(page).composer.fill('Original question');await submit(page).click();
   await expect(page.getByRole('button',{name:'Stop waiting',exact:true})).toBeVisible();await page.getByRole('button',{name:'Stop waiting',exact:true}).click();
   await expect(check(page)).toBeVisible();await expect(ui(page).composer).toHaveValue('Original question');release();
   await expect(ui(page).thread.getByText('Your saved response is ready.',{exact:true})).toHaveCount(0);
   await check(page).click();await expect(ui(page).thread.getByText('Your saved response is ready.',{exact:true})).toHaveCount(1);expect(posts).toBe(1);
  } finally {release();}
 });
 test(`${role}: invalid success cannot erase the question or enable a duplicate send`,async({page})=>{
  const f=await prepare(page,role);let posts=0;
  f.state.send=route=>{posts++;const body=route.request().postDataJSON();return json(route,{...result(body),assistantMessage:null},201);};
  await f.open();await ui(page).composer.fill('Original question');await submit(page).click();await expect(check(page)).toBeVisible();
  await expect(ui(page).composer).toHaveValue('Original question');await expect(submit(page)).toBeDisabled();expect(posts).toBe(1);
  await expect(ui(page).thread).not.toContainText('undefined');
 });
 test(`${role}: lost restart result retains old history until checking its confirmed successor`,async({page})=>{
  const f=await prepare(page,role);let receipt,posts=0;
  f.state.restart=route=>{posts++;const body=route.request().postDataJSON();receipt={ok:true,request:{id:body.requestId,action:'restart',state:'succeeded'},conversation:{...conversation,id:'888888888888888888888888'},messages:[]};return route.abort('failed');};
  await page.route('**/api/support/conversation/*/requests/*',route=>json(route,{ok:true,request:receipt.request,result:receipt}));
  await f.open();await page.getByRole('button',{name:'Open assistant options',exact:true}).click();await page.getByRole('menuitem',{name:'Start new conversation',exact:true}).click();
  await expect(check(page)).toBeVisible();await expect(ui(page).thread).toContainText('Earlier verified account guidance');await check(page).click();
  await expect(ui(page).thread).not.toContainText('Earlier verified account guidance');expect(posts).toBe(1);expect(receipt.request.id).toMatch(/^[a-f\d]{8}-/i);
 });
}
