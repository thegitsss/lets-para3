#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const runtimeDirectories = ["ai", "middleware", "models", "routes", "scheduler", "services", "utils"];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function resolveLocalModule(importer, specifier) {
  if (!String(specifier).startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function localDependencies(filePath, dependencyRoot = backendRoot) {
  const source = fs.readFileSync(filePath, "utf8");
  const dependencies = new Set();
  const patterns = [
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\.resolve\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*(?:\([^)]*|[^;]*?\bfrom\s*)["']([^"']+)["']/g,
    /\bexport\s+[^;]*?\bfrom\s*["']([^"']+)["']/g,
  ];
  patterns.forEach((pattern) => {
    for (const match of source.matchAll(pattern)) {
      const resolved = resolveLocalModule(filePath, match[1]);
      if (resolved?.startsWith(path.resolve(dependencyRoot) + path.sep)) dependencies.add(resolved);
    }
  });
  return [...dependencies];
}

function declaredEntrypoints() {
  const roots = new Set([path.join(backendRoot, "index.js")]);
  const packageJson = JSON.parse(fs.readFileSync(path.join(backendRoot, "package.json"), "utf8"));
  Object.values(packageJson.scripts || {}).forEach((command) => {
    for (const match of String(command).matchAll(/(?:^|&&|\|\|)\s*(?:[^&|]*?\s)?node(?:\s+--[^\s]+)*\s+(scripts\/[\w./-]+\.(?:js|mjs))/g)) {
      const target = path.join(backendRoot, match[1]);
      if (fs.existsSync(target)) roots.add(target);
    }
  });
  return roots;
}

function reachableFiles({ dependencyRoot = backendRoot } = {}) {
  const reachable = new Set();
  const queue = [...declaredEntrypoints()];
  while (queue.length) {
    const filePath = queue.pop();
    if (reachable.has(filePath)) continue;
    reachable.add(filePath);
    localDependencies(filePath, dependencyRoot).forEach((dependency) => {
      if (!reachable.has(dependency)) queue.push(dependency);
    });
  }
  return reachable;
}

function run() {
  const runtimeFiles = runtimeDirectories
    .flatMap((directory) => walk(path.join(backendRoot, directory)))
    .filter((filePath) => /\.(?:js|mjs)$/.test(filePath));
  const reachable = reachableFiles();
  const orphaned = runtimeFiles
    .filter((filePath) => !reachable.has(filePath))
    .map((filePath) => path.relative(backendRoot, filePath).split(path.sep).join("/"))
    .sort();

  if (orphaned.length) {
    console.error("[backend-reachability] Runtime modules without a declared production or operational entrypoint:");
    orphaned.forEach((filePath) => console.error(`- ${filePath}`));
    process.exitCode = 1;
    return;
  }
  console.log(`[backend-reachability] ${runtimeFiles.length} runtime modules are reachable from declared entrypoints.`);
}

if (require.main === module) run();

module.exports = { declaredEntrypoints, localDependencies, reachableFiles, resolveLocalModule, run };
