import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { api, escapeHTML as esc, date, label } from './shared.js';
import { confirmAction } from '../utils/dialogs.js';
const templates={information:'Thank you for reaching out. Could you share a little more detail about what happened and what you need help with? Please leave out passwords and payment details.',acknowledge:'Thank you for your message. I’m reviewing your question and will follow up here as soon as I have an update.',followup:'I’m following up on your inquiry. Were you able to move forward, or is there anything else you need help with?'};
export const replyTemplates=()=>'<label for="adminReplyTemplate" class="small">Saved reply</label><select id="adminReplyTemplate"><option value="">None</option><option value="information">Request more information</option><option value="acknowledge">Acknowledge an inquiry</option><option value="followup">Follow up</option></select>';
export function bindReplyTemplates(read,write) {
  const input=document.getElementById('adminReplyTemplate');
  replaceEventHandler(input, 'change', async()=>{const value=templates[input.value];input.value='';if(!value)return;if(read().trim()&&!await confirmAction('Replace the text in this reply draft?',{title:'Use saved reply',confirmLabel:'Replace draft'}))return;write(value);});
}
function deliveryCounts(counts = {}) {
  const attention = (counts.failed || 0) + (counts.unknown || 0) + (counts.disabled || 0);
  return [counts.pending ? `${counts.pending} queued` : '', counts.sending ? `${counts.sending} sending` : '', counts.accepted ? `${counts.accepted} accepted by the mail provider` : '', attention ? `${attention} ${attention === 1 ? 'needs' : 'need'} attention` : ''].filter(Boolean).join(' · ') || 'No emails queued.';
}
function attentionList(rows, kind) {
  if (!rows.length) return '';
  const isFile = kind === 'files', isWork = kind === 'work', isPayment = kind === 'payments', isWithdrawal = kind === 'withdrawals', isReview = kind === 'reviews', isApplication = kind === 'applications', isInvitation = kind === 'invitations', isPreEngagement = kind === 'pre-engagement', isPosting = kind === 'posting', isMatter = isFile || isWork || isPayment || isWithdrawal || isReview || isApplication || isInvitation || isPreEngagement || isPosting;
  return `<details data-delivery-attention="${kind}"><summary>${isFile ? 'File emails' : isWork ? 'Work emails' : isPayment ? 'Payment emails' : isWithdrawal ? 'Withdrawal emails' : isReview ? 'Matter review emails' : isApplication ? 'Application emails' : isInvitation ? 'Invitation emails' : isPreEngagement ? 'Pre-engagement emails' : isPosting ? 'Posting emails' : 'Owner alerts'} that need attention</summary>${rows.map(row => `
    <article class="admin-message">
      <strong>${isFile ? 'File upload' : isWork ? 'Work ready' : isPayment ? 'Payment update' : isWithdrawal ? 'Paralegal withdrawal' : isReview ? 'Matter review' : isApplication ? row.kind === 'withdrawn' ? 'Application withdrawn' : 'Application received' : isPosting ? ({created:'Posting published',updated:'Posting updated',deleted:'Posting removed',edits_requested:'Posting revisions requested',review_requested:'Posting review requested'}[row.kind] || 'Posting') : isPreEngagement ? ({requested:'Pre-engagement requested',submitted:'Pre-engagement response',changes_requested:'Pre-engagement changes requested'}[row.kind] || 'Pre-engagement') : isInvitation ? ({accepted:'Invitation accepted',declined:'Invitation declined',revoked:'Invitation acceptance withdrawn',sent:'Matter invitation'}[row.kind] || 'Matter invitation') : esc(label(row.kind))} · ${esc(label(row.status))}</strong>
      <p>${esc(row.failure || 'Email sending was disabled. This notice was not sent.')}</p>
      <small>${esc(date(row.updatedAt))} · ${row.attempts} ${row.attempts === 1 ? 'attempt' : 'attempts'}</small>
      <p class="small" style="overflow-wrap:anywhere">Delivery reference: ${esc(`<lpc-${isFile ? 'file' : isWork ? 'work' : isPayment ? 'payment' : isWithdrawal ? 'withdrawal' : isReview ? 'review' : isApplication ? 'application' : isInvitation ? 'invitation' : isPreEngagement ? 'pre-engagement' : isPosting ? 'posting' : 'alert'}.${row._id}@lets-paraconnect.com>`)}</p>
      <div class="admin-inline-actions">
        ${isMatter ? '' : `<button type="button" class="btn secondary" data-alert-open="${esc(row.targetId)}" data-alert-kind="${esc(row.kind)}">Open request</button>`}
        <button type="button" class="btn secondary" data-delivery-retry="${esc(row._id)}" data-delivery-kind="${kind}" data-delivery-revision="${esc(row.revision)}">Queue another attempt</button>
      </div>
    </article>`).join('')}${rows.length === 10 ? '<p class="small">Showing the 10 most recently updated notices needing attention. Refresh after addressing them.</p>' : ''}</details>`;
}
export function initCommunications() {
  const section = document.getElementById('section-support-ops');
  if (!section || section.querySelector('.admin-communications')) return;
  const fold = document.createElement('details');
  fold.className = 'admin-detail-fold admin-communications';
  fold.innerHTML = '<summary>Email delivery &amp; support mailbox</summary><div data-communications-body><p>Loading connection status…</p></div>';
  section.querySelector('header').after(fold);
  const root = fold.querySelector('[data-communications-body]');
  let busy = false, generation = 0;
  async function refresh({ focus = false, message = '' } = {}) {
    if (busy) return;
    const current = ++generation;
    try {
      const { mailbox: m, alerts: a, fileNotices: f, workNotices: w, paymentNotices: p, withdrawalNotices: v, reviewNotices: d, applicationNotices: n, invitationNotices: i, preEngagementNotices: e, postingNotices: t } = await api('/api/admin/workspace/communications');
      if (current !== generation) return;
      if (!f?.counts || !Array.isArray(f.recent)) throw new Error('File email status could not be verified.');
      if (!w?.counts || !Array.isArray(w.recent)) throw new Error('Work email status could not be verified.');
      if (!p?.counts || !Array.isArray(p.recent)) throw new Error('Payment email status could not be verified.');
      if (!v?.counts || !Array.isArray(v.recent)) throw new Error('Withdrawal email status could not be verified.');
      if (!d?.counts || !Array.isArray(d.recent)) throw new Error('Matter review email status could not be verified.');
      if (!n?.counts || !Array.isArray(n.recent)) throw new Error('Application email status could not be verified.');
      if (!i?.counts || !Array.isArray(i.recent)) throw new Error('Invitation email status could not be verified.');
      if (!e?.counts || !Array.isArray(e.recent)) throw new Error('Pre-engagement email status could not be verified.');
      if (!t?.counts || !Array.isArray(t.recent)) throw new Error('Posting email status could not be verified.');
      const workerRecent = m.lastWorkerAt && Date.now() - new Date(m.lastWorkerAt) < 5 * 60000;
      root.innerHTML = `
        <p><strong>Support mailbox</strong> · ${esc(m.mailbox)}</p>
        <p>${m.configured ? m.error ? esc(m.error) : m.lastCompletedAt ? `Last completed scan: ${esc(date(m.lastCompletedAt))}${m.backlog ? ' · More messages are being checked.' : ''}` : 'Connected settings saved. The first scan has not finished.' : 'Mailbox connection needed. Email replies currently remain in the support mailbox.'}</p>
        ${m.since ? `<p class="small">Checking messages received since ${esc(date(m.since))}.</p>` : ''}
        <p><strong>Owner alerts</strong> · ${esc(a.recipient)}<br>${deliveryCounts(a.counts)}</p>
        <p><strong>File upload emails</strong><br>${deliveryCounts(f.counts)}</p>
        <p><strong>Work ready emails</strong><br>${deliveryCounts(w.counts)}</p>
        <p><strong>Payment update emails</strong><br>${deliveryCounts(p.counts)}</p>
        <p><strong>Withdrawal emails</strong><br>${deliveryCounts(v.counts)}</p>
        <p><strong>Application emails</strong><br>${deliveryCounts(n.counts)}</p>
        <p><strong>Invitation emails</strong><br>${deliveryCounts(i.counts)}</p>
        <p><strong>Pre-engagement emails</strong><br>${deliveryCounts(e.counts)}</p>
        <p><strong>Posting emails</strong><br>${deliveryCounts(t.counts)}</p>
        <p><strong>Matter review emails</strong><br>${deliveryCounts(d.counts)}</p>
        <p class="small">${workerRecent ? 'Background worker checked in recently.' : `Background worker has ${m.lastWorkerAt ? `not checked in since ${esc(date(m.lastWorkerAt))}` : 'not checked in yet'}. Automatic sync and queued emails need the worker running.`}</p>
        <div class="admin-inline-actions">
          <button type="button" class="btn secondary" data-communications-refresh>Refresh status</button>
          ${m.configured ? '<button type="button" class="btn secondary" data-communications-sync>Check for email replies</button>' : ''}
        </div>
        <div role="status" data-communications-result>${esc(message)}</div>
        ${attentionList(a.recent, 'alerts')}${attentionList(f.recent, 'files')}${attentionList(w.recent, 'work')}${attentionList(p.recent, 'payments')}${attentionList(v.recent, 'withdrawals')}${attentionList(d.recent, 'reviews')}${attentionList(n.recent, 'applications')}${attentionList(i.recent, 'invitations')}${attentionList(e.recent, 'pre-engagement')}${attentionList(t.recent, 'posting')}`;
      const refreshButton = root.querySelector('[data-communications-refresh]');
      replaceEventHandler(refreshButton, 'click', () => refresh({ focus: true }));
      if (focus) refreshButton.focus();
      const sync = root.querySelector('[data-communications-sync]');
      if (sync) replaceEventHandler(sync, 'click', async () => {
        busy = true; sync.disabled = true;
        const result = root.querySelector('[data-communications-result]');
        result.textContent = 'Checking for replies…';
        try {
          const response = await api('/api/admin/workspace/communications/sync', { method: 'POST', body: {} });
          result.textContent = response.busy ? 'A scan is already running.' : `${response.imported || 0} emails added.${response.complete ? ' Scan complete.' : ' More messages will be checked on the next pass.'}`;
          window.dispatchEvent(new Event('admin:inbox-changed')); window.loadSupportOps?.();
        } catch (error) { result.textContent = error.message; }
        finally { busy = false; sync.disabled = false; }
      });
      root.querySelectorAll('[data-alert-open]').forEach(button => replaceEventHandler(button, 'click', () => button.dataset.alertKind === 'signup' ? window.reviewAdminApplicant?.(button.dataset.alertOpen) : window.openSupportTicketInAdmin?.(button.dataset.alertOpen)));
      root.querySelectorAll('[data-delivery-retry]').forEach(button => replaceEventHandler(button, 'click', async () => {
        button.focus();
        if (!await confirmAction('Check the mail provider’s delivery record using this notice’s delivery reference. An unconfirmed email may already have arrived; another attempt could duplicate it.', { title: 'Retry email notice', confirmLabel: 'I checked — queue attempt' })) return;
        button.disabled = true;
        try {
          const response = await api(`/api/admin/workspace/communications/${button.dataset.deliveryKind}/${button.dataset.deliveryRetry}/retry`, { method: 'POST', body: { confirmed: true, revision: button.dataset.deliveryRevision } });
          if (response?.ok !== true) throw new Error('The retry could not be confirmed. Refresh its status.');
          await refresh({ focus: true, message: 'Another attempt is queued.' });
        } catch (error) {
          root.querySelector('[data-communications-result]').textContent = error.message;
          button.disabled = false; button.focus();
        }
      }));
    } catch (error) {
      if (current !== generation) return;
      root.innerHTML = `<p role="alert">Communication status is unavailable. ${esc(error.message)}</p><button type="button" class="btn secondary" data-retry-status>Try again</button>`;
      const retry = root.querySelector('[data-retry-status]');
      replaceEventHandler(retry, 'click', () => refresh({ focus: true }));
      if (focus) retry.focus();
    }
  }
  fold.addEventListener('toggle', () => { if (fold.open) void refresh(); });
}
