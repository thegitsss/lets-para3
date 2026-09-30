#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { verifyFrontendBuild } = require("../utils/frontendAssets");
const BACKEND_RUNTIME_ROOTS = ["routes", "services", "utils"].map((directory) =>
  path.resolve(__dirname, "..", directory)
);
const KIB = 1024;
const BUDGETS = Object.freeze({
  total: 7 * 1024 * KIB,
  html: 250 * KIB,
  javascript: 400 * KIB,
  stylesheet: 150 * KIB,
  raster: 600 * KIB,
  icon: 128 * KIB,
});
const TEXT_EXTENSIONS = new Set([
  ".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt", ".webmanifest", ".xml",
]);
const RASTER_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const REDIRECT_MARKERS = ["http-equiv=\"refresh\"", "window.location.replace("];

function isCanonicalRedirect(html) {
  return (
    /<body\b[^>]*\bdata-redirect-target=(?:"[^"]+"|'[^']+')[^>]*>/i.test(html) &&
    /<script\b[^>]*\bsrc=(?:"[^"]*canonical-redirect\.js(?:\?[^"#]*)?"|'[^']*canonical-redirect\.js(?:\?[^'#]*)?')[^>]*>/i.test(html)
  );
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".DS_Store") return [];
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function relative(filePath, frontendRoot) {
  return path.relative(frontendRoot, filePath).split(path.sep).join("/");
}

function formatBytes(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

function rasterSignatureIsValid(filePath, extension) {
  const bytes = fs.readFileSync(filePath);
  if (extension === ".png") {
    return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (extension === ".gif") return bytes.subarray(0, 3).toString("ascii") === "GIF";
  if (extension === ".webp") {
    return bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return true;
}

function main() {
  const { frontendRoot } = verifyFrontendBuild();
  const files = walk(frontendRoot);
  const failures = [];
  const totalBytes = files.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);
  if (totalBytes > BUDGETS.total) {
    failures.push(`built frontend payload is ${formatBytes(totalBytes)}; budget is ${formatBytes(BUDGETS.total)}`);
  }

  const searchableText = files
    .filter((filePath) => TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .concat(
      BACKEND_RUNTIME_ROOTS.flatMap((directory) => walk(directory)).filter((filePath) =>
        [".js", ".json", ".mjs"].includes(path.extname(filePath).toLowerCase())
      )
    )
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");

  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    const bytes = fs.statSync(filePath).size;
    const rel = relative(filePath, frontendRoot);
    let limit = null;
    let kind = "asset";

    if (extension === ".html") [limit, kind] = [BUDGETS.html, "HTML"];
    if ([".js", ".mjs"].includes(extension)) [limit, kind] = [BUDGETS.javascript, "JavaScript"];
    if (extension === ".css") [limit, kind] = [BUDGETS.stylesheet, "stylesheet"];
    if (RASTER_EXTENSIONS.has(extension)) [limit, kind] = [BUDGETS.raster, "raster image"];
    if (RASTER_EXTENSIONS.has(extension) && /(favicon|icon|logo)/i.test(path.basename(filePath))) {
      [limit, kind] = [BUDGETS.icon, "icon/logo"];
    }
    if (limit !== null && bytes > limit) {
      failures.push(`${rel} is a ${formatBytes(bytes)} ${kind}; budget is ${formatBytes(limit)}`);
    }

    if (RASTER_EXTENSIONS.has(extension)) {
      if (!rasterSignatureIsValid(filePath, extension)) {
        failures.push(`${rel} contents do not match its ${extension} extension`);
      }
      const basename = path.basename(filePath);
      if (!searchableText.includes(basename)) {
        failures.push(`${rel} is not referenced by any frontend source, manifest, or production backend consumer`);
      }
    }

    if (extension === ".html") {
      const html = fs.readFileSync(filePath, "utf8");
      const isRedirect = REDIRECT_MARKERS.some((marker) => html.includes(marker)) || isCanonicalRedirect(html);
      const hasRum = /assets\/scripts\/(?:utils\/session|accessibility-toggle|web-vitals-rum)\.js/.test(html);
      if (!isRedirect && !hasRum) {
        failures.push(`${rel} is a real entry page without Core Web Vitals measurement`);
      }
    }
  }

  if (failures.length) {
    console.error("Performance budget check failed:\n- " + failures.join("\n- "));
    process.exit(1);
  }

  console.log(
    `Performance budgets passed (${files.length} files, ${formatBytes(totalBytes)} total; ` +
    `largest raster budget ${formatBytes(BUDGETS.raster)}).`
  );
}

if (require.main === module) {
  main();
}

module.exports = { isCanonicalRedirect };
