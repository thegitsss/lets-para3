const {
  CANONICAL_PUBLIC_DOCUMENT_PATHS,
  INDEXABLE_HTML_DOCUMENTS,
  setNoStoreHeaders,
  setStaticCacheHeaders,
  setStaticResponseHeaders,
} = require("../utils/staticCache");

function responseRecorder() {
  const headers = new Map();
  return {
    headers,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), String(value));
    },
  };
}

describe("static cache policy", () => {
  test("keeps HTML and application fallbacks out of browser caches", () => {
    const html = responseRecorder();
    setStaticCacheHeaders(html, "/app/frontend/login.html", { production: true });
    expect(html.headers.get("cache-control")).toBe("no-store");

    const fallback = responseRecorder();
    setNoStoreHeaders(fallback);
    expect(fallback.headers.get("cache-control")).toBe("no-store");
    expect(fallback.headers.get("pragma")).toBe("no-cache");
  });

  test("caches content-addressed fonts and vendored assets immutably", () => {
    const response = responseRecorder();
    setStaticCacheHeaders(response, "/app/frontend/assets/fonts/font-hash.woff2", { production: true });
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("revalidates mutable static assets so releases cannot mix old UI with a new API", () => {
    const response = responseRecorder();
    setStaticCacheHeaders(response, "/app/frontend/assets/scripts/dashboard.js", { production: true });
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  test("forces revalidation during local development", () => {
    const response = responseRecorder();
    setStaticCacheHeaders(response, "/app/frontend/assets/styles/app.css", { production: false });
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("serves browser ES modules with an executable JavaScript MIME type", () => {
    const response = responseRecorder();
    setStaticResponseHeaders(response, "/app/frontend/assets/scripts/search.mjs", { production: true });
    expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  test("indexes only the explicit public-document allowlist", () => {
    expect(INDEXABLE_HTML_DOCUMENTS).toEqual([
      "accessibility.html",
      "attorney-faq.html",
      "browse-paralegals.html",
      "contact.html",
      "index.html",
      "paralegal-admission.html",
      "paralegal-faq.html",
      "privacy.html",
      "terms.html",
    ]);

    const publicPage = responseRecorder();
    setStaticResponseHeaders(publicPage, "/app/frontend/index.html", { production: true });
    expect(publicPage.headers.has("x-robots-tag")).toBe(false);
    expect(publicPage.headers.get("link")).toBe(
      '<https://www.lets-paraconnect.com/>; rel="canonical"'
    );
    expect(Object.keys(CANONICAL_PUBLIC_DOCUMENT_PATHS)).toEqual(INDEXABLE_HTML_DOCUMENTS);

    for (const document of ["login.html", "dashboard-attorney.html", "new-private-page.html", "404.html"]) {
      const privatePage = responseRecorder();
      setStaticResponseHeaders(privatePage, `/app/frontend/${document}`, { production: true });
      expect(privatePage.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
});
