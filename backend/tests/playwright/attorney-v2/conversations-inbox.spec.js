const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const AxeBuilder=require('@axe-core/playwright').default;
const {install,fixtures,objectId}=require('./home-summaries-fixture');
const {OWNER,workspaceMatter}=require('../assistant-completion/fixture');
const fulfill=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
const panel=page=>page.locator('[data-workspace-messages]');
async function setup(page,{count=3,lost=false,closed=false}={}){
 const data=fixtures(),state={messages:new Map(),writes:[],reads:[],mutations:[],rejected:false,lost,unrecorded:false,failList:false};
 const row=(caseId,n,text,own=false)=>({_id:objectId(1000+n),caseId,senderId:{_id:own?OWNER:objectId(999),firstName:own?'Dana':'Sam',lastName:own?'Young':'Rivera'},senderRole:own?'attorney':'paralegal',type:'text',text,createdAt:new Date(Date.UTC(2026,8,20,12,n)).toISOString(),revision:'d'.repeat(64),reactions:{},readBy:[],pinned:false});
 data.threads={total:4,threads:Array.from({length:4},(_,i)=>({id:objectId(i+1),title:`Matter ${i+1}`,participant:{id:objectId(999),name:`Sam Rivera ${i+1}`,role:'paralegal'},lastMessageSnippet:'Latest message',lastSenderName:'Sam',unread:i===3?1:0,updatedAt:'2026-09-20T12:00:00Z'}))};
 const summaries=()=>{data.summary={items:data.threads.threads.map(t=>({caseId:t.id,unread:t.unread}))};data.unread={count:data.threads.threads.reduce((sum,t)=>sum+t.unread,0)};};summaries();
 for(const thread of data.threads.threads)state.messages.set(thread.id,Array.from({length:count},(_,i)=>row(thread.id,i+1,`${thread.title} message ${i+1}`,i===count-1)));
 await install(page,data,['messages']);
 await page.route('**/api/cases/*?*',route=>{
  const caseId=new URL(route.request().url()).pathname.split('/')[3];if(!state.messages.has(caseId))return route.fallback();
  if(state.rejected)return fulfill(route,{},403);
  const matter={...workspaceMatter(),_id:caseId,title:`Matter ${Number.parseInt(caseId,16)}`,status:closed?'completed':'in progress',readOnly:closed};
  matter.matterExperience.overview={paralegal:'Sam Rivera'};matter.matterExperience.header.status={label:closed?'Completed':'In progress'};
  return fulfill(route,matter);
 });
 const read=route=>{
  const url=new URL(route.request().url()),caseId=url.pathname.includes('retained-messages')?url.pathname.split('/')[3]:url.pathname.split('/')[3];
  if(state.rejected)return fulfill(route,{},403);
  let rows=state.messages.get(caseId).filter(m=>!m.deleted);
  if(url.searchParams.has('clientMessageId'))rows=rows.filter(m=>m.clientMessageId===url.searchParams.get('clientMessageId'));
  if(url.searchParams.has('cursor'))rows=rows.slice(0,Number(url.searchParams.get('cursor')));
  return fulfill(route,{caseId,messages:rows.slice(-50),nextCursor:rows.length>50?String(rows.length-50):null,targetMissing:false,writable:!closed,...(closed?{retained:true}:{})});
 };
 await page.route('**/api/messages/*?*',route=>state.messages.has(new URL(route.request().url()).pathname.split('/')[3])?read(route):route.fallback());
 await page.route('**/api/cases/*/retained-messages?*',read);
 await page.route('**/api/messages/*',route=>{
  if(route.request().method()!=='POST')return route.fallback();
  const caseId=new URL(route.request().url()).pathname.split('/')[3],body=route.request().postDataJSON();state.writes.push(body);expect(body.expectedOwnerId).toBe(OWNER);
  const rows=state.messages.get(caseId);let saved=rows.find(m=>m.clientMessageId===body.clientMessageId);
  if(!saved&&!state.unrecorded){saved={...row(caseId,rows.length+1,body.text,true),clientMessageId:body.clientMessageId};rows.push(saved);const thread=data.threads.threads.find(t=>t.id===caseId);thread.lastMessageSnippet=body.text;thread.lastSenderName='You';}
  if(state.lost||state.unrecorded)return route.abort('failed');return fulfill(route,{message:saved},201);
 });
 await page.route('**/api/messages/*/*',route=>{
  const parts=new URL(route.request().url()).pathname.split('/'),caseId=parts[3],messageId=parts[4],body=route.request().postDataJSON();
  if(messageId==='read'){state.reads.push(body);if(state.readError)return fulfill(route,{},state.readError);data.threads.threads.find(t=>t.id===caseId).unread=0;summaries();return fulfill(route,{updatedLegacy:1,updatedReceipts:1});}
  const message=state.messages.get(caseId).find(m=>m._id===messageId);state.mutations.push(body);
  if(message.revision!==body.reviewedRevision)return fulfill(route,{},409);
  if(route.request().method()==='DELETE')message.deleted=true;
  else {if(body.content)message.text=body.content;if(body.pin)message.pinned=true;if(body.unpin)message.pinned=false;}
  message.revision='e'.repeat(64);return fulfill(route,{ok:true});
 });
 await page.route('**/api/messages/*/*/react',route=>{
  const parts=new URL(route.request().url()).pathname.split('/'),body=route.request().postDataJSON(),message=state.messages.get(parts[3]).find(m=>m._id===parts[4]);
  message.reactions=route.request().method()==='DELETE'?{}:{[body.emoji]:[OWNER]};return fulfill(route,{ok:true});
 });
 await page.locator('.av2-nav').getByRole('link',{name:'Messages',exact:true}).click();
 await expect(panel(page)).toHaveAttribute('data-state','ready');
 await page.locator('.av2-inbox-workspace').evaluate(element=>element.readiness);
 return {data,state,row};
}
test('Home reaches all four; inbox switches threads, searches, filters unread, preserves drafts and reloads selection',async({page})=>{
 const {state}=await setup(page);
 await expect(page.locator('.av2-thread-link')).toHaveCount(4);
 await expect(page.locator('[data-av2-route="conversations"]')).toHaveAttribute('aria-current','page');
 const input=page.getByRole('textbox',{name:'Message to the paralegal'});
 await input.fill('Keep this draft');await page.locator('.av2-thread-link').nth(1).click();await expect(input).toHaveValue('');
 await page.locator('.av2-thread-link').first().click();await expect(input).toHaveValue('Keep this draft');
 await page.getByRole('searchbox',{name:'Search conversations'}).fill('Matter 4');await expect(page.locator('.av2-thread-link')).toHaveCount(1);
 await page.getByRole('searchbox',{name:'Search conversations'}).fill('');await page.getByRole('button',{name:'Unread 1',exact:true}).click();await expect(page.locator('.av2-thread-link')).toHaveCount(1);
 await page.locator('.av2-thread-link').click();await expect(page.locator('#av2-thread-title')).toHaveText('Matter 4');
 await expect(page.getByText('You’re caught up. No unread conversations.')).toBeVisible();
 await page.getByRole('button',{name:'All',exact:true}).click();await expect(page.locator('.av2-thread-link')).toHaveCount(4);
 await page.reload();await expect(page.locator('#av2-thread-title')).toHaveText('Matter 4');await expect(panel(page)).toHaveAttribute('data-state','ready');
 await expect(page.getByRole('link',{name:'View Matter',exact:true})).toHaveAttribute('href',`#/matters/${objectId(4)}/overview`);
 await expect(page.getByRole('button',{name:'Attach document',exact:true})).toBeVisible();expect(state.writes).toHaveLength(0);
 await page.locator('.av2-nav').getByRole('link',{name:'Home',exact:true}).click();
 const home=page.locator('[data-av2-region="messages"]');await expect(home.locator('li')).toHaveCount(3);await home.getByRole('button',{name:'View All'}).click();await expect(home.locator('li')).toHaveCount(4);await home.getByRole('button',{name:'Show fewer'}).click();await expect(home.locator('li')).toHaveCount(3);await home.locator('li a').first().click();await expect(page.locator('#av2-thread-title')).toHaveText('Matter 1');
});
test('send confirms once, updates preview, and edit, pin, reaction and delete operate on the selected thread',async({page})=>{
 const {state}=await setup(page);const input=page.getByRole('textbox',{name:'Message to the paralegal'});
 await input.fill('Please keep the signed exhibit.');await input.press('ControlOrMeta+Enter');
 await expect(panel(page)).toContainText('Message sent.');expect(state.writes).toHaveLength(1);await expect(input).toHaveValue('');
 await expect(page.locator('.av2-thread-link').first()).toContainText('You: Please keep the signed exhibit.');
 const own=page.locator('.av2-conversation >li[data-message-id]').last();await own.locator('summary').click();await own.getByRole('button',{name:'Edit',exact:true}).click();
 await page.getByRole('textbox',{name:'Message text',exact:true}).fill('Please keep both exhibits.');await page.getByRole('button',{name:'Save message'}).click();await expect(own).toContainText('Please keep both exhibits.');
 await own.locator('summary').click();await own.getByRole('button',{name:'Pin',exact:true}).click();await expect(own).toContainText('Pinned message');
 await own.locator('summary').click();await own.getByRole('button',{name:'Add 👍 reaction'}).click();await expect(panel(page)).toContainText('Reaction updated.');await own.locator('summary').click();await expect(own.getByRole('button',{name:'Remove 👍 reaction'})).toBeVisible();
 await own.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Keep message'}).click();await expect(own).toContainText('Please keep both exhibits.');
 await own.locator('summary').click();await own.getByRole('button',{name:'Delete',exact:true}).click();await page.getByRole('button',{name:'Delete message',exact:true}).click();await expect(page.locator('.av2-conversation')).not.toContainText('Please keep both exhibits.');
});
test('a lost send response reconciles without a duplicate; an unrecorded send retries the same id',async({page})=>{
 const {state}=await setup(page,{lost:true});const input=page.getByRole('textbox',{name:'Message to the paralegal'});
 await input.fill('Recorded despite lost response');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(panel(page)).toContainText('Message sent.');expect(state.writes).toHaveLength(1);
 state.lost=false;state.unrecorded=true;await input.fill('Retry safely');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('button',{name:'Retry same message'})).toBeVisible();
 state.unrecorded=false;await page.getByRole('button',{name:'Retry same message'}).click();await expect(panel(page)).toContainText('Message sent.');expect(state.writes[1].clientMessageId).toBe(state.writes[2].clientMessageId);
});
test('earlier history remains reachable, background refresh preserves the composer, and access loss clears it',async({page})=>{
 const {state,row}=await setup(page,{count:55});await expect(page.locator('.av2-conversation >li[data-message-id]')).toHaveCount(50);
 await page.getByRole('button',{name:'Show earlier messages'}).click();await expect(page.locator('.av2-conversation >li[data-message-id]')).toHaveCount(55);
 const input=page.getByRole('textbox',{name:'Message to the paralegal'});await input.fill('Retain while refreshing');
 state.messages.get(objectId(1)).push(row(objectId(1),56,'New incoming message'));
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.locator('.av2-conversation')).toContainText('New incoming message');await expect(input).toHaveValue('Retain while refreshing');
 state.rejected=true;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.getByText('This Matter is no longer available to your account.')).toBeVisible({timeout:20000});await expect(input).toHaveCount(0);
});
test('empty, failed and recovered reads are distinct; the list follows all result pages',async({page})=>{
 const d=fixtures();await install(page,d,['messages']);await page.locator('.av2-nav').getByRole('link',{name:'Messages',exact:true}).click();await expect(page.getByText('No Matter conversations yet.')).toBeVisible();
 d.threads={httpError:500};await page.reload();await expect(page.getByRole('button',{name:'Retry conversations'})).toBeVisible();await expect(page.getByText('No Matter conversations yet.')).toHaveCount(0);
 d.threads={total:0,threads:[]};await page.getByRole('button',{name:'Retry conversations'}).click();await expect(page.getByText('No Matter conversations yet.')).toBeVisible();
 await page.route('**/api/messages/threads?*',r=>{const second=new URL(r.request().url()).searchParams.get('page')==='2';return fulfill(r,{total:4,threads:Array.from({length:2},(_,i)=>({id:objectId(i+(second?3:1)),title:'Paged matter',unread:0}))});});
 await page.reload();await expect(page.locator('.av2-thread-link')).toHaveCount(4);
});
test('retained conversations are readable but cannot send or change messages',async({page})=>{
 await setup(page,{closed:true});await expect(page.locator('.av2-conversation >li[data-message-id]')).toHaveCount(3);await expect(page.getByRole('textbox',{name:'Message to the paralegal'})).toHaveCount(0);await expect(page.getByText('Retained correspondence. This conversation is closed to new messages and changes.')).toBeVisible();
});
test('attachment download preserves the reviewed message and handles unavailable storage',async({page})=>{
 const {state,row}=await setup(page);const msg={...row(objectId(1),4,'',false),type:'file',fileName:'Exhibit.pdf',hasAttachment:true};state.messages.get(objectId(1)).push(msg);
 await page.route('**/api/cases/*/message-attachments/*?*',route=>{expect(new URL(route.request().url()).searchParams.get('revision')).toBe(msg.revision);return route.fulfill({status:200,contentType:'application/octet-stream',body:'%PDF synthetic attachment'});});
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.getByRole('button',{name:'Download attachment'})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download attachment'}).click();await expect(panel(page)).toContainText('Attachment download started.');expect((await download).suggestedFilename()).toBe('Exhibit.pdf');
 await page.route('**/api/cases/*/message-attachments/*?*',route=>fulfill(route,{},404));await page.getByRole('button',{name:'Download attachment'}).click();await expect(page.getByText('This attachment is no longer available.')).toBeVisible();
});
test('desktop geometry, keyboard focus and accessibility; mobile offers a list and back navigation',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await setup(page,{count:55});
 const lastMessage=page.locator('.av2-conversation >li[data-message-id]').last();
 await lastMessage.locator('p.av2-preserve-lines').click();await expect(lastMessage).toHaveCSS('outline-style','none');
 await page.keyboard.press('Tab');await expect(lastMessage.locator('summary')).toBeFocused();await expect(lastMessage.locator('summary')).toHaveCSS('outline-style','solid');
 await panel(page).evaluate(e=>e.sync());await expect(lastMessage.locator('summary')).toBeFocused();
 await page.locator('.av2-conversation >li[data-message-id]').last().locator('summary').click();
 await expect.poll(()=>page.locator('.av2-conversation >li[data-message-id]').last().locator('.av2-context-options').evaluate(el=>{const menu=el.getBoundingClientRect(),list=el.closest('ol').getBoundingClientRect();return menu.top>=list.top&&menu.bottom<=list.bottom;})).toBe(true);
 await page.keyboard.press('Escape');
 const bounds=await page.locator('.av2-message-composer').boundingBox();expect(bounds.y+bounds.height).toBeLessThan(1000);
 const desktop=await new AxeBuilder({page}).include('.av2-conversations-page').analyze();expect(desktop.violations).toEqual([]);
 await page.screenshot({path:'outputs/attorney-v2-conversations/fixture-desktop.png'});
 await page.setViewportSize({width:390,height:844});await expect(page.getByRole('button',{name:'← Messages'})).toBeVisible();await page.getByRole('button',{name:'← Messages'}).click();await expect(page.getByRole('searchbox',{name:'Search conversations'})).toBeFocused();
 await page.locator('.av2-thread-link').nth(1).click();await expect(page.locator('#av2-thread-title')).toHaveText('Matter 2');await expect(page.locator('.av2-inbox-sidebar')).not.toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const mobile=await new AxeBuilder({page}).include('.av2-conversations-page').analyze();expect(mobile.violations).toEqual([]);
 await page.screenshot({path:'outputs/attorney-v2-conversations/fixture-mobile.png'});
});

