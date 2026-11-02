import { node, action, validId, matterHref } from './shared.mjs';
import { confirmAction } from '../utils/dialogs.js';
const button = (label, fn, secondary = false) => action(label, fn, secondary ? 'lpc-connected-button is-secondary' : 'lpc-connected-button');
const text = (value, className = 'lpc-connected-note') => node('p', { className, text: value });
function readPreparation(value, kind) {
  if (!value || !validId(value.id) || value.kind !== kind || !['proposed', 'accepted'].includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.items) || value.items.length > 30 || value.items.some(item => !item || typeof item.title !== 'string' || !item.title || !Array.isArray(item.citations)) || !Array.isArray(value.files)) throw new Error('The preparation response could not be confirmed. Check the saved request before continuing.');
  return value;
}
function readJob(value, expectedId) {
  if (!value || !validId(value.id) || expectedId && value.id !== expectedId || !['preparation', 'submission'].includes(value.kind) || !['queued', 'running', 'complete', 'failed'].includes(value.status) || !['queued', 'reading', 'ocr', 'analyzing', 'complete', 'failed'].includes(value.stage) || !Number.isSafeInteger(value.totalFiles) || value.totalFiles < 0 || value.totalFiles > 8 || !Number.isSafeInteger(value.processedFiles) || value.processedFiles < 0 || value.processedFiles > value.totalFiles || value.status === 'complete' && (value.stage !== 'complete' || !validId(value.preparationId)) || value.status === 'failed' && value.stage !== 'failed') throw new Error('The preparation progress could not be confirmed. Check the saved request before continuing.');
  return value;
}
function readAccepted(value, body) {
  const result = readPreparation(value, 'preparation'), expected = body.items.map(item => typeof item === 'string' ? item : item.title);
  if (result.id !== body.preparationId || result.status !== 'accepted' || result.revision <= body.revision || JSON.stringify(result.items.map(item => item.title)) !== JSON.stringify(expected)) throw new Error('The checklist save could not be confirmed. Check the saved checklist before editing again.');
  return result;
}
export function preparationEntry(preparation) {
  const entry = button('Prepare work', () => {
    preparation.scrollIntoView({ block: 'start', behavior: 'instant' });
    preparation.tabIndex = -1; preparation.focus({ preventScroll: true });
  }, true);
  entry.dataset.nativePreparationEntry = '';
  return entry;
}
export function createNativePreparation({ caseId, ownerId, role, api, signal, mode = 'preparation', privateState, drafts = privateState?.preparationDrafts || new Map() }) {
  const root = node('section', { className: 'lpc-connected-section', 'data-native-preparation': '', 'data-mode': mode, 'aria-label': 'Document preparation' });
  const header = node('div', { className: 'lpc-connected-heading' }, [node('div', {}, [node('span', { className: 'lpc-connected-eyebrow', text: 'Document intelligence' }), node('h3', { text: mode === 'submission' ? 'A closer look before review' : 'Turn the brief into a clear next step' })])]);
  const feedback = node('p', { className: 'lpc-connected-feedback', role: 'status', 'aria-live': 'polite' });
  const content = node('div'), progress = node('div', { className: 'lpc-connected-progress', hidden: '', role: 'status', 'aria-live': 'polite' }), output = node('div', { className: 'lpc-connected-output' });
  root.append(header, text(mode === 'submission' ? 'Check selected documents against the agreed work, with source notes for every suggestion.' : 'Build a working checklist from the agreed instructions and selected documents.'), feedback, content, progress, output);
  let payload, kind = mode, busy = false, disposed = false, polling, selected = new Set(), sequence = 0;
  const base = '/api/matter-preparation/matters/' + caseId;
  const stateFor = () => { const key = ownerId + ':' + caseId + ':' + kind; if (!drafts.has(key)) drafts.set(key, { dirty: false }); return drafts.get(key); };
  const alive = () => !disposed && !signal?.aborted;
  function report(message, error = false) { if (!alive()) return; feedback.textContent = message; feedback.dataset.error = String(error); feedback.setAttribute('role', error ? 'alert' : 'status'); }
  function citationList(citations = []) {
    if (!citations.length) return text('Added by the attorney.', 'lpc-connected-meta');
    const details = node('details', { className: 'lpc-connected-citations' }, [node('summary', { text: 'View source' })]);
    for (const citation of citations) {
      const label = [citation.name || 'Agreed instructions', citation.page ? 'page ' + citation.page : citation.section ? 'section ' + citation.section : ''].filter(Boolean).join(' · ');
      const heading = validId(citation.fileId) ? node('a', { href: matterHref(role, caseId, 'files') + (role === 'paralegal' ? '&' : '?') + 'fileId=' + citation.fileId, text: label }) : node('span', { text: label });
      details.append(node('div', {}, [heading, node('blockquote', { text: citation.quote })]));
    }
    return details;
  }
  function renderResult() {
    output.replaceChildren();
    const result = payload?.[kind]; if (!result) return;
    const state = stateFor();
    if (state.preparationId && state.preparationId !== result.id && (state.dirty || state.pendingAccept)) {
      output.append(node('h4', { text: 'Your earlier checklist edits' }), text('A newer preparation is available. Your earlier edits are retained here until you choose to review it.', 'lpc-connected-warning'), node('ol', { className: 'lpc-connected-checklist' }, state.items.map(item => node('li', { text: item.title }))));
      if (state.pendingAccept) output.append(button('Check saved checklist', async () => {
        if (busy) return; busy = true;
        try { const saved = await api.write(base + '/accept', state.pendingAccept); readAccepted(saved.preparation, state.pendingAccept); if (!alive()) return; state.dirty = false; state.pendingAccept = null; state.preparationId = null; await load(); report('The earlier checklist save was confirmed. The latest preparation is shown.'); }
        catch (error) { report(error.message, true); }
        finally { busy = false; }
      }));
      else output.append(button('Review latest preparation', async () => {
        const confirmed = await confirmAction('Discard these earlier checklist edits and review the latest preparation?', { title: 'Review latest preparation', confirmLabel: 'Review latest', cancelLabel: 'Keep my edits' });
        if (!confirmed || !alive()) return;
        state.dirty = false; state.preparationId = null; renderControls(); renderResult();
      }, true));
      return;
    }
    if (state.preparationId !== result.id || result.status === 'accepted') { state.preparationId = result.id; state.items = result.items.map((item, index) => ({ title: item.title, sourceIndex: index })); state.dirty = false; state.pendingAccept = null; }
    const accepted = result.status === 'accepted';
    output.append(node('div', { className: 'lpc-connected-result-heading' }, [node('h4', { text: kind === 'submission' ? 'Submission notes' : 'Working checklist' }), node('span', { className: 'lpc-connected-badge', text: result.stale ? 'Sources changed' : accepted ? 'Accepted by attorney' : 'For review' })]));
    if (result.stale) output.append(text('The agreed instructions or source documents changed. Prepare a fresh version before using these suggestions.', 'lpc-connected-warning'));
    if (kind === 'preparation') {
      const editable = role === 'attorney' && !accepted && !result.stale && !['queued', 'running'].includes(payload.activeJob?.status);
      const list = node('ol', { className: 'lpc-connected-checklist' });
      function drawItems(focusIndex) {
        list.replaceChildren(...state.items.map((item, index) => {
          const source = item.sourceIndex === null ? null : result.items[item.sourceIndex];
          const entry = node('li');
          if (editable) {
            const input = node('textarea', { rows: '2', maxlength: '400', 'aria-label': 'Working checklist item ' + (index + 1), 'data-working-item': index }); input.value = item.title;
            input.addEventListener('input', () => { item.title = input.value; state.dirty = true; });
            const remove = button('Remove', () => { state.items.splice(index, 1); state.dirty = true; drawItems(Math.min(index, state.items.length - 1)); }, true); remove.setAttribute('aria-label', 'Remove checklist item ' + (index + 1));
            const row = node('div', { className: 'lpc-connected-edit-row' }, [input, remove]); entry.append(row);
          } else entry.append(node('p', { text: item.title }));
          entry.append(citationList(source?.citations || [])); return entry;
        }));
        if (focusIndex !== undefined) list.querySelector('[data-working-item="' + focusIndex + '"]')?.focus();
      }
      drawItems(); list.inert = Boolean(state.pendingAccept); output.append(list);
      if (!state.items.length) output.append(text('No checklist items were supported by the selected sources. Review the questions below or add a working item.'));
      if (editable) {
        const add = button('Add working item', () => { if (state.pendingAccept || busy) return; if (state.items.length >= 30) return report('A working checklist can contain up to 30 items.', true); state.items.push({ title: '', sourceIndex: null }); state.dirty = true; drawItems(state.items.length - 1); }, true); add.disabled = Boolean(state.pendingAccept);
        const accept = button(state.pendingAccept ? 'Check saved checklist' : 'Accept working checklist', async () => {
          if (busy) return;
          if (!state.items.length || state.items.some(item => !item.title.trim())) { report('Give every working item a title before accepting it.', true); list.querySelector('textarea')?.focus(); return; }
          const body = state.pendingAccept || { preparationId: result.id, revision: result.revision, items: state.items.map(item => ({ title: item.title.trim(), sourceIndex: item.sourceIndex })), confirmed: true };
          state.pendingAccept = body; state.dirty = true; busy = true; accept.disabled = true; add.disabled = true; list.inert = true; report('Saving the reviewed checklist…');
          try { const saved = await api.write(base + '/accept', body); const accepted = readAccepted(saved.preparation, body); if (!alive()) return; payload.preparation = accepted; state.dirty = false; state.pendingAccept = null; state.preparationId = null; report('Working checklist accepted and saved.'); renderResult(); }
          catch (error) { if (alive()) { report(error.message, true); if (error.status && error.status < 500) state.pendingAccept = null; accept.textContent = state.pendingAccept ? 'Check saved checklist' : 'Accept working checklist'; } }
          finally { busy = false; if (alive()) { accept.disabled = false; add.disabled = Boolean(state.pendingAccept); list.inert = Boolean(state.pendingAccept); } }
        });
        output.append(node('div', { className: 'lpc-connected-actions' }, [add, accept]), text('Acceptance saves a working aid for this matter. Changes to the agreed scope follow the existing matter workflow.', 'lpc-connected-meta'));
      } else if (!accepted && role === 'paralegal') output.append(text('The attorney can edit and accept this working checklist.'));
    }
    for (const [key, title] of [['observations', 'Points to review'], ['questions', 'Questions to clarify']]) {
      const items = result[key] || []; if (!items.length) continue;
      output.append(node('h4', { text: title }), node('ul', { className: 'lpc-connected-evidence-list' }, items.map(item => node('li', {}, [node('p', { text: item.title }), citationList(item.citations)]))));
    }
    if (kind === 'submission' && !(result.observations?.length || result.questions?.length)) output.append(text('No source-supported issues were identified in the selected text. Review the original documents before making a submission decision.'));
    const coverage = node('details', { className: 'lpc-connected-coverage' }, [node('summary', { text: 'Reading coverage · ' + (result.files?.length || 0) + ' selected document' + (result.files?.length === 1 ? '' : 's') })]);
    coverage.append(text(result.coverageNotice || 'Reviewed the agreed instructions and readable text in the selected documents.'));
    for (const file of result.files || []) coverage.append(text(file.name + ' · version ' + file.version + ' · ' + file.sectionsRead + (file.totalSections ? ' of ' + file.totalSections : '') + ' sections read' + (file.readingMethod === 'text_and_ocr' ? ' · scanned text included' : '') + (file.unreadablePages?.length ? ' · unreadable pages: ' + file.unreadablePages.join(', ') : '') + (file.partial ? ' · scan returned partial results' : ''), 'lpc-connected-meta'));
    output.append(coverage);
  }
  function showJob(job) {
    clearTimeout(polling); progress.replaceChildren(); progress.hidden = !job;
    const priorStatus = payload?.activeJob?.status;
    if (payload) payload.activeJob = job;
    if (job && priorStatus !== job.status && ['failed', 'queued', 'running'].includes(job.status)) { renderControls(); renderResult(); }
    if (!job) return;
    if (job.status === 'failed') {
      progress.append(text(job.error || 'The preparation could not be completed.', 'lpc-connected-warning'));
      if (job.retryable) progress.append(button('Continue preparation', async () => { if (busy) return; busy = true; try { const result = await api.write(base + '/jobs/' + job.id + '/retry'); const saved = readJob(result.job, job.id); if (alive()) showJob(saved); } catch (error) { report(error.message, true); } finally { busy = false; } }, true));
      return;
    }
    if (job.status === 'complete') { progress.hidden = true; return; }
    const labels = { queued: 'Preparation queued', reading: 'Reading selected documents', ocr: 'Reading scanned pages', analyzing: 'Preparing source-linked suggestions' };
    progress.append(node('span', { className: 'lpc-connected-progress-dot', 'aria-hidden': 'true' }), node('div', {}, [node('strong', { text: labels[job.stage] || 'Preparing documents' }), text(job.totalFiles ? job.processedFiles + ' of ' + job.totalFiles + ' documents read. You can leave this page and return to the progress.' : 'Using the agreed instructions. You can return to this matter while preparation continues.', 'lpc-connected-meta')]));
    polling = setTimeout(async () => {
      if (!alive()) return;
      try { const result = await api.read(base + '/jobs/' + job.id); const saved = readJob(result.job, job.id); if (!alive()) return; if (saved.status === 'complete') await load(); else showJob(saved); }
      catch (error) { if (alive()) { progress.append(button('Check progress', () => void load(), true)); report(error.message, true); } }
    }, 2500);
  }
  function renderControls() {
    content.replaceChildren(); selected = new Set(stateFor().fileIds || []);
    if (!payload.aiConfigured) { content.append(text('Document intelligence is being connected. Your agreed work and documents are available here.')); return; }
    const tabs = node('div', { className: 'lpc-connected-segments', 'aria-label': 'Preparation type' });
    for (const [value, label] of [['preparation', 'Prepare work'], ['submission', 'Check submission']]) { const control = button(label, () => { if (busy) return; kind = value; root.dataset.mode = kind; renderControls(); renderResult(); }, true); control.setAttribute('aria-pressed', String(value === kind)); tabs.append(control); }
    const choose = node('details', { className: 'lpc-connected-source-picker' });
    const summary = node('summary'); const updateSummary = () => { summary.textContent = 'Select documents · ' + selected.size + ' selected'; }; updateSummary(); choose.append(summary);
    choose.append(text('The agreed instructions are always included. Choose up to eight documents.', 'lpc-connected-meta'));
    for (const file of payload.files || []) {
      const supported = /\.(?:pdf|docx?|txt)$/i.test(file.name || '');
      const safe = ['clean', 'not_required'].includes(file.securityStatus);
      const available = supported && safe && file.size <= 10 * 1024 * 1024;
      if (!available) selected.delete(file.id);
      const control = node('input', { type: 'checkbox', value: file.id, ...(selected.has(file.id) ? { checked: '' } : {}), ...(!available ? { disabled: '' } : {}) });
      control.addEventListener('change', () => { if (control.checked && selected.size >= 8) { control.checked = false; report('Select up to eight documents.', true); return; } control.checked ? selected.add(file.id) : selected.delete(file.id); stateFor().fileIds = [...selected]; stateFor().request = null; updateSummary(); });
      choose.append(node('label', { className: 'lpc-connected-source' }, [control, node('span', {}, [node('span', { text: file.name }), node('small', { text: !safe ? 'Available after security clearance' : !supported ? 'Use a PDF, Word, or text document' : file.size > 10 * 1024 * 1024 ? 'Exceeds the 10 MB reading limit' : 'Version ' + file.version })])]));
    }
    if (!payload.files?.length) choose.append(text('Add documents in Files when you want to include them.'));
    updateSummary(); choose.inert = Boolean(stateFor().request);
    const start = button(stateFor().request ? 'Check preparation' : kind === 'submission' ? 'Check submission' : 'Prepare work', async () => {
      if (busy) return;
      const state = stateFor();
      if (state.dirty && !state.request) { report('Accept your edited checklist before preparing another version, or reset the edits.', true); return; }
      const body = state.request || { fileIds: [...selected], kind, requestId: crypto.randomUUID() };
      state.request = body; busy = true; start.disabled = true; choose.inert = true; tabs.inert = true; output.inert = true; report('Starting preparation…');
      try { const result = await api.write(base + '/jobs', body); const job = readJob(result.job); if (!alive()) return; state.request = null; report(''); payload.activeJob = job; renderResult(); showJob(job); if (job.status === 'complete') await load(); }
      catch (error) { if (alive()) { report(error.message, true); start.textContent = 'Check preparation'; if (error.status && error.status < 500) state.request = null; } }
      finally { busy = false; if (alive()) { start.disabled = ['queued', 'running'].includes(payload.activeJob?.status); choose.inert = Boolean(state.request); tabs.inert = false; output.inert = false; } }
    });
    if (['queued', 'running'].includes(payload.activeJob?.status)) start.disabled = true;
    const actions = node('div', { className: 'lpc-connected-actions' }, [start]);
    if (role === 'attorney' && kind === 'preparation' && payload.preparation?.status === 'proposed') actions.append(button('Reset checklist edits', () => { const state = stateFor(); if (state.pendingAccept) return report('Check the saved checklist before resetting edits.', true); state.preparationId = null; state.dirty = false; renderControls(); renderResult(); }, true));
    content.append(tabs, choose, actions);
  }
  async function load() {
    const seq = ++sequence;
    try { const data = await api.read(base); if (!alive() || seq !== sequence) return;
      if (data.caseId !== caseId || data.role !== role || typeof data.aiConfigured !== 'boolean' || !Array.isArray(data.files) || data.files.some(file => !validId(file.id) || typeof file.name !== 'string')) throw new Error('The matter preparation view could not be confirmed. Please try again.');
      if (data.preparation) readPreparation(data.preparation, 'preparation'); if (data.submission) readPreparation(data.submission, 'submission'); if (data.activeJob) readJob(data.activeJob);
      payload = data; report(''); renderControls(); renderResult(); showJob(data.activeJob); }
    catch (error) { if (!alive() || seq !== sequence) return; report(error.message, true); content.replaceChildren(button('Try again', () => void load(), true)); }
  }
  root.readiness = load(); root.refresh = load;
  root.hasDrafts = () => [...drafts.values()].some(value => value.dirty || value.pendingAccept);
  root.dispose = () => { disposed = true; clearTimeout(polling); };
  signal?.addEventListener('abort', root.dispose, { once: true });
  return root;
}
