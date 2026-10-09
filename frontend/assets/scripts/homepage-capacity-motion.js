(() => {
  'use strict';

  const hook = document.querySelector('.hero-capacity');
  if (!hook || hook.dataset.capacityMotionController === 'unified-v1') return;
  const scene = hook.querySelector('.type-hook__scene');
  const inner = hook.querySelector('.type-hook__inner');
  const outline = hook.querySelector('.type-hook__outline');
  const composite = hook.querySelector('.type-hook__composite');
  const foreground = hook.querySelector('.type-hook__papers--full');
  const headline = hook.querySelector('.type-hook__paper-headline');
  const smoke = hook.querySelector('.type-hook__smoke');
  if (!scene || !inner || !outline || !composite || !foreground || !headline || !smoke) return;
  hook.dataset.capacityMotionController = 'unified-v1';

  const papers = [...hook.querySelectorAll('.type-hook__papers')];
  const clouds = [...hook.querySelectorAll('.type-hook__cloud')];
  const paths = [...outline.querySelectorAll('path')];
  let clearLetters = hook.querySelector('.type-hook__clear-letters');
  if (!clearLetters) {
    clearLetters = outline.cloneNode(true);
    clearLetters.classList.add('type-hook__clear-letters');
    [...clearLetters.querySelectorAll('path')].slice(5).forEach(path => path.remove());
    outline.after(clearLetters);
  }
  const clearPaths = [...clearLetters.querySelectorAll('path')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const mobileMedia = matchMedia('(max-width: 767px)');
  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = value => 1 - (1 - value) ** 2;
  const tween = (value, start, duration) => ease(clamp((value - start) / duration));
  const writtenStyles = new WeakMap();
  let mobile = mobileMedia.matches;
  let sectionTop = 0;
  let sectionHeight = 1;
  let viewportHeight = innerHeight;
  let measured = false;
  let measurePending = false;
  let restorePending = false;
  let progress = 0;
  let frame = 0;
  let previousTime = 0;
  let lastRenderedValue = null;
  let lastMobile = null;
  let layoutWidth = innerWidth;

  function writeStyle(element, property, value) {
    const text = String(value);
    let previous = writtenStyles.get(element);
    if (!previous) { previous = {}; writtenStyles.set(element, previous); }
    if (previous[property] === text) return;
    previous[property] = text;
    element.style[property] = text;
  }

  // Every layer uses this single smoothed value, including SVG strokes. There
  // are no independent ScrollTimeline clocks or paused animations to seek.
  function render(value) {
    if (value === lastRenderedValue && mobile === lastMobile) return;
    lastRenderedValue = value;
    lastMobile = mobile;
    const travel = tween(value, 0, 1);
    const exit = tween(value, 0, .2);
    const drawDuration = mobile ? .3 : .14;
    const fillStart = mobile ? .4 : .24;
    const fillDuration = mobile ? .1 : .06;
    const ink = tween(value, .1, drawDuration);
    const fill = tween(value, fillStart, fillDuration);
    const outlineOpacity = tween(value, .1, mobile ? .04 : .01) *
      (1 - tween(value, fillStart, fillDuration));

    writeStyle(inner, 'transform', mobile ? 'none'
      : `translate3d(0, ${20 * travel}%, 0) scale(${1 - .1 * travel})`);
    writeStyle(inner, 'opacity', 1 - exit);
    papers.forEach(paper => writeStyle(paper, 'transform',
      `translate3d(0, ${-40 * travel}%, 0) scale(${1 + .3 * travel})`));
    writeStyle(foreground, 'opacity', 1 - tween(value, fillStart, mobile ? .18 : .06));
    writeStyle(headline, 'opacity', 1 - tween(value, .03, .06));
    clouds.forEach((cloud, index) => writeStyle(cloud, 'transform',
      `translate3d(${(mobile ? (index ? -40 : 40) : (index ? 15 : -15)) * travel}%, 0, 0)`));
    writeStyle(smoke, 'transform', `translate3d(0, ${70 * (1 - travel)}%, 0)`);
    writeStyle(outline, 'opacity', outlineOpacity);
    paths.forEach(path => writeStyle(path, 'strokeDashoffset', 1 - ink));
    writeStyle(composite, 'opacity', fill);
    writeStyle(clearLetters, 'opacity', .65);
    clearPaths.forEach(path => {
      writeStyle(path, 'strokeDashoffset', 1 - ink);
      writeStyle(path, 'strokeOpacity', outlineOpacity);
      writeStyle(path, 'fill', path.classList.contains('type-hook__apostrophe-outline') ? '#6495ed' : '#233b5a');
      writeStyle(path, 'fillOpacity', fill);
    });
  }

  function scrollProgress() {
    return clamp((scrollY - sectionTop) / sectionHeight);
  }

  function measure(restore = false) {
    const nextMobile = mobileMedia.matches;
    hook.classList.toggle('hook-find', !reduced.matches);
    const rect = hook.getBoundingClientRect();
    const nextTop = rect.top + scrollY;
    const nextHeight = Math.max(1, rect.height);
    const geometryChanged = !measured || mobile !== nextMobile ||
      Math.abs(sectionTop - nextTop) > .5 || Math.abs(sectionHeight - nextHeight) > .5;
    mobile = nextMobile;
    sectionTop = nextTop;
    sectionHeight = nextHeight;
    viewportHeight = mobile ? scene.clientHeight || innerHeight : innerHeight;
    measured = true;
    // ResizeObserver notifications with unchanged geometry must not reset a
    // running scrub. Toolbar-only mobile resizes do not reach this method.
    if (geometryChanged || restore || reduced.matches) {
      progress = reduced.matches ? 0 : scrollProgress();
      previousTime = 0;
      lastRenderedValue = null;
      render(progress);
    }
  }

  function update(time) {
    frame = 0;
    if (document.hidden) { previousTime = 0; return; }
    if (measurePending) {
      measurePending = false;
      measure(restorePending);
      restorePending = false;
    }
    if (reduced.matches) return;
    const target = scrollProgress();
    if (mobile && (scrollY < sectionTop - viewportHeight || scrollY > sectionTop + sectionHeight)) {
      progress = target;
      previousTime = 0;
      render(progress);
      return;
    }
    const elapsed = previousTime ? Math.max(0, time - previousTime) : 16;
    previousTime = time;
    // The desktop curve is unchanged. Mobile uses the same 100 ms time
    // constant, with a cap so a stalled frame cannot advance the whole reveal.
    const delta = mobile ? Math.min(64, elapsed) : elapsed;
    progress += (target - progress) * (1 - Math.exp(-delta / 100));
    if (Math.abs(target - progress) < .0001) progress = target;
    render(progress);
    if (progress !== target) frame = requestAnimationFrame(update);
    else previousTime = 0;
  }

  function schedule() {
    if (!frame && !document.hidden && (!reduced.matches || measurePending)) {
      frame = requestAnimationFrame(update);
    }
  }

  function scheduleMeasure(restore = false) {
    measurePending = true;
    restorePending = restorePending || restore;
    schedule();
  }

  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', () => {
    if (mobileMedia.matches && innerWidth === layoutWidth) return;
    layoutWidth = innerWidth;
    scheduleMeasure();
  }, { passive: true });
  addEventListener('pageshow', () => scheduleMeasure(true));
  reduced.addEventListener('change', () => scheduleMeasure(true));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
    } else scheduleMeasure(true);
  });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => scheduleMeasure());
    observer.observe(hook);
    observer.observe(scene);
    const hero = document.querySelector('.editorial-hero');
    if (hero) observer.observe(hero);
  }
  measure();
  document.fonts?.ready.then(() => scheduleMeasure());
})();
