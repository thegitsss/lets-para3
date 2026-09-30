import { node, page, link, button, recoveryButton, setRecovery } from './dom.mjs';
import { createReader, activityTime } from './home.mjs';
import { reconcileUnread, id } from './read-model.mjs';
import { objectId } from './workspace-model.mjs';
import { createMatterWorkspace } from './workspace.mjs';
import { conversationAvatar } from './conversation-avatar.mjs';

// The inbox is a navigation surface over the existing, owner-checked Matter
// conversation. Its pane retains the workspace's access checks, stream,
// presence lease, idempotent writes and per-Matter in-memory drafts.
export function createConversations(route, identity, context) {
  const { api, signal } = context;
  const root = page('Messages');
  root.removeAttribute('aria-labelledby');
  root.setAttribute('aria-label', 'Messages workspace');
  root.classList.add('av2-conversations-page');
  root.dataset.av2Region = 'messages';
  const read = createReader(api, signal);
  const count = node('span', {className:'av2-inbox-count'});
  const search = node('input', {type:'search', placeholder:'Search conversations', 'aria-label':'Search conversations', autocomplete:'off'});
  const searchIcon=document.createElementNS('http://www.w3.org/2000/svg','svg');searchIcon.setAttribute('viewBox','0 0 24 24');searchIcon.setAttribute('aria-hidden','true');
  const searchPath=document.createElementNS(searchIcon.namespaceURI,'path');searchPath.setAttribute('d','M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0');searchIcon.append(searchPath);
  const searchWrap = node('div', {className:'av2-inbox-search'}, [searchIcon,search]);
  const all = button('All', () => filter(false), 'av2-inbox-filter');
  all.setAttribute('aria-label','All');
  const unread = button('Unread', () => filter(true), 'av2-inbox-filter');
  const filters = node('div', {className:'av2-inbox-filters', 'aria-label':'Filter conversations'}, [all, unread]);
  const list = node('ul', {className:'av2-thread-list', 'aria-label':'Matter conversations'});
  const status = node('p', {role:'status', className:'av2-inbox-status'});
  const retry = recoveryButton('Retry conversations', () => void refresh());
  all.append(count);
  const sidebar = node('section', {className:'av2-inbox-sidebar', 'aria-label':'Conversation list'}, [searchWrap, filters, status, retry, list]);
  const pane = node('div', {className:'av2-inbox-pane'});
  const back = button('← Messages', () => { root.classList.remove('av2-thread-open'); search.focus(); }, 'av2-inbox-back');
  back.setAttribute('aria-label','← Messages');back.textContent='‹';
  const content = node('div', {className:'av2-inbox-content'});
  pane.append(back, content);
  root.append(node('div', {className:'av2-inbox'}, [sidebar, pane]));
  let data = null, onlyUnread = false, selected = objectId(route.query.get('matter')), child = null, ticket = 0, initialized = false;
  const empty = text => node('div', {className:'av2-inbox-empty'}, [node('p', {text})]);
  content.append(empty('Select a conversation to read and reply.'));
  function filter(value) { onlyUnread = value; paint(); }
  function paint() {
    if (data?.mismatch) onlyUnread = false;
    all.setAttribute('aria-pressed', String(!onlyUnread)); unread.setAttribute('aria-pressed', String(onlyUnread));
    if (!data) return;
    count.textContent = String(data.threads.length);
    unread.disabled = data.mismatch;
    const unreadThreads = data.threads.filter(thread => (data.byId.get(id(thread)) || 0) > 0).length;
    unread.textContent = data.mismatch || !unreadThreads ? 'Unread' : `Unread ${unreadThreads}`;
    const query = search.value.trim().toLocaleLowerCase();
    const matches = data.threads.filter(thread => (!onlyUnread || (data.byId.get(id(thread)) || 0) > 0) && [thread.title, thread.participant?.name, thread.lastSenderName, thread.lastMessageSnippet].some(value => String(value || '').toLocaleLowerCase().includes(query)));
    const focusedId = list.contains(document.activeElement) ? document.activeElement?.dataset.threadId : null;
    list.replaceChildren(...matches.map(thread => {
      const key = id(thread), unseen = !data.mismatch && (data.byId.get(key) || 0);
      const target = link('', `#/conversations?matter=${key}`, 'av2-thread-link');
      target.dataset.threadId = key;
      if (key === selected) target.setAttribute('aria-current','true');
      if (unseen) target.classList.add('av2-thread-unread');
      const title = thread.title || 'Matter messages';
      const person = thread.participant || {name:context.participantFallback || 'No assigned paralegal'};
      const heading = node('span', {className:'av2-thread-row-heading'}, [node('strong', {className:'av2-thread-person',text:person.name || 'Name unavailable'})]);
      if (Number.isFinite(Date.parse(thread.updatedAt))) heading.append(activityTime(thread.updatedAt));
      const preview = node('span', {className:'av2-thread-preview',text:`${thread.lastSenderName && thread.lastSenderName !== thread.participant?.name ? `${thread.lastSenderName}: ` : ''}${thread.lastMessageSnippet || 'No messages yet.'}`});
      const copy = node('span', {className:'av2-thread-copy'}, [heading, node('span',{className:'av2-thread-matter',text:title}), preview]);
      target.append(conversationAvatar(person), copy);
      if (unseen) target.append(node('span', {className:'av2-thread-unread-count',text:unseen,'aria-label':`${unseen} unread messages`}));
      target.addEventListener('click', event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button) return;
        event.preventDefault(); select(key); paint();
      });
      return node('li', {}, [target]);
    }));
    if (!matches.length) list.append(node('li', {className:'av2-inbox-list-empty',text:!data.threads.length ? 'No Matter conversations yet.' : query ? 'No conversations match your search.' : 'You’re caught up. No unread conversations.'}));
    if (focusedId) list.querySelector(`[data-thread-id="${focusedId}"]`)?.focus({preventScroll:true});
  }
  function select(key, {writeUrl = true} = {}) {
    root.classList.add('av2-thread-open');
    if (selected === key && child) return;
    child?.abort(); child = new AbortController(); selected = key;
    if (writeUrl) history.replaceState(history.state, '', `#/conversations?matter=${key}`);
    const query = new URLSearchParams(writeUrl ? '' : route.query); query.delete('matter');
    const thread = (context.createConversationWorkspace || createMatterWorkspace)({caseId:key, tab:'messages', query}, identity, {...context, signal:child.signal, presentation:'conversation', conversationParticipant:data?.threads.find(thread=>id(thread)===key)?.participant, onConversationChanged:() => void refresh({background:true})});
    thread.querySelector(".av2-matter-header")?.prepend(back);
    content.replaceChildren(thread);
  }
  async function refresh({background = false} = {}) {
    const generation = ++ticket;
    if (!background) { root.dataset.state = 'loading'; status.textContent = 'Loading conversations…'; }
    retry.disabled = true;
    try {
      const next = reconcileUnread(...await Promise.all([read('unread'), read('messageSummary'), read('threads')]));
      if (signal.aborted || generation !== ticket) return;
      data = next; root.dataset.state = 'ready'; status.textContent = data.mismatch ? 'Unread counts are updating.' : '';
      // A closed Matter can have retained correspondence outside the active inbox.
      // Its workspace verifies access; list membership is not an authorization check.
      if (selected && !child) select(selected, {writeUrl:false});
      else if (!initialized && !selected && data.threads.length && matchMedia('(min-width: 761px)').matches) select(id(data.threads[0]));
      initialized = true; paint();
    } catch {
      if (signal.aborted || generation !== ticket) return;
      data = null; list.replaceChildren(); count.textContent = '';
      if(selected && !child)select(selected,{writeUrl:false});
      if(!selected)content.replaceChildren(empty('Messages could not be loaded. Try again.'));
      root.dataset.state = 'error'; status.textContent = 'Messages couldn’t load.';
    } finally { if (!signal.aborted && generation === ticket) { retry.disabled = false; setRecovery(retry, root); } }
  }
  search.addEventListener('input', paint);
  root.refreshFromNotice = () => refresh({background:true});
  signal.addEventListener('abort', () => child?.abort(), {once:true});
  paint(); root.readiness = refresh();
  return root;
}
