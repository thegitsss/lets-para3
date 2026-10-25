import { createApiClient } from '../attorney-v2/api-client.mjs';
import { createPrivateState } from '../attorney-v2/private-state.mjs';
import { createHiring } from '../attorney-v2/hiring.mjs';
import { createPreEngagement } from '../attorney-v2/pre-engagement.mjs';
import { activateDialogFocus, deactivateDialogFocus } from './dialog-focus.js';

let sequence = 0;
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
export function createLegacyEngagementDialog({ ownerId, request, onAccountChanged = () => window.location.reload() }) {
  if (!validId(ownerId) || typeof request !== 'function') throw new TypeError('An attorney account is required.');
  const privateState = createPrivateState();
  const dialog = document.createElement('dialog'); dialog.className = 'lpc-engagement-dialog';
  const heading = document.createElement('h2'); heading.id = `legacy-engagement-${++sequence}`; heading.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', heading.id);
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  const header = document.createElement('header'); header.append(heading, close);
  const content = document.createElement('div'); content.className = 'lpc-engagement-content'; content.tabIndex = 0;
  content.setAttribute('role', 'region'); content.setAttribute('aria-label', 'Engagement details'); dialog.append(header, content);
  let controller, current, returnFocus, generation = 0, disposed = false, accountLost = false;
  const api = createApiClient({ fetchImpl: (url, options) => request(url, { ...options, noRedirect: true }), onAuthenticationLost: loseAccount });
  const writing = () => [...privateState.hiring.values(), ...privateState.preEngagement.values(), privateState.hiringReturn].some(value => value.busy && value.pending);
  function controls() { close.disabled = writing(); }
  const observer = new MutationObserver(controls);
  observer.observe(content, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy', 'data-state'] });
  function loseAccount() {
    if (accountLost) return;
    accountLost = true; hide(true, false); privateState.clear(); api.clear(); onAccountChanged();
  }
  function errorView(mode) {
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = 'Engagement details are unavailable. Try again.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry review'; retry.addEventListener('click', () => void render(mode));
    content.replaceChildren(status, retry); dialog.dataset.state = 'error'; heading.focus();
  }
  async function render(mode = 'hiring') {
    if (disposed || accountLost || !dialog.open || writing() || !current) return;
    controller?.abort(); controller = new AbortController(); const signal = controller.signal, ticket = ++generation;
    heading.textContent = mode === 'requirements' ? 'Pre-engagement' : 'Review hire';
    content.textContent = 'Checking access…'; dialog.dataset.state = 'loading'; controls();
    const timeout = setTimeout(() => controller?.signal === signal && controller.abort(), 30000);
    try {
      await api.verifyOwner({ ownerId, signal }); signal.throwIfAborted();
      clearTimeout(timeout);
      if (ticket !== generation || !dialog.open || accountLost) return;
      const options = { api, signal, ownerId, privateState, current: true, autoReview: true };
      const editor = mode === 'requirements'
        ? createPreEngagement(current.caseId, { applicantId: current.paralegalId }, { ...options, onContinue: () => void render('hiring') })
        : createHiring(current.caseId, { applicantId: current.paralegalId }, { ...options, onRequirements: () => void render('requirements') });
      // The containing dialog supplies the heading and the section retains its accessible name.
      const innerHeading = editor.firstElementChild; if (innerHeading?.tagName === 'H3') innerHeading.hidden = true;
      content.replaceChildren(editor); dialog.dataset.state = mode;
      await editor.readiness;
      if (ticket === generation && dialog.open && !signal.aborted && !accountLost) { heading.focus(); controls(); }
    } catch (error) {
      if (ticket !== generation || !dialog.open || accountLost) return;
      if (error.kind === 'authentication') { loseAccount(); return; }
      errorView(mode);
    } finally { clearTimeout(timeout); }
  }
  function hide(force = false, restoreFocus = true) {
    if (!force && writing()) return;
    generation++; controller?.abort(); controller = null;
    if (dialog.open) dialog.close();
    deactivateDialogFocus(dialog, { restoreFocus }); content.replaceChildren(); dialog.remove(); current = null; controls();
  }
  function open({ caseId, paralegalId, trigger }) {
    if (disposed || accountLost || writing() || !validId(caseId) || !validId(paralegalId)) return;
    hide(true, false); current = { caseId, paralegalId }; returnFocus = trigger;
    document.body.append(dialog); heading.textContent = 'Review hire'; dialog.showModal();
    activateDialogFocus(dialog, { initialFocus: heading, returnFocus, onEscape: () => hide(), deferInitialFocus: false });
    void render('hiring');
  }
  const leave = () => { hide(true, false); api.clear(); };
  const identity = value => {
    let user; try { user = typeof value === 'string' ? JSON.parse(value) : value; } catch { user = null; }
    if (String(user?.id || user?._id || '') !== ownerId || user?.role !== 'attorney') loseAccount();
  };
  const storage = event => { if (event.key === 'lpc_user' || event.key === null) identity(localStorage.getItem('lpc_user')); };
  const changedUser = event => identity(event.detail);
  const beforeLeave = event => { if (privateState.hasUnsaved()) { event.preventDefault(); event.returnValue = ''; } };
  close.addEventListener('click', () => hide());
  dialog.addEventListener('cancel', event => { event.preventDefault(); hide(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) hide();
  });
  window.addEventListener('pagehide', leave); window.addEventListener('beforeunload', beforeLeave);
  window.addEventListener('storage', storage); window.addEventListener('lpc:user-updated', changedUser);
  return { open, dispose() { disposed = true; leave(); privateState.clear(); observer.disconnect(); window.removeEventListener('pagehide', leave); window.removeEventListener('beforeunload', beforeLeave); window.removeEventListener('storage', storage); window.removeEventListener('lpc:user-updated', changedUser); } };
}
