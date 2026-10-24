import { activateDialogFocus, deactivateDialogFocus } from './dialog-focus.js';
const validId = value => /^[a-f0-9]{24}$/i.test(String(value || ''));
const count = value => { if (!Number.isSafeInteger(value) || value < 0) invalid(); return value; };
const array = value => { if (!Array.isArray(value)) invalid(); return value; };
function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') element.textContent = String(value);
    else if (key === 'className') element.className = value;
    else element.setAttribute(key, String(value));
  }
  children.forEach(child => element.append(child));
  return element;
}

let sequence = 0;
const invalid = () => { throw new TypeError('Matter choices could not be verified.'); };
export function readMatterChoices(value, ownerId, filters) {
  if (!validId(ownerId) || value?.ownerId !== ownerId || !/^[a-f0-9]{64}$/.test(value.revision || '') || ['search', 'page', 'selectedId'].some(key => value.filters?.[key] !== filters[key])) invalid();
  const total = count(value.total), page = count(value.page), pages = count(value.pages), items = array(value.items);
  if (page !== filters.page || value.pageSize !== 10 || pages !== Math.max(1, Math.ceil(total / 10)) || items.length !== Math.min(10, Math.max(0, total - (page - 1) * 10))) invalid();
  const valid = item => validId(item?.id) && ['title', 'status', 'practiceArea'].every(key => typeof item[key] === 'string') && typeof item.archived === 'boolean';
  if (items.some(item => !valid(item)) || new Set(items.map(item => item.id)).size !== items.length || value.selected !== null && (!valid(value.selected) || value.selected.id !== filters.selectedId)) invalid();
  return { total, page, pages, items, selected: value.selected };
}

