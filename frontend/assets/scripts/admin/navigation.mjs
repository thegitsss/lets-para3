import { icon } from './presentation.js';

// The same navigation nodes serve desktop and mobile. Native modal ownership
// keeps the closed drawer out of keyboard navigation and the open one isolated.
export function initAdminNavigation(topbar, main) {
  const sidebar = document.getElementById('sidebarNav');
  const opener = document.getElementById('sidebarToggle');
  if (!sidebar || !opener) return;
  topbar.prepend(opener);
  const desktopPosition = document.createComment('Desktop navigation position');
  sidebar.before(desktopPosition);

  const heading = document.createElement('div');
  heading.className = 'admin-navigation-heading';
  const brand = sidebar.querySelector('.admin-brand');
  brand.before(heading);
  heading.append(brand);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'admin-navigation-close';
  closeButton.setAttribute('aria-label', 'Close navigation');
  closeButton.innerHTML = icon('close');
  heading.append(closeButton);

  const drawer = document.createElement('dialog');
  drawer.id = 'adminNavigationDialog';
  drawer.className = 'admin-navigation-dialog';
  drawer.setAttribute('aria-label', 'Admin navigation');
  document.body.append(drawer);
  opener.setAttribute('aria-controls', drawer.id);
  opener.setAttribute('aria-haspopup', 'dialog');
  const mobile = matchMedia('(max-width: 1024px)');
  const syncOpen = () => {
    document.body.classList.toggle('nav-open', drawer.open);
    opener.setAttribute('aria-expanded', String(drawer.open));
  };
  const close = () => {
    if (drawer.open) drawer.close();
    syncOpen();
  };
  const selectedLink = () => sidebar.querySelector('[aria-current="page"]') || closeButton;
  const updateMode = () => {
    const focusedNavigation = sidebar.contains(document.activeElement);
    if (mobile.matches) {
      drawer.append(sidebar);
      if (focusedNavigation) opener.focus({ preventScroll: true });
    } else {
      const wasOpen = drawer.open;
      close();
      desktopPosition.after(sidebar);
      if (focusedNavigation || wasOpen) selectedLink().focus({ preventScroll: true });
    }
  };
  opener.addEventListener('click', () => {
    if (!mobile.matches) return;
    if (drawer.open) { close(); return; }
    opener.focus({ preventScroll: true });
    drawer.showModal();
    syncOpen();
    selectedLink().focus({ preventScroll: true });
  });
  closeButton.addEventListener('click', close);
  drawer.addEventListener('close', syncOpen);
  // Native modality excludes the page, but Tab can still leave for browser
  // chrome. Keep the navigation's visible first/last controls in one cycle.
  drawer.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...drawer.querySelectorAll('button:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')]
      .filter(control => control.getClientRects().length && !control.closest('[hidden], [inert]') && getComputedStyle(control).visibility !== 'hidden');
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  // Dismiss before the guided flow's sidebar capture handler can hold or
  // reject navigation, so its pending/blocked feedback is on the visible page.
  drawer.addEventListener('click', event => {
    if (event.target === drawer) {
      const bounds = drawer.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    } else if (event.target instanceof Element && event.target.closest('[data-section], a[href], #logoutBtn')) {
      close();
    }
  }, true);
  mobile.addEventListener('change', updateMode);
  updateMode();

  // Focus scrolling must account for the actual toolbar height after text
  // enlargement or a responsive change, rather than a fixed spacer.
  const sizeToolbar = () => main.style.setProperty('--admin-toolbar-height', `${topbar.getBoundingClientRect().height}px`);
  new ResizeObserver(sizeToolbar).observe(topbar);
  sizeToolbar();
}
