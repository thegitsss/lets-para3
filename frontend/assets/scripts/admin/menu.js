import { initUsability } from './usability.js';
import { initSystem } from './system.js';
import { initCalmAdmin } from './calm.js';
import { api } from './shared.js';
const el = id => document.getElementById(id);
function init() {
  const params = new URL(location.href).searchParams;
  if (params.get('view') === 'queue') return;
  document.body.classList.add('admin-menu-mode');
  initCalmAdmin();
  initSystem();
  initUsability();
  const overview = el('section-overview');
  const menu = document.createElement('div');
  menu.id = 'adminSimpleMenu';
  const items = [
    ['signups', 'New user signups', 'admin-dashboard.html?area=signups#user-management', 'Awaiting review', '/api/admin/pending-users?status=pending&limit=1', data => data.total],
    ['photos', 'Photos', 'admin-dashboard.html?area=photos#photo-reviews', 'Awaiting review', '/api/admin/profile-photos?status=pending_review', data => Array.isArray(data.items) ? data.items.length : null],
    ['requests', 'Human requests', 'admin-dashboard.html?area=requests&inbox=human#support-ops', 'Awaiting review', '/api/admin/support/inbox-summary', data => data.human],
    ['finances', 'Finances', 'admin-dashboard.html#finance', 'Payment exceptions', '/api/admin/workspace/attention', data => Number.isSafeInteger(data.money) && Number.isSafeInteger(data.chargebacks) ? data.money + data.chargebacks : null],
    ['security', 'Security', 'profile-settings.html#security', 'Your active sessions', '/api/account/sessions', data => data.total],
  ];
  menu.innerHTML = `<header><h1>Overview</h1></header><nav aria-label="Admin tasks">${items.map(([key, label, href, caption]) => `<a href="${href}" aria-label="View ${label.toLowerCase()}"><span class="admin-card-label">${label}</span><strong id="adminCardCount-${key}" class="admin-card-count">—</strong><span class="admin-card-caption" id="adminCardCaption-${key}">${caption}</span></a>`).join('')}</nav>`;
  overview.prepend(menu);
  let refreshing = false;
  async function refreshCounts() {
    if (refreshing || document.hidden || !overview.classList.contains('visible')) return;
    refreshing = true;
    try {
      await Promise.all(items.map(async ([key, , , caption, url, read]) => {
        try {
          const target = key === 'security' ? `${url}?expectedOwnerId=${encodeURIComponent((await api('/api/auth/me')).user.id)}` : url;
          const value = read(await api(target));
          if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count');
          el(`adminCardCount-${key}`).textContent = value.toLocaleString();
          el(`adminCardCaption-${key}`).textContent = caption;
        } catch {
          el(`adminCardCount-${key}`).textContent = '—';
          el(`adminCardCaption-${key}`).textContent = 'Count unavailable';
        }
      }));
    } finally { refreshing = false; }
  }
  window.addEventListener('focus', refreshCounts);
  document.addEventListener('visibilitychange', refreshCounts);
  setInterval(refreshCounts, 60000);
  const home = document.querySelector('#sidebarNav [data-section="overview"]');
  [...home.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).forEach(node => node.textContent = 'Overview');
  const back = document.createElement('a');
  back.id = 'adminMenuBack'; back.href = 'admin-dashboard.html#overview'; back.textContent = '← Menu';
  document.querySelector('.admin-topbar').prepend(back);
  back.addEventListener('click', async event => {
    event.preventDefault();
    try {
      await window.flushAdminAccountDraft?.();
      await window.flushAdminInquiryDraft?.();
      location.assign(back.href);
    } catch (error) {
      window.toastUtils?.show(error.message || 'Your draft could not be saved. Try again.', { targetId: 'toastBanner', type: 'err' });
    }
  });
  function sync() {
    const atMenu = overview.classList.contains('visible');
    document.body.classList.toggle('admin-at-menu', atMenu);
    back.hidden = atMenu;
    if (atMenu) { el('adminCurrentWorkspace').textContent = 'Overview'; refreshCounts(); }
  }
  new MutationObserver(sync).observe(overview, { attributes: true, attributeFilter: ['class'] });
  sync();
  const area = params.get('area');
  if (area === 'signups' || area === 'photos') {
    window.showAdminUsers?.(area === 'photos' ? 'photos' : 'applications', { navigate: false });
    el('section-user-management').classList.add('admin-single-area');
    el('section-user-management').querySelector('h1').textContent = area === 'photos' ? 'Photos' : 'New user signups';
  }
  if (area === 'requests') {
    el('section-support-ops').classList.add('admin-single-area');
    el('section-support-ops').querySelector('h1').textContent = 'Human requests';
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
