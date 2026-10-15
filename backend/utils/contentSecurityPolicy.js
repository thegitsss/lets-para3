const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function walkHtmlFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkHtmlFiles(target);
    return entry.isFile() && entry.name.endsWith(".html") ? [target] : [];
  });
}

function inlineScriptBodies(source) {
  const scripts = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of String(source).matchAll(pattern)) scripts.push(match[1]);
  return scripts;
}

function sha256Source(content) {
  return `'sha256-${crypto.createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

function upgradeInsecureRequestsDirective(production) {
  return production ? [] : null;
}

function collectInlineScriptHashes(frontendDirectory) {
  const hashes = new Set();
  for (const filePath of walkHtmlFiles(frontendDirectory)) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const body of inlineScriptBodies(source)) hashes.add(sha256Source(body));
  }
  return [...hashes].sort();
}

module.exports = {
  collectInlineScriptHashes,
  inlineScriptBodies,
  sha256Source,
  upgradeInsecureRequestsDirective,
};
