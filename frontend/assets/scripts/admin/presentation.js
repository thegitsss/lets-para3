import { escapeHTML as esc } from './shared.js';

const paths = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a6 6 0 0 0-3-5"/>',
  matters: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 11h18"/>',
  inbox: '<path d="M4 4h16v13l-4 4H8l-4-4Z"/><path d="M4 14h5l1 3h4l1-3h5M8 8h8"/>',
  finance: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h3m5 0h2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  document: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8m-8 4h5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1a8 8 0 0 1 13 2M4.9 15.9a8 8 0 0 0 13 2"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
};
export const icon = (name, cls='') => `<svg class="admin-icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.document}</svg>`;
export function initials(name='') { return String(name).split(/\s+/).filter(Boolean).slice(0,2).map(s=>s[0]).join('').toUpperCase() || 'LP'; }
export const avatar = (name, role='') => `<span class="admin-avatar ${role==='paralegal'?'admin-avatar-sage':''}" aria-hidden="true">${esc(initials(name))}</span>`;
export function age(value) {
  const ms=Date.now()-new Date(value).getTime();
  if(!Number.isFinite(ms))return 'Date unavailable';
  if(ms<60000)return 'Just now';
  if(ms<3600000)return `${Math.floor(ms/60000)}m ago`;
  if(ms<86400000)return `${Math.floor(ms/3600000)}h ago`;
  const days=Math.floor(ms/86400000);return `${days} ${days===1?'day':'days'} ago`;
}
const statusLabels={open:'Awaiting team',in_review:'In review',waiting_on_user:'Waiting on reply',waiting_on_info:'Waiting on information',needs_reconciliation:'Needs review',pending_review:'Pending review',pending:'Pending',approved:'Approved',denied:'Denied',resolved:'Resolved',closed:'Closed',suspended:'Suspended',in_progress:'In progress'};
export const statusText=value=>statusLabels[value] || String(value||'Not recorded').replace(/[_.]/g,' ').replace(/^./,c=>c.toUpperCase());
export function badge(value,text) {
  const tone=['approved','resolved','closed','paid','succeeded','verified','clean'].includes(value)?'good':['open','in_review','pending','pending_review','needs_reconciliation','flagged'].includes(value)?'attention':['failed','blocked','suspended','denied'].includes(value)?'alert':'neutral';
  return `<span class="admin-status admin-status-${tone}">${esc(text||statusText(value))}</span>`;
}
export const emptyState=(title,description,name='check')=>`<div class="admin-empty"><span class="admin-empty-icon">${icon(name)}</span><strong>${esc(title)}</strong>${description ? `<p>${esc(description)}</p>` : ''}</div>`;
export function safeHref(value){try{const u=new URL(value,location.origin);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}}
