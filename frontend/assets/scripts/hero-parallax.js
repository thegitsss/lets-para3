const HERO_SELECTOR = '.hero-banner';

function initHeroParallax(selector = HERO_SELECTOR) {
  const hero = document.querySelector(selector);
  if (!hero) return;

  const updateHeroParallax = () => {
    const offset = window.scrollY * 0.2;
    hero.style.backgroundPosition = `center calc(50% + ${offset}px)`;
  };

  hero.style.backgroundPosition = 'center center';
  window.addEventListener('scroll', updateHeroParallax, { passive: true });
  window.addEventListener('resize', updateHeroParallax);
  updateHeroParallax();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initHeroParallax());
  } else {
    initHeroParallax();
  }
}

export default initHeroParallax;
