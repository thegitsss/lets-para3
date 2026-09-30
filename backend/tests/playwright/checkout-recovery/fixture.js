const {test}=require('../assistant-completion/shell-fixture');
const {expect}=require('playwright/test');
const {fixture:shell,OWNER,MATTER,json}=require('../assistant-completion/fixture');
async function fixture(page,{theme='light'}={}) {
 const funding={ownerId:OWNER,caseId:MATTER,caseTitle:'River Street original payment',revision:'a'.repeat(64),state:'needs_review',blockers:['payment_reference_needs_review'],fundingVerified:false,verifiedAt:null,baseCents:40000,feeCents:8800,totalCents:48800,currency:'USD',feePct:22,paralegalName:null,hasOriginalCheckout:true,canPrepare:false,canCheck:false,canEditAmount:false,closed:false,operation:null};
 const state={funding,checkout:{ownerId:OWNER,caseId:MATTER,fundingRevision:funding.revision,revision:'b'.repeat(64),sessionId:'cs_test_original',state:'available',canResume:true,fundingVerified:false,totalCents:48800,currency:'USD',expiresAt:new Date(Date.now()+1800000).toISOString(),privateNote:'PRIVATE'},reads:[],posts:[],status:200,resumeStatus:200,url:'https://checkout.stripe.com/c/pay/cs_test_original#synthetic',hold:null};
 const result=await shell(page,'attorney',{hash:`/matters/${MATTER}/financials`,setup:async account=>{
  state.account=account;account.user.preferences.theme=theme;account.user.onboarding.attorneyTourCompleted=true;
  await page.route(`**/api/payments/matter/${MATTER}/funding?**`,route=>json(route,state.funding));
  await page.route(`**/api/payments/matter/${MATTER}/checkout?**`,route=>{state.reads.push(Object.fromEntries(new URL(route.request().url()).searchParams));return state.hold?state.hold(route):json(route,state.checkout,state.status);});
  await page.route(`**/api/payments/matter/${MATTER}/checkout/resume`,route=>{state.posts.push({body:route.request().postDataJSON(),csrf:route.request().headers()['x-csrf-token']});return json(route,{checkout:state.checkout,url:state.url},state.resumeStatus);});
  await page.route('**/api/payments/attorney-financial-history?**',route=>json(route,{ownerId:OWNER,revision:'f'.repeat(64),view:'all',q:'',caseId:MATTER,total:0,entries:[],nextCursor:null,summary:{currencies:[],requiresReview:0,pending:0,undated:0}}));
 }});
 const panel=page.locator('[data-workspace-funding]');await expect(panel).toHaveAttribute('data-state','ready');return {...result,state,panel};
}
const inspect=async panel=>{await panel.getByRole('button',{name:'Review original Checkout',exact:true}).click();await expect(panel.getByRole('button',{name:'Refresh payment status',exact:true})).toBeVisible();};
module.exports={test,expect,fixture,inspect,OWNER,MATTER,json};
