(function(global) {
  const STORAGE_KEY = 'lpDashboardToast';
  let hideTimer;

  function stage(message, type = 'info') {
    if (!message) return;
    const payload = { message, type };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function consume() {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn('Invalid toast payload, returning raw string.', err);
      return { message: raw, type: 'info' };
    }
  }

  function show(message, options = {}) {
    const { targetId = 'toastBanner', type = 'info', duration = 2600 } = options;
    const el = typeof targetId === 'string' ? document.getElementById(targetId) : targetId;
    if (!el) return;
    el.textContent = message;
    el.dataset.toastType = type;
    el.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  global.toastUtils = {
    STORAGE_KEY,
    stage,
    consume,
    show
  };
})(window);
