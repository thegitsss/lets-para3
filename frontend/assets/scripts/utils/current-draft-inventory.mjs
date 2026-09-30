import { readMatterInventory } from '../attorney-v2/matter-inventory-model.mjs';

// A page is usable only after the complete owner-bound inventory is verified.
// Keep failures explicit and ignore responses belonging to an older query/session.
export function createCurrentDraftInventory({ ownerId, read, verifyOwner, onChange }) {
  let state = { phase: 'idle', key: '', result: null }, epoch = 0, controller, pending;
  const notify = () => onChange?.(state);
  function clear() {
    epoch++; controller?.abort(); pending = null;
    state = { phase: 'unavailable', key: state.key, result: null }; notify();
  }
  function load(filters, { force = false } = {}) {
    const snapshot = { ...filters }, key = JSON.stringify(snapshot);
    if (!force && state.key === key) return pending || Promise.resolve();
    const ticket = ++epoch;
    controller?.abort(); controller = new AbortController();
    const signal = controller.signal;
    state = { phase: 'loading', key, result: null }; notify();
    pending = (async () => {
      try {
        if (await verifyOwner() !== ownerId) throw new Error('Account changed');
        if (ticket !== epoch || signal.aborted) return;
        const value = await read(snapshot, { ownerId, signal });
        if (ticket !== epoch || signal.aborted) return;
        const result = readMatterInventory(value, ownerId, snapshot);
        if (await verifyOwner() !== ownerId) throw new Error('Account changed');
        if (ticket !== epoch || signal.aborted) return;
        state = { phase: 'ready', key, result };
      } catch {
        if (ticket !== epoch || signal.aborted) return;
        state = { phase: 'unavailable', key, result: null };
      } finally {
        if (ticket === epoch) { pending = null; notify(); }
      }
    })();
    return pending;
  }
  return { load, clear, get state() { return state; } };
}
