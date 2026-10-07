(() => {
  const hook = document.querySelector('.hero-capacity');
  if (!hook || !window.gsap || !window.ScrollTrigger) return;
  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);
  const scene = hook.querySelector('.type-hook__scene');
  const inner = hook.querySelector('.type-hook__inner');
  const papers = [...hook.querySelectorAll('.type-hook__papers')];
  const clouds = [...hook.querySelectorAll('.type-hook__cloud')];
  const outline = hook.querySelector('.type-hook__outline');
  const paths = [...outline.querySelectorAll('path')];
  const clearLetters = outline.cloneNode(true);
  clearLetters.classList.add('type-hook__clear-letters');
  scene.append(clearLetters);
  const clearPaths = [...clearLetters.querySelectorAll('path')];
  const composite = hook.querySelector('.type-hook__composite');
  const smoke = hook.querySelector('.type-hook__smoke');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let context = null;
  let refreshFrame = 0;

  function syncMotion() {
    const enabled = !reduced.matches && !document.body.classList.contains('accessibility-mode');
    if (enabled && context) return;
    context?.revert();
    context = null;
    hook.classList.toggle('hook-find', enabled);
    if (!enabled) return;
    context = gsap.context(() => {
      gsap.set([...paths, ...clearPaths], { strokeDashoffset: 1 });
      gsap.set(clearLetters, { opacity: .65 });
      gsap.set(clearPaths, { strokeOpacity: 0, fillOpacity: 0 });
      clearPaths.forEach(path => {
        path.style.fill = path.classList.contains('type-hook__apostrophe-outline') ? '#6495ed' : '#233b5a';
      });
      const timeline = gsap.timeline();
      timeline.to(papers, { y: '-40%', scale: 1.3, duration: .52, ease: 'power1.out' }, 0);
      timeline.to(smoke, { y: '0%', duration: 1, ease: 'none' }, 0);
      clouds.forEach((cloud, index) => {
        timeline.to(cloud, { x: index ? '15%' : '-15%', duration: 1, ease: 'none' }, 0);
      });
      timeline.to(inner, { y: '8%', scale: .98, opacity: 0, duration: .12, ease: 'power1.inOut' }, .14);
      timeline.to(outline, { opacity: 1, duration: .015, ease: 'none' }, .27);
      timeline.to(clearPaths, { strokeOpacity: 1, duration: .015, ease: 'none' }, .27);
      timeline.to([...paths, ...clearPaths], { strokeDashoffset: 0, autoRound: false, duration: .22, ease: 'none' }, .27);
      timeline.to(composite, { opacity: 1, duration: .1, ease: 'power1.inOut' }, .51);
      timeline.to(clearPaths, { fillOpacity: 1, duration: .1, ease: 'power1.inOut' }, .51);
      timeline.to(clearLetters, { opacity: 1, duration: .1, ease: 'power1.inOut' }, .51);
      timeline.to(outline, { opacity: 0, duration: .1, ease: 'power1.inOut' }, .51);
      timeline.to(clearPaths, { strokeOpacity: 0, duration: .1, ease: 'power1.inOut' }, .51);
      ScrollTrigger.create({
        trigger: hook,
        animation: timeline,
        start: 'top top',
        end: 'bottom top',
        scrub: .1,
        invalidateOnRefresh: true,
      });
    }, hook);
  }

  function scheduleRefresh() {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      if (context) ScrollTrigger.refresh();
    });
  }

  reduced.addEventListener('change', syncMotion);
  new MutationObserver(syncMotion).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  addEventListener('pageshow', scheduleRefresh);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleRefresh);
    observer.observe(document.querySelector('.editorial-hero') || scene);
  }
  syncMotion();
  document.fonts.ready.then(scheduleRefresh);
})();
