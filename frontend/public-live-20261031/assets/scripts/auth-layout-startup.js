(() => {
  const root = document.documentElement;
  root.classList.add('auth-layout-pending');
  let prepare = () => {};
  const failedStyles = new WeakSet();
  window.addEventListener('error', event => {
    if (event.target instanceof HTMLLinkElement && event.target.rel === 'stylesheet') failedStyles.add(event.target);
  }, true);

  window.LPCAuthLayout = Object.freeze({
    prepare(callback) { prepare = callback; },
  });

  async function settleLayout() {
    try {
      await Promise.all([...document.querySelectorAll('link[rel="stylesheet"]')].map(link => {
        if (link.sheet || failedStyles.has(link)) return Promise.resolve();
        return new Promise(resolve => {
          link.addEventListener('load', resolve, { once: true });
          link.addEventListener('error', resolve, { once: true });
        });
      }));
      await document.fonts.ready;
      prepare();
    } finally {
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('auth-layout-pending')));
    }
  }

  document.addEventListener('DOMContentLoaded', settleLayout, { once: true });
})();
