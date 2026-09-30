(() => {
  const hero = document.querySelector('.admission-hero');
  const header = document.querySelector('[data-public-header]');
  if (!hero || !header || !('IntersectionObserver' in window)) return;
  new IntersectionObserver(([entry]) => {
    header.classList.toggle('is-past-hero', !entry.isIntersecting);
  }, { rootMargin: '-72px 0px 0px 0px' }).observe(hero);
})();
