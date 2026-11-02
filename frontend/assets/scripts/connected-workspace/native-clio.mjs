import { node, button, link } from '../attorney-v2/dom.mjs';

const BASE = '/api/integrations/clio/';
const objectId = value => /^[a-f0-9]{24}$/i.test(String(value || ''));
const uuid = () => crypto.randomUUID();
const documentVersions = documents => documents.map(item => ({ id: String(item.id), versionId: String(item.versionId || ''), versionUuid: String(item.versionUuid || '') }));
function confirmedImport(result, count) {
  if (result?.status !== 'recorded' || !objectId(result.transferId) || !Array.isArray(result.files) || result.files.length !== count || !count || result.files.some(file => !objectId(file?.id) || !Number.isSafeInteger(file.version) || file.version < 1) || new Set(result.files.map(file => file.id)).size !== count) throw new Error('The document import could not be confirmed. Your selection is still here. Check the saved transfer before trying again.');
  return result;
}
function confirmedExport(result, fileId, clioMatterId) {
  if (result?.status !== 'recorded' || !objectId(result.transferId) || result.fileId !== fileId || String(result.clioMatterId) !== String(clioMatterId) || !/^[1-9][0-9]{0,18}$/.test(String(result.clioDocumentId || '')) || !Number.isSafeInteger(Number(result.clioDocumentId))) throw new Error('The document export could not be confirmed. Your selection is still here. Check the saved transfer before trying again.');
  return result;
}
const paragraph = (text, className = 'lc-clio-muted') => node('p', { className, text });
const actions = children => node('div', { className: 'lc-clio-actions' }, children);
const control = (label, fn, primary = false) => button(label, fn, primary ? 'av2-button lc-clio-primary' : 'av2-secondary lc-clio-secondary');
const sizeLabel = bytes => Number.isFinite(Number(bytes)) && Number(bytes) > 0 ? Number(bytes) >= 1048576 ? `${(Number(bytes) / 1048576).toFixed(1)} MB` : `${Math.ceil(Number(bytes) / 1024)} KB` : '';
const dateLabel = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date) : ''; };
function field(label, tag, attributes = {}) { const id = `lc-clio-${uuid()}`, input = node(tag, { id, ...attributes }); return { input, element: node('label', { className: 'lc-clio-field', for: id }, [node('span', { text: label }), input]) }; }
function errorMessage(error) { return typeof error?.message === 'string' && error.message !== 'The workspace request could not be completed.' ? error.message : 'Clio could not complete this request. Your selection is still here.'; }
function draftHref(value) { try { const url = new URL(value, location.origin); return url.origin === location.origin && url.pathname === '/attorney-v2.html' && /^#\/matters\/new\?draftId=[a-f0-9]{24}$/i.test(url.hash) ? url.pathname + url.hash : null; } catch { return null; } }

function createCore({ ownerId, api, signal }) {
  const root = node('section', { className: 'lc-clio' }), feedback = node('p', { className: 'lc-clio-feedback', role: 'status', 'aria-live': 'polite' });
  let connection = null, disposed = false, generation = 0;
  const dialogs = new Set(), identities = new Map(), drafts = new Map();
  const active = () => !disposed && !signal?.aborted;
  const operationId = key => { if (!identities.has(key)) identities.set(key, uuid()); return identities.get(key); };
  function message(text = '', error = false) { if (!active()) return; feedback.textContent = text; feedback.dataset.state = error ? 'error' : 'ready'; }
  function accessFailure(error) {
    if (error?.status === 401 || ['CLIO_ACCOUNT_CHANGED','ACCOUNT_CHANGED','CONNECTED_ACCOUNT_CHANGED'].includes(error?.code)) { dispose(); root.append(paragraph('Your account changed. Refresh LPC to continue.'), control('Refresh LPC', () => window.location.reload())); }
  }
  async function read(path) { try { const value = await api.read(path); if (!active()) throw new DOMException('The view closed.', 'AbortError'); return value; } catch (error) { accessFailure(error); throw error; } }
  async function status() {
    const value = await read(`${BASE}status`);
    if (value?.ownerId && String(value.ownerId) !== String(ownerId)) { const error = Object.assign(new Error('The signed-in account changed.'), { code: 'CLIO_ACCOUNT_CHANGED' }); accessFailure(error); throw error; }
    if (typeof value?.configured !== 'boolean' || typeof value?.connected !== 'boolean' || value.connected && (typeof value.connectionRevision !== 'string' || !value.connectionRevision)) throw new Error('The Clio connection could not be verified. Refresh its status.');
    connection = value; return value;
  }
  async function write(path, body = {}, method = 'POST') {
    if (!active()) throw new DOMException('The view closed.', 'AbortError');
    const isConnection = path === `${BASE}connect` || path === `${BASE}connection`;
    let value; try { value = await api.write(path, { ...body, expectedOwnerId: String(ownerId), ...(!isConnection ? { expectedConnectionRevision: connection?.connectionRevision } : {}) }, method); } catch (error) { accessFailure(error); throw error; }
    if (!active()) throw new DOMException('The view closed.', 'AbortError'); return value;
  }
  function modal(title, launcher) {
    const heading = node('h2', { id: `lc-clio-heading-${uuid()}`, text: title, tabindex: '-1' }), close = control('Close', () => dialog.close());
    close.classList.add('lc-clio-close'); close.setAttribute('aria-label', `Close ${title.toLowerCase()}`);
    const body = node('div', { className: 'lc-clio-dialog-body' }), footer = node('div', { className: 'lc-clio-dialog-footer' }), error = node('p', { role: 'status', className: 'lc-clio-feedback' });
    const dialog = node('dialog', { className: 'lc-clio-dialog', 'aria-labelledby': heading.id }, [node('header', { className: 'lc-clio-dialog-header' }, [heading, close]), body, error, footer]);
    document.body.append(dialog); dialogs.add(dialog); dialog.showModal(); heading.focus();
    let busy = false, closed = false;
    const live = () => active() && !closed;
    const setError = value => { if (live()) { error.textContent = value; error.dataset.state = 'error'; } };
    async function operate(label, work) {
      if (busy || !live()) return; busy = true; dialog.setAttribute('aria-busy', 'true'); error.textContent = label;
      const states = [...dialog.querySelectorAll('button,input,textarea,select')].map(element => [element, element.disabled]);
      for (const [element] of states) if (element !== close) element.disabled = true;
      try { await work(); } catch (failure) { if (failure.name !== 'AbortError') setError(errorMessage(failure)); }
      finally { busy = false; if (live()) { dialog.setAttribute('aria-busy', 'false'); for (const [element, disabled] of states) if (element.isConnected) element.disabled = disabled; if (error.textContent === label) error.textContent = ''; } }
    }
    dialog.addEventListener('close', () => { closed = true; dialogs.delete(dialog); dialog.remove(); if (active() && launcher?.isConnected) launcher.focus(); }, { once: true });
    return { body, footer, error, dialog, live, operate, setError, close: () => dialog.close(), step(text) { if (!live()) return; error.textContent = ''; body.dataset.step = text; }, focus() { heading.focus(); } };
  }
  const dispose = () => { disposed = true; generation++; identities.clear(); drafts.clear(); for (const dialog of dialogs) dialog.close(); dialogs.clear(); root.replaceChildren(); connection = null; };
  signal?.addEventListener('abort', dispose, { once: true });
  return { root, feedback, active, read, write, status, message, modal, operationId, dispose, getDraft: key => drafts.get(key), setDraft: (key, value) => value ? drafts.set(key, value) : drafts.delete(key), get connection() { return connection; }, nextGeneration() { return ++generation; }, isGeneration(value) { return generation === value && active(); } };
}

function connectionHeading(connection) {
  const state = connection.connected ? 'Connected' : connection.needsReconnect ? 'Reconnect required' : 'Not connected';
  return node('div', { className: 'lc-clio-heading' }, [node('div', { className: 'lc-clio-brand-lockup' }, [clioWordmark('h2'), paragraph('Clio Manage · United States')]), node('span', { className: `lc-clio-state${connection.connected ? ' is-connected' : ''}`, text: state })]);
}
function clioWordmark(tag = 'span') {
  return node(tag, { className: 'lc-clio-wordmark', 'aria-label': 'Clio' }, [node('span', { className: 'lc-clio-symbol', 'aria-hidden': 'true' }), node('span', { className: 'lc-clio-logotype', 'aria-hidden': 'true' })]);
}
function connectButton(core, { caseId, onBeforeNavigate } = {}) {
  return control(core.connection?.needsReconnect ? 'Reconnect Clio' : 'Connect Clio', async event => {
    const launcher = event.currentTarget; if (launcher.disabled) return; launcher.disabled = true; core.message('Opening Clio…');
    try {
      const result = await core.write(`${BASE}connect`, objectId(caseId) ? { returnCaseId: caseId } : {});
      const destination = new URL(result.authorizationUrl);
      if (destination.origin !== 'https://app.clio.com' || destination.pathname !== '/oauth/authorize') throw new Error('Clio returned an invalid connection link.');
      if (core.active()) { onBeforeNavigate?.(); window.location.assign(destination.href); }
    } catch (error) { if (error.name !== 'AbortError') core.message(errorMessage(error), true); if (core.active()) launcher.disabled = false; }
  }, true);
}

function renderMatterPicker(core, modal, onSelect, { back, initialQuery = '' } = {}) {
  modal.step('matter');
  const search = field('Search Clio matters', 'input', { type: 'search', maxlength: '200', placeholder: 'Matter number or description' }); search.input.value = initialQuery;
  const find = control('Search', () => form.requestSubmit()), form = node('form', { className: 'lc-clio-search' }, [search.element, find]);
  const list = node('div', { className: 'lc-clio-matter-list', 'data-clio-matter-list': '' }), status = paragraph('Loading matters…'); status.setAttribute('role', 'status');
  const more = control('Load more matters', () => void load(true)); more.hidden = true;
  modal.body.replaceChildren(paragraph('Choose the private Clio matter to work from.'), form, status, list, more);
  modal.footer.replaceChildren(...(back ? [control('Back', back)] : []), control('Cancel', modal.close));
  let cursor = null, query = initialQuery, generation = 0, busy = false, items = [];
  async function load(append = false) {
    if (!modal.live() || busy) return; busy = true; const ticket = ++generation; status.textContent = append ? 'Loading more matters…' : 'Loading matters…'; find.disabled = true; more.disabled = true;
    if (!append) { list.replaceChildren(); items = []; cursor = null; }
    try {
      const params = new URLSearchParams(); if (query) params.set('q', query); if (append && cursor) params.set('cursor', cursor);
      const result = await core.read(`${BASE}matters${params.size ? `?${params}` : ''}`); if (!modal.live() || ticket !== generation) return;
      if (!Array.isArray(result.items)) throw new Error('The Clio matter list could not be read.');
      items = append ? [...items, ...result.items] : result.items; cursor = result.nextCursor || null;
      list.replaceChildren(...items.map(item => {
        const row = control('', () => onSelect(item)); row.className = 'lc-clio-matter-row'; row.dataset.clioMatterChoice = String(item.id);
        row.append(node('span', {}, [node('strong', { text: item.label || `Clio matter ${item.id}` }), ...(item.description ? [node('span', { text: String(item.description).slice(0,160) })] : [])]), node('span', { className: 'lc-clio-row-arrow', 'aria-hidden': 'true', text: '›' })); return row;
      }));
      status.textContent = items.length ? '' : query ? 'No matters match this search.' : 'No accessible matters were found in Clio.'; more.hidden = !cursor;
    } catch (error) {
      if (modal.live() && error.name !== 'AbortError') { status.textContent = errorMessage(error); list.querySelector('[data-clio-retry]')?.remove(); const retry = control('Try again', () => void load(append)); retry.dataset.clioRetry = ''; list.append(retry); }
    } finally { busy = false; if (modal.live()) { find.disabled = false; more.disabled = false; } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); if (busy) return; query = search.input.value.trim(); void load(); });
  void load();
}

function renderDocumentStep(core, modal, source, { publicBrief, selected = new Set(), brief = {}, onBack, onReview } = {}) {
  modal.step('documents'); const documents = [], choices = node('fieldset', { className: 'lc-clio-document-list', 'data-clio-document-list': '' }, [node('legend', { text: 'Documents to share' })]);
  const count = paragraph('Nothing selected'), status = paragraph('Loading documents…'), more = control('Load more documents', () => void load()); more.hidden = true;
  const content = [node('div', { className: 'lc-clio-source' }, [node('span', { text: 'Private Clio source' }), node('strong', { text: source.label || `Clio matter ${source.id}` })]), choices, count, status, more];
  const title = field('Work title', 'input', { maxlength: '300', required: '' }), description = field('Work description', 'textarea', { rows: '4', maxlength: '4000', minlength: '10', required: '' }), deliverables = field('Deliverables · one per line', 'textarea', { rows: '3', maxlength: '5025' });
  title.input.value = brief.title || ''; description.input.value = brief.description || ''; deliverables.input.value = (brief.tasks || []).join('\n');
  if (publicBrief) content.push(node('section', { className: 'lc-clio-public-brief' }, [node('h3', { text: 'Work to post on LPC' }), paragraph('Describe the assignment without private client details.'), title.element, description.element, deliverables.element]));
  const form = node('form', { className: 'lc-clio-selection-form' }, content), next = control('Review selection', () => form.requestSubmit(), true);
  modal.body.replaceChildren(form); modal.footer.replaceChildren(control('Back', () => { remember(); onBack?.(); }), next);
  let cursor = null, busy = false;
  const remember = () => Object.assign(brief, { title: title.input.value.trim(), description: description.input.value.trim(), tasks: deliverables.input.value.split('\n').map(value => value.trim()).filter(Boolean) });
  form.addEventListener('input', remember);
  function updateCount() { count.textContent = `${selected.size} ${selected.size === 1 ? 'document' : 'documents'} selected${publicBrief ? ' · Available after hiring and funding' : ''}`; next.disabled = busy || !publicBrief && !selected.size; }
  function addRows(rows) {
    for (const item of rows) {
      if (documents.some(value => value.id === item.id)) continue; documents.push(item);
      const available = item.ready !== false && !(Number(item.size) > 20 * 1048576), box = node('input', { type: 'checkbox', value: item.id, 'data-clio-document-choice': item.id }); box.checked = selected.has(item.id); box.disabled = !available;
      box.addEventListener('change', () => { if (box.checked && selected.size >= 10) { box.checked = false; modal.setError('Choose up to ten documents for one transfer.'); return; } if (box.checked) selected.add(item.id); else selected.delete(item.id); updateCount(); });
      choices.append(node('label', { className: 'lc-clio-document-row' }, [box, node('span', {}, [node('strong', { text: item.name || 'Document' }), node('small', { text: available ? [sizeLabel(item.size), item.versionId ? `Version ${item.versionId}` : ''].filter(Boolean).join(' · ') : Number(item.size) > 20 * 1048576 ? 'Over the 20 MB transfer limit' : 'Still processing in Clio' })])]));
    }
  }
  async function load() {
    if (busy || !modal.live()) return; busy = true; updateCount(); more.disabled = true;
    try { const result = await core.read(`${BASE}matters/${encodeURIComponent(source.id)}/documents${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); if (!modal.live() || modal.body.dataset.step !== 'documents') return;
      if (!Array.isArray(result.items)) throw new Error('The Clio document list could not be read.'); addRows(result.items); cursor = result.nextCursor || null; more.textContent = 'Load more documents'; more.hidden = !cursor; status.textContent = documents.length ? '' : 'No documents are available in this Clio matter.';
    } catch (error) { if (modal.live() && error.name !== 'AbortError') { status.textContent = errorMessage(error); more.textContent = 'Try again'; more.hidden = false; } }
    finally { busy = false; if (modal.live()) { updateCount(); more.disabled = false; } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); remember(); if (!publicBrief && !selected.size) { modal.setError('Select at least one document.'); return; } if (brief.tasks.some(task => task.length > 200) || brief.tasks.length > 25) { modal.setError('Use up to 25 deliverables, each no more than 200 characters.'); return; } const chosen = documents.filter(item => selected.has(item.id)); if (chosen.length !== selected.size) { modal.setError('A selected document could not be verified. Refresh the selection.'); return; } onReview({ source, documents: chosen, brief, selected }); });
  updateCount(); void load();
}
function reviewBlock(label, value) { return node('div', { className: 'lc-clio-review-block' }, [node('span', { text: label }), node('strong', { text: value })]); }
function documentReview(documents) { return node('ul', { className: 'lc-clio-review-documents' }, documents.map(item => node('li', {}, [node('span', { text: item.name || 'Document' }), node('small', { text: sizeLabel(item.size) })]))); }

function startHandoff(core, launcher, sourcePreset) {
  const modal = core.modal('Start from Clio', launcher), state = sourcePreset ? { selected: new Set(), brief: {} } : core.getDraft('posting') || { selected: new Set(), brief: {} }; core.setDraft('posting', state);
  const choose = source => { if (state.source?.id !== source.id) state.selected.clear(); state.source = source; renderDocuments(); };
  const pick = () => renderMatterPicker(core, modal, choose);
  function renderDocuments() { renderDocumentStep(core, modal, state.source, { publicBrief: true, selected: state.selected, brief: state.brief, onBack: pick, onReview: review }); }
  function review(value) {
    modal.step('review'); const summary = node('div', { className: 'lc-clio-review' }, [reviewBlock('Private Clio source', value.source.label || `Clio matter ${value.source.id}`), reviewBlock('Public work title', value.brief.title), paragraph(value.brief.description, 'lc-clio-review-description'), ...(value.brief.tasks.length ? [node('ul', {}, value.brief.tasks.map(text => node('li', { text })))] : []), node('h3', { text: `${value.documents.length} ${value.documents.length === 1 ? 'document' : 'documents'} selected` }), documentReview(value.documents), paragraph('Documents stay private and can be imported after the LPC matter is hired and funded.')]);
    const confirm = control('Continue to posting', () => void modal.operate('Preparing your draft…', async () => {
      const publicWorkBrief = { title: value.brief.title, description: value.brief.description, tasks: value.brief.tasks };
      const body = { clioMatterId: String(value.source.id), documentIds: value.documents.map(item => item.id), expectedDocuments: documentVersions(value.documents), publicWorkBrief, publicBriefConfirmed: true, confirmed: true, requestId: core.operationId(JSON.stringify(['handoff', value.source.id, documentVersions(value.documents), publicWorkBrief])) };
      const result = await core.write(`${BASE}handoffs`, body), href = draftHref(result.href);
      if (!href || !objectId(result.handoffId) || !objectId(result.draftId) || !href.endsWith(`draftId=${result.draftId}`)) throw new Error('The posting draft could not be confirmed. Your reviewed work is still here.');
      if (core.active()) {
        core.setDraft('posting', null);
        if (modal.live()) { modal.close(); window.location.assign(href); }
        else { core.message('Your posting draft is ready. '); core.feedback.append(link('Open posting draft', href)); }
      }
    }), true);
    modal.body.replaceChildren(summary); modal.footer.replaceChildren(control('Back', renderDocuments), confirm); modal.focus();
  }
  if (sourcePreset) choose(sourcePreset); else if (state.source) renderDocuments(); else pick(); return modal;
}

export function createClioConnection({ ownerId, api, signal, route } = {}) {
  const core = createCore({ ownerId, api, signal }), card = core.root; card.dataset.nativeClioConnection = '';
  const body = node('div'), refresh = control('Refresh connection', () => { card.readiness = load(); }); refresh.classList.add('lc-clio-refresh');
  const initialQuery = new URLSearchParams(route?.query || location.hash.split('?')[1] || '');
  let actionContext = ['custom_action_nonce','subject_url','user_id'].every(key => initialQuery.has(key)) ? Object.fromEntries(['custom_action_nonce','subject_url','user_id'].map(key => [key, initialQuery.get(key)])) : null;
  let actionState = 'idle';
  // The one-use nonce stays in this account-scoped view's memory only. It must
  // not persist in the address bar, history entries or copied page links.
  const currentHash = location.hash, split = currentHash.indexOf('?');
  if (currentHash.startsWith('#/settings') && split >= 0) { const query = new URLSearchParams(currentHash.slice(split + 1)); let changed = false; for (const key of ['custom_action_nonce','subject_url','user_id','custom_action_id']) { if (query.has(key)) changed = true; query.delete(key); } if (changed) history.replaceState(history.state, '', `${location.pathname}${location.search}${currentHash.slice(0,split)}${query.size ? `?${query}` : ''}`); }
  signal?.addEventListener('abort', () => { actionContext = null; }, { once: true });
  function recoveryAction() {
    return control('Recover selected matter', async event => {
      if (!actionContext) return; const launcher = event.currentTarget; launcher.disabled = true;
      const match = /^\/api\/v4\/matters\/([1-9][0-9]{0,18})(?:\.json)?$/.exec(actionContext.subject_url);
      if (!match) { core.message('Select the Clio matter again using Start from Clio.', true); launcher.disabled = false; return; }
      try { const query = new URLSearchParams({ expectedUserId: actionContext.user_id, expectedConnectionRevision: core.connection.connectionRevision }); const result = await core.read(`${BASE}matters/${match[1]}/context?${query}`); actionState = 'resolved'; actionContext = null; core.message(''); startHandoff(core, launcher, result.matter); }
      catch (error) { if (error.name !== 'AbortError') core.message(errorMessage(error), true); if (core.active()) launcher.disabled = false; }
    });
  }
  async function load() {
    const generation = core.nextGeneration(); body.replaceChildren(paragraph('Checking Clio connection…')); card.setAttribute('aria-busy', 'true');
    try {
      const connection = await core.status(); if (!core.isGeneration(generation)) return;
      const heading = connectionHeading(connection), content = node('div', { className: 'lc-clio-connection-body' });
      if (!connection.configured) content.append(paragraph('Clio connections are currently unavailable. You can keep working in LPC.'));
      else if (!connection.connected) content.append(paragraph(connection.needsReconnect ? 'Reconnect your account to resume selected matter and document transfers.' : 'Bring selected matters and documents into LPC. Return approved work to the right Clio matter.'), actions([connectButton(core)]));
      else {
        const start = control('Start from Clio', event => startHandoff(core, event.currentTarget), true);
        const menu = node('details', { className: 'lc-clio-options' }, [node('summary', { text: 'Connection options' })]);
        const add = control('Add LPC action in Clio', async () => { add.disabled = true; core.message('Adding the LPC action…'); try { const result = await core.write(`${BASE}custom-action`); core.message(result.replayed ? 'The LPC action is already available in Clio.' : 'The LPC action is now available in Clio.'); } catch (error) { if (error.name !== 'AbortError') core.message(errorMessage(error), true); if (core.active()) add.disabled = false; } });
        const disconnect = control('Disconnect Clio', event => { const modal = core.modal('Disconnect Clio?', event.currentTarget); modal.body.append(paragraph('New transfers will stop. Your LPC matters and files stay available.')); modal.footer.append(control('Keep connected', modal.close), control('Disconnect', () => void modal.operate('Disconnecting…', async () => { const result = await core.write(`${BASE}connection`, {}, 'DELETE'); modal.close(); await load(); core.message(result.revokeRefreshTokenInClio ? 'Disconnected from LPC. To remove the remaining Clio grant, remove LPC in your Clio application settings.' : 'Clio disconnected.'); }))); });
        menu.append(add, disconnect); content.append(paragraph('Choose what to share on each matter. Your other Clio information stays in Clio.'), actions([start, menu]));
      }
      body.replaceChildren(heading, content);
      if (connection.connected && actionContext && actionState === 'idle') {
        actionState = 'pending';
        try { const result = await core.write(`${BASE}action-context`, actionContext); if (core.active()) { actionState = 'resolved'; actionContext = null; startHandoff(core, body.querySelector('button'), result.matter); } }
        catch (error) { if (error.name !== 'AbortError' && core.active()) { actionState = 'uncertain'; core.message('The Clio action could not be confirmed. Recover the selected matter or choose it again.', true); body.append(recoveryAction()); } }
      }
      else if (connection.connected && actionContext && actionState === 'uncertain') body.append(recoveryAction());
    } catch (error) { if (core.active() && error.name !== 'AbortError') { body.replaceChildren(paragraph('The connection status could not be loaded.')); core.message(errorMessage(error), true); } }
    finally { if (core.active()) card.setAttribute('aria-busy', 'false'); }
  }
  card.append(body, core.feedback, refresh); card.readiness = load(); card.refresh = load; card.dispose = core.dispose; return card;
}

export function createClioMatterTransfers({ caseId, ownerId, api, signal, files, onFilesChanged, readOnly = false } = {}) {
  const core = createCore({ ownerId, api, signal }), card = core.root; card.dataset.nativeClioTransfers = '';
  const body = node('div'), receipts = node('div', { className: 'lc-clio-receipts', 'data-clio-transfer-receipts': '' });
  let handoffs = [], recorded = [], currentFiles = [], busy = false, currentAssignment = '';
  signal?.addEventListener('abort', () => { handoffs = []; recorded = []; currentFiles = []; }, { once: true });
  const isReadOnly = () => typeof readOnly === 'function' ? Boolean(readOnly()) : Boolean(readOnly);
  const refresh = control('Refresh transfers', () => { card.readiness = load(); }); refresh.classList.add('lc-clio-refresh');
  const loadFiles = async () => { const value = typeof files === 'function' ? await files() : files; if (Array.isArray(value)) return value; const result = await core.read(`/api/matter-preparation/matters/${caseId}`); return Array.isArray(result.files) ? result.files : []; };
  async function changed() { if (core.active()) { await onFilesChanged?.(); if (core.active()) await load(); } }
  function renderReceipts() {
    receipts.replaceChildren();
    if (!recorded.length) return;
    receipts.append(node('h3', { text: 'Recent transfers' }));
    for (const receipt of recorded) {
      const completed = receipt.status === 'recorded', direction = receipt.direction === 'import' ? 'Imported from Clio' : 'Sent to Clio', state = completed ? direction : receipt.status === 'uncertain' ? 'Needs confirmation' : 'In progress';
      const row = node('div', { className: 'lc-clio-receipt', 'data-clio-transfer-id': receipt.id }, [node('div', {}, [node('strong', { text: receipt.fileName || `${receipt.documentCount || 0} ${receipt.documentCount === 1 ? 'document' : 'documents'}` }), paragraph([receipt.label, dateLabel(receipt.updatedAt || receipt.createdAt)].filter(Boolean).join(' · '))]), node('span', { className: `lc-clio-receipt-status${completed ? ' is-complete' : ''}`, text: state })]);
      if (!isReadOnly() && core.connection?.connected && !completed && receipt.retry) row.append(control('Check transfer', event => {
        const expected = `${BASE}matters/${caseId}/${receipt.direction}`;
        if (!['import','export'].includes(receipt.direction) || receipt.retry.path !== expected || !receipt.retry.body || typeof receipt.retry.body !== 'object') { core.message('This saved transfer could not be verified. Refresh its status.', true); return; }
        const modal = core.modal('Check saved transfer', event.currentTarget); modal.body.append(reviewBlock(receipt.direction === 'import' ? 'Source Clio matter' : 'Destination Clio matter', receipt.label), paragraph(receipt.fileName || `${receipt.documentCount || 0} selected documents`), paragraph('This checks the same saved transfer and preserves its original document and destination.'));
        modal.footer.append(control('Cancel', modal.close), control('Check transfer', () => void modal.operate('Checking saved transfer…', async () => {
          core.message('');
          try { const result = await core.write(expected, { ...receipt.retry.body, confirmed: true }); if (receipt.direction === 'import') confirmedImport(result, receipt.retry.body.documentIds?.length || 0); else confirmedExport(result, receipt.retry.body.fileId, receipt.retry.body.clioMatterId); }
          catch (error) { await load(); throw error; }
          modal.close(); core.message('Transfer confirmed.'); await changed();
        }), true));
      }));
      receipts.append(row);
    }
  }
  function importWizard(launcher, savedHandoff) {
    const modal = core.modal('Import from Clio', launcher), state = { selected: new Set() };
    function choose(source) { state.source = source; state.selected.clear(); renderDocuments(); }
    const pick = () => renderMatterPicker(core, modal, choose);
    function renderDocuments() { renderDocumentStep(core, modal, state.source, { selected: state.selected, onBack: pick, onReview: review }); }
    function review(value) {
      modal.step('review'); modal.body.replaceChildren(reviewBlock('Source Clio matter', value.source.label || `Clio matter ${value.source.id}`), node('h3', { text: `${value.documents.length} selected ${value.documents.length === 1 ? 'document' : 'documents'}` }), documentReview(value.documents), paragraph('These files will be shared in this LPC matter. Each file must pass the normal security check before it can be opened.'));
      modal.footer.replaceChildren(control('Back', savedHandoff ? modal.close : renderDocuments), control('Import selected documents', () => void modal.operate('Importing selected documents…', async () => {
        core.message('');
        const ids = value.documents.map(item => item.id);
        const handoff = savedHandoff || await core.write(`${BASE}matters/${caseId}/handoffs`, { clioMatterId: String(value.source.id), documentIds: ids, expectedDocuments: documentVersions(value.documents), confirmed: true, requestId: core.operationId(JSON.stringify(['matter-handoff', caseId, currentAssignment, value.source.id, documentVersions(value.documents)])) });
        if (!objectId(handoff?.handoffId) || !savedHandoff && handoff.caseId !== caseId) throw new Error('The selected source documents could not be confirmed. Your selection is still here.');
        try { confirmedImport(await core.write(`${BASE}matters/${caseId}/import`, { handoffId: handoff.handoffId, documentIds: ids, confirmed: true, requestId: core.operationId(JSON.stringify(['import', caseId, currentAssignment, handoff.handoffId, ids])) }), ids.length); }
        catch (error) { await load(); throw error; }
        modal.close(); core.message('Documents imported. Security status is shown in Files.'); await changed();
      }), true)); modal.focus();
    }
    if (savedHandoff) review({ source: { id: savedHandoff.clioMatterId, label: savedHandoff.label }, documents: savedHandoff.documents || [] }); else pick();
  }
  function exportWizard(launcher) {
    const modal = core.modal('Send to Clio', launcher), approved = currentFiles.filter(file => file.status === 'approved' && ['clean','not_required'].includes(file.securityStatus)); let chosen = null;
    function chooseFile() {
      modal.step('document'); const fieldset = node('fieldset', { className: 'lc-clio-document-list' }, [node('legend', { text: 'Approved document' })]);
      for (const file of approved) { const radio = node('input', { type: 'radio', name: 'clio-approved-file', value: file.id, 'data-clio-export-file': file.id }); radio.checked = chosen?.id === file.id; radio.addEventListener('change', () => { chosen = file; next.disabled = false; }); fieldset.append(node('label', { className: 'lc-clio-document-row' }, [radio, node('span', {}, [node('strong', { text: file.name || file.originalName || 'Document' }), node('small', { text: `Version ${file.version || 1} · Approved` })])])); }
      const next = control('Choose destination', () => renderMatterPicker(core, modal, review, { back: chooseFile }), true); next.disabled = !chosen;
      modal.body.replaceChildren(paragraph('Choose the approved document to return to Clio.'), fieldset); if (!approved.length) modal.body.append(paragraph('Approve a document in Files before sending it to Clio.'));
      modal.footer.replaceChildren(control('Cancel', modal.close), next);
    }
    function review(destination) {
      modal.step('review'); modal.body.replaceChildren(reviewBlock('Approved document', chosen.name || chosen.originalName || 'Document'), paragraph(`Version ${chosen.version || 1}`), reviewBlock('Destination Clio matter', destination.label || `Clio matter ${destination.id}`), paragraph('Only this approved document will be sent to the selected Clio matter.'));
      modal.footer.replaceChildren(control('Back', () => renderMatterPicker(core, modal, review, { back: chooseFile })), control('Send approved document', () => void modal.operate('Sending approved document…', async () => {
        core.message('');
        try { confirmedExport(await core.write(`${BASE}matters/${caseId}/export`, { fileId: chosen.id, expectedFileVersion: Number(chosen.version || 1), clioMatterId: String(destination.id), confirmed: true, requestId: core.operationId(JSON.stringify(['export', caseId, chosen.id, chosen.version, destination.id])) }), chosen.id, String(destination.id)); }
        catch (error) { await load(); throw error; }
        modal.close(); core.message('The approved document was sent to Clio.'); await load();
      }), true)); modal.focus();
    }
    chooseFile();
  }
  async function load() {
    if (busy || !core.active()) return; busy = true; const generation = core.nextGeneration(); card.setAttribute('aria-busy','true');
    try {
      const [connection, history] = await Promise.all([core.status(), core.read(`${BASE}transfers?caseId=${caseId}`)]); if (!core.isGeneration(generation)) return;
      if (!Array.isArray(history.items)) throw new Error('The saved Clio transfers could not be read.'); recorded = history.items; currentAssignment = typeof history.assignmentRevision === 'string' ? history.assignmentRevision : '';
      body.replaceChildren(node('div', { className: 'lc-clio-transfer-heading' }, [clioWordmark('h3'), node('span', { className: `lc-clio-state${connection.connected ? ' is-connected' : ''}`, text: connection.connected ? 'Connected' : 'Not connected' })]));
      if (!connection.configured) { body.append(paragraph('Clio transfers are currently unavailable.')); renderReceipts(); return; }
      if (!connection.connected) { body.append(paragraph('Connect Clio to bring selected documents into this matter and return approved work.'), connectButton(core, { caseId })); renderReceipts(); return; }
      const [sources, available] = await Promise.all([core.read(`${BASE}handoffs?caseId=${caseId}`), isReadOnly() ? Promise.resolve([]) : loadFiles()]);
      if (!core.isGeneration(generation)) return;
      if (!Array.isArray(sources.items)) throw new Error('The saved Clio document selections could not be read.');
      handoffs = sources.items; currentFiles = available;
      if (!isReadOnly()) {
        const send = control('Send to Clio', event => exportWizard(event.currentTarget)); send.disabled = !currentFiles.some(file => file.status === 'approved' && ['clean','not_required'].includes(file.securityStatus));
        body.append(paragraph('Bring in selected source documents or return approved work.'), actions([control('Import documents', event => importWizard(event.currentTarget), true), send]));
        if (send.disabled) body.append(paragraph('Approve a document in Files before sending it to Clio.'));
      }
      else body.append(paragraph('This matter is read only. Its saved transfer history remains available.'));
      const transferredIds = new Set(recorded.filter(receipt => !currentAssignment || receipt.assignmentRevision === currentAssignment).map(receipt => receipt.handoffId).filter(Boolean));
      const pending = handoffs.filter(item => !transferredIds.has(item.handoffId) && item.documents?.length);
      if (!isReadOnly() && pending.length) body.append(node('details', { className: 'lc-clio-saved-selections' }, [node('summary', { text: `${pending.length} saved ${pending.length === 1 ? 'document selection' : 'document selections'}` }), ...pending.map(handoff => control(`${handoff.label} · ${handoff.documents.length} ${handoff.documents.length === 1 ? 'document' : 'documents'}`, event => importWizard(event.currentTarget, handoff)))]));
      renderReceipts();
    } catch (error) { if (core.active() && error.name !== 'AbortError') { core.message(errorMessage(error), true); body.replaceChildren(node('h3', { text: 'Clio' }), paragraph('Transfer status could not be loaded.')); receipts.replaceChildren(); } }
    finally { busy = false; if (core.active()) card.setAttribute('aria-busy','false'); }
  }
  if (!objectId(caseId)) { body.append(paragraph('Select a matter to view Clio transfers.')); card.readiness = Promise.resolve(); }
  else { body.append(paragraph('Checking Clio transfers…')); card.readiness = load(); }
  card.append(body, core.feedback, receipts, refresh); card.refresh = load; card.dispose = core.dispose; return card;
}
