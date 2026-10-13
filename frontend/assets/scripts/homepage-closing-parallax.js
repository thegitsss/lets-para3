/* Desktop closing invitation with the restored mountain and gentle parallax. */
(() => {
  if (innerWidth <= 767) return;
  const scene = document.querySelector('.closing-scene');
  if (!scene) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'closing-scene__canvas';
  canvas.setAttribute('aria-hidden', 'true');
  scene.prepend(canvas);
  const image = scene.querySelector('.closing-scene__mountain');
  image.loading = 'eager';
  const title = scene.querySelector('#closing-title');
  const actions = scene.querySelector('.role-actions');
  const buttons = [...actions.querySelectorAll('a')];
  const reassurance = actions.querySelector('.closing-scene__reassurance');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let width = innerWidth, height = Math.max(740, innerHeight);
  let sceneTop = 0, frame = 0, lastY = null, lastTitleY = null, lastActionsY = null, lastOpacity = null, path = null;
  let painting = false, paintAgain = false;
  let lastActionsOpacity = [];
  let mountainTop = 0;
  function measure() {
    height = Math.max(740, innerHeight);
    scene.style.setProperty('--closing-height', `${height}px`);
    const titleTop = Math.max(112, Math.min(height * .17, 210));
    const actionsTop = titleTop + title.offsetHeight + 64;
    scene.style.setProperty('--title-top', `${titleTop}px`);
    scene.style.setProperty('--actions-top', `${actionsTop}px`);
    mountainTop = Math.max(height * .59, actionsTop + actions.offsetHeight + 44);
    sceneTop = scene.getBoundingClientRect().top + scrollY;
    lastY = null;
    lastTitleY = null;
    lastActionsY = null;
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
      // Keep the mountain below the current invitation without moving any text.
      const photoHeight = Math.max(height, surfaceWidth / (1.5 * .86));
      const photoWidth = photoHeight * 1.5;
      const x = scene.clientWidth / 2 - photoWidth * .43 + 24;
      const y = mountainTop - 135 * photoWidth / 1536;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(photoWidth / 1536, photoHeight / 1024);
      ctx.clip(path);
      if ('filter' in ctx) ctx.filter = 'brightness(.64) saturate(.82)';
      ctx.drawImage(image, 0, 0, 1536, 1024);
      ctx.restore();
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
    if (innerWidth <= 767) return;
    const disabled = reduced.matches || document.body.classList.contains('accessibility-mode') || document.documentElement.classList.contains('accessibility-mode');
    const top = sceneTop - scrollY;
    if (!disabled && (top > height + 80 || top < -height - 80)) return;
    const progress = Math.max(0, Math.min(1, (height - top) / (height * 1.5)));
    const y = disabled ? 0 : Math.round((-48 + progress * 96) * 100) / 100;
    const reveal = Math.max(0, Math.min(1, (height * .8 - top) / (height * 1.05)));
    const eased = reveal * reveal * (3 - 2 * reveal);
    const titleY = disabled ? 0 : Math.round((1 - eased) * 160 * 100) / 100;
    const actionsY = disabled ? 0 : Math.round((1 - eased) * 64 * 100) / 100;
    const fade = Math.max(0, Math.min(1, (reveal - .08) / .4));
    const opacity = disabled ? 1 : Math.round(fade * fade * (3 - 2 * fade) * 1000) / 1000;
    // Reveal both role choices while the invitation and mountain remain in view.
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
    if (actionsY !== lastActionsY) {
      actions.style.transform = `translate3d(0,${actionsY}px,0)`;
      lastActionsY = actionsY;
    }
    if (opacity !== lastOpacity) {
      title.style.opacity = opacity;
      lastOpacity = opacity;
    }
    buttons.forEach((button, index) => {
      // Reveal both choices together with a small offset.
      const fade = Math.max(0, Math.min(1, (reveal - .4 - index * .03) / .16));
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
  // This section owns its scroll-driven fades rather than the generic entrance.
  scene.querySelector('.closing-scene__content').classList.add('is-revealed');
  buttons.forEach(button => button.classList.add('is-revealed'));
  measure();
  document.fonts.ready.then(() => { measure(); paint(); });
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', () => {
    // Browser chrome may change height while scrolling; only width changes
    // establish a new layout, including device rotation.
    if (innerWidth === width) return;
    width = innerWidth; measure(); paint(); schedule();
  }, { passive: true });
  reduced.addEventListener('change', () => { lastY = lastTitleY = lastActionsY = lastOpacity = null; lastActionsOpacity = []; schedule(); });
  for (const node of [document.body, document.documentElement]) {
    new MutationObserver(() => { lastY = lastTitleY = lastActionsY = lastOpacity = null; lastActionsOpacity = []; schedule(); }).observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  new ResizeObserver(() => {
    sceneTop = scene.getBoundingClientRect().top + scrollY;
    schedule();
  }).observe(document.body);
  schedule();
})();
