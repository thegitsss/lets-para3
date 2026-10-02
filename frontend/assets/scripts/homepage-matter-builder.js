(() => {
  const opening = document.querySelector('.matter-builder__opening');
  const details = document.querySelector('.matter-builder__details');
  if (!opening || !details) return;

  const notes = opening.querySelector('.matter-builder__line--notes');
  const lpc = opening.querySelector('.matter-builder__line--lpc');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let layoutWidth = 0;
  const syncStableViewport = () => {
    if (Math.abs(window.innerWidth - layoutWidth) < 2) return;
    layoutWidth = window.innerWidth;
    document.documentElement.style.setProperty('--home-stable-viewport', `${window.innerHeight}px`);
  };
  syncStableViewport();
  const clamp = value => Math.max(0, Math.min(1, value));
  const smoothstep = (start, end, value) => {
    const t = clamp((value - start) / (end - start));
    return t * t * (3 - 2 * t);
  };
  let frame = 0;

  const setLine = (element, progress) => {
    element.style.setProperty('--matter-line-opacity', progress.toFixed(3));
    element.style.setProperty('--matter-line-blur', `${((1 - progress) * 14).toFixed(1)}px`);
    element.style.setProperty('--matter-line-rise', `${((1 - progress) * 62).toFixed(1)}px`);
    element.style.setProperty('--matter-line-scale', (0.88 + progress * 0.12).toFixed(3));
  };

  const update = () => {
    frame = 0;
    if (!document.body.classList.contains('matter-builder-motion-ready')) return;
    const viewport = window.innerHeight;
    const travel = Math.max(1, opening.offsetHeight - viewport + viewport * 0.65);
    const progress = clamp((viewport * 0.65 - opening.getBoundingClientRect().top) / travel);
    setLine(notes, smoothstep(0.02, 0.31, progress));
    setLine(lpc, smoothstep(0.38, 0.74, progress));
    if (details.getBoundingClientRect().top < viewport * 0.86) {
      details.classList.add('is-visible');
    }
  };

  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };

  const syncPreference = () => {
    document.body.classList.toggle('matter-builder-motion-ready', !reducedMotion.matches);
    if (reducedMotion.matches) details.classList.add('is-visible');
    schedule();
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', () => { syncStableViewport(); schedule(); }, { passive: true });
  reducedMotion.addEventListener('change', syncPreference);
  syncPreference();
})();
