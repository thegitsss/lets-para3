import { node, button, link } from './dom.mjs';
import { blockedStatus } from '../utils/account-blocked-api.mjs';

// Creation is limited to a qualifying Matter or applicant. Settings owns unblock.
export function createContextualBlock(caseId, target, { api, signal, ownerId, privateState, onRecorded } = {}) {
  const key = `${caseId}:${target.id}`, states = privateState.contextualBlocks;
  if (!states.has(key)) states.set(key, {});
  const state = states.get(key), options = { signal, ownerId };
  const section = node('section', { 'data-contextual-block': target.id, 'aria-label': 'Future interaction' });
  const status = node('p', { role: 'status' }), controls = node('div', { className: 'av2-actions' }), confirmation = node('div');
  section.append(status, controls, confirmation);
  let busy = false, reviewing = false, message = '', blocked = target.blocked === true;
  const alive = () => !signal.aborted;
  const label = target.mode === 'application' ? 'Block applicant' : 'Block paralegal';
  const settings = () => link('Manage blocked users', '#/settings?tab=blocked');
  const focusResult = () => { if (alive() && section.isConnected) controls.querySelector('button, a')?.focus(); };
  function render() {
    section.setAttribute('aria-busy', String(busy)); controls.replaceChildren(); confirmation.replaceChildren();
    status.textContent = message || (blocked ? 'Future interaction is blocked.' : '');
    if (state.pending) controls.append(button('Check block result', () => void check()));
    else if (blocked) controls.append(settings());
    else if (target.canBlock) {
      const launcher = button(label, () => { reviewing = true; render(); confirmation.querySelector('button')?.focus(); });
      controls.append(launcher); launcher.hidden = reviewing;
      if (reviewing) confirmation.append(node('h4', { text: `Block ${target.name || 'this paralegal'}?` }), node('p', { text: 'This prevents future applications, invitations, hiring and direct messages between you. The paralegal will not be notified. Existing Matter, application and payment records remain available.' }), node('div', { className: 'av2-actions' }, [button('Keep interaction available', () => { reviewing = false; render(); controls.querySelector('button')?.focus(); }), button('Confirm block', () => void save())]));
    }
    section.querySelectorAll('button').forEach(control => { control.disabled = busy; });
  }
  async function readback() {
    const result = blockedStatus(await api.readContextualBlock(target.id, options), target.id);
    if (!alive()) return;
    delete state.pending; blocked = result.blocked; reviewing = false;
    message = blocked ? 'Future interaction is blocked.' : 'No active block from your account was found. Review this Matter before trying again.';
    if (blocked) onRecorded?.();
  }
  async function check() {
    if (busy || !alive() || !state.pending) return;
    busy = true; message = 'Checking the saved block…'; render();
    try { await readback(); }
    catch (error) { if (alive() && error.kind !== 'authentication') message = 'The block result could not be confirmed. Check again before trying another action.'; }
    finally { if (alive()) { busy = false; render(); focusResult(); } }
  }
  async function save() {
    if (busy || !alive() || !reviewing || state.pending || !target.canBlock) return;
    busy = true; state.pending = true; reviewing = false; message = 'Saving the block…'; render();
    try {
      await api.createContextualBlock(caseId, target.id, { ...options, application: target.mode === 'application' });
      if (alive()) await readback();
    } catch (error) {
      if (!alive()) return;
      if ([400, 403, 404].includes(error.status) || error.kind === 'authentication') {
        delete state.pending; message = 'This block could not be saved. Refresh the Matter to review the available actions.';
      } else message = 'The block result could not be confirmed. Check its saved result before trying again.';
    } finally { if (alive()) { busy = false; render(); focusResult(); } }
  }
  signal.addEventListener('abort', () => { busy = false; section.replaceChildren(); }, { once: true });
  message = state.pending ? 'An earlier block has not been confirmed. Check its saved result.' : '';
  render(); if (state.pending) void check(); return section;
}
