const fs = require("fs");
const path = require("path");

// Used only by an explicit local preview server or a synthetic browser fixture.
// Production index.js never mounts this archive.
const archiveRoot = path.resolve(__dirname, "../../docs/design-previews/retained-2026-09-08/frontend");
function resolvePreviewAsset(requestUrl) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname); }
  catch (_) { return null; } // An invalid URL has no preview asset.
  const target = path.resolve(archiveRoot, `.${pathname}`);
  return target.startsWith(archiveRoot + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
}
module.exports = { resolvePreviewAsset };
