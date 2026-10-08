(() => {
  const hook = document.querySelector('.hero-capacity');
  if (!hook) return;
  const scene = hook.querySelector('.type-hook__scene');
  const inner = hook.querySelector('.type-hook__inner');
  const papers = [...hook.querySelectorAll('.type-hook__papers')];
  const foreground = hook.querySelector('.type-hook__papers--full');
  const headline = hook.querySelector('.type-hook__paper-headline');
  const clouds = [...hook.querySelectorAll('.type-hook__cloud')];
  const outline = hook.querySelector('.type-hook__outline');
  const paths = [...outline.querySelectorAll('path')];
  // Restore a little contrast above the clouds only for the opening Let’s characters.
  const clearLetters = outline.cloneNode(true);
  clearLetters.classList.add('type-hook__clear-letters');
  [...clearLetters.querySelectorAll('path')].forEach((path, index) => {
    if (index > 4) path.remove();
  });
  outline.after(clearLetters);
  const clearPaths = [...clearLetters.querySelectorAll('path')];
  const composite = hook.querySelector('.type-hook__composite');
  const smoke = hook.querySelector('.type-hook__smoke');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = value => Math.max(0, Math.min(1, value));
  // FIND uses GSAP's default power1.out for each tween and a 0.1s scrub.
  const ease = value => 1 - (1 - value) ** 2;
  const tween = (progress, start, duration) => ease(clamp((progress - start) / duration));
  let frame = 0;
  let previousTime = 0;
  let progress = 0;
  let sectionTop = 0;
  let sectionHeight = 1;

  let lastRenderedValue = null;
  function render(value) {
    // An unchanged off-screen scene needs no SVG or inherited style updates.
    if (innerWidth <= 767 && value === lastRenderedValue) return;
    lastRenderedValue = value;
    const travel = tween(value, 0, 1);
    const exit = tween(value, 0, .2);
    const ink = tween(value, .1, .14);
    const fill = tween(value, .24, .06);
    inner.style.transform = `translate3d(0, ${20 * travel}%, 0) scale(${1 - .1 * travel})`;
    inner.style.opacity = 1 - exit;
    papers.forEach(paper => {
      paper.style.transform = `translate3d(0, ${-40 * travel}%, 0) scale(${1 + .3 * travel})`;
    });
    foreground.style.opacity = 1 - fill;
    // Clear the paper headline before the logo starts drawing at .1.
    headline.style.opacity = 1 - tween(value, .03, .06);
    clouds.forEach((cloud, index) => {
      cloud.style.transform = `translate3d(${(index ? 15 : -15) * travel}%, 0, 0)`;
    });
    smoke.style.transform = `translate3d(0, ${70 * (1 - travel)}%, 0)`;
    outline.style.opacity = tween(value, .1, .01) * (1 - tween(value, .24, .06));
    paths.forEach(path => { path.style.strokeDashoffset = 1 - ink; });
    composite.style.opacity = fill;
    clearLetters.style.opacity = .65;
    clearPaths.forEach((path) => {
      path.style.strokeDashoffset = 1 - ink;
      path.style.strokeOpacity = outline.style.opacity;
      path.style.fill = path.classList.contains('type-hook__apostrophe-outline') ? '#6495ed' : '#233b5a';
      path.style.fillOpacity = fill;
    });
  }

  function update(time) {
    frame = 0;
    if (reduced.matches) return;
    const target = clamp((scrollY - sectionTop) / sectionHeight);
    const elapsed = previousTime ? Math.max(0, time - previousTime) : 16;
    previousTime = time;
    progress += (target - progress) * (1 - Math.exp(-elapsed / 100));
    if (Math.abs(target - progress) < .0001) progress = target;
    render(progress);
    if (progress !== target) frame = requestAnimationFrame(update);
    else previousTime = 0;
  }

  function schedule() {
    if (!frame && !reduced.matches) frame = requestAnimationFrame(update);
  }

  function measure() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    hook.classList.toggle('hook-find', !reduced.matches);
    const rect = hook.getBoundingClientRect();
    sectionTop = rect.top + scrollY;
    sectionHeight = Math.max(1, rect.height);
    progress = reduced.matches ? 0 : clamp((scrollY - sectionTop) / sectionHeight);
    render(progress);
  }

  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', measure, { passive: true });
  addEventListener('pageshow', measure);
  reduced.addEventListener('change', measure);
  // Font and upstream layout changes can move the scene after initial paint.
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(measure);
    observer.observe(document.querySelector('.editorial-hero') || document.body);
    observer.observe(scene);
  }
  measure();
  document.fonts.ready.then(measure);
})();
