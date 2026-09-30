import { actionMenu } from "../attorney-v2/presentation.mjs";
import { conversationAvatar } from "../attorney-v2/conversation-avatar.mjs";
import { LpcApiError } from "./api-client.mjs";
import { ACCEPTED_FILE_TYPES, MAX_FILE_BYTES } from "./matter-files.mjs";

const POLL_INTERVAL_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  children.flat().filter(Boolean).forEach((child) => {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return element;
}

function dateTimeLabel(value) {
  const parsed = new Date(value || 0);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function bytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return "Size unavailable";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function messageText(message) {
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.content === "string") return message.content;
  if (typeof message?.content?.text === "string") return message.content.text;
  if (message?.type === "file") return message.fileName ? `Shared ${message.fileName}` : "Shared a file";
  if (message?.type === "audio") return message.transcript || message.content?.transcript || "Audio message";
  return "Message";
}

function senderName(message) {
  const sender = message?.senderId || message?.sender || {};
  if (sender && typeof sender === "object") {
    return [sender.firstName, sender.lastName].filter(Boolean).join(" ") || String(sender.role || "LPC member");
  }
  return "LPC member";
}

function senderId(message) {
  const sender = message?.senderId || message?.sender;
  if (sender && typeof sender === "object") return String(sender._id || sender.id || "");
  return String(sender || "");
}

function messageId(message) {
  return String(message?._id || message?.id || "");
}

function filesFrom(result) {
  return Array.isArray(result?.files) ? result.files : [];
}

function fileId(file) {
  return String(file?.id || file?._id || "");
}

function fileName(file) {
  return String(file?.originalName || file?.original || file?.filename || "Matter file");
}

function fileReady(file) {
  return ["clean", "not_required"].includes(String(file?.securityStatus || "").toLowerCase());
}

function normalizedMessages(result) {
  if (Array.isArray(result?.messages)) return result.messages;
  return Array.isArray(result) ? result : [];
}

function conversationFingerprint(messagesResult, filesResult) {
  return JSON.stringify({
    messages: normalizedMessages(messagesResult).map((message) => ({
      id: messageId(message),
      text: messageText(message),
      createdAt: String(message?.createdAt || message?.created || ""),
      editedAt: String(message?.editedAt || ""),
      deleted: message?.deleted === true,
      pinned: message?.pinned === true,
      readBy: Array.isArray(message?.readBy) ? message.readBy.map(String).sort() : [],
      reactions: message?.reactions && typeof message.reactions === 'object' ? message.reactions : {},
    })),
    files: filesFrom(filesResult).map((file) => ({
      id: fileId(file),
      name: fileName(file),
      status: String(file?.status || ""),
      securityStatus: String(file?.securityStatus || ""),
      version: Number(file?.version || 0),
    })),
  });
}

function latestTimestamp(messages) {
  let latest = 0;
  messages.forEach((message) => {
    const timestamp = new Date(message?.createdAt || message?.created || 0).getTime();
    if (Number.isFinite(timestamp)) latest = Math.max(latest, timestamp);
  });
  return latest ? new Date(latest).toISOString() : null;
}

function timelineEntries(state) {
  const messages = normalizedMessages(state.result).map((value) => ({
    type: "message",
    value,
    at: new Date(value?.createdAt || value?.created || 0).getTime() || 0,
    id: messageId(value),
  }));
  const linkedFileIds = new Set(messages.map(entry=>String(entry.value.content?.caseFileId || "")).filter(Boolean));
  const pendingFileIds = new Set(state.attachments.filter(entry=>entry.status!=="uploaded").map(entry=>entry.uploaded?.file?.id));
  const files = filesFrom(state.filesResult).filter(file=>!linkedFileIds.has(fileId(file)) && !pendingFileIds.has(fileId(file))).map((value) => ({
    type: "file",
    value,
    at: new Date(value?.uploadedAt || value?.createdAt || 0).getTime() || 0,
    id: fileId(value),
  }));
  const pending = state.pendingDelivery;
  const pendingAlreadyConfirmed = pending && messages.some((entry) => {
    const value = entry.value;
    const createdAt = new Date(value?.createdAt || value?.created || 0).getTime();
    return senderId(value) === state.viewerId
      && messageText(value) === pending.text
      && createdAt >= pending.createdAt - 5_000;
  });
  const pendingEntries = pending && !pendingAlreadyConfirmed ? [{
    type: "message",
    value: {
      _id: `pending-${pending.id}`,
      text: pending.text,
      createdAt: new Date(pending.createdAt).toISOString(),
      senderId: { _id: state.viewerId },
      pending: true,
    },
    at: pending.createdAt,
    id: `pending-${pending.id}`,
  }] : [];
  return [...messages, ...files, ...pendingEntries].sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
}

function fileIcon(){
  const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');
  const path=document.createElementNS(icon.namespaceURI,'path');path.setAttribute('d','M13 3H5v18h14V9l-6-6v6h6M8 13h8m-8 4h5');icon.append(path);return icon;
}

function fileTimelineItem(state, entry) {
  const file = entry.value;
  const id = fileId(file);
  const own = String(file?.uploadedBy || file?.userId || "") === state.viewerId
    || String(file?.uploadedByRole || "").toLowerCase() === "paralegal";
  const ready = fileReady(file) && !state.historical;
  const security = String(file?.securityStatus || "pending").toLowerCase();
  const status = ready ? "Available" : security === "blocked" ? "Unavailable" : security === "error" ? "Check unavailable" : "Security check in progress";
  return node("li", {
    className: `v2-matter-message-file${id === state.highlightedFileId ? " is-highlighted" : ""}`,
    ...(id ? { "data-file-id": id, tabindex: "-1" } : {}),
  }, [
    node("div", { className: "v2-matter-message-meta" }, [
      node("strong", { text: own ? "You shared a file" : "File shared" }),
      node("time", { datetime: file.uploadedAt || file.createdAt || "", text: dateTimeLabel(file.uploadedAt || file.createdAt) }),
    ]),
    node("div", { className: "v2-matter-message-file-row av2-attachment-tile" }, [
      node("button",{type:"button",className:"av2-file-open",'data-v2-message-file-download':id,disabled:!ready,'aria-label':`Download ${fileName(file)}`},[
        fileIcon(),node('span',{className:'av2-file-copy'},[node('span',{className:'av2-file-name',text:fileName(file)}),node('span',{className:'av2-file-meta',text:`${bytes(file.size)}${ready?'':` · ${status}`}`})]),
        node('span',{'aria-hidden':'true',className:'av2-file-download-icon',text:'↓'}),
      ]),
    ]),
  ]);
}

function renderConversation(state) {
  state.renderAfterMenu = false;
  const content = state.panel.querySelector("[data-v2-message-content]");
  if (!content) return;
  if (state.result?.unavailable) {
    content.replaceChildren(node("div", { className: "v2-matter-locked" }, [
      node("strong", { text: "Messages are unavailable" }),
      node("p", { text: state.result.message || "Messaging is closed for this matter." }),
    ]));
    return;
  }

  const entries = timelineEntries(state);
  if (!entries.length) {
    content.replaceChildren(node("p", { className: "v2-matter-empty", text: "No messages or files yet. Start the conversation when you’re ready." }));
    return;
  }

  const previousIds=new Set([...content.querySelectorAll("[data-message-id]")].map(item=>item.dataset.messageId));
  const scrollTop = content.scrollTop;
  const nearBottom = state.scrollToEnd || content.scrollHeight - content.clientHeight - scrollTop < 48;
  state.scrollToEnd=false;
  const focused = content.querySelector(':focus');
  const focusId = focused?.closest('[data-message-id]')?.dataset.messageId;
  state.menuController?.abort();state.menuController=new AbortController();
  const list = node("ol", {className:"av2-conversation v2-matter-message-list"});
  let day = '', previous = null;
  entries.forEach(entry => {
    const date = new Date(entry.at).toLocaleDateString(undefined,{month:'short',day:'numeric'});
    if(date!==day){list.append(node('li',{className:'av2-message-date',text:date}));day=date;previous=null;}
    if(entry.type==='file'){list.append(fileTimelineItem(state,entry));previous=null;return;}
    const message=entry.value, id=messageId(message), own=senderId(message)===state.viewerId, pending=message.pending===true;
    const grouped=previous && senderId(previous)===senderId(message) && entry.at-new Date(previous.createdAt).getTime()<300000;
    const item=node('li',{'data-message-id':id,'data-message-own':String(own),tabindex:'-1',className:grouped?'av2-message-continuation':''});
    if(!own&&!grouped){const avatar=conversationAvatar(state.participant || {name:senderName(message)});avatar.classList.add('av2-message-avatar');item.append(avatar);}
    item.append(node('div',{className:'av2-message-heading'},[node('strong',{text:own?'You':senderName(message)}),node('time',{datetime:message.createdAt || '',text:pending?'Sending…':new Date(entry.at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})})]));
    if(message.type==='file'){
      const file=filesFrom(state.filesResult).find(file=>fileId(file)===String(message.content?.caseFileId || ''));
      if(file){const tile=fileTimelineItem(state,{value:file});item.append(tile.querySelector('.v2-matter-message-file-row'));}
      else item.append(node('p',{className:'av2-preserve-lines',text:message.fileName || 'File unavailable'}));
    }else if(state.edit?.id===id){
      item.classList.add('av2-editing-message');
      const field=node('textarea',{className:'av2-inline-edit-field','aria-label':'Message text',maxlength:'2000',rows:'2',text:state.edit.text});
      field.addEventListener('input',()=>{state.edit.text=field.value;save.disabled=!field.value.trim()||state.mutating;});
      const save=node('button',{type:'button',className:'av2-inline-save','aria-label':'Save message',text:'Save',disabled:state.mutating||!state.edit.text.trim()});
      save.addEventListener('click',()=>state.mutate(message,'edit',{content:state.edit.text}));
      const cancel=node('button',{type:'button',className:'av2-composer-cancel','aria-label':'Cancel edit',text:'Cancel',disabled:state.mutating});
      cancel.addEventListener('click',()=>state.cancelEdit());
      field.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();state.cancelEdit();}else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();save.click();}});
      field.disabled=state.mutating;
      item.append(node('div',{className:'av2-message-editor'},[field,node('div',{className:'av2-inline-edit-actions'},[cancel,save])]));
    }else{
      item.append(node('p',{className:'av2-preserve-lines',text:messageText(message)}));
      if(message.pinned)item.append(node('small',{className:'av2-muted',text:'Pinned'}));
      if(own && (message.readBy || []).some(value=>String(value?._id||value)!==state.viewerId))item.append(node('p',{className:'av2-muted',text:'Read'}));
      if(state.writable&&!pending){
        const actions=[];
        if(own && (!message.type || message.type==='text'))actions.push({label:'Edit message',action:()=>state.beginEdit(message)});
        if(own)actions.push({label:message.pinned?'Unpin message':'Pin message',action:()=>state.mutate(message,'pin',message.pinned?{unpin:true}:{pin:true})});
        actions.push({label:'React 👍',action:()=>state.mutate(message,'react',{emoji:'👍'})});
        if(own)actions.push({label:'Delete message',action:()=>state.confirmDelete(message)});
        const menu=actionMenu('Message actions',actions.map(({label,action})=>{const button=node('button',{type:'button',text:label});button.addEventListener('click',action);return button;}),state.menuController.signal);
        menu.addEventListener('toggle',()=>{
          if(menu.open){item.classList.remove('av2-message-menu-up');if(menu.querySelector('.av2-context-options').getBoundingClientRect().bottom>content.getBoundingClientRect().bottom)item.classList.add('av2-message-menu-up');}
          else state.flushMenuRefresh?.();
        },{signal:state.menuController.signal});
        item.append(menu);
      }
      const reactions=message.reactions || {};
      const reactionEntries=Array.isArray(reactions)?reactions.map(r=>[r.emoji,r.users||[]]):Object.entries(reactions);
      if(reactionEntries.length)item.append(node('div',{className:'av2-message-reactions'},reactionEntries.map(([emoji,users])=>{
        const ownReaction=users.some(value=>String(value?._id||value)===state.viewerId);
        const control=node('button',{type:'button',text:`${emoji} ${users.length}`,'aria-label':`${ownReaction?'Remove':'Add'} ${emoji} reaction`,'aria-pressed':String(ownReaction),disabled:!state.writable});
        control.addEventListener('click',()=>state.mutate(message,ownReaction?'unreact':'react',{emoji}));return control;
      })));
    }
    list.append(item);previous=message;
  });
  content.replaceChildren(list);
  content.scrollTop=nearBottom?content.scrollHeight:scrollTop;
  if(nearBottom)state.unseen=false;
  else if(previousIds.size && entries.some(entry=>entry.type==='message' && !previousIds.has(entry.id) && senderId(entry.value)!==state.viewerId))state.unseen=true;
  const newMessages=state.panel.querySelector('[data-new-messages]');if(newMessages)newMessages.hidden=!state.unseen;
  if(focusId)content.querySelector(`[data-message-id="${CSS.escape(focusId)}"]`)?.focus({preventScroll:true});

}

