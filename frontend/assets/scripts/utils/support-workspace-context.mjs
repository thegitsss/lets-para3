// A context hint from an already authorized Matter view, never an access grant.
// The server must still resolve ownership and retrieve current evidence.
const id = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value) ? value.toLowerCase() : '';
const tabs = new Set(['overview', 'applications', 'work', 'files', 'messages', 'deadlines', 'activity', 'financials']);
let current = null;
export function setSupportMatterContext({ ownerId, role, matterId, routeMatterId, currentTab, availableMatterTabs = [], status = '', relationship = '', signal, location: address = globalThis.location } = {}) {
  const owner = id(ownerId), matter = id(matterId);
  const allowed = [...new Set(availableMatterTabs)].filter(tab => tabs.has(tab));
  const path = String(address?.pathname || ''), hash = String(address?.hash || '');
  if (!owner || !matter || matter !== id(routeMatterId) || !['attorney', 'paralegal'].includes(role) || path !== `/${role}-v2.html` || signal?.aborted) return () => {};
  const expected = role === 'attorney' ? `#/matters/${matter}/` : `#/matter/${matter}`;
  if (!(role === 'attorney' ? hash.toLowerCase().startsWith(expected) : hash.toLowerCase() === expected || hash.toLowerCase().startsWith(`${expected}?`))) return () => {};
  const entry = { ownerId: owner, role, path, hash, caseId: matter, currentTab: allowed.includes(currentTab) ? currentTab : 'overview', availableMatterTabs: allowed, status: typeof status === 'string' ? status : '', relationship: typeof relationship === 'string' ? relationship : '' };
  current = entry;
  const clear = () => { signal?.removeEventListener('abort', clear); if (current === entry) current = null; };
  signal?.addEventListener('abort', clear, { once: true });
  return clear;
}
export function getSupportMatterContext({ ownerId, role, location: address = globalThis.location } = {}) {
  if (!current || current.ownerId !== id(ownerId) || current.role !== role || current.path !== address?.pathname || current.hash !== address?.hash) return null;
  const { ownerId: _owner, role: _role, path: _path, hash: _hash, ...context } = current;
  return { ...context, availableMatterTabs: [...context.availableMatterTabs] };
}
export function clearSupportMatterContext() { current = null; }
