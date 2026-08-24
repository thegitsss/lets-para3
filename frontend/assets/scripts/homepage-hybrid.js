(() => {
  "use strict";

  const hero = document.querySelector("[data-find-hero]");
  if (!hero) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frame = 0;

  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const smoothstep = (start, end, value) => {
    const progress = clamp((value - start) / Math.max(0.0001, end - start));
    return progress * progress * (3 - (2 * progress));
  };

  const motionDisabled = () => (
    reducedMotion.matches ||
    document.documentElement.classList.contains("accessibility-mode") ||
    document.body.classList.contains("accessibility-mode")
  );

  const render = () => {
    frame = 0;

    if (motionDisabled()) {
      hero.style.setProperty("--hero-scene-progress", "0");
      hero.style.setProperty("--hero-copy-opacity", "1");
      return;
    }

    const rect = hero.getBoundingClientRect();
    const travel = Math.max(1, hero.offsetHeight - window.innerHeight);
    const progress = clamp(-rect.top / travel);
    hero.style.setProperty("--hero-scene-progress", progress.toFixed(4));
    hero.style.setProperty(
      "--hero-copy-opacity",
      (1 - smoothstep(0.55, 0.96, progress)).toFixed(4)
    );
  };

  const schedule = () => {
    if (frame) return;
    frame = window.requestAnimationFrame(render);
  };

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule);
  reducedMotion.addEventListener("change", schedule);

  const accessibilityObserver = new MutationObserver(schedule);
  accessibilityObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  accessibilityObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });

  render();
})();
