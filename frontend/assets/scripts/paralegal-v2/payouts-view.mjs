import { verifyParalegalSession } from './session-boundary.mjs';
import { readEarningsReport, readExpectedCompensation, renderEarningsReport, payoutMoney, payoutStates, payoutPresentation } from '../utils/paralegal-financials.mjs';
import { loadParalegalHistory } from '../utils/paralegal-history.mjs';
import { withMatterReturn } from './router.mjs';

const node=(tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined&&text!==null)element.textContent=text;if(className)element.className=className;return element;};
const link=(label,path)=>{const element=node('a',label,'pv2-payout-link');element.href=`paralegal-v2.html#${path}`;element.dataset.view=path;element.setAttribute('data-v2-route','');return element;};
const reasons=Object.freeze({
 matter_unavailable:'The Matter associated with this payout is unavailable, so LPC cannot verify the payment.',
 matter_conflict:'The associated Matter has conflicting account records. LPC cannot confirm this payout until those records are resolved.',
 currency_unconfirmed:'The currency recorded for this payment could not be verified.',
 reconciliation_required:'The payment records require reconciliation before LPC can confirm this transfer.',
 transfer_missing:'This payout record is missing a valid Stripe transfer reference.',
 mode_unconfirmed:'LPC could not verify whether this transfer is a live payment or a test record.',
 records_mismatch:'The available payment records do not provide enough matching evidence to confirm this transfer.',
 pending:'This transfer is recorded as pending. It is not included in recorded payout totals.',
 failed:'This transfer is recorded as failed. Review the related Matter for its payment record and next steps.',
 reversed:'This transfer is recorded as reversed. It is not included in recorded payout totals.',
});
const paymentRow=(title,path)=>{const row=link('',path);row.className='pv2-payout-row pv2-payout-record';row.setAttribute('aria-label',`View payment details: ${title}`);const chevron=node('span','›','pv2-payout-chevron');chevron.setAttribute('aria-hidden','true');row.append(chevron);return row;};
const date=value=>value?new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}):'Date not recorded';

