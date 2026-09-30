import { createBlockedApi } from './blocked-api.mjs';
function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") element.textContent = String(value);
    else if (key === "className") element.className = value;
    else element.setAttribute(key, String(value));
  }
  children.forEach(child => element.append(child)); return element;
}
function button(text, callback, className = "pv2-secondary") {
  const control = node("button", { type: "button", text, className });
  control.addEventListener("click", callback); return control;
}

const date=value=>value?new Intl.DateTimeFormat('en-US',{dateStyle:'medium'}).format(new Date(value)):'';
export function createBlockedView(identity,{signal,accountState,onSessionLost,blockedApi}={}) {
  const api=blockedApi||createBlockedApi({onAuthenticationLost:onSessionLost}),options={ownerId:identity.id,signal},state=accountState;
  const view=node('section',{className:'pv2-blocked',id:'v2-settings-blocked','aria-labelledby':'pv2-blocked-title'});
  const refresh=button('Refresh blocked users',()=>{view.readiness=load();},'pv2-refresh');
  const title=node('h2',{id:'pv2-blocked-title',text:'Blocked users',tabindex:'-1'}),notice=node('p',{role:'status',className:'pv2-account-feedback'}),check=button('Check again',()=>{view.readiness=recover();},'pv2-secondary');check.hidden=true;
  const list=node('div',{className:'pv2-blocked-list','data-blocked-list':'','aria-busy':'true'}),more=button('Load more',()=>{view.readiness=load(true);},'pv2-secondary'),count=node('span',{className:'pv2-muted'});
  const footer=node('div',{className:'pv2-blocked-pages'},[count,more]);more.hidden=true;view.append(node('header',{className:'pv2-blocked-header'},[title,refresh]),notice,check,list,footer);
  let items=[],nextCursor=null,total=0,loaded=false,loading=false,busy=false,failed=false,pagingInvalid=false,ticket=0,dialog=null;
  let pageCursors=new Set();
  const active=()=>!signal.aborted&&view.isConnected;
  const valid=()=>!signal.aborted;
  signal.addEventListener('abort',()=>{ticket++;api.clear();if(state.blockedAction?.phase==='pending')state.blockedAction.phase='uncertain';dialog?.close('interrupted');dialog?.remove();dialog=null;list.replaceChildren();notice.textContent='';},{once:true});
  function feedback(text,error=false){notice.textContent=text;notice.dataset.state=error?'error':'saved';}
  function lock(){const unavailable=loading||busy||failed||Boolean(state.blockedAction);refresh.disabled=loading||busy;more.disabled=unavailable||pagingInvalid;list.querySelectorAll('button').forEach(item=>{item.disabled=unavailable;});check.disabled=loading||busy;}
  function restoreFocus(control){control.focus();control.scrollIntoView({block:'center',inline:'nearest'});}
  function focus(id){if(!active()||dialog)return;const control=[...list.querySelectorAll('button')].find(item=>item.dataset.blockedId===id&&!item.disabled);restoreFocus(control||title);}
  function render(){
    list.replaceChildren();if(!items.length&&loaded&&!failed)list.append(node('p',{className:'pv2-muted',text:'No blocked users.'}));
    for(const item of items){const unblock=button('Unblock',()=>confirm(item,unblock),'pv2-secondary');unblock.dataset.blockedId=item.blockedId;unblock.setAttribute('aria-label',`Unblock ${item.name}`);
      const meta=[({attorney:'Attorney',paralegal:'Paralegal'})[item.role],item.createdAt?`Blocked ${date(item.createdAt)}`:''].filter(Boolean).join(' · ');
      const details=node('div',{},[node('h3',{text:item.name}),...(meta?[node('p',{className:'pv2-muted',text:meta})]:[]),...(item.reason?[node('details',{className:'pv2-blocked-reason'},[node('summary',{text:'Reason'}),node('p',{text:item.reason})])]:[])]);
      list.append(node('article',{className:'pv2-blocked-row','data-blocked-id':item.blockedId},[details,unblock]));
    }
    more.hidden=!nextCursor;count.textContent=nextCursor||items.length<total?`${items.length} of ${total}`:'';lock();
  }
  async function load(append=false,{message='',focusId=null,error=false}={}) {
    if(!valid()||loading||busy||append&&pagingInvalid)return;loading=true;failed=false;lock();list.setAttribute('aria-busy','true');const current=++ticket,cursor=append?nextCursor:null;
    if(!loaded)list.replaceChildren(node('p',{role:'status',className:'pv2-muted',text:'Loading blocked users…'}));
    try{const result=await api.readPage({...options,...(cursor?{cursor}:{})});if(!valid()||current!==ticket)return;
      const seen=new Set(append?items.map(item=>item.blockedId):[]),added=result.items.filter(item=>!seen.has(item.blockedId));
      const cursors=new Set(append?pageCursors:[]);if(cursor)cursors.add(cursor);
      if(result.nextCursor&&(cursors.has(result.nextCursor)||!added.length)) {
        pagingInvalid=true;throw Object.assign(new Error('Invalid continuation'),{kind:'pagination'});
      }
      items=append?[...items,...added]:result.items;nextCursor=result.nextCursor;total=result.total;loaded=true;pageCursors=cursors;pagingInvalid=false;
      feedback(message||(state.blockedAction?'Check the current unblock result before trying another action.':''),error||Boolean(state.blockedAction));loading=false;render();if(append&&added.length)focus(added[0].blockedId);else if(focusId!==null)focus(focusId);
    }catch(failure){if(!valid()||current!==ticket||failure.name==='AbortError')return;failed=!append;feedback(failure.kind==='pagination'?'The next page could not be verified. Refresh blocked users to continue.':append?'More blocked users could not be loaded. Try again.':loaded?'Blocked users could not be refreshed. The previous list is shown below.':'Blocked users could not be loaded. Try again.',true);if(!loaded)list.replaceChildren();}
    finally{if(valid()&&current===ticket){loading=false;list.setAttribute('aria-busy','false');lock();}}
  }
  async function recover({confirmed=false}={}) {
    const pending=state.blockedAction;if(!valid()||!pending||loading||busy)return;busy=true;check.hidden=true;lock();
    try{const result=await api.readStatus(pending.blockedId,options);if(!valid()||state.blockedAction!==pending)return;
      delete state.blockedAction;busy=false;const message=!result.blocked?confirmed?`Unblocked ${pending.name}.`:`Your block on ${pending.name} is no longer active.`:result.revision===pending.revision?'Your block is still active. Review it before trying again.':'This block changed. Review the current list before trying again.';
      await load(false,{message,error:result.blocked,focusId:result.blocked?pending.blockedId:''});
    }catch(failure){if(!valid()||failure.name==='AbortError')return;pending.phase='uncertain';feedback('The unblock result could not be confirmed. Check again before trying another action.',true);check.hidden=false;}
    finally{if(valid()){busy=false;lock();}}
  }
  function confirm(item,launcher) {
    if(loading||busy||failed||state.blockedAction||dialog)return;
    const reviewed={...item};dialog=node('dialog',{className:'pv2-account-dialog pv2-blocked-dialog','aria-labelledby':'pv2-blocked-confirm-title'},[node('h2',{id:'pv2-blocked-confirm-title',text:`Unblock ${item.name}?`}),node('p',{text:'This removes your block on future interactions. Other account and Matter restrictions still apply.'})]);
    const cancel=button('Cancel',()=>dialog.close('cancel'),'pv2-secondary'),submit=button('Unblock',async()=>{
      if(busy||!valid())return;busy=true;lock();cancel.disabled=true;submit.disabled=true;state.blockedAction={blockedId:reviewed.blockedId,name:reviewed.name,revision:reviewed.revision,phase:'pending'};
      let confirmed=false;
      try{await api.unblock(reviewed.blockedId,reviewed.revision,options);if(!valid())return;confirmed=true;}
      catch(failure){if(!valid()||failure.name==='AbortError')return;if(!['uncertain','conflict'].includes(failure.kind)){delete state.blockedAction;feedback('This block could not be removed. Refresh blocked users and try again.',true);dialog?.close('failed');return;}}
      finally{if(valid()){busy=false;cancel.disabled=false;submit.disabled=false;lock();}}
      if(valid()){dialog?.close('review');if(state.blockedAction)state.blockedAction.phase='uncertain';await recover({confirmed});}
    },'pv2-button');dialog.append(node('div',{className:'pv2-actions'},[cancel,submit]));
    dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
    const currentDialog=dialog;currentDialog.addEventListener('close',()=>{currentDialog.remove();if(dialog===currentDialog)dialog=null;if(active()&&!loading&&!busy){if(launcher.isConnected&&!launcher.disabled)restoreFocus(launcher);else focus(reviewed.blockedId);}},{once:true});document.body.append(currentDialog);currentDialog.showModal();cancel.focus();
  }
  view.hasPending = () => loading || busy || Boolean(dialog) || Boolean(state.blockedAction);
  view.readiness=(async()=>{await load();if(valid()&&state.blockedAction)await recover();})();return view;
}