test('server-confirmed receipts avoid repeated read writes; failed acknowledgements expose a working retry',async({page})=>{
 const {state,row}=await setup(page);
 state.messages.get(objectId(1)).forEach(message=>message.readBy=[OWNER]);
 await page.locator('.av2-thread-link').nth(1).click();await page.locator('.av2-inbox-workspace').evaluate(element=>element.readiness);
 const before=state.reads.length;await page.locator('.av2-thread-link').first().click();await page.locator('.av2-inbox-workspace').evaluate(element=>element.readiness);expect(state.reads).toHaveLength(before);
 state.readError=429;state.messages.get(objectId(1)).push(row(objectId(1),10,'A new unread reply'));
 await page.locator('.av2-thread-link').nth(2).click();await page.locator('.av2-inbox-workspace').evaluate(element=>element.readiness);
 await page.locator('.av2-thread-link').first().click();await expect(panel(page)).toHaveAttribute('data-state','error');await expect(page.getByRole('button',{name:'Retry messages',exact:true})).toBeVisible();
 state.readError=0;await page.getByRole('button',{name:'Retry messages',exact:true}).click();await expect(panel(page)).toHaveAttribute('data-state','ready');await expect(page.getByRole('button',{name:'Retry messages',exact:true})).toBeHidden();await expect(panel(page)).not.toContainText('read status could not be saved');
});

