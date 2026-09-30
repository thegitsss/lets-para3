const fs = require("fs");
const http = require("http");
const path = require("path");
const { resolvePreviewAsset } = require("./design-preview-assets");
const includeDesignPreviews = process.argv.includes("--design-previews");

const frontendRoot = require("../utils/frontendAssets").frontendDirectory({ built: process.argv.includes("--built") });
const notFoundDocument = path.join(frontendRoot, "404.html");
const vendorFiles = new Map([
  ["/assets/vendor/chart-4.5.1.js", path.resolve(__dirname, "../node_modules/chart.js/dist/chart.umd.js")],
  [
    "/assets/vendor/simplewebauthn-13.3.0.js",
    path.resolve(__dirname, "../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js"),
  ],
  ["/assets/vendor/web-vitals-6.1.1.js", path.resolve(__dirname, "../node_modules/web-vitals/dist/web-vitals.js")],
]);
const port = Number(process.env.PORT || 5054);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".zip": "application/zip",
};

function resolveRequestPath(requestUrl = "/") {
  if (includeDesignPreviews) {
    const preview = resolvePreviewAsset(requestUrl);
    if (preview) return preview;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname); }
  catch (_) { return null; } // Invalid URLs do not identify a public asset.
  if (vendorFiles.has(pathname)) return vendorFiles.get(pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(frontendRoot, relativePath);
  return target.startsWith(`${frontendRoot}${path.sep}`) ? target : null;
}

const server = http.createServer((request, response) => {
  const target = resolveRequestPath(request.url);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
    });
    fs.createReadStream(notFoundDocument).pipe(response);
    return;
  }
  response.writeHead(200, {
    "Cache-Control": vendorFiles.has(new URL(request.url, "http://127.0.0.1").pathname)
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "Content-Type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream",
  });
  fs.createReadStream(target).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[accessibility-server] http://127.0.0.1:${server.address().port}`);
  if (includeDesignPreviews) console.log("[design-preview] Archived sample screens are enabled on this loopback server.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
