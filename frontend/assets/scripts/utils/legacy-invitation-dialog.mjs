import { activateDialogFocus, deactivateDialogFocus } from './dialog-focus.js';
import { readInvitationOptions, readInvitationReview, confirmInvitation, invitationAmount, invitationReason } from '../attorney-v2/invitation-action-model.mjs';

const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
let sequence = 0;
function element(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children); return node;
}
const paragraph = text => element('p', { text });
const button = (text, action) => {
  const node = element('button', { type: 'button', text }); node.addEventListener('click', action); return node;
};

// Both original invitation entry points use the same reviewed server contract.
// Pending writes remain local to their paralegal until a fresh review resolves them.
export function createLegacyInvitationDialog({ ownerId, request, onAccountChanged = () => window.location.reload() }) {
  if (!validId(ownerId) || typeof request !== 'function') throw new TypeError('An attorney account is required.');
  const states = new Map(), key = `legacy-invitation-${++sequence}`;
  const dialog = element('dialog', { class: 'lpc-invitation-dialog', 'aria-labelledby': `${key}-title` });
  const title = element('h2', { id: `${key}-title`, text: 'Invite to a Matter' });
  const close = button('Close', () => hide());
  const search = element('input', { id: `${key}-search`, type: 'search', maxlength: '200', autocomplete: 'off' });
  const searchField = element('label', { class: 'lpc-invitation-field', for: search.id }, [element('span', { text: 'Search Matters' }), search]);
  const status = element('p', { class: 'lpc-invitation-status', role: 'status', tabindex: '-1' });
  const content = element('div', { class: 'lpc-invitation-content', tabindex: '0', role: 'region', 'aria-label': 'Invitation details' });
  const pages = element('nav', { class: 'lpc-invitation-actions', 'aria-label': 'Invitation Matter pages' });
  const actions = element('div', { class: 'lpc-invitation-actions' });
  dialog.append(element('header', {}, [title, close]), searchField, status, content, pages, actions);
  let current, review, operation, generation = 0, debounce, disposed = false, accountLost = false;
  let cursor = '', previous = [], next = null, returnFocus;

  function controls() {
    const saving = operation?.phase === 'saving';
    close.disabled = !!saving; search.disabled = !!saving;
    dialog.setAttribute('aria-busy', String(!!operation));
    for (const control of dialog.querySelectorAll('.lpc-invitation-content button,.lpc-invitation-actions button')) control.disabled = !!operation;
  }
  function message(text, phase) { status.textContent = text; dialog.dataset.state = phase; }
  function clearView() { content.replaceChildren(); pages.replaceChildren(); actions.replaceChildren(); review = null; }
  function loseAccount() {
    if (accountLost) return;
    accountLost = true; states.clear(); hide(true, false); onAccountChanged();
  }
  async function json(url, options, signal) {
    const response = await request(url, { noRedirect: true, cache: 'no-store', ...options, signal });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value?.error || 'The request could not be confirmed.'), { status: response.status, code: value?.code || '' });
    return value;
  }
  async function verify(signal) {
    const value = await json('/api/auth/me', {}, signal), user = value?.user || value;
    const id = String(user?.id || user?._id || '');
    if (!validId(id)) throw new Error('The account could not be verified.');
    if (id !== ownerId || user.role !== 'attorney' || user.status !== 'approved' || user.disabled || user.deleted) throw Object.assign(new Error('The account changed.'), { code: 'ACCOUNT_CHANGED' });
  }
  async function ownedRequest(url, options, signal) {
    await verify(signal); signal.throwIfAborted();
    const value = await json(url, options, signal);
    signal.throwIfAborted(); await verify(signal); signal.throwIfAborted(); return value;
  }
  async function run(phase, read, accept, reject) {
    if (disposed || accountLost || !dialog.open || operation?.phase === 'saving') return;
    clearTimeout(debounce); operation?.controller.abort();
    const ticket = ++generation, controller = new AbortController(), saved = { phase, controller };
    operation = saved; const timer = setTimeout(() => controller.abort(), phase === 'saving' ? 60000 : 30000); controls();
    try {
      const value = await read(controller.signal);
      if (ticket !== generation || !dialog.open || accountLost) return;
      controller.signal.throwIfAborted(); accept(value);
    } catch (error) {
      if (ticket !== generation || !dialog.open || accountLost) return;
      if (error.status === 401 || /ACCOUNT_CHANGED$/.test(String(error.code || ''))) { loseAccount(); return; }
      reject(error);
    } finally {
      clearTimeout(timer); if (operation === saved) operation = null;
      if (dialog.open && !accountLost) controls();
    }
  }
  function loadChoices({ focus = false } = {}) {
    if (!current || current.pending) return;
    clearView(); searchField.hidden = false; message('Loading Matters…', 'loading');
    const term = search.value.trim(), pageCursor = cursor, paralegalId = current.paralegalId;
    void run('loading', async signal => {
      const query = new URLSearchParams({ expectedOwnerId: ownerId, q: term, ...(pageCursor ? { cursor: pageCursor } : {}) });
      const value = await ownedRequest(`/api/cases/invitation-options/${paralegalId}?${query}`, {}, signal);
      if (value.search !== term) throw new Error('The Matter search could not be verified.');
      return readInvitationOptions(value, ownerId, paralegalId, pageCursor);
    }, value => {
      next = value.next;
      message(value.matters.length ? `Page ${previous.length + 1}` : term ? 'No Matters match this search.' : pageCursor ? 'No more Matters on this page.' : 'No Matters are available for invitation review.', 'choosing');
      if (value.matters.length) {
        const list = element('ul', { class: 'lpc-invitation-choices', tabindex: '0', 'aria-label': 'Matters for invitation review' });
        for (const item of value.matters) list.append(element('li', {}, [button(item.title || 'Untitled Matter', () => { current.caseId = item.caseId; loadReview(); })]));
        content.append(list);
      }
      if (!term && !pageCursor && !value.matters.length) actions.append(element('a', { href: 'create-case.html', text: 'Create Matter' }));
      if (previous.length) pages.append(button('Previous Matters', () => { cursor = previous.pop() || ''; loadChoices({ focus: true }); }));
      if (next) pages.append(button('Next Matters', () => { previous.push(cursor); cursor = next; loadChoices({ focus: true }); }));
      if (focus) status.focus();
    }, () => {
      message('Matters could not be loaded. Try again.', 'error');
      actions.append(button('Retry search', () => loadChoices({ focus: true }))); if (focus) status.focus();
    });
  }
  function changeMatter() { if (current?.pending) return; loadChoices({ focus: true }); }
  function facts(value) {
    const heading = element('h3', { text: value.caseTitle, tabindex: '-1' });
    content.append(heading);
    const amount = value.relisted ? invitationAmount({ ...value, amountCents: value.remainingCents }) : invitationAmount(value);
    const details = element('dl', {}, [element('dt', { text: value.relisted ? 'Remaining amount' : 'Matter amount' }), element('dd', { text: amount })]);
    if (value.relisted) details.append(element('dt', { text: 'Original amount' }), element('dd', { text: invitationAmount(value) }));
    content.append(details); return heading;
  }
  function loadReview() {
    if (!current?.caseId) return;
    clearView(); searchField.hidden = true; message('Checking the invitation…', 'loading');
    const selected = current, caseId = selected.caseId;
    void run('review', async signal => readInvitationReview(await ownedRequest(`/api/cases/${caseId}/invitation-review/${selected.paralegalId}?${new URLSearchParams({ expectedOwnerId: ownerId })}`, {}, signal), caseId, ownerId, selected.paralegalId), value => {
      selected.pending = false; review = value; title.textContent = `Invite ${value.name}`;
      message('', 'review'); const heading = facts(value);
      if (value.canInvite) {
        content.append(paragraph(value.relisted ? 'This invitation is for replacement work within the remaining amount.' : value.amountLocked ? 'This invitation uses the locked Matter amount. Hiring and funding follow acceptance.' : 'Sending locks this amount. Hiring and funding follow acceptance.'));
        actions.append(button('Send invitation', send));
      } else {
        content.append(paragraph(invitationReason(value.reason)));
        if (value.invitation?.invitedAt) content.append(paragraph(`Invited ${new Date(value.invitation.invitedAt).toLocaleDateString()}`));
        actions.append(button('Check invitation', loadReview));
      }
      actions.append(button('Change Matter', changeMatter)); heading.focus();
    }, error => {
      message(error.status === 409 ? 'The Matter changed. Check the invitation again.' : 'The invitation could not be checked. Try again.', selected.pending ? 'uncertain' : 'error');
      actions.append(button('Check invitation', loadReview));
      if (!selected.pending) actions.append(button('Change Matter', changeMatter)); status.focus();
    });
  }
  function send() {
    if (!review?.canInvite || operation || current?.pending) return;
    const selected = current, displayed = review; selected.pending = true;
    message('Sending invitation…', 'saving');
    void run('saving', async signal => {
      const value = await ownedRequest(`/api/cases/${displayed.caseId}/invite/${displayed.paralegalId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedOwnerId: ownerId, reviewedRevision: displayed.revision }) }, signal);
      confirmInvitation(value, displayed); return value;
    }, () => {
      selected.pending = false; clearView(); searchField.hidden = true;
      message('Invitation sent.', 'sent'); content.append(paragraph(displayed.caseTitle));
      actions.append(button('Done', () => hide())); status.focus();
    }, error => {
      clearView(); searchField.hidden = true;
      message(error.status === 409 ? 'The Matter or invitation changed. Check its status before continuing.' : 'The invitation could not be confirmed. Check its status before sending again.', 'uncertain');
      actions.append(button('Check invitation', loadReview)); status.focus();
    });
  }
  function hide(force = false, restoreFocus = true) {
    if (!force && operation?.phase === 'saving') return;
    clearTimeout(debounce); operation?.controller.abort(); operation = null; generation++;
    if (dialog.open) dialog.close();
    deactivateDialogFocus(dialog, { restoreFocus }); dialog.remove(); clearView(); current = null;
  }
  function open({ paralegalId, name = 'paralegal', trigger }) {
    if (disposed || accountLost || !validId(paralegalId) || operation?.phase === 'saving') return;
    hide(true, false);
    if (!states.has(paralegalId)) states.set(paralegalId, { paralegalId, caseId: '', pending: false });
    current = states.get(paralegalId); returnFocus = trigger; title.textContent = `Invite ${name}`;
    cursor = ''; previous = []; next = null; search.value = ''; searchField.hidden = !!current.pending;
    document.body.append(dialog); dialog.showModal();
    activateDialogFocus(dialog, { initialFocus: current.pending ? close : search, returnFocus, onEscape: () => hide(), deferInitialFocus: false });
    if (current.pending) loadReview(); else loadChoices();
  }
  search.addEventListener('input', () => {
    if (operation?.phase === 'saving') return;
    clearTimeout(debounce); operation?.controller.abort(); operation = null; generation++; cursor = ''; previous = []; next = null;
    clearView(); message('Searching…', 'loading'); controls(); debounce = setTimeout(() => loadChoices(), 250);
  });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); cursor = ''; previous = []; loadChoices({ focus: true }); } });
  dialog.addEventListener('cancel', event => { event.preventDefault(); hide(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) hide();
  });
  const leave = () => hide(true, false);
  const accountChanged = event => {
    if (event.key !== 'lpc_user' && event.key !== null) return;
    let user;
    try { user = JSON.parse(localStorage.getItem('lpc_user') || 'null'); } catch { user = null; }
    if (String(user?.id || user?._id || '') !== ownerId) loseAccount();
  };
  window.addEventListener('pagehide', leave); window.addEventListener('storage', accountChanged);
  return { open, dispose() { disposed = true; leave(); states.clear(); window.removeEventListener('pagehide', leave); window.removeEventListener('storage', accountChanged); } };
}
