(() => {
  const STORAGE_KEY = 'lpc_accessibility_mode';
  const toggles = Array.from(document.querySelectorAll('.accessibility-toggle'));
  if (!toggles.length) return;

  const prefersAccessibility = () => {
    try {
      return (
        window.matchMedia('(prefers-contrast: more)').matches ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        window.matchMedia('(forced-colors: active)').matches
      );
    } catch {
      return false;
    }
  };

  const setState = (enabled, persist) => {
    document.body.classList.toggle('accessibility-mode', enabled);
    document.documentElement.classList.toggle('accessibility-mode', enabled);
    toggles.forEach((btn) => {
      btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      btn.classList.toggle('is-active', enabled);
      btn.setAttribute('aria-label', enabled ? 'Accessibility mode on' : 'Accessibility mode off');
      btn.setAttribute('title', enabled ? 'Accessibility mode on' : 'Accessibility mode off');
    });
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
      } catch {}
    }
  };

  let initial = null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'on') initial = true;
    if (stored === 'off') initial = false;
  } catch {}

  if (initial === null) {
    initial = prefersAccessibility();
  }

  setState(initial, false);

  toggles.forEach((btn) => {
    btn.addEventListener('click', () => {
      const enabled = !document.body.classList.contains('accessibility-mode');
      setState(enabled, true);
    });
  });
})();
