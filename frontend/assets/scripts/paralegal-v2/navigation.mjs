// One sidebar and one header toggle serve desktop collapse and the mobile dialog,
// following Attorney V2's navigation behavior.
export function createNavigation({ ready, beforeOpen }) {
  const sidebar = document.querySelector('[data-v2-persistent="sidebar"]');
  const opener = document.querySelector('[data-v2-mobile-menu]');
  const closeButton = sidebar.querySelector('[data-v2-navigation-close]');
  const position = document.createComment('Desktop navigation position');
  sidebar.before(position);
  const drawer = document.createElement('dialog');
  drawer.id = 'v2-navigation-dialog';
  drawer.className = 'v2-navigation-dialog';
  drawer.setAttribute('aria-label', 'Workspace navigation');
  document.body.append(drawer);
  const mobile = matchMedia('(max-width: 900px)');
  let modeVersion = 0;
  const sync = () => {
    document.body.classList.toggle('v2-nav-open', drawer.open);
    sidebar.inert = !ready() || (mobile.matches && !drawer.open);
    const expanded = mobile.matches ? drawer.open : !document.body.classList.contains('v2-sidebar-collapsed');
    opener.setAttribute('aria-expanded', String(expanded));
    opener.setAttribute('aria-label', mobile.matches ? 'Open navigation' : expanded ? 'Collapse navigation' : 'Expand navigation');
    opener.setAttribute('aria-controls', mobile.matches ? drawer.id : sidebar.id);
    opener.dataset.collapseLabel = expanded ? 'Collapse' : 'Expand';
    if (mobile.matches) opener.title = opener.getAttribute('aria-label');
    else opener.removeAttribute('title');
    sidebar.querySelectorAll('.v2-nav-link').forEach(link => {
      if (!mobile.matches && !expanded) link.title = link.textContent.trim();
      else link.removeAttribute('title');
    });
    if (mobile.matches) opener.setAttribute('aria-haspopup', 'dialog');
    else opener.removeAttribute('aria-haspopup');
  };
  function close() {
    if (drawer.open) drawer.close();
    sync();
  }
  function selectedLink() {
    const selected = sidebar.querySelector('[aria-current="page"]');
    if (selected) {
      selected.closest('details')?.setAttribute('open', '');
      const subnav = selected.closest('#v2-matter-subnav');
      if (subnav) {
        subnav.hidden = false;
        const toggle = sidebar.querySelector('[data-v2-matters-toggle]');
        toggle?.setAttribute('aria-expanded', 'true');
        toggle?.setAttribute('aria-label', 'Collapse Matters navigation');
      }
    }
    return selected || sidebar.querySelector('a');
  }
  function updateMode() {
    const version = ++modeVersion;
    const focusedNavigation = sidebar.contains(document.activeElement);
    document.body.classList.remove('v2-sidebar-collapsed');
    let focusTarget = null;
    if (mobile.matches) {
      drawer.append(sidebar);
      if (focusedNavigation) focusTarget = opener;
    } else {
      const wasOpen = drawer.open;
      close(); position.after(sidebar);
      if (focusedNavigation || wasOpen) focusTarget = selectedLink();
    }
    sync();
    if (focusTarget && ready()) {
      focusTarget.focus({ preventScroll: true });
      // WebKit can retain the closed dialog's inert layout for the remainder
      // of this breakpoint event. Retry after layout only if focus is unowned.
      if (document.activeElement !== focusTarget) requestAnimationFrame(() => {
        if (version === modeVersion && ready() && [document.body, opener].includes(document.activeElement)) focusTarget.focus({ preventScroll: true });
      });
    }
  }
  opener.addEventListener('click', () => {
    if (!ready()) return;
    if (!mobile.matches) {
      document.body.classList.toggle('v2-sidebar-collapsed');
      if (document.body.classList.contains('v2-sidebar-collapsed')) {
        const menu = sidebar.querySelector('[data-v2-profile-menu]');
        if (menu) menu.hidden = true;
        sidebar.querySelector('[data-v2-profile-trigger]')?.setAttribute('aria-expanded', 'false');
      }
      sync();
      return;
    }
    if (drawer.open) { close(); return; }
    beforeOpen();
    opener.focus({ preventScroll: true });
    drawer.showModal(); sync(); selectedLink()?.focus({ preventScroll: true });
  });
  closeButton.addEventListener('click', close);
  drawer.addEventListener('close', sync);
  drawer.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...drawer.querySelectorAll('button:not(:disabled), a[href], summary')]
      .filter(el => el.getClientRects().length && !el.closest('[hidden], [inert]') && getComputedStyle(el).visibility !== 'hidden');
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  drawer.addEventListener('click', event => {
    if (event.target === drawer) {
      const box = drawer.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    } else if (event.target instanceof Element && event.target.closest('a[href]') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      // Dismiss before routing so page focus and any guarded-navigation dialog
      // remain reachable. Native details disclosures are not navigation.
      close();
    }
  }, true);
  window.addEventListener('lpc:v2-route-changed', event => {
    selectedLink();
    if (!event.detail?.refresh) close();
  });
  mobile.addEventListener('change', updateMode);
  updateMode();
  return Object.freeze({ close });
}
