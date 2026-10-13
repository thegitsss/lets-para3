// Scale only the decorative feature composition, never the authentication form.
(() => {
  const figures = document.querySelectorAll('.lpc-entry-preview');
  const fit = (figure) => {
    if (!figure.clientWidth || !figure.clientHeight) return;
    const scale = Math.max(0, Math.min(1, (figure.clientWidth - 16) / 560, (figure.clientHeight - 16) / 560));
    figure.style.setProperty('--auth-preview-scale', String(scale));
  };
  figures.forEach(fit);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver((entries) => entries.forEach(({ target }) => fit(target)));
    figures.forEach((figure) => observer.observe(figure));
  } else {
    window.addEventListener('resize', () => figures.forEach(fit));
  }
})();
