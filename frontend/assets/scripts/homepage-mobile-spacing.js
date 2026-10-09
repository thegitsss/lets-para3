(() => {
  const intro = document.querySelector('.type-hook__inner');
  const hook = document.querySelector('.hero-capacity');
  const note = document.querySelector('.editorial-hero__publishing');
  if (!intro || !hook || !note) return;
  let width = innerWidth;
  function measure() {
    if (innerWidth > 767) { intro.style.removeProperty('--capacity-preview-intro-offset'); return; }
    const currentOffset = parseFloat(getComputedStyle(intro).top) || 0;
    const sectionTop = hook.getBoundingClientRect().top + scrollY;
    const noteBottom = note.getBoundingClientRect().bottom + scrollY;
    const scene = hook.querySelector('.type-hook__scene');
    const title = hook.querySelector('h2');
    const naturalTitleTop = title.getBoundingClientRect().top + sectionTop - scene.getBoundingClientRect().top;
    // Reference: roughly 460px of clear space in a 750px-wide content image.
    const referenceGap = innerWidth * (460 / 750);
    intro.style.setProperty('--capacity-preview-intro-offset', `${currentOffset + noteBottom + referenceGap - naturalTitleTop}px`);
  }
  addEventListener('resize', () => { if (innerWidth === width) return; width = innerWidth; measure(); }, { passive: true });
  if ('ResizeObserver' in window) {
    let measureFrame = 0;
    const observer = new ResizeObserver(() => {
      if (measureFrame) return;
      measureFrame = requestAnimationFrame(() => { measureFrame = 0; measure(); });
    });
    observer.observe(intro);
    observer.observe(document.querySelector('.editorial-hero'));
  }
  addEventListener('load', measure);
  document.fonts.ready.then(() => {
    measure();
    const entrances = document.querySelector('.editorial-hero').getAnimations({ subtree: true })
      .filter(animation => Number.isFinite(animation.effect.getTiming().iterations));
    Promise.all(entrances.map(animation => animation.finished.catch(() => {}))).then(measure);
  });
  measure();
})();
