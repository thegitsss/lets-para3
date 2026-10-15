import { createConversations } from '../attorney-v2/conversations.mjs';
import { node, button } from '../attorney-v2/dom.mjs';
import { conversationAvatar } from '../attorney-v2/conversation-avatar.mjs';
import { createMatterMessagesController } from './matter-messages.mjs';
import { LpcApiError } from './api-client.mjs';
import { createWorkspacePresenceController } from './workspace-presence.mjs';
import { withMatterReturn } from './router.mjs';
import { setSupportMatterContext } from '../utils/support-workspace-context.mjs';

// The inbox presentation is shared; reads and mutations retain the paralegal
// API/session boundary and the server's Matter experience permissions.
export function createConversationsView({api, getIdentity, onSessionLost, onChanged}) {
  let controller;
  let activeWorkspace;
  const presence = createWorkspacePresenceController({api});
  const messages = createMatterMessagesController({api, getIdentity, onSessionLost,
    onAccessLost: matterId => {
      if (activeWorkspace?.matterId === matterId && activeWorkspace.isCurrent()) void activeWorkspace.reload();
    },
    onChanged:() => { root?.refreshFromNotice?.(); onChanged?.(); }});
  let root;
  function workspace(route, identity, context) {
    messages.leave();
    const {signal}=context;
    signal.addEventListener('abort',()=>{messages.leave();presence.stop();},{once:true});
    const view=node('section',{className:'av2-inbox-workspace', 'data-tab':'messages'});
    const header=node('header',{className:'av2-matter-header'});
    const body=node('div',{className:'av2-matter-body'});
    let clearAssistantContext = () => {};
    let pendingLoad;
    const isCurrent = () => !signal.aborted && String(getIdentity()?.id || getIdentity()?._id || '') === String(identity.id || identity._id || '');
    view.append(header,body);
    async function readWorkspace() {
      messages.leave();
      presence.stop();
      clearAssistantContext();
      const back = header.querySelector('.av2-inbox-back');
      header.replaceChildren(...(back ? [back] : []));
      view.dataset.state='loading';
      body.replaceChildren(node('p',{role:'status',text:'Loading conversation…'}));
      try {
        const matter=await api.get(`/api/cases/${route.caseId}?${new URLSearchParams({expectedOwnerId:identity.id || identity._id})}`,{signal});
        if(!isCurrent())return;
        const experience=matter.matterExperience;
        if(!experience?.sections?.some(section=>section.id==='messages'))throw new Error('Messages are unavailable for this Matter.');
        clearAssistantContext();
        clearAssistantContext = setSupportMatterContext({ownerId:identity.id || identity._id,role:'paralegal',matterId:matter.id || matter._id,routeMatterId:route.caseId,currentTab:'messages',availableMatterTabs:experience.sections.map(section=>section.id),status:matter.status,relationship:experience.header?.relationship,signal});
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
        if(!isCurrent())return;
        const panel=messages.panel({matterId:route.caseId,messagesResult:result,filesResult:files,writable:!historical && experience.work?.readOnly!==true && !result?.unavailable,historical,highlightedMessageId:route.query.get('messageId') || '',highlightedFileId:route.query.get('fileId') || '',participant:person});
        body.replaceChildren(panel);messages.afterMount(view);view.dataset.state='ready';
        presence.start(route.caseId,{enabled:!historical,surface:'messages'});
      } catch(error) {
        clearAssistantContext();
        if(!isCurrent())return;
        view.dataset.state='error';
        if (error instanceof LpcApiError && [401,403,404].includes(error.status)) {
          const back = header.querySelector('.av2-inbox-back');
          header.replaceChildren(...(back ? [back] : []));
        }
        if (error instanceof LpcApiError && [403,404].includes(error.status)) {
          messages.discardMatter(route.caseId);
          root?.forgetConversation?.(route.caseId);
          onChanged?.();
          const heading=node('h2',{tabindex:'-1',text:'You no longer have access to this matter'});
          body.replaceChildren(heading);
          if(view.isConnected)heading.focus({preventScroll:true});
          return;
        }
        if (error instanceof LpcApiError && error.status===401) { messages.discardMatter(route.caseId); onSessionLost?.(); return; }
        body.replaceChildren(node('p',{role:'status',text:error.message || 'Conversation could not load.'}),button('Retry conversation',load));
      }
    }
    function load() {
      if(pendingLoad)return pendingLoad;
      pendingLoad=readWorkspace().finally(()=>{pendingLoad=null;});
      return pendingLoad;
    }
    activeWorkspace={matterId:route.caseId,isCurrent,reload:load};
    view.readiness=load();return view;
  }
  return {
    render({route}) {
      controller?.abort();controller=new AbortController();
      const wrapper=node('div',{className:'av2 pv2-conversations'});
      root=createConversations(route,getIdentity(),{api,signal:controller.signal,createConversationWorkspace:workspace,participantFallback:'Attorney unavailable'});
      wrapper.append(root);return wrapper;
    },
    leave(){controller?.abort();messages.leave();presence.stop();activeWorkspace=null;root=null;},
    clearDrafts(){messages.clearDrafts();},
    hasDrafts(){return messages.hasDrafts();},
  };
}
