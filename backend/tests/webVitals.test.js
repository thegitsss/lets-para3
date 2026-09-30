const {
  GOOD_THRESHOLDS,
  isGoodP75,
  isTrustedVitalsRequest,
  normalizePagePath,
  normalizeWebVitalSample,
} = require("../utils/webVitals");

function request(headers = {}, protocol = "https") {
  return {
    protocol,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
}

describe("Core Web Vitals telemetry", () => {
  test("accepts only privacy-minimized, bounded samples", () => {
    expect(normalizeWebVitalSample({
      metric: "lcp",
      value: 1840.27,
      rating: "poor",
      page: "/dashboard-attorney.html?caseId=secret#funds",
      deviceClass: "mobile",
      navigationType: "back_forward",
      connectionType: "4g",
      userId: "must-not-survive",
    })).toEqual({
      metric: "LCP",
      value: 1840.3,
      rating: "good",
      page: "/dashboard-attorney.html",
      deviceClass: "mobile",
      navigationType: "back-forward",
      connectionType: "4g",
    });
  });

  test("derives ratings from values instead of trusting client labels", () => {
    expect(normalizeWebVitalSample({ metric: "INP", value: 201, rating: "good", page: "/" }).rating)
      .toBe("needs-improvement");
    expect(normalizeWebVitalSample({ metric: "CLS", value: 0.3, rating: "good", page: "/" }).rating)
      .toBe("poor");
  });

  test("rejects unsupported metrics, invalid paths, and implausible values", () => {
    expect(normalizeWebVitalSample({ metric: "FID", value: 10, page: "/" })).toBeNull();
    expect(normalizeWebVitalSample({ metric: "CLS", value: 11, page: "/" })).toBeNull();
    expect(normalizeWebVitalSample({ metric: "INP", value: 100, page: "https://example.com" })).toBeNull();
    expect(normalizePagePath("//evil.example/path")).toBe("");
  });

  test("uses Google's current good p75 thresholds", () => {
    expect(GOOD_THRESHOLDS).toEqual({ CLS: 0.1, INP: 200, LCP: 2500 });
    expect(isGoodP75("LCP", 2500)).toBe(true);
    expect(isGoodP75("INP", 201)).toBe(false);
    expect(isGoodP75("CLS", 0.101)).toBe(false);
  });

  test("accepts same-origin samples and rejects cross-site telemetry pollution", () => {
    const env = { NODE_ENV: "production", APP_BASE_URL: "https://www.lets-paraconnect.com" };
    expect(isTrustedVitalsRequest(request({
      origin: "https://www.lets-paraconnect.com",
      host: "www.lets-paraconnect.com",
      "sec-fetch-site": "same-origin",
    }), env)).toBe(true);
    expect(isTrustedVitalsRequest(request({
      origin: "https://evil.example",
      host: "www.lets-paraconnect.com",
      "sec-fetch-site": "cross-site",
    }), env)).toBe(false);
    expect(isTrustedVitalsRequest(request({ host: "www.lets-paraconnect.com" }), env)).toBe(false);
  });
});
