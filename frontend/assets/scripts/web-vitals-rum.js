import { onCLS, onINP, onLCP } from "/assets/vendor/web-vitals-6.1.1.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function shouldCollect() {
  return !LOCAL_HOSTS.has(window.location.hostname) && window.__LPC_DISABLE_RUM__ !== true;
}

function sendMetric(metric) {
  const payload = JSON.stringify({
    metric: metric.name,
    value: metric.value,
    rating: metric.rating,
    page: window.location.pathname,
    deviceClass: window.matchMedia("(max-width: 767px)").matches ? "mobile" : "desktop",
    navigationType: metric.navigationType || "navigate",
    connectionType: navigator.connection?.effectiveType || "unknown",
  });

  if (navigator.sendBeacon) {
    const accepted = navigator.sendBeacon(
      "/api/performance/vitals",
      new Blob([payload], { type: "application/json" })
    );
    if (accepted) return;
  }

  fetch("/api/performance/vitals", {
    method: "POST",
    credentials: "omit",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: payload,
  }).catch(() => {});
}

if (shouldCollect()) {
  onCLS(sendMetric);
  onINP(sendMetric);
  onLCP(sendMetric);
}
