// Compatibility entry points retain old bookmarks and provider callbacks while
// routing every feature into the existing role-specific LPC portal.
const objectId = value => /^[a-f0-9]{24}$/i.test(value || '') ? value : '';
export function nativeDestination(kind, role, search) {
  const query = new URLSearchParams(search), matterId = objectId(query.get('caseId'));
  const attorney = role === 'attorney';
  const portal = attorney ? '/attorney-v2.html' : '/paralegal-v2.html';
  if (kind === 'matching') {
    if (!attorney) return portal + '#/home';
    const params = new URLSearchParams({ match: 'work' }); if (matterId) params.set('caseId', matterId);
    return portal + '#/paralegals?' + params;
  }
  if (kind === 'clio' && (!attorney || !matterId)) {
    if (!attorney) return portal + '#/home';
    const params = new URLSearchParams({ tab: 'connections' });
    for (const key of ['user_id', 'subject_url', 'custom_action_nonce']) { const value = query.get(key); if (value && value.length <= 4000 && !/[\u0000-\u001f\u007f]/.test(value)) params.set(key, value); }
    const state = query.get('connected'); if (state === '1' || state === 'true') params.set('clio', 'connected'); else if (state === '0' || state === 'false') params.set('clio', 'declined');
    return portal + '#/settings?' + params;
  }
  if (!matterId) return portal + (attorney ? '#/matters' : '#/work');
  const params = new URLSearchParams(), tab = kind === 'preparation' ? 'work' : 'files';
  const fileId = objectId(query.get('fileId')); if (kind === 'editor' && fileId) { params.set('fileId', fileId); params.set('editFile', fileId); }
  if (kind === 'clio') params.set('clio', query.get('connected') === '1' ? 'connected' : '1');
  if (!attorney) { params.set('tab', tab); return portal + '#/matter/' + matterId + '?' + params; }
  return portal + '#/matters/' + matterId + '/' + tab + (params.size ? '?' + params : '');
}
async function enter() {
  const status = document.querySelector('[data-redirect-status]'), fallback = document.querySelector('[data-redirect-link]');
  const kind = document.body.dataset.connectedDestination;
  if (!['preparation', 'editor', 'matching', 'clio'].includes(kind)) return;
  try {
    const response = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (response.status === 401) { location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search)); return; }
    const payload = await response.json(), user = payload?.user;
    if (!response.ok || !['attorney', 'paralegal'].includes(user?.role) || user.status !== 'approved' || user.disabled || user.deleted) throw new Error('Open your account to continue.');
    const destination = nativeDestination(kind, user.role, location.search); fallback.href = destination; location.replace(destination);
  } catch (error) { status.textContent = error.message || 'The workspace could not open. Please try again.'; fallback.textContent = 'Open LPC'; fallback.hidden = false; }
}
if (typeof document !== 'undefined' && document.body?.dataset.connectedDestination) void enter();
