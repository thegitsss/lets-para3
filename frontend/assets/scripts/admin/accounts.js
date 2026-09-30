import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { api as request, escapeHTML as esc, date, label, person, routeParam } from './shared.js';
import { icon, safeHref } from './presentation.js';
import { createDraftStore } from './drafts.js';
import { confirmAction, promptForText } from '../utils/dialogs.js';
const el = id => document.getElementById(id);
// This workspace owns its request outcomes in the active review panel.
const api = (url, options = {}) => request(url, { ...options, suppressToast: true });
let sequence = 0;
const draftStore=createDraftStore('account', { suppressToast: true });
const readinessText = r => `${label(r.key).replace(/^./, character => character.toUpperCase())}: ${label(r.status)}${r.fields?.length ? ` (${r.fields.map(label).join(', ')})` : ''}`;
function accountHistoryMarkup(context) {
  const requests = context.admissionRequests, events = context.history;
  if (!requests.length && !events.length) return '<p>No activity or correspondence yet.</p>';
  return `${requests.length ? `<h3>Application correspondence</h3>${requests.map(ticket => `<article class="admin-message"><button class="btn secondary" type="button" data-account-ticket="${esc(ticket._id)}">Open information request</button><p>${esc(label(ticket.status))} · ${esc(date(ticket.createdAt))}</p>${ticket.emailReplies.map(reply => `<p>${esc(reply.text)}<br><small>Email: ${esc(label(reply.delivery))} · ${esc(date(reply.createdAt))}</small></p>`).join('')}</article>`).join('')}` : ''}
    ${events.length ? `<h3>Account activity</h3>${events.map(entry => `<article class="admin-message"><strong>${esc(label(entry.action.replace(/^admin\.user\./, '')))}</strong>${entry.meta?.note || entry.meta?.reason ? `<p>${esc(entry.meta.note || entry.meta.reason)}</p>` : ''}${entry.meta?.delivery ? `<p>Email: ${esc(label(entry.meta.delivery))}</p>` : ''}<small>${esc(date(entry.createdAt))}</small></article>`).join('')}` : ''}
    ${events.length >= 30 ? '<p class="small">Showing the 30 most recent events. The full Activity log is under System.</p>' : ''}`;
}
function init() {
  const modal = el('pendingUserModal'),
    root = document.createElement('div');
  root.id = 'adminAccountContext';
  modal.querySelector('.details-header').after(root);
  const profile = el('pendingUserDetails').closest('table');
  window.renderAdminAccount = async user => {
    const id = String(user.id || user._id),
      seq = ++sequence;
    let historyRequest = 0;
    const isCurrent = () => seq === sequence && !modal.classList.contains('hidden');
    let writing = false;
    const setWriting = value => {
      writing = value;
      window.dispatchEvent(new CustomEvent('admin:work-busy', { detail: { id, busy: value } }));
    };
    routeParam('account', id);
    profile.hidden = true;
    root.innerHTML = '<p role="status">Loading account review…</p>';
    el('approveUserBtn').disabled=true;
    el('denyUserBtn').disabled=true;
    const [context, check, saved] = await Promise.allSettled([api(`/api/admin/workspace/accounts/${id}`), api(`/api/admin/users/${id}/admission-check`),draftStore.load(id)]);
    if (seq !== sequence || modal.classList.contains('hidden')) return;
    if (context.status !== 'fulfilled' || saved.status !== 'fulfilled') {
      root.innerHTML = `<p role="alert">${esc(context.reason?.message || saved.reason?.message)}</p><button class="btn secondary" id="adminAccountRetry">Retry account details</button>`;
      replaceEventHandler(el('adminAccountRetry'), 'click', () => window.renderAdminAccount(user));
      profile.hidden = false;
      return;
    }
    const c = context.value;
    const listedRequirements = new Set(c.readiness.reasons.map(readinessText));
    const additionalDirectoryRequirements = c.visibility?.reasons.filter(reason => !listedRequirements.has(readinessText(reason))) || [];
    const pending = user.status === 'pending',
      canAccess = !user.disabled && !user.deleted;
    const documentLinks = [['resumeURL','Resume'],['certificateURL','Certificate'],['linkedInURL','LinkedIn profile']].filter(([key]) => user[key] && safeHref(user[key]));
    const introduction = user.bio || user.about;
    const focusAreas = [...(user.practiceAreas || []), ...(user.specialties || [])].filter((value, index, values) => values.indexOf(value) === index);
    const hasBackground = introduction || focusAreas.length || user.yearsExperience != null || user.barNumber || user.jurisdictions?.length;
    const admissionMessage = pending ? (check.status === 'fulfilled' ? (user.role === 'attorney' || !check.value.canApprove ? check.value.message : '') : 'Document checks are unavailable. Approval still enforces the required checks.') : '';
    const resumeRequirementCovered = pending && check.status === 'fulfilled' && check.value.code === 'ADMISSION_FILE_REQUIRED';
    const profileReasons = c.readiness.reasons.filter(reason => !resumeRequirementCovered || reason.key !== 'resume');
    const draft = saved.value;
    window.flushAdminAccountDraft = () => draftStore.flush(draft);
    const recorded=c.admissionRequests.flatMap(t=>t.emailReplies||[]).find(r=>r.requestId===draft.requestId);
    if(recorded?.delivery==='accepted'){draft.text='';draft.requestId='';draft.uncertain=false;draftStore.change(draft);}
    else if(recorded&&['pending','unknown'].includes(recorded.delivery))draft.uncertain=true;
    el('denyUserBtn').disabled=false;
    root.innerHTML = `<div class="admin-tabs" role="group" aria-label="Account detail"><button type="button" data-account-tab="review" aria-pressed="true">Review</button><button type="button" data-account-tab="profile" aria-pressed="false">Profile</button><button type="button" data-account-tab="history" aria-pressed="false">History</button></div>
  <div data-account-panel="review">${pending ? `<dl class="admin-review-summary"><div><dt>${user.role === 'attorney' ? 'Bar number' : 'Qualification'}</dt><dd>${esc(user.role === 'attorney' ? user.barNumber || 'Not provided' : ({ certificate: 'Certificate', degree: 'Paralegal degree', law_firm_experience: 'Law firm experience' }[user.paralegalQualification] || 'Not provided'))}</dd></div><div><dt>${user.role === 'attorney' ? 'State' : 'Experience'}</dt><dd>${esc(user.role === 'attorney' ? user.barState || user.state || 'Not provided' : user.yearsExperience == null ? 'Not provided' : `${user.yearsExperience} years`)}</dd></div></dl>` : ''}${draftStore.markup(draft)}
  <div class="admin-facts"><div><span>Application</span><strong>${esc(label(user.status))}</strong></div><div><span>Account access</span><strong>${user.deleted ? 'Deactivated' : !canAccess ? 'Suspended' : user.status==='approved' ? 'Enabled' : 'Awaiting approval'}</strong></div><div><span>Active matters</span><strong>${c.activeMatters}</strong></div><div><span>Open inquiries</span><strong>${c.openInquiries}</strong></div></div>
  ${c.reviewState === 'information_requested' ? '<p class="admin-status admin-status-attention">Information requested. Check delivery and replies in History.</p>' : ''}
  <div class="admin-application-grid"><div>${hasBackground ? `<section class="admin-review-card"><h3>Professional background</h3>${introduction ? `<p>${esc(introduction)}</p>` : ''}${focusAreas.length ? `<p><strong>${user.role==='attorney'?'Practice areas':'Specialties'}</strong><br>${esc(focusAreas.join(' · '))}</p>` : ''}${user.paralegalQualification ? `<p><strong>Admission qualification</strong><br>${esc(({certificate: "Paralegal certificate", degree: "Degree in paralegal studies", law_firm_experience: "At least 1 year working in a law firm"})[user.paralegalQualification] || user.paralegalQualification)}</p>` : ''}${user.yearsExperience != null ? `<p><strong>Experience</strong><br>${esc(user.yearsExperience)} years</p>` : ''}${user.barNumber ? `<p><strong>Bar number</strong><br>${esc(user.barNumber)}</p>` : ''}${user.jurisdictions?.length ? `<p><strong>Jurisdictions</strong><br>${esc(user.jurisdictions.join(' · '))}</p>` : ''}</section>` : ''}
  ${documentLinks.length ? `<section class="admin-review-card"><h3>Documents</h3>${documentLinks.map(([key,title])=>`<a class="admin-document-link" href="${esc(safeHref(user[key]))}" target="_blank" rel="noopener">${icon('document')} ${title} ${icon('external')}</a>`).join('')}</section>` : ''}
  <section class="admin-review-card"><label for="adminDecisionNote">Reason or internal follow-up</label><textarea id="adminDecisionNote" rows="3" maxlength="4000">${esc(draft.note)}</textarea><button class="btn secondary" id="adminAccountNote" type="button">Save internal note</button></section></div>
  <div><section class="admin-review-card"><h3>${pending ? 'Application review checklist' : 'Account readiness'}</h3><ul class="admin-checklist"><li>${icon(user.emailVerified?'check':'clock')}<span>Email ${user.emailVerified?'verified':'not confirmed'}</span></li>${profileReasons.map(r=>`<li>${icon('clock')}<span>${esc(readinessText(r))}</span></li>`).join('')}</ul><p class="small">Checked ${esc(date(c.checkedAt))}.</p>${c.visibility ? `<p>Directory: ${c.visibility.ready ? 'Eligible' : 'Not ready'}${additionalDirectoryRequirements.length ? ` · ${esc(additionalDirectoryRequirements.map(readinessText).join('; '))}` : ''}</p>` : ''}${c.payouts ? `<p>Payout account: ${c.payouts.accountPresent ? 'Recorded' : 'Not recorded'}. Live readiness is checked during payment.</p>` : ''}</section>
  ${pending ? `<details class="admin-detail-fold" open><summary>Need more information?</summary><p>Emails ${esc(user.email)}. Application stays pending.</p><form id="adminInformationRequest">${c.preparation?.requestText && !draft.uncertain ? `<p>${esc(c.preparation.summary)}</p><button class="btn secondary" type="button" id="adminUsePreparedRequest">Use prepared request</button>` : ''}<label for="adminInformationText">Information you need</label><textarea id="adminInformationText" rows="4" required maxlength="12000" ${draft.uncertain ? 'readonly' : ''}>${esc(draft.text)}</textarea><button class="btn secondary" type="submit">${draft.uncertain?'Check or retry saved request':'Send information request'}</button></form></details>` : ''}
  <details class="admin-detail-fold"><summary>Account access &amp; exceptions</summary><p>${c.moneyExceptions} money exceptions. Access changes do not settle matters, refund money, or complete pending work.</p>${!user.deleted ? `<button class="btn ${user.disabled ? 'secondary' : 'danger'}" type="button" id="adminAccountAccess">${user.disabled ? 'Reinstate account' : 'Suspend account'}</button>` : ''}</details></div></div><p id="adminAccountResult" role="status"></p></div>
  <div data-account-panel="history" hidden></div>`;
    // Keep the decision and documents visible; background and checks expand on demand.
    for (const card of root.querySelectorAll('.admin-review-card')) {
      const heading = card.querySelector('h3');
      if (!heading || !['Professional background', 'Application review checklist', 'Account readiness'].includes(heading.textContent)) continue;
      const details = document.createElement('details');
      details.className = 'admin-detail-fold admin-review-evidence';
      const summary = document.createElement('summary');
      summary.textContent = heading.textContent === 'Professional background' ? 'Background' : 'Checks';
      details.append(summary); heading.remove();
      card.before(details); details.append(card);
    }
    if (admissionMessage) {
      const brief = document.createElement('p'); brief.className = 'admin-admission-brief'; brief.textContent = admissionMessage;
      root.querySelector('.admin-tabs').after(brief);
    }
    const historyPanel = root.querySelector('[data-account-panel="history"]');
    async function loadHistory() {
      if (!isCurrent()) return;
      const request = ++historyRequest;
      historyPanel.setAttribute('aria-busy', 'true');
      historyPanel.innerHTML = '<p role="status">Loading history…</p>';
      try {
        const context = await api(`/api/admin/workspace/accounts/${id}`);
        if (!isCurrent() || request !== historyRequest) return;
        historyPanel.innerHTML = accountHistoryMarkup(context);
      } catch (error) {
        if (!isCurrent() || request !== historyRequest) return;
        historyPanel.innerHTML = `<p role="alert">${esc(error.message)}</p><button class="btn secondary" type="button" data-history-retry>Retry history</button>`;
      } finally {
        if (isCurrent() && request === historyRequest) historyPanel.removeAttribute('aria-busy');
      }
    }
    root.querySelectorAll('[data-account-tab]').forEach(b => replaceEventHandler(b, 'click', () => {
      root.querySelectorAll('[data-account-panel]').forEach(p => p.hidden = p.dataset.accountPanel !== b.dataset.accountTab);
      profile.hidden = b.dataset.accountTab !== 'profile';
      root.querySelectorAll('[data-account-tab]').forEach(t => t.setAttribute('aria-pressed', String(t === b)));
      if (b.dataset.accountTab === 'history') void loadHistory();
    }));
    replaceEventHandler(historyPanel, 'click', event => {
      if (!isCurrent()) return;
      if (event.target.closest('[data-history-retry]')) { void loadHistory(); return; }
      const ticket = event.target.closest('[data-account-ticket]');
      if (ticket) {
        el('closePendingModal').click();
        window.openSupportTicketInAdmin(ticket.dataset.accountTicket);
      }
    });
    if (pending && check.status === 'fulfilled' && !check.value.canApprove) el('approveUserBtn').disabled = true;else el('approveUserBtn').disabled = false;
    draftStore.paint(draft);
    replaceEventHandler(el('adminDecisionNote'), 'input', e=>{draft.note=e.target.value;draftStore.change(draft);});
    if(draft.uncertain)el('adminAccountResult').textContent='The last email outcome is unconfirmed. Check or retry the saved request; a recorded send will not be repeated.';
    replaceEventHandler(el('adminAccountNote'), 'click', async event => {
      const field = el('adminDecisionNote'), button = event.currentTarget;
      const originalText = field.value, text = originalText.trim();
      if (!text || writing || !isCurrent()) return;
      button.disabled = true;
      setWriting(true);
      let recorded = false;
      try {
        await api(`/api/admin/workspace/accounts/${id}/note`, {
          method: 'POST',
          body: {
            text
          }
        });
        recorded = true;
        // A later draft belongs to the administrator, even when the earlier
        // note's acknowledgement arrives after typing or account navigation.
        if (draft.note === originalText) {
          draft.note = '';
          if (isCurrent() && field.value === originalText) field.value = '';
          draftStore.change(draft);
        }
        if (isCurrent()) el('adminAccountResult').textContent = 'Internal note saved.';
        await draftStore.flush(draft);
      } catch (e) {
        // The draft store reports its own persistence failure. It must not
        // turn an acknowledged note into an apparently failed note request.
        if (isCurrent() && !recorded) el('adminAccountResult').textContent = e.status >= 400 && e.status < 500 ? e.message : 'The note could not be confirmed. Check History before saving it again.';
      } finally {
        button.disabled = false;
        setWriting(false);
      }
    });
    if (el('adminAccountAccess')) replaceEventHandler(el('adminAccountAccess'), 'click', async event => {
      const button = event.currentTarget;
      if (button.disabled || writing || !isCurrent()) return;
      button.disabled = true;
      setWriting(true);
      let recorded = false;
      try {
      const reason = await promptForText(`Reason for ${user.disabled ? 'reinstating' : 'suspending'} ${person(user)}?`, {
        title: 'Account access',
        confirmLabel: 'Continue'
      });
      if (!reason?.trim() || !isCurrent()) return;
      if (!(await confirmAction(`${user.disabled ? 'Restore' : 'Block'} access for ${person(user)} (${user.email})? This account has ${c.activeMatters} active matters and ${c.moneyExceptions} money exceptions. ${reason}`, {
        title: user.disabled ? 'Reinstate account?' : 'Suspend account?',
        confirmLabel: user.disabled ? 'Reinstate' : 'Suspend',
        tone: 'danger'
      })) || !isCurrent()) return;
        await api(`/api/admin/${user.disabled ? 'enable' : 'disable'}/${id}`, {
          method: 'POST',
          body: {
            reason
          }
        });
        recorded = true;
        if (isCurrent()) await window.reviewAdminApplicant(id, { inline: modal.classList.contains('admin-flow-inline'), isCurrent });
        window.refreshAdminUsers?.();
      } catch (e) {
        if (isCurrent()) el('adminAccountResult').textContent = recorded ? `Account ${user.disabled ? 'reinstated' : 'suspended'}. Reopen the review to load its current details.` : e.message;
      } finally {
        button.disabled = false;
        setWriting(false);
      }
    });
    if (pending) {
      if (el('adminUsePreparedRequest')) replaceEventHandler(el('adminUsePreparedRequest'), 'click', async () => {
        if (!isCurrent() || writing || draft.uncertain) return;
        if (draft.text.trim() && !await confirmAction('Replace your current draft with the prepared request?', { title: 'Keep or replace your draft', confirmLabel: 'Replace draft' })) return;
        if (!isCurrent() || writing || draft.uncertain) return;
        draft.text = c.preparation.requestText;
        el('adminInformationText').value = draft.text;
        draftStore.change(draft);
        el('adminInformationText').focus();
      });
      replaceEventHandler(el('adminInformationText'), 'input', e => {
        draft.text = e.target.value;
        draftStore.change(draft);
      });
      replaceEventHandler(el('adminInformationRequest'), 'submit', async event => {
        event.preventDefault();
        const field = el('adminInformationText'), button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
        if (!isCurrent() || writing || button.disabled || !draft.text.trim()) return;
        if (!(await confirmAction(`Send this information request to ${user.email}?`, {
          title: 'Review application information request',
          confirmLabel: 'Send request'
        })) || !isCurrent() || writing) return;
        button.disabled = true;
        setWriting(true);
        const priorRequestId = draft.requestId;
        draft.requestId ||= crypto.randomUUID();
        field.readOnly=true;
        let sendStarted=false;
        let confirmed = false;
        try {
          draftStore.change(draft);await draftStore.flush(draft);
          if (!isCurrent()) { draft.requestId = priorRequestId; return; }
          sendStarted=true;
          const result = await api(`/api/admin/workspace/accounts/${id}/information-request`, {
            method: 'POST',
            body: {
              text: draft.text,
              requestId: draft.requestId
            }
          });
          if (isCurrent()) el('adminAccountResult').textContent = result.delivery === 'accepted' ? 'Information request accepted by the email provider. The application remains pending.' : `Information request recorded. Email ${label(result.delivery)}.`;
          draft.uncertain=['pending','unknown'].includes(result.delivery);
          if(result.delivery==='disabled')draft.requestId='';
          if (result.delivery === 'accepted') {
            confirmed = true;
            draft.text = '';
            draft.requestId = '';
            field.value = '';
          }
          window.dispatchEvent(new Event('admin:inbox-changed'));
        } catch (e) {
          if(sendStarted&&(!e.status||e.status>=500||e.status===409))draft.uncertain=true;
          if(!sendStarted)draft.requestId=priorRequestId;
          if (isCurrent()) el('adminAccountResult').textContent = e.message;
        } finally {
          draftStore.change(draft);await draftStore.flush(draft).catch(()=>draftStore.paint(draft));
          field.readOnly=draft.uncertain;
          button.disabled = false;
          button.textContent=draft.uncertain?'Check or retry saved request':'Send information request';
          setWriting(false);
          if (confirmed) window.dispatchEvent(new CustomEvent('admin:work-saved',{detail:{id,kind:'application',message:'Information requested.'}}));
        }
      });
    }
  };
  addEventListener('admin:admissions-changed',async event=>{
    if(!event.detail?.id)return;
    try {const draft=await draftStore.load(event.detail.id);draft.note='';draftStore.change(draft);await draftStore.flush(draft);}
    catch(error) { window.toastUtils?.show(`The decision is saved, but the private draft could not be cleared. ${error.message}`,{targetId:'toastBanner',type:'err'}); }
  });
  new MutationObserver(() => {
    if (modal.classList.contains('hidden')) {
      sequence++;
      routeParam('account', '');
    }
  }).observe(modal, {
    attributes: true,
    attributeFilter: ['class']
  });
  const initial = new URL(location.href).searchParams.get('account');
  if (initial) window.reviewAdminApplicant?.(initial).catch(e => window.toastUtils?.show(e.message, {
    targetId: 'toastBanner',
    type: 'err'
  }));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
