/* Pre-rendered mountain with a transform-only heading reveal behind its ridge. */
(() => {
  const mobile = matchMedia('(max-width:767px),(hover:none) and (pointer:coarse)');
  if (innerWidth > 767 || !mobile.matches) return;
  const scene = document.querySelector('.closing-mobile');
  if (!scene) return;
  const canvas = scene.querySelector('canvas');
  const image = scene.querySelector('img');
  let imageRequested = false;
  let sourcePrepared = false;
  function prepareSource() {
    if (sourcePrepared) return;
    sourcePrepared = true;
    image.decoding = 'async';
    image.fetchPriority = 'low';
    image.loading = 'eager';
  }
  function requestImage() {
    if (imageRequested) return;
    imageRequested = true;
    prepareSource();
    image.fetchPriority = 'auto';
    void paint();
  }
  const title = scene.querySelector('h2');
  const reassurance = scene.querySelector('.closing__reassurance');
  const actions = scene.querySelector('.closing__actions');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  // Fetch the small phone image after the unchanged hero entrance, while keeping
  // canvas decoding/painting near the closing section rather than at startup.
  function queueSource() {
    const outro = document.querySelector('.editorial-hero__reassurance');
    if (reduced.matches) { prepareSource(); return; }
    outro?.addEventListener('animationend', prepareSource, { once: true });
    setTimeout(prepareSource, 2200);
  }
  if (document.documentElement.classList.contains('hero-fonts-pending')) {
    const ready = new MutationObserver(() => {
      if (document.documentElement.classList.contains('hero-fonts-pending')) return;
      ready.disconnect();
      queueSource();
    });
    ready.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  } else queueSource();
  let width = innerWidth, height = Math.max(700, innerHeight);
  let sceneTop = 0, frame = 0, lastY = null, lastTitleY = null, lastActionsY = null, lastOpacity = null, path = null;
  let painting = false, paintAgain = false;
  function measure() {
    height = Math.max(700, innerHeight);
    scene.style.setProperty('--closing-height', `${height}px`);
    const photoScale = height / 1024;
    const summit = height * .27 + 135 * photoScale;
    scene.style.setProperty('--title-top', `${Math.max(90, summit - title.offsetHeight - 18) - 55}px`);
    scene.style.setProperty('--reassurance-top', `${Math.max(90, summit - title.offsetHeight - 18) + title.firstElementChild.offsetHeight + 12 - 55}px`);
    scene.style.setProperty('--actions-top', `${Math.max(summit + 100, height * .56) - 55}px`);
    sceneTop = scene.getBoundingClientRect().top + scrollY;
    lastY = null;
    lastTitleY = null;
    lastActionsY = null;
    lastOpacity = null;
  }
  async function paint() {
    if (!imageRequested) return;
    if (painting) { paintAgain = true; return; }
    painting = true;
    try {
      // Wait for the homepage's lazy image load before decoding; calling
      // decode while Safari changes lazy-loading state can abort the decode.
      if (!image.complete || !image.naturalWidth) {
        await new Promise((resolve, reject) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', reject, { once: true });
        });
      }
      await image.decode();
      if (!path) path = new Path2D(document.querySelector('#closing-ridge-cutout path').getAttribute('d'));
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const surfaceWidth = scene.clientWidth + 48;
      canvas.width = Math.round(surfaceWidth * dpr);
      canvas.height = Math.round(height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const photoWidth = height * 1.5;
      const x = scene.clientWidth / 2 - photoWidth * .43 + 24;
      const y = height * .27;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(photoWidth / 1536, height / 1024);
      ctx.clip(path);
      if ('filter' in ctx) ctx.filter = 'brightness(.64) saturate(.82)';
      ctx.drawImage(image, 0, 0, 1536, 1024);
      ctx.restore();
      // Flatten the photo treatment once rather than filtering moving DOM layers.
      if (!('filter' in ctx)) {
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = 'rgba(0,0,0,.36)';
        ctx.fillRect(0, 0, surfaceWidth, height);
      }
      scene.classList.add('closing--rendered');
      schedule();
    } catch (error) {
      console.error('Closing mountain rendering failed:', error);
      canvas.hidden = true;
    } finally {
      painting = false;
      if (paintAgain) { paintAgain = false; paint(); }
    }
  }
  function render() {
    frame = 0;
    const disabled = reduced.matches || document.body.classList.contains('accessibility-mode') || document.documentElement.classList.contains('accessibility-mode');
    const top = sceneTop - scrollY;
    scene.classList.toggle('closing--in-view', top < height && top > -(height - 120));
    if (!disabled && (top > height + 80 || top < -height - 80)) return;
    const progress = Math.max(0, Math.min(1, (height - top) / (height * 1.5)));
    const y = disabled ? 0 : Math.round((-48 + progress * 96) * 100) / 100;
    const reveal = Math.max(0, Math.min(1, (height - top) / (height * .5)));
    const eased = reveal * reveal * (3 - 2 * reveal);
    // Anchor at mid-viewport, with continuous reversible drift after entry.
    const drift = top - height * .5;
    const titleY = disabled ? 0 : Math.round(((1 - eased) * 160 + drift * .18) * 100) / 100;
    const actionsY = disabled ? 0 : Math.round(drift * .13 * 100) / 100;
    const opacity = disabled ? 1 : Math.round(eased * 1000) / 1000;
    // Keep the role choices visible while text and buttons drift with scrolling.
    // No layout reads, canvas redraws, text scaling, or inherited variables here.
    if (y !== lastY) {
      canvas.style.transform = `translate3d(0,${y}px,0)`;
      lastY = y;
    }
    if (titleY !== lastTitleY) {
      title.style.transform = `translate3d(0,${titleY}px,0)`;
      reassurance.style.transform = `translate3d(0,${titleY}px,0)`;
      lastTitleY = titleY;
    }
    if (actionsY !== lastActionsY) {
      actions.style.transform = `translate3d(0,${actionsY}px,0)`;
      lastActionsY = actionsY;
    }
    if (opacity !== lastOpacity) {
      title.style.opacity = opacity;
      lastOpacity = opacity;
    }
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(render); }
  measure();
  document.fonts.ready.then(() => { measure(); if (imageRequested) paint(); });
  if ('IntersectionObserver' in window) {
    const loader = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      loader.disconnect();
      requestImage();
    }, { rootMargin: '1500px 0px' });
    loader.observe(scene);
  } else requestImage();
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', () => {
    // Browser chrome may change height while scrolling; only width changes
    // establish a new layout, including device rotation.
    if (innerWidth === width) return;
    width = innerWidth; measure(); paint(); schedule();
  }, { passive: true });
  reduced.addEventListener('change', () => { lastY = lastTitleY = lastActionsY = lastOpacity = null; schedule(); });
  for (const node of [document.body, document.documentElement]) {
    new MutationObserver(() => { lastY = lastTitleY = lastActionsY = lastOpacity = null; schedule(); }).observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  new ResizeObserver(() => {
    sceneTop = scene.getBoundingClientRect().top + scrollY;
    schedule();
  }).observe(document.body);
  schedule();
})();
