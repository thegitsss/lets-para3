import { calmMode, simplifyInquiry } from './calm.js';
import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { api as request, escapeHTML, date, label, person, debounce, visible, routeParam } from './shared.js';
import { avatar, age, badge, icon, emptyState } from './presentation.js';
import { initCommunications, replyTemplates, bindReplyTemplates } from './communications.js';
import { createDraftStore } from './drafts.js';
import { confirmAction } from '../utils/dialogs.js';
const state = {
  source: 'all',
  status: 'active',
  q: '',
  assignment: '',
  followUp: '',
  operators: [],
  page: 1,
  pages: 1,
  selected: '',
  listRequest: 0,
  detailRequest: 0,
  busy: false
};
const el = id => document.getElementById(id);
// Keep the specific error beside the affected inquiry or list.
const api = (url, options = {}) => request(url, { ...options, suppressToast: true });
const requestKind = t => t.requestKind === 'email' ? 'Support email' : t.requestKind === 'human' ? 'Human request' : t.requestKind === 'contact' || !t.conversationId && t.sourceSurface === 'public' ? 'Contact form' : 'Support';
const draftStore=createDraftStore('inquiry', { suppressToast: true });
const inquirySummary = ticket => calmMode() ? escapeHTML(({open:'Needs your reply',in_review:'Needs your reply',waiting_on_user:'Waiting for a reply',resolved:'Resolved',closed:'Resolved'})[ticket.status] || label(ticket.status)) : `Owner: ${escapeHTML(ticket.assignedTo?.name || 'Unassigned')} · ${badge(ticket.status)}${ticket.followUpAt ? ` · Follow up ${escapeHTML(date(ticket.followUpAt))}` : ''}`;
const inquiryNotes = notes => (notes || []).map(note => `<article class="admin-message"><strong>${escapeHTML(note.adminName || 'Admin')}</strong><p>${escapeHTML(note.text)}</p><small>${escapeHTML(date(note.createdAt))}</small></article>`).join('');
function inquiryConversation(t) {
  const chat = !!t.conversationId, messages = chat ? t.conversationMessages || [] : [], emailReplies = t.emailReplies || [];
  const timeline=[...messages.map(m=>({text:m.text,createdAt:m.createdAt,team:m.metadata?.kind==='team_reply',title:m.metadata?.kind==='team_reply'?'LPC team':m.sender==='user'?'User':m.sender==='assistant'?'Assistant':'Update'})),...emailReplies.map(r=>({text:r.text,createdAt:r.createdAt,team:true,title:`LPC team · Email ${label(r.delivery)}`})),...(t.inboundEmails||[]).map(m=>({...m,title:`Email from ${m.sender}`}))].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  return `${!chat || !messages.length ? `<article class="admin-message"><strong>Original question</strong><p>${escapeHTML(t.message)}</p><small>${escapeHTML(date(t.createdAt))}</small></article>` : ''}${timeline.map(m=>`<article class="admin-message ${m.team?'admin-message-team':''}"><strong>${escapeHTML(m.title)}</strong><p>${escapeHTML(m.text)}</p><small>${escapeHTML(date(m.createdAt))}</small>${m.hasAttachments?'<p class="small">This email has attachments. <a href="https://mail.zoho.com/" target="_blank" rel="noopener">Open the support mailbox</a> to review them.</p>':''}${m.truncated?'<p class="small">This long email is shortened here. <a href="https://mail.zoho.com/" target="_blank" rel="noopener">Read the full message in the support mailbox.</a></p>':''}</article>`).join('')}`;
}
function error(message) {
  el('adminInboxListStatus').textContent = message;
}
async function backToList() {
  if (state.busy) return;
  try { await window.flushAdminInquiryDraft?.(); }
  catch (e) { el('adminReplyResult').textContent = e.message || 'Your draft could not be saved. Try again.'; return; }
  routeParam('ticket', '');
  el('section-support-ops').classList.remove('admin-inbox-selected');
  const row=[...el('adminInboxList').querySelectorAll('[data-inbox-ticket]')].find(b=>b.dataset.inboxTicket===state.selected);
  (row||el('adminInboxSearch')).focus();
}
const backButton=()=>`<button class="btn secondary admin-inbox-back" type="button" id="adminInboxBack" data-inbox-back>${icon('back')} Back to requests</button>`;
function updateFilters() {
  document.querySelectorAll('[data-inbox-source]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.inboxSource === state.source)));
}
async function loadList({
  choose = false
} = {}) {
  const request = ++state.listRequest;
  updateFilters();
  error('Loading inquiries…');
  el('adminInboxList').setAttribute('aria-busy', 'true');
  el('adminInboxPage').textContent = '';
  el('adminInboxPrev').disabled = true;
  el('adminInboxNext').disabled = true;
  try {
    const result = await api(`/api/admin/support/inbox?${new URLSearchParams({
      source: state.source,
      status: state.status,
      q: state.q,
      page: state.page,
      assignment: state.assignment,
      followUp: state.followUp,
      includeTests: String(el('adminInboxIncludeTests')?.checked || false)
    })}`);
    if (request !== state.listRequest) return;
    state.pages = Math.max(1, result.pages || 1);
    if (state.page > state.pages) {
      state.page = state.pages;
      return loadList({
        choose
      });
    }
    el('adminInboxList').innerHTML = result.tickets.length ? result.tickets.map(t => `<button type="button" class="admin-ticket-row ${state.selected === t.id ? 'selected' : ''}" data-inbox-ticket="${escapeHTML(t.id)}" aria-pressed="${state.selected===t.id}"><span class="admin-ticket-meta">${badge(t.status)}<span class="admin-row-meta" title="${escapeHTML(date(t.updatedAt))}">${age(t.updatedAt)}</span></span><strong>${escapeHTML(t.subject)}</strong><span class="admin-ticket-person">${avatar(t.requesterUserId ? person(t.requesterUserId) : t.contextSnapshot?.requesterName || t.requesterEmail,t.requesterRole)}${escapeHTML(t.requesterUserId ? person(t.requesterUserId) : t.contextSnapshot?.requesterName || t.requesterEmail)}</span><span class="admin-row-preview">${escapeHTML(t.latestUserMessage || t.message)}</span><span class="admin-row-meta">${escapeHTML(requestKind(t))} · ${escapeHTML(t.reference)}${t.followUpAt ? ` · Follow up ${escapeHTML(date(t.followUpAt))}` : ''}</span></button>`).join('') : emptyState(calmMode() ? 'No messages in this view' : 'No inquiries match these filters','','inbox');
    el('adminInboxPage').textContent = `Page ${state.page} of ${state.pages}`;
    el('adminInboxPage').closest('.admin-pager').hidden = state.pages <= 1;
    el('adminInboxPrev').disabled = state.page <= 1;
    el('adminInboxNext').disabled = state.page >= state.pages;
    error(result.total ? `${result.total} ${state.status === 'active' ? 'active ' : ''}inquir${result.total === 1 ? 'y' : 'ies'}` : '');
    if (choose && !state.selected && result.tickets.length) await select(result.tickets[0].id);
  } catch (e) {
    if (request !== state.listRequest) return;
    el('adminInboxList').innerHTML = `<p role="alert">${escapeHTML(e.message || 'Inquiries could not be loaded.')}</p>`;
    el('adminInboxPage').closest('.admin-pager').hidden = true;
    error('');
  } finally {
    if (request === state.listRequest) el('adminInboxList').setAttribute('aria-busy', 'false');
  }
}
async function select(id) {
  if (state.busy) return;
  state.selected = id;
  el('section-support-ops').classList.add('admin-inbox-selected');
  routeParam('ticket', id);
  const request = ++state.detailRequest;
  el('adminInboxDetail').innerHTML = backButton()+'<p role="status">Loading inquiry…</p>';
  try {
    const [data, owners, savedDraft] = await Promise.all([api(`/api/admin/support/tickets/${encodeURIComponent(id)}`), api('/api/admin/support/operators'), draftStore.load(id)]);
    state.operators = owners.operators;
    if (request !== state.detailRequest) return;
    renderDetail(data.ticket, savedDraft);
  } catch (e) {
    if (request !== state.detailRequest) return;
    el('adminInboxDetail').innerHTML = `${backButton()}<p role="alert">${escapeHTML(e.message)}</p><button class="btn secondary" id="inboxDetailRetry">Try again</button>`;
    replaceEventHandler(el('inboxDetailRetry'), 'click', () => select(id));
  }
  document.querySelectorAll('[data-inbox-ticket]').forEach(b => {b.classList.toggle('selected', b.dataset.inboxTicket === id);b.setAttribute('aria-pressed',String(b.dataset.inboxTicket===id));});
  if(calmMode() || matchMedia('(max-width:760px)').matches) { el('adminInboxDetail').scrollIntoView({block:'start'}); el('adminInboxBack')?.focus({preventScroll:true}); }
}
function renderDetail(t, d) {
  window.flushAdminInquiryDraft = () => draftStore.flush(d);
  const id = t.id || String(t._id),
    chat = !!t.conversationId;
  const canReply = chat || Boolean(t.requesterEmail?.trim());
  const request = state.detailRequest;
  const isCurrent = () => state.selected === id && state.detailRequest === request;
  const messages = chat ? t.conversationMessages || [] : [];
  const emailReplies = t.emailReplies || [];
  if (d.requestId) {
    const sent = emailReplies.find(r => r.requestId === d.requestId) || messages.find(m=>m.metadata?.adminReplyRequestId===d.requestId);
    if (sent && (sent.delivery === 'accepted' || sent.metadata?.kind === 'team_reply')) {
      d.text = '';
      d.requestId = '';
      d.uncertain = false;
      draftStore.change(d);
    } else if (sent && ['pending', 'unknown'].includes(sent.delivery)) d.uncertain = true;
  }
  el('adminInboxDetail').innerHTML = `${backButton()}<div class="panel-header"><div><p class="admin-row-meta">${escapeHTML(requestKind(t))} · ${escapeHTML(t.reference)}</p><h2>${escapeHTML(t.subject)}</h2></div></div>
 <div class="admin-inquiry-identity">${avatar(t.requester?.name || t.contextSnapshot?.requesterName || 'Visitor',t.requesterRole)}<span>${[t.requester?.name || t.contextSnapshot?.requesterName || 'Visitor', t.requester?.email || t.requesterEmail, t.requesterRole && t.requesterRole !== 'unknown' && label(t.requesterRole)].filter(Boolean).map(escapeHTML).join(' · ')}</span></div>
 <div class="admin-inline-actions">${t.requester?.id ? `<button class="btn secondary" type="button" data-inbox-user="${escapeHTML(t.requester.id)}">Open account</button>` : ''}${t.caseId ? `<button class="btn secondary" type="button" data-inbox-matter="${escapeHTML(t.caseId)}">Open matter</button>` : ''}<button class="btn secondary" id="inboxDetailRefresh" type="button">Refresh conversation</button></div>

 <p class="admin-row-meta" id="adminInquirySummary">${inquirySummary(t)}</p>
 <div class="admin-conversation" role="region" tabindex="0" aria-label="Inquiry conversation">${inquiryConversation(t)}</div>
 ${draftStore.markup(d)}<form id="adminReplyForm" class="${canReply ? '' : 'admin-reply-unavailable'}"><h3 id="adminReplyTitle">${!canReply ? 'Reply unavailable' : chat ? 'Reply in this conversation' : 'Reply by email'}</h3>${chat ? '' : `<p class="small">${canReply ? `To ${escapeHTML(t.requesterEmail)}. Replies are sent by email.` : 'No reply email is recorded. You can add an internal note or update the inquiry status.'}</p>`}
 ${!canReply && d.text ? `<details class="admin-detail-fold"><summary>Saved reply draft</summary><p>${escapeHTML(d.text)}</p></details>` : ''}
 <details class="admin-detail-fold" id="adminPreparedReply"><summary>Prepared reply</summary><p data-prepared-reason>Checking approved answers…</p><p data-prepared-source></p><p data-prepared-text style="white-space:pre-wrap"></p><button class="btn secondary" type="button" id="adminUsePreparedReply" hidden>Use prepared reply</button></details>
 ${replyTemplates()}<textarea id="adminReplyText" aria-labelledby="adminReplyTitle" rows="3" maxlength="12000" required ${d.uncertain ? 'readonly' : ''}>${escapeHTML(d.text)}</textarea>
 <div class="admin-inline-actions"><label for="adminReplyStatus">After reply<select id="adminReplyStatus" aria-label="Status after reply"><option value="waiting_on_user">Waiting</option><option value="in_review">In review</option><option value="resolved">Resolved</option></select></label><button class="btn primary" type="submit" id="adminReplySend" ${canReply ? '' : 'disabled'}>${d.uncertain ? 'Check or retry saved reply' : chat ? 'Send reply' : 'Send email'}</button></div><p id="adminReplyResult" role="status" class="small">${d.uncertain ? 'The result is unconfirmed. Check or retry this saved reply using the same request. A recorded send will not be repeated.' : ''}</p></form>
 <details class="admin-detail-fold"><summary>Follow-up &amp; assignment</summary> <form id="adminTriageForm" class="admin-triage"><div class="admin-inline-actions"><label>Owner<select id="adminInquiryOwner"><option value="">Unassigned</option>${state.operators.map(u => `<option value="${escapeHTML(u._id)}" ${String(t.assignedTo?.id || t.assignedTo?._id || t.assignedTo || '') === String(u._id) ? 'selected' : ''}>${escapeHTML(person(u))}</option>`).join('')}</select></label><label>Follow up by<input type="datetime-local" id="adminInquiryDue" value="${escapeHTML(t.followUpAt ? new Date(new Date(t.followUpAt) - new Date(t.followUpAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')}"></label></div><label for="adminInquiryNext">Next action</label><textarea id="adminInquiryNext" rows="2" maxlength="600">${escapeHTML(t.nextAction || '')}</textarea><button class="btn secondary" type="submit">Save follow-up</button><p id="adminTriageResult" role="status"></p></form></details>
 <details class="admin-detail-fold"><summary>Internal notes &amp; status</summary><div id="adminInquiryNotes">${inquiryNotes(t.internalNotes)}</div>
 <label for="adminInternalNote">Internal note</label><textarea id="adminInternalNote" rows="3">${escapeHTML(d.note)}</textarea><button class="btn secondary" id="adminSaveNote" type="button">Save note</button>
 <div class="admin-inline-actions"><select id="adminTicketStatus" aria-label="Inquiry status">${['open', 'in_review', 'waiting_on_user', 'resolved', 'closed'].map(s => `<option value="${escapeHTML(s)}" ${t.status === s ? 'selected' : ''}>${escapeHTML(label(s))}</option>`).join('')}</select><button class="btn secondary" id="adminSaveTicketStatus" type="button">Update status</button></div><p id="adminInternalResult" role="status"></p></details>
 ${t.routePath || t.sourceLabel || t.assistantSummary || t.linkedIncidents?.length ? `<details class="admin-detail-fold"><summary>Context &amp; technical details</summary>${t.routePath || t.sourceLabel ? `<p>Source: ${escapeHTML(t.routePath || t.sourceLabel)}</p>` : ''}${t.assistantSummary ? `<p>${escapeHTML(t.assistantSummary)}</p>` : ''}${(t.linkedIncidents || []).map(i => `<button type="button" class="btn secondary" data-inbox-incident="${escapeHTML(i.publicId || i.id)}">Open engineering issue ${escapeHTML(i.publicId || '')}</button>`).join('')}</details>` : ''}`;
  simplifyInquiry(t);
  draftStore.paint(d);
  if (canReply && !d.uncertain) {
    void (async () => {
      try {
        const prepared = await api(`/api/admin/workspace/inquiries/${encodeURIComponent(id)}/preparation`);
        if (!isCurrent()) return;
        const panel = el('adminPreparedReply');
        if (prepared.sourceRevision !== t.updatedAt) {
          panel.querySelector('[data-prepared-reason]').textContent = 'This inquiry changed. Refresh the conversation to prepare a reply.';
          return;
        }
        panel.querySelector('[data-prepared-reason]').textContent = prepared.reason;
        panel.querySelector('[data-prepared-source]').textContent = (prepared.sources || []).map(source => source.title).join(' · ');
        panel.querySelector('[data-prepared-text]').textContent = prepared.text;
        el('adminUsePreparedReply').hidden = !prepared.text;
        replaceEventHandler(el('adminUsePreparedReply'), 'click', async () => {
          if (!isCurrent() || state.busy || d.uncertain) return;
          if (d.text.trim() && !await confirmAction('Replace your current draft with the prepared reply?', { title: 'Keep or replace your draft', confirmLabel: 'Replace draft' })) return;
          if (!isCurrent() || state.busy || d.uncertain) return;
          d.text = prepared.text;
          el('adminReplyText').value = d.text;
          draftStore.change(d);
          el('adminReplyText').focus();
        });
      } catch (error) {
        if (isCurrent()) el('adminPreparedReply').querySelector('[data-prepared-reason]').textContent = error.message || 'A reply could not be prepared. Refresh to try again.';
      }
    })();
  } else el('adminPreparedReply').hidden = true;
  bindReplyTemplates(()=>d.text,value=>{if(d.uncertain||state.busy)return;d.text=value;el('adminReplyText').value=value;draftStore.change(d);});
  const transcript=el('adminInboxDetail').querySelector('.admin-conversation');
  transcript.scrollTop=transcript.scrollHeight;
  const triageValues = () => ({
    assignedTo: el('adminInquiryOwner').value || null,
    followUpAt: el('adminInquiryDue').value ? new Date(el('adminInquiryDue').value).toISOString() : null,
    nextAction: el('adminInquiryNext').value.trim()
  });
  replaceEventHandler(el('adminTriageForm'), 'input', () => { if (isCurrent()) el('adminTriageResult').textContent = 'Unsaved changes.'; });
  replaceEventHandler(el('adminTriageForm'), 'submit', async event => {
    event.preventDefault();
    if (state.busy || !isCurrent()) return;
    state.busy = true;
    window.dispatchEvent(new CustomEvent('admin:work-busy', { detail: { id, busy: true } }));
    const button = event.submitter;
    button.disabled = true;
    try {
      const submitted = triageValues();
      const result = await api(`/api/admin/support/tickets/${id}/triage`, {
        method: 'PATCH',
        body: { ...submitted, revision: t.triageRevision }
      });
      if (isCurrent()) {
        t = result.ticket;
        el('adminInquirySummary').innerHTML = inquirySummary(t);
        el('adminTriageResult').textContent = JSON.stringify(triageValues()) === JSON.stringify(submitted) ? 'Saved.' : 'Saved. You have newer changes to save.';
      }
      void loadList();
      window.dispatchEvent(new Event('admin:inbox-changed'));
    } catch (e) {
      if (isCurrent()) el('adminTriageResult').textContent = e.message;
    } finally {
      state.busy = false;
      button.disabled = false;
      window.dispatchEvent(new CustomEvent('admin:work-busy', { detail: { id, busy: false } }));
    }
  });
  replaceEventHandler(el('adminReplyText'), 'input', e => {
    d.text = e.target.value;
    draftStore.change(d);
  });
  replaceEventHandler(el('adminInternalNote'), 'input', e => {
    d.note = e.target.value;
    draftStore.change(d);
  });
  replaceEventHandler(el('inboxDetailRefresh'), 'click', () => select(id));
  replaceEventHandler(el('adminReplyForm'), 'submit', async event => {
    event.preventDefault();
    if (state.busy || !isCurrent() || !canReply || !d.text.trim()) return;
    const button = el('adminReplySend'), field = el('adminReplyText');
    if (!chat && !(await confirmAction(`Send this reply to ${t.requesterEmail}?`, {
      title: 'Send email reply',
      confirmLabel: 'Send email'
    }))) return;
    if (!isCurrent() || state.busy) return;
    state.busy = true;
    button.disabled = true;
    window.dispatchEvent(new CustomEvent('admin:work-busy',{detail:{id,busy:true}}));
    const priorRequestId = d.requestId, priorStatus = el('adminTicketStatus').value;
    const replyStatus = el('adminReplyStatus').value;
    d.requestId ||= crypto.randomUUID();
    field.readOnly = true;
    let sendStarted=false;
    let confirmed = false;
    try {
      draftStore.change(d);
      await draftStore.flush(d);
      if (!isCurrent()) { d.requestId = priorRequestId; return; }
      sendStarted=true;
      const result = await api(`/api/admin/support/tickets/${id}/reply`, {
        method: 'POST',
        body: {
          text: d.text,
          status: replyStatus,
          requestId: d.requestId
        }
      });
      if (result.delivery && result.delivery !== 'accepted') {
        d.uncertain = result.delivery !== 'disabled';
        if (isCurrent()) el('adminReplyResult').textContent = result.delivery === 'disabled' ? 'Email sending is disabled in this environment. Your reply was recorded but was not sent.' : 'The email outcome is unconfirmed. Refresh to check its status; it will not be automatically sent again.';
        if (result.delivery === 'disabled') d.requestId = '';
      } else {
        d.uncertain = false;
        d.text = '';
        d.requestId = '';
        confirmed = true;
        field.value = '';
        if (isCurrent()) el('adminReplyResult').textContent = chat ? 'Reply sent to the conversation.' : 'Email accepted by the mail provider.';
      }
      if (isCurrent()) {
        t.status = result.ticket.status;
        t.emailReplies = result.ticket.emailReplies || t.emailReplies;
        if (result.replyMessage) {
          const messageId = message => String(message.id || message._id || '');
          t.conversationMessages = [...(t.conversationMessages || []).filter(message => messageId(message) !== messageId(result.replyMessage)), result.replyMessage];
        }
        el('adminInquirySummary').innerHTML = inquirySummary(t);
        if (el('adminTicketStatus').value === priorStatus) el('adminTicketStatus').value = t.status;
        transcript.innerHTML = inquiryConversation(t);
        transcript.scrollTop = transcript.scrollHeight;
      }
      void loadList();
      window.dispatchEvent(new Event('admin:inbox-changed'));
    } catch (e) {
      if (sendStarted && !confirmed) d.uncertain = !e.status || e.status >= 500 || e.status === 409;
      if(!sendStarted)d.requestId=priorRequestId;
      if (isCurrent() && !confirmed) el('adminReplyResult').textContent = chat || !d.uncertain ? e.message : 'The send result could not be confirmed. Refresh the conversation to check before sending again.';
    } finally {
      draftStore.change(d);
      await draftStore.flush(d).catch(()=>draftStore.paint(d));
      state.busy = false;
      button.disabled = false;
      button.textContent=d.uncertain?'Check or retry saved reply':chat?'Send reply':'Send email';
      field.readOnly = d.uncertain;
      window.dispatchEvent(new CustomEvent('admin:work-busy',{detail:{id,busy:false}}));
      if (confirmed) window.dispatchEvent(new CustomEvent('admin:work-saved',{detail:{id,kind:'inquiry',message:'Reply sent.'}}));
    }
  });
  const mutate = async (button, suffix, body) => {
    if (state.busy || !isCurrent()) return;
    state.busy = true;
    window.dispatchEvent(new CustomEvent('admin:work-busy', { detail: { id, busy: true } }));
    button.disabled = true;
    let saved = false;
    try {
      const result = await api(`/api/admin/support/tickets/${id}/${suffix}`, {
        method: 'POST',
        body
      });
      saved = true;
      if (suffix === 'note' && d.note === body.text) {
        d.note = '';
        if (isCurrent()) el('adminInternalNote').value = '';
        draftStore.change(d);
      }
      if (isCurrent()) {
        if (suffix === 'note') {
          t.internalNotes = result.ticket.internalNotes;
          el('adminInquiryNotes').innerHTML = inquiryNotes(t.internalNotes);
        } else {
          t.status = result.ticket.status;
          el('adminInquirySummary').innerHTML = inquirySummary(t);
          if (el('adminTicketStatus').value === body.status) el('adminTicketStatus').value = t.status;
        }
        el('adminInternalResult').textContent = suffix === 'note' ? 'Note saved.' : 'Status updated.';
      }
      void loadList();
      window.dispatchEvent(new Event('admin:inbox-changed'));
      if (suffix === 'note') await draftStore.flush(d);
    } catch (e) {
      if (isCurrent() && !saved) el('adminInternalResult').textContent = suffix === 'note' && (!e.status || e.status >= 500) ? 'The note could not be confirmed. Refresh the inquiry before saving it again.' : e.message;
    } finally {
      state.busy = false;
      button.disabled = false;
      window.dispatchEvent(new CustomEvent('admin:work-busy', { detail: { id, busy: false } }));
      if (saved && suffix === 'status') window.dispatchEvent(new CustomEvent('admin:work-saved',{detail:{id,kind:'inquiry',message:'Status saved.'}}));
    }
    return saved;
  };
  if (el('adminResolveRequest')) replaceEventHandler(el('adminResolveRequest'), 'click', async event => {
    const button = event.currentTarget;
    const saved = await mutate(button, 'status', {status: 'resolved'});
    if (!isCurrent()) return;
    el('adminResolveResult').textContent = saved ? 'Marked resolved.' : el('adminInternalResult').textContent;
    if (saved) { button.textContent = 'Resolved'; button.disabled = true; el('adminTicketStatus').value = 'resolved'; }
  });
  replaceEventHandler(el('adminSaveNote'), 'click', e => {
    if (d.note.trim()) void mutate(e.currentTarget, 'note', {
      text: d.note
    });
  });
  replaceEventHandler(el('adminSaveTicketStatus'), 'click', e => mutate(e.currentTarget, 'status', {
    status: el('adminTicketStatus').value
  }));
}
function init() {
  if (!el('adminInboxList')) return;
  initCommunications();
  document.addEventListener('change', event => {
    if (event.target.id === 'adminInboxIncludeTests') { state.page = 1; void loadList(); }
  });
  state.source = new URL(location.href).searchParams.get('inbox') || 'all';
  document.querySelectorAll('[data-inbox-source]').forEach(b => replaceEventHandler(b, 'click', () => {
    if (state.busy) return;
    state.source = b.dataset.inboxSource;
    state.page = 1;
    state.detailRequest++;
    state.selected = '';
    el('section-support-ops').classList.remove('admin-inbox-selected');
    routeParam('inbox', state.source);
    routeParam('ticket', '');
    el('adminInboxDetail').innerHTML = '<p>Select an inquiry to read it and reply.</p>';
    void loadList();
  }));
  replaceEventHandler(el('adminInboxSearch'), 'input', debounce(e => {
    state.q = e.target.value;
    state.page = 1;
    void loadList();
  }));
  replaceEventHandler(el('adminInboxStatus'), 'change', e => {
    state.status = e.target.value;
    state.page = 1;
    void loadList();
  });
  replaceEventHandler(el('adminInboxAssignment'), 'change', e => {
    state.assignment = e.target.value;
    state.page = 1;
    void loadList();
  });
  replaceEventHandler(el('adminInboxFollowUp'), 'change', e => {
    state.followUp = e.target.value;
    state.page = 1;
    void loadList();
  });
  replaceEventHandler(el('adminInboxRefresh'), 'click', () => loadList());
  replaceEventHandler(el('adminInboxPrev'), 'click', () => {
    state.page--;
    void loadList();
  });
  replaceEventHandler(el('adminInboxNext'), 'click', () => {
    state.page++;
    void loadList();
  });
  replaceEventHandler(el('adminInboxList'), 'click', e => {
    const b = e.target.closest('[data-inbox-ticket]');
    if (b) void select(b.dataset.inboxTicket);
  });
  replaceEventHandler(el('adminInboxDetail'), 'click', e => {
    if(e.target.closest('[data-inbox-back]'))backToList();
    const u = e.target.closest('[data-inbox-user]'),
      m = e.target.closest('[data-inbox-matter]'),
      i = e.target.closest('[data-inbox-incident]');
    if (u) window.reviewAdminApplicant?.(u.dataset.inboxUser).catch(e => error(e.message));
    if (m) window.openAdminMatter?.(m.dataset.inboxMatter);
    if (i) window.openIncidentInAdminRoom?.(i.dataset.inboxIncident);
  });
  let wasVisible = false;
  new MutationObserver(() => {
    const now = visible('support-ops');
    if (now && !wasVisible) {
      void loadList();
      const id = new URL(location.href).searchParams.get('ticket');
      if (id) void select(id);
    }
    wasVisible = now;
  }).observe(el('section-support-ops'), {
    attributes: true,
    attributeFilter: ['class']
  });
  window.openAdminInbox = (source = 'all') => {
    if (state.busy) return;
    state.status = 'active';
    state.assignment = '';
    state.followUp = '';
    state.q = '';
    el('adminInboxStatus').value = 'active';
    el('adminInboxAssignment').value = '';
    el('adminInboxFollowUp').value = '';
    el('adminInboxSearch').value = '';
    state.source = source;
    state.page = 1;
    state.detailRequest++;
    state.selected = '';
    el('section-support-ops').classList.remove('admin-inbox-selected');
    el('adminInboxDetail').innerHTML = '<p>Select an inquiry to read it and reply.</p>';
    routeParam('inbox', source);
    routeParam('ticket', '');
    window.activateAdminSection?.('support-ops');
    void loadList();
  };
  window.openSupportTicketInAdmin = async id => {
    routeParam('ticket', id);
    window.activateAdminSection?.('support-ops');
    await loadList();
    await select(String(id));
  };
  window.selectSupportTicketInAdmin = select;
  window.loadSupportOps = () => loadList();
  setInterval(() => {
    if (visible('support-ops') && !document.hidden && !state.busy) void loadList();
  }, 15000);
  if (visible('support-ops')) {
    void loadList();
    const id = new URL(location.href).searchParams.get('ticket');
    if (id) void select(id);
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
