// Keep one persistent sidebar. Native modality owns mobile background isolation;
// the desktop shell retains its original scroll and collapse behavior.
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
  opener.setAttribute('aria-controls', drawer.id);
  opener.setAttribute('aria-haspopup', 'dialog');
  const mobile = matchMedia('(max-width: 900px)');
  let modeVersion = 0;
  const sync = () => {
    document.body.classList.toggle('v2-nav-open', drawer.open);
    opener.setAttribute('aria-expanded', String(drawer.open));
  };
  function close() {
    if (drawer.open) drawer.close();
    sync();
  }
  function selectedLink() {
    const selected = sidebar.querySelector('[aria-current="page"]');
    if (selected) selected.closest('details')?.setAttribute('open', '');
    return selected || sidebar.querySelector('a');
  }
  function updateMode() {
    const version = ++modeVersion;
    const focusedNavigation = sidebar.contains(document.activeElement);
    let focusTarget = null;
    if (mobile.matches) {
      drawer.append(sidebar);
      if (focusedNavigation) focusTarget = opener;
    } else {
      const wasOpen = drawer.open;
      close(); position.after(sidebar);
      if (focusedNavigation || wasOpen) focusTarget = selectedLink();
    }
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
      // WebKit can retain the closed dialog's inert layout for the remainder
      // of this breakpoint event. Retry after layout only if focus is unowned.
      if (document.activeElement !== focusTarget) requestAnimationFrame(() => {
        if (version === modeVersion && ready() && [document.body, opener].includes(document.activeElement)) focusTarget.focus({ preventScroll: true });
      });
    }
  }
  opener.addEventListener('click', () => {
    if (!mobile.matches || !ready()) return;
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
