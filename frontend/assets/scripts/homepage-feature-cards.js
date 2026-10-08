(() => {
  "use strict";
  const section = document.getElementById("lpc-feature-cards");
  if (!section) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let visible = false;

  function sync() {
    const still = reducedMotion.matches;
    section.classList.toggle("animation-still", still);
    section.classList.toggle("paused", still || !visible || document.hidden);
  }

  reducedMotion.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    }, { threshold: 0 }).observe(section);
  } else {
    visible = true;
  }
  sync();
})();
