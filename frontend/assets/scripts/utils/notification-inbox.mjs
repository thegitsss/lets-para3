import { showDocumentQuickLook } from './document-quick-look.mjs';

const idOf = value => String(value?.id || value?._id || '');
const read = value => value?.read === true || value?.isRead === true;
const validId = value => /^[a-f\d]{24}$/i.test(value || '');
function shortTime(value) {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return '';
  const minutes = Math.floor(elapsed / 60000);
  if(minutes < 1) return 'now';
  if(minutes < 60) return `${minutes}m`;
  if(minutes < 1440) return `${Math.floor(minutes/60)}h`;
  if(minutes < 10080) return `${Math.floor(minutes/1440)}d`;
  return new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
const messageText = message => typeof message?.text === 'string' ? message.text : typeof message?.content === 'string' ? message.content : message?.content?.text || message?.transcript || (message?.type === 'file' ? `Shared ${message.fileName || 'a document'}` : 'Message contents unavailable');
function el(tag, attrs = {}, children = []) {
  const result = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'text') result.textContent = value;
    else if (key === 'className') result.className = value;
    else result.setAttribute(key, String(value));
  }
  for (const child of children) if (child) result.append(child);
  return result;
}
function inboxIcon(name, className) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:className || ''})) svg.setAttribute(key,value);
  const paths={folder:['M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7Z'],discussion:['M14 15H6l-3 3V4h15v4','M10 12h11v10l-3-3h-8v-7Z'],file:['M14 3H5v18h14V8l-5-5Z','M14 3v5h5','M8 12h8M8 16h6'],send:['M12 19V5','m6 11 6-6 6 6']};
  for(const d of paths[name] || []) {const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);}
  return svg;
}
export function groupNotifications(items) {
  const groups = new Map();
  for (const item of items) {
    // Account events remain independent; never merge unrelated private records.
    const key = item.available === true && validId(item.context?.caseId) ? `matter:${item.context.caseId}` : `event:${idOf(item)}`;
    if (!groups.has(key)) groups.set(key, { key, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

// Only the bell panel uses this renderer. The full Updates page retains its
// existing pagination, actions and presentation.
export function createNotificationInbox({ api, panel, owner, isCurrent, markRead, markUnread, dismiss, navigate, destinationFor, timeLabel, deferRead }) {
  const states = new Map();
  let lifecycle = new AbortController();
  const previews = new Set();
  const current = (state, ticket = lifecycle.signal) => !ticket.aborted && states.get(state.key) === state && isCurrent() && state.ownerId === owner();
  function stateFor(group) {
    let state = states.get(group.key);
    if (!state) { state = { key: group.key, ownerId: owner(), expanded: false, drafts: new Map(), messages: new Map(), loading: new Set(), failures: new Map(), sending: new Set(), requests: new Map(), statuses: new Map(), sent: new Map(), composing: new Set() }; states.set(group.key, state); }
    const editing = state.expanded && (state.sending.size || state.requests.size || [...state.drafts.values()].some(Boolean) || state.root?.contains(document.activeElement));
    const incoming = state.group && group.items.some(item=>!state.group.items.some(old=>idOf(old)===idOf(item)));
    if(editing && incoming) state.pendingGroup = group;
    else { state.group = group; state.pendingGroup = null; }
    return state;
  }
  async function verifyOwner(signal) {
    const payload = await api.get('/api/auth/me', { signal });
    const user = payload?.user;
    if (!user || String(user.id || user._id) !== owner() || user.disabled || user.deleted || user.status !== 'approved') throw new Error('Your account changed. Reopen notifications.');
  }
  async function readMessage(state, item) {
    const id = idOf(item), caseId = item.context?.caseId, messageId = item.context?.messageId, signal = lifecycle.signal;
    if (!validId(caseId) || !validId(messageId) || state.loading.has(id) || state.messages.has(id)) return;
    state.loading.add(id); state.failures.delete(id); paint(state);
    try {
      await verifyOwner(signal);
      const result = api.readWorkspaceMessages
        ? await api.readWorkspaceMessages(caseId, { ownerId: state.ownerId, signal, messageId })
        : await api.get(`/api/messages/${caseId}`, { signal, headers: { 'X-LPC-Owner-Id': state.ownerId } });
      await verifyOwner(signal);
      if (!current(state, signal)) return;
      if (!Array.isArray(result?.messages) || result.caseId && result.caseId !== caseId) throw new Error('Message unavailable.');
      const target = result.messages.find(message => idOf(message) === messageId && String(message.caseId) === caseId && message.deleted !== true);
      if (!target) throw new Error('This message is no longer available.');
      state.messages.set(id, target);
    } catch (error) {
      if (current(state, signal)) state.failures.set(id, error.status === 403 || error.status === 404 ? 'This conversation is no longer available.' : 'Message contents could not load. Try again.');
    } finally { if (current(state, signal)) { state.loading.delete(id); paint(state); } }
  }
  function control(text, action, attrs = {}) {
    const button = el('button', { type: 'button', text, ...attrs });
    button.addEventListener('click', action); return button;
  }
  async function sendReply(state, item, textarea, status, send) {
    const id = idOf(item), caseId = item.context.caseId, replyTo = item.context.messageId, signal = lifecycle.signal;
    if (state.sending.has(id) || !current(state) || !textarea.value.trim()) return;
    const text = textarea.value.trim();
    let request = state.requests.get(id);
    // Ambiguous deliveries retain the exact text and request id. A retry checks
    // the same persisted send rather than creating a duplicate message.
    if (!request) { request = { text, clientMessageId: crypto.randomUUID() }; state.requests.set(id, request); }
    state.sending.add(id); textarea.disabled = true; send.disabled = true; status.textContent = 'Sending…';
    try {
      await verifyOwner(signal);
      const result = api.sendWorkspaceMessage
        ? await api.sendWorkspaceMessage(caseId, request.text, request.clientMessageId, { ownerId: state.ownerId, signal, replyTo })
        : await api.post(`/api/messages/${caseId}`, { text: request.text, clientMessageId: request.clientMessageId, replyTo }, { signal, headers: { 'X-LPC-Owner-Id': state.ownerId } });
      await verifyOwner(signal);
      if (!current(state, signal)) return;
      const saved = result?.message;
      if (!validId(idOf(saved)) || String(saved.caseId) !== caseId || String(saved.replyTo) !== replyTo || String(saved.senderId?._id || saved.senderId?.id || saved.senderId) !== state.ownerId || saved.clientMessageId !== request.clientMessageId) throw new Error('Unconfirmed reply');
      state.requests.delete(id); state.drafts.delete(id); state.statuses.set(id, 'Reply sent'); state.sent.set(id,messageText(saved));
      window.dispatchEvent(new CustomEvent('lpc:notifications-refreshed'));
    } catch (error) {
      if (current(state, signal)) {
        // Definitive rejection permits editing; a network/unknown outcome does
        // not, until the same request is explicitly retried.
        const rejected = [400,401,403,404,409,413,422,423].includes(error.status);
        if (rejected) state.requests.delete(id);
        state.statuses.set(id, rejected ? 'Reply was not sent. Check the conversation or edit your reply.' : 'Delivery could not be confirmed. Retry this same reply to check it.');
      }
    } finally {
      state.sending.delete(id);
      if (current(state, signal)) paint(state);
    }
  }
  function messageDetails(state, item) {
    const id = idOf(item), holder = el('div', { className: 'nc-message-details' }), message = state.messages.get(id);
    if (!validId(item.context?.messageId)) return holder;
    if (!message) {
      holder.append(el('p', { className: 'nc-detail-status', role: 'status', text: state.failures.get(id) || 'Loading message…' }));
      if (state.failures.has(id)) holder.append(control('Try again', () => void readMessage(state, item)));
      return holder;
    }
    holder.append(el('p', { className: 'nc-message-text', text: messageText(message) }));
    if (!state.composing.has(id)) return holder;
    const form = el('form', { className: 'nc-reply-form', 'aria-label': 'Reply in this conversation' });
    const label = `nc-reply-${id}`, textarea = el('textarea', { id: label, rows: 1, maxlength: 2000, placeholder: 'Reply…', 'data-notification-focus': `reply:${id}` });
    textarea.value = state.requests.get(id)?.text || state.drafts.get(id) || '';
    textarea.disabled = state.sending.has(id) || state.requests.has(id);
    const resize = () => { if(textarea.isConnected) { textarea.style.height='auto';textarea.style.height=`${Math.min(160,Math.max(36,textarea.scrollHeight))}px`; } };
    textarea.addEventListener('input', () => { state.drafts.set(id, textarea.value); send.disabled = !textarea.value.trim(); resize(); });
    requestAnimationFrame(resize);
    const status = el('p', { className: 'nc-detail-status', role: 'status', 'aria-live': 'polite', text: state.statuses.get(id) || '' });
    const send = el('button', { type: 'submit', className: 'nc-send', text: state.requests.has(id) ? 'Retry' : '↑', 'aria-label':state.requests.has(id)?'Retry reply':'Send reply' });
    if(!state.requests.has(id)) send.replaceChildren(inboxIcon('send','nc-send-icon'));
    send.disabled = state.sending.has(id) || !textarea.value.trim();
    const replyContext = el('div',{className:'nc-reply-context'},[
      el('label', { for: label, text: `Reply to ${item.actorFirstName || 'this message'}` }),
      el('span',{text:messageText(message)}),
    ]);
    form.append(replyContext, el('div',{className:'nc-composer'},[textarea,send]), status);
    form.addEventListener('submit', event => { event.preventDefault(); void sendReply(state, item, textarea, status, send); });
    textarea.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !send.disabled) { event.preventDefault(); form.requestSubmit(); } });
    if(state.sent.has(id)) holder.append(el('p',{className:'nc-sent-reply',text:`You: ${state.sent.get(id)}`}));
    state.composer = form;
    textarea.placeholder = `Reply to ${item.actorFirstName || 'this message'}…`;
    return holder;
  }
  async function previewDocument(state, item, trigger, status) {
    const { caseId, fileId } = item.context || {}, signal = lifecycle.signal;
    if (!validId(caseId) || !validId(fileId) || trigger.disabled) return;
    trigger.disabled = true; status.textContent = 'Opening document…';
    try {
      await verifyOwner(signal);
      let name = 'Shared document', mime = '', src;
      if (api.readWorkspaceFiles) {
        const value = await api.readWorkspaceFiles(caseId, { ownerId: state.ownerId, fileId, signal });
        const file = value?.selectedFile;
        if (value?.ownerId !== state.ownerId || value?.caseId !== caseId || idOf(file) !== fileId || !['clean','not_required'].includes(file.securityStatus)) throw new Error('Document unavailable');
        name = file.name; mime = file.mimeType;
        if (mime !== 'application/pdf') { navigate(destinationFor(item)); return; }
        src = await api.prepareMatterPdfPreview(caseId, fileId, file.revision, { ownerId: state.ownerId, signal });
      } else {
        const value = await api.get(`/api/uploads/case/${caseId}?presentation=matter`, { signal, headers: { 'X-LPC-Owner-Id': state.ownerId } });
        const file = value?.files?.find(value => idOf(value) === fileId);
        if (!file || !['clean','not_required'].includes(file.securityStatus)) throw new Error('Document unavailable');
        name = file.originalName || file.original || file.filename || name; mime = file.mimeType || file.mime;
        if (mime !== 'application/pdf') { navigate(destinationFor(item)); return; }
        src = `/api/uploads/case/${caseId}/${fileId}/download?preview=true`;
      }
      await verifyOwner(signal);
      if (!current(state, signal)) return;
      const host = el('div'), frame = el('iframe', { src, title: `Preview of ${name}` });
      frame.addEventListener('load', () => { try { if (frame.contentDocument?.contentType === 'application/json') frame.replaceWith(el('p', { role: 'alert', text: 'Document unavailable. Close this preview and check Files.' })); } catch {} });
      host.append(frame); document.body.append(host);
      let preview;
      preview = showDocumentQuickLook(host, { name, returnFocus: trigger, onClose: () => { previews.delete(preview); host.remove(); } });
      if (preview) previews.add(preview);
      status.textContent = '';
    } catch (error) { if (current(state, signal)) status.textContent = 'This document could not open. Check Files for its current access and security status.'; }
    finally { if (current(state, signal)) trigger.disabled = false; }
  }
  function paint(state) {
    if (!current(state) || !state.root || state.sending.size) return;
    const active = document.activeElement, focusKey = state.root.contains(active) ? active.dataset.notificationFocus : null;
    const selection = active instanceof HTMLTextAreaElement ? [active.selectionStart,active.selectionEnd] : null;
    const group = state.group, first = group.items[0];
    const allMessages = group.items.every(item => item.type === 'message');
    const matterTitle = first.context?.matterTitle || '';
    const actorLabel = first.actorFirstName || 'LPC';
    const heading = matterTitle ? `${actorLabel} ${allMessages ? 'sent messages in' : 'updated'}` : first.message;
    const people = el('span', { className: 'nc-people', 'aria-hidden': 'true' });
    people.append(el('span', { className: 'nc-person', text: actorLabel[0].toLocaleUpperCase() }));
    const latest = state.messages.get(idOf(first));
    const summary = control('', () => {
      state.expanded = !state.expanded; paint(state);
      if (state.expanded) {
        for (const item of group.items) if (item.type === 'message') { state.messages.delete(idOf(item)); void readMessage(state, item); }
        if(!deferRead?.()) void markRead(group.items.filter(item => !read(item)));
      }
      else if(deferRead?.()) void markRead(group.items.filter(item=>!read(item)));
    }, { className: 'nc-group-summary', 'aria-expanded': state.expanded, 'aria-controls': `nc-group-${idOf(first)}`, 'data-notification-focus': `group:${state.key}` });
    const preview = latest ? messageText(latest) : first.context?.matterTitle && group.items.length === 1 ? first.context.matterTitle : first.headline || first.message;
    const count = group.items.length > 1 ? el('span',{className:'nc-summary-count'}) : null;
    if(count) {
      const icon = inboxIcon('discussion','nc-discussion-icon');
      const messages=group.items.filter(item=>item.type==='message').length;
      const documents=group.items.filter(item=>validId(item.context?.fileId)).length;
      const other=group.items.length-messages-documents;
      const parts=[];
      if(messages)parts.push(`${messages} ${messages===1?'message':'messages'}`);
      if(documents)parts.push(`${documents} ${documents===1?'document':'documents'}`);
      if(other)parts.push(`${other} ${other===1?'update':'updates'}`);
      count.append(icon,document.createTextNode(parts.join(' · ')));
    }
    summary.append(people,el('span', { className: 'nc-summary-copy' }, [
      el('span', { className: 'nc-summary-title' }, matterTitle ? [el('strong',{text:actorLabel}), document.createTextNode(heading.slice(actorLabel.length))] : [document.createTextNode(heading)]),
      matterTitle ? el('span',{className:'nc-summary-matter'},[inboxIcon('folder','nc-matter-icon'),el('strong',{text:matterTitle})]) : null,
      preview !== heading ? el('span', { className: 'nc-summary-preview', text: preview }) : null,
      count,
    ]), el('time', { datetime: first.createdAt || '', 'data-nc-compact-time':'', title:timeLabel(first.createdAt), text: shortTime(first.createdAt) }));
    if(group.items.some(item=>!read(item))) summary.append(el('span',{className:'nc-unread','aria-label':'Unread'}));
    summary.append(el('span',{className:'nc-expand-chevron','aria-hidden':'true'}));
    const detail = el('div', { className: 'nc-group-details', id: `nc-group-${idOf(first)}` }); detail.hidden = !state.expanded;
    state.composer = null;
    if(state.expanded && !state.composing.size) {
      const target=group.items.find(item=>item.type==='message' && state.messages.has(idOf(item)));
      if(target)state.composing.add(idOf(target));
    }
    let previousActor = '', previousDay = '';
    if (state.expanded) for (const item of group.items) {
      const actor = item.actorFirstName || 'LPC', day = String(item.createdAt || '').slice(0,10);
      const continuation = actor === previousActor && day === previousDay;
      const row = el('section', { className: `nc-event${continuation?' nc-event-continuation':''}${validId(item.context?.fileId)?' nc-event-document':''}`, 'aria-label': item.headline || item.message, title: `${actor} · ${timeLabel(item.createdAt)}` });
      row.append(el('span', { className: 'nc-thread-avatar', 'aria-hidden':'true', text: actor.charAt(0).toUpperCase() }), el('div', { className: 'nc-event-heading' }, [el('strong', { text: actor }),el('time', { datetime: item.createdAt || '', text: timeLabel(item.createdAt) })]));
      previousActor=actor;previousDay=day;
      if (item.type === 'message') row.append(messageDetails(state,item));
      else if(!validId(item.context?.fileId)) row.append(el('p', { className: 'nc-message-text', text: item.message }));
      const destination = destinationFor(item), status = el('p', { className: 'nc-detail-status', role: 'status' }), actions = el('div', { className: 'nc-event-actions' });
      if(item.type==='message' && state.messages.has(idOf(item)) && !state.composing.has(idOf(item))) actions.append(control('Reply',()=>{
        state.composing.clear(); state.composing.add(idOf(item)); paint(state);
        state.root.querySelector(`[data-notification-focus="reply:${idOf(item)}"]`)?.focus({preventScroll:true});
      }));
      if (destination) {
        if (validId(item.context?.fileId)) {
          const prefix=`${item.actorFirstName || 'A participant'} uploaded `, suffix=` to ${item.context?.matterTitle}`;
          const name=item.message.startsWith(prefix)&&item.message.endsWith(suffix)?item.message.slice(prefix.length,-suffix.length):'Open document';
          const documentButton = control(name, event => void previewDocument(state,item,event.currentTarget,status), { className:'nc-document','aria-label':name,'data-notification-focus':`document:${idOf(item)}` });
          documentButton.replaceChildren(el('span',{className:'nc-document-icon'},[inboxIcon('file','nc-file-glyph')]),el('span',{className:'nc-document-copy'},[el('span',{className:'nc-document-name',text:name}),el('span',{className:'nc-document-type',text:/\.pdf$/i.test(name)?'PDF document':'Document'})]));
          actions.append(documentButton);
        }
      }
      const menu = el('details',{className:'nc-event-options'}), choices = el('div',{className:'nc-event-menu'});
      menu.append(el('summary',{'aria-label':`Actions for ${item.headline || item.message}`,text:'•••'}));
      if(destination) choices.append(control(item.type==='message'?'Open conversation ↗':item.action?.label || 'Open ↗',()=>navigate(destination)));
      choices.append(control(read(item)?'Mark as unread':'Mark as read',()=>{menu.open=false;read(item)?markUnread(item):void markRead([item]);}),control('Dismiss notification',()=>{menu.open=false;dismiss(item);}));
      menu.append(choices); actions.append(menu);
      row.append(actions,status); detail.append(row);
    }
    if(state.expanded && state.composer) detail.append(el('div',{className:'nc-thread-composer'},[state.composer]));
    state.root.replaceChildren(summary,detail);
    if(state.pendingGroup) {
      const incoming=state.pendingGroup.items.filter(item=>!state.group.items.some(old=>idOf(old)===idOf(item))).length;
      state.root.append(control(`${incoming} new ${incoming===1?'update':'updates'}`,()=>{
        state.group=state.pendingGroup;state.pendingGroup=null;paint(state);
        for(const item of state.group.items)if(item.type==='message')void readMessage(state,item);
      },{className:'nc-new-updates','data-notification-focus':`new:${state.key}`}));
    }
    if (focusKey) {
      const replacement = [...state.root.querySelectorAll('[data-notification-focus]')].find(e=>e.dataset.notificationFocus===focusKey);
      replacement?.focus({preventScroll:true}); if(selection && replacement instanceof HTMLTextAreaElement) replacement.setSelectionRange(...selection);
    }
  }
  return {
    render(items) {
      const nodes = [];
      for (const group of groupNotifications(items)) {
        const state = stateFor(group); state.root ||= el('article',{className:'nc-group'}); paint(state); nodes.push(state.root);
        if(group.items[0].type==='message' && !state.messages.has(idOf(group.items[0])) && !state.failures.has(idOf(group.items[0]))) void readMessage(state,group.items[0]);
      }
      if([...states.values()].some(state=>state.expanded && ([...state.drafts.values()].some(Boolean)||state.requests.size))) {
        const prior=[...panel.querySelectorAll('.nc-group')];
        nodes.sort((a,b)=>{const ai=prior.indexOf(a),bi=prior.indexOf(b);return (ai<0?prior.length:ai)-(bi<0?prior.length:bi);});
      }
      return nodes;
    },
    hasDraft() { return [...states.values()].some(s=>s.requests.size || [...s.drafts.values()].some(Boolean)); },
    resize() { for(const textarea of panel.querySelectorAll('.nc-composer textarea')) { textarea.style.height='auto';textarea.style.height=`${Math.min(160,Math.max(36,textarea.scrollHeight))}px`; } },
    reset() { lifecycle.abort(); lifecycle = new AbortController(); for(const preview of previews) preview.close(); previews.clear(); states.clear(); },
  };
}
