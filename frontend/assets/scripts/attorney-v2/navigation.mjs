// One sidebar serves both desktop and the native mobile drawer. Session
// protection always dismisses it before the shell is quarantined.
export function createNavigation({ ready, beforeOpen }) {
  const sidebar = document.querySelector('[data-av2-persistent="sidebar"]');
  const opener = document.querySelector('[data-av2-nav-toggle]');
  const closer = sidebar.querySelector('[data-av2-navigation-close]');
  const accountMenu = sidebar.querySelector('.av2-brand-menu');
  document.addEventListener('pointerdown', event => {
    if (accountMenu?.open && !accountMenu.contains(event.target)) accountMenu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && accountMenu?.open) {
      event.preventDefault();
      accountMenu.open = false;
      accountMenu.querySelector('summary').focus();
    }
  });
  accountMenu?.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('a[href]')) accountMenu.open = false;
  });
  accountMenu?.querySelector('summary')?.addEventListener('click', () => {
    if (!accountMenu.open) beforeOpen();
  });
  const position = document.createComment('Attorney desktop navigation position');
  sidebar.before(position);
  const drawer = document.createElement('dialog');
  drawer.id = 'av2-navigation-dialog';
  drawer.className = 'av2-navigation-dialog';
  drawer.setAttribute('aria-label', 'Attorney navigation');
  document.body.append(drawer);
  const mobile = matchMedia('(max-width: 900px)');
  let modeVersion = 0;

  function sync() {
    document.body.classList.toggle('av2-nav-open', drawer.open);
    sidebar.inert = mobile.matches && !drawer.open;
    const expanded = mobile.matches ? drawer.open : !document.body.classList.contains('av2-collapsed');
    opener.setAttribute('aria-expanded', String(expanded));
    opener.setAttribute('aria-label', mobile.matches ? 'Open navigation' : expanded ? 'Collapse navigation' : 'Expand navigation');
    opener.setAttribute('aria-controls', mobile.matches ? drawer.id : sidebar.id);
    opener.dataset.collapseLabel = expanded ? 'Collapse' : 'Expand';
    if (mobile.matches) opener.title = opener.getAttribute('aria-label');
    else opener.removeAttribute('title');
    sidebar.querySelectorAll('.av2-nav a').forEach(link => {
      if (!mobile.matches && !expanded) link.title = link.textContent.trim();
      else link.removeAttribute('title');
    });
    if (mobile.matches) opener.setAttribute('aria-haspopup', 'dialog');
    else opener.removeAttribute('aria-haspopup');
  }
  function close() { if (drawer.open) drawer.close(); if (accountMenu) accountMenu.open = false; sync(); }
  const selectedLink = () => {
    const selected = sidebar.querySelector('[aria-current="page"]') || sidebar.querySelector('a');
    return selected?.closest('details:not([open])')?.querySelector('summary') || selected;
  };
  function updateMode() {
    const version = ++modeVersion;
    const focusedNavigation = sidebar.contains(document.activeElement);
    document.body.classList.remove('av2-collapsed');
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
      // WebKit may retain the closed dialog's inert layout until the next frame.
      if (document.activeElement !== focusTarget) requestAnimationFrame(() => {
        if (version === modeVersion && ready() && [document.body, opener].includes(document.activeElement)) focusTarget.focus({ preventScroll: true });
      });
    }
  }
  opener.addEventListener('click', () => {
    if (!ready()) return;
    if (!mobile.matches) { document.body.classList.toggle('av2-collapsed'); sync(); return; }
    if (drawer.open) { close(); return; }
    beforeOpen(); opener.focus({ preventScroll: true });
    drawer.showModal(); sync(); selectedLink()?.focus({ preventScroll: true });
  });
  closer.addEventListener('click', close);
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
    } else if (event.target instanceof Element && event.target.closest('a[href]') && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) close();
  }, true);
  mobile.addEventListener('change', updateMode);
  updateMode();
  return Object.freeze({ close });
}
