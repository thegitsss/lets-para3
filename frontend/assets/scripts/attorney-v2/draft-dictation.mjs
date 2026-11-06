import {node,button} from './dom.mjs';
import {createLiveDictation} from './live-dictation.mjs';

export function createDraftDictation({api,ownerId,signal,brief,available,onState}) {
  const root=node('div',{className:'av2-dictation'});
  const controls=node('div',{className:'av2-dictation-controls'});
  const status=node('p',{className:'av2-dictation-status',role:'status','aria-live':'polite'});
  const elapsed=node('span',{className:'av2-dictation-elapsed','aria-hidden':'true',hidden:''});
  const supported=Boolean(globalThis.RTCPeerConnection&&navigator.mediaDevices?.getUserMedia);
  let phase='idle',session,request,deadline,clock,recordedAt,attempt=0,blocked=false;
  const mic=document.createElementNS('http://www.w3.org/2000/svg','svg');
  mic.setAttribute('viewBox','0 0 24 24');mic.setAttribute('aria-hidden','true');mic.setAttribute('focusable','false');
  const line=document.createElementNS(mic.namespaceURI,'path');
  line.setAttribute('d','M12 15a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v7a3 3 0 0 0 3 3Zm-7-4v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8');mic.append(line);
  const start=button('',()=>{if(phase==='recording'){void stop();return;}void begin();},'av2-dictation-button');
  start.dataset.tooltipPlacement='above';
  const cancel=button('Cancel',()=>reset(),'av2-dictation-cancel');
  controls.append(start,cancel);root.append(controls,status,elapsed);
  function paint(notify=true){
    const label=phase==='recording'?'Stop dictation':phase==='permission'?'Connecting microphone…':phase==='finishing'?'Finishing…':'Dictate notes';
    start.replaceChildren(...(phase==='idle'?[mic,node('span',{text:label})]:[document.createTextNode(label)]));
    root.dataset.state=phase;
    elapsed.hidden=phase!=='recording';
    start.classList.toggle('av2-dictation-mic',phase==='idle');start.setAttribute('aria-label',label);start.title=label;
    start.setAttribute('aria-pressed',String(phase==='recording'));
    start.disabled=!supported||blocked||!available()||['permission','finishing'].includes(phase);
    cancel.hidden=phase!=='permission';if(notify)onState?.(phase!=='idle');
  }
  function reset(message=''){
    attempt++;clearTimeout(deadline);clearInterval(clock);request?.abort();request=null;session?.close();session=null;
    phase='idle';status.textContent=message;status.setAttribute('role',message?'alert':'status');paint();
  }
  async function stop(){
    if(phase!=='recording')return;
    const ticket=attempt,active=session;clearTimeout(deadline);clearInterval(clock);phase='finishing';status.textContent='Finishing dictation…';paint();
    await active?.stop();if(ticket===attempt&&!signal.aborted)reset();
  }
  async function begin(){
    if(!supported||blocked||!available()||signal.aborted||phase!=='idle')return;
    const ticket=++attempt;request=new AbortController();phase='permission';status.textContent='';status.setAttribute('role','status');paint();
    const prefix=brief.value,space=prefix&&!/\s$/.test(prefix)?' ':'';let lastValue=prefix;
    try { session=createLiveDictation({api,ownerId,signal:request.signal,
      onReady(){if(ticket!==attempt||signal.aborted)return;phase='recording';status.textContent='Listening…';recordedAt=performance.now();const tick=()=>{const seconds=Math.min(120,Math.floor((performance.now()-recordedAt)/1000));elapsed.textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');};tick();clock=setInterval(tick,1000);paint();deadline=setTimeout(()=>void stop(),120000);},
      onText(words){
        if(ticket!==attempt||signal.aborted)return;
        if(!available()||brief.value!==lastValue){reset();return;}
        const room=Math.max(0,brief.maxLength-prefix.length-space.length);
        if(!room){reset('Your notes are full. Shorten them before dictating more.');return;}
        const clean=words.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,room);
        if(!clean)return;
        brief.value=prefix+space+clean;lastValue=brief.value;
        brief.setSelectionRange(brief.value.length,brief.value.length);brief.dispatchEvent(new Event('input',{bubbles:true}));
        if(words.length>=room)reset('Your notes are full. Shorten them before dictating more.');
      },
      onError(message){if(ticket===attempt&&!signal.aborted)reset(message);}
    });
    await session.start();
    } catch { if(ticket===attempt&&!signal.aborted)reset('Dictation couldn’t start. Your notes are unchanged. Try again.'); }
  }
  brief.addEventListener('beforeinput',()=>{if(phase!=='idle')reset();},{signal});
  document.addEventListener('close',event=>{if(event.target.contains(root))reset();},{capture:true,signal});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&phase!=='idle')reset();},{signal});
  window.addEventListener('pagehide',()=>reset(),{signal});signal.addEventListener('abort',()=>reset(),{once:true});
  if(!supported)status.textContent='Live dictation isn’t supported in this browser. You can keep typing.';
  paint(false);
  return {root,get busy(){return phase!=='idle';},update(disabled){blocked=disabled;if(blocked&&session)reset();else start.disabled=!supported||blocked||!available()||['permission','finishing'].includes(phase);}};
}
