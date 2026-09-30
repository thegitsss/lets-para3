const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOTS = ["middleware", "routes", "services", "utils"];
const ALLOWED = new Set(["utils/logger.js"]);
const RAW_CONSOLE = /\bconsole\.(?:log|warn|error|info|debug)\s*\(/g;

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".js") ? [absolute] : [];
  });
}

const files = RUNTIME_ROOTS.flatMap((root) => collectJavaScriptFiles(path.join(ROOT, root)));
const violations = [];

for (const absolute of files) {
  const relative = path.relative(ROOT, absolute).split(path.sep).join("/");
  if (ALLOWED.has(relative)) continue;
  const source = fs.readFileSync(absolute, "utf8");
  source.split(/\r?\n/).forEach((line, index) => {
    RAW_CONSOLE.lastIndex = 0;
    if (RAW_CONSOLE.test(line)) violations.push(`${relative}:${index + 1}`);
  });
}

if (violations.length) {
  process.stderr.write(
    `[logging] Runtime modules must use createLogger() so secrets and email addresses are redacted:\n${violations.join("\n")}\n`
  );
  process.exit(1);
}

process.stdout.write(`[logging] ${files.length} runtime modules use the redacting logger contract.\n`);