async function uploads(page,state){
 const saved={id:objectId(400),name:'Exhibit.txt',revision:'c'.repeat(64),reviewRevision:'d'.repeat(64),size:20,version:1,uploadedAt:null,securityStatus:'pending',status:'pending_review',uploadedByRole:'attorney',notes:'',requestedAt:null,approvedAt:null,replacedAt:null,revisionOf:null,mimeType:'text/plain',canReview:false};
 state.uploadWrites=0;state.uploadRequests=[];state.uploadResult=null;state.uploadRevision='a'.repeat(64);state.uploadAllowed=true;
 await page.route('**/api/uploads/case/*/upload-review?*',route=>{const url=new URL(route.request().url()),caseId=url.pathname.split('/')[4],requestId=url.searchParams.get('requestId');if(requestId)state.uploadRequests.push(requestId);return fulfill(route,{caseId,ownerId:OWNER,revision:state.uploadRevision,canUpload:state.uploadAllowed,upload:requestId?state.uploadResult||{status:'missing',file:null,retryAllowed:true}:null});});
 await page.route('**/api/uploads/case/*/reviewed-upload',route=>{state.uploadWrites++;if(state.uploadFailure){state.uploadResult={status:'failed',file:null,retryAllowed:true};return fulfill(route,{},503);}state.uploadResult={status:'recorded',file:saved,retryAllowed:false};return state.uploadLost?route.abort('failed'):fulfill(route,state.uploadResult);});
 state.fileMessages=[];
 await page.route('**/api/messages/*/file',route=>{
  const body=route.request().postDataJSON(),caseId=new URL(route.request().url()).pathname.split('/')[3];state.fileMessages.push(body);
  if(state.scanPending)return fulfill(route,{code:'FILE_SCAN_PENDING'},423);
  if(state.fileBlocked)return fulfill(route,{},422);
  let message=state.messages.get(caseId).find(m=>m.clientMessageId===body.clientMessageId);
  if(!message){message={_id:objectId(8000+state.fileMessages.length),caseId,senderId:OWNER,senderRole:'attorney',type:'file',text:saved.name,fileName:saved.name,hasAttachment:true,attachments:[{id:'primary',filename:saved.name,hasAttachment:true,audioMimeType:null,size:saved.size}],createdAt:'2026-09-24T12:00:00Z',revision:'e'.repeat(64),reactions:{},readBy:[],clientMessageId:body.clientMessageId};state.messages.get(caseId).push(message);}
  return state.fileMessageLost?route.abort('failed'):fulfill(route,{message});
 });
 return saved;
}
test('participant search, daily separators, time labels and grouped messages have a clear hierarchy',async({page})=>{
 await setup(page,{count:5});
 await expect(page.locator('.av2-thread-person')).toHaveText(['Sam Rivera 1','Sam Rivera 2','Sam Rivera 3','Sam Rivera 4']);
 await page.getByRole('searchbox',{name:'Search conversations'}).fill('Rivera 3');await expect(page.locator('.av2-thread-link')).toHaveCount(1);await page.locator('.av2-thread-link').click();await expect(page.locator('#av2-thread-title')).toHaveText('Matter 3');
 await expect(page.locator('.av2-message-date')).toHaveCount(1);await expect(page.locator('.av2-message-continuation')).toHaveCount(3);
 const groupedGap=await page.locator('.av2-message-continuation').first().evaluate(e=>e.getBoundingClientRect().top-e.previousElementSibling.getBoundingClientRect().bottom);
 expect(groupedGap).toBeGreaterThanOrEqual(3);expect(groupedGap).toBeLessThanOrEqual(5);
 await expect(page.locator('.av2-message-heading time').first()).not.toContainText('2026');await expect(page.locator('.av2-message-heading time').first()).toHaveAttribute('aria-label',/2026/);
 await expect(page.locator('.av2-thread-identity')).toContainText('Sam Rivera');await expect(page.locator('.av2-thread-identity [role=status]')).toBeEmpty();
});
test('a document is shared directly from the composer without losing text or leaving the thread',async({page})=>{
 const {state}=await setup(page);await uploads(page,state);const input=page.getByRole('textbox',{name:'Message to the paralegal'});await input.fill('Please review the attached exhibit.');const url=page.url();
 await page.getByRole('button',{name:'Attach document',exact:true}).click();const tray=page.locator('.av2-composer-attachments');await expect(tray.getByText('Choose document',{exact:true})).toBeVisible();
 await tray.locator('input[type=file]').setInputFiles({name:'Exhibit.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic exhibit')});
 await expect(tray).toContainText('Exhibit.txt');await expect(tray).toContainText('Ready to attach');await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeVisible();expect(state.uploadWrites).toBe(0);
 await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('.av2-attachment-tile')).toContainText('Exhibit.txt');await expect(input).toHaveValue('');await expect(tray).toBeHidden();
 expect(state.uploadWrites).toBe(1);expect(state.writes).toHaveLength(1);expect(state.writes[0].text).toBe('Please review the attached exhibit.');expect(page.url()).toBe(url);
 await page.getByRole('button',{name:'Attach document',exact:true}).click();await expect(tray.getByText('Choose document',{exact:true})).toBeVisible();expect(state.uploadWrites).toBe(1);

});
test('uncertain inline uploads reconcile before retry and invalid files cannot be shared',async({page})=>{
 const {state}=await setup(page);await uploads(page,state);await page.getByRole('button',{name:'Attach document',exact:true}).click();const tray=page.locator('.av2-composer-attachments');
 await tray.locator('input[type=file]').setInputFiles({name:'Bad.html',mimeType:'text/html',buffer:Buffer.from('<p>Bad</p>')});await expect(tray.getByRole('button',{name:'Review selected document'})).toBeDisabled();expect(state.uploadWrites).toBe(0);
 await tray.locator('input[type=file]').setInputFiles({name:'Exhibit.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic exhibit')});state.uploadLost=true;
 await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(tray).toContainText('could not be confirmed');await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
 await tray.getByRole('button',{name:'Check saved upload'}).click();await expect(page.locator('.av2-attachment-tile')).toContainText('Exhibit.txt');expect(state.uploadWrites).toBe(1);expect(state.uploadRequests[0]).toMatch(/^[a-f0-9-]{36}$/);
});
test('attachment panel fits a phone, stays keyboard accessible and clears when access is lost',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const {state}=await setup(page);await uploads(page,state);await page.getByRole('button',{name:'Attach document',exact:true}).click();const tray=page.locator('.av2-composer-attachments');
 await tray.locator('input[type=file]').setInputFiles({name:'Exhibit.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic exhibit')});await page.setViewportSize({width:390,height:844});
 const result=await new AxeBuilder({page}).include('.av2-conversations-page').analyze();expect(result.violations).toEqual([]);
 await expect(tray.getByRole('button',{name:'Remove attachment'})).toBeVisible();await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const bounds=await page.locator('.av2-message-composer').boundingBox();expect(bounds.y+bounds.height).toBeLessThanOrEqual(844);
 await page.screenshot({path:'outputs/attorney-v2-conversations/refined-attachment-mobile.png'});
 state.rejected=true;await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(tray).toHaveCount(0,{timeout:20000});expect(state.uploadWrites).toBe(0);
});

