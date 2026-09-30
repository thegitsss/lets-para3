import { createConversations } from '../attorney-v2/conversations.mjs';
import { node, button } from '../attorney-v2/dom.mjs';
import { conversationAvatar } from '../attorney-v2/conversation-avatar.mjs';
import { createMatterMessagesController } from './matter-messages.mjs';
import { withMatterReturn } from './router.mjs';

// The inbox presentation is shared; reads and mutations retain the paralegal
// API/session boundary and the server's Matter experience permissions.
export function createConversationsView({api, getIdentity, onSessionLost, onChanged}) {
  let controller;
  const messages = createMatterMessagesController({api, getIdentity, onSessionLost, onChanged:() => { root?.refreshFromNotice?.(); onChanged?.(); }});
  let root;
  function workspace(route, identity, context) {
    messages.leave();
    const {signal}=context;
    signal.addEventListener('abort',()=>messages.leave(),{once:true});
    const view=node('section',{className:'av2-inbox-workspace', 'data-tab':'messages'});
    const header=node('header',{className:'av2-matter-header'});
    const body=node('div',{className:'av2-matter-body'});
    view.append(header,body);
    async function load() {
      body.replaceChildren(node('p',{role:'status',text:'Loading conversation…'}));
      try {
        const matter=await api.get(`/api/cases/${route.caseId}?${new URLSearchParams({expectedOwnerId:identity.id || identity._id})}`,{signal});
        if(signal.aborted)return;
        const experience=matter.matterExperience;
        if(!experience?.sections?.some(section=>section.id==='messages'))throw new Error('Messages are unavailable for this Matter.');
        const historical=matter.readOnly===true || matter.archived===true || matter.paymentReleased===true || ['completed','closed','cancelled','canceled','expired'].includes(String(matter.status).toLowerCase());
        const person=context.conversationParticipant || {name:experience.overview?.attorney || 'Attorney'};
        const title=node('h2',{text:matter.title || experience.header?.title || 'Matter'});
        const identityBlock=node('div',{className:'av2-thread-identity'},[node('p',{className:'av2-thread-participant',text:person.name}),title]);
        const matterHref=withMatterReturn(`/matter/${route.caseId}?tab=overview`,route.query.get('returnTo'));
        const link=node('a',{className:'av2-thread-matter-link',href:`#${matterHref}`,'data-v2-route':'matter','aria-label':'View Matter',text:'View Matter'});
        const back=header.querySelector('.av2-inbox-back');
        const avatar=conversationAvatar(person);avatar.classList.add('av2-thread-header-avatar');
        header.replaceChildren(...(back?[back]:[]),avatar,identityBlock,link);
        const result=await api.get(`/api/messages/${route.caseId}`,{signal});
        const files=experience.sections.some(section=>section.id==='files') && !historical ? await api.get(`/api/uploads/case/${route.caseId}?presentation=matter`,{signal}) : null;
        if(signal.aborted)return;
        const panel=messages.panel({matterId:route.caseId,messagesResult:result,filesResult:files,writable:!historical && experience.work?.readOnly!==true && !result?.unavailable,historical,highlightedMessageId:route.query.get('messageId') || '',highlightedFileId:route.query.get('fileId') || '',participant:person});
        body.replaceChildren(panel);messages.afterMount(view);view.dataset.state='ready';
      } catch(error) {
        if(signal.aborted)return;
        view.dataset.state='error';
        body.replaceChildren(node('p',{role:'status',text:error.message || 'Conversation could not load.'}),button('Retry conversation',load));
      }
    }
    view.readiness=load();return view;
  }
  return {
    render({route}) {
      controller?.abort();controller=new AbortController();
      const wrapper=node('div',{className:'av2 pv2-conversations'});
      root=createConversations(route,getIdentity(),{api,signal:controller.signal,createConversationWorkspace:workspace,participantFallback:'Attorney unavailable'});
      wrapper.append(root);return wrapper;
    },
    leave(){controller?.abort();messages.leave();root=null;},
    clearDrafts(){messages.clearDrafts();},
    hasDrafts(){return messages.hasDrafts();},
  };
}
