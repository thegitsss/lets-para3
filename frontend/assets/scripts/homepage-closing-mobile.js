/* Pre-rendered mountain with a transform-only heading reveal behind its ridge. */
(() => {
  const mobile = matchMedia('(max-width:767px),(hover:none) and (pointer:coarse)');
  if (innerWidth > 767 || !mobile.matches) return;
  const scene = document.querySelector('.closing-mobile');
  if (!scene) return;
  const canvas = scene.querySelector('canvas');
  const image = scene.querySelector('img');
  const title = scene.querySelector('h2');
  const actions = scene.querySelector('.closing__actions');
  const buttons = [...actions.querySelectorAll('a')];
  const reassurance = actions.querySelector('.closing__reassurance');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let width = innerWidth, height = Math.max(700, innerHeight);
  let sceneTop = 0, frame = 0, lastY = null, lastTitleY = null, lastOpacity = null, path = null;
  let painting = false, paintAgain = false;
  let prepared = false;
  let lastActionsOpacity = [];
  function measure() {
    height = Math.max(700, innerHeight);
    scene.style.setProperty('--closing-height', `${height}px`);
    const photoScale = height / 1024;
    const summit = height * .27 + 135 * photoScale;
    scene.style.setProperty('--title-top', `${Math.max(90, summit - title.offsetHeight - 18)}px`);
    scene.style.setProperty('--actions-top', `${Math.max(summit + 100, height * .56)}px`);
    sceneTop = scene.getBoundingClientRect().top + scrollY;
    lastY = null;
    lastTitleY = null;
    lastOpacity = null;
    lastActionsOpacity = [];
  }
  async function paint() {
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
    if (!disabled && (top > height + 80 || top < -height - 80)) return;
    const progress = Math.max(0, Math.min(1, (height - top) / (height * 1.5)));
    const y = disabled ? 0 : Math.round((-48 + progress * 96) * 100) / 100;
    const reveal = Math.max(0, Math.min(1, (height * .8 - top) / (height * 1.05)));
    const eased = reveal * reveal * (3 - 2 * reveal);
    const titleY = disabled ? 0 : Math.round((1 - eased) * 160 * 100) / 100;
    const fade = Math.max(0, Math.min(1, (reveal - .08) / .4));
    const opacity = disabled ? 1 : Math.round(fade * fade * (3 - 2 * fade) * 1000) / 1000;
    // Reveal the role choices while the heading clears the ridge and the
    // mountain composition is still comfortably in view.
    // Tie the fade to scroll progress so reversing never leaves a timed fade running.
    // No layout reads, canvas redraws, text scaling, or inherited variables here.
    if (y !== lastY) {
      canvas.style.transform = `translate3d(0,${y}px,0)`;
      lastY = y;
    }
    if (titleY !== lastTitleY) {
      title.style.transform = `translate3d(0,${titleY}px,0)`;
      lastTitleY = titleY;
    }
    if (opacity !== lastOpacity) {
      title.style.opacity = opacity;
      lastOpacity = opacity;
    }
    buttons.forEach((button, index) => {
      // Start earlier and give each choice a longer, separate soft reveal.
      const fade = Math.max(0, Math.min(1, (reveal - .4 - index * .16) / .16));
      const opacity = disabled ? 1
        : Math.round(fade * fade * (3 - 2 * fade) * 1000) / 1000;
      if (opacity === lastActionsOpacity[index]) return;
      button.style.opacity = opacity;
      if (index === buttons.length - 1 && reassurance) reassurance.style.opacity = opacity;
      const blur = disabled ? 0 : Math.round((1 - opacity) * 7 * 100) / 100;
      button.style.filter = blur === 0 ? 'none' : `blur(${blur}px)`;
      button.inert = opacity < .1;
      lastActionsOpacity[index] = opacity;
    });
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(render); }
  function prepare() {
    if (prepared) return;
    prepared = true;
    image.loading = 'eager';
    document.fonts.ready.then(paint);
  }
  measure();
  document.fonts.ready.then(measure);
  // Decode and flatten the same mountain before it enters view, rather
  // than competing with the initial paper/logo animation for paint time.
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      prepare();
    }, { rootMargin: `${Math.max(1800, Math.ceil(innerHeight * 2))}px 0px` });
    observer.observe(scene);
  } else prepare();
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', () => {
    // Browser chrome may change height while scrolling; only width changes
    // establish a new layout, including device rotation.
    if (innerWidth === width) return;
    width = innerWidth; measure(); if (prepared) paint(); schedule();
  }, { passive: true });
  reduced.addEventListener('change', () => { lastY = lastTitleY = lastOpacity = null; lastActionsOpacity = []; schedule(); });
  for (const node of [document.body, document.documentElement]) {
    new MutationObserver(() => { lastY = lastTitleY = lastOpacity = null; lastActionsOpacity = []; schedule(); }).observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  new ResizeObserver(() => {
    sceneTop = scene.getBoundingClientRect().top + scrollY;
    schedule();
  }).observe(document.body);
  schedule();
})();