test('incoming messages preserve reading position and expose New messages; the composer grows without sending on Enter',async({page})=>{
 const {state,row}=await setup(page,{count:50});const history=page.locator('.av2-conversation');await history.evaluate(e=>e.scrollTop=140);
 const anchor=await history.locator('[data-message-id]').evaluateAll(es=>es.find(e=>e.getBoundingClientRect().bottom>e.parentElement.getBoundingClientRect().top)?.dataset.messageId);
 const y=await page.locator(`[data-message-id="${anchor}"]`).evaluate(e=>e.getBoundingClientRect().top),writes=state.reads.length;
 state.messages.get(objectId(1)).push(row(objectId(1),55,'New reply while reading earlier messages'));
 await panel(page).evaluate(e=>e.sync());await expect(page.getByRole('button',{name:'New messages ↓'})).toBeVisible();
 expect(Math.abs((await page.locator(`[data-message-id="${anchor}"]`).evaluate(e=>e.getBoundingClientRect().top))-y)).toBeLessThan(3);expect(state.reads.length).toBe(writes);
 await page.getByRole('button',{name:'New messages ↓'}).click();await expect.poll(()=>history.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)).toBeLessThan(4);
 const input=page.getByRole('textbox',{name:'Message to the paralegal'}),small=await input.evaluate(e=>e.clientHeight);await input.fill('First paragraph');await input.press('Enter');await input.type('Second paragraph\nThird paragraph\nFourth paragraph');expect(state.writes).toHaveLength(0);expect(await input.evaluate(e=>e.clientHeight)).toBeGreaterThan(small);await expect(input).toHaveValue(/First paragraph\nSecond/);
});

