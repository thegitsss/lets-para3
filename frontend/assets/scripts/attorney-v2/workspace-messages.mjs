import { actionMenu } from "./presentation.mjs";
import { node, button, link, recoveryButton, setRecovery } from "./dom.mjs";
import { matterLink, objectId, timeLabel } from "./workspace-model.mjs";
import { readConversation, confirmedMessage, mergeMessages } from "./conversation-model.mjs";
import { createMessageAttachment } from "./workspace-message-attachment.mjs";
import { createConversationUpload } from "./conversation-upload.mjs";
import { conversationAvatar } from './conversation-avatar.mjs';

export function createWorkspaceMessages(caseId, { api, signal, ownerId, route, privateState, retained = false, presentation, conversationParticipant, onConversationChanged }) {
  const section = node("section", { "aria-label": "Matter messages", "data-workspace-messages": "" });
  const feedback = node("p", { role: "status" }), list = node("ol", { className: "av2-conversation", tabindex:"0", "aria-label":"Message history" });
  const state = (!retained && privateState.conversations.get(caseId)) || { text: "", pending: null, busy: false, edit: null };
  if (retained) privateState.conversations.delete(caseId); else privateState.conversations.set(caseId, state); state.busy = false;
  const options = { signal, ownerId };
  const read = options => retained ? api.readRetainedMessages(caseId, options) : api.readWorkspaceMessages(caseId, options);
  let messages = [], nextCursor = null, busy = false, writable = false, watermark = "", target = objectId(route.query.get("messageId")), mutation = false, readStatusFailed = false;
  const attachmentViews = new Map(), messageViews = new Map();
  function clearAttachments() { for (const view of attachmentViews.values()) view.element.dispose(); attachmentViews.clear(); messageViews.clear(); }
  const refresh = recoveryButton("Retry messages", () => void load()), earlier = button("Show earlier messages", () => void load({ earlier: true }));
  const latest = button("Show latest messages", () => { target = null; void load(); }); latest.hidden = !target;
  const editor = node("div", { className: "av2-message-editor" });
  const newMessages = button('New messages ↓', () => { list.scrollTop = list.scrollHeight; newMessages.hidden = true; void acknowledge().then(changed=>{if(changed)onConversationChanged?.();}); }, 'av2-new-messages'); newMessages.hidden = true;
  list.addEventListener('scroll',()=>{if(list.scrollHeight-list.scrollTop-list.clientHeight<40 && !newMessages.hidden){newMessages.hidden=true;void acknowledge().then(changed=>{if(changed)onConversationChanged?.();});}},{passive:true});
  const input = node("textarea", { id: `av2-message-${caseId}`, rows: "2", maxlength: "2000", "aria-describedby": `av2-message-hint-${caseId}` }); input.value = state.text;
  const send = button("Send message", () => void submitComposer(), "av2-button");
  const retry = button("Retry same message", () => void sendMessage()); retry.hidden = true;
  const pending = node("p", { role: "status", className: "av2-preserve-lines" });
  const composer = node("div", { className: "av2-message-composer" }, [node("label", { for: input.id, text: "Message to the paralegal" }), input, node("p", { id: `av2-message-hint-${caseId}`, className: "av2-muted", text: "Up to 2,000 characters. Unsent text stays in this tab until you sign out or close it." }), node("div", { className: "av2-actions" }, [send, retry, link("Attach documents", matterLink(caseId, "files"))]), pending]);
  let upload = null, confirmingDelete = false, attachmentSending = false;
  const composerRow = node("div", {className:"av2-composer-row"});
  const deleteDialog = node("dialog", {className:"av2-message-delete-dialog", "aria-labelledby":`av2-delete-title-${caseId}`});
  const attachments = node("div", {className:"av2-composer-attachments", id:`av2-message-attachments-${caseId}`}); attachments.hidden = true;
  const attach = button("Attach document", () => {
    if (!writable || retained || state.edit || confirmingDelete) return;
    if (upload && attachments.hidden && !upload.canSubmit()) void upload.prepareNext?.();
    attachments.hidden = !attachments.hidden; attach.setAttribute("aria-expanded", String(!attachments.hidden));
    if (!attachments.hidden && !upload) {
      const files = privateState.fileReviews.get(caseId) || {drafts:{},pending:null}; privateState.fileReviews.set(caseId, files); files.upload ||= {};
      upload = createConversationUpload(caseId, {api, signal, ownerId, state:files.upload, onChange:controls, onSent:async ({removed}={}) => {await load(); onConversationChanged?.();if(!removed){attachments.hidden=true;attach.setAttribute("aria-expanded","false");}}, onAccessLost:() => {clearForAccess();section.dataset.state='error';feedback.textContent='Attachment access changed. Reload the conversation to continue.';}});
      const close = button("Close attachment panel", () => { attachments.hidden = true; attach.setAttribute("aria-expanded", "false"); attach.focus(); }, "av2-attachment-close");
      close.textContent = "Close"; close.setAttribute("aria-label","Close attachment panel"); attachments.append(close, upload);
    }
  }, "av2-composer-attach");
  attach.setAttribute("aria-expanded","false"); attach.setAttribute("aria-controls",attachments.id);
  function resizeInput() { if (presentation !== 'conversation' || signal.aborted) return; input.style.height='auto'; input.style.height=`${Math.min(116,Math.max(28,input.scrollHeight))}px`; }
  input.addEventListener("input", () => {
    state.text = input.value;
    resizeInput(); controls();
  });
  if (presentation === "conversation") {
    input.rows = 1;
    const clip = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    clip.setAttribute("viewBox", "0 0 24 24"); clip.setAttribute("aria-hidden", "true"); clip.setAttribute("focusable", "false");
    const path = document.createElementNS(clip.namespaceURI, "path");
    path.setAttribute("d", "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l10.6-10.6a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l9.2-9.19");
    clip.append(path); attach.replaceChildren(clip);
    attach.setAttribute("aria-label", "Attach document"); attach.dataset.av2Tooltip = "Attach document";
    input.placeholder = "Write a message…";
    composer.querySelector(".av2-actions").replaceChildren(retry);
    composerRow.append(attach, input, send);
    composer.prepend(attachments, composerRow);
    send.textContent = "Send"; send.setAttribute("aria-label","Send message");
    input.addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !send.disabled) { event.preventDefault(); void submitComposer(); } else if (event.key === "Escape" && state.edit && !state.busy) { event.preventDefault(); closeEditor(); input.focus(); } });
  }
  section.append(node("h2", { text: "Messages" }), feedback, node("div", { className: "av2-actions" }, [refresh, earlier, latest]), list, newMessages, editor, composer);
  if (presentation === "conversation" && !retained) { composer.append(feedback); section.append(deleteDialog); }
  deleteDialog.addEventListener("cancel", event => { if (mutation) event.preventDefault(); else closeEditor(); });
  signal.addEventListener("abort", () => deleteDialog.close(), {once:true});
  composer.addEventListener("keydown", event => {
    if (event.key === "Escape" && confirmingDelete && !state.busy) { event.preventDefault(); closeEditor(); input.focus(); }
  });
  if (retained) { composer.remove(); editor.remove(); section.insertBefore(node("p", { text: "Retained correspondence. This conversation is closed to new messages and changes." }), feedback); }
  function controls() {
    input.disabled = !writable || state.busy || attachmentSending || Boolean(state.pending) || Boolean(presentation === "conversation" && state.edit);
    attach.disabled = !writable || state.busy || mutation || attachmentSending || Boolean(state.edit);
    const editing = presentation === "conversation" && state.edit;
    send.disabled = !writable || state.busy || mutation || attachmentSending || Boolean(editing) || Boolean(upload?.hasSelection() && !upload.canSubmit() && !upload.delivered()) || !(state.text.trim() || upload?.canSubmit?.()) || Boolean(state.pending);
    if (presentation === "conversation") {
      send.textContent = state.busy || attachmentSending ? "Sending…" : "Send";
      send.setAttribute("aria-label", "Send message");
      attach.hidden = false; composer.classList.toggle("av2-composer-editing", Boolean(editing));
      for (const control of editor.querySelectorAll("button,textarea")) control.disabled = !writable || state.busy || mutation;
      const save = editor.querySelector("[data-save-edit]"); if (save) save.disabled ||= !state.edit?.text.trim();
      for (const control of deleteDialog.querySelectorAll("button")) control.disabled = !writable || state.busy || mutation;
    }
    retry.hidden = !state.pending || state.busy; retry.disabled = !writable || mutation;
    earlier.hidden = !nextCursor; earlier.disabled = busy;
    refresh.disabled = busy || mutation; latest.disabled = busy || mutation;
    pending.textContent = state.pending ? `${state.busy ? "Sending…" : "Delivery not confirmed. Refresh messages to check, or retry this same message."}\n${state.pending.text}` : "";
    for (const control of list.querySelectorAll(".av2-message-actions button,.av2-message-reactions button")) control.disabled = !writable || mutation || state.busy || attachmentSending || Boolean(presentation === "conversation" && (state.edit || confirmingDelete));

    setRecovery(refresh, section);
  }
  function clearForAccess() {
    clearAttachments();
    messages = []; nextCursor = null; writable = false; list.replaceChildren(); editor.replaceChildren();
    state.text = ""; state.pending = null; state.edit = null; confirmingDelete = false; input.value = ""; privateState.conversations.delete(caseId); closeEditor(); controls();
    upload?.clear(); attachments.hidden = true; attach.setAttribute("aria-expanded","false");
  }
  function reactionControl(message, emoji, users = []) {
    const own = users.includes(ownerId), label = `${own ? "Remove" : "Add"} ${emoji} reaction`;
    const control = button(`${emoji}${users.length ? ` ${users.length}` : ""}`, () => void change(message, own ? "unreact" : "react", { emoji }));
    control.setAttribute("aria-label", label); control.setAttribute("aria-pressed", String(own)); return control;
  }
  function render() {
    const focusedElement = document.activeElement;
    const focused = focusedElement?.closest?.("[data-message-id]")?.dataset.messageId;
    const visible = new Set(messages.map(message => message.id));
    for (const [id, view] of attachmentViews) {
      const current = messages.find(message => message.id === view.messageId);
      if (!current || !current.attachments.some(item => item.id === view.attachmentId) || current.revision !== view.revision) { view.element.dispose(); attachmentViews.delete(id); }
    }
    for (const id of messageViews.keys()) if (!visible.has(id)) messageViews.delete(id);
    const lastOwnId = messages.filter(item => item.senderId === ownerId).at(-1)?.id;
    const rows = messages.map((message, index) => {
      const before = messages[index - 1];
      const grouped = before?.senderId === message.senderId && Date.parse(message.createdAt) - Date.parse(before.createdAt) >= 0 && Date.parse(message.createdAt) - Date.parse(before.createdAt) < 300000 && (presentation !== "conversation" || new Date(before.createdAt).toDateString() === new Date(message.createdAt).toDateString());
      const serialized = JSON.stringify([message, lastOwnId, grouped]), previous = messageViews.get(message.id);
      if (previous?.serialized === serialized) return previous.item;
      const own = message.senderId === ownerId;
      const item = node("li", { "data-message-id": message.id, className: grouped ? "av2-message-continuation" : "", tabindex: "-1" }, [node("div", { className: "av2-message-heading" }, [node("strong", { text: own ? "You" : message.sender }), node(message.createdAt ? "time" : "span", { ...(message.createdAt ? { datetime: message.createdAt } : {}), text: timeLabel(message.createdAt) })])]);
      if (presentation === "conversation") {
        item.dataset.messageOwn = String(own);
        const stamp = item.querySelector("time");
        if (stamp) { stamp.title = timeLabel(message.createdAt); stamp.setAttribute("aria-label",stamp.title); stamp.textContent = new Date(message.createdAt).toLocaleTimeString(undefined, {hour:"numeric",minute:"2-digit"}); }
        if (!own && !grouped) item.prepend(conversationAvatar({name:message.sender,...(conversationParticipant?.id===message.senderId?conversationParticipant:{})},'av2-message-avatar'));
      }
      if (message.pinned) item.append(node("p", { className: "av2-muted", text: "Pinned message" }));
      if (message.replyTo) item.append(link("View earlier message", matterLink(caseId, "messages", new URLSearchParams({ messageId: message.replyTo }))));
      if (message.text && !(presentation === 'conversation' && message.type === 'file' && message.attachments.length)) item.append(node("p", { className: "av2-preserve-lines", text: message.text }));
      if (message.type === "audio") item.append(node("p", { className: "av2-preserve-lines", text: message.transcript || "No transcript is recorded for this audio message." }));
      for (const attachment of message.attachments) {
        if (attachment.filename && presentation !== 'conversation') item.append(node("p", { text: attachment.filename }));
        const key = `${message.id}:${attachment.id}`;
        let view = attachmentViews.get(key);
        if (view && view.revision !== message.revision) { view.element.dispose(); attachmentViews.delete(key); view = null; }
        if (!view) {
          view = { messageId: message.id, attachmentId: attachment.id, revision: message.revision, element: createMessageAttachment(caseId, { ...message, ...attachment, id: message.id }, { api, signal, ownerId, retained, presentation, attachmentId: attachment.id === "primary" ? undefined : attachment.id, multipleAttachments: message.attachments.length > 1, onAccessLost: () => { clearForAccess(); section.dataset.state = "error"; feedback.textContent = "Message access changed. Refresh the Matter before continuing."; } }) };
          attachmentViews.set(key, view);
        }
        item.append(view.element);
      }
      if (own && message.id === lastOwnId && message.readBy.some(id => id !== ownerId)) item.append(node("p", { className: "av2-muted", text: "Read" }));
      const actions = node("div", { className: "av2-message-actions" });
      const reactions = node('div',{className:'av2-message-reactions'});
      if (retained) {
        for (const reaction of message.reactions) actions.append(node("span", { text: `${reaction.emoji} ${reaction.users.length}` }));
        item.append(actions); messageViews.set(message.id, { serialized, item }); return item;
      }
      for (const reaction of message.reactions) (presentation==='conversation'?reactions:actions).append(reactionControl(message, reaction.emoji, reaction.users));
      if (reactions.childElementCount) item.append(reactions);
      if (!message.reactions.some(reaction => reaction.emoji === "👍")) actions.append(reactionControl(message, "👍"));
      if (own) {
        if (message.type === "text") actions.append(button("Edit", () => openEditor(message)));
        actions.append(button(message.pinned ? "Unpin" : "Pin", () => void change(message, "pin", message.pinned ? { unpin: true } : { pin: true })), button("Delete", () => confirmDelete(message)));
      }
      const menu = actionMenu("Message actions", [actions], signal);
      if (presentation === "conversation") menu.addEventListener("toggle", () => {
        menu.classList.remove("av2-message-menu-up");
        if (!menu.open) return;
        const options = menu.querySelector(".av2-context-options");
        const bounds = list.getBoundingClientRect();
        options.style.maxHeight = `${Math.max(80, bounds.height - 32)}px`;
        if (options.getBoundingClientRect().bottom > bounds.bottom - 8) menu.classList.add("av2-message-menu-up");
      });
      item.append(menu); messageViews.set(message.id, { serialized, item }); return item;
    });
    // Preserve unchanged message nodes so background reads do not restart audio.
    const timeline = [];
    let previousDay = "";
    rows.forEach((row, index) => {
      const value = messages[index].createdAt;
      const day = value ? new Date(value).toDateString() : "Date unavailable";
      if (presentation === "conversation" && day !== previousDay) {
        const label = value ? new Date(value).toLocaleDateString(undefined, {month:"short",day:"numeric",...(new Date(value).getFullYear() !== new Date().getFullYear() ? {year:"numeric"} : {})}) : day;
        timeline.push(node("li", {className:"av2-message-date", text:label}));
      }
      previousDay = day; timeline.push(row);
    });
    let cursor = list.firstElementChild;
    for (const row of timeline) { if (row === cursor) cursor = cursor.nextElementSibling; else list.insertBefore(row, cursor); }
    while (cursor) { const next = cursor.nextElementSibling; cursor.remove(); cursor = next; }
    if (focused && document.activeElement !== focusedElement) {
      const restore = focusedElement.isConnected ? focusedElement : list.querySelector(`[data-message-id="${focused}"]`);
      restore?.focus({ preventScroll: true });
    }
    controls();
  }
  function closeEditor() {
    const prior = editor.closest("[data-message-id]");
    if (prior) {
      prior.classList.remove("av2-editing-message");
      prior.querySelector(":scope > p.av2-preserve-lines")?.removeAttribute("hidden");
      prior.querySelector(".av2-context-menu")?.removeAttribute("hidden");
    }
    state.edit = null; confirmingDelete = false; editor.replaceChildren(); deleteDialog.close();
    if (presentation === "conversation") {
      section.insertBefore(editor, composer); composer.append(feedback); delete composer.dataset.mode;
      input.value = state.text; resizeInput(); controls();
    }
  }
  async function submitComposer() {
    if (confirmingDelete || state.edit || state.busy || attachmentSending || !writable) return;
    if (upload?.canSubmit?.()) {
      attachmentSending = true; controls();
      try { if (!await upload.submit()) return; }
      finally { attachmentSending = false; controls(); }
      if (signal.aborted || !writable) return;
    }
    if (state.text.trim()) await sendMessage();
  }
  function openEditor(message, restoredText) {
    const original = messages.find(entry => entry.id === message.id); if (!original) return;
    if (presentation === "conversation" && (state.pending || state.busy || !writable)) return;
    state.edit = { id: message.id, text: restoredText ?? message.text, revision: message.revision };
    if (presentation === "conversation") {
      const item = list.querySelector(`[data-message-id="${message.id}"]`); if (!item) return;
      const previous = editor.closest("[data-message-id]");
      if (previous && previous !== item) {
        previous.classList.remove("av2-editing-message");
        previous.querySelector(":scope > p.av2-preserve-lines")?.removeAttribute("hidden");
        previous.querySelector(".av2-context-menu")?.removeAttribute("hidden");
      }
      confirmingDelete = false; deleteDialog.close();
      composer.dataset.mode = "edit"; item.classList.add("av2-editing-message");
      item.querySelector(":scope > p.av2-preserve-lines")?.setAttribute("hidden", "");
      item.querySelector(".av2-context-menu")?.setAttribute("hidden", "");
      const field = node("textarea", {className:"av2-inline-edit-field", rows:"2", maxlength:"2000", "aria-label":"Message text"}); field.value = state.edit.text;
      const cancel = button("Cancel", () => { closeEditor(); input.focus(); }, "av2-composer-cancel"); cancel.setAttribute("aria-label", "Cancel edit");
      const save = button("Save", () => {
        const current = messages.find(entry => entry.id === state.edit?.id);
        if (current && state.edit.text.trim()) void change({...current, revision:state.edit.revision}, "edit", {content:state.edit.text});
      }, "av2-inline-save"); save.setAttribute("aria-label", "Save message"); save.dataset.saveEdit = "";
      const resize = () => {field.style.height="auto";field.style.height=`${Math.min(160, Math.max(58, field.scrollHeight))}px`;};
      field.addEventListener("input", () => {state.edit.text=field.value;resize();controls();});
      field.addEventListener("keydown", event => {
        if (event.key === "Escape" && !mutation) {event.preventDefault();closeEditor();input.focus();}
        else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {event.preventDefault();if(!save.disabled)save.click();}
      });
      editor.replaceChildren(field, node("div", {className:"av2-inline-edit-actions"}, [cancel,save]));
      editor.append(feedback); item.append(editor); feedback.textContent=""; controls(); resize();
      item.scrollIntoView({block:"nearest"}); field.focus({preventScroll:true}); return;
    }
    const field = node("textarea", { id: `av2-edit-message-${message.id}`, rows: "4", maxlength: "2000" }); field.value = state.edit.text;
    field.addEventListener("input", () => { state.edit.text = field.value; });
    editor.replaceChildren(node("h3", { text: "Edit message" }), node("label", { for: field.id, text: "Message text" }), field, node("div", { className: "av2-actions" }, [button("Save message", () => {
      if (!field.value.trim()) { feedback.textContent = "Enter a message before saving."; field.focus(); return; }
      void change({ ...message, revision: state.edit.revision }, "edit", { content: field.value });
    }, "av2-button"), button("Cancel edit", closeEditor)]));
    field.focus();
  }
  function confirmDelete(message) {
    closeEditor();
    if (presentation === "conversation") {
      confirmingDelete = true;
      const keep = button("Cancel", () => {closeEditor();input.focus();}, "av2-composer-cancel"); keep.setAttribute("aria-label", "Keep message");
      const remove = button("Delete", () => void change(message, "delete", {}), "av2-message-delete"); remove.setAttribute("aria-label", "Delete message");
      deleteDialog.replaceChildren(node("h2", {id:`av2-delete-title-${caseId}`,text:"Delete this message?"}), node("p", {className:"av2-delete-preview",text:message.text || message.filename || "This message"}), node("p", {className:"av2-delete-note",text:"It will be removed from the conversation. LPC retains the record."}),node("div", {className:"av2-delete-actions"}, [keep,remove]));
      feedback.textContent="";controls();deleteDialog.showModal();keep.focus();return;
    }
    editor.replaceChildren(node("h3", { text: "Delete this message?" }), node("p", { className: "av2-preserve-lines", text: message.text || message.filename || "This message" }), node("p", { text: "It will be removed from the conversation. LPC retains the record." }), node("div", { className: "av2-actions" }, [button("Delete message", () => void change(message, "delete", {}), "av2-button"), button("Keep message", closeEditor)]));
    editor.querySelector("button")?.focus();
  }
  async function change(message, action, changes) {
    if (mutation || state.busy || !writable || signal.aborted) return;
    mutation = true; state.busy = true; controls(); for (const control of editor.querySelectorAll("button, textarea")) control.disabled = true;
    try {
      const response = await api.updateWorkspaceMessage(caseId, message.id, action, changes, message.revision, options);
      if (signal.aborted) return;
      if (response?.ok !== true) throw new Error("unconfirmed_change");
      closeEditor(); await load({quiet:presentation === "conversation"}); feedback.textContent = action === "delete" ? "Message deleted." : action === "edit" ? "Message saved." : action === "pin" ? (changes.pin ? "Message pinned." : "Message unpinned.") : "Reaction updated.";
      if (presentation === "conversation" && ["edit", "delete"].includes(action) && writable && !signal.aborted) input.focus({preventScroll:true});
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status)) clearForAccess();
      section.dataset.state = "error";
      feedback.textContent = error.status === 409 ? "This message changed. Refresh messages before editing it again. Your text remains below." : "The message change could not be confirmed. Refresh messages to check before making another change.";
    } finally {
      if (!signal.aborted) { mutation = false; state.busy = false; controls(); for (const control of editor.querySelectorAll("button, textarea")) control.disabled = !writable; }
    }
  }
  async function acknowledge() {
    if (retained || !writable || !messages.length || document.hidden || signal.aborted) return;
    if(presentation==='conversation' && !newMessages.hidden)return;
    const upTo = messages.at(-1).createdAt;
    // A verified server receipt is already authoritative. Reopening an already
    // read thread must not issue another write or refresh the entire inbox.
    if (messages.every(message => message.readBy.includes(ownerId))) {
      watermark = upTo;
      if (readStatusFailed) { readStatusFailed = false; feedback.textContent = ""; }
      return false;
    }
    if (watermark && Date.parse(watermark) >= Date.parse(upTo)) return;
    try { await api.markWorkspaceMessagesRead(caseId, upTo, options); if (!signal.aborted) { watermark = upTo; if (readStatusFailed) feedback.textContent = ""; readStatusFailed = false; return true; } }
    catch (error) { if (!signal.aborted) { if ([401, 403, 404].includes(error.status)) clearForAccess(); readStatusFailed = true; section.dataset.state = "error"; feedback.textContent = "Messages loaded, but their read status could not be saved. Refresh messages to try again."; } }
  }
  async function recover() {
    if (retained || !state.pending || signal.aborted) return false;
    const result = readConversation(await api.readWorkspaceMessages(caseId, { ...options, clientMessageId: state.pending.id }), caseId);
    const found = result.messages.find(message => message.clientMessageId === state.pending.id && message.senderId === ownerId);
    if (!signal.aborted && found) { state.pending = null; state.text = ""; input.value = ""; return true; }
    return false;
  }
  async function load({ earlier: older = false, quiet = false } = {}) {
    if (signal.aborted || busy) return;
    const previousTop=list.scrollTop, previousHeight=list.scrollHeight, atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<48;
    const anchor=[...list.querySelectorAll('[data-message-id]')].find(e=>e.getBoundingClientRect().bottom>=list.getBoundingClientRect().top), anchorId=anchor?.dataset.messageId, anchorTop=anchor?.getBoundingClientRect().top;
    busy = true; const previousMessages = messages; if (!quiet && !older && !messages.length) { clearAttachments(); messages = []; list.replaceChildren(); section.dataset.state = "loading"; feedback.textContent = "Loading messages…"; }
    controls();
    try {
      let page = readConversation(await read({ ...options, ...(older ? { cursor: nextCursor } : target ? { messageId: target } : {}) }), caseId);
      if (retained && page.retained !== true) throw new Error("invalid_retained_conversation");
      if (signal.aborted) return;
      if (quiet && previousMessages.length > 50 && !target) {
        const oldest = previousMessages[0], instant = entry => entry.createdAt === null ? -Infinity : Date.parse(entry.createdAt), earliest = entry => instant(entry) < instant(oldest) || entry.createdAt === oldest.createdAt && entry.id <= oldest.id;
        const cursors = new Set();
        while (page.nextCursor && page.messages.length && !earliest(page.messages[0])) {
          if (cursors.has(page.nextCursor)) throw new Error("repeated_message_page");
          cursors.add(page.nextCursor);
          const prior = readConversation(await read({ ...options, cursor: page.nextCursor }), caseId);
          if (retained && prior.retained !== true) throw new Error("invalid_retained_conversation");
          if (signal.aborted) return;
          page = { ...page, messages: mergeMessages(prior.messages, page.messages), nextCursor: prior.nextCursor };
        }
      }
      messages = older ? mergeMessages(previousMessages, page.messages) : page.messages; nextCursor = page.nextCursor; writable = !retained && page.writable;
      // An acknowledgement is matched by its private request ID, never by text or time.
      const recovered = await recover(); if (signal.aborted) return;
      render(); section.dataset.state = "ready";
      if (presentation === 'conversation') {
        const added=messages.some(message=>!previousMessages.some(prior=>prior.id===message.id));
        const preserved=anchorId && list.querySelector(`[data-message-id="${anchorId}"]`);
        if (older || quiet && !atBottom) {
          list.scrollTop = preserved ? previousTop + preserved.getBoundingClientRect().top-anchorTop : older ? previousTop+list.scrollHeight-previousHeight : previousTop;
          if(quiet && added)newMessages.hidden=false;
        } else if (!target) {list.scrollTop=list.scrollHeight;newMessages.hidden=true;}
        requestAnimationFrame(resizeInput);
      } else if (!quiet && !older && !target) list.scrollTop = list.scrollHeight;
      if (!quiet) feedback.textContent = recovered ? "Message sent." : page.targetMissing ? "The linked message is no longer available in this conversation." : messages.length ? "" : "No messages have been recorded for this Matter.";
      if (target && !older && !quiet && messages.some(message => message.id === target)) requestAnimationFrame(() => { if (!signal.aborted) { const item = list.querySelector(`[data-message-id="${target}"]`); item?.scrollIntoView({ block: "center" }); item?.focus({ preventScroll: true }); } });
      if (state.edit) {
        const selected = messages.find(message => message.id === state.edit.id);
        if (selected && (!editor.childElementCount || presentation === "conversation" && !list.contains(editor))) openEditor({ ...selected, revision: state.edit.revision }, state.edit.text);
        if (selected && selected.revision !== state.edit.revision && !editor.querySelector("[data-message-conflict]")) {
          editor.append(node("div", { "data-message-conflict": "" }, [node("p", { className: "av2-preserve-lines", text: `Current saved message: ${selected.text}` }), button("Review my edit against this message", () => openEditor(selected, state.edit.text))]));
        }
      }
      const readChanged = await acknowledge();
      const latestChanged = previousMessages.length && JSON.stringify(previousMessages.at(-1)) !== JSON.stringify(messages.at(-1));
      if (!signal.aborted && (readChanged || latestChanged)) onConversationChanged?.();
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404, 410].includes(error.status)) { clearForAccess(); feedback.textContent = error.status === 410 ? "The retention period ended or these messages were purged. They are no longer available here." : "Messages are unavailable for this Matter. Refresh the Matter to check its current access."; }
      else { clearAttachments(); messages = []; list.replaceChildren(); writable = false; feedback.textContent = older ? "Earlier messages couldn’t load. Refresh messages to try again." : retained ? "Retained messages couldn’t load. Refresh messages to try again." : "Messages couldn’t load. Try again. Unsent text remains in this tab."; }
      section.dataset.state = "error";
    } finally { if (!signal.aborted) { busy = false; controls(); } }
  }
  async function sendMessage() {
    if (state.busy || mutation || !writable || signal.aborted || !state.pending && !state.text.trim()) return;
    if (!state.pending) state.pending = { id: crypto.randomUUID(), text: state.text };
    state.busy = true; controls(); feedback.textContent = "";
    try {
      const result = await api.sendWorkspaceMessage(caseId, state.pending.text, state.pending.id, options);
      if (signal.aborted) return;
      confirmedMessage(result, caseId, ownerId); state.pending = null; state.text = ""; input.value = ""; target = null; latest.hidden = true;
      await load(); feedback.textContent = result.message.deleted === true ? "This message was already sent and has since been deleted." : section.dataset.state === "error" ? "Message sent. The conversation couldn’t reload; refresh messages to try again." : "Message sent.";
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status)) { clearForAccess(); feedback.textContent = "Message access changed. Refresh the Matter before continuing."; }
      else if ([400, 413, 422].includes(error.status)) { state.pending = null; feedback.textContent = "Message not sent. Enter text of up to 2,000 characters before trying again."; }
      else {
        try {
          if (await recover()) { await load(); feedback.textContent = section.dataset.state === "error" ? "Message sent. The conversation couldn’t reload; refresh messages to try again." : "Message sent."; }
        } catch (readError) {
          if (signal.aborted) return;
          if ([401, 403, 404].includes(readError.status)) {
            clearForAccess(); feedback.textContent = "Message access changed. Refresh the Matter before continuing.";
          } else feedback.textContent = ""; // The pending-message status owns the single unconfirmed outcome.
        }
      }
    } finally { if (!signal.aborted) { state.busy = false; controls(); } }
  }
  section.sync = () => mutation || state.busy || state.edit ? Promise.resolve() : load({ quiet: true });
  section.presenceActive = () => writable && !document.hidden && !signal.aborted;
  signal.addEventListener("abort", () => { clearAttachments(); state.busy = false; messages = []; section.replaceChildren(); }, { once: true });
  controls(); section.readiness = load(); return section;
}
