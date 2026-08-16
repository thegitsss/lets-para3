const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const directories = ["ai", "email", "middleware", "models", "routes", "scheduler", "scripts", "services", "tests", "utils"];
const files = [path.join(root, "index.js")];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "test-results", ".cache"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.isFile() && /\.(?:c?js|mjs)$/.test(entry.name)) files.push(target);
  }
}

for (const directory of directories) {
  const target = path.join(root, directory);
  if (fs.existsSync(target)) visit(target);
}

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}\n${result.stderr || result.stdout}`);
}

if (failures.length) {
  console.error(`[syntax] ${failures.length} JavaScript file(s) failed parsing:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log(`[syntax] Parsed ${files.length} JavaScript files successfully.`);