test('an uploaded attachment is a real file message and a lost message response recovers without another upload or message',async({page})=>{
 const {state}=await setup(page);await uploads(page,state);state.fileMessageLost=true;
 await page.getByRole('button',{name:'Attach document',exact:true}).click();const tray=page.locator('.av2-composer-attachments');await tray.locator('input[type=file]').setInputFiles({name:'Exhibit.txt',mimeType:'text/plain',buffer:Buffer.from('Evidence')});
 await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(tray).toContainText('Attachment delivery is not confirmed.');expect(state.uploadWrites).toBe(1);expect(state.fileMessages).toHaveLength(1);
 await tray.getByRole('button',{name:'Check and send attachment'}).click();await expect(tray).toBeHidden();await expect(page.locator('.av2-attachment-tile')).toContainText('Exhibit.txt');await expect(page.locator('.av2-attachment-tile')).toContainText('Exhibit.txt');await expect(page.locator('.av2-attachment-tile')).toContainText('20 B');expect(state.fileMessages).toHaveLength(1);expect(state.uploadWrites).toBe(1);
});

test('a pending file security check cannot look delivered and retry reuses the exact message request',async({page})=>{
 const {state}=await setup(page);await uploads(page,state);state.scanPending=true;
 await page.getByRole('button',{name:'Attach document',exact:true}).click();const tray=page.locator('.av2-composer-attachments');await tray.locator('input[type=file]').setInputFiles({name:'Exhibit.txt',mimeType:'text/plain',buffer:Buffer.from('Evidence')});await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(tray).toContainText('security check must finish');await expect(page.locator('.av2-attachment-tile')).toHaveCount(0);state.scanPending=false;await tray.getByRole('button',{name:'Check and send attachment'}).click();await expect(tray).toBeHidden();await expect(page.locator('.av2-attachment-tile')).toContainText('Exhibit.txt');expect(state.fileMessages).toHaveLength(2);expect(state.fileMessages[0].clientMessageId).toBe(state.fileMessages[1].clientMessageId);expect(state.uploadWrites).toBe(1);
});

