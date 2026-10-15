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
  // Keep settled SVG strokes and opacity out of subsequent scroll paints.
  const renderedStyles = new WeakMap();
  function setStyle(node, property, value) {
    let values = renderedStyles.get(node);
    if (!values) renderedStyles.set(node, values = new Map());
    value = String(value);
    if (values.get(property) === value) return;
    values.set(property, value);
    node.style[property] = value;
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  // Prepare the unchanged artwork just before its scroll scene enters view.
  // Native lazy loading otherwise starts these large decorative downloads
  // during the hero, and eager decoding defeats that boundary entirely.
  const prepareArtwork = () => hook.querySelectorAll('img[data-scene-src]').forEach(img => {
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = img.dataset.sceneSrc;
    delete img.dataset.sceneSrc;
    // Predecode is best effort; normal image loading remains authoritative.
    void Promise.allSettled([img.decode()]);
  });
  if ('IntersectionObserver' in window) {
    const artworkObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      artworkObserver.disconnect();
      prepareArtwork();
    }, { rootMargin: '128px 0px' });
    // Observe the first artwork, which starts below the introductory text.
    // The tall section itself touches the hero edge before any artwork is visible.
    artworkObserver.observe(clouds[1] || scene);
  } else prepareArtwork();
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
  let lastMobile = null;
  let lastEntranceOffset = null;
  let introductionTop = 0;
  let entranceStart = 0;
  let viewportHeight = innerHeight;
  function render(value) {
    // An unchanged off-screen scene needs no SVG or inherited style updates.
    const mobile = innerWidth <= 767;
    const entrance = clamp((scrollY - entranceStart) / Math.max(1, sectionTop - entranceStart));
    const entranceOffset = mobile ? Math.max(0, introductionTop - 24) * (1 - entrance) : 0;
    if (value === lastRenderedValue && mobile === lastMobile && entranceOffset === lastEntranceOffset) return;
    lastEntranceOffset = entranceOffset;
    lastRenderedValue = value;
    lastMobile = mobile;
    const travel = tween(value, 0, 1);
    const exit = tween(value, 0, .2);
    const ink = tween(value, .1, .14);
    const fill = tween(value, .24, .06);
    // Let mobile text follow the browser's native sticky scrolling.
    // Scroll-event counter-translations and scaling can lag phone swipes.
    setStyle(inner, 'transform', mobile
      ? 'none'
      : `translate3d(0, ${20 * travel}%, 0) scale(${1 - .1 * travel})`);
    setStyle(inner, 'opacity', 1 - exit);
    papers.forEach(paper => {
      setStyle(paper, 'transform', `translate3d(0, ${-40 * travel}%, 0) scale(${1 + .3 * travel})`);
    });
    // Let the smaller papers dissolve gradually into the mobile cloud sweep.
    setStyle(foreground, 'opacity', 1 - tween(value, .24, mobile ? .18 : .06));
    // Clear the paper headline before the logo starts drawing at .1.
    setStyle(headline, 'opacity', 1 - tween(value, .03, .06));
    clouds.forEach((cloud, index) => {
      setStyle(cloud, 'transform', `translate3d(${(mobile ? (index ? -40 : 40) : (index ? 15 : -15)) * travel}%, 0, 0)`);
    });
    setStyle(smoke, 'transform', `translate3d(0, ${70 * (1 - travel)}%, 0)`);
    const outlineOpacity = tween(value, .1, .01) * (1 - tween(value, .24, .06));
    setStyle(outline, 'opacity', outlineOpacity);
    paths.forEach(path => { setStyle(path, 'strokeDashoffset', 1 - ink); });
    setStyle(composite, 'opacity', fill);
    setStyle(clearLetters, 'opacity', .65);
    clearPaths.forEach((path) => {
      setStyle(path, 'strokeDashoffset', 1 - ink);
      setStyle(path, 'strokeOpacity', outlineOpacity);
      setStyle(path, 'fill', path.classList.contains('type-hook__apostrophe-outline') ? '#6495ed' : '#233b5a');
      setStyle(path, 'fillOpacity', fill);
    });
  }

  function update(time) {
    frame = 0;
    if (reduced.matches) return;
    const target = clamp((scrollY - sectionTop) / sectionHeight);
    if (innerWidth <= 767) {
      progress = target;
      previousTime = 0;
      render(progress);
      return;
    }
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
    viewportHeight = innerWidth <= 767
      ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--home-stable-viewport')) || innerHeight
      : innerHeight;
    introductionTop = inner.offsetTop;
    const rect = hook.getBoundingClientRect();
    sectionTop = rect.top + scrollY;
    sectionHeight = Math.max(1, rect.height);
    const heroNote = document.querySelector('.editorial-hero__publishing');
    const heroContentBottom = heroNote ? heroNote.getBoundingClientRect().bottom + scrollY : sectionTop - viewportHeight;
    // Keep the content gap steady during entry, then settle at center as the hero leaves.
    entranceStart = Math.max(sectionTop - viewportHeight,
      Math.min(heroContentBottom, sectionTop - Math.max(0, introductionTop - 24)));
    progress = reduced.matches ? 0 : clamp((scrollY - sectionTop) / sectionHeight);
    render(progress);
  }

  addEventListener('scroll', schedule, { passive: true });
  let layoutWidth = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth <= 767 && innerWidth === layoutWidth) return;
    layoutWidth = innerWidth;
    measure();
  }, { passive: true });
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
