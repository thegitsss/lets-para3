import { previousWorkspaceDestination } from './workspace-destinations.mjs';
import { markDocumentLeaving } from './document-navigation.mjs';

export function workspaceDecision(payload, identity) {
  const value = payload?.workspace, id = String(identity?.id || identity?._id || '');
  if (!/^[a-f\d]{24}$/i.test(id) || !value || value.schemaVersion !== 1 || value.ownerId !== id || value.role !== identity?.role || !['attorney', 'paralegal'].includes(value.role) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !['baseline', 'legacy', 'v2'].includes(value.version)) throw new Error('Workspace routing could not be verified.');
  const expected = value.version === 'v2' ? `/${value.role}-v2.html#/home` : `/dashboard-${value.role}.html`;
  if (value.defaultDestination !== expected) throw new Error('Workspace destination could not be verified.');
  return { ownerId: id, role: value.role, revision: value.revision, version: value.version, defaultDestination: expected };
}
export async function readWorkspaceDecision(identity, { fetchImpl = window.fetch.bind(window), signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  try {
    const response = await fetchImpl('/api/auth/workspace-release', { credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error('Workspace routing could not be verified.'), { status: response.status });
    return workspaceDecision(await response.json(), identity);
  } catch (error) {
    if (timedOut && !signal?.aborted) throw new Error('Workspace routing could not be checked in time.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function defaultWorkspaceDestination(identity, options) {
  if (!['attorney', 'paralegal'].includes(identity?.role)) return null;
  try { return (await readWorkspaceDecision(identity, options)).defaultDestination; }
  catch { return `/dashboard-${identity.role}.html`; }
}

// A workspace switch changes presentation, never authentication or financial
// authority. Finish/review existing work first; never replay it to the other UI.
export function createWorkspaceReleaseController({ outlet, baselineAllowed, hasUnfinishedWork, onAccessLost, currentLocation, noticeHost, windowObject = window }) {
  const win = windowObject, doc = win.document, fetchImpl = win.fetch.bind(win);
  let identity = null, decision = null, checking = null, controller = null, timer = null, generation = 0;
  let pendingWrites = 0, navigating = false, notice = null, noticeUnavailable = false, settledTimer = null;
  const observer = new win.MutationObserver(() => { if (notice && !notice.isConnected) showNotice(noticeUnavailable); });
  function showNotice(unavailable = false) {
    if (!identity || navigating) return;
    noticeUnavailable = unavailable;
    if (!notice) {
      notice = doc.createElement('section'); notice.className = identity.role === 'attorney' ? 'av2-card av2-notice' : 'v2-route-state';
      notice.dataset.workspaceReleaseNotice = ''; notice.setAttribute('role', 'status');
      const button = doc.createElement('button'); button.type = 'button'; button.className = identity.role === 'attorney' ? 'av2-button' : 'v2-settings-secondary';
      button.addEventListener('click', () => { button.disabled = true; void check().finally(() => { if (button.isConnected) button.disabled = false; }); });
      notice.append(doc.createElement('p'), doc.createElement('p'), button);
    }
    notice.children[0].textContent = unavailable ? 'The workspace update could not be checked.' : 'LPC is returning to the previous workspace.';
    notice.children[1].textContent = unavailable ? 'Your current work remains open. Check again when your connection is available.' : 'Your unsent text and pending changes are still open here. Finish or review them before switching. LPC will not repeat a submission.';
    notice.children[2].textContent = unavailable ? 'Check again' : 'Check and switch';
    const host = noticeHost?.() || outlet;
    if (notice.parentNode !== host) host.prepend(notice);
    observer.disconnect();
    observer.observe(host, { childList: true });
  }
  function clearNotice() { observer.disconnect(); notice?.remove(); notice = null; }
  const hasPendingSwitch = () => Boolean(identity && decision && (decision.version === 'legacy' || decision.version === 'baseline' && !baselineAllowed(identity)));
  function switchWhenReady() {
    if (!identity || navigating || !decision) return true;
    if (!hasPendingSwitch()) { clearNotice(); return true; }
    if (pendingWrites || hasUnfinishedWork()) { showNotice(); return true; }
    const destination = previousWorkspaceDestination(identity.role, currentLocation?.() || win.location.href, { origin: win.location.origin, ownerId: identity.id }) || `/dashboard-${identity.role}.html`;
    navigating = true; clearNotice(); if (timer) win.clearInterval(timer); timer = null;
    // Keep the managed session. Existing pagehide cleanup owns private state.
    markDocumentLeaving(win);
    win.location.replace(destination);
    return false;
  }
  async function check() {
    if (!identity || navigating) return false;
    if (checking) return checking;
    const ticket = generation, owner = identity;
    controller = new AbortController();
    checking = (async () => {
      try {
        const next = await readWorkspaceDecision(owner, { fetchImpl, signal: controller.signal });
        if (ticket !== generation || navigating) return false;
        decision = next; return switchWhenReady();
      } catch (error) {
        if (ticket !== generation || navigating || error.name === 'AbortError') return false;
        if ([401, 403].includes(error.status)) { onAccessLost?.(); return false; }
        // An isolated local preview may use a static fixture without this API.
        // Production receives no such fallback; an unavailable read preserves
        // the currently authenticated view and provides a deliberate retry.
        if (error.status === 404 && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(win.location.hostname) && baselineAllowed(owner)) return true;
        if (!decision && !baselineAllowed(owner)) { decision = { version: 'baseline' }; return switchWhenReady(); }
        showNotice(true); return true;
      } finally { if (ticket === generation) checking = null; }
    })();
    return checking;
  }
  const refresh = () => { if (doc.visibilityState === 'visible') void check(); };
  function updatePreviousLinks() {
    if (!identity) return;
    const path = previousWorkspaceDestination(identity.role, currentLocation?.() || win.location.href, { origin: win.location.origin, ownerId: identity.id }) || `/dashboard-${identity.role}.html`;
    const target = new URL(path, win.location.origin); target.searchParams.set('workspace', 'legacy');
    for (const link of doc.querySelectorAll('[data-workspace-previous]')) link.setAttribute('href', `${target.pathname}${target.search}${target.hash}`);
  }
  async function start(value) {
    const id = String(value?.id || value?._id || '');
    if (!identity || identity.id !== id || identity.role !== value.role) {
      stop(); identity = { id, role: value.role, status: value.status, disabled: value.disabled, deleted: value.deleted };
      win.addEventListener('focus', refresh); win.addEventListener('online', refresh); doc.addEventListener('visibilitychange', refresh);
      win.addEventListener('hashchange', updatePreviousLinks);
    }
    updatePreviousLinks();
    const allowed = await check();
    if (identity && !navigating && !timer) timer = win.setInterval(refresh, 30000);
    return allowed;
  }
  function stop() {
    generation++; controller?.abort(); controller = null; checking = null;
    if (timer) win.clearInterval(timer); timer = null;
    if (settledTimer) win.clearTimeout(settledTimer); settledTimer = null;
    win.removeEventListener('focus', refresh); win.removeEventListener('online', refresh); doc.removeEventListener('visibilitychange', refresh);
    win.removeEventListener('hashchange', updatePreviousLinks);
    identity = null; decision = null; navigating = false; clearNotice();
  }
  function checkAfterSettlement() {
    if (!identity || !decision) return;
    if (settledTimer) win.clearTimeout(settledTimer);
    settledTimer = win.setTimeout(() => { settledTimer = null; if (identity && decision) switchWhenReady(); }, 0);
  }
  async function observedFetch(input, init = {}) {
    const method = String(init.method || input?.method || 'GET').toUpperCase();
    const url = new URL(typeof input === 'string' ? input : input?.url || String(input), win.location.href);
    const apiRequest = url.origin === win.location.origin && url.pathname.startsWith('/api/');
    const write = apiRequest && !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (write) pendingWrites++;
    try {
      const response = await fetchImpl(input, init);
      if (apiRequest) {
        // fetch resolves at the headers. The view cannot settle until its body
        // has been consumed and the API caller has adopted or rejected it.
        for (const method of ['json', 'text', 'blob', 'arrayBuffer']) {
          if (typeof response[method] !== 'function') continue;
          const consume = response[method].bind(response);
          response[method] = async (...args) => {
            try { return await consume(...args); }
            finally { checkAfterSettlement(); }
          };
        }
      }
      return response;
    }
    finally {
      if (write) pendingWrites--;
      // A read-only financial refresh may temporarily mark a view busy too.
      // Recheck after its caller settles, without starting another request or
      // waiting for the next policy poll. Uncertain writes remain protected.
      if (apiRequest) checkAfterSettlement();
    }
  }
  function refreshPresentation() { updatePreviousLinks(); if (notice) showNotice(noticeUnavailable); }
  return Object.freeze({ start, check, stop, hasPendingSwitch, refreshPresentation, fetch: observedFetch });
}
