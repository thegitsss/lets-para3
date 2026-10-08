(() => {
  'use strict';
  const film = document.querySelector('#matter-film');
  if (!film) return;
  const pen = new URLSearchParams(location.search).get('pen');
  const pens = {mathilde:['LPC Notes','400'],nothing:['LPC nothing','400'],reenie:['LPC reenie','400'],cedarville:['LPC cedarville','400'],labelle:['LPC labelle','400'],kalam:['LPC Kalam','300'],handlee:['LPC Handlee','400'],patrick:['LPC Patrick','400'],caveat:['LPC Caveat','400']};
  if (pens[pen]) { film.dataset.pen = pen; film.style.setProperty('--notes-font', pens[pen][0]); film.style.setProperty('--notes-weight', pens[pen][1]); }

  const stepTitles = ['Your notes', 'LPC builds your Matter', 'Preview post'];
  const journey = document.querySelector('.matter-scroll-journey');
  const advance = film.querySelector('[data-advance]');
  const amount = film.querySelector('#matter-amount');
  const deadline = film.querySelector('#matter-deadline');
  const feedback = film.querySelector('[data-feedback]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const status = ['YOUR STARTING POINT', 'YOUR NOTES → YOUR MATTER', ''];
  const actions = ['Build my Matter', 'Preview', 'Post Matter'];
  const previewStart = .64;
  let previewThreshold = previewStart;
  let stage = 0, frame = 0, scrollStart = 0, scrollDistance = 1;
  let measureFrame = 0;
  let mobileFilmStart = 0, mobileFilmEnd = Infinity, measuredViewportHeight = innerHeight;
  const disclosure = '';
  const builder = film.querySelector('.dashboard-builder');
  const builderSkip = film.querySelector('.builder-skip');
  const builderPreview = film.querySelector('.builder-preview');
  const builderAmount = film.querySelector('#builder-amount');
  const builderDate = film.querySelector('#builder-date');
  const brief = film.querySelector('.builder-brief');
  let mobileBriefScrollTop = 0;
  brief.addEventListener('scroll', () => {
    if (innerWidth <= 767) mobileBriefScrollTop = brief.scrollTop;
  }, { passive: true });
  const originalNotes = brief.innerHTML.replace(/<br\s*\/?>/gi, '\n');
  brief.setAttribute('aria-label', `Your original notes: ${originalNotes}`);
  const typedNotes = document.createElement('span');
  typedNotes.setAttribute('aria-hidden', 'true');
  brief.replaceChildren(typedNotes);
  let typedCount = -1;
  let draftReady = false;
  let buildFrame = 0;
  let lastValidation = null;
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const setAttribute = (node, name, value) => {
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
  };
  const setStyle = (node, name, value) => {
    value = String(value);
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  };
  const buildIntake = film.querySelector('.build-intake');
  const buildTracks = film.querySelectorAll('.build-track, .builder-progress');
  const builderStatus = film.querySelector('[data-builder-status]');
  const filmStatus = film.querySelector('[data-status]');
  const buildParts = [
    ['title', .25, .38, '.matter-title h2, .matter-location', '.matter-title'],
    ['scope', .38, .53, '.scope-summary', '.scope-summary'],
    ['tasks', .53, .73, '.tasks-label, .typeset, .addition', '.tasks-label, .fragment, .addition'],
    ['amount', .73, .84, '.amount-field', '.amount-field'],
    ['date', .84, .95, '.deadline-field', '.deadline-field'],
  ].map(([name, start, end, selector, styleSelector]) => ({
    name, start, end, nodes: [...film.querySelectorAll(selector)],
    styleNodes: [...film.querySelectorAll(styleSelector)],
  }));
  const builderParts = [...builder.querySelectorAll('[data-build-part]')];
  const builderTasks = [...builder.querySelectorAll('[data-builder-task]')];
  const suggestedTask = builder.querySelector('[data-suggestion-task]');
  // Keep the arrows fixed while the scene changes beneath them.
  const stageElement = film.querySelector('.stage');
  const scene = document.createElement('div');
  scene.className = 'matter-stage-scene';
  [...stageElement.children].filter(node => !node.matches('.stage-arrow')).forEach(node => scene.append(node));
  stageElement.append(scene);
  let requestedStage = 0;
  let changingStage = false;
  let sceneAnimation = null;
  let transitionVersion = 0;
  let mobileArrival = 0;

  async function transitionTo(next) {
    // Native flings can cross another threshold before a fade finishes.
    // A phone must follow the latest scroll state instead of replaying an
    // obsolete fade after the user has reversed direction.
    if (innerWidth <= 767 && changingStage && next !== requestedStage) {
      transitionVersion++;
      sceneAnimation?.cancel();
      sceneAnimation = null;
      changingStage = false;
      scene.inert = false;
      delete film.dataset.transitioning;
    }
    requestedStage = next;
    const mobileOffscreen = innerWidth <= 767 &&
      (scrollY > mobileFilmEnd || scrollY + measuredViewportHeight < mobileFilmStart);
    if (reduced.matches || mobileOffscreen) {
      transitionVersion++;
      sceneAnimation?.cancel();
      sceneAnimation = null;
      changingStage = false;
      scene.inert = false;
      delete film.dataset.transitioning;
      delete scene.dataset.mobileArrival;
      if (stage !== next) setStage(next);
      return;
    }
    if (changingStage || stage === next) return;
    changingStage = true;
    const restoreFocus = scene.contains(document.activeElement);
    scene.inert = true;
    film.dataset.transitioning = 'true';
    const version = ++transitionVersion;
    try {
      if (innerWidth <= 767) {
        // Keep a visible card throughout native scrolling. The desktop's
        // fade-out/fade-in leaves an empty scene and delays the next phone
        // state by 200ms, so phones use just the existing incoming motion.
        const direction = requestedStage > stage ? 1 : -1;
        setStage(requestedStage);
        // CSS starts this compositor animation at the normal render boundary.
        // Alternating names restarts a reversed arrival without forcing style
        // or layout synchronously after the stage's DOM changes.
        scene.style.setProperty('--matter-arrival-x', `${18 * direction}px`);
        scene.dataset.mobileArrival = ++mobileArrival % 2 ? 'a' : 'b';
        await new Promise(resolve => setTimeout(resolve, 380));
        if (version === transitionVersion) delete scene.dataset.mobileArrival;
        return;
      }
      while (stage !== requestedStage && version === transitionVersion) {
        const direction = requestedStage > stage ? 1 : -1;
        sceneAnimation = scene.animate([
          { opacity: 1, transform: 'translateX(0)' },
          { opacity: 0, transform: `translateX(${-14 * direction}px)` }
        ], { duration: 200, easing: 'ease-in', fill: 'forwards' });
        await sceneAnimation.finished;
        const destination = requestedStage;
        setStage(destination);
        sceneAnimation.cancel();
        sceneAnimation = scene.animate([
          { opacity: 0, transform: `translateX(${18 * direction}px)` },
          { opacity: 1, transform: 'translateX(0)' }
        ], { duration: 380, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
        await sceneAnimation.finished;
        sceneAnimation.cancel();
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    } finally {
      if (version === transitionVersion) {
        sceneAnimation = null;
        changingStage = false;
        scene.inert = false;
        delete film.dataset.transitioning;
        if (restoreFocus) (stage === 1 ? film.querySelector('#builder-title') : advance).focus({preventScroll:true});
      }
    }
  }

  function validate() {
    const signature = [amount.value, deadline.value, stage, draftReady].join('|');
    if (lastValidation?.signature === signature) return lastValidation.valid;
    const validAmount = amount.value !== '' && Number.isFinite(Number(amount.value)) && Number(amount.value) >= 400 && Number(amount.value) <= 100000 && Number.isInteger(Number(amount.value));
    const validDate = deadline.value >= '2026-06-06' && deadline.value <= '2026-06-27';
    const valid = validAmount && validDate;
    advance.disabled = stage === 1 && !valid;
    builderPreview.disabled = !valid || !draftReady;
    amount.setAttribute('aria-invalid', String(!validAmount));
    deadline.setAttribute('aria-invalid', String(!validDate));
    if (stage === 1) feedback.textContent = valid ? disclosure : 'Set an amount of $400–$100,000 and a due date from June 6–27 for this example.';
    if (validDate) {
      const date = new Date(`${deadline.value}T12:00:00`);
      const postedDate = film.querySelector('.posted-date');
      setText(postedDate, date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      postedDate.dateTime = deadline.value;
      setText(film.querySelector('.editor-note > span:nth-child(3)'), `One-page memo. $${Number(amount.value).toLocaleString('en-US')}. Due ${date.toLocaleDateString('en-US', {month:'long',day:'numeric'})}.`);
    }
    lastValidation = { signature, valid };
    return valid;
  }
  function setStage(next) {
    lastValidation = null;
    const previousStage = stage;
    // Keep keyboard focus out of controls that are about to disappear.
    if (next !== 1 && (document.activeElement === amount || document.activeElement === deadline)) advance.focus({preventScroll:true});
    if (next !== 1 && builder.contains(document.activeElement)) advance.focus({preventScroll:true});
    builder.hidden = next !== 1;
    builderSkip.hidden = next !== 1;
    film.querySelector('.matter-sheet').inert = next === 1;
    stage = next;
    film.dataset.stage = String(stage);
    film.querySelector('.stage-arrow-prev').disabled = stage === 0;
    film.querySelector('.stage-arrow-next').disabled = stage === 2;
    film.querySelector('.sheet-stage').textContent = String(stage + 1).padStart(2, '0');
    film.querySelector('[data-step-title]').textContent = stepTitles[stage];
    film.querySelector('[data-status]').textContent = status[stage];
    advance.querySelector('span').textContent = actions[stage];
    advance.querySelector('[aria-hidden]').hidden = stage === 1;
    advance.disabled = false;
    amount.readOnly = stage !== 1;
    amount.tabIndex = stage === 1 ? 0 : -1;
    deadline.tabIndex = stage === 1 ? 0 : -1;
    deadline.disabled = stage !== 1;
    // Hide duplicate handwritten content from assistive technology after the morph.
    film.querySelectorAll('.hand, .hand-title').forEach(node => node.setAttribute('aria-hidden', String(stage !== 0)));
    film.querySelectorAll('.typeset, .matter-title h2, .matter-location, .scope-label, .scope-summary, .tasks-label, .addition, .sheet-state').forEach(node => node.setAttribute('aria-hidden', String(stage === 0)));
    film.querySelector('.tasks-label').textContent = 'TASKS';
    film.querySelector('.amount-input').setAttribute('aria-hidden', String(stage === 0));
    film.querySelector('.deadline-input').setAttribute('aria-hidden', String(stage !== 1));
    film.querySelector('.posted-date').setAttribute('aria-hidden', String(stage !== 2));
    film.querySelectorAll('.task-toggle').forEach(button => { button.tabIndex = stage === 2 ? 0 : -1; button.disabled = stage !== 2; button.setAttribute('aria-hidden', String(stage !== 2)); });
    feedback.textContent = disclosure;
    film.classList.toggle('edits-visible', stage >= 1);
    validate();
    cancelAnimationFrame(buildFrame);
    if (stage === 1 && previousStage !== 2 && !reduced.matches) {
      const started = performance.now();
      renderBuild(0);
      const tick = now => {
        if (stage !== 1) return;
        if (innerWidth <= 767 && (scrollY > mobileFilmEnd || scrollY + measuredViewportHeight < mobileFilmStart)) {
          renderBuild(1);
          return;
        }
        const build = Math.min(1, (now - started) / 8000);
        renderBuild(build);
        if (build < 1) buildFrame = requestAnimationFrame(tick);
      };
      buildFrame = requestAnimationFrame(tick);
    } else renderBuild(1);
  }
  function updateFromScroll() {
    frame = 0;
    const progress = Math.max(0, Math.min(1, (scrollY - scrollStart) / scrollDistance));

    if (reduced.matches) return;
    let next = progress < .26 ? 0 : progress < previewThreshold ? 1 : 2;
    if (next === 2 && !validate()) next = 1;
    transitionTo(next);
  }
  function renderBuild(build) {
    const portion = (start, end) => Math.max(0, Math.min(1, (build - start) / (end - start)));
    const count = reduced.matches ? originalNotes.length : Math.floor(portion(.02, .65) * originalNotes.length);
    if (count !== typedCount) {
      // Reset scroll before changing text; writing scrollTop afterward forces
      // layout for the newly typed text on every character update.
      if (innerWidth <= 767) {
        if (mobileBriefScrollTop) { brief.scrollTop = 0; mobileBriefScrollTop = 0; }
      } else if (brief.scrollTop) brief.scrollTop = 0;
      typedNotes.textContent = originalNotes.slice(0, count);
      typedCount = count;
    }
    const typing = stage === 1 && count < originalNotes.length;
    if (brief.classList.contains('is-typing') !== typing) brief.classList.toggle('is-typing', typing);
    draftReady = build >= .62;
    const ready = stage === 1 && draftReady;
    if (builder.classList.contains('is-ready') !== ready) builder.classList.toggle('is-ready', ready);
    if (builderSkip.hidden !== (stage !== 1)) builderSkip.hidden = stage !== 1;
    const replay = build >= 1;
    if (builderSkip.dataset.mode !== (replay ? 'replay' : 'skip')) {
      builderSkip.dataset.mode = replay ? 'replay' : 'skip';
      builderSkip.setAttribute('aria-label', replay ? 'Replay draft animation' : 'Skip draft animation');
      builderSkip.title = replay ? 'Replay' : 'Skip';
      builderSkip.innerHTML = replay ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 8a8 8 0 1 1-1 7M5 3v5h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : 'Skip';
    }
    const statusElement = builderStatus.parentElement;
    if (statusElement.classList.contains('is-complete')) statusElement.classList.remove('is-complete');
    const previewDisabled = !draftReady || amount.getAttribute('aria-invalid') === 'true' || deadline.getAttribute('aria-invalid') === 'true';
    if (builderPreview.disabled !== previewDisabled) builderPreview.disabled = previewDisabled;
    const intake = 1 - portion(.12, .27);
    setStyle(buildIntake, '--intake-opacity', intake);
    setStyle(buildIntake, '--intake-y', `${-portion(.12, .27) * 24}px`);
    buildTracks.forEach(node => setStyle(node, '--build-progress', `${build * 100}%`));
    // Scope each reveal value to its existing consumers instead of inheriting
    // eight changing properties through the entire pinned scene.
    buildParts.forEach(({name, start, end, nodes, styleNodes}) => {
      const visible = portion(start, end);
      styleNodes.forEach(node => setStyle(node, `--hide-${name}`, `${(1 - visible) * 100}%`));
      nodes.forEach(node => {
        setAttribute(node, 'aria-hidden', String(stage === 0 || (stage === 1 && visible === 0)));
        if (node.matches('.typeset, .addition, .amount-field, .deadline-field')) {
          const inert = stage === 0 || (stage === 1 && visible < 1);
          if (node.inert !== inert) node.inert = inert;
        }
      });
    });
    // Three overlapping groups: heading and scope, tasks, then practical details.
    const groups = {title:[.12,.28],scope:[.12,.28],tasks:[.24,.42],practice:[.38,.58],state:[.38,.58],amount:[.38,.58],date:[.38,.58]};
    builderParts.forEach(node => {
      const visible = portion(...groups[node.dataset.buildPart]);
      setStyle(node, '--part-opacity', visible);
      const inert = stage !== 1 || visible < 1;
      if (node.inert !== inert) node.inert = inert;
      setAttribute(node, 'aria-hidden', String(visible === 0));
    });
    builderTasks.forEach(node => {
      if (node.style.opacity !== '1') node.style.opacity = '1';
      if (node.inert) node.inert = false;
      if (node.hasAttribute('aria-hidden')) node.removeAttribute('aria-hidden');
    });
    if (suggestedTask.style.opacity !== '1') suggestedTask.style.opacity = '1';
    if (suggestedTask.hasAttribute('aria-hidden')) suggestedTask.removeAttribute('aria-hidden');
    setText(builderStatus, draftReady ? 'Draft built' : 'LPC is building your Matter…');
    setAttribute(buildIntake, 'aria-hidden', String(stage !== 1 || intake === 0));
    if (stage === 1) setText(filmStatus, build < .25 ? 'READING YOUR NOTES' : build < .38 ? 'CREATING THE MATTER TITLE' : build < .53 ? 'WRITING THE SCOPE' : build < .73 ? 'ORGANIZING THE TASKS' : build < .84 ? 'ADDING YOUR AMOUNT' : build < .95 ? 'SUGGESTING A DELIVERY DATE' : 'CONFIRM DRAFT');

  }
  function measure() {
    const stableHeight = innerWidth <= 640
      ? Math.round(parseFloat(document.documentElement.style.getPropertyValue('--mobile-stable-height')))
      : 0;
    const viewportHeight = stableHeight || innerHeight;
    measuredViewportHeight = viewportHeight;
    const height = film.offsetHeight;
    const oversize = Math.max(0, height - viewportHeight);
    const builderBottom = builder.offsetTop + builder.offsetHeight;
    // Use the actual painted height for the sticky boundary. offsetHeight is
    // rounded and can release the scene a fraction of a pixel too early.
    setStyle(journey, '--film-height', `${film.getBoundingClientRect().height}px`);
    setStyle(journey, '--film-top', `${-oversize}px`);
    scrollStart = journey.getBoundingClientRect().top + scrollY + oversize;
    mobileFilmStart = scrollStart - oversize;
    mobileFilmEnd = mobileFilmStart + journey.offsetHeight;
    // Keep the notes/build thresholds at their original scroll positions.
    // The document ends its sticky travel at Preview instead of holding 03
    // for the unused last 36 percent of the original 260vh scroll range.
    scrollDistance = Math.max(1, Math.round(height + viewportHeight * 2.6) - Math.max(height, viewportHeight));
    // Mobile's draft is shifted upward to fit its controls. Give the final
    // preview time to return into view before the existing sticky release;
    // releasing and starting its entrance together sends 03 offscreen.
    // Keep Draft's .43 navigation target and the original section length.
    previewThreshold = innerWidth <= 760
      ? Math.max(.45, previewStart - Math.max(oversize, viewportHeight * .5) / scrollDistance)
      : previewStart;
    setStyle(journey, '--matter-release-distance', `${oversize + scrollDistance * previewStart}px`);
    updateFromScroll();
    setStyle(film, '--builder-bottom', `${builderBottom}px`);
  }
  function scheduleMeasure() {
    if (measureFrame) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      measure();
    });
  }
  function goTo(next) {
    if (next === 2 && !validate()) next = 1;
    if (reduced.matches) { setStage(next); return; }
    // Land at the start of Preview, before its natural scroll-out. The extra
    // pixel avoids falling back into Draft when a browser rounds scrollY.
    const target = scrollStart + scrollDistance * [0, .43, previewThreshold][next] + (next === 2 ? 1 : 0);
    scrollTo({top:target, behavior:reduced.matches ? 'instant' : 'smooth'});
  }
  builderSkip.addEventListener('click', () => {
    if (builderSkip.dataset.mode === 'replay') { setStage(1); return; }
    cancelAnimationFrame(buildFrame);
    renderBuild(1);
    builderSkip.focus({preventScroll:true});
  });
  film.querySelector('.stage-arrow-prev').addEventListener('click', () => goTo(Math.max(0, stage - 1)));
  film.querySelector('.stage-arrow-next').addEventListener('click', () => goTo(Math.min(2, stage + 1)));
  builderPreview.addEventListener('click', () => { if (validate()) goTo(2); });
  builderAmount.addEventListener('input', () => { amount.value = builderAmount.value; validate(); });
  builderDate.addEventListener('input', () => { deadline.value = builderDate.value; validate(); });
  builderDate.addEventListener('click', () => { try { builderDate.showPicker?.(); } catch {} });
  film.querySelector('#builder-title').addEventListener('input', event => { film.querySelector('.matter-title h2').textContent = event.target.value; });
  film.querySelector('#builder-scope').addEventListener('input', event => { film.querySelector('.scope-summary').textContent = event.target.value; });
  film.querySelectorAll('[data-builder-task]').forEach(input => input.addEventListener('input', () => { film.querySelectorAll('.task-toggle')[Number(input.dataset.builderTask)].textContent = input.value; }));
  advance.addEventListener('click', () => {
    if (stage === 0) goTo(1);
    else if (stage === 1 && validate()) goTo(2);
    else if (stage === 2) return;
  });
  film.querySelectorAll('.task-toggle').forEach(button => button.addEventListener('click', () => {
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'));
  }));
  deadline.addEventListener('click', () => {
    if (stage !== 1 || deadline.disabled) return;
    try { if (typeof deadline.showPicker === 'function') deadline.showPicker(); }
    catch { deadline.focus({preventScroll:true}); }
  });
  [amount, deadline].forEach(input => input.addEventListener('input', validate));
  addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(updateFromScroll); }, {passive:true});
  let viewportWidth = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth <= 640 && innerWidth === viewportWidth) return;
    viewportWidth = innerWidth;
    scheduleMeasure();
  }, {passive:true});
  reduced.addEventListener('change', () => {
    transitionTo(stage);
    setStage(stage);
    // The preceding capacity scene also changes height for reduced motion.
    // Measure after all preference handlers have applied their layouts.
    scheduleMeasure();
  });
  // Defer layout writes out of ResizeObserver delivery to avoid resize loops.
  new ResizeObserver(scheduleMeasure).observe(film);
  new ResizeObserver(() => { if (!builder.hidden) scheduleMeasure(); }).observe(builder);
  setStage(0); measure();
  document.fonts.ready.then(scheduleMeasure);
})();
