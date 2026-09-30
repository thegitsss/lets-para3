(function redirectToCanonicalSurface() {
  function redirect() {
    const targetValue = String(document.body?.dataset?.redirectTarget || "").trim();
    if (!targetValue) return;
    const source = new URL(window.location.href);
    const target = new URL(targetValue, source);
    if (document.body.dataset.preserveSearch === "true") {
      source.searchParams.forEach((value, key) => target.searchParams.set(key, value));
    }
    window.location.replace(target.toString());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", redirect, { once: true });
  } else {
    redirect();
  }
})();
