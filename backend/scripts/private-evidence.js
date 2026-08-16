#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const backendRoot = path.resolve(__dirname, "..");
const evidenceRoot = path.join(backendRoot, "test-results");

function applyPrivateArtifactUmask(platform = process.platform) {
  if (platform !== "win32" && typeof process.umask === "function") process.umask(0o077);
}

function walkPrivateTree(root, visitor) {
  const resolvedRoot = path.resolve(root);
  let rootStats;
  try {
    rootStats = fs.lstatSync(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("Evidence root must be a real directory.");
  }

  const visit = (target) => {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error("Evidence trees must not contain symbolic links.");
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error("Evidence trees may contain only regular files and directories.");
    }
    visitor(target, stats);
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
    }
  };
  visit(resolvedRoot);
  return true;
}

function inspectPrivateTree(root, platform = process.platform) {
  if (platform === "win32") return [];
  const violations = [];
  const resolvedRoot = path.resolve(root);
  try {
    walkPrivateTree(resolvedRoot, (target, stats) => {
      if ((stats.mode & 0o077) !== 0) {
        violations.push(path.relative(resolvedRoot, target) || ".");
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return violations;
}

function securePrivateTree(root, platform = process.platform) {
  if (platform === "win32") return false;
  return walkPrivateTree(root, (target, stats) => {
    fs.chmodSync(target, stats.isDirectory() ? 0o700 : 0o600);
  });
}

function assertEvidenceRoot(root = evidenceRoot) {
  const resolved = path.resolve(root);
  if (resolved !== evidenceRoot) throw new Error("Evidence permission policy is restricted to backend/test-results.");
  return resolved;
}

function secureEvidenceTree(root = evidenceRoot) {
  return securePrivateTree(assertEvidenceRoot(root));
}

function main(argv = process.argv.slice(2)) {
  applyPrivateArtifactUmask();
  if (argv.includes("--secure")) secureEvidenceTree();
  const violations = inspectPrivateTree(evidenceRoot);
  if (violations.length) {
    console.error(
      `[evidence-permissions] ${violations.length} evidence path(s) are group/world accessible: ${violations.slice(0, 12).join(", ")}`
    );
    process.exitCode = 1;
    return;
  }
  console.log("[evidence-permissions] Generated test evidence is owner-only or not present.");
}

if (require.main === module) main();

module.exports = {
  applyPrivateArtifactUmask,
  evidenceRoot,
  inspectPrivateTree,
  secureEvidenceTree,
  securePrivateTree,
  walkPrivateTree,
};