test('Matter Messages and notification deep links use the same inbox and retain the draft',async({page})=>{
 await setup(page);const input=page.getByRole('textbox',{name:'Message to the paralegal'});await input.fill('Retain this when entering through the Matter.');await page.getByRole('link',{name:'View Matter',exact:true}).click();await page.getByRole('navigation',{name:'Matter sections'}).getByRole('link',{name:'Messages',exact:true}).click();await expect(page.locator('.av2-inbox')).toBeVisible();await expect(input).toHaveValue('Retain this when entering through the Matter.');
 const href=await page.evaluate(async()=>{const {notificationDestination}=await import('/assets/scripts/attorney-v2/routes.mjs');return notificationDestination({action:{href:'/case-detail.html?caseId=000000000000000000000001&tab=messages&messageId=0000000000000000000003e9'}},location.origin).href;});await page.evaluate(href=>{location.hash=new URL(href,location.origin).hash},href);await expect(page.locator('.av2-inbox')).toBeVisible();await expect(input).toHaveValue('Retain this when entering through the Matter.');
});

test('populated reference composition, long content and assistant-width layout',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});
 const {state,row}=await setup(page);const caseId=objectId(1);state.messages.set(caseId,[row(caseId,1,'I’ve finished reviewing the medical records. The chronology includes treatment dates, providers and source-page references.'),row(caseId,2,'I flagged two gaps in treatment for your review.'),{...row(caseId,3,'Medical chronology.pdf'),type:'file',fileName:'Medical chronology.pdf',attachments:[{id:'primary',filename:'Medical chronology.pdf',hasAttachment:true,audioMimeType:null,size:1258291}],hasAttachment:true},row(caseId,4,'Thank you. Please check the dates against the hospital discharge summary before we finalize.',true),row(caseId,5,'Of course. I’ll update the chronology and flag any discrepancies.'),{...row(caseId,6,'That works. Thank you.',true),reactions:{'👍':[objectId(999)]}}]);
 await panel(page).evaluate(e=>e.sync());await page.mouse.move(0,0);await page.evaluate(()=>document.activeElement?.blur());await expect(page.locator('.av2-attachment-tile')).toContainText('1.2 MB');await expect(page.locator('.av2-message-reactions')).toContainText('👍');
 await expect(page.locator('[data-message-id]').first().locator('summary')).toHaveCSS('opacity','0');await page.locator('[data-message-id]').first().hover();await expect(page.locator('[data-message-id]').first().locator('summary')).toHaveCSS('opacity','1');await page.mouse.move(0,0);await expect(page.locator('[data-message-id]').first().locator('summary')).toHaveCSS('opacity','0');
 await page.screenshot({path:'outputs/attorney-v2-conversations/composition-reference-desktop.png'});
 await page.locator('.av2-conversations-page').evaluate(e=>e.style.maxWidth='600px');await expect(page.locator('.av2-inbox-back')).toBeVisible();await expect(page.locator('.av2-inbox-sidebar')).not.toBeVisible();await page.locator('.av2-inbox-back').click();await expect(page.locator('.av2-inbox-sidebar')).toBeVisible();await page.locator('.av2-thread-link').first().click();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'outputs/attorney-v2-conversations/composition-reference-mobile.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const bounds=await page.locator('.av2-message-composer').boundingBox();expect(bounds.y+bounds.height).toBeLessThanOrEqual(844);
 const result=await new AxeBuilder({page}).include('.av2-conversations-page').analyze();expect(result.violations).toEqual([]);
});