function setStatus(state, message, kind = "") {
  const status = state.panel.querySelector("[data-v2-message-status]");
  if (!status) return;
  status.textContent = String(message || "");
  if (kind) status.dataset.kind = kind;
  else delete status.dataset.kind;
}

function setSending(state, sending) {
  state.sending = sending;
  const form = state.panel.querySelector("[data-v2-message-form]");
  const button = form?.querySelector("button[type='submit']");
  const input = form?.querySelector("[data-v2-message-input]");
  const picker = form?.querySelector("[data-v2-message-attachment-picker]");
  if (form) form.setAttribute("aria-busy", String(sending));
  if (input) input.readOnly = sending || Boolean(state.edit);
  if (picker) picker.setAttribute("aria-disabled", String(sending || Boolean(state.edit)));
  if (button) {
    button.disabled = sending || Boolean(state.edit) || !state.writable || !(input?.value.trim() || state.attachments.some(entry=>entry.status!=="uploaded"));
    button.textContent = sending ? "Sending…" : "Send";
  }
}

function lockComposer(state, message) {
  state.writable = false;
  state.renderAfterMenu = false;
  state.drafts.delete(state.draftKey);
  state.edit=null;state.attachments=[];state.menuController?.abort();
  state.panel.querySelector("dialog")?.close();
  state.panel.querySelector("[data-v2-message-content]")?.replaceChildren();
  state.panel.querySelector("[data-v2-message-form]")?.remove();
  setStatus(state, message || "Messaging is no longer available for this matter.", "error");
}

