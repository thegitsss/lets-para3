const fs = require("fs");
const path = require("path");

const testsRoot = path.resolve(__dirname, "../tests");
const forbidden = /\b(?:describe|test|it)\.(?:only|skip)\s*\(|\bfit\s*\(|\bfdescribe\s*\(|\bxit\s*\(|\bxdescribe\s*\(/g;
const violations = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.isFile() && /\.(?:c?js|mjs)$/.test(entry.name)) {
      const content = fs.readFileSync(target, "utf8");
      for (const match of content.matchAll(forbidden)) {
        const line = content.slice(0, match.index).split("\n").length;
        violations.push(`${path.relative(testsRoot, target)}:${line} ${match[0].trim()}`);
      }
    }
  }
}

visit(testsRoot);
if (violations.length) {
  console.error(`[tests] Focused or skipped tests are forbidden in launch branches:\n${violations.join("\n")}`);
  process.exit(1);
}
console.log("[tests] No focused or skipped tests found.");