test('long names, titles, messages and filenames wrap without clipping or horizontal scrolling',async({page})=>{
 const {data,state,row}=await setup(page);data.threads.threads[0].participant.name='Alexandria Verylongparticipantname'.repeat(4);data.threads.threads[0].title='Medicalmalpracticeanddiscovery'.repeat(10);
 const caseId=objectId(1),message={...row(caseId,11,'Unbrokenmessage'.repeat(90)),type:'file',fileName:'Expert_Report_'.repeat(25)+'.pdf',attachments:[{id:'primary',filename:'Expert_Report_'.repeat(25)+'.pdf',hasAttachment:true,audioMimeType:null,size:1024}],hasAttachment:true};state.messages.set(caseId,[row(caseId,9,'Unbrokenmessage'.repeat(90)),message]);
 await page.locator('.av2-conversations-page').evaluate(e=>e.refreshFromNotice());await panel(page).evaluate(e=>e.sync());
 for(const width of [320,390,1440]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.locator('.av2-inbox').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await expect(page.locator('.av2-attachment-tile')).toContainText(message.fileName);}
});

test('recovering an already deleted file message does not report a new delivery or duplicate the upload',async({page})=>{
 const {state}=await setup(page);await uploads(page,state);state.fileMessageLost=true;
 await page.getByRole('button',{name:'Attach document',exact:true}).click();const tray=page.locator('.av2-composer-attachments');await tray.locator('input[type=file]').setInputFiles({name:'Exhibit.txt',mimeType:'text/plain',buffer:Buffer.from('Evidence')});await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(tray).toContainText('Attachment delivery is not confirmed.');
 state.messages.get(objectId(1)).find(m=>m.type==='file').deleted=true;state.fileMessageLost=false;await tray.getByRole('button',{name:'Check and send attachment'}).click();await expect(tray).toContainText('already sent and has since been removed');await expect(page.locator('.av2-attachment-tile')).toHaveCount(0);expect(state.uploadWrites).toBe(1);expect(state.messages.get(objectId(1)).filter(m=>m.type==='file')).toHaveLength(1);
});