function isSameFile(left, right) {
  return Boolean(left && right && left.name === right.name && left.size === right.size && left.lastModified === right.lastModified);
}

function createClientUploadId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function attachmentEntry(file) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    clientUploadId: createClientUploadId(),
    file,
    status: "pending",
    progress: 0,
    error: "",
    controller: null,
  };
}

function saveDraft(state) {
  if (!state.writable) return;
  const text = String(state.panel.querySelector("[data-v2-message-input]")?.value || "");
  const attachments = state.attachments.filter((entry) => entry.status !== "uploaded");
  if (!text && !attachments.length && !state.edit) {
    state.drafts.delete(state.draftKey);
    return;
  }
  const pendingMessage = state.pendingMessage?.text === text ? state.pendingMessage : null;
  state.drafts.set(state.draftKey, { text, attachments, pendingMessage, edit:state.edit });
}

function renderAttachments(state) {
  const list = state.panel.querySelector("[data-v2-message-attachments]");
  if (!list) return;
  list.hidden = state.attachments.length === 0;
  list.replaceChildren(...state.attachments.map((entry) => {
    const status = entry.status === "uploading" ? `Sharing${entry.progress ? ` ${entry.progress}%` : "…"}`
      : entry.status === "uploaded" ? "Shared"
        : entry.status === "failed" ? entry.error || "Could not share" : "Ready to share";
    const action = entry.status === "uploading" ? "Cancel" : entry.status === "failed" ? "Retry" : entry.status === "uploaded" ? "" : "Remove";
    return node("li", { "data-v2-message-attachment": entry.id, "data-status": entry.status }, [
      node("span", {}, [node("strong", { text: entry.file.name }), node("small", { text: `${bytes(entry.file.size)} · ${status}` })]),
      action ? node("button", { type: "button", "data-v2-message-attachment-action": entry.id, text: action }) : null,
    ]);
  }));
  saveDraft(state);
  setSending(state,state.sending);
}

