#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.join(repoRoot, "frontend");
const indexSource = fs.readFileSync(path.join(backendRoot, "index.js"), "utf8");

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function joinRoute(mount, route) {
  const left = String(mount || "").replace(/\/+$/g, "");
  const right = String(route || "").replace(/^\/+/, "");
  return `${left}/${right}`.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

function routeSegments(value) {
  return String(value || "").split("/").filter(Boolean);
}

function routeMatches(endpoint, registered, { prefix = false } = {}) {
  const actual = routeSegments(endpoint);
  const candidate = routeSegments(registered);
  if ((!prefix && actual.length !== candidate.length) || (prefix && actual.length > candidate.length)) return false;
  for (let index = 0; index < actual.length; index += 1) {
    const left = actual[index];
    const right = candidate[index];
    if (left === ":value" || right?.startsWith(":") || right === "*") continue;
    if (left !== right) return false;
  }
  return true;
}

function routeDeclarations(filePath, routerName = "router", seen = new Set()) {
  if (seen.has(filePath)) return [];
  seen = new Set([...seen, filePath]);
  const source = fs.readFileSync(filePath, "utf8");
  const escaped = routerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\.(?:get|post|put|patch|delete)\\s*\\(\\s*(["'\\x60])([^"'\\x60]+)\\1`, "g");
  const routes = [...source.matchAll(pattern)].map((match) => match[2]);
  // Follow locally required nested routers, including configured router factories.
  // Keep the real prefix so a child route cannot satisfy an unrelated API path.
  const nested = new RegExp(`${escaped}\\.use\\(\\s*(["'])([^"']+)\\1\\s*,\\s*require\\(["'](\\.[^"']+)["']\\)`, "g");
  for (const match of source.matchAll(nested)) {
    const target = require.resolve(path.resolve(path.dirname(filePath), match[3]));
    for (const route of routeDeclarations(target, "router", seen)) routes.push(joinRoute(match[2], route));
  }
  return routes;
}

function mountedRoutes() {
  const imports = new Map();
  for (const match of indexSource.matchAll(/const\s+(\w+)\s*=\s*require\(["']\.\/routes\/([^"']+)["']\)/g)) {
    imports.set(match[1], match[2]);
  }
  const registrations = new Set();
  for (const match of indexSource.matchAll(/app\.use\(\s*(["'])(\/api\/[^"']*)\1\s*,\s*(\w+)\s*\)/g)) {
    const mount = match[2];
    const routeFile = imports.get(match[3]);
    if (!routeFile) continue;
    for (const route of routeDeclarations(path.join(backendRoot, "routes", `${routeFile}.js`))) {
      registrations.add(joinRoute(mount, route));
    }
  }
  // The users module exports a second router for its /api/paralegals compatibility mount.
  for (const route of routeDeclarations(path.join(backendRoot, "routes", "users.js"), "paralegalRouter")) {
    registrations.add(joinRoute("/api/paralegals", route));
  }
  // The signed Stripe webhook is mounted with an inline require before the router imports.
  for (const route of routeDeclarations(path.join(backendRoot, "routes", "paymentsWebhook.js"))) {
    registrations.add(joinRoute("/api/webhooks/stripe", route));
  }
  for (const match of indexSource.matchAll(/app\.(?:get|post|put|patch|delete)\s*\(\s*(["'])(\/api\/[^"']*)\1/g)) {
    registrations.add(match[2].replace(/\/$/, ""));
  }
  return registrations;
}

function sourceFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(target));
    else if (/\.(?:html|js|mjs)$/.test(entry.name)) files.push(target);
  }
  return files;
}

function quotedStrings(source) {
  const values = [];
  const pattern = /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gs;
  for (const match of source.matchAll(pattern)) {
    values.push({ value: match[0].slice(1, -1), index: match.index });
  }
  return values;
}

function frontendEndpoints() {
  const endpoints = [];
  for (const filePath of sourceFiles(frontendRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const quoted of quotedStrings(source)) {
      if (!quoted.value.startsWith("/api/")) continue;
      const rawPath = quoted.value
        .split("?")[0]
        .replace(/&amp;.*$/, "")
        .replace(/(?<!\/)\$\{[^}]+\}$/g, "");
      const prefix = rawPath.endsWith("/");
      const normalized = rawPath
        .replace(/\$\{[^}]+\}/g, ":value")
        .replace(/\/$/, "");
      if (!normalized || normalized.includes("${") || /[<>]/.test(normalized)) continue;
      endpoints.push({
        endpoint: normalized,
        prefix,
        file: path.relative(repoRoot, filePath),
        line: lineOf(source, quoted.index),
      });
    }
  }
  return endpoints;
}

const registered = mountedRoutes();
const missing = frontendEndpoints().filter((entry) =>
  ![...registered].some((route) => routeMatches(entry.endpoint, route, { prefix: entry.prefix }))
);
const uniqueMissing = [...new Map(missing.map((entry) => [`${entry.file}:${entry.line}:${entry.endpoint}`, entry])).values()];

if (uniqueMissing.length) {
  console.error("[api-contract] Frontend API literals without a mounted backend route:");
  uniqueMissing.forEach((entry) => console.error(`- ${entry.file}:${entry.line} ${entry.endpoint}`));
  process.exit(1);
}

console.log(
  `[api-contract] ${frontendEndpoints().length} frontend API literals resolve against ${registered.size} mounted route patterns.`
);
