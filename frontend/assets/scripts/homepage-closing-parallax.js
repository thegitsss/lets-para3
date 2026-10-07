(() => {
  const scene = document.querySelector('.closing-scene');
  if (!scene?.querySelector('.closing-scene__mountain')) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const actions = scene.querySelector('.role-actions');
  const title = scene.querySelector('#closing-title');
  const mountain = scene.querySelector('.closing-scene__mountain');
  const ridge = scene.querySelector('.closing-scene__ridge');
  // Scope mobile motion values to the layers that consume them. The values and
  // timing are unchanged; unrelated descendants no longer inherit each update.
  const mobileStyleTargets = {
    '--closing-roles-opacity': [actions],
    '--closing-title-top': [title], '--closing-title-y': [title], '--closing-title-scale': [title],
    '--closing-actions-top': [actions], '--closing-actions-bottom': [actions], '--closing-actions-y': [actions],
    '--closing-mountain-y': [mountain, ridge], '--closing-mountain-scale': [mountain, ridge],
    '--closing-footer-drift': [mountain, ridge],
  };
  let mobileStyles = null;
  const track = document.createElement('div');
  track.className = 'closing-parallax-track';
  scene.before(track);
  track.append(scene);
  let frame = 0, displayedProgress = null;
  let geometry = null, geometryDirty = true, nearViewport = true, hasRendered = false;
  const setStyle = (name, value) => {
    value = String(value);
    const targets = mobileStyles && mobileStyleTargets[name] || [scene];
    targets.forEach(node => {
      if (node && node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
    });
  };
  function render() {
    frame = 0;
    const nextMobileStyles = innerWidth < 768;
    if (mobileStyles !== nextMobileStyles) {
      Object.entries(mobileStyleTargets).forEach(([name, nodes]) => {
        scene.style.removeProperty(name);
        nodes.forEach(node => node?.style.removeProperty(name));
      });
      mobileStyles = nextMobileStyles;
    }
    const disabled = reduced.matches || document.body.classList.contains('accessibility-mode') || document.documentElement.classList.contains('accessibility-mode');
    if (track.classList.contains('closing-parallax-track--active') === disabled) {
      track.classList.toggle('closing-parallax-track--active', !disabled);
      geometryDirty = true;
    }
    const focused = scene.contains(document.activeElement);
    if (hasRendered && !nearViewport && !geometryDirty && !focused) return;
    const stableHeight = innerWidth <= 640
      ? Math.round(parseFloat(document.documentElement.style.getPropertyValue('--mobile-stable-height')))
      : 0;
    const viewportHeight = stableHeight || innerHeight;
    // Read geometry together, before any animation writes. Sizes only need
    // remeasurement when fonts, layout, or viewport dimensions change.
    const rect = track.getBoundingClientRect();
    const sceneTop = scene.getBoundingClientRect().top;
    if (geometryDirty) {
      geometry = {
        trackHeight: track.offsetHeight, sceneHeight: scene.offsetHeight,
        sceneClientHeight: scene.clientHeight, mountainWidth: mountain.clientWidth,
        mountainHeight: mountain.clientHeight, titleHeight: title.offsetHeight,
      };
      geometryDirty = false;
    }
    const mobile = innerWidth < 768;
    const compactRoles = innerWidth < 1100;
    // Release the sticky scene as the reveal finishes, with no settled scroll hold.
    const revealDistance = (geometry.trackHeight - geometry.sceneHeight) / .57;
    // Mobile reveals during its natural entrance rather than stopping on a sticky scene.
    const targetProgress = mobile
      ? .57 * Math.max(0, Math.min(1, (viewportHeight - rect.top) / (viewportHeight * .85)))
      : Math.max(0, Math.min(1, -rect.top / Math.max(1, revealDistance)));
    const immediate = mobile || disabled || focused || rect.bottom < 0 || rect.top > viewportHeight;
    if (displayedProgress === null || immediate) displayedProgress = targetProgress;
    else displayedProgress = targetProgress; // Page scrolling already supplies the smoothing.
    if (Math.abs(targetProgress - displayedProgress) < .0003) displayedProgress = targetProgress;
    const progress = displayedProgress;
    // The ridge masks the title until it rises into the open sky; controls remain in front.
    const t = Math.max(0, Math.min(1, progress / .57));
    const eased = t * t * (3 - 2 * t);
    const remaining = disabled || focused ? 0 : 1 - eased;
    // Complete the mobile reveal while the whole composition is still inside the viewport.
    const titleT = mobile
      ? Math.max(0, Math.min(1, (viewportHeight * .8 - rect.top) / (viewportHeight * .72)))
      : Math.max(0, Math.min(1, t / .88));
    const titleRemaining = disabled || focused
      ? 0 : 1 - titleT * titleT * (3 - 2 * titleT);
    const rolesVisible = Math.max(0, Math.min(1, mobile ? (progress - .36) / .12 : compactRoles ? (progress - .4) / .12 : progress / .16));
    const rolesOpacity = remaining === 0 ? 1 : rolesVisible * rolesVisible * (3 - 2 * rolesVisible);
    const actionsReady = rolesOpacity > 0;
    setStyle('--closing-roles-opacity', rolesOpacity);
    setStyle('--closing-role-inset', `${compactRoles ? 0 : remaining * 110}px`);
    if (scene.classList.contains('closing-scene--actions-ready') !== actionsReady) scene.classList.toggle('closing-scene--actions-ready', actionsReady);
    if (actions && actions.inert !== !actionsReady) actions.inert = !actionsReady;
    const photoScale = Math.max(geometry.mountainWidth / 1536, geometry.mountainHeight / 1024);
    const exitDistance = Math.max(0, -sceneTop);
    setStyle('--closing-footer-drift', `${disabled ? 0 : Math.min(geometry.mountainHeight * .16, exitDistance * .35)}px`);
    const summitTop = geometry.mountainHeight * (mobile ? .27 : .24) + 135 * photoScale;
    const titleTop = Math.max(90, summitTop - geometry.titleHeight - (mobile ? 6 : 22));
    setStyle('--closing-title-top', `${titleTop}px`);
    const actionsTop = mobile
      ? Math.max(summitTop + 100, geometry.sceneClientHeight * .72)
      : innerWidth >= 1100
        ? summitTop + Math.max(40, Math.min(64, viewportHeight * .055))
        : titleTop + geometry.titleHeight + 32;
    setStyle('--closing-actions-top', `${actionsTop}px`);
    setStyle('--closing-actions-bottom', 'auto');
    setStyle('--closing-mountain-y', `${-remaining * (mobile ? 40 : 35)}px`);
    setStyle('--closing-mountain-scale', `${1 + remaining * (mobile ? .035 : .07)}`);
    setStyle('--closing-title-y', `${titleRemaining * (mobile ? 290 : 380)}px`);
    setStyle('--closing-title-scale', `${1 - titleRemaining * .1}`);
    setStyle('--closing-actions-y', `${compactRoles ? 0 : remaining * 210}px`);
    hasRendered = true;
    if (!immediate && displayedProgress !== targetProgress) schedule();
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(render); }
  function invalidate() { geometryDirty = true; schedule(); }
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', invalidate, { passive: true });
  reduced.addEventListener('change', invalidate);
  scene.addEventListener('focusin', schedule);
  scene.addEventListener('focusout', schedule);
  for (const node of [document.body, document.documentElement]) {
    new MutationObserver(schedule).observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  const visibilityObserver = new IntersectionObserver(entries => {
    nearViewport = entries[0].isIntersecting;
    if (nearViewport) schedule();
  }, { rootMargin: `${Math.max(innerHeight, innerWidth)}px 0px` });
  visibilityObserver.observe(track);
  const sizeObserver = new ResizeObserver(invalidate);
  [track, scene, title, mountain].forEach(node => sizeObserver.observe(node));
  document.fonts.ready.then(invalidate);
  schedule();
})();
