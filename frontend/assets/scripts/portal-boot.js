/* First-document reveal only. Authentication and each view still own their data. */
(function installPortalBoot() {
  'use strict';
  if (window.LPC_PORTAL_BOOT) return;
  // Explicit original-workspace and provider-return entries do not adopt V2.
  const entry = new URLSearchParams(location.search);
  if (window.lpcWorkspaceEntryGuard && (entry.get('workspace') === 'legacy' || entry.has('cardSetup'))) return;
  const root = document.documentElement;
  root.dataset.lpcBoot = 'loading';
  try {
    const theme = String(JSON.parse(localStorage.getItem('lpc_user') || 'null')?.preferences?.theme || '').trim().toLowerCase();
    root.dataset.lpcBootTheme = /dark$/.test(theme) || theme === 'system' && (new Date().getHours() < 7 || new Date().getHours() >= 19) ? 'dark' : 'light';
  } catch { root.dataset.lpcBootTheme = 'light'; }
  let screen, outlet, ticket = 0, prerequisites = false, forced = false;
  let released = false, preparing = false, quietTimer, epoch = 0, recoveryRequested = false;
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const watchdog = setTimeout(recover, 12000);
  function mount() {
    screen ||= document.querySelector('[data-lpc-boot-screen]');
    if (!screen || screen.open || released) return;
    // The HTML parser may expose the dialog before its children arrive.
    const retry = screen.querySelector('[data-lpc-boot-retry]');
    if (!retry || !screen.querySelector('[data-lpc-boot-label]')) return;
    screen.addEventListener('cancel', event => event.preventDefault());
    retry.addEventListener('click', () => location.reload());
    try { screen.showModal(); } catch { screen.setAttribute('open', ''); }
    if (recoveryRequested) recover();
  }
  function recover(message) {
    if (released) return;
    recoveryRequested = true;
    mount();
    const label = screen?.querySelector('[data-lpc-boot-label]');
    const retry = screen?.querySelector('[data-lpc-boot-retry]');
    if (!label || !retry) return;
    screen.dataset.recovery = '';
    screen.setAttribute('aria-busy', 'false');
    label.textContent = typeof message === 'string' ? message : 'Your workspace is taking longer to load.';
    retry.hidden = false;
  }
  function visible(element) {
    return element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
  }
  function busy() {
    if (forced) return false;
    if (!outlet?.isConnected || outlet.getAttribute('aria-busy') === 'true') return true;
    if (root.hasAttribute('data-attorney-state') && root.dataset.attorneyState !== 'ready') return true;
    if (document.body?.hasAttribute('data-v2-session') && document.body.dataset.v2Session !== 'ready') return true;
    return [...outlet.querySelectorAll('[aria-busy="true"],[data-state="loading"],[data-home-loading="true"]')].some(visible);
  }
  function finish() {
    if (released) return;
    released = true;
    clearTimeout(watchdog); clearTimeout(quietTimer);
    observer.disconnect(); resizeObserver?.disconnect();
    document.fonts?.removeEventListener('loadingdone', changed);
    window.removeEventListener('resize', changed);
    root.dataset.lpcBoot = 'ready';
    const close = () => {
      if (screen?.open) screen.close();
      screen?.remove(); resolveFinished();
      if (forced) document.querySelector('[data-av2-gate] button,[data-v2-session-recovery] button')?.focus({ preventScroll: true });
    };
    if (screen?.open && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      screen.dataset.leaving = '';
      setTimeout(close, 160);
    } else close();
  }
  async function attempt() {
    if (released || preparing || !prerequisites || busy()) return;
    preparing = true;
    const revision = ticket, version = epoch;
    try {
      if (!forced) {
        await document.fonts?.ready;
        // Non-lazy images keep their reserved layout; broken images cannot trap boot.
        const images = [...document.querySelectorAll('img[src]:not([loading="lazy"])')];
        await Promise.race([
          Promise.allSettled(images.map(img => img.decode?.())),
          new Promise(resolve => setTimeout(resolve, 1500)),
        ]);
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!released && revision === ticket && version === epoch && !busy()) finish();
    } finally {
      preparing = false;
      if (!released && prerequisites) schedule();
    }
  }
  function schedule() {
    clearTimeout(quietTimer);
    if (!released && prerequisites && !busy()) quietTimer = setTimeout(attempt, 100);
  }
  function changed() { if (!released) { epoch++; mount(); schedule(); } }
  const observer = new MutationObserver(changed);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['aria-busy','data-state','data-home-loading','data-attorney-state','data-v2-session','hidden','class','style'] });
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(changed) : null;
  document.fonts?.addEventListener('loadingdone', changed);
  window.addEventListener('resize', changed);
  function ready({ outlet: next, settled } = {}) {
    if (released) return;
    const current = ++ticket;
    outlet = next; prerequisites = false; forced = false;
    resizeObserver?.disconnect();
    if (outlet) resizeObserver?.observe(outlet);
    Promise.allSettled([settled, document.fonts?.ready]).then(() => {
      if (released || current !== ticket) return;
      prerequisites = true; changed();
    });
  }
  function fail() {
    if (released) return;
    ticket++; forced = true; prerequisites = true;
    // Authentication recovery must remain usable even if a font or image hangs.
    requestAnimationFrame(() => requestAnimationFrame(finish));
  }
  window.LPC_PORTAL_BOOT = Object.freeze({ ready, fail, recover, finished, get pending() { return !released; } });
  mount();
})();
