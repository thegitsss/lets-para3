// Restored desktop closing controller; mobile has its own approved component.
(() => {
  if (matchMedia("(max-width: 767px)").matches) return;
  const scene = document.querySelector('.closing-scene');
  if (!scene?.querySelector('.closing-scene__mountain')) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const actions = scene.querySelector('.role-actions');
  const track = document.createElement('div');
  track.className = 'closing-parallax-track';
  scene.before(track);
  track.append(scene);
  let frame = 0, displayedProgress = null, lastFrame = 0;
  function render(now) {
    frame = 0;
    const disabled = reduced.matches || document.body.classList.contains('accessibility-mode') || document.documentElement.classList.contains('accessibility-mode');
    track.classList.toggle('closing-parallax-track--active', !disabled);
    const rect = track.getBoundingClientRect();
    const mobile = innerWidth < 768;
    // Preserve the reveal's scroll distance; the added 80svh is a settled hold.
    const revealDistance = (track.offsetHeight - scene.offsetHeight) * (mobile ? 110 / 190 : 140 / 220);
    const targetProgress = Math.max(0, Math.min(1, -rect.top / Math.max(1, revealDistance)));
    const immediate = disabled || scene.contains(document.activeElement) || rect.bottom < 0 || rect.top > innerHeight;
    const elapsed = Math.min(64, now - lastFrame || 16); lastFrame = now;
    if (displayedProgress === null || immediate) displayedProgress = targetProgress;
    else displayedProgress += (targetProgress - displayedProgress) * (1 - Math.exp(-elapsed / 100));
    if (Math.abs(targetProgress - displayedProgress) < .0003) displayedProgress = targetProgress;
    const progress = displayedProgress;
    // The ridge masks the title until it rises into the open sky; controls remain in front.
    const t = Math.max(0, Math.min(1, (progress - .06) / .82));
    const eased = t * t * (3 - 2 * t);
    const remaining = disabled || scene.contains(document.activeElement) ? 0 : 1 - eased;
    const actionsReady = disabled || scene.contains(document.activeElement) || t >= 1;
    scene.classList.toggle('closing-scene--actions-ready', actionsReady);
    if (actions) actions.inert = !actionsReady;
    const title = scene.querySelector('#closing-title');
    const mountain = scene.querySelector('.closing-scene__mountain');
    const photoScale = Math.max(mountain.clientWidth / 1536, mountain.clientHeight / 1024);
    const exitDistance = Math.max(0, -scene.getBoundingClientRect().top);
    scene.style.setProperty('--closing-footer-drift', `${disabled ? 0 : Math.min(mountain.clientHeight * .16, exitDistance * .35)}px`);
    const summitTop = mountain.clientHeight * (mobile ? .27 : .24) + 135 * photoScale;
    const titleTop = Math.max(90, summitTop - title.offsetHeight - (mobile ? 26 : 22));
    scene.style.setProperty('--closing-title-top', `${titleTop}px`);
    scene.style.setProperty('--closing-actions-top', `${titleTop + title.offsetHeight + (mobile ? 24 : 32)}px`);
    scene.style.setProperty('--closing-actions-bottom', 'auto');
    scene.style.setProperty('--closing-mountain-y', `${-remaining * (mobile ? 25 : 35)}px`);
    scene.style.setProperty('--closing-mountain-scale', `${1 + remaining * .07}`);
    scene.style.setProperty('--closing-title-y', `${remaining * (mobile ? 145 : 210)}px`);
    scene.style.setProperty('--closing-actions-y', `${remaining * (mobile ? 145 : 210)}px`);
    if (!immediate && displayedProgress !== targetProgress) schedule();
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(render); }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule, { passive: true });
  reduced.addEventListener('change', schedule);
  scene.addEventListener('focusin', schedule);
  scene.addEventListener('focusout', schedule);
  for (const node of [document.body, document.documentElement]) {
    new MutationObserver(schedule).observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  document.fonts.ready.then(schedule);
  schedule();
})();