test('inline editing does not send a new message or losing the unsent draft; cancel and thread switching preserve both',async({page})=>{
 const {state}=await setup(page);const draft=page.getByRole('textbox',{name:'Message to the paralegal'}),own=page.locator('[data-message-own=true]').last();
 await draft.fill('My unsent follow-up');await own.locator('summary').click();await own.getByRole('button',{name:'Edit',exact:true}).click();
 const edit=page.getByRole('textbox',{name:'Message text',exact:true});await expect(page.locator('.av2-conversation textarea:visible')).toHaveCount(1);await expect(page.getByRole('textbox',{name:'Message to the paralegal'})).toBeDisabled();await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
 await edit.fill('Revised instruction');await page.locator('.av2-thread-link').nth(1).click();await page.locator('.av2-thread-link').first().click();await expect(edit).toHaveValue('Revised instruction');
 await edit.press('Escape');await expect(draft).toHaveValue('My unsent follow-up');expect(state.mutations).toHaveLength(0);expect(state.writes).toHaveLength(0);
 await own.locator('summary').click();await own.getByRole('button',{name:'Edit',exact:true}).click();await edit.fill('Revised instruction');await edit.press('ControlOrMeta+Enter');
 await expect(own).toContainText('Revised instruction');await expect(draft).toHaveValue('My unsent follow-up');expect(state.mutations).toHaveLength(1);expect(state.writes).toHaveLength(0);
 await own.locator('summary').click();await own.getByRole('button',{name:'Delete',exact:true}).click();await expect(page.getByRole('dialog',{name:'Delete this message?'})).toBeVisible();await page.keyboard.press('Escape');await expect(draft).toHaveValue('My unsent follow-up');expect(state.mutations).toHaveLength(1);
});

test('compact editing keeps stale text for review and preserves the separate new-message draft',async({page})=>{
 const {state}=await setup(page);const draft=page.getByRole('textbox',{name:'Message to the paralegal'}),own=page.locator('[data-message-own=true]').last();await draft.fill('Unsent draft');
 await own.locator('summary').click();await own.getByRole('button',{name:'Edit',exact:true}).click();const edit=page.getByRole('textbox',{name:'Message text'});await edit.fill('My correction');
 const message=state.messages.get(objectId(1)).at(-1);message.text='Saved in another tab';message.revision='a'.repeat(64);
 await page.getByRole('button',{name:'Save message',exact:true}).click();await expect(panel(page)).toContainText('This message changed.');await expect(edit).toHaveValue('My correction');
 await page.getByRole('button',{name:'Retry messages',exact:true}).click();await expect(panel(page)).toContainText('Current saved message: Saved in another tab');await page.getByRole('button',{name:'Review my edit against this message'}).click();await page.getByRole('button',{name:'Save message',exact:true}).click();
 await expect(own).toContainText('My correction');await expect(draft).toHaveValue('Unsent draft');expect(state.writes).toHaveLength(0);
});

test('compose, edit, delete and attachment selection stay compact and accessible on desktop and phone',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});const {state}=await setup(page);await uploads(page,state);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});const composer=page.locator('.av2-message-composer'),own=page.locator('[data-message-own=true]').last();
  await own.locator('summary').click();await own.getByRole('button',{name:'Edit',exact:true}).click();await expect(page.locator('.av2-conversation textarea:visible')).toHaveCount(1);await expect(page.getByRole('textbox',{name:'Message to the paralegal'})).toBeDisabled();
  expect((await composer.boundingBox()).height).toBeLessThan(155);expect((await new AxeBuilder({page}).include('.av2-conversations-page').analyze()).violations).toEqual([]);
  await page.screenshot({path:`outputs/attorney-v2-conversations/composer-edit-${width}.png`});await page.getByRole('button',{name:'Cancel edit'}).click();
  await own.locator('summary').click();await own.getByRole('button',{name:'Delete',exact:true}).click();expect((await composer.boundingBox()).height).toBeLessThan(155);await page.screenshot({path:`outputs/attorney-v2-conversations/composer-delete-${width}.png`});await page.getByRole('button',{name:'Keep message'}).click();
  await page.getByRole('button',{name:'Attach document',exact:true}).click();const tray=page.locator('.av2-composer-attachments');await tray.locator('input[type=file]').setInputFiles({name:'Exhibit.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic exhibit')});
  await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeVisible();expect((await composer.boundingBox()).height).toBeLessThan(280);await page.screenshot({path:`outputs/attorney-v2-conversations/composer-attachment-${width}.png`});await page.getByRole('button',{name:'Remove attachment'}).click();await page.getByRole('button',{name:'Close attachment panel'}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
 expect(state.uploadWrites).toBe(0);expect(state.mutations).toHaveLength(0);
});
