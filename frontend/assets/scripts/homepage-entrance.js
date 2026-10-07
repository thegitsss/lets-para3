(() => {
  'use strict';
  const hero = document.querySelector('.editorial-hero');
  if (!hero) return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const title = hero.querySelector('h1');
  const groups = [...hero.querySelectorAll('.editorial-hero__line')];
  let animations = [];
  const originalText = new Map(groups.map(e => [e, e.textContent.trim()]));
  const setMobileHeight = () => {
    // Height-only toolbar changes must not switch the draft card layout.
    document.documentElement.classList.toggle('mobile-compact-height', innerHeight <= 880);
    if (innerWidth > 640) { document.documentElement.style.removeProperty('--mobile-stable-height'); return; }
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;height:100svh;width:0;visibility:hidden;pointer-events:none';
    document.body.append(probe);
    document.documentElement.style.setProperty('--mobile-stable-height', `${probe.getBoundingClientRect().height}px`);
    probe.remove();
  };
  setMobileHeight();
  // Measure rendered lines so the stagger follows typography at every width.
  function linesFor(element) {
    const words = element.textContent.trim().split(/\s+/);
    const measure = document.createElement('span');
    measure.className = 'hero-line-measure';
    words.forEach((word, i) => {
      const span = document.createElement('span'); span.textContent = word;
      measure.append(span); if (i < words.length - 1) measure.append(' ');
    });
    element.replaceChildren(measure);
    const rows = [];
    [...measure.children].forEach(word => {
      const top = word.getBoundingClientRect().top;
      const row = rows.at(-1);
      if (row && Math.abs(row.top - top) < 2) row.words.push(word.textContent);
      else rows.push({ top, words: [word.textContent] });
    });
    element.replaceChildren(...rows.map(row => {
      const line = document.createElement('span'); line.className = 'hero-motion-line';
      line.textContent = row.words.join(' '); return line;
    }));
  }
  const reveal = () => {
    // CSS is already revealing the hero. Only enhance physical lines before
    // any text appears; a late script must never hide or restart visible text.
    const entrance = groups[0]?.getAnimations().find(a => a.animationName === 'hero-first-frame-enter');
    const elapsed = entrance ? Number(entrance.currentTime ?? 0) : Infinity;
    hero.classList.add('hero-entrance-ready');
    if (motion.matches || document.body.classList.contains('accessibility-mode') || elapsed >= 400) return;
    title.setAttribute('aria-label', groups.map(e => e.textContent.trim()).join(' '));
    groups.forEach(e => { linesFor(e); e.setAttribute('aria-hidden', 'true'); });
    hero.classList.add('hero-lines-ready');
    const lineStagger = innerWidth <= 640 ? 33 : 100;
    const startTime = document.timeline.currentTime - elapsed;
    animations = [...hero.querySelectorAll('.hero-motion-line')].map((el, i) => {
      const animation = el.animate([
        { opacity: 0, filter: 'blur(10px)', transform: 'translateY(20%)' },
        { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0%)' },
      ], { duration: 1000, delay: 400 + i * lineStagger, easing: 'cubic-bezier(.25,.1,.25,1)', fill: 'both' });
      animation.startTime = startTime;
      return animation;
    });
    Promise.all(animations.map(a => a.finished.catch(() => {}))).then(() => animations.forEach(a => a.cancel()));
  };
  // Font readiness only improves line measurement; it never gates visibility.
  const fontReady = document.fonts ? document.fonts.ready : Promise.resolve();
  Promise.race([fontReady, new Promise(resolve => setTimeout(resolve, 200))]).then(reveal);
  motion.addEventListener('change', () => { if (motion.matches) animations.forEach(a => a.cancel()); });
  // Once revealed, resizing restores natural wrapping without replaying the entrance.
  let width = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth === width || !hero.classList.contains('hero-entrance-ready')) return;
    width = innerWidth; setMobileHeight(); animations.forEach(a => a.cancel());
    groups.forEach(e => e.replaceChildren(originalText.get(e)));
  }, { passive: true });
})();
