import { api, escapeHTML as esc, date } from './shared.js';
import { replaceEventHandler } from '../utils/event-bindings.mjs';
import { promptForText } from '../utils/dialogs.js';
export function bindDisputeEvidence(root, { caseId, disputeId }) {
  const result = root.querySelector('[data-evidence-result]');
  let busy = false, reason = '', sequence = 0;
  const request = body => api(`/api/disputes/${encodeURIComponent(caseId)}/${encodeURIComponent(disputeId)}/evidence`, { method: 'POST', body: { ...body, reason } });
  async function load(action, before) {
    if (busy) return;
    if (!before) {
      reason = await promptForText('Explain why these records are needed for this open dispute. The reason and each evidence read are recorded. Leave confidential client details out of the reason.', { title: 'Review dispute evidence', label: 'Reason for access', required: true, maxLength: 500, confirmLabel: 'Review evidence' });
      if (reason === null) return;
    }
    if (reason.trim().length < 20) { result.textContent = 'Use at least 20 characters to explain why this evidence is needed.'; return; }
    busy = true; const current = ++sequence;
    root.querySelectorAll('button').forEach(button => button.disabled = true);
    result.textContent = 'Loading evidence…';
    try {
      const value = await request({ action, ...(before ? { before } : {}) });
      if (current !== sequence || !root.isConnected) return;
      const rows = action === 'files' ? value.files : value.messages;
      if (!Array.isArray(rows)) throw new Error('Evidence could not be verified.');
      result.innerHTML = rows.length ? rows.map(row => action === 'files'
        ? `<article class="admin-message"><strong>${esc(row.name || 'Document')}</strong><p>${esc(date(row.createdAt))}${row.replaced ? ' · Replaced version' : ''}</p><button type="button" class="btn secondary" data-evidence-file="${esc(row.id)}">Download document</button></article>`
        : `<article class="admin-message"><strong>${esc(row.senderRole || 'Participant')} · ${esc(date(row.createdAt))}</strong><p class="admin-preserve-text">${esc(row.text || row.transcript || row.fileName || 'Attachment message')}</p></article>`).join('') : `<p>No ${action === 'files' ? 'documents' : 'messages'} recorded for this assignment.</p>`;
      if (value.nextBefore) {
        const next = document.createElement('button'); next.type = 'button'; next.className = 'btn secondary'; next.textContent = 'Earlier records';
        replaceEventHandler(next, 'click', () => load(action, value.nextBefore)); result.append(next);
      }
      result.querySelectorAll('[data-evidence-file]').forEach(button => replaceEventHandler(button, 'click', async () => {
        button.disabled = true;
        const status = document.createElement('p'); status.setAttribute('role', 'status'); button.after(status); status.textContent = 'Checking document safety…';
        try {
          const response = await request({ action: 'preview', fileId: button.dataset.evidenceFile });
          if (!response.url || response.expiresIn !== 60) throw new Error('A protected download could not be verified.');
          const url = new URL(response.url);
          if (url.protocol !== 'https:') throw new Error('A protected download could not be verified.');
          const link = document.createElement('a'); link.href = url.href; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; link.textContent = 'Download document · link expires in 60 seconds';
          status.replaceChildren(link); setTimeout(() => { if (status.isConnected) status.textContent = 'This download link expired. Request another when needed.'; }, 60000);
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
      }));
    } catch (error) { result.textContent = error.message; }
    finally { busy = false; root.querySelectorAll('button').forEach(button => button.disabled = false); }
  }
  root.querySelectorAll('[data-evidence-action]').forEach(button => replaceEventHandler(button, 'click', () => load(button.dataset.evidenceAction)));
  root.addEventListener('toggle', () => { if (!root.open) { sequence++; result.replaceChildren(); reason = ''; } });
}
