import {node,button} from './dom.mjs';
import {draftPractices,draftStates,draftExperience} from './draft-options.mjs';
import {validDraftDate,dollarCents} from '../matter-draft-contract.mjs';
const labels={title:'Matter',description:'Scope',tasks:'Tasks',practiceArea:'Practice area',state:'State',compAmount:'Compensation',deadline:'Deadline',experience:'Experience',requirements:'Requirements'};
const fields=v=>Object.fromEntries(Object.keys(labels).map(key=>[key,key==='tasks'?v.tasks.map(item=>item.title):v[key]??(key==='requirements'?[]:'')]));
const snapshot=v=>JSON.stringify({fields:fields(v),source:v.sourceDescription});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function validChanges(changes){
 if(!changes||typeof changes!=='object'||Array.isArray(changes))return false;
 return Object.entries(changes).every(([key,value])=>{
  if(!Object.hasOwn(labels,key))return false;
  if(['tasks','requirements'].includes(key))return Array.isArray(value)&&value.length<=(key==='tasks'?25:12)&&value.every(item=>typeof item==='string'&&item.trim()&&item.length<=200);
  if(typeof value!=='string')return false;
  if(key==='deadline')return !value||validDraftDate(value);
  if(key==='compAmount')return !value||dollarCents(value)!==null;
  if(['practiceArea','state','experience'].includes(key))return ({practiceArea:draftPractices,state:draftStates,experience:draftExperience})[key].some(([v])=>v===value);
  return value.length<=(key==='title'?300:4000);
 });
}
const display=(key,value)=>!value?.length?'Empty':key==='deadline'?globalThis.LPCBusinessDate.format(value):key==='compAmount'?'$'+value:Array.isArray(value)?value.join('\n'):value;
export function createDraftUpdater({api,ownerId,signal,values,edit,available,memory,brief,isShape}){
 let pending=false,proposal=null,baseline=null,choices={};
 const status=node('p',{role:'status',tabindex:-1,className:'av2-muted'});
 const conflicts=node('div',{className:'av2-update-conflicts'});
 const trigger=button('Update Matter',()=>void generate(),'av2-secondary');
 const root=node('section',{className:'av2-matter-update',hidden:'','aria-label':'Update Matter from description'},[trigger,status,conflicts]);
 brief.after(root);
 function commit(){
  if(!proposal||!available())return;
  if(snapshot(values())!==baseline){invalidate();return;}
  const changes=Object.fromEntries(Object.entries(proposal).filter(([key])=>choices[key]!=='keep'));
  const keys=Object.keys(changes);
  if(changes.tasks)changes.tasks=changes.tasks.map(title=>({title}));
  proposal=null;conflicts.replaceChildren();
  edit({...changes,appliedSourceDescription:brief.value.trim()});
  status.textContent=keys.length?'Matter updated.':'Your current details were kept.';
  brief.dispatchEvent(new CustomEvent('av2-matter-updated',{bubbles:true,detail:keys}));
  update();status.focus({preventScroll:true});
 }
 function invalidate(){proposal=null;conflicts.replaceChildren();status.textContent='Your notes or Matter changed. Update again to include your latest edits.';}
 function choose(key,value,row){
  if(snapshot(values())!==baseline){invalidate();update();return;}
  choices[key]=value;row.dataset.resolved='true';
  row.querySelectorAll('button').forEach(button=>button.disabled=true);
  row.append(node('p',{className:'av2-muted',text:value==='keep'?'Keeping your current value.':'Using the value from your notes.'}));
  if(Object.values(choices).every(Boolean))commit();
 }
 async function generate(){
  if(pending||!available())return;
  if(brief.value.trim().length<10){status.textContent='Add a little more about the work.';return;}
  const current=structuredClone(values());baseline=snapshot(current);proposal=null;conflicts.replaceChildren();status.textContent='';pending=true;update();
  try{
   const response=await api.suggestMatterDraft(brief.value.trim(),{ownerId,signal,practiceArea:current.practiceArea,state:current.state,update:{previousSource:current.appliedSourceDescription||'',fields:fields(current)}});
   if(signal.aborted)return;
   if(snapshot(values())!==baseline){invalidate();return;}
   const changes=response?.suggestions?.changes;
   if(!validChanges(changes))throw Error('invalid update');
   proposal=Object.fromEntries(Object.entries(changes).filter(([key,value])=>!equal(value,fields(current)[key])));
   choices={};
   for(const [key,value] of Object.entries(proposal)){
    // A reloaded draft has no trustworthy in-memory edit history. Ask before replacing it.
    if(!memory.creationGenerated||(memory.creationEditedFields||[]).includes(key)){
     choices[key]='';
     const row=node('section',{className:'av2-update-conflict','aria-label':`${labels[key]} conflict`},[node('h3',{text:labels[key]}),node('p',{text:'Your current value'}),node('pre',{text:display(key,fields(current)[key])}),node('p',{text:'From your notes'}),node('pre',{text:display(key,value)})]);
     row.append(node('div',{className:'av2-actions'},[button('Keep current',()=>choose(key,'keep',row),'av2-compose-example'),button('Use notes',()=>choose(key,'use',row),'av2-compose-example')]));conflicts.append(row);
    }
   }
   if(Object.keys(choices).length){status.textContent='Choose which value to keep for your edited fields.';conflicts.querySelector('button')?.focus();}
   else commit();
  }catch{if(!signal.aborted)status.textContent='We couldn’t update your Matter. Your notes and edits are safe. Try again.';}
  finally{pending=false;update();}
 }
 function update(){
  if(proposal&&snapshot(values())!==baseline)invalidate();
  const changed=brief.value.trim()!==(values().appliedSourceDescription||'').trim();
  if(changed&&!pending&&!proposal&&['Matter updated.','Your current details were kept.'].includes(status.textContent))status.textContent='';
  root.hidden=!isShape()||(!changed&&!status.textContent&&!pending);
  trigger.hidden=!changed&&!pending;
  trigger.disabled=pending||!available()||Boolean(proposal);
  const caption=pending?'Updating Matter…':'Update Matter';
  // Keep the hit target stable when leaving an input triggers a render in Safari.
  if(trigger.textContent!==caption)trigger.textContent=caption;
  root.setAttribute('aria-busy',String(pending));
 }
 return {root,update};
}
