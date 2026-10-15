import { secureFetch, getStoredSession } from '../auth.js';
// Bind private reads and renderers to the current Admin document and owner.
let privateGeneration = 0;
let privateOwner = String(getStoredSession().user?.id || getStoredSession().user?._id || '');
let privateDocumentLeaving = false;
const privateInvalidators = new Set();
const privateSessionSnapshot = () => { try { return localStorage.getItem('lpc_user') || ''; } catch { return ''; } };
const privateAccessError = () => Object.assign(new Error('Your Admin access changed. Refresh or sign in before continuing.'), { code: 'ACCOUNT_CHANGED' });
function invalidatePrivateState() {
  privateGeneration++;
  for (const clear of privateInvalidators) clear();
}
function changedPrivateOwner(user) {
  const next = String(user?.id || user?._id || '');
  if (next !== privateOwner || user?.role !== 'admin' || user?.status !== 'approved' || user?.disabled || user?.deleted) invalidatePrivateState();
  privateOwner = next;
}
window.addEventListener('lpc:user-updated', event => changedPrivateOwner(event.detail));
window.addEventListener('storage', event => {
  if (event.key !== 'lpc_user') return;
  let user = null;try { user = JSON.parse(event.newValue || 'null'); } catch {}
  changedPrivateOwner(user);
});
window.addEventListener('admin:admission-access-changed', event => {
  const current = getStoredSession().user;
  if (String(current?.id || current?._id || '') === String(event.detail?.ownerId || '')) invalidatePrivateState();
});
window.addEventListener('pagehide', () => { privateDocumentLeaving = true;invalidatePrivateState(); });
window.addEventListener('pageshow', event => { if (event.persisted) { privateDocumentLeaving = false;invalidatePrivateState(); } });
export function onAdminPrivateInvalidation(clear) { privateInvalidators.add(clear); }
export async function privateApi(url, options = {}) {
  if (options.method && options.method.toUpperCase() !== 'GET') return api(url, options);
  const generation = privateGeneration, snapshot = privateSessionSnapshot();
  const current = () => !privateDocumentLeaving && generation === privateGeneration && snapshot === privateSessionSnapshot();
  try {
    const result = await api(url, { ...options, noRedirect: true });
    if (!current()) throw privateAccessError();
    return result;
  } catch (error) {
    if (!current()) throw privateAccessError();
    if ([401, 403].includes(error.status)) invalidatePrivateState();
    throw error;
  }
}

import { readFinancial } from './financial-read.js';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);
export const date = value => value ? (/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T12:00:00`).toLocaleDateString() : new Date(value).toLocaleString()) : '—';
export const label = value => String(value || '—').replace(/[_.]/g, ' ');
export const person = value => [value?.firstName, value?.lastName].filter(Boolean).join(' ') || value?.email || 'Unassigned';
export async function api(url, options = {}) {
  if ((!options.method || options.method === 'GET') && /^\/api\/(?:admin\/(?:metrics|summary|analytics|income|funding-evidence|payouts|workspace\/finance\/records|workspace\/search)(?:[?]|$)|admin\/workspace\/matters\/[a-f0-9]{24}(?:[?]|$)|payments\/receipts(?:[?]|$))/.test(url)) return readFinancial(url, options);
  const response = await secureFetch(url, {
    headers: {
      Accept: 'application/json'
    },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || body.msg || 'Unable to load this information. Please try again.');
    error.status = response.status;
    throw error;
  }
  return body;
}
export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
export function visible(section) {
  return document.getElementById(`section-${section}`)?.classList.contains('visible');
}
export function routeParam(key, value) {
  const url = new URL(location.href);
  // Embedded reviews restore their selected task from the owner session. Never
  // publish a transient standalone record link while that review is loading.
  if (document.body.classList.contains('admin-flow-active') && ['account', 'ticket', 'matter', 'dispute'].includes(key)) value = '';
  if (value) url.searchParams.set(key, value);else url.searchParams.delete(key);
  history.replaceState(null, '', url);
}
