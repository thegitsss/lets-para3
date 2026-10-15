const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const AxeBuilder=require('@axe-core/playwright').default;
const fs=require('node:fs/promises');
const OWNER='64b000000000000000000001',ATTORNEY='64b000000000000000000002',MATTER='64b000000000000000000011';
async function setup(page){
 const state={writes:[],messages:[{_id:'64b000000000000000000021',text:'Please check these documents.',type:'text',senderId:{_id:ATTORNEY,firstName:'Jordan',lastName:'Lee'},createdAt:'2026-09-23T12:00:00Z',readBy:[]},{_id:'64b000000000000000000022',text:'hi',type:'text',senderId:{_id:OWNER},createdAt:'2026-09-23T12:05:00Z',readBy:[]}],files:[]};
 await page.route('**/paralegal-v2.html',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Conversations</title><link rel="stylesheet" href="/assets/styles/fonts.css"><link rel="stylesheet" href="/assets/styles/paralegal-v2-matter.css"><link rel="stylesheet" href="/assets/styles/attorney-v2-conversations.css"><link rel="stylesheet" href="/assets/styles/paralegal-conversations.css"><style>body{margin:0;height:100vh;padding:28px;box-sizing:border-box}main{height:100%}</style></head><body><main></main><script type="module">
 import {createApiClient} from '/assets/scripts/paralegal-v2/api-client.mjs';
 import {createConversationsView} from '/assets/scripts/paralegal-v2/conversations-view.mjs';
 import {parseRouteHash} from '/assets/scripts/paralegal-v2/router.mjs';
 window.view=createConversationsView({api:createApiClient(),getIdentity:()=>({id:'${OWNER}',role:'paralegal'})});
 document.querySelector('main').append(window.view.render({route:parseRouteHash(location.hash||'#/conversations')}));
 </script></body></html>`}));
 state.handler=async route=>{
  const path=new URL(route.request().url()).pathname,method=route.request().method();let body={};
  if(path==='/api/auth/workspace-release')body={workspace:{schemaVersion:1,ownerId:OWNER,role:'paralegal',revision:1,version:'v2',defaultDestination:'/paralegal-v2.html#/home'}};
  else if(path==='/api/csrf')body={csrfToken:'test-token'};
  else if(path==='/api/messages/unread-count')body={count:0};
  else if(path==='/api/messages/summary')body={items:[{caseId:MATTER,unread:0}]};
  else if(path==='/api/messages/threads')body={total:1,threads:[{id:MATTER,title:'Discovery response support',participant:{id:ATTORNEY,name:'Jordan Lee',role:'attorney'},unread:0,lastMessageSnippet:'hi',updatedAt:'2026-09-23T12:05:00Z'}]};
  else if(path===`/api/cases/${MATTER}`)body={_id:MATTER,title:'Discovery response support',status:'in progress',matterExperience:{sections:[{id:'messages'},{id:'files'}],overview:{attorney:'Jordan Lee'},work:{readOnly:Boolean(state.closed)}}};
  else if(path===`/api/messages/${MATTER}` && method==='GET')body={messages:state.messages};
  else if(path===`/api/uploads/case/${MATTER}` && method==='GET')body={files:state.files};
  else if(path===`/api/uploads/case/${MATTER}`){state.writes.push({upload:true});state.files.push({version:1,id:'64b000000000000000000031',originalName:'Exhibit.txt',size:10,securityStatus:'pending',uploadedAt:new Date().toISOString(),uploadedBy:OWNER});body={file:state.files.at(-1)};}
  else if(path.endsWith('/stream'))return route.fulfill({contentType:'text/event-stream',body:': connected\n\n'});
  else if(path.endsWith('/read'))body={ok:true};
  else if(path===`/api/messages/${MATTER}`){const input=route.request().postDataJSON();state.writes.push(input);if(state.failSend)return route.abort();let row=state.messages.find(m=>m.clientMessageId===input.clientMessageId);if(!row){row={_id:'64b000000000000000000023',...input,type:'text',senderId:{_id:OWNER},createdAt:new Date().toISOString(),readBy:[]};state.messages.push(row);}body={message:row};}
  else if(path===`/api/messages/${MATTER}/file`){
   const input=route.request().postDataJSON();state.writes.push({fileMessage:true,...input});
   if(state.files.at(-1).securityStatus==='pending')return route.fulfill({status:423,contentType:'application/json',body:JSON.stringify({error:'Security check in progress'})});
   let message=state.messages.find(m=>m.clientMessageId===input.clientMessageId);
   if(!message){message={_id:'64b000000000000000000024',caseId:MATTER,senderId:OWNER,type:'file',fileName:'Exhibit.txt',content:{caseFileId:input.fileId},clientMessageId:input.clientMessageId,createdAt:new Date().toISOString()};state.messages.push(message);}
   body={message};
  }
  else if(path.startsWith(`/api/messages/${MATTER}/`)){
   const id=path.split('/')[4],input=route.request().postDataJSON();state.writes.push({id,method,...input});const message=state.messages.find(m=>m._id===id);
   if(state.failEdit)return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Try again.'})});
   if(method==='DELETE')state.messages=state.messages.filter(m=>m!==message);else if(input.content)message.text=input.content;else if(input.pin)message.pinned=true;body={ok:true};
  } else return route.fallback();
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 };
 await page.route('**/api/**',state.handler);
 await page.goto('/paralegal-v2.html#/conversations');
 await expect(page.locator('.av2-thread-link')).toHaveCount(1);
 if(!await page.locator('[data-v2-message-input]').count())await page.locator('.av2-thread-link').click();
 await expect(page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state','ready');
 return state;
}
test('remote reaction additions and removals refresh without another message or a write',async({page})=>{
 const state=await setup(page);
 const input=page.locator('[data-v2-message-input]');await input.fill('Keep my unsent reply');
 const message=page.locator('[data-message-id="64b000000000000000000021"]');
 await expect(message.locator('.av2-message-reactions button')).toHaveCount(0);
 state.messages[0].reactions={'👍':[ATTORNEY]};
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await expect(message.locator('.av2-message-reactions button')).toHaveText('👍 1');
  await expect(message.locator('.av2-message-reactions button')).toHaveAttribute('aria-pressed','false');
  await expect(message.getByRole('button',{name:'Add 👍 reaction',exact:true})).toBeVisible();
 state.messages[0].reactions={};
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await expect(message.locator('.av2-message-reactions button')).toHaveCount(0);
 await expect(input).toHaveValue('Keep my unsent reply');
 expect(state.writes).toEqual([]);
});
test('approved compact composition, inline editing and unsent draft preservation',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const state=await setup(page);
 const input=page.locator('[data-v2-message-input]');await input.fill('Separate unsent reply');
 const own=page.locator('[data-message-own=true]').last();await own.hover();await own.getByText('⋯').click();await own.getByRole('button',{name:'Edit message',exact:true}).click();
 await page.getByRole('textbox',{name:'Message text',exact:true}).fill('Updated reply');
 await page.getByRole('button',{name:'Save message',exact:true}).click();await expect(own.locator('.av2-preserve-lines')).toHaveText('Updated reply');await expect(input).toHaveValue('Separate unsent reply');
 expect(state.writes.filter(w=>w.method==='PATCH')).toHaveLength(1);
 expect(await page.locator('.av2-composer-row').evaluate(e=>e.getBoundingClientRect().height)).toBeLessThan(65);
 await fs.mkdir('../outputs/paralegal-v2-conversations',{recursive:true});await page.screenshot({path:'../outputs/paralegal-v2-conversations/desktop.png'});
 expect((await new AxeBuilder({page}).include('.pv2-conversations').analyze()).violations).toEqual([]);
});
test('failed editing preserves text; cancel and deletion use separate controls',async({page})=>{
 const state=await setup(page);state.failEdit=true;const own=page.locator('[data-message-own=true]').last();await own.hover();await own.getByText('⋯').click();await own.getByRole('button',{name:'Edit message',exact:true}).click();await page.getByRole('textbox',{name:'Message text',exact:true}).fill('Keep this edit');await page.getByRole('button',{name:'Save message',exact:true}).click();await expect(page.locator('[data-v2-message-status]')).toContainText('Try again');await expect(page.getByRole('textbox',{name:'Message text',exact:true})).toHaveValue('Keep this edit');await page.getByRole('button',{name:'Cancel edit'}).click();state.failEdit=false;
 await own.hover();await own.getByText('⋯').click();await own.getByRole('button',{name:'Delete message',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'Keep message'}).click();expect(state.messages).toHaveLength(2);
});
test('paperclip, upload security status, mobile back navigation and no overflow',async({page})=>{
 await page.setViewportSize({width:390,height:844});const state=await setup(page);
 await page.locator('[data-v2-message-attachment-input]').setInputFiles({name:'Exhibit.txt',mimeType:'text/plain',buffer:Buffer.from('test file')});await expect(page.getByText('Ready to share',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByText('Security check in progress',{exact:false})).toBeVisible();expect(state.writes.filter(w=>w.upload)).toHaveLength(1);
 state.files[0].securityStatus='clean';await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('.v2-matter-message-file-row')).toHaveCount(1);expect(state.writes.filter(w=>w.upload)).toHaveLength(1);expect(state.messages.filter(m=>m.type==='file')).toHaveLength(1);
 await page.screenshot({path:'../outputs/paralegal-v2-conversations/mobile.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'← Messages',exact:true}).click();await expect(page.locator('.av2-thread-link')).toBeVisible();
});
test('keyboard newline, idempotent retry and read-only permissions',async({page})=>{
 const state=await setup(page);const input=page.locator('[data-v2-message-input]');await input.fill('First line');await input.press('Enter');await expect(input).toHaveValue('First line\n');expect(state.writes).toHaveLength(0);
 state.failSend=true;await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('[data-v2-message-status]')).toContainText('connect');state.failSend=false;await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(input).toHaveValue('');expect(state.writes[0].clientMessageId).toBe(state.writes[1].clientMessageId);
 state.closed=true;await page.reload();await expect(page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state','ready');await expect(input).toHaveCount(0);await expect(page.locator('.av2-context-menu')).toHaveCount(0);
});

test('real Paralegal shell navigation and Matter message links use the same inbox',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});
 const state=await setup(page);
 await page.unroute('**/paralegal-v2.html');
 await page.goto('about:blank');
 const {fixture}=require('../assistant-completion/fixture');
 await fixture(page,'paralegal',{hash:'/conversations',setup:async value=>{value.user.id=OWNER;value.user._id=OWNER;await page.route('**/api/**',state.handler);}});
 await expect(page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state','ready');
 await expect(page.locator('[data-v2-route="conversations"]')).toHaveAttribute('aria-current','page');
 await expect(page.locator('.v2-route-state')).toHaveCount(0);
 expect(await page.locator('.av2-composer-row').evaluate(e=>e.getBoundingClientRect().bottom<innerHeight)).toBe(true);
 await page.screenshot({path:'../outputs/paralegal-v2-conversations/full-shell.png'});
 await page.goto(`/paralegal-v2.html#/matter/${MATTER}?tab=messages`);
 await expect(page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state','ready');
 await expect(page.locator('.av2-thread-participant')).toHaveText('Jordan Lee');
});

test('background messages preserve reading position and offer New messages',async({page})=>{
 const state=await setup(page);
 state.messages.push(...Array.from({length:35},(_,i)=>({_id:(100+i).toString(16).padStart(24,'0'),type:'text',text:`Earlier note ${i}`,senderId:{_id:ATTORNEY,firstName:'Jordan',lastName:'Lee'},createdAt:new Date(Date.UTC(2026,8,23,13,i)).toISOString(),readBy:[]})));
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.locator('[data-message-id]')).toHaveCount(37);
 const history=page.locator('[data-v2-message-content]');await history.evaluate(e=>e.scrollTop=30);
 const before=await history.evaluate(e=>e.scrollTop);
 state.messages.push({_id:'64b000000000000000000099',type:'text',text:'A new update',senderId:{_id:ATTORNEY,firstName:'Jordan'},createdAt:new Date().toISOString(),readBy:[]});
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByRole('button',{name:'New messages ↓'})).toBeVisible();expect(await history.evaluate(e=>e.scrollTop)).toBe(before);
 await page.getByRole('button',{name:'New messages ↓'}).click();await expect(page.getByRole('button',{name:'New messages ↓'})).toBeHidden();
});


