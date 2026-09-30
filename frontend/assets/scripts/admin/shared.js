import { secureFetch } from '../auth.js';
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
  if (value) url.searchParams.set(key, value);else url.searchParams.delete(key);
  history.replaceState(null, '', url);
}
