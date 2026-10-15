const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

// These UI contracts mock authentication and API records; the current Matter
// modules and their dependencies still execute in the browser unchanged.
function prepareMatterModule(source) {
  const authImport = /^import\s+\{[^}]+\}\s+from\s+["']\.\/auth\.js["'];?\s*$/m;
  assert.match(source, authImport, "Expected the explicit Matter authentication import");
  return source.replace(authImport, `
const secureFetch = (url, options = {}) => fetch(url, { ...options, credentials: "include", headers: { ...(options.headers || {}), "Content-Type": options.body && !(options.body instanceof FormData) ? "application/json" : undefined }, body: options.body && !(options.body instanceof FormData) && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body });
const fetchCSRF = async () => "test-csrf";
const showMsg = (node, message) => { if (node) node.textContent = message || ""; };
const loadUserHeaderInfo = async () => {};
const applyRoleVisibility = (role) => document.querySelectorAll("[data-visible]").forEach((node) => { node.hidden = node.dataset.visible !== role; });
`).replace(/\bfrom (["'])\.\//g, "from $1/assets/scripts/");
}

async function fulfillFrontendAsset(route, repositoryRoot) {
  const pathname = new URL(route.request().url()).pathname;
  if (!pathname.startsWith("/assets/")) return false;
  const root = path.resolve(repositoryRoot, "frontend");
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    await route.fulfill({ status: 404, body: "" });
    return true;
  }
  const types = { ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg" };
  await route.fulfill({ contentType: types[path.extname(file)] || "application/octet-stream", body: fs.readFileSync(file) });
  return true;
}

module.exports = { prepareMatterModule, fulfillFrontendAsset };