test('background receipts keep an open message action usable and apply queued updates on close',async({page})=>{
 const state=await setup(page), own=page.locator('[data-message-own=true]').last();
 await own.locator('summary').click();
 await own.locator('.av2-context-menu').evaluate(menu=>window.originalMessageMenu=menu);
 state.messages[1].readBy=[ATTORNEY];
 const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/messages/${MATTER}` && response.request().method()==='GET');
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));await (await refreshed).finished();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 expect(await page.evaluate(()=>window.originalMessageMenu.isConnected && window.originalMessageMenu.open)).toBe(true);
 await own.getByRole('button',{name:'Edit message',exact:true}).click();
 await page.getByRole('textbox',{name:'Message text',exact:true}).fill('An edit chosen during an update');
 await page.getByRole('button',{name:'Save message',exact:true}).click();
 await expect(own.locator('.av2-preserve-lines')).toHaveText('An edit chosen during an update');
 await expect(own.getByText('Read',{exact:true})).toBeVisible();
 await own.locator('summary').click();
 state.messages.push({_id:'64b000000000000000000099',type:'text',text:'Arrived during menu use',senderId:{_id:ATTORNEY,firstName:'Jordan'},createdAt:new Date().toISOString(),readBy:[]});
 const next=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/messages/${MATTER}` && response.request().method()==='GET');
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));await (await next).finished();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await expect(own.locator('.av2-context-menu')).toHaveAttribute('open','');
 await page.keyboard.press('Escape');
 await expect(page.getByText('Arrived during menu use',{exact:true})).toBeVisible();
 expect(state.writes.filter(w=>w.method==='PATCH')).toHaveLength(1);
});


test('Matter message deep links preserve safe originating list context',async({page})=>{
 await setup(page);
 for(const origin of ['/home','/work?section=applications&appQuery=discovery&appPage=2','https://example.com']){
  await page.goto(`/paralegal-v2.html#/matter/${MATTER}?tab=messages&returnTo=${encodeURIComponent(origin)}`);
  await page.reload();
  await expect(page.locator('.av2-inbox-workspace')).toHaveAttribute('data-state','ready');
  const href=await page.getByRole('link',{name:'View Matter',exact:true}).getAttribute('href');
  const query=new URLSearchParams(href.split('?')[1]);
  expect(href.split('?')[0]).toBe(`#/matter/${MATTER}`);
  expect(query.get('tab')).toBe('overview');
  expect(query.get('returnTo')).toBe(origin.startsWith('https:')?null:origin);
 }
});
