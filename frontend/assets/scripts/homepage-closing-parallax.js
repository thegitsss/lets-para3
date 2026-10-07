(() => {
  const scene = document.querySelector('.closing-scene');
  if (!scene?.querySelector('.closing-scene__mountain')) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const actions = scene.querySelector('.role-actions');
  const track = document.createElement('div');
  track.className = 'closing-parallax-track';
  scene.before(track);
  track.append(scene);
  let frame = 0, displayedProgress = null;
  function render() {
    frame = 0;
    const disabled = reduced.matches || document.body.classList.contains('accessibility-mode') || document.documentElement.classList.contains('accessibility-mode');
    track.classList.toggle('closing-parallax-track--active', !disabled);
    const rect = track.getBoundingClientRect();
    const mobile = innerWidth < 768;
    const compactRoles = innerWidth < 1100;
    // Release the sticky scene as the reveal finishes, with no settled scroll hold.
    const revealDistance = (track.offsetHeight - scene.offsetHeight) / .57;
    // Mobile reveals during its natural entrance rather than stopping on a sticky scene.
    const targetProgress = mobile
      ? .57 * Math.max(0, Math.min(1, (innerHeight - rect.top) / (innerHeight * .85)))
      : Math.max(0, Math.min(1, -rect.top / Math.max(1, revealDistance)));
    const immediate = mobile || disabled || scene.contains(document.activeElement) || rect.bottom < 0 || rect.top > innerHeight;
    if (displayedProgress === null || immediate) displayedProgress = targetProgress;
    else displayedProgress = targetProgress; // Page scrolling already supplies the smoothing.
    if (Math.abs(targetProgress - displayedProgress) < .0003) displayedProgress = targetProgress;
    const progress = displayedProgress;
    // The ridge masks the title until it rises into the open sky; controls remain in front.
    const t = Math.max(0, Math.min(1, progress / .57));
    const eased = t * t * (3 - 2 * t);
    const remaining = disabled || scene.contains(document.activeElement) ? 0 : 1 - eased;
    // Complete the mobile reveal while the whole composition is still inside the viewport.
    const titleT = mobile
      ? Math.max(0, Math.min(1, (innerHeight * .8 - rect.top) / (innerHeight * .72)))
      : Math.max(0, Math.min(1, t / .88));
    const titleRemaining = disabled || scene.contains(document.activeElement)
      ? 0 : 1 - titleT * titleT * (3 - 2 * titleT);
    const rolesVisible = Math.max(0, Math.min(1, mobile ? (progress - .36) / .12 : compactRoles ? (progress - .4) / .12 : progress / .16));
    const rolesOpacity = remaining === 0 ? 1 : rolesVisible * rolesVisible * (3 - 2 * rolesVisible);
    const actionsReady = rolesOpacity > 0;
    scene.style.setProperty('--closing-roles-opacity', `${rolesOpacity}`);
    scene.style.setProperty('--closing-role-inset', `${compactRoles ? 0 : remaining * 110}px`);
    scene.classList.toggle('closing-scene--actions-ready', actionsReady);
    if (actions) actions.inert = !actionsReady;
    const title = scene.querySelector('#closing-title');
    const mountain = scene.querySelector('.closing-scene__mountain');
    const photoScale = Math.max(mountain.clientWidth / 1536, mountain.clientHeight / 1024);
    const exitDistance = Math.max(0, -scene.getBoundingClientRect().top);
    scene.style.setProperty('--closing-footer-drift', `${disabled ? 0 : Math.min(mountain.clientHeight * .16, exitDistance * .35)}px`);
    const summitTop = mountain.clientHeight * (mobile ? .27 : .24) + 135 * photoScale;
    const titleTop = Math.max(90, summitTop - title.offsetHeight - (mobile ? 6 : 22));
    scene.style.setProperty('--closing-title-top', `${titleTop}px`);
    const actionsTop = mobile
      ? Math.max(summitTop + 100, scene.clientHeight * .72)
      : innerWidth >= 1100
        ? summitTop + Math.max(40, Math.min(64, innerHeight * .055))
        : titleTop + title.offsetHeight + 32;
    scene.style.setProperty('--closing-actions-top', `${actionsTop}px`);
    scene.style.setProperty('--closing-actions-bottom', 'auto');
    scene.style.setProperty('--closing-mountain-y', `${-remaining * (mobile ? 40 : 35)}px`);
    scene.style.setProperty('--closing-mountain-scale', `${1 + remaining * (mobile ? .035 : .07)}`);
    scene.style.setProperty('--closing-title-y', `${titleRemaining * (mobile ? 290 : 380)}px`);
    scene.style.setProperty('--closing-title-scale', `${1 - titleRemaining * .1}`);
    scene.style.setProperty('--closing-actions-y', `${compactRoles ? 0 : remaining * 210}px`);
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
