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
 const calls=[];const state={history,historyStatus,restart:null,send:null,escalate:null,feedback:null};
 await page.evaluate(owner=>sessionStorage.setItem('lpc_support_session_user',owner),OWNER);
 await page.route('**/api/support/**',async route=>{
  const req=route.request(),url=new URL(req.url());calls.push({path:url.pathname,method:req.method(),query:Object.fromEntries(url.searchParams),body:req.postData()?req.postDataJSON():null});
  if(url.pathname==='/api/support/conversation')return json(route,{ok:true,conversation});
  if(url.pathname===`/api/support/conversation/${CONVERSATION}/messages`&&req.method()==='GET')return json(route,{ok:state.historyStatus===200,conversation,messages:state.history},state.historyStatus);
  if(url.pathname.endsWith('/escalate'))return state.escalate?state.escalate(route):json(route,{error:'not configured'},503);
  if(url.pathname.endsWith('/feedback'))return state.feedback?state.feedback(route):json(route,{ok:true,message:{...oldAnswer,metadata:{feedback:{rating:req.postDataJSON().rating}}}});
  if(url.pathname.endsWith('/restart'))return state.restart?state.restart(route):json(route,{ok:true,request:{id:req.postDataJSON().requestId,action:'restart',state:'succeeded'},conversation:{...conversation,id:'888888888888888888888888'},messages:[]},201);
  if(url.pathname.endsWith('/messages')&&req.method()==='POST')return state.send?state.send(route):json(route,{ok:true,request:{id:req.postDataJSON().requestId,action:'send',state:'succeeded'},conversation,userMessage:{...oldUser,text:req.postDataJSON().text},assistantMessage:oldAnswer},201);
  return json(route,{ok:true});
 });
 const open=async()=>{await page.locator(role==='attorney'?'[data-av2-assistant]':'[data-v2-assistant-trigger]').click();await expect(ui(page).drawer).toHaveAttribute('aria-hidden','false');};
 return {...result,sessionState:result.state,state,calls,open};
}
async function restart(page){await page.getByRole('button',{name:'Open assistant options',exact:true}).click();await page.getByRole('menuitem',{name:'Start new conversation',exact:true}).click();}

module.exports={prepare,ui,conversation,oldUser,oldAnswer,CONVERSATION};
