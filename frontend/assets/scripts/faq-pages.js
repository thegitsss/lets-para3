(() => {
  const hero = document.querySelector('.hero-banner');
  const header = document.querySelector('[data-public-header]');
  if (hero && header && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      header.classList.toggle('is-past-hero', !entry.isIntersecting);
    }, { rootMargin: '-72px 0px 0px 0px' }).observe(hero);
  }

  // Keep incoming bookmarks to individual answers usable after the redesign.
  const openLinkedAnswer = () => {
    const target = document.getElementById(location.hash.slice(1));
    if (target?.matches('.faq-item')) {
      target.open = true;
      requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    }
  };
  window.addEventListener('hashchange', openLinkedAnswer);
  openLinkedAnswer();
})();
