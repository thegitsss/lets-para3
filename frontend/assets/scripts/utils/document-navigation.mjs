// A document that is leaving must not start another authenticated request.
// Restoring it from browser history reopens transport; session guards still
// decide whether its private UI may be shown.
const documents = new WeakMap();
const currentWindow = () => typeof window === 'undefined' ? null : window;
function stateFor(win) {
  if (!win) return null;
  if (!documents.has(win)) {
    const state = { leaving: false }; documents.set(win, state);
    win.addEventListener?.('pagehide', () => { state.leaving = true; }, true);
    win.addEventListener?.('pageshow', event => { if (event.persisted) state.leaving = false; }, true);
  }
  return documents.get(win);
}
// Register before consuming shells install their lifecycle handlers. Chromium
// dispatches Window pageshow listeners in registration order, so lazy setup on
// the first request can leave a restored shell seeing the old exit state.
stateFor(currentWindow());
export const documentIsLeaving = (win = currentWindow()) => Boolean(stateFor(win)?.leaving);
export function markDocumentLeaving(win = currentWindow()) { const state = stateFor(win); if (state) state.leaving = true; }
export function assertDocumentActive(win = currentWindow()) {
  if (documentIsLeaving(win)) throw new DOMException('The page is leaving.', 'AbortError');
}
export async function fetchInDocument(input, init) { assertDocumentActive(); return globalThis.fetch(input, init); }