export function createMatterPicker({ label, emptyLabel = 'No Matter', value = '', ownerId, api, signal,
  endpoint, classPrefix, formatStatus, triggerLabel = '', allowClear = true, currentId = '',
  dialogTitle = 'Choose a Matter', searchLabelText = 'Search Matters', emptyMessage = 'No Matters to choose from.', scrollResults = false }) {
  const css = name => `${classPrefix}-${name}`;
  const button = (text, action, className = css('secondary')) => {
    const control = node('button', { type: 'button', text, className });
    control.addEventListener('click', action); return control;
  };
  const key = `lpc-matter-picker-${++sequence}`;
  const input = node('input', { type: 'hidden', value: validId(value) ? value : '' });
  const selectedName = node('span', { id: `${key}-selected`, text: triggerLabel || (input.value ? 'Selected Matter' : emptyLabel) });
  const open = button('', () => show(), `${css('secondary')} ${css('matter-picker-button')}`); open.append(selectedName);
  open.setAttribute('aria-labelledby', triggerLabel ? `${key}-selected` : `${key}-label ${key}-selected`); open.setAttribute('aria-haspopup', 'dialog'); open.setAttribute('aria-expanded', 'false'); open.setAttribute('aria-controls', `${key}-dialog`);
  const selectionStatus = node('p', { className: css('muted'), role: 'status' }); selectionStatus.hidden = true;
  const selectionMessage = text => { selectionStatus.textContent = text; selectionStatus.hidden = !text; };
  const root = node('div', { className: css('field'), 'data-matter-picker': key }, [...(!triggerLabel ? [node('span', { id: `${key}-label`, text: label })] : []), input, open, selectionStatus]);
  const dialog = node('dialog', { id: `${key}-dialog`, className: css('matter-choice-dialog'), 'aria-labelledby': `${key}-title` });
  const close = button('Close', () => dismiss());
  const search = node('input', { id: `${key}-search`, type: 'search', maxlength: 200, autocomplete: 'off' });
  const searchLabel = node('label', { className: css('field'), for: `${key}-search` }, [node('span', { text: searchLabelText }), search]);
  const status = node('p', { className: css('muted'), role: 'status', tabindex: '-1' });
  const results = node('ul', { className: css('matter-choices') });
  if (scrollResults) { results.tabIndex = 0; results.setAttribute('aria-label', 'Matter choices'); }
  const controls = node('nav', { className: css('actions'), 'aria-label': 'Matter choice pages' });
  const retry = button('Retry search', () => void load({ focusResults: true })); retry.hidden = true;
  const clear = button(emptyLabel, () => { choose(null); dismiss(); });
  dialog.append(node('div', { className: css('card-heading') }, [node('h2', { id: `${key}-title`, text: dialogTitle }), close]), searchLabel, status, results, controls, node('div', { className: css('actions') }, [...(allowClear ? [clear] : []), retry]));
  // Keep the dialog outside forms: searching never submits an unfinished draft.
  let requestController, timer, generation = 0, page = 1, selected = null;
  const stop = () => { clearTimeout(timer); requestController?.abort(); requestController = null; generation += 1; };
  const renderSelection = () => { selectedName.textContent = triggerLabel || (selected ? selected.title || 'Untitled Matter' : input.value ? 'Selected Matter' : emptyLabel); };
  function choose(record) {
    selected = record; input.value = record?.id || ''; selectionMessage(''); renderSelection();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function dismiss() {
    stop(); if (dialog.open) dialog.close(); open.setAttribute('aria-expanded', 'false'); deactivateDialogFocus(dialog, { restoreFocus: !signal.aborted });
  }
  function show() {
    if (signal.aborted) return;
    if (!dialog.isConnected) document.body.append(dialog);
    page = 1; search.value = ''; dialog.showModal(); open.setAttribute('aria-expanded', 'true');
    activateDialogFocus(dialog, { initialFocus: search, returnFocus: open, onEscape: dismiss, deferInitialFocus: false });
    void load();
  }
  async function load({ selectionOnly = false, focusResults = false } = {}) {
    stop(); if (signal.aborted) return;
    const ticket = generation, controller = new AbortController(); requestController = controller;
    const filters = { search: selectionOnly ? '' : search.value.trim(), page: selectionOnly ? 1 : page, selectedId: input.value };
    if (!selectionOnly) { dialog.dataset.state = 'loading'; results.replaceChildren(); controls.replaceChildren(); retry.hidden = true; status.textContent = 'Loading Matters…'; }
    try {
      const query = new URLSearchParams({ expectedOwnerId: ownerId, q: filters.search, page: String(filters.page), ...(filters.selectedId ? { selectedId: filters.selectedId } : {}) });
      const data = readMatterChoices(await api.get(`${endpoint}?${query}`, { signal: controller.signal }), ownerId, filters);
      if (signal.aborted || ticket !== generation) return;
      if (filters.selectedId && input.value === filters.selectedId) {
        selected = data.selected; renderSelection(); selectionMessage(selected ? '' : 'The selected Matter is unavailable. Choose another or remove the link.');
      }
      if (selectionOnly) return;
      dialog.dataset.state = 'ready';
      status.textContent = data.total ? `${data.total} ${data.total === 1 ? 'Matter' : 'Matters'}${data.pages > 1 ? ` · Page ${data.page} of ${data.pages}` : ''}` : filters.search ? 'No Matters match this search.' : emptyMessage;
      if (data.total && !data.items.length) status.textContent = 'There are no Matters on this page.';
      for (const record of data.items) {
        const chooseButton = button('', () => { choose(record); dismiss(); }, css('matter-choice'));
        chooseButton.append(node('span', { text: record.title || 'Untitled Matter' }), node('span', { className: css('muted'), text: [record.id === currentId ? 'Current Matter' : formatStatus(record), record.practiceArea].filter(Boolean).join(' · ') }));
        if (record.id === currentId) { chooseButton.disabled = true; chooseButton.setAttribute('aria-current', 'true'); }
        results.append(node('li', {}, [chooseButton]));
      }
      const move = next => { page = next; void load({ focusResults: true }); };
      if (data.page > 1) controls.append(button('Previous Matters', () => move(data.page - 1)));
      if (data.page < data.pages) controls.append(button('Next Matters', () => move(data.page + 1)));
      if (data.page > data.pages) controls.append(button('First page', () => move(1)));
      if (focusResults) status.focus();
    } catch (error) {
      if (signal.aborted || controller.signal.aborted || ticket !== generation) return;
      if (selectionOnly) selectionMessage('The selected Matter could not be checked. Open the chooser to retry.');
      else { dialog.dataset.state = 'error'; status.textContent = error.kind === 'authorization' ? 'These Matters are no longer available to your account.' : 'Matter choices could not be loaded. Retry your search.'; results.replaceChildren(); controls.replaceChildren(); retry.hidden = false; if (focusResults) retry.focus(); }
    }
  }
  search.addEventListener('input', () => { stop(); page = 1; results.replaceChildren(); controls.replaceChildren(); retry.hidden = true; status.textContent = 'Searching…'; dialog.dataset.state = 'loading'; timer = setTimeout(() => void load(), 250); });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); page = 1; void load(); } });
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dismiss(); } });
  signal.addEventListener('abort', () => { dismiss(); dialog.remove(); }, { once: true });
  const readiness = input.value ? load({ selectionOnly: true }) : Promise.resolve();
  return { element: root, input, readiness, open: show, clear: () => choose(null) };
}
