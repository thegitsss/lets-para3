import { initSecondaryViews } from './secondary.js';
import { initGrowth } from './growth.js';
import { initUsability } from './usability.js';
import { initSystem } from './system.js';
import { initCalmAdmin } from './calm.js';
import { api, onAdminPrivateInvalidation, escapeHTML as esc } from './shared.js';
import { readFinancial, money } from './financial-read.js';
import { readExecutive } from './executive.js';
const el = id => document.getElementById(id);
function init() {
  const params = new URL(location.href).searchParams;
  if (params.get('view') === 'queue') return;
  document.body.classList.add('admin-menu-mode');
  initCalmAdmin();
  initSystem();
  initUsability();
  initGrowth();
  initSecondaryViews();
  const overview = el('section-overview');
  const menu = document.createElement('div');
  menu.id = 'adminSimpleMenu';
  const items = [
    ['signups', 'New user signups', 'admin-dashboard.html?area=signups#user-management', 'Awaiting review', '/api/admin/pending-users?status=pending&limit=1', data => data.total],
    ['photos', 'Photos', 'admin-dashboard.html?area=photos#photo-reviews', 'Awaiting review', '/api/admin/profile-photos?status=pending_review', data => Array.isArray(data.items) ? data.items.length : null],
    ['requests', 'Human requests', 'admin-dashboard.html?area=requests&inbox=human#support-ops', 'Awaiting review', '/api/admin/support/inbox-summary', data => data.human],
    ['finances', 'Finances', 'admin-dashboard.html#finance', 'Payment exceptions', '/api/admin/workspace/attention', data => { const valid = [data.money, data.chargebacks, data.disputes].every(value => Number.isSafeInteger(value) && value >= 0); document.dispatchEvent(new CustomEvent('admin:finance-attention', { detail: valid ? data : null })); return valid ? data.money + data.chargebacks + data.disputes : null; }],
    ['security', 'Security', 'profile-settings.html#security', 'Your active sessions', '/api/account/sessions', data => data.total],
  ];
  menu.innerHTML = `<header><h1>Overview</h1></header><div class="admin-executive-summary"><article class="admin-earnings-card" aria-label="Monthly platform earnings"><span class="admin-card-label">Platform earnings</span><strong class="admin-card-count" id="adminPlatformEarnings" role="status">—</strong><span class="admin-card-caption" id="adminPlatformEarningsPeriod">This month · Live platform fees</span></article><section class="admin-business-signals" aria-labelledby="adminBusinessSignalsTitle"><h2 id="adminBusinessSignalsTitle">This month</h2><dl><div><dt>Attorney signups</dt><dd id="adminAttorneyRegistrations">—</dd></div><div><dt>Paralegal signups</dt><dd id="adminParalegalRegistrations">—</dd></div><div><dt>Matters posted</dt><dd id="adminMattersPosted">—</dd></div><div><dt>Hires</dt><dd id="adminMattersHired">—</dd></div></dl><p id="adminMarketplaceState"></p><p id="adminExecutiveStatus" role="status">Checking business figures…</p></section></div><details id="adminExecutiveDetails" class="admin-executive-details"><summary>Business details</summary><dl id="adminExecutiveMeasurements"></dl><ul id="adminExecutiveLimitations"></ul></details><details class="admin-overview-shortcuts" id="adminOverviewShortcuts"><summary>Sections</summary><nav aria-label="Admin sections">${items.map(([key, label, href, caption]) => `<a href="${href}" aria-label="View ${label.toLowerCase()}"><span class="admin-card-label">${label}</span><strong id="adminCardCount-${key}" class="admin-card-count">—</strong><span class="admin-card-caption" id="adminCardCaption-${key}">${caption}</span></a>`).join('')}</nav></details>`;
  const shortcuts = menu.querySelector('#adminOverviewShortcuts');
  const flow = el('adminFlow'), today = overview.querySelector('.admin-today-details');
  if (today) {
    const background = today.querySelector('.admin-background-status');
    if (background) menu.querySelector('#adminExecutiveDetails').before(background);

  }
  const details = menu.querySelector('#adminExecutiveDetails');
  const estimate = document.createElement('p'); estimate.id = 'adminReviewTimeEstimate'; estimate.hidden = true;
  if (flow) flow.querySelector(':scope > header').after(estimate);
  if (flow) details.before(flow);
  if (today) details.before(today);
  overview.prepend(menu);
  let executiveRequest = 0, earningsRequest = 0, countsRequest = 0;
  let queueRemaining, estimateData = null;
  function syncEstimate() {
    const remaining = queueRemaining === undefined ? estimateData?.remaining : queueRemaining;
    const review = flow?.querySelector('[data-today-view=review]')?.getAttribute('aria-selected') === 'true';
    const current = review && estimateData && remaining > 0 && remaining === estimateData.remaining;
    estimate.hidden = !current;
    estimate.textContent = current ? `Estimated review time: ${estimateData.minutes.toLocaleString()} min` : '';
    const measurement = el('adminReviewTimeMeasurement'); if (measurement) measurement.hidden = !current;
  }
  document.addEventListener('admin:queue-state', event => {
    const remaining = event.detail?.remaining; queueRemaining = Number.isSafeInteger(remaining) && remaining >= 0 ? remaining : null; syncEstimate();
  });
  for (const type of ['click', 'keydown']) flow?.querySelector('.admin-today-tabs')?.addEventListener(type, syncEstimate);
  const clearBusiness = () => {
    executiveRequest++; earningsRequest++; countsRequest++;
    for (const [key] of items) { el(`adminCardCount-${key}`).textContent = '—'; el(`adminCardCaption-${key}`).textContent = 'Count unavailable'; }
    for (const id of ['adminAttorneyRegistrations','adminParalegalRegistrations','adminMattersPosted','adminMattersHired','adminPlatformEarnings']) el(id).textContent = '—';
    el('adminMarketplaceState').textContent = ''; el('adminExecutiveStatus').textContent = 'Business figures unavailable.';
    el('adminPlatformEarningsPeriod').textContent = 'Earnings unavailable';
    el('adminExecutiveMeasurements').replaceChildren(); el('adminExecutiveLimitations').replaceChildren();
    queueRemaining = null; estimateData = null; syncEstimate();
  };
  onAdminPrivateInvalidation(clearBusiness);
  window.addEventListener('admin:financial-account-changed', clearBusiness);
  window.addEventListener('admin:financial-source-changed', clearBusiness);
  window.addEventListener('pagehide', clearBusiness);
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
  function renderEarnings(data) {
    const valid = data?.available && data.currency === 'USD' && data.stripeMode === 'live' && data.period === 'month' && Number.isSafeInteger(data.amount) && data.amount >= 0;
    el('adminPlatformEarnings').textContent = valid ? money(data.amount, data.currency) : '—';
    el('adminPlatformEarningsPeriod').textContent = valid ? 'This month · Live platform fees' : 'Earnings unavailable';
    document.dispatchEvent(new CustomEvent('admin:earnings-evidence', { detail: { available: !!valid } }));
  }
  async function refreshEarnings() {
    const request = ++earningsRequest;
    try { const data = await readFinancial('/api/admin/workspace/finance/earnings', { suppressToast: true }); if (request === earningsRequest) renderEarnings(data); }
    catch (_) { if (request === earningsRequest) renderEarnings(null); }
  }
  const rate = value => value && Number.isFinite(value.rate) && value.rate >= 0 && value.rate <= 100 ? `${value.rate.toFixed(1).replace(/\.0$/, '')}% (${number(value.numerator)} of ${number(value.denominator)})` : 'Not available';
  const duration = value => value && Number.isFinite(value.hours) && value.hours >= 0 && value.samples > 0 ? `${value.hours.toFixed(1).replace(/\.0$/, '')} hours · ${number(value.samples)} records` : 'Not available';
  function renderMetrics(metrics) {
    const acquisition = metrics?.sources?.acquisition?.available === true ? metrics.acquisition : null;
    const marketplace = metrics?.sources?.marketplace?.available === true ? metrics.marketplace : null;
    el('adminAttorneyRegistrations').textContent = number(acquisition?.attorneys?.registeredThisMonth);
    el('adminParalegalRegistrations').textContent = number(acquisition?.paralegals?.registeredThisMonth);
    el('adminMattersPosted').textContent = number(marketplace?.postedThisMonth);
    el('adminMattersHired').textContent = number(marketplace?.hiredThisMonth);
    el('adminMarketplaceState').textContent = marketplace ? `${number(marketplace.active)} active engagements · ${number(marketplace.unfilled)} open matters · ${number(marketplace.blocked)} need checking` : 'Engagement status unavailable.';
    const incomplete = !acquisition || !marketplace;
    el('adminExecutiveStatus').textContent = incomplete ? 'Some business figures are unavailable.' : '';
    const rows = [
      ['Attorneys making a first post', rate(acquisition?.attorneys?.firstPostConversion), acquisition?.attorneys?.firstPostConversion?.definition],
      ['Posted matters leading to a hire', rate(marketplace?.postedToHire), marketplace?.postedToHire?.definition],
      ['Paralegal activation', rate(acquisition?.paralegals?.activation), acquisition?.paralegals?.activation?.definition],
      ['Paralegals obtaining an engagement', rate(acquisition?.paralegals?.engagement), acquisition?.paralegals?.engagement?.definition],
      ['Time to hire', duration(marketplace?.timeToHire), 'Measured from recorded posting and hiring dates.'],
      ['Time to complete', duration(marketplace?.timeToComplete), 'Measured from recorded hiring and completion dates.'],
      ['Unresolved support', number(metrics?.customerExperience?.unresolved), 'Open support records, including work waiting on a reply.'],
      ['Owner decisions this month', number(metrics?.owner?.decisionsThisMonth), 'Recorded decisions. Time spent is not inferred from a click.'],
      ['Background actions this month', number(metrics?.automation?.recordedActionsThisMonth), 'Recorded completed background actions; this does not establish success of every workflow.'],
      ['Email delivery attempts', metrics?.automation?.delivery ? `${number(metrics.automation.delivery.accepted)} accepted · ${number(metrics.automation.delivery.failed)} failed · ${number(metrics.automation.delivery.unknown)} unknown` : 'Not available', 'Provider acceptance records, not confirmation that a recipient read an email.'],
      ['Email acceptance rate', Number.isFinite(metrics?.automation?.delivery?.successRate) ? `${metrics.automation.delivery.successRate.toFixed(1).replace(/\.0$/, '')}%` : 'Not available', 'Available only when delivery-attempt records have complete coverage.'],
    ];
    el('adminExecutiveMeasurements').innerHTML = rows.map(([title, value, definition]) => `<div><dt>${esc(title)}</dt><dd>${esc(value)}${definition ? `<small>${esc(definition)}</small>` : ''}</dd></div>`).join('');
    el('adminExecutiveLimitations').innerHTML = (Array.isArray(metrics?.limitations) ? metrics.limitations : []).map(row => typeof row === 'string' ? row : row.message).filter(Boolean).map(message => `<li>${esc(message)}</li>`).join('');
  }
  async function refreshExecutive() {
    if (document.hidden || !overview.classList.contains('visible')) return;
    const request = ++executiveRequest;
    try {
      const data = await readExecutive(); if (request !== executiveRequest) return;
      renderMetrics(data.metrics);
      const minutes = data.ownerTime?.estimatedMinutes;
      const estimated = data.ownerTime?.available === true && data.ownerTime?.estimate === true && Number.isSafeInteger(minutes) && minutes >= 0;
      estimateData = estimated ? { minutes, remaining: data.decisions?.remaining } : null;
      if (estimated) el('adminExecutiveMeasurements').insertAdjacentHTML('beforeend', `<div id="adminReviewTimeMeasurement"><dt>Estimated review time</dt><dd>${esc(minutes.toLocaleString())} minutes<small>${esc(data.ownerTime.definition || 'Planning estimate, not measured owner time.')}</small></dd></div>`);
      syncEstimate();

      const earnings = data.financial?.earnings || data.metrics?.financial?.earnings || (data.financial?.period === 'month' ? data.financial : null);
      if (earnings) { earningsRequest++; renderEarnings(earnings); } else void refreshEarnings();
      document.dispatchEvent(new CustomEvent('admin:executive-data', { detail: data }));
    } catch (_) {
      if (request !== executiveRequest) return;
      renderMetrics(null); estimateData = null; syncEstimate(); void refreshEarnings();
      document.dispatchEvent(new Event('admin:executive-unavailable'));
    }
  }
  let refreshing = false;
  async function refreshCounts() {
    if (refreshing || document.hidden || !overview.classList.contains('visible') || !shortcuts.open) return;
    refreshing = true; const request = ++countsRequest;
    try {
      await Promise.all(items.map(async ([key, , , caption, url, read]) => {
        try {
          const target = key === 'security' ? `${url}?expectedOwnerId=${encodeURIComponent((await api('/api/auth/me')).user.id)}` : url;
          const value = read(await api(target, { suppressToast: true }));
          if (request !== countsRequest) return;
          if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count');
          el(`adminCardCount-${key}`).textContent = value.toLocaleString(); el(`adminCardCaption-${key}`).textContent = caption;
        } catch { if (request !== countsRequest) return; el(`adminCardCount-${key}`).textContent = '—'; el(`adminCardCaption-${key}`).textContent = 'Count unavailable'; }
      }));
    } finally { refreshing = false; }
  }
  const refreshVisible = () => { void refreshExecutive(); void refreshCounts(); };
  shortcuts.addEventListener('toggle', () => { if (shortcuts.open) void refreshCounts(); });
  window.addEventListener('focus', refreshVisible);
  document.addEventListener('visibilitychange', refreshVisible);
  setInterval(refreshVisible, 60000);
  let refreshTimer;
  for (const event of ['admin:admissions-changed', 'admin:work-saved']) window.addEventListener(event, () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshVisible, 250); });
  const home = document.querySelector('#sidebarNav [data-section="overview"]');
  [...home.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).forEach(node => node.textContent = 'Overview');
  const back = document.createElement('a');
  back.id = 'adminMenuBack'; back.href = 'admin-dashboard.html#overview'; back.textContent = '← Menu';
  document.querySelector('.admin-topbar').prepend(back);
  const people = el('section-user-management');
  const inbox = el('section-support-ops');
  const peopleTitle = people.querySelector('h1').textContent;
  const inboxTitle = inbox.querySelector('h1').textContent;
  let navigating = false;
  async function navigate(href) {
    if (navigating) return;
    navigating = true;
    try {
      await window.flushAdminAccountDraft?.();
      await window.flushAdminInquiryDraft?.();
      const url = new URL(href, location.href);
      if (url.href !== location.href) history.pushState(null, '', url);
      applyRoute();
    } catch (error) {
      window.toastUtils?.show(error.message || 'Your draft could not be saved. Try again.', { targetId: 'toastBanner', type: 'err' });
    } finally { navigating = false; }
  }
  function follow(event) {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href);
    // Other applications and the separately assembled queue retain their own entry.
    if (url.origin !== location.origin || url.pathname !== location.pathname || url.searchParams.get('view') !== new URL(location.href).searchParams.get('view')) return;
    event.preventDefault();
    void navigate(url.href);
  }
  menu.addEventListener('click', follow);
  back.addEventListener('click', follow);
  addEventListener('popstate', applyRoute);
  function sync() {
    const atMenu = overview.classList.contains('visible');
    document.body.classList.toggle('admin-at-menu', atMenu);
    back.hidden = atMenu;
    if (atMenu) { el('adminCurrentWorkspace').textContent = 'Overview'; refreshVisible(); }
  }
  new MutationObserver(sync).observe(overview, { attributes: true, attributeFilter: ['class'] });
  sync();
  function applyRoute() {
    const route = new URL(location.href);
    const area = route.searchParams.get('area');
    people.classList.toggle('admin-single-area', area === 'signups' || area === 'photos');
    inbox.classList.toggle('admin-single-area', area === 'requests');
    people.querySelector('h1').textContent = area === 'photos' ? 'Photos' : area === 'signups' ? 'New user signups' : peopleTitle;
    inbox.querySelector('h1').textContent = area === 'requests' ? 'Human requests' : inboxTitle;
    if (area === 'signups' || area === 'photos') {
      window.showAdminUsers?.(area === 'photos' ? 'photos' : 'applications', { navigate: false });
    } else if (route.searchParams.has('people')) {
      window.showAdminUsers?.(route.searchParams.get('people'), { navigate: false });
    }
    if (area === 'requests') window.openAdminInbox?.('human');
    window.activateAdminSection?.(route.hash.slice(1) || 'overview', { syncHash: false });
    sync();
  }
  applyRoute();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
