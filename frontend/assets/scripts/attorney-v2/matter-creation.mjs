import {node,button} from './dom.mjs';
import {createDraftEditor} from './draft-editor.mjs';
import {matterLink} from './workspace-model.mjs';
const resumeKey='lpc.attorney.creation.v1';

// The router and outlet remain untouched while creation is open. Only opaque
// draft identity/step metadata goes into session storage; draft text never does.
export function createMatterCreation({api,privateState,identity,ready,beforeOpen=()=>{},onOpenChange=()=>{},navigate=href=>{location.hash=href;},onSuccess=()=>{}}) {
  let view,controller,opener,lastQuery=new URLSearchParams(),owner='',switching=false;
  const dialog=node('dialog',{className:'av2-creation-layer','aria-labelledby':'av2-creation-title'});
  const veil=node('div',{className:'av2-creation-veil','aria-hidden':'true'});
  const closeButton=button('×',()=>close(),'av2-creation-close');closeButton.setAttribute('aria-label','Close Matter creation');
  const closeGlyph=document.createElementNS('http://www.w3.org/2000/svg','svg');
  closeGlyph.setAttribute('viewBox','0 0 24 24');closeGlyph.setAttribute('aria-hidden','true');closeGlyph.setAttribute('class','av2-close-glyph');
  const closePath=document.createElementNS('http://www.w3.org/2000/svg','path');closePath.setAttribute('d','M6 6l12 12M18 6 6 18');closeGlyph.append(closePath);closeButton.replaceChildren(closeGlyph);
  const startNew=button('',()=>{
    if(!view?.canStartNew?.())return;
    const state=view.creationState,v=state.values;
    const hasWork=Boolean(v.sourceDescription?.trim()||v.title?.trim()||v.description?.trim()||v.tasks?.length||v.requirements?.length||v.compAmount||v.deadline);
    if(!hasWork){void startFresh();return;}
    restartPrompt.hidden=false;content.inert=true;startNew.disabled=true;cancelRestart.focus();
  },'av2-creation-rewind');startNew.setAttribute('aria-label','Start over');startNew.disabled=true;
  const rewind=document.createElementNS('http://www.w3.org/2000/svg','svg');
  rewind.setAttribute('viewBox','0 0 24 24');rewind.setAttribute('aria-hidden','true');
  for(const d of ['M6.7 6.7a7.5 7.5 0 1 1-2.2 5.3','M6.7 3.2v3.5h3.5']){
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);rewind.append(path);
  }
  startNew.append(rewind);
  const cancelRestart=button('Cancel',()=>dismissRestart(),'av2-secondary');
  const confirmRestart=button('Start new Matter',()=>{dismissRestart(false);void startFresh();},'av2-button');
  const restartPrompt=node('section',{className:'av2-creation-restart',role:'group','aria-labelledby':'av2-restart-title',hidden:''},[
    node('h3',{id:'av2-restart-title',text:'Start a new Matter?'}),node('p',{text:'Your current work will be saved in Drafts.'}),node('div',{className:'av2-actions'},[cancelRestart,confirmRestart])
  ]);
  const headerActions=node('div',{className:'av2-creation-header-actions'},[startNew,closeButton,restartPrompt]);
  const heading=node('header',{className:'av2-creation-heading'},[node('h2',{id:'av2-creation-title',text:'New Matter'}),headerActions]);
  const content=node('div',{className:'av2-creation-content'});
  const surface=node('section',{className:'av2-creation-surface','data-step':'describe'},[heading,content]);
  dialog.append(veil,surface);document.body.append(dialog);
  function dismissRestart(focus=true){restartPrompt.hidden=true;content.inert=false;startNew.disabled=switching||!view?.canStartNew?.();if(focus)startNew.focus();}
  async function startFresh(){if(!view?.canStartNew?.())return;await open(new URLSearchParams({request:crypto.randomUUID()}),opener);}
  function remember(){
    if(!dialog.open||!owner)return;
    try{sessionStorage.setItem(resumeKey,JSON.stringify({owner,query:lastQuery.toString()}));}catch{}
  }
  function forget(){try{sessionStorage.removeItem(resumeKey);}catch{}}
  function position(){
    const frame=document.querySelector('.av2-frame');const box=frame?.getBoundingClientRect();
    dialog.style.setProperty('--creation-left',`${box?.left || 0}px`);
    dialog.style.setProperty('--creation-top',`${document.querySelector('.av2-header')?.getBoundingClientRect().bottom || 0}px`);
  }
  function setStep(step){surface.dataset.step=step;remember();}
  function close({save=true}={}){
    if(!dialog.open)return;
    dismissRestart(false);dialog.close();document.documentElement.classList.remove('av2-creation-open');onOpenChange(false);forget();
    if(save)void view?.flush?.();
    if(opener?.isConnected)opener.focus({preventScroll:true});
  }
  async function open(query=new URLSearchParams(),trigger=document.activeElement){
    if(!ready()||switching)return;
    const user=identity();if(!user)return;
    const target=query.get('draftId')||query.get('caseDraftId')||query.get('request');
    const current=lastQuery.get('draftId')||lastQuery.get('caseDraftId')||lastQuery.get('request');
    if(view&&target&&target!==current){
      switching=true;startNew.disabled=true;
      const previous=view,wasOpen=dialog.open;const saved=await view.flush?.();switching=false;
      if(view!==previous||!ready()||identity()?.id!==user.id)return;
      startNew.disabled=!view.canStartNew?.();
      if(wasOpen&&!dialog.open)return;
      if(saved===false){if(!dialog.open)show(trigger);view.focusCreation?.();return;}
      controller?.abort();view=null;
    }
    if(view?.creationState?.publishedCaseId||view?.creationState?.deleted){controller?.abort();view=null;}
    if(!view){
      owner=user.id;lastQuery=new URLSearchParams(query);controller=new AbortController();
      view=createDraftEditor({query:lastQuery},user,{api,privateState,signal:controller.signal,creationHost:{
        mountSaveStatus(status){headerActions.querySelector('.av2-compose-save-status')?.remove();startNew.before(status);},
        sync(query,step){lastQuery=new URLSearchParams(query);setStep(step);},
        step:setStep,
        availability(available){startNew.disabled=switching||!available||!restartPrompt.hidden;},
        published(result){close({save:false});forget();onSuccess('Matter published.');navigate(matterLink(result.caseId));}
      }});
      content.replaceChildren(view);
    }
    show(trigger);
    await view.readiness;
    if(dialog.open){setStep(view.getCreationStep?.()||'describe');view.focusCreation?.();}
  }
  function show(trigger){
    beforeOpen();opener=trigger?.isConnected?trigger:document.querySelector('.av2-create-trigger');
    position();if(!dialog.open)dialog.showModal();document.documentElement.classList.add('av2-creation-open');onOpenChange(true);remember();
  }
  dialog.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&!restartPrompt.hidden){event.preventDefault();event.stopPropagation();dismissRestart();return;}
    if(event.key!=='Tab'||event.ctrlKey||event.metaKey||event.altKey)return;
    const controls=[...dialog.querySelectorAll('button,input,textarea,select,a[href],[tabindex="0"]')].filter(el=>!el.matches(':disabled')&&el.getClientRects().length&&!el.closest('[hidden],[inert]'));
    const first=controls[0];
    if(!first){event.preventDefault();return;}
    event.preventDefault();
    const index=controls.indexOf(document.activeElement);
    controls[index<0?(event.shiftKey?controls.length-1:0):(index+(event.shiftKey?-1:1)+controls.length)%controls.length].focus();
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  let backdropDown=false;
  dialog.addEventListener('pointerdown',event=>{backdropDown=event.target===veil||event.target===dialog;});
  dialog.addEventListener('pointerup',event=>{if(backdropDown&&(event.target===veil||event.target===dialog))close();backdropDown=false;});
  window.addEventListener('resize',position);
  document.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const command=event.target.closest?.('[data-av2-create]');
    const link=event.target.closest?.('a[href]');let query;
    if(command)query=new URLSearchParams();
    else if(link){
      const url=new URL(link.href,location.href);
      if(url.origin!==location.origin||url.pathname!==location.pathname||url.search!==location.search||!/^#\/matters\/new(?:\?|$)/.test(url.hash))return;
      query=new URLSearchParams(url.hash.split('?')[1]);if(query.has('caseId'))return;
    }else return;
    if(!ready())return;
    event.preventDefault();event.stopPropagation();void open(query,command||link);
  },true);
  return {
    open,close,
    workspaceLocation(){return dialog.open&&owner===identity()?.id?`${location.origin}/attorney-v2.html#/matters/new?${lastQuery}`:null;},
    noticeHost(){return dialog.open?content:null;},
    clear({forgetResume=true}={}){dismissRestart(false);if(dialog.open)dialog.close();document.documentElement.classList.remove('av2-creation-open');onOpenChange(false);controller?.abort();view=null;content.replaceChildren();owner='';lastQuery=new URLSearchParams();if(forgetResume)forget();},
    resume(){
      try{const saved=JSON.parse(sessionStorage.getItem(resumeKey)||'null');if(saved?.owner===identity()?.id&&typeof saved.query==='string')void open(new URLSearchParams(saved.query));else if(saved)forget();}catch{forget();}
    }
  };
}
