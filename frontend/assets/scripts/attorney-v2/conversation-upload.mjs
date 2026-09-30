import { node, button } from './dom.mjs';
import { createWorkspaceFileUploads } from './workspace-file-uploads.mjs';
import { readConversation } from './conversation-model.mjs';

// The upload receipt and message receipt are separate authoritative operations.
// Keep their private IDs until both outcomes are known; never re-upload to retry a message.
export function createConversationUpload(caseId, {api,signal,ownerId,state,onSent,onAccessLost,onChange}) {
  const root=node('div'), status=node('p',{role:'status'});
  let busy=false, deliveryPromise=null;
  const retry=button('Check and send attachment',()=>void deliver());retry.hidden=true;
  const uploader=createWorkspaceFileUploads(caseId,{api,signal,ownerId,state,compact:true,composerMode:true,onChange,onSaved:file=>{
    if(state.messageDelivery?.file.id!==file.id)state.messageDelivery={file:{id:file.id,version:file.version,name:file.name},id:crypto.randomUUID(),sent:false};
    deliveryPromise=deliver();
  }});
  root.append(uploader,status,retry);
  async function deliver() {
    const delivery=state.messageDelivery;
    if(!delivery || delivery.sent || busy || signal.aborted)return;
    busy=true;onChange?.();retry.hidden=true;status.textContent='Sending attachment…';
    try {
      let removed=false;
      const result=readConversation(await api.readWorkspaceMessages(caseId,{signal,ownerId,clientMessageId:delivery.id}),caseId);
      const recorded=result.messages.find(message=>message.clientMessageId===delivery.id && message.senderId===ownerId && message.type==='file');
      if(signal.aborted)return;
      if(!recorded) {
        const value=await api.sendWorkspaceFileMessage(caseId,delivery.file,delivery.id,{signal,ownerId});
        if(value?.message?.type!=='file' || String(value.message.caseId)!==caseId || String(value.message.senderId?._id || value.message.senderId)!==ownerId || value.message.clientMessageId!==delivery.id)throw new Error('unconfirmed_attachment');
        removed=value.message.deleted===true;
      }
      if(signal.aborted)return;
      delivery.sent=true;status.textContent=removed?'This attachment was already sent and has since been removed.':'Attachment sent.';await onSent?.({removed});
    } catch(error) {
      if(signal.aborted)return;
      if([401,403,404].includes(error.status)){state.messageDelivery=null;uploader.clear();onAccessLost?.();return;}
      status.textContent=error.status===423?'The document is saved. Its security check must finish before it can appear in this conversation.':error.status===422?'This document was blocked by its security check. It has not been sent.':error.status===409?'The document changed. Check the saved attachment before continuing.':'Attachment delivery is not confirmed. Check its status before trying again.';
      retry.hidden=error.status===422;
    } finally {busy=false;onChange?.();}
  }
  root.delivered=()=>state.messageDelivery?.sent===true;
  root.canSubmit=()=>!busy && uploader.canSubmit();
  root.hasSelection=()=>uploader.hasSelection();
  root.submit=async()=>{
    if(!root.canSubmit())return false;
    deliveryPromise=null;await uploader.submit();if(deliveryPromise)await deliveryPromise;
    return state.messageDelivery?.sent===true;
  };
  root.reset=()=>{state.messageDelivery=null;status.textContent='';retry.hidden=true;return uploader.reset();};
  root.prepareNext=()=>{if(state.messageDelivery?.sent)return root.reset();};
  root.clear=()=>{state.messageDelivery=null;uploader.clear();status.textContent='';retry.hidden=true;};
  root.readiness=uploader.readiness.then(()=>{if(state.messageDelivery&&!state.messageDelivery.sent)return deliver();});
  return root;
}