function addAttachments(state, incoming) {
  if (!state.writable || state.sending || state.edit) return;
  const files = Array.from(incoming || []).filter(Boolean);
  let invalid = "";
  files.forEach((file) => {
    if (file.size > MAX_FILE_BYTES) {
      invalid = `${file.name} is larger than 20 MB.`;
      return;
    }
    if (!state.attachments.some((entry) => isSameFile(entry.file, file))) state.attachments.push(attachmentEntry(file));
  });
  renderAttachments(state);
  setStatus(state, invalid, invalid ? "error" : "");
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function createMatterMessagesController({ api, getIdentity, onSessionLost, onAccessLost, onChanged, onMatterChanged, onFilesChanged } = {}) {
  const panelStates = new WeakMap();
  const drafts = new Map();
  // The Matter panel is replaced when its tab changes. Keep read progress at
  // controller scope so a remount cannot acknowledge the same conversation
  // twice while the first request is still in flight.
  const readWatermarks = new Map();
  let current = null;
  let generation = 0;
  let refreshController = null;
  let eventSource = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let refreshTimer = null;
  let channel = null;

  function stopRealtime() {
    eventSource?.close();
    eventSource = null;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (pollTimer) window.clearInterval(pollTimer);
    if (refreshTimer) window.clearTimeout(refreshTimer);
    reconnectTimer = null;
    pollTimer = null;
    refreshTimer = null;
    channel?.close?.();
    channel = null;
  }

  function leave() {
    generation += 1;
    refreshController?.abort();
    refreshController = null;
    if (current) {
      current.attachments.forEach((entry) => {
        if (entry.status === "uploading") {
          entry.controller?.abort();
          entry.status = "pending";
          entry.controller = null;
        }
      });
      current.menuController?.abort();
      current.panel.querySelector("dialog")?.close();
      saveDraft(current);
    }
    stopRealtime();
    current = null;
  }

  function handleAccessError(state, error) {
    if (error instanceof LpcApiError && error.status === 401) {
      drafts.clear();
      onSessionLost?.();
      return true;
    }
    if (error instanceof LpcApiError && [403, 404].includes(error.status)) {
      lockComposer(state, error.message);
      stopRealtime();
      onAccessLost?.(state.matterId);
      onMatterChanged?.();
      return true;
    }
    return false;
  }

  async function markRead(state, messages) {
    const upTo = latestTimestamp(messages);
    if (!upTo || state !== current) return;
    const matterId = String(state.matterId || "");
    if (readWatermarks.get(matterId) === upTo) return;
    readWatermarks.set(matterId, upTo);
    try {
      await api.post(`/api/messages/${encodeURIComponent(state.matterId)}/read`, { upTo });
      if (state === current) onChanged?.({ reason: "read", matterId: state.matterId });
    } catch (error) {
      if (readWatermarks.get(matterId) === upTo) readWatermarks.delete(matterId);
      if (!handleAccessError(state, error)) setStatus(state, "We couldn’t mark these messages as read.", "error");
    }
  }

  async function loadConversation(state, signal) {
    const requests = [api.get(`/api/messages/${encodeURIComponent(state.matterId)}`, { signal })];
    if (state.canReadFiles && !state.historical) {
      requests.push(api.get(`/api/uploads/case/${encodeURIComponent(state.matterId)}?presentation=matter`, { signal }));
    }
    const [messagesResult, filesResult] = await Promise.all(requests);
    return { messagesResult, filesResult: filesResult || state.filesResult };
  }

  async function refresh(state, { announce = false } = {}) {
    if (state !== current) return;
    const requestGeneration = generation;
    refreshController?.abort();
    refreshController = new AbortController();
    if (announce) setStatus(state, "Updating conversation…");
    try {
      const previousFingerprint = conversationFingerprint(state.result, state.filesResult);
      const { messagesResult, filesResult } = await loadConversation(state, refreshController.signal);
      if (state !== current || requestGeneration !== generation) return;
      const changed = previousFingerprint !== conversationFingerprint(messagesResult, filesResult);
      state.result = messagesResult;
      state.filesResult = filesResult;
      if (changed && !state.edit) {
        // Keep an action being chosen in place while receipts or messages arrive.
        // Access failures still render immediately; the latest successful read
        // is painted when the menu closes, without acknowledging unseen content.
        if (!messagesResult?.unavailable && state.panel.querySelector(".av2-context-menu[open]")) state.renderAfterMenu = true;
        else renderConversation(state);
      }
      if (announce) setStatus(state, "");
      if(!state.unseen && !state.renderAfterMenu)await markRead(state, normalizedMessages(messagesResult));
      if (state === current && changed) onChanged?.({ reason: "refresh", matterId: state.matterId });
    } catch (error) {
      if (error?.name === "AbortError" || state !== current || requestGeneration !== generation) return;
      if (!handleAccessError(state, error)) setStatus(state, error?.message || "The conversation could not be updated right now.", "error");
    }
  }

  function scheduleRefresh() {
    if (!current || refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refresh(current);
    }, 100);
  }

  function startPolling() {
    if (pollTimer || !current) return;
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") scheduleRefresh();
    }, POLL_INTERVAL_MS);
  }

  function startStream(state) {
    if (state !== current) return;
    if (typeof EventSource !== "function") {
      startPolling();
      return;
    }
    const source = new EventSource(`/api/cases/${encodeURIComponent(state.matterId)}/stream`);
    eventSource = source;
    source.addEventListener("open", () => {
      scheduleRefresh();
    });
    source.addEventListener("messages", scheduleRefresh);
    source.addEventListener("documents", scheduleRefresh);
    source.addEventListener("case", () => onMatterChanged?.());
    source.addEventListener("error", () => {
      if (eventSource !== source) return;
      source.close();
      eventSource = null;
      startPolling();
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (state === current) startStream(state);
      }, RECONNECT_DELAY_MS);
    });
  }

  function publishSync(state) {
    try { channel?.postMessage({ matterId: state.matterId, at: Date.now() }); } catch {}
  }

  async function uploadEntry(state, entry) {
    entry.status = "uploading";
    entry.progress = 0;
    entry.error = "";
    entry.controller = new AbortController();
    renderAttachments(state);
    const formData = new FormData();
    formData.append("file", entry.file);
    formData.append("caseId", state.matterId);
    formData.append("clientUploadId", entry.clientUploadId);
    try {
      const uploaded = entry.uploaded || await api.upload(`/api/uploads/case/${encodeURIComponent(state.matterId)}?presentation=matter`, formData, {
        signal: entry.controller.signal,
        onProgress(progress) {
          entry.progress = progress;
          if (state === current) renderAttachments(state);
        },
      });
      const file=uploaded.file;
      if(!file?.id || !Number.isSafeInteger(file.version))throw new Error('Upload could not be confirmed. Retry to check the saved file.');
      if(uploaded.changedSinceUpload)throw new Error('This document changed after upload. Review it in Files before sharing.');
      entry.uploaded=uploaded;
      entry.clientMessageId ||= createClientUploadId();
      const delivery=await api.post(`/api/messages/${encodeURIComponent(state.matterId)}/file`,{fileId:file.id,fileVersion:file.version,clientMessageId:entry.clientMessageId},{signal:entry.controller.signal});
      if(!messageId(delivery?.message) || String(delivery.message.caseId)!==state.matterId || senderId(delivery.message)!==state.viewerId || delivery.message.type!=='file')throw new Error('Attachment delivery could not be confirmed. Retry this same attachment.');
      entry.status = "uploaded";
      entry.controller = null;
      renderAttachments(state);
      onFilesChanged?.({ reason: "uploaded", matterId: state.matterId });
      return true;
    } catch (error) {
      if (error?.name === "AbortError") {
        entry.status = "pending";
        entry.progress = 0;
        entry.error = "";
      } else {
        entry.status = "failed";
        entry.progress = 0;
        entry.error = error?.message || "Could not share";
      }
      entry.controller = null;
      renderAttachments(state);
      if (handleAccessError(state, error)) return false;
      return false;
    }
  }

  async function uploadEntries(state, entries) {
    let cursor = 0;
    const outcomes = new Array(entries.length).fill(false);
    const workers = Array.from({ length: Math.min(3, entries.length) }, async () => {
      while (state === current) {
        const index = cursor;
        cursor += 1;
        if (index >= entries.length) return;
        outcomes[index] = await uploadEntry(state, entries[index]);
      }
    });
    await Promise.all(workers);
    return outcomes;
  }

  async function send(state) {
    const input = state.panel.querySelector("[data-v2-message-input]");
    const text = String(input?.value || "").trim();
    const pending = state.attachments.filter((entry) => ["pending", "failed"].includes(entry.status));
    if (!text && !pending.length) {
      setStatus(state, "Write a message or attach a file before sending.", "error");
      input?.focus();
      return;
    }
    if (state.sending || state.edit || state !== current || !state.writable) return;

    setSending(state, true);
    setStatus(state, pending.length ? "Sharing files…" : "");
    try {
      const uploadOutcomes = await uploadEntries(state, pending);
      if (state !== current) return;
      const failedIndex = uploadOutcomes.findIndex((uploaded) => !uploaded);
      if (failedIndex >= 0) {
        const entry = pending[failedIndex];
        if (state.writable) setStatus(state, `${entry.file.name} could not be shared. Retry it before sending the message.`, "error");
        return;
      }
      if (text) {
        if (!state.pendingMessage || state.pendingMessage.text !== text) {
          state.pendingMessage = { id: createClientUploadId().replace(/^upload-/, "message-"), text };
        }
        state.pendingDelivery = {
          id: state.pendingMessage.id,
          text,
          createdAt: Date.now(),
        };
        saveDraft(state);
        renderConversation(state);
        const sent = await api.post(`/api/messages/${encodeURIComponent(state.matterId)}`, {
          text,
          clientMessageId: state.pendingMessage.id,
        });
        if (state !== current) return;
        if (sent?.message) {
          const confirmedId = messageId(sent.message);
          const existing = normalizedMessages(state.result);
          state.result = {
            ...(Array.isArray(state.result) ? {} : state.result),
            messages: [...existing.filter((item) => !confirmedId || messageId(item) !== confirmedId), sent.message],
          };
        }
        state.pendingDelivery = null;
        state.scrollToEnd=true;
        renderConversation(state);
        input.value = "";
        state.pendingMessage = null;
      }
      state.attachments = [];
      drafts.delete(state.draftKey);
      renderAttachments(state);
      await refresh(state);
      if (state !== current) return;
      setStatus(state, text ? "Message sent." : "Files shared.", "success");
      publishSync(state);
      onChanged?.({ reason: text ? "sent" : "uploaded", matterId: state.matterId });
    } catch (error) {
      if (state !== current || error?.name === "AbortError") return;
      state.pendingDelivery = null;
      renderConversation(state);
      if (!handleAccessError(state, error)) setStatus(state, error?.message || "Your message could not be sent. Please try again.", "error");
    } finally {
      if (state === current) {setSending(state, false);saveDraft(state);}
    }
  }

  async function mutate(state, message, action, body) {
    if(state!==current || !state.writable || state.mutating || state.sending)return;
    state.mutating=true;setSending(state,true);
    try {
      // Keep the paralegal mutation endpoint and its participant/ownership checks.
      const path=`/api/messages/${encodeURIComponent(state.matterId)}/${encodeURIComponent(messageId(message))}${['react','unreact'].includes(action)?'/react':''}`;
      const result=await api.request(path,{method:['delete','unreact'].includes(action)?'DELETE':action==='react'?'POST':'PATCH',body:JSON.stringify(body)});
      if(state!==current)return;
      if(result?.ok!==true)throw new Error('The change could not be confirmed.');
      state.edit=null;state.panel.querySelector('dialog')?.close();
      await refresh(state);renderConversation(state);saveDraft(state);publishSync(state);
      onChanged?.({reason:action,matterId:state.matterId});setStatus(state,'');
    }catch(error){
      if(state===current&&!handleAccessError(state,error))setStatus(state,error.message || 'The change could not be confirmed. Your text is preserved.','error');
    }finally{if(state===current){state.mutating=false;setSending(state,false);state.panel.querySelectorAll('.av2-message-editor button,.av2-message-editor textarea,dialog button').forEach(control=>control.disabled=false);}}
  }
  function confirmDelete(state,message) {
    if(state.sending || state.mutating)return;
    state.panel.querySelector('dialog')?.remove();
    const dialog=node('dialog',{className:'av2-message-delete-dialog','aria-label':'Delete this message?'});
    const cancel=node('button',{type:'button',className:'av2-composer-cancel',text:'Cancel','aria-label':'Keep message'});
    const remove=node('button',{type:'button',className:'av2-message-delete',text:'Delete','aria-label':'Delete message'});
    cancel.addEventListener('click',()=>dialog.close());
    remove.addEventListener('click',()=>{cancel.disabled=true;remove.disabled=true;void mutate(state,message,'delete',{});});
    dialog.addEventListener('cancel',event=>{if(state.mutating)event.preventDefault();});
    dialog.append(node('h2',{text:'Delete this message?'}),node('p',{className:'av2-delete-preview',text:messageText(message)}),node('p',{text:'It will be removed from the conversation. LPC retains the record.'}),node('div',{className:'av2-delete-actions'},[cancel,remove]));
    state.panel.append(dialog);dialog.showModal();cancel.focus();
  }

  async function download(state, id) {
    if (!id || state.downloadingId || state !== current) return;
    const file = filesFrom(state.filesResult).find((entry) => fileId(entry) === id);
    if (!file) return;
    state.downloadingId = id;
    const button = state.panel.querySelector(`[data-v2-message-file-download="${CSS.escape(id)}"]`);
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy","true");
    }
    try {
      const blob = await api.blob(`/api/uploads/case/${encodeURIComponent(state.matterId)}/${encodeURIComponent(id)}/download`, { headers: { Accept: "application/octet-stream" } });
      if (state === current) triggerDownload(blob, fileName(file));
    } catch (error) {
      if (state === current && !handleAccessError(state, error)) setStatus(state, error?.message || "The file could not be downloaded.", "error");
    } finally {
      if (state === current) {
        state.downloadingId = "";
        const nextButton = state.panel.querySelector(`[data-v2-message-file-download="${CSS.escape(id)}"]`);
        if (nextButton) {
          nextButton.disabled = false;
          nextButton.removeAttribute("aria-busy");
        }
      }
    }
  }

  function panel({ matterId, messagesResult, filesResult, highlightedMessageId = "", highlightedFileId = "", writable = false, historical = false, participant = null } = {}) {
    const identity = getIdentity?.() || {};
    const viewerId = String(identity.id || identity._id || "");
    const draftKey = `${viewerId}:${String(matterId || "")}`;
    const savedDraft = drafts.get(draftKey) || { text: "", attachments: [] };
    const content = node("div", { className: "v2-matter-message-content", "data-v2-message-content": "" });
    const status = node("p", { className: "v2-matter-message-status", "data-v2-message-status": "", role: "status", "aria-live": "polite" });
    const inputId = `v2-matter-message-input-${String(matterId || "matter")}`;
    const attachmentId = `v2-matter-message-attachment-${String(matterId || "matter")}`;
    const section = node("section", { className: "v2-matter-panel v2-matter-messages", "data-workspace-messages":"", "aria-labelledby": "v2-matter-messages-title", "data-v2-message-panel": "" }, [
      node("div", { className: "v2-matter-panel-heading" }, [
        node("div", {}, [node("h2", { id: "v2-matter-messages-title", text: "Messages" })]),
        writable ? null : node("span", { className: "v2-matter-panel-note", text: "Read-only record" }),
      ]),
      content,
      node("button",{type:"button",className:"av2-new-messages",text:"New messages ↓","data-new-messages":"",hidden:""}),
      writable ? node("form", { className: "av2-message-composer v2-matter-message-form", "data-v2-message-form": "", "aria-label": "Send a matter message" }, [
        node("label", { className: "v2-visually-hidden", for: inputId, text: "Write a message" }),
        node("ul", { className: "v2-matter-message-attachments av2-composer-attachments", "data-v2-message-attachments": "", hidden: "" }),
        node("div", {className:"av2-composer-row"},[
          node("button", {type:'button',className:"av2-composer-attach",'aria-label':'Attach document',title:'Attach document',"data-v2-message-attachment-picker":""}),
          node("textarea", { id: inputId, "data-v2-message-input": "", maxlength: "2000", rows: "1", placeholder: "Write a message…", text: savedDraft.text }),
          node("button", { type: "submit",className:'av2-button','aria-label':'Send message', text: "Send" }),
        ]),
        node("input", { hidden:"", id: attachmentId, type: "file", accept: ACCEPTED_FILE_TYPES, multiple: "", "data-v2-message-attachment-input": "" }),
      ]) : null,
      status,
    ]);

    const state = {
      panel: section,
      matterId: String(matterId || ""),
      highlightedMessageId: String(highlightedMessageId || ""),
      highlightedFileId: String(highlightedFileId || ""),
      viewerId,
      participant,
      edit: savedDraft.edit || null,
      mutating:false,
      draftKey,
      drafts,
      writable: Boolean(writable),
      historical: Boolean(historical),
      canReadFiles: filesResult !== null && filesResult !== undefined && !filesResult?.unavailable,
      result: messagesResult,
      filesResult,
      attachments: Array.isArray(savedDraft.attachments) ? savedDraft.attachments : [],
      pendingMessage: savedDraft.pendingMessage || null,
      pendingDelivery: null,
      sending: false,
      downloadingId: "",
    };
    const picker=section.querySelector('[data-v2-message-attachment-picker]');
    if(picker){
      const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');
      const path=document.createElementNS(icon.namespaceURI,'path');path.setAttribute('d','m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l10.6-10.6a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l9.2-9.19');icon.append(path);picker.append(icon);
      picker.addEventListener('click',()=>{if(!state.sending&&!state.edit)section.querySelector('[data-v2-message-attachment-input]').click();});
    }
    state.flushMenuRefresh=()=>{
      if(state!==current || !state.writable || !state.renderAfterMenu || section.querySelector('.av2-context-menu[open]'))return;
      renderConversation(state);
      if(!state.unseen)void markRead(state,normalizedMessages(state.result));
    };
    state.beginEdit=message=>{state.edit={id:messageId(message),text:messageText(message),original:messageText(message)};renderConversation(state);setSending(state,false);saveDraft(state);section.querySelector('.av2-inline-edit-field')?.focus();};
    state.cancelEdit=()=>{if(state.mutating)return;state.edit=null;renderConversation(state);setSending(state,false);saveDraft(state);section.querySelector('[data-v2-message-input]')?.focus();};
    state.mutate=(message,action,body)=>mutate(state,message,action,body);
    state.confirmDelete=message=>confirmDelete(state,message);
    section.querySelector('[data-new-messages]').addEventListener('click',()=>{
      content.scrollTop=content.scrollHeight;state.unseen=false;section.querySelector('[data-new-messages]').hidden=true;void markRead(state,normalizedMessages(state.result));
    });
    content.addEventListener('scroll',()=>{if(state.unseen && content.scrollHeight-content.clientHeight-content.scrollTop<48){state.unseen=false;section.querySelector('[data-new-messages]').hidden=true;void markRead(state,normalizedMessages(state.result));}},{passive:true});
    panelStates.set(section, state);
    renderConversation(state);
    renderAttachments(state);
    const input = section.querySelector("[data-v2-message-input]");
    input?.addEventListener("input", () => {
      if (state.pendingMessage?.text !== String(input.value || "").trim()) state.pendingMessage = null;
      input.style.height="auto";input.style.height=`${Math.min(116,Math.max(28,input.scrollHeight))}px`;
      setSending(state,state.sending);saveDraft(state);
    });
    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || event.isComposing || event.repeat) return;
      event.preventDefault();
      void send(state);
    });
    section.querySelector("[data-v2-message-attachment-input]")?.addEventListener("change", (event) => {
      addAttachments(state, event.target.files);
      event.target.value = "";
    });
    section.querySelector("[data-v2-message-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void send(state);
    });
    section.addEventListener("dragover", (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
      event.preventDefault();
      section.classList.add("is-dragover");
    });
    section.addEventListener("dragleave", (event) => {
      if (!section.contains(event.relatedTarget)) section.classList.remove("is-dragover");
    });
    section.addEventListener("drop", (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
      event.preventDefault();
      section.classList.remove("is-dragover");
      addAttachments(state, event.dataTransfer.files);
    });
    section.addEventListener("click", (event) => {
      const attachmentButton = event.target.closest("[data-v2-message-attachment-action]");
      if (attachmentButton) {
        const entry = state.attachments.find((item) => item.id === attachmentButton.dataset.v2MessageAttachmentAction);
        if (!entry) return;
        if (entry.status === "uploading") entry.controller?.abort();
        else if (entry.status === "failed") {
          entry.status = "pending";
          entry.error = "";
        } else state.attachments = state.attachments.filter((item) => item !== entry);
        renderAttachments(state);
        return;
      }
      const downloadButton = event.target.closest("[data-v2-message-file-download]");
      if (downloadButton) void download(state, downloadButton.dataset.v2MessageFileDownload);
    });
    return section;
  }

  function afterMount(root) {
    const section = root?.querySelector?.("[data-v2-message-panel]");
    const state = section ? panelStates.get(section) : null;
    if (!state) return;
    current = state;
    generation += 1;
    setSending(state,false);
    const content=state.panel.querySelector("[data-v2-message-content]");
    if(content)requestAnimationFrame(()=>{
      if(state!==current)return;
      positionCurrentMessage();
      if(!state.positioned)content.scrollTop=content.scrollHeight;
    });
    if (!state.result?.unavailable) void markRead(state, normalizedMessages(state.result));
    if (!state.writable) return;
    if (typeof BroadcastChannel === "function") {
      try {
        channel = new BroadcastChannel(`lpc-v2-matter-messages:${state.matterId}`);
        channel.addEventListener("message", scheduleRefresh);
      } catch {
        channel = null;
      }
    }
    // Reconcile periodically even while SSE is healthy so a write performed by
    // a separate process cannot leave the open conversation stale forever.
    startPolling();
    startStream(state);
  }

  function positionCurrentMessage() {
    const state = current;
    if (!state || state.positioned || !state.panel.isConnected) return;
    const messages = normalizedMessages(state.result);
    const idOf = (value) => String(value?._id || value?.id || value || "");
    const unread = messages.find((message) => senderId(message) !== state.viewerId
      && !(message.readBy || []).some((value) => idOf(value) === state.viewerId)
      && !(message.readReceipts || []).some((receipt) => idOf(receipt.user) === state.viewerId));
    const destination = state.highlightedMessageId || messageId(unread || messages.at(-1));
    const messageItems = Array.from(state.panel.querySelectorAll("[data-message-id]"));
    const linkedFile = !state.highlightedMessageId && state.highlightedFileId
      ? Array.from(state.panel.querySelectorAll("[data-file-id]")).find((element) => element.dataset.fileId === state.highlightedFileId) : null;
    const item = linkedFile || messageItems.find((element) => element.dataset.messageId === destination)
      || messageItems.find((element) => element.dataset.messageId === messageId(unread || messages.at(-1)));
    state.positioned = true;
    if (item) {
      item.classList.add("is-highlighted");
      item.focus({ preventScroll: true });
      item.scrollIntoView({ block: "center", behavior: "instant" });
    }
  }
  window.addEventListener("lpc:v2-route-changed", positionCurrentMessage);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && current?.writable) scheduleRefresh();
  });
  window.addEventListener("online", () => {
    if (!current) return;
    scheduleRefresh();
    if (!eventSource) startStream(current);
  });

  return Object.freeze({
    panel,
    afterMount,
    leave,
    refresh: () => current ? refresh(current, { announce: true }) : Promise.resolve(),
    hasDrafts: () => drafts.size > 0,
    clearDrafts: () => {
      drafts.clear();
      readWatermarks.clear();
    },
  });
}
