(() => {
  const hook = document.querySelector('.hero-capacity');
  if (!hook || !window.gsap || !window.ScrollTrigger) return;
  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);
  const scene = hook.querySelector('.type-hook__scene');
  const inner = hook.querySelector('.type-hook__inner');
  const paperArtwork = [...hook.querySelectorAll('.type-hook__papers')];
  let papers = paperArtwork;
  const paperLayers = new Map();
  let rasterFailed = false;
  const clouds = [...hook.querySelectorAll('.type-hook__cloud')];
  const outline = hook.querySelector('.type-hook__outline');
  const paths = [...outline.querySelectorAll('path')];
  const composite = hook.querySelector('.type-hook__composite');
  const smoke = hook.querySelector('.type-hook__smoke');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let context = null;
  let refreshFrame = 0;
  const mobile = matchMedia('(max-width: 767px)');
  const supportsScrollTimeline = CSS.supports('view-timeline-name: --capacity-reveal') &&
    CSS.supports('animation-timeline: --capacity-reveal') &&
    CSS.supports('animation-range: entry 100% exit 100%');
  let renderedMobile = null;
  let viewportWidth = innerWidth;
  let rasterDecodePending = false;
  const configureRefresh = () => {
    // The scene already uses a stable mobile scroll distance. Browser toolbar
    // changes must not revert/rebuild its animation during a touch gesture.
    ScrollTrigger.config({ autoRefreshEvents: mobile.matches && ScrollTrigger.isTouch
      ? 'none' : 'visibilitychange,DOMContentLoaded,load,resize' });
  };
  configureRefresh();
  mobile.addEventListener('change', () => { configureRefresh(); syncMotion(); });

  function syncPaperLayers() {
    // The phone asset is the same photograph, cutout, color filter and fade,
    // rendered once. Native image transforms avoid filtering SVG photographs
    // again during scrolling. Keep the original SVGs for desktop and fallback.
    papers = paperArtwork.map(svg => {
      let layer = paperLayers.get(svg);
      if (mobile.matches && !rasterFailed) {
        if (!layer) {
          layer = document.createElement('img');
          layer.className = `${svg.getAttribute('class')} type-hook__paper-layer`;
          layer.alt = '';
          layer.setAttribute('aria-hidden', 'true');
          layer.width = 2000;
          layer.height = 1750;
          layer.src = 'assets/images/homepage-capacity/mountain-mobile-composited.webp';
          layer.addEventListener('error', () => {
            rasterFailed = true;
            renderedMobile = null;
            syncMotion();
          }, { once: true });
          svg.replaceWith(layer);
          paperLayers.set(svg, layer);
        }
        return layer;
      }
      if (layer) {
        svg.querySelector('[data-home-mountain]')?.setAttribute('href', mobile.matches
          ? 'hero-mountain-mobile.jpg' : 'hero-mountain-restored.jpg');
        layer.replaceWith(svg);
        paperLayers.delete(svg);
      }
      return svg;
    });
  }

  function createLogoTexture() {
    if (!mobile.matches || !(papers[1] instanceof HTMLImageElement)) return null;
    const image = papers[1];
    if (!image.complete || !image.naturalWidth) {
      if (!rasterDecodePending) {
        rasterDecodePending = true;
        image.decode().then(() => {
          rasterDecodePending = false;
          renderedMobile = null;
          syncMotion();
        }, () => { rasterDecodePending = false; });
      }
      return null;
    }
    // Keep the final mountain texture inside the mark. A viewport-sized image
    // moving behind its SVG mask made Safari repaint the filled logo each frame.
    const width = composite.clientWidth, height = composite.clientHeight;
    const x = image.offsetLeft, y = image.offsetTop;
    const paperWidth = image.offsetWidth, paperHeight = image.offsetHeight;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.className = 'type-hook__paper-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const density = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.ceil(width * density);
    canvas.height = Math.ceil(height * density);
    const paint = canvas.getContext('2d');
    if (!paint) return null;
    paint.setTransform(density, 0, 0, density, 0, 0);
    paint.drawImage(image, x, y - paperHeight * .4, paperWidth, paperHeight);
    composite.append(canvas);
    gsap.set(image, { display: 'none' });
    return { destroy() {
      canvas.remove();
      canvas.width = canvas.height = 0;
    } };
  }

  function syncMotion() {
    const enabled = !reduced.matches && !document.body.classList.contains('accessibility-mode');
    if (enabled && context && renderedMobile === mobile.matches) return;
    context?.revert();
    context = null;
    hook.classList.remove('hook-native');
    syncPaperLayers();
    renderedMobile = mobile.matches;
    hook.classList.toggle('hook-find', enabled);
    if (!enabled) return;
    const nativeMotion = mobile.matches && supportsScrollTimeline;
    hook.classList.toggle('hook-native', nativeMotion);
    context = gsap.context(() => {
      const painter = createLogoTexture();
      if (nativeMotion) return () => painter?.destroy();
      gsap.set(paths, { strokeDashoffset: 1 });
      const timeline = gsap.timeline();
      // Keep the mountain at its natural size as it rises. A bottom-anchored
      // zoom made the peak grow out of frame and appear to stretch vertically.
      timeline.fromTo(papers, { y: '0%' }, { y: '-40%', duration: .52, ease: 'power1.out' }, 0);
      timeline.fromTo(smoke, { y: '70%' }, { y: '0%', duration: 1, ease: 'power1.out' }, 0);
      clouds.forEach((cloud, index) => {
        timeline.fromTo(cloud, { x: '0%' }, { x: index ? '15%' : '-15%', duration: 1, ease: 'power1.out' }, 0);
      });
      timeline.fromTo(inner, { y: '0%', scale: 1 }, { y: '20%', scale: .9, duration: 1, ease: 'power1.out' }, 0);
      timeline.fromTo(inner, { opacity: 1 }, { opacity: 0, duration: .2, ease: 'power1.out' }, 0);
      timeline.fromTo(outline, { opacity: 0 }, { opacity: 1, duration: .01, ease: 'power1.out' }, .1);
      timeline.fromTo(paths, { strokeDashoffset: 1 }, { strokeDashoffset: 0, autoRound: false, duration: .3, ease: 'power1.out' }, .1);
      timeline.to(outline, { opacity: 0, duration: .2, ease: 'power1.out' }, .28);
      timeline.fromTo(composite, { opacity: 0 }, { opacity: 1, duration: .1, ease: 'power1.out' }, .3);
      ScrollTrigger.create({
        trigger: hook,
        animation: timeline,
        start: 'top top',
        // The second cloud bank moves with the document, covering the logo
        // while the next section enters, as in Find's complete reveal.
        end: () => `+=${hook.getBoundingClientRect().height}`,
        scrub: mobile.matches ? true : .1,
        invalidateOnRefresh: true,
      });
      return () => painter?.destroy();
    }, hook);
  }

  function scheduleRefresh() {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      if (context) ScrollTrigger.refresh(true);
    });
  }

  reduced.addEventListener('change', syncMotion);
  new MutationObserver(syncMotion).observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  addEventListener('pageshow', scheduleRefresh);
  addEventListener('load', scheduleRefresh, { once: true });
  addEventListener('resize', () => {
    if (innerWidth === viewportWidth) return;
    viewportWidth = innerWidth;
    if (mobile.matches) {
      renderedMobile = null;
      syncMotion();
    }
    scheduleRefresh();
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleRefresh();
  });
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleRefresh);
    observer.observe(document.querySelector('.editorial-hero') || scene);
  }
  syncMotion();
  document.fonts.ready.then(scheduleRefresh);
})();
