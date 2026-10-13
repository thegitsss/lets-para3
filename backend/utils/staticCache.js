const path = require("path");

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const CANONICAL_PUBLIC_DOCUMENT_PATHS = Object.freeze({
  "accessibility.html": "/accessibility.html",
  "attorney-faq.html": "/attorney-faq.html",
  "browse-paralegals.html": "/browse-paralegals.html",
  "contact.html": "/contact.html",
  "index.html": "/",
  "paralegal-admission.html": "/paralegal-admission.html",
  "paralegal-faq.html": "/paralegal-faq.html",
});
const INDEXABLE_HTML_DOCUMENTS = Object.freeze(Object.keys(CANONICAL_PUBLIC_DOCUMENT_PATHS));
const INDEXABLE_HTML_SET = new Set(INDEXABLE_HTML_DOCUMENTS);

function setNoStoreHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function setStaticCacheHeaders(res, filePath, { production = process.env.NODE_ENV === "production" } = {}) {
  const normalizedPath = String(filePath || "").replace(/\\/g, "/");
  const extension = path.extname(normalizedPath).toLowerCase();

  if (extension === ".html") {
    setNoStoreHeaders(res);
    return;
  }

  if (!production) {
    res.setHeader("Cache-Control", "no-cache");
    return;
  }

  if (/\/assets\/(?:fonts|vendor)\//.test(normalizedPath)) {
    res.setHeader("Cache-Control", `public, max-age=${ONE_YEAR_SECONDS}, immutable`);
    return;
  }

  // Most LPC asset URLs are stable filenames, not content hashes. Let browsers
  // retain them for conditional requests, but require revalidation on every use
  // so a deploy cannot leave users running stale frontend code against a new API.
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
}

function setStaticResponseHeaders(res, filePath, options) {
  setStaticCacheHeaders(res, filePath, options);
  const normalizedPath = String(filePath || "").replace(/\\/g, "/");
  const extension = path.extname(normalizedPath).toLowerCase();
  if (extension === ".mjs") {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    return;
  }
  if (extension !== ".html") return;
  const documentName = path.basename(normalizedPath).toLowerCase();
  if (!INDEXABLE_HTML_SET.has(documentName)) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return;
  }
  res.setHeader(
    "Link",
    `<https://www.lets-paraconnect.com${CANONICAL_PUBLIC_DOCUMENT_PATHS[documentName]}>; rel="canonical"`
  );
}

module.exports = {
  CANONICAL_PUBLIC_DOCUMENT_PATHS,
  INDEXABLE_HTML_DOCUMENTS,
  setNoStoreHeaders,
  setStaticCacheHeaders,
  setStaticResponseHeaders,
};
