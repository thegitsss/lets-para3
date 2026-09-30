// Only opaque recovery references survive a reload. Card details and provider
// secrets stay out of browser storage; every reference is verified by the API.
const key = 'lpc_attorney_card_setup_v1';
const validIntent = value => /^seti_[A-Za-z0-9]{1,200}$/.test(value || '');
const validRequest = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value || '');
export function clearCardSetupRecovery() { try { sessionStorage.removeItem(key); } catch {} }
export function recoverCardSetup(ownerId) {
  try {
    const value = JSON.parse(sessionStorage.getItem(key));
    if (!value) return {};
    if (value.ownerId !== ownerId || !/^[a-f0-9]{24}$/i.test(ownerId) || value.intentId && !validIntent(value.intentId) || value.requestId && !validRequest(value.requestId)) { clearCardSetupRecovery(); return {}; }
    return { ...(validIntent(value.intentId) ? { intentId: value.intentId } : {}), ...(validRequest(value.requestId) ? { requestId: value.requestId } : {}), ...(value.pending === true ? { pending: true } : {}) };
  } catch { clearCardSetupRecovery(); return {}; }
}
export function retainCardSetup(ownerId, state) {
  const value = { ownerId, ...(validIntent(state.intentId) ? { intentId: state.intentId } : {}), ...(validRequest(state.requestId) ? { requestId: state.requestId } : {}), ...(state.pending ? { pending: true } : {}) };
  if (!value.intentId && !value.requestId && !value.pending) { clearCardSetupRecovery(); return; }
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {}
}
