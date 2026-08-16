import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  findSilentAwaitCatches,
  findUnmarkedUnusedParameters,
  findUnusedBindings,
} from "./check-frontend-bindings.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(scriptDirectory, "..");
const runtimeDirectories = Object.freeze([
  "ai",
  "diagnostics",
  "email",
  "middleware",
  "models",
  "ops",
  "routes",
  "scheduler",
  "scripts",
  "services",
  "utils",
]);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function runtimeFiles(root = backendRoot) {
  return [
    path.join(root, "index.js"),
    ...runtimeDirectories.flatMap((directory) => walk(path.join(root, directory))),
  ]
    .filter((filePath) => /\.(?:c?js|mjs)$/.test(filePath) && fs.existsSync(filePath))
    .sort();
}

function checkRuntimeBindings(root = backendRoot) {
  const files = runtimeFiles(root);
  const issues = [];
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    let unused;
    let unmarkedUnusedParameters;
    let silentAwaitCatches;
    try {
      unused = findUnusedBindings(source, filePath);
      unmarkedUnusedParameters = findUnmarkedUnusedParameters(source, filePath);
      silentAwaitCatches = findSilentAwaitCatches(source, filePath);
    } catch (error) {
      issues.push({
        filePath,
        line: error?.loc?.line || 1,
        message: `could not parse: ${error.message}`,
      });
      continue;
    }
    for (const binding of unused) {
      issues.push({
        filePath,
        line: binding.line,
        message: `unused ${binding.kind} binding ${binding.name}`,
      });
    }
    for (const parameter of unmarkedUnusedParameters) {
      issues.push({
        filePath,
        line: parameter.line,
        message: `unused parameter ${parameter.name}; remove it or prefix it with _ when a positional contract requires it`,
      });
    }
    for (const caught of silentAwaitCatches) {
      issues.push({
        filePath,
        line: caught.line,
        message: "empty catch silently swallows awaited work",
      });
    }
  }
  return { files, issues };
}

function run() {
  const { files, issues } = checkRuntimeBindings();
  if (issues.length) {
    console.error("Runtime binding check failed:");
    for (const issue of issues) {
      const relativePath = path.relative(backendRoot, issue.filePath).split(path.sep).join("/");
      console.error(`- ${relativePath}:${issue.line} ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[runtime-bindings] ${files.length} runtime modules contain no unused bindings or silent awaited catches.`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();

export { checkRuntimeBindings, runtimeFiles };
