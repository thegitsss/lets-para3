import { icon } from './presentation.js';
import { registerSupportLauncher } from '../utils/support-drawer.js';

const el = id => document.getElementById(id);
function init() {
  document.body.classList.add('admin-live');
  const main = el('main');
  const groups = [
    { key: 'growth', label: 'Growth', sections: ['marketing-drafts', 'sales-workspace'] },
    { key: 'system', label: 'System', sections: ['ai-control-room', 'engineering', 'activity-logs', 'settings'] },
  ];
  for (const group of groups) {
    const old = document.querySelector(`[data-live-group="${group.key}"]`);
    const nav = document.createElement('nav');
    nav.className = 'admin-tabs admin-workspace-tabs';
    nav.setAttribute('aria-label', `${group.label} views`);
    const links = [...old.children].filter(node => node.tagName !== 'SUMMARY');
    links.sort((a, b) => {
      const order = node => group.sections.includes(node.dataset.section) ? group.sections.indexOf(node.dataset.section) : group.sections.length;
      return order(a) - order(b);
    }).forEach(node => nav.append(node));
    old.remove();
    group.nav = nav;
    for (const section of group.sections) {
      const heading = el(`section-${section}`).querySelector('h1');
      if (heading) heading.textContent = group.label;
    }
  }
  const search = el('adminSearchOpen');
  search.querySelector('span').textContent = 'Search';
  const sidebar = el('sidebarNav');
  sidebar.querySelector('.admin-nav-label')?.remove();
  sidebar.querySelector('nav').before(search);
  search.classList.add('admin-sidebar-search');
  const mobile = matchMedia('(max-width: 1024px)');
  const placeSearch = () => {
    if (mobile.matches) document.querySelector('.admin-topbar-actions').prepend(search);
    else sidebar.querySelector('nav').before(search);
  };
  mobile.addEventListener('change', placeSearch);
  placeSearch();
  const assistant = document.createElement('button');
  assistant.type = 'button'; assistant.className = 'btn secondary admin-assistant-button';
  assistant.innerHTML = `${icon('inbox')}<span>Assistant</span>`;
  registerSupportLauncher(assistant);
  document.querySelector('.admin-topbar-actions').prepend(assistant);
  el('adminSearchTitle').textContent = 'Search';
  document.querySelector('.admin-search-hint').textContent = '↑ ↓ Move · Enter Open · Esc Close';
  const brand = sidebar.querySelector('.admin-brand');
  brand.querySelector('small').textContent = 'ADMIN';
  brand.querySelector('.admin-brand-mark').textContent = 'LPC';
  const manage = document.createElement('span');
  manage.className = 'admin-nav-section'; manage.textContent = 'Manage';
  sidebar.querySelector('.admin-primary-growth').before(manage);
  const primaryGrowth = sidebar.querySelector('.admin-primary-growth');
  const primarySystem = sidebar.querySelector('.admin-primary-system');
  primaryGrowth.querySelector('svg')?.remove(); primaryGrowth.insertAdjacentHTML('afterbegin', icon('arrow'));
  primarySystem.querySelector('svg')?.remove(); primarySystem.insertAdjacentHTML('afterbegin', icon('settings'));
  sidebar.querySelector('.sidebar-footer').textContent = 'LPC Admin';
  document.querySelector('.admin-breadcrumb').firstChild.textContent = 'Admin ';

  function sync() {
    for (const group of groups) {
      const section = group.sections.map(key => el(`section-${key}`)).find(node => node.classList.contains('visible'));
      if (!section) continue;
      const header = section.querySelector(':scope > header') || section.querySelector('.admin-automation-controls > header');
      if (header && group.nav.previousElementSibling !== header) header.after(group.nav);
      const key = section.id.replace('section-', '');
      group.nav.querySelectorAll('[data-section]').forEach(button => {
        button.classList.toggle('active', button.dataset.section === key);
        if (button.dataset.section === key) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      const heading = header?.querySelector('h1');
      if (heading && heading.textContent !== group.label) heading.textContent = group.label;
    }
    // Existing tables retain their records and handlers. Only ordinary data rows
    // become labeled cards on mobile; expanded investigations stay full width.
    for (const table of main.querySelectorAll('table')) {
      // Financial reports own their keyboard-scrollable column layout.
      if (table.closest('.table-wrap[role="region"][tabindex]')) continue;
      const headings = [...table.querySelectorAll('thead tr:first-child th')].map(th => th.textContent.trim());
      if (!headings.length) continue;
      table.classList.add('admin-record-table');
      for (const row of table.querySelectorAll('tbody > tr')) {
        const cells = [...row.children];
        if (cells.length !== headings.length || cells.some(cell => cell.colSpan > 1)) continue;
        row.classList.add('admin-record-row');
        cells.forEach((cell, i) => { if (cell.dataset.label !== headings[i]) cell.dataset.label = headings[i]; });
      }
    }
  }
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sync(); });
  });
  observer.observe(main, { childList: true, subtree: true });
  for (const node of document.querySelectorAll('.section')) {
    new MutationObserver(sync).observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  sync();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);else init();
