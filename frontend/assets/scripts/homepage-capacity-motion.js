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
      gsap.set(paths, { strokeDashoffset: 1 });
      const timeline = gsap.timeline();
      // Restore the mountain's pre-redesign rise; both copies stay aligned.
      // The clouds and logo retain the complete reveal and cloud-cover ending.
      timeline.to(papers, { y: '-40%', scale: 1.3, duration: .52, ease: 'power1.out' }, 0);
      timeline.to(smoke, { y: '0%', duration: 1, ease: 'power1.out' }, 0);
      clouds.forEach((cloud, index) => {
        timeline.to(cloud, { x: index ? '15%' : '-15%', duration: 1, ease: 'power1.out' }, 0);
      });
      timeline.to(inner, { y: '20%', scale: .9, duration: 1, ease: 'power1.out' }, 0);
      timeline.to(inner, { opacity: 0, duration: .2, ease: 'power1.out' }, 0);
      timeline.to(outline, { opacity: 1, duration: .01, ease: 'power1.out' }, .1);
      timeline.to(paths, { strokeDashoffset: 0, autoRound: false, duration: .3, ease: 'power1.out' }, .1);
      timeline.to(outline, { opacity: 0, duration: .2, ease: 'power1.out' }, .28);
      timeline.to(composite, { opacity: 1, duration: .1, ease: 'power1.out' }, .3);
      ScrollTrigger.create({
        trigger: hook,
        animation: timeline,
        start: 'top top',
        // The second cloud bank moves with the document, covering the logo
        // while the next section enters, as in Find's complete reveal.
        end: () => `+=${hook.getBoundingClientRect().height}`,
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
