const {test}=require('./shell-fixture');
const {expect}=require('playwright/test');
const {json}=require('./fixture');
const {prepare,ui,conversation,oldUser,oldAnswer}=require('./flows-fixture');
for(const role of ['attorney','paralegal']) {
 test(`${role}: keyboard history retry retains a useful focus target`,async({page})=>{
  const {state,open}=await prepare(page,role,{historyStatus:503});await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  const retry=ui(page).status.getByRole('button',{name:'Try again',exact:true});await retry.focus();state.historyStatus=200;await retry.press('Enter');
  await expect(ui(page).thread).toContainText(oldAnswer.text);await expect(ui(page).composer).toBeFocused();
 });
 test(`${role}: feedback preserves keyboard focus after the message row is redrawn`,async({page})=>{
  const {open}=await prepare(page,role);await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  const helpful=ui(page).thread.getByRole('button',{name:'Helpful',exact:true});await helpful.focus();await helpful.press('Enter');
  await expect(helpful).toHaveAttribute('aria-pressed','true');await expect(helpful).toBeFocused();await expect(ui(page).thread).toContainText(oldAnswer.text);
 });
 test(`${role}: completed escalation shows its reference and current user-facing status`,async({page},testInfo)=>{
  const offered={...oldAnswer,metadata:{provider:`openai_manager_${role}`,needsEscalation:true,escalation:{available:true,reason:'request_human_help'}}};
  const {state,open,calls}=await prepare(page,role,{history:[oldUser,offered]});
  const sent={...offered,metadata:{...offered.metadata,escalation:{requested:true,ticketReference:'LPC-TEST-204',ticketStatus:'waiting_on_info'}}};
  state.escalate=route=>json(route,{ok:true,conversation:{...conversation,escalation:{requested:true,ticketReference:'LPC-TEST-204'}},assistantMessage:sent},201);
  await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');await ui(page).thread.getByRole('button',{name:'Send to the team',exact:true}).click();
  await expect(ui(page).thread).toContainText('Sent to the team for review.');
  await expect(ui(page).thread).toContainText('LPC-TEST-204');await expect(ui(page).thread).toContainText('Waiting for your reply');
  expect(calls.filter(x=>x.path.endsWith('/escalate'))).toHaveLength(1);await expect(ui(page).thread.getByRole('button',{name:'Send to the team',exact:true})).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('escalation-reference.png'),fullPage:true});
 });
}
for(const role of ['attorney','paralegal']) {
 test(`${role}: history updates keep the reader at their current message`,async({page})=>{
  const history=Array.from({length:30},(_,i)=>({...oldAnswer,id:(900+i).toString(16).padStart(24,'0'),text:`Earlier answer ${i}. ${'Retained context for review. '.repeat(8)}`}));
  const {state,open}=await prepare(page,role,{history});let release;const gate=new Promise(resolve=>release=resolve);state.feedback=async route=>{await gate;return json(route,{ok:true,message:{...history.at(-1),metadata:{feedback:{rating:'helpful'}}}});};
  await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  await expect.poll(()=>ui(page).thread.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeGreaterThan(1000);
  const helpful=ui(page).thread.getByRole('button',{name:'Helpful',exact:true});await helpful.focus();await helpful.press('Enter');await expect(helpful).toBeDisabled();await ui(page).thread.evaluate(el=>el.scrollTop=0);release();
  await expect(helpful).toHaveAttribute('aria-pressed','true');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  expect(await ui(page).thread.evaluate(el=>el.scrollTop)).toBeLessThan(100);
 });
 test(`${role}: finishing feedback does not steal focus from newer composer input`,async({page})=>{
  const {state,open}=await prepare(page,role);await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');let release;const gate=new Promise(r=>release=r);
  state.feedback=async route=>{await gate;return json(route,{ok:true,message:{...oldAnswer,metadata:{feedback:{rating:'helpful'}}}});};
  const helpful=ui(page).thread.getByRole('button',{name:'Helpful',exact:true});await helpful.focus();
  try {await helpful.press('Enter');await expect(helpful).toBeDisabled();await ui(page).composer.fill('New draft while feedback is saved');} finally {release();}
  await expect(helpful).toHaveAttribute('aria-pressed','true');await expect(ui(page).composer).toBeFocused();await expect(ui(page).composer).toHaveValue('New draft while feedback is saved');
 });
}

for(const role of ['attorney','paralegal']) {
 test(`${role}: only the latest substantive answer has copy and rating controls`,async({page})=>{
  const welcome={...oldAnswer,id:'aaaaaaaaaaaaaaaaaaaaaaa1',text:'Welcome back, Dana.',metadata:{kind:'welcome'}};
  const earlier={...oldAnswer,id:'aaaaaaaaaaaaaaaaaaaaaaa2'};
  const clarification={...oldAnswer,id:'aaaaaaaaaaaaaaaaaaaaaaa3',text:'Which Matter do you mean?',metadata:{kind:'assistant_reply',responseMode:'CLARIFY_ONCE',awaitingField:'case_identifier',suggestedReplies:['This case']}};
  const confirmation={...oldAnswer,id:'aaaaaaaaaaaaaaaaaaaaaaa4',text:"Glad that's sorted.",metadata:{kind:'assistant_reply',primaryAsk:'issue_resolved'}};
  const {state,open,calls}=await prepare(page,role,{history:[welcome,oldUser,earlier,oldAnswer,clarification,confirmation]});
  await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  await expect(ui(page).thread.locator('.support-message-utilities')).toHaveCount(1);
  const answer=page.locator(`[data-support-message-id="${oldAnswer.id}"]`);
  await expect(answer.getByRole('button',{name:'Copy',exact:true})).toBeVisible();
  await answer.getByRole('button',{name:'Not helpful',exact:true}).click();
  await expect(answer.getByRole('button',{name:'Not helpful',exact:true})).toHaveAttribute('aria-pressed','true');
  expect(calls.find(c=>c.path.endsWith('/feedback')).body).toEqual(expect.objectContaining({rating:'unhelpful'}));
  const next={...oldAnswer,id:'aaaaaaaaaaaaaaaaaaaaaaa5',text:'Your Matter files are available from the Files tab.'};
  state.send=route=>json(route,{ok:true,request:{id:route.request().postDataJSON().requestId,action:'send',state:'succeeded'},conversation,userMessage:{...oldUser,id:'aaaaaaaaaaaaaaaaaaaaaaa6',text:'Where are my files?'},assistantMessage:next},201);
  await ui(page).composer.fill('Where are my files?');await ui(page).composer.press('Enter');
  await expect(page.locator(`[data-support-message-id="${next.id}"] .support-message-utilities`)).toHaveCount(1);
  await expect(answer.locator('.support-message-utilities')).toHaveCount(0);
  await expect(ui(page).thread.locator('.support-message-utilities')).toHaveCount(1);
 });
 test(`${role}: a greeting-only conversation has no rating or copy controls`,async({page})=>{
  const {open}=await prepare(page,role,{history:[{...oldAnswer,metadata:{kind:'welcome'},text:'Welcome back, Dana.'}]});
  await open();await expect(ui(page).drawer).toHaveAttribute('aria-busy','false');
  await expect(ui(page).thread.locator('.support-message-utilities')).toHaveCount(0);
 });
}
