import {createDraftUpdater} from './draft-updater.mjs';
import {node,button} from './dom.mjs';
import {draftPractices,draftStates,draftExperience} from './draft-options.mjs';
import {validDraftDate,dollarCents} from '../matter-draft-contract.mjs';
const content = v => ({title:v.title,description:v.description,tasks:v.tasks,practiceArea:v.practiceArea,state:v.state,sourceDescription:v.sourceDescription,compAmount:v.compAmount,deadline:v.deadline,appliedSourceDescription:v.appliedSourceDescription,experience:v.experience,requirements:v.requirements});
export function createDraftComposer({api,ownerId,signal,values,edit,go,available,memory,canvas=false,retainSource=false}) {
  let pending=false, proposal=null, baseline=null, failed=false, updater;
  const intro=node('fieldset',{className:'av2-card av2-draft-fields av2-compose-intro','data-draft-step':'describe',tabindex:-1});
  const brief=node('textarea',{id:'av2-compose-brief',rows:canvas?3:5,maxlength:4000,placeholder:canvas?'Organize medical records for this Wednesday…':'Organize approximately 1,200 pages of medical records and prepare a chronology highlighting treatment dates, providers, diagnoses, and gaps in care.'});
  function fitBrief(){
    if(!canvas||brief.readOnly||brief.hidden)return;
    brief.style.height='auto';
    brief.style.height=Math.max(108,brief.scrollHeight+2)+'px';
  }
  brief.addEventListener('input',fitBrief);
  if(canvas){
    let previousWidth=0;
    const observer=new ResizeObserver(entries=>{const width=entries[0].contentRect.width;if(width&&width!==previousWidth){previousWidth=width;fitBrief();}});
    observer.observe(brief);signal.addEventListener('abort',()=>observer.disconnect(),{once:true});
  }
  brief.value=memory.creationBrief || values().sourceDescription || (!canvas?values().description:'') || '';
  brief.addEventListener('input',()=>{memory.creationBrief=brief.value;edit({...(retainSource?{sourceDescription:brief.value}:{}),...(!values().title&&!values().tasks.length&&(!canvas||brief.closest('.av2-living-canvas')?.dataset.creationStep==='describe')?{description:brief.value}:{})});});
  const examples=node('div',{className:'av2-compose-examples','aria-label':'Example work descriptions'});
  examples.append(node('span',{text:'Try an example:'}));
  for(const [label,text] of [['Discovery review','Review the discovery production, organize documents by issue, and prepare an index of key evidence with source-page references.'],['Medical chronology','Organize approximately 1,200 pages of medical records and prepare a chronology highlighting treatment dates, providers, diagnoses, and gaps in care.'],['Deposition summary','Summarize the deposition transcript by topic, with page and line references for key testimony, inconsistencies, and follow-up questions.']])examples.append(button(label,()=>{brief.value=text;brief.dispatchEvent(new Event('input'));brief.focus();},'av2-compose-example'));
  const status=node('p',{role:'status',className:'av2-muted'});
  const refinePanel=node('section',{className:'av2-compose-refine',hidden:'','aria-label':'Refine draft'});
  const instruction=node('textarea',{id:'av2-refine-instruction',rows:2,maxlength:4000,placeholder:'Make this shorter, or break the work into smaller tasks.'});
  const refinementStatus=node('p',{role:'status',className:'av2-muted'});
  const preview=node('div',{className:'av2-compose-proposal'});
  const launch=button('Refine draft',()=>{refinePanel.hidden=!refinePanel.hidden;launch.setAttribute('aria-expanded',String(!refinePanel.hidden));if(!refinePanel.hidden)instruction.focus();},'av2-draft-ai-trigger');
  launch.setAttribute('aria-expanded','false');
  const accept=button('Use revised draft',()=>{
    if(!proposal||!available())return;
    if(JSON.stringify(content(values()))!==JSON.stringify(baseline)){refinementStatus.textContent='Your draft changed. Refine again to include your latest edits.';return;}
    apply(proposal);proposal=null;refinePanel.hidden=true;launch.setAttribute('aria-expanded','false');go('description');
  },'av2-button');accept.hidden=true;
  function extractedChanges(data){
    const current=values(),changes={},protectedFields=memory.creationEditedFields || [];
    for(const key of ['compAmount','deadline','experience'])if(data[key]&&!current[key]&&!protectedFields.includes(key))changes[key]=data[key];
    if(data.requirements?.length&&!current.requirements?.length&&!protectedFields.includes('requirements'))changes.requirements=data.requirements;
    // Profile state may be superseded on first build; later edits and established drafts are retained.
    if(data.state&&!protectedFields.includes('state')&&(!current.state||(!current.title&&!current.tasks.length)))changes.state=data.state;
    return changes;
  }
  function apply(data){memory.creationGenerated=true;edit({...extractedChanges(data),...(canvas&&retainSource?{sourceDescription:memory.creationBrief||brief.value,appliedSourceDescription:memory.creationBrief||brief.value}:{}),title:data.title,description:data.description,tasks:data.tasks.map(title=>({title})),...(data.practiceArea?{practiceArea:data.practiceArea}:{})});}
  async function generate(refine=false){
    if(pending||!available())return;
    const prompt=refine?instruction.value:brief.value, feedback=refine?refinementStatus:status;
    if(prompt.trim().length<10){feedback.textContent='Add a little more detail, such as practice area, deadline, and compensation.';return;}
    baseline=structuredClone(content(values()));failed=false;pending=true;update();feedback.textContent=refine?'Revising your draft…':'';proposal=null;accept.hidden=true;preview.replaceChildren();
    try {
      const current=refine||Boolean(baseline.title||baseline.tasks.length)?{title:baseline.title,description:baseline.description,tasks:baseline.tasks.map(t=>t.title)}:undefined;
      const response=await api.suggestMatterDraft(prompt.trim(),{ownerId,signal,practiceArea:baseline.practiceArea,state:baseline.state,...(current?{current}:{})});
      if(signal.aborted)return;
      const data=response?.suggestions;
      if(!data||typeof data.title!=='string'||!data.title.trim()||data.title.length>300||typeof data.description!=='string'||!data.description.trim()||data.description.length>4000||!draftPractices.some(([v])=>v===data.practiceArea)||!Array.isArray(data.tasks)||!data.tasks.length||data.tasks.length>25||data.tasks.some(t=>typeof t!=='string'||!t.trim()||t.length>200))throw Error('invalid');
      if((data.compAmount!==undefined&&(typeof data.compAmount!=='string'||dollarCents(data.compAmount)===null))||(data.deadline!==undefined&&!validDraftDate(data.deadline))||(data.state!==undefined&&!draftStates.some(([value])=>value&&value===data.state)))throw Error('invalid details');
      if((data.experience!==undefined&&!draftExperience.some(([value])=>value&&value===data.experience))||(data.requirements!==undefined&&(!Array.isArray(data.requirements)||data.requirements.length>12||data.requirements.some(value=>typeof value!=='string'||!value.trim()||value.length>200))))throw Error('invalid requirements');
      if(JSON.stringify(content(values()))!==JSON.stringify(baseline)){feedback.textContent='Your draft changed while AI was working. Try again to include your latest edits.';return;}
      if(refine||current){
        proposal=data;refinePanel.hidden=false;launch.setAttribute('aria-expanded','true');
        preview.append(node('h3',{text:data.title}),node('p',{text:data.description}),node('ul',{},data.tasks.map(t=>node('li',{text:t}))));
        const additions=extractedChanges(data);
        for(const [key,value] of Object.entries(additions))preview.append(node('p',{text:({compAmount:'Compensation',deadline:'Deadline',state:'State',experience:'Experience',requirements:'Requirements'})[key]+': '+(key==='deadline'?globalThis.LPCBusinessDate.format(value):key==='compAmount'?'$'+value:Array.isArray(value)?value.join('; '):value)}));
        refinementStatus.textContent='Review these changes before replacing your title, description, and tasks.';accept.hidden=false;
        if(!refine)go('description');
      } else {apply(data);go('description');}
      feedback.textContent=refine?refinementStatus.textContent:'';
    }catch{if(!signal.aborted){failed=true;feedback.textContent=canvas?'We couldn’t build your Matter. Your notes are still here. Try again, or enter details manually.':'AI drafting is unavailable right now. Try again or continue manually.';}}
    finally{pending=false;update();}
  }
  const build=button('Build my Matter →',()=>void generate(false),'av2-button');
  const manual=button(canvas?"Enter details manually":"I'll enter the details myself",()=>{
    // Manual drafts keep the entered text as scope, not a second source panel.
    const current=values();
    edit({...(retainSource?{sourceDescription:'',appliedSourceDescription:''}:{}),...(!current.description.trim()&&brief.value.trim()?{description:brief.value}:{})});
    memory.creationBrief='';go('description');
  },'av2-compose-example');
  intro.append(node('h2',{text:canvas?'Start a new Matter.':'What do you need help with?'}),node('label',{for:brief.id,text: canvas?'Start with your notes. We’ll put them in order.':'Describe the work in your own words. You don’t need to format anything yet.'}),brief,examples,status,node('div',{className:'av2-actions'},[build,manual]));
  const refine=button('Refine draft',()=>void generate(true),'av2-secondary');
  refinePanel.append(node('label',{for:instruction.id,text:'What would you like to change?'}),instruction,refine,refinementStatus,preview,node('div',{className:'av2-actions'},[accept,button('Cancel',()=>{refinePanel.hidden=true;launch.setAttribute('aria-expanded','false');launch.focus();},'av2-compose-example')]));
  if(canvas)updater=createDraftUpdater({api,ownerId,signal,values,edit,available,memory,brief,isShape:()=>brief.closest('.av2-living-canvas')?.dataset.creationStep==='description'});
  function update(){
    if(!memory.creationBrief&&!brief.value&&(values().sourceDescription||(!canvas&&values().description)))brief.value=values().sourceDescription||values().description;
    const disabled=!available();build.textContent=pending?'Building your Matter…':failed?'Try again':'Build my Matter →';
    build.disabled=refine.disabled=launch.disabled=disabled||pending;manual.disabled=disabled||pending;
    examples.querySelectorAll('button').forEach(control=>control.disabled=disabled||pending);
    brief.readOnly=pending||disabled;accept.disabled=disabled||pending;
    intro.setAttribute('aria-busy',String(pending));refinePanel.setAttribute('aria-busy',String(pending));updater?.update();
  }
  return {intro,brief,updater,examples,build,manual,status,refinePanel,launch,update,fitBrief};
}