// Reads stay account-scoped and in memory. No unconfirmed amounts enter totals.
export function createPayoutsView({api,getIdentity,onSessionLost}) {
 let root=null,controller=null,generation=0;
 function clearProtected(){generation++;controller?.abort();controller=null;root?.replaceChildren();root=null;}
 function render({route,isCurrent=()=>true}={}) {
  clearProtected();const view=node('section',null,'v2-payouts pv2-payouts-settings');root=view;view.dataset.v2Payouts='';view.setAttribute('aria-labelledby','v2-payouts-title');
  const heading=node('h1','Payouts');heading.id='v2-payouts-title';const content=node('div');view.append(heading,content);
  const run=++generation,ownerId=String(getIdentity()?.id||getIdentity()?._id||'');let busy=false;
  const current=()=>run===generation&&root===view&&isCurrent();const sameOwner=()=>ownerId&&ownerId===String(getIdentity()?.id||getIdentity()?._id||'');
  const requested=route?.query?.get('section');let selected=['records','attention','account'].includes(requested)?requested:'records';
  const navigation=node('nav',null,'pv2-payout-navigation');navigation.setAttribute('aria-label','Payout sections');
  const panels=node('div',null,'pv2-payout-panels'),sections=new Map(),bodies=new Map();
  const show=(key,{remember=false}={})=>{
   selected=key;for(const [id,panel]of sections)panel.hidden=id!==key;
   navigation.querySelectorAll('button').forEach(button=>{if(button.dataset.section===key)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
   if(remember&&current()){
    const url=new URL(location.href),[path,...parts]=url.hash.split('?');
    if(path==='#/payouts'){const query=new URLSearchParams(parts.join('?'));query.set('section',key);url.hash=`${path}?${query}`;history.replaceState(history.state,'',url);}
   }
  };
   for(const [key,label]of [['records','Payment records'],['attention','Payment issues'],['account','Payout account']]){
    const button=node('button',label,'pv2-payout-nav-item');button.type='button';button.dataset.section=key;button.addEventListener('click',()=>show(key,{remember:true}));navigation.append(button);
    const panel=node('section',null,'pv2-payout-section');panel.setAttribute('aria-label',label);const header=node('div',null,'pv2-payout-section-header');header.append(node('h2',label));if(key==='records')header.append(link('Matter history','/work?section=history'));const body=node('div');panel.append(header,body);sections.set(key,panel);bodies.set(key,body);panels.append(panel);
   }
   const account=node('div',null,'pv2-payout-group'),row=node('div',null,'pv2-payout-row'),copy=node('div',null,'pv2-payout-copy');copy.append(node('h3','Stripe payout account'),node('p','Manage your connected account and payout setup.'));row.append(copy,link('Manage payout account','/settings?tab=security&section=payments'));account.append(row);bodies.get('account').append(account);
   const layout=node('div',null,'pv2-payout-layout');layout.append(navigation,panels);content.replaceChildren(layout);show(selected);
  function retryControl(container){
   const retry=node('button','Retry payouts','pv2-payout-link');retry.type='button';retry.addEventListener('click',()=>void load());container.append(retry);
  }
  function paint(report,expected,history) {
   const summary=node('div',null,'pv2-payout-group pv2-payout-summary');const totals=renderEarningsReport(report,{expected});
   if(report&&!report.currencies.length)totals.querySelector('p').textContent='No confirmed payouts yet.';
   const status=totals.querySelector('.pf-record-status');
   if(status){const count=report.states.needs_review+report.states.pending+report.states.failed+report.states.reversed;const action=node('button',`View ${count} payment issue${count===1?'':'s'}`,'pv2-payout-attention-action');action.setAttribute('aria-label',action.textContent);action.type='button';action.addEventListener('click',()=>show('attention',{remember:true}));status.replaceWith(action);}
   summary.append(totals);if(!report||!expected)retryControl(summary);bodies.get('records').replaceChildren(summary);
   const attention=node('div',null,'pv2-payout-group');
   const reviewItems=report?.reviewItems;
   if(reviewItems?.length){
    for(const item of reviewItems){const unavailable=['matter_unavailable','matter_conflict'].includes(item.reason);const row=paymentRow(item.caseTitle||'Matter payment',unavailable?'/help':withMatterReturn(`/matter/${item.caseId}?tab=financials`,'/payouts?section=attention'));if(unavailable)row.setAttribute('aria-label',`Contact LPC about ${item.caseTitle||'Matter payment'}`);const copy=node('div',null,'pv2-payout-copy');copy.append(node('h3',item.caseTitle||'Matter payment'),node('span',payoutStates[item.state]||'Payment not confirmed','pv2-payout-state'),node('p',reasons[item.reason]||reasons.records_mismatch));
     if(item.recordedAt)copy.append(node('small',`Recorded ${date(item.recordedAt)}`));row.prepend(copy);attention.append(row);
    }
   }else if(report&&(report.requiresReview||report.states.pending||report.states.failed||report.states.reversed)){
    const row=node('div',null,'pv2-payout-row');const copy=node('div');copy.append(node('h3','Payment details unavailable'),node('p','LPC could not load the individual payment details for this report. Your recorded payout totals exclude these unconfirmed payments.'));const action=node('button','View payment records','pv2-payout-link');action.type='button';action.addEventListener('click',()=>show('records',{remember:true}));row.append(copy,action);attention.append(row);
   }else attention.append(node('p',report?'No payment issues recorded.':'Payment status is unavailable.','pv2-payout-empty'));
   if(!report)retryControl(attention);bodies.get('attention').replaceChildren(attention);
   const records=node('div',null,'pv2-payout-group');
   if(history?.items.length){for(const item of history.items){for(const receipt of item.receipts){const row=paymentRow(item.title||'Matter payment',withMatterReturn(`/matter/${item.caseId}?tab=financials`,'/payouts?section=records'));const copy=node('div',null,'pv2-payout-copy');copy.append(node('h3',item.title||'Matter payment'),node('span',payoutPresentation(receipt).label,'pv2-payout-state'));
     const matches=reviewItems?.filter(review=>review.caseId===item.caseId&&review.state===receipt.payoutState)||[];
     if(matches.length===1&&item.receipts.filter(other=>other.payoutState===receipt.payoutState).length===1)copy.append(node('p',reasons[matches[0].reason]||reasons.records_mismatch));
     else if(payoutPresentation(receipt).reason)copy.append(node('p',payoutPresentation(receipt).reason));
     if(receipt.recordedAt)copy.append(node('small',date(receipt.recordedAt)));
     row.prepend(copy);
     if(['recorded','no_payout'].includes(receipt.payoutState))row.insertBefore(node('span',payoutMoney(Math.round(receipt.paymentAmount*100),receipt.currency)+(receipt.stripeMode==='test'?' · Test':''),'pv2-payout-amount'),row.lastChild);
     records.append(row);
   }}}else records.append(node('p',history?'No payment records yet.':'Payment records are currently unavailable.','pv2-payout-empty'));
   if(!history&&report&&expected)retryControl(records);bodies.get('records').append(records);show(selected);
  }
  async function load(){
   if(busy||!current())return;busy=true;
   const restoreFocus=view.contains(document.activeElement)&&document.activeElement.textContent==='Retry payouts';
   const request=new AbortController();controller=request;
   view.dataset.state='loading';
   for(const key of ['records','attention']){const body=bodies.get(key),status=node('p','Loading payouts…','pv2-payout-empty');status.setAttribute('role','status');body.setAttribute('aria-busy','true');body.replaceChildren(status);}
   const timeout=setTimeout(()=>request.abort(),10000);
   try{
    const options={signal:request.signal};const before=await verifyParalegalSession(api,options);if(!current())return;
    if(!sameOwner()||before.state!=='ready'||before.identity.id!==ownerId){clearProtected();onSessionLost?.();return;}
    const results=await Promise.allSettled([api.get(`/api/paralegal/dashboard?expectedOwnerId=${encodeURIComponent(ownerId)}`,options),loadParalegalHistory(api,ownerId,{...options,isCurrent:current})]);
    const after=await verifyParalegalSession(api,options);if(!current())return;
    if(!sameOwner()||after.state!=='ready'||after.identity.id!==ownerId){clearProtected();onSessionLost?.();return;}
    const payload=results[0].status==='fulfilled'?results[0].value:null;let report=null,expected=null;
    try{report=readEarningsReport(payload?.metrics?.earningsReport,ownerId);}catch{}
    try{expected=readExpectedCompensation(payload?.metrics?.expectedCompensation,ownerId);}catch{}
    view.dataset.state=report?'ready':'unavailable';paint(report,expected,results[1].status==='fulfilled'?results[1].value:null);
   }catch{
    if(!current())return;if(!sameOwner()){clearProtected();onSessionLost?.();return;}
    view.dataset.state='unavailable';paint(null,null,null);
   }finally{clearTimeout(timeout);if(current()){busy=false;for(const key of ['records','attention'])bodies.get(key).removeAttribute('aria-busy');if(restoreFocus&&[document.body,document.documentElement].includes(document.activeElement)){const heading=sections.get(selected).querySelector('h2');heading.tabIndex=-1;heading.focus({preventScroll:true});}}}
  }
  view.readiness=load();return view;
 }
 return{render,clearProtected,leave:clearProtected};
}
