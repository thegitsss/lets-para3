#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lockfile = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const policy = manifest.allowScripts || {};

function packageNameFromLockPath(lockPath, entry = {}) {
  if (entry.name) return entry.name;
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return "";
  const remainder = lockPath.slice(index + marker.length);
  const parts = remainder.split("/");
  return remainder.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const scriptedDependencies = Object.entries(lockfile.packages || {})
  .filter(([lockPath, entry]) => lockPath && entry?.hasInstallScript)
  .map(([lockPath, entry]) => ({
    lockPath,
    name: packageNameFromLockPath(lockPath, entry),
    version: String(entry.version || ""),
  }));

const uncovered = scriptedDependencies.filter(({ name, version }) => {
  const exact = `${name}@${version}`;
  return !Object.prototype.hasOwnProperty.call(policy, exact) && !Object.prototype.hasOwnProperty.call(policy, name);
});

const unpinnedApprovals = Object.entries(policy)
  .filter(([selector, allowed]) => allowed === true && !/@[^/]+$/.test(selector))
  .map(([selector]) => selector);

const stale = Object.keys(policy).filter((selector) => {
  if (selector.includes("@", 1)) {
    return !scriptedDependencies.some(({ name, version }) => `${name}@${version}` === selector);
  }
  return !scriptedDependencies.some(({ name }) => name === selector);
});

if (uncovered.length || unpinnedApprovals.length || stale.length) {
  if (uncovered.length) {
    console.error(`[install-scripts] Missing decisions: ${uncovered.map(({ name, version }) => `${name}@${version}`).join(", ")}`);
  }
  if (unpinnedApprovals.length) {
    console.error(`[install-scripts] Allowed scripts must be version-pinned: ${unpinnedApprovals.join(", ")}`);
  }
  if (stale.length) {
    console.error(`[install-scripts] Stale policy entries: ${stale.join(", ")}`);
  }
  process.exit(1);
}

console.log(`[install-scripts] ${scriptedDependencies.length} dependency install scripts have explicit, reviewable decisions.`);
