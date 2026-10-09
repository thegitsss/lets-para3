(() => {
  const hook = document.querySelector('.hero-capacity');
  if (!hook) return;
  const scene = hook.querySelector('.type-hook__scene');
  const inner = hook.querySelector('.type-hook__inner');
  const introHeading = hook.querySelector('#capacity-hook-title');
  let headingAnimation = null;
  let headingRange = '';
  let paperAnimations = [];
  let paperRange = '';
  let risingCloudAnimation = null;
  let risingCloudRange = '';
  let sideCloudAnimations = [];
  let sideCloudRange = '';
  const nativeHeadingSupported = typeof ScrollTimeline === 'function' && CSS.supports('animation-range', '100px 200px');
  const papers = [...hook.querySelectorAll('.type-hook__papers')];
  const foreground = hook.querySelector('.type-hook__papers--full');
  const headline = hook.querySelector('.type-hook__paper-headline');
  const clouds = [...hook.querySelectorAll('.type-hook__cloud')];
  const outline = hook.querySelector('.type-hook__outline');
  const paths = [...outline.querySelectorAll('path')];
  // Restore a little contrast above the clouds only for the opening Let’s characters.
  const clearLetters = outline.cloneNode(true);
  clearLetters.classList.add('type-hook__clear-letters');
  [...clearLetters.querySelectorAll('path')].forEach((path, index) => {
    if (index > 4) path.remove();
  });
  outline.after(clearLetters);
  const clearPaths = [...clearLetters.querySelectorAll('path')];
  const composite = hook.querySelector('.type-hook__composite');
  const smoke = hook.querySelector('.type-hook__smoke');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = value => Math.max(0, Math.min(1, value));
  // FIND uses GSAP's default power1.out for each tween and a 0.1s scrub.
  const ease = value => 1 - (1 - value) ** 2;
  const tween = (progress, start, duration) => ease(clamp((progress - start) / duration));
  let frame = 0;
  let previousTime = 0;
  let progress = 0;
  let sectionTop = 0;
  let sectionHeight = 1;

  let lastRenderedValue = null;
  let lastMobile = null;
  let lastEntranceOffset = null;
  let introductionTop = 0;
  let entranceStart = 0;
  let viewportHeight = innerHeight;
  // Older iOS uses the JS fallback. Avoid invalidating the masked scene for
  // unchanged SVG strokes, fills and opacity on every paper/cloud frame.
  const writtenStyles = new WeakMap();
  function writeStyle(element, property, value) {
    if (innerWidth > 767) { element.style[property] = value; return; }
    const text = String(value);
    let previous = writtenStyles.get(element);
    if (!previous) { previous = {}; writtenStyles.set(element, previous); }
    if (previous[property] === text) return;
    previous[property] = text;
    element.style[property] = text;
  }
  function render(value) {
    // An unchanged off-screen scene needs no SVG or inherited style updates.
    const mobile = innerWidth <= 767;
    const entrance = clamp((scrollY - entranceStart) / Math.max(1, sectionTop - entranceStart));
    const entranceOffset = mobile ? Math.max(0, introductionTop - 24) * (1 - entrance) : 0;
    if (mobile && value === lastRenderedValue && mobile === lastMobile && entranceOffset === lastEntranceOffset) return;
    lastEntranceOffset = entranceOffset;
    lastRenderedValue = value;
    lastMobile = mobile;
    if (mobile && !nativeHeadingSupported) {
      // iOS 18 supports Web Animations but not ScrollTimeline. Keep the same
      // keyframes on browser animation layers and advance their paused clocks.
      const seek = (animation, position) => {
        if (!animation) return;
        const time = clamp(position) * 1000;
        if (animation.currentTime !== time) animation.currentTime = time;
      };
      seek(headingAnimation, value / .2);
      papers.forEach((paper, index) => seek(paperAnimations[index], value));
      seek(paperAnimations[papers.length], (value - .24) / .18);
      seek(risingCloudAnimation, value);
      sideCloudAnimations.forEach(animation => seek(animation, value));
    }
    const travel = tween(value, 0, 1);
    const exit = tween(value, 0, .2);
    const ink = tween(value, .1, .14);
    const fill = tween(value, .24, .06);
    // Keep mobile text in the native sticky scene: JS counter-motion lags
    // asynchronous phone scrolling and continually re-rasterizes scaled glyphs.
    writeStyle(inner, 'transform', mobile
      ? 'none'
      : `translate3d(0, ${20 * travel}%, 0) scale(${1 - .1 * travel})`);
    if (mobile && headingAnimation) {
      writeStyle(inner, 'opacity', 1);
      [...inner.children].filter(child => child !== introHeading).forEach(child => { writeStyle(child, 'opacity', 1 - exit); });
    } else {
      writeStyle(inner, 'opacity', 1 - exit);
      [...inner.children].filter(child => child !== introHeading).forEach(child => { child.style.removeProperty('opacity'); });
    }
    if (!(mobile && paperAnimations.length)) {
      papers.forEach(paper => {
        writeStyle(paper, 'transform', `translate3d(0, ${-40 * travel}%, 0) scale(${1 + .3 * travel})`);
      });
    }
    // Let the smaller papers dissolve gradually into the mobile cloud sweep.
    if (!(mobile && paperAnimations.length)) writeStyle(foreground, 'opacity', 1 - tween(value, .24, mobile ? .18 : .06));
    // Clear the paper headline before the logo starts drawing at .1.
    writeStyle(headline, 'opacity', 1 - tween(value, .03, .06));
    if (!(mobile && sideCloudAnimations.length)) {
      clouds.forEach((cloud, index) => {
        writeStyle(cloud, 'transform', `translate3d(${(mobile ? (index ? -40 : 40) : (index ? 15 : -15)) * travel}%, 0, 0)`);
      });
    }
    if (!(mobile && risingCloudAnimation)) writeStyle(smoke, 'transform', `translate3d(0, ${70 * (1 - travel)}%, 0)`);
    const outlineOpacity = tween(value, .1, .01) * (1 - tween(value, .24, .06));
    writeStyle(outline, 'opacity', outlineOpacity);
    paths.forEach(path => { writeStyle(path, 'strokeDashoffset', 1 - ink); });
    writeStyle(composite, 'opacity', fill);
    writeStyle(clearLetters, 'opacity', .65);
    clearPaths.forEach((path) => {
      writeStyle(path, 'strokeDashoffset', 1 - ink);
      writeStyle(path, 'strokeOpacity', outlineOpacity);
      writeStyle(path, 'fill', path.classList.contains('type-hook__apostrophe-outline') ? '#6495ed' : '#233b5a');
      writeStyle(path, 'fillOpacity', fill);
    });
  }

  function scrollProgress() {
    return clamp((scrollY - sectionTop) / sectionHeight);
  }

  function update(time) {
    frame = 0;
    if (reduced.matches) return;
    const target = scrollProgress();
    // Phones follow the current swipe directly; no trailing scrub frames or resize resets.
    if (innerWidth <= 767) {
      progress = target;
      previousTime = 0;
      render(progress);
      return;
    }
    const elapsed = previousTime ? Math.max(0, time - previousTime) : 16;
    previousTime = time;
    progress += (target - progress) * (1 - Math.exp(-elapsed / 100));
    if (Math.abs(target - progress) < .0001) progress = target;
    render(progress);
    if (progress !== target) frame = requestAnimationFrame(update);
    else previousTime = 0;
  }

  function schedule() {
    if (!frame && !reduced.matches) frame = requestAnimationFrame(update);
  }

  function measure() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
    hook.classList.toggle('hook-find', !reduced.matches);
    viewportHeight = innerWidth <= 767
      ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--home-stable-viewport')) || innerHeight
      : innerHeight;
    introductionTop = inner.offsetTop;
    const rect = hook.getBoundingClientRect();
    sectionTop = rect.top + scrollY;
    sectionHeight = Math.max(1, rect.height);
    const heroNote = document.querySelector('.editorial-hero__publishing');
    const heroContentBottom = heroNote ? heroNote.getBoundingClientRect().bottom + scrollY : sectionTop - viewportHeight;
    // Keep the content gap steady during entry, then settle at center as the hero leaves.
    entranceStart = Math.max(sectionTop - viewportHeight,
      Math.min(heroContentBottom, sectionTop - Math.max(0, introductionTop - 24)));
    const range = `${sectionTop}:${sectionHeight}`;
    if (innerWidth <= 767 && !reduced.matches) {
      if (!headingAnimation || headingRange !== range) {
        headingAnimation?.cancel();
        headingAnimation = introHeading.animate([{ opacity: 1 }, { opacity: 0 }], {
          timeline: nativeHeadingSupported ? new ScrollTimeline({ source: document.scrollingElement, axis: 'block' }) : undefined,
          rangeStart: `${sectionTop}px`,
          rangeEnd: `${sectionTop + sectionHeight * .2}px`,
          duration: nativeHeadingSupported ? 'auto' : 1000, fill: 'both', easing: 'cubic-bezier(.333333,.666667,.666667,1)',
        });
        headingRange = range;
      }
    } else {
      headingAnimation?.cancel();
      headingAnimation = null;
      headingRange = '';
    }
    if (innerWidth <= 767 && !reduced.matches) {
      if (!paperAnimations.length || paperRange !== range) {
        paperAnimations.forEach(animation => animation.cancel());
        const timeline = nativeHeadingSupported ? new ScrollTimeline({ source: document.scrollingElement, axis: 'block' }) : undefined;
        const timing = { timeline, duration: nativeHeadingSupported ? 'auto' : 1000, fill: 'both', easing: 'cubic-bezier(.333333,.666667,.666667,1)' };
        paperAnimations = papers.map(paper => paper.animate([
          { transform: 'translate3d(0, 0%, 0) scale(1)' },
          { transform: 'translate3d(0, -40%, 0) scale(1.3)' },
        ], { ...timing, rangeStart: `${sectionTop}px`, rangeEnd: `${sectionTop + sectionHeight}px` }));
        paperAnimations.push(foreground.animate([{ opacity: 1 }, { opacity: 0 }], {
          ...timing, rangeStart: `${sectionTop + sectionHeight * .24}px`, rangeEnd: `${sectionTop + sectionHeight * .42}px`,
        }));
        paperRange = range;
      }
    } else {
      paperAnimations.forEach(animation => animation.cancel());
      paperAnimations = [];
      paperRange = '';
    }
    if (innerWidth <= 767 && !reduced.matches) {
      if (!risingCloudAnimation || risingCloudRange !== range) {
        risingCloudAnimation?.cancel();
        risingCloudAnimation = smoke.animate([
          { transform: 'translate3d(0, 70%, 0)' },
          { transform: 'translate3d(0, 0%, 0)' },
        ], {
          timeline: nativeHeadingSupported ? new ScrollTimeline({ source: document.scrollingElement, axis: 'block' }) : undefined,
          rangeStart: `${sectionTop}px`, rangeEnd: `${sectionTop + sectionHeight}px`,
          duration: nativeHeadingSupported ? 'auto' : 1000, fill: 'both', easing: 'cubic-bezier(.333333,.666667,.666667,1)',
        });
        risingCloudRange = range;
      }
    } else {
      risingCloudAnimation?.cancel();
      risingCloudAnimation = null;
      risingCloudRange = '';
    }
    if (innerWidth <= 767 && !reduced.matches) {
      if (!sideCloudAnimations.length || sideCloudRange !== range) {
        sideCloudAnimations.forEach(animation => animation.cancel());
        const timeline = nativeHeadingSupported ? new ScrollTimeline({ source: document.scrollingElement, axis: 'block' }) : undefined;
        sideCloudAnimations = clouds.map((cloud, index) => cloud.animate([
          { transform: 'translate3d(0%, 0, 0)' },
          { transform: `translate3d(${index ? -40 : 40}%, 0, 0)` },
        ], { timeline, rangeStart: `${sectionTop}px`, rangeEnd: `${sectionTop + sectionHeight}px`,
          duration: nativeHeadingSupported ? 'auto' : 1000, fill: 'both', easing: 'cubic-bezier(.333333,.666667,.666667,1)' }));
        sideCloudRange = range;
      }
    } else {
      sideCloudAnimations.forEach(animation => animation.cancel());
      sideCloudAnimations = [];
      sideCloudRange = '';
    }
    if (!nativeHeadingSupported) {
      [headingAnimation, ...paperAnimations, risingCloudAnimation, ...sideCloudAnimations]
        .filter(Boolean).forEach(animation => animation.pause());
    }
    lastRenderedValue = null;
    progress = reduced.matches ? 0 : scrollProgress();
    render(progress);
  }

  addEventListener('scroll', schedule, { passive: true });
  let layoutWidth = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth <= 767 && innerWidth === layoutWidth) return;
    layoutWidth = innerWidth;
    measure();
  }, { passive: true });
  addEventListener('pageshow', measure);
  reduced.addEventListener('change', measure);
  // Font and upstream layout changes can move the scene after initial paint.
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(measure);
    observer.observe(document.querySelector('.editorial-hero') || document.body);
    observer.observe(scene);
  }
  measure();
  document.fonts.ready.then(measure);
})();
