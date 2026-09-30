import { workspaceDecision } from './workspace-release.mjs';
import { currentWorkspaceDestination } from './workspace-destinations.mjs';
import { markDocumentLeaving } from './document-navigation.mjs';

// Existing bookmarks remain valid. Only an untouched dashboard entry adopts
// the server-selected canonical workspace; an active original form stays open.
const role = location.pathname === '/dashboard-attorney.html' ? 'attorney' : location.pathname === '/dashboard-paralegal.html' ? 'paralegal' : '';
const guard = window.lpcWorkspaceEntryGuard;
if (role && new URLSearchParams(location.search).get('workspace') !== 'legacy' && !new URLSearchParams(location.search).has('cardSetup')) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  const abort = () => controller.abort();
  window.addEventListener('pagehide', abort, { once: true });
  try {
    const response = await fetch('/api/auth/workspace-release', { credentials: 'include', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (response.ok) {
      const payload = await response.json();
      const decision = workspaceDecision(payload, { id: payload?.workspace?.ownerId, role });
      document.documentElement.dataset.workspaceEntry = decision.version;
      const destination = currentWorkspaceDestination(role, location.href, { origin: location.origin });
      if (!controller.signal.aborted && decision.version === 'v2' && destination && guard?.isUntouched()) { markDocumentLeaving(); location.replace(destination); }
    } else document.documentElement.dataset.workspaceEntry = 'unavailable';
  } catch {
    // Keep the authenticated original page and expose the failed optional
    // routing check to diagnostics without presenting an empty success state.
    document.documentElement.dataset.workspaceEntry = 'unavailable';
  }
  finally { clearTimeout(timer); window.removeEventListener('pagehide', abort); guard?.dispose(); }
} else guard?.dispose();
