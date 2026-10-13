(() => {
  const legalHero = document.querySelector(".privacy-hero, .terms-hero");
  const artwork = legalHero?.querySelector(".utility-hero__art");
  if (!legalHero) return;
  if (!artwork) {
    const header = document.querySelector('[data-public-header]');
    if (header && 'IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => header.classList.toggle('is-past-hero', !entry.isIntersecting),
        { rootMargin: '-72px 0px 0px 0px' }).observe(legalHero);
    }
    return;
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frameId = 0;

  const motionIsDisabled = () => (
    reducedMotion.matches ||
    document.body.classList.contains("accessibility-mode") ||
    document.documentElement.classList.contains("accessibility-mode")
  );

  const syncHeroParallax = () => {
    frameId = 0;
    if (motionIsDisabled()) {
      artwork.style.removeProperty("--legal-hero-field-y");
      return;
    }

    const rect = legalHero.getBoundingClientRect();
    const progress = Math.max(0, Math.min(1, -rect.top / Math.max(1, rect.height)));
    const travel = window.innerWidth <= 640 ? 58 : 78;
    artwork.style.setProperty("--legal-hero-field-y", `${(progress * travel).toFixed(1)}px`);
  };

  const scheduleHeroParallax = () => {
    if (frameId) return;
    frameId = window.requestAnimationFrame(syncHeroParallax);
  };

  window.addEventListener("scroll", scheduleHeroParallax, { passive: true });
  window.addEventListener("resize", scheduleHeroParallax, { passive: true });
  reducedMotion.addEventListener?.("change", scheduleHeroParallax);
  new MutationObserver(scheduleHeroParallax).observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
  syncHeroParallax();
})();
