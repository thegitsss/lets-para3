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
  let stage = 0, frame = 0, scrollStart = 0, scrollDistance = 1;
  const disclosure = '';
  const builder = film.querySelector('.dashboard-builder');
  const builderSkip = film.querySelector('.builder-skip');
  const builderPreview = film.querySelector('.builder-preview');
  const builderAmount = film.querySelector('#builder-amount');
  const builderDate = film.querySelector('#builder-date');
  const brief = film.querySelector('.builder-brief');
  const originalNotes = brief.innerHTML.replace(/<br\s*\/?>/gi, '\n');
  brief.setAttribute('aria-label', `Your original notes: ${originalNotes}`);
  const typedNotes = document.createElement('span');
  typedNotes.setAttribute('aria-hidden', 'true');
  brief.replaceChildren(typedNotes);
  let typedCount = -1;
  let draftReady = false;
  let buildFrame = 0;
  const postedDate = film.querySelector('.posted-date');
  const editorNote = film.querySelector('.editor-note > span:nth-child(3)');
  const buildIntake = film.querySelector('.build-intake');
  const buildBars = [...film.querySelectorAll('.build-track span, .builder-progress > span')];
  const builderStatus = film.querySelector('[data-builder-status]');
  const statusLabel = film.querySelector('[data-status]');
  const builderStatusGroup = builder.querySelector('.builder-status');
  const suggestedTask = builder.querySelector('[data-suggestion-task]');
  const builderTasks = [...builder.querySelectorAll('[data-builder-task]')];
  const buildParts = [
    ['title', .25, .38, '.matter-title h2, .matter-location', '.matter-title'],
    ['scope', .38, .53, '.scope-summary', '.scope-summary'],
    ['tasks', .53, .73, '.tasks-label, .typeset, .addition', '.tasks-label, .fragment, .addition'],
    ['amount', .73, .84, '.amount-field', '.amount-field'],
    ['date', .84, .95, '.deadline-field', '.deadline-field']
  ].map(([name, start, end, selector, consumers]) => ({
    name, start, end,
    nodes: [...film.querySelectorAll(selector)].map(node => ({node, interactive: node.matches('.typeset, .addition, .amount-field, .deadline-field')})),
    consumers: [...film.querySelectorAll(consumers)]
  }));
  const groupTiming = {title:[.12,.28],scope:[.12,.28],tasks:[.24,.42],practice:[.38,.58],state:[.38,.58],amount:[.38,.58],date:[.38,.58]};
  const buildGroups = [...builder.querySelectorAll('[data-build-part]')].map(node => ({node, timing: groupTiming[node.dataset.buildPart]}));
  const setAttribute = (node, name, value) => {
    value = String(value);
    if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    if (name === 'aria-hidden' && node.querySelector('button,input,select,textarea,a[href]')) {
      const inert = value === 'true';
      if (node.inert !== inert) node.inert = inert;
    }
  };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const setStyle = (node, name, value) => {
    value = String(value);
    if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
  };
  let validationKey = null;
  let validationResult = false;
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

  async function transitionTo(next) {
    requestedStage = next;
    if (reduced.matches) {
      transitionVersion++;
      sceneAnimation?.cancel();
      sceneAnimation = null;
      changingStage = false;
      scene.inert = false;
      delete film.dataset.transitioning;
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
    const key = `${amount.value}|${deadline.value}|${stage}|${draftReady}`;
    if (key === validationKey) return validationResult;
    validationKey = key;
    const validAmount = amount.value !== '' && Number.isFinite(Number(amount.value)) && Number(amount.value) >= 400 && Number(amount.value) <= 100000 && Number.isInteger(Number(amount.value));
    const validDate = deadline.value >= '2026-06-06' && deadline.value <= '2026-06-27';
    const valid = validAmount && validDate;
    validationResult = valid;
    advance.disabled = stage === 1 && !valid;
    builderPreview.disabled = !valid || !draftReady;
    setAttribute(amount, 'aria-invalid', !validAmount);
    setAttribute(deadline, 'aria-invalid', !validDate);
    if (stage === 1) setText(feedback, valid ? disclosure : 'Set an amount of $400–$100,000 and a due date from June 6–27 for this example.');
    if (validDate) {
      const date = new Date(`${deadline.value}T12:00:00`);
      setText(postedDate, date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
      if (postedDate.dateTime !== deadline.value) postedDate.dateTime = deadline.value;
      setText(editorNote, `One-page memo. $${Number(amount.value).toLocaleString('en-US')}. Due ${date.toLocaleDateString('en-US', {month:'long',day:'numeric'})}.`);
    }
    return valid;
  }
  function setStage(next) {
    validationKey = null;
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
    film.querySelector('.amount-input').inert = stage === 0;
    film.querySelector('.deadline-input').setAttribute('aria-hidden', String(stage !== 1));
    film.querySelector('.deadline-input').inert = stage !== 1;
    film.querySelector('.posted-date').setAttribute('aria-hidden', String(stage !== 2));
    film.querySelectorAll('.task-toggle').forEach(button => { button.tabIndex = stage === 0 ? -1 : 0; button.disabled = stage === 0; });
    feedback.textContent = disclosure;
    film.classList.toggle('edits-visible', stage >= 1);
    validate();
    cancelAnimationFrame(buildFrame);
    if (stage === 1 && previousStage !== 2 && !reduced.matches) {
      const started = performance.now();
      renderBuild(0);
      const tick = now => {
        if (stage !== 1) return;
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
    let next = progress < .26 ? 0 : progress < .64 ? 1 : 2;
    if (next === 2 && !validate()) next = 1;
    transitionTo(next);
  }
  function renderBuild(build) {
    const portion = (start, end) => Math.max(0, Math.min(1, (build - start) / (end - start)));
    const count = reduced.matches ? originalNotes.length : Math.floor(portion(.02, .65) * originalNotes.length);
    if (count !== typedCount) {
      // Reset before changing the text, avoiding a forced layout after each letter.
      if (brief.scrollTop !== 0) brief.scrollTop = 0;
      typedNotes.textContent = originalNotes.slice(0, count);
      typedCount = count;
    }
    brief.classList.toggle('is-typing', stage === 1 && count < originalNotes.length);
    draftReady = build >= .62;
    builder.classList.toggle('is-ready', stage === 1 && draftReady);
    if (builderSkip.hidden !== (stage !== 1)) builderSkip.hidden = stage !== 1;
    const replay = build >= 1;
    if (builderSkip.dataset.mode !== (replay ? 'replay' : 'skip')) {
      builderSkip.dataset.mode = replay ? 'replay' : 'skip';
      builderSkip.setAttribute('aria-label', replay ? 'Replay draft animation' : 'Skip draft animation');
      builderSkip.title = replay ? 'Replay' : 'Skip';
      builderSkip.innerHTML = replay ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 8a8 8 0 1 1-1 7M5 3v5h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : 'Skip';
    }
    if (builderStatusGroup.classList.contains('is-complete')) builderStatusGroup.classList.remove('is-complete');
    const previewDisabled = !draftReady || amount.getAttribute('aria-invalid') === 'true' || deadline.getAttribute('aria-invalid') === 'true';
    if (builderPreview.disabled !== previewDisabled) builderPreview.disabled = previewDisabled;
    const intake = 1 - portion(.12, .27);
    // Animate only the elements that consume these values, rather than
    // invalidating inherited styles across the entire Matter on every frame.
    setStyle(buildIntake, '--intake-opacity', intake);
    setStyle(buildIntake, '--intake-y', `${-portion(.12, .27) * 24}px`);
    buildBars.forEach(node => setStyle(node, '--build-progress', `${build * 100}%`));
    buildParts.forEach(({name, start, end, nodes, consumers}) => {
      const visible = portion(start, end);
      consumers.forEach(node => setStyle(node, `--hide-${name}`, `${(1 - visible) * 100}%`));
      nodes.forEach(({node, interactive}) => {
        setAttribute(node, 'aria-hidden', stage === 0 || (stage === 1 && visible === 0));
        const inert = stage === 0 || (stage === 1 && visible < 1);
        if (interactive && node.inert !== inert) node.inert = inert;
      });
    });
    // Three overlapping groups: heading and scope, tasks, then practical details.
    buildGroups.forEach(({node, timing}) => {
      const visible = portion(...timing);
      setStyle(node, '--part-opacity', visible);
      const inert = stage !== 1 || visible < 1;
      if (node.inert !== inert) node.inert = inert;
      setAttribute(node, 'aria-hidden', visible === 0);
    });
    builderTasks.forEach(node => {
      setStyle(node, 'opacity', '1');
      if (node.inert) node.inert = false;
      if (node.hasAttribute('aria-hidden')) node.removeAttribute('aria-hidden');
    });
    setStyle(suggestedTask, 'opacity', '1');
    if (suggestedTask.hasAttribute('aria-hidden')) suggestedTask.removeAttribute('aria-hidden');
    setText(builderStatus, draftReady ? 'Draft built' : 'LPC is building your Matter…');
    setAttribute(buildIntake, 'aria-hidden', stage !== 1 || intake === 0);
    if (stage === 1) setText(statusLabel, build < .25 ? 'READING YOUR NOTES' : build < .38 ? 'CREATING THE MATTER TITLE' : build < .53 ? 'WRITING THE SCOPE' : build < .73 ? 'ORGANIZING THE TASKS' : build < .84 ? 'ADDING YOUR AMOUNT' : build < .95 ? 'SUGGESTING A DELIVERY DATE' : 'CONFIRM DRAFT');

  }
  function measure() {
    const height = film.offsetHeight;
    const stableHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--home-stable-viewport'));
    const viewportHeight = innerWidth <= 767 && Number.isFinite(stableHeight) ? stableHeight : innerHeight;
    const oversize = Math.max(0, height - viewportHeight);
    setStyle(journey, '--film-height', `${height}px`);
    setStyle(journey, '--film-top', `${-oversize}px`);
    scrollStart = journey.getBoundingClientRect().top + scrollY + oversize;
    scrollDistance = Math.max(1, journey.offsetHeight - Math.max(height, viewportHeight));
    updateFromScroll();
    setStyle(film, '--builder-bottom', `${builder.offsetTop + builder.offsetHeight}px`);
  }
  function goTo(next) {
    if (next === 2 && !validate()) next = 1;
    if (reduced.matches) { setStage(next); return; }
    const target = scrollStart + scrollDistance * [0, .43, .83][next];
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
    else if (stage === 2) location.assign('signup.html?role=attorney');
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
  let layoutWidth = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth <= 767 && innerWidth === layoutWidth) return;
    layoutWidth = innerWidth;
    measure();
  }, {passive:true});
  reduced.addEventListener('change', () => {
    transitionTo(stage);
    setStage(stage);
    // The preceding capacity scene also changes height for reduced motion.
    // Measure after all preference handlers have applied their layouts.
    requestAnimationFrame(measure);
  });
  // Resize callbacks write scene geometry; deliver those writes after the
  // current observer batch so shallower layout observers can settle normally.
  const afterResize = action => {
    let pendingFrame = 0;
    return () => {
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; action(); });
    };
  };
  new ResizeObserver(afterResize(measure)).observe(film);
  new ResizeObserver(afterResize(() => { if (!builder.hidden) setStyle(film, '--builder-bottom', `${builder.offsetTop + builder.offsetHeight}px`); })).observe(builder);
  setStage(0); measure();
  document.fonts.ready.then(measure);
})();
