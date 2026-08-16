const fs = require("fs");
const path = require("path");

const routesRoot = path.resolve(__dirname, "../routes");
const routePattern = /router\.(get|post|put|patch|delete)\(\s*["`]([^"`]+)["`]/g;
const duplicates = [];
let routeCount = 0;

for (const entry of fs.readdirSync(routesRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  const target = path.join(routesRoot, entry.name);
  const source = fs.readFileSync(target, "utf8");
  const seen = new Map();

  for (const match of source.matchAll(routePattern)) {
    const key = `${match[1].toUpperCase()} ${match[2]}`;
    const line = source.slice(0, match.index).split("\n").length;
    routeCount += 1;
    if (seen.has(key)) {
      duplicates.push(`${entry.name}:${seen.get(key)},${line} ${key}`);
    } else {
      seen.set(key, line);
    }
  }
}

if (duplicates.length) {
  console.error(`[routes] Duplicate method/path registrations found:\n${duplicates.join("\n")}`);
  process.exit(1);
}

console.log(`[routes] ${routeCount} literal route registrations are unique within their routers.`);
