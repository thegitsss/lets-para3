import { node, page, link, button } from './dom.mjs';
import { accountNavigation } from './account-navigation.mjs';
import { createClosureApi } from './closure-api.mjs';
import { storeClosureProof, clearClosureProof } from '../utils/account-closure-state.mjs';

export function isClosureRoute(route) {
  return ['closure', 'deactivate'].includes(route.query.get('tab')) || ['closure', 'security:closure', 'deactivate', 'deactivateAccount'].includes(route.query.get('settingsTarget') || route.query.get('panel') || '');
}

export function createClosureView(_route, identity, {signal, privateState, onSessionLost, onClosurePending, closureApi} = {}) {
  const state = privateState.account;
  if (state.ownerId !== identity.id) {
    Object.keys(state).forEach(key => delete state[key]);
    Object.assign(state, {ownerId:identity.id,changes:{},expected:{},dirty:false});
  }
  const api = closureApi || createClosureApi({onAuthenticationLost:onSessionLost});
  const options = {ownerId:identity.id, signal};
  const view = page('Profile Settings');view.classList.add('av2-account', 'av2-closure');
  const nav = accountNavigation('closure');
  const refresh = button('Retry', () => {view.readiness = load();}, 'av2-secondary');
  const notice = node('p', {role:'status',className:'av2-account-feedback'});
  const body = node('div', {'data-closure-review':'','aria-busy':'true'});
  const check = button('Check account status', handoff, 'av2-secondary');check.hidden = true;
  view.append(nav, notice, refresh, body, check);
  let review = null, loading = false, busy = false, dialog = null, ticket = 0;
  const valid = () => !signal.aborted && state.ownerId === identity.id;
  const active = () => valid() && view.isConnected;
  function handoff() {
    if (!valid() || !state.closure?.pending) return;
    try {storeClosureProof(state.closure.proof);}
    catch {
      busy = false;check.hidden = false;
      notice.textContent = 'The account check could not be opened. Keep this page open and try again.';
      dialog?.close('pending');lock();
      if (active()) {check.focus();check.scrollIntoView({block:'nearest'});}
      return;
    }
    if (onClosurePending) onClosurePending();
    else location.replace('/account-closure.html');
  }
  function lock() {
    refresh.disabled = loading || busy || Boolean(state.closure?.pending); refresh.hidden = loading || Boolean(review) && !state.closure?.pending;
    body.querySelectorAll('button').forEach(control => {control.disabled = loading || busy || Boolean(state.closure?.pending);});
    check.disabled = busy;
  }
  function feedback(text, error = false) {notice.textContent = text;notice.dataset.state = error ? 'error' : '';}
  signal.addEventListener('abort', () => {
    ticket++;api.clear();busy = false;
    if (state.closure?.pending) state.closure.phase = 'uncertain';
    dialog?.close('interrupted');dialog?.remove();dialog = null;
    body.replaceChildren();notice.textContent = '';
  }, {once:true});
  function render() {
    const effects = node('div', {className:'av2-closure-effects'}, [
      node('p', {text:'Deactivation ends access to LPC and signs out all sessions. Open, unfunded Matter postings close, and pending applications and invitations end.'}),
      node('p', {text:'Past Matters and records of work, payments, disputes, and account activity are retained.'}),
    ]);
    const content = [effects];
    if (review.blockers.length) {
      content.push(node('section', {className:'av2-closure-blockers','aria-labelledby':'av2-closure-blockers-heading'}, [
        node('h2', {id:'av2-closure-blockers-heading',text:'Resolve these before deactivating'}),
        node('ul', {}, review.blockers.map(item => node('li', {'data-closure-blocker':item.code,text:item.message}))),
        node('div', {className:'av2-actions'}, [link('View Matters', '#/matters'), ...(review.blockers.some(item => ['unresolved_financials', 'pending_payouts'].includes(item.code)) ? [link('View payments', '#/payments')] : [])]),
      ]));
    } else {
      const deactivate = button('Deactivate account', () => confirm(deactivate), 'av2-secondary av2-closure-danger');
      content.push(node('div', {className:'av2-actions'}, [deactivate]));
    }
    body.replaceChildren(...content);lock();
  }
  async function load(message = '') {
    if (!valid() || loading || busy || state.closure?.pending) return;
    loading = true;review = null;lock();body.setAttribute('aria-busy','true');body.replaceChildren();feedback('Checking account closure…');
    const current = ++ticket;
    try {
      const value = await api.readReview(options);
      if (!valid() || current !== ticket) return;
      review = value;feedback(message, Boolean(message));render();
    } catch (failure) {
      if (!valid() || current !== ticket || failure.name === 'AbortError') return;
      feedback('Account closure could not be checked. Choose Retry to check again.', true);
    } finally {
      if (valid() && current === ticket) {loading = false;body.setAttribute('aria-busy','false');lock();}
    }
  }
  function confirm(launcher) {
    if (!valid() || loading || busy || !review?.canDeactivate || state.closure?.pending || dialog) return;
    const reviewed = structuredClone(review);
    dialog = node('dialog', {className:'av2-account-dialog av2-closure-dialog','aria-labelledby':'av2-closure-confirm-title'}, [
      node('h2', {id:'av2-closure-confirm-title',text:'Deactivate your account?'}),
      node('p', {text:'You will lose access to LPC. Your open, unfunded postings will close, and all sessions will end. Past work and financial records will remain.'}),
    ]);
    const error = node('p', {role:'alert',className:'av2-account-feedback'});
    const cancel = button('Cancel', () => dialog.close('cancel'), 'av2-secondary');
    const submit = button('Deactivate account', async () => {
      if (!valid() || busy || state.closure?.pending) return;
      busy = true;lock();cancel.disabled = true;submit.disabled = true;error.textContent = '';
      try {
        await api.deactivate(reviewed, {...options,beforeDispatch() {
          try {storeClosureProof(reviewed.resultProof);}
          catch {throw Object.assign(new Error('Recovery storage unavailable'), {kind:'storage'});}
          state.closure = {ownerId:identity.id,pending:true,proof:reviewed.resultProof,phase:'pending'};
        }});
        if (!valid()) return;
        state.closure.phase = 'confirmed';handoff();
      } catch (failure) {
        if (!valid() || failure.name === 'AbortError') return;
        if (failure.dispatched === false) {
          delete state.closure;clearClosureProof();
          if (failure.kind === 'storage') {error.textContent = 'This browser could not retain the account check. Allow session storage and try again.';return;}
          busy = false;dialog?.close('review');review = null;body.replaceChildren();
          feedback('Account closure could not start. Refresh the review and try again.', true);
          lock();
          if (active()) refresh.focus();
        } else if (failure.kind === 'conflict' || failure.kind === 'expired' || failure.status === 400) {
          delete state.closure;clearClosureProof();busy = false;dialog?.close('review');
          await load(failure.kind === 'expired' ? 'This review expired. Review the current information before continuing.' : 'Account closure changed. Review the current information before continuing.');
          if (active()) refresh.focus();
        } else {state.closure.phase = 'uncertain';handoff();}
      } finally {
        if (valid()) {busy = false;cancel.disabled = false;submit.disabled = Boolean(state.closure?.pending);lock();}
      }
    }, 'av2-secondary av2-closure-danger');
    dialog.append(error, node('div', {className:'av2-actions'}, [cancel, submit]));
    dialog.addEventListener('cancel', event => {if (busy) event.preventDefault();});
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const controls = [cancel, submit].filter(control => !control.disabled);
      if (!controls.length) return;
      const index = controls.indexOf(document.activeElement);
      const next = controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length];
      next.focus();next.scrollIntoView({block:'nearest'});
    });
    const currentDialog = dialog;
    currentDialog.addEventListener('close', () => {
      currentDialog.remove();if (dialog === currentDialog) dialog = null;
      if (active() && !loading && !busy) {
        const control = (state.closure?.pending && !check.hidden ? check : launcher.isConnected && !launcher.disabled ? launcher : refresh.disabled ? nav.querySelector('[aria-current="page"]') : refresh);
        control.focus();control.scrollIntoView({block:'center',inline:'nearest'});
      }
    }, {once:true});
    document.body.append(currentDialog);currentDialog.showModal();cancel.focus();
    cancel.scrollIntoView({block:'nearest'});
  }
  if (state.closure?.pending) {
    state.closure.phase = 'uncertain';body.setAttribute('aria-busy','false');
    feedback('Check the current account status before taking another action.', true);check.hidden = false;lock();
    view.readiness = Promise.resolve();
  } else view.readiness = load();
  return view;
}
