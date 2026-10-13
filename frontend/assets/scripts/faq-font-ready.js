(() => {
  "use strict";
  const root = document.documentElement;
  if (!document.fonts) return;
  // This head script runs before the headings can paint. Keep their layout,
  // then show the design after the light face and deferred header are ready.
  root.classList.add("faq-font-loading");
  let finished = false;
  const finish = (loaded) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (!loaded) root.classList.add("faq-font-fallback");
    root.classList.remove("faq-font-loading");
  };
  // Do not leave headings hidden if a font request fails or stalls. In that
  // case keep a readable fallback for this navigation, without a later swap.
  const timeout = setTimeout(() => finish(false), 8000);
  const pageReady = document.readyState === "loading"
    ? new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }))
    : Promise.resolve();
  Promise.all([
    document.fonts.load('300 1em "Cormorant Garamond"', "Attorney FAQ Paralegal FAQ"),
    pageReady,
  ]).then(([faces]) => finish(faces.length > 0), () => finish(false));
})();
