const {test,expect,fixture:legacy}=require('../payment-summary/legacy-fixture');
const {fixture:shell,OWNER,OTHER,MATTER,json}=require('../assistant-completion/fixture');
const card={id:'pm_synthetic',type:'card',brand:'visa',last4:'4242',exp_month:12,exp_year:2029}, revision='a'.repeat(64);
async function cards(page,account,{saved=true}={}) {
 const state={account,current:saved?card:null,starts:[],saves:[],portals:[],reads:[],status:'succeeded',defaultStatus:200,portalStatus:200,url:'https://billing.stripe.com/p/session/synthetic',pending:null};
 await page.route('**/api/payments/config',route=>json(route,{publishableKey:'pk_test_synthetic'}));
 await page.route('**/api/payments/payment-method/default**',async route=>{
  const request=route.request();state.reads.push(request.method());
  if(request.method()==='POST'){state.saves.push(request.postDataJSON());state.current=card;return state.saveRespond?state.saveRespond(route):json(route,{ok:true,paymentMethod:card});}
  return state.defaultRespond?state.defaultRespond(route):json(route,{customerId:'cus_synthetic',hasDefault:!!state.current,paymentMethod:state.current},state.defaultStatus);
 });
 await page.route('**/api/payments/payment-method/setup-intent',route=>{state.starts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});return state.startRespond?state.startRespond(route):json(route,{intentId:'seti_synthetic',clientSecret:'seti_synthetic_secret_synthetic'});});
 await page.route('**/api/payments/payment-method/setup-intent/seti_synthetic?**',route=>{state.reads.push('setup');return json(route,{ownerId:OWNER,intentId:'seti_synthetic',status:state.status,paymentMethod:state.status==='succeeded'?card:null});});
 await page.route('**/api/payments/portal/attorney',route=>{state.portals.push({body:route.request().postDataJSON(),csrf:route.request().headers()['x-csrf-token']});return state.portalRespond?state.portalRespond(route):json(route,{ownerId:OWNER,url:state.url},state.portalStatus);});
 await page.route('**/api/users/me/pending-hire?**',route=>json(route,{ownerId:OWNER,revision,pending:state.pending}));
 await page.route('**/api/payments/attorney-financial-history?**',route=>json(route,{ownerId:OWNER,revision,view:'all',q:'',caseId:null,entries:[],total:0,nextCursor:null,summary:{currencies:[],requiresReview:0,pending:0,undated:0}}));
 await page.addInitScript(()=>{
  window.syntheticCards={entries:[],appearances:[],confirmations:0};
  window.Stripe=()=>({elements:options=>{window.syntheticCards.appearances.push(options.appearance);return {create:()=>{
   const entry={events:{},destroyed:false};window.syntheticCards.entries.push(entry);let host;
   return {on:(name,fn)=>entry.events[name]=fn,mount:target=>{host=target;const label=document.createElement('label'),input=document.createElement('input');label.textContent='Synthetic provider card entry';input.addEventListener('input',()=>entry.events.change?.({complete:input.value==='4242',empty:!input.value}));label.append(input);host.append(label);entry.events.ready?.();},destroy:()=>{entry.destroyed=true;host?.replaceChildren();}};
  }};},confirmSetup:async()=>{window.syntheticCards.confirmations++;return {setupIntent:{id:'seti_synthetic',status:'succeeded'}};}});
 });return state;
}
async function original(page,{theme='light',...options}={}){
 let state;await legacy(page,{theme,setup:async account=>{state=await cards(page,account,options);}});
 const panel=page.locator('[data-payment-card]');await expect(panel).toHaveAttribute('data-state','ready');return {state,panel};
}
async function setup(page,{theme='light',...options}={}){
 let state;await shell(page,'attorney',{hash:'/payments/setup',setup:async account=>{account.user.preferences.theme=theme;account.user.onboarding.attorneyTourCompleted=true;state=await cards(page,account,options);}});
 const panel=page.getByRole('region',{name:'Payment card details',exact:true});await expect(panel).toHaveAttribute('data-state','ready');return {state,panel};
}
module.exports={test,expect,original,setup,card,OWNER,OTHER,MATTER,json};
