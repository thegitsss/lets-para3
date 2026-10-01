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
    const alreadyVisible = getComputedStyle(hero.querySelector(".editorial-hero__inner")).opacity === "1";
    title.setAttribute('aria-label', groups.map(e => e.textContent.trim()).join(' '));
    groups.forEach(e => { linesFor(e); e.setAttribute('aria-hidden', 'true'); });
    hero.classList.add('hero-entrance-ready');
    if (alreadyVisible || motion.matches || document.body.classList.contains('accessibility-mode')) return;
    const lineStagger = innerWidth <= 640 ? 33 : 100;
    const targets = [
      ...[...hero.querySelectorAll('.hero-motion-line')].map((el, i) => [el, 400 + i * lineStagger]),
      [hero.querySelector('.editorial-hero__qualifier'), 400],
      [hero.querySelector('.editorial-hero__support'), 600],
      [hero.querySelector('.editorial-hero__actions'), 850],
      [hero.querySelector('.editorial-hero__publishing'), 883],
      [hero.querySelector('.editorial-hero__reassurance'), 916],
    ];
    animations = targets.filter(([el]) => el).map(([el, delay]) => el.animate([
      { opacity: 0, filter: 'blur(10px)', transform: 'translateY(20%)' },
      { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0%)' },
    ], { duration: 1000, delay, easing: 'cubic-bezier(.25,.1,.25,1)', fill: 'both' }));
    Promise.all(animations.map(a => a.finished.catch(() => {}))).then(() => animations.forEach(a => a.cancel()));
  };
  // Fonts get a bounded head start; an unavailable font cannot hold up the hero.
  const fontReady = document.fonts ? document.fonts.ready : Promise.resolve();
  Promise.race([fontReady, new Promise(resolve => setTimeout(resolve, 600))]).then(reveal);
  motion.addEventListener('change', () => { if (motion.matches) animations.forEach(a => a.cancel()); });
  // Once revealed, resizing restores natural wrapping without replaying the entrance.
  let width = innerWidth;
  addEventListener('resize', () => {
    if (innerWidth === width || !hero.classList.contains('hero-entrance-ready')) return;
    width = innerWidth; setMobileHeight(); animations.forEach(a => a.cancel());
    groups.forEach(e => e.replaceChildren(originalText.get(e)));
  }, { passive: true });
})();
