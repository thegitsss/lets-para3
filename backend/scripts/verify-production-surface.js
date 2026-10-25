#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { RELEASE_COMMIT_HEADER } = require("../utils/releaseIdentity");
const { collectInlineScriptHashes } = require("../utils/contentSecurityPolicy");
const { REQUIRED_CANDIDATE_FILES } = require("./check-release-candidate");

const repositoryRoot = path.resolve(__dirname, "../..");
const frontendDirectory = path.join(repositoryRoot, "frontend");
const PRODUCTION_ORIGIN = "https://www.lets-paraconnect.com";
const DEFAULT_CANDIDATE_PATH = path.join(
  repositoryRoot,
  "backend/test-results/release/candidate.json"
);
const DEFAULT_OUTPUT_PATH = path.join(
  repositoryRoot,
  "backend/test-results/release/production-surface.json"
);
const NOT_FOUND_ROUTE = "/__lpc-release-probe-page-that-does-not-exist__";
const SURFACES = Object.freeze([
  {
    route: "/",
    candidateFile: "frontend/index.html",
    canonical: "https://www.lets-paraconnect.com/",
    contentType: /^text\/html\b/i,
    cacheControl: "no-store",
  },
  {
    route: "/terms.html",
    candidateFile: "frontend/terms.html",
    canonical: "https://www.lets-paraconnect.com/terms.html",
    contentType: /^text\/html\b/i,
    cacheControl: "no-store",
  },
  {
    route: "/privacy.html",
    candidateFile: "frontend/privacy.html",
    canonical: "https://www.lets-paraconnect.com/privacy.html",
    contentType: /^text\/html\b/i,
    cacheControl: "no-store",
  },
  {
    route: "/robots.txt",
    candidateFile: "public/robots.txt",
    contentType: /^text\/plain\b/i,
    cacheControl: "public, max-age=0, must-revalidate",
  },
  {
    route: "/sitemap.xml",
    candidateFile: "public/sitemap.xml",
    contentType: /^(?:application|text)\/xml\b/i,
    cacheControl: "public, max-age=0, must-revalidate",
  },
]);

function fail(message) {
  const error = new Error(`[production-surface] ${message}`);
  error.code = "PRODUCTION_SURFACE_INVALID";
  throw error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertRegularFile(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is missing: ${filePath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${filePath}`);
}

function readCandidateManifest(candidatePath = DEFAULT_CANDIDATE_PATH) {
  assertRegularFile(candidatePath, "Candidate manifest");
  try {
    return JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  } catch (error) {
    fail(`Candidate manifest is not valid JSON: ${error.message}`);
  }
}

function currentCommit(repoRoot = repositoryRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().toLowerCase();
  } catch (error) {
    fail(`Could not read the current Git commit: ${String(error?.stderr || error?.message).trim()}`);
  }
}

function currentWorkingTreeStatus(repoRoot = repositoryRoot) {
  try {
    return execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim();
  } catch (error) {
    fail(`Could not inspect the working tree: ${String(error?.stderr || error?.message).trim()}`);
  }
}

function validateCandidateManifest(
  candidate,
  {
    repoRoot = repositoryRoot,
    expectedCommit = currentCommit(repoRoot),
    workingTreeStatus = currentWorkingTreeStatus(repoRoot),
  } = {}
) {
  const commit = String(candidate?.commit || "").trim().toLowerCase();
  if (candidate?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(commit)) {
    fail("Candidate manifest must contain schemaVersion 1 and a full Git commit.");
  }
  if (commit !== String(expectedCommit || "").trim().toLowerCase()) {
    fail(`Candidate manifest commit ${commit} does not match checked-out HEAD ${expectedCommit}.`);
  }
  if (String(workingTreeStatus || "").trim()) {
    fail("Production verification must run from the clean checkout that produced the candidate manifest.");
  }
  if (!candidate.generatedAt || Number.isNaN(new Date(candidate.generatedAt).getTime())) {
    fail("Candidate manifest has no valid generation timestamp.");
  }

  for (const candidateFile of REQUIRED_CANDIDATE_FILES) {
    const expectedHash = String(candidate?.files?.[candidateFile] || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      fail(`Candidate manifest does not bind ${candidateFile}. Run npm run check:candidate first.`);
    }
    const absolutePath = path.resolve(repoRoot, candidateFile);
    if (!absolutePath.startsWith(`${path.resolve(repoRoot)}${path.sep}`)) {
      fail(`Candidate surface escapes the repository: ${candidateFile}`);
    }
    assertRegularFile(absolutePath, "Candidate surface");
    const observedHash = sha256(fs.readFileSync(absolutePath));
    if (observedHash !== expectedHash) {
      fail(`${candidateFile} no longer matches the retained candidate manifest.`);
    }
  }
  return { ...candidate, commit };
}

function requireHeader(response, name, expected) {
  const value = String(response.headers.get(name) || "").trim();
  if (expected instanceof RegExp) {
    if (!expected.test(value)) fail(`${name} is missing or invalid (${value || "missing"}).`);
  } else if (value.toLowerCase() !== String(expected).toLowerCase()) {
    fail(`${name} must be ${expected}, received ${value || "missing"}.`);
  }
  return value;
}

function assertReleaseHeader(response, commit, route) {
  const observed = String(response.headers.get(RELEASE_COMMIT_HEADER) || "").trim().toLowerCase();
  if (observed !== commit) {
    fail(`${route} reports release ${observed || "missing"}; expected ${commit}.`);
  }
}

function parseContentSecurityPolicy(value) {
  const directives = new Map();
  for (const item of String(value || "").split(";")) {
    const tokens = item.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (directives.has(name)) {
      fail(`Content-Security-Policy repeats ${name}; duplicate directives are ambiguous.`);
    }
    directives.set(name, tokens.slice(1));
  }
  return directives;
}

function requireExactDirective(directives, name, expectedSources) {
  const observed = directives.get(name);
  if (!observed) fail(`Content-Security-Policy is missing ${name}.`);
  const expected = new Set(expectedSources);
  if (
    observed.length !== expected.size ||
    observed.some((source) => !expected.has(source))
  ) {
    fail(
      `Content-Security-Policy ${name} must be exactly ${expectedSources.join(" ") || "present without sources"}.`
    );
  }
}

function validateSecurityHeaders(response) {
  const hsts = requireHeader(response, "strict-transport-security", /max-age=(\d+)/i);
  const maxAge = Number(hsts.match(/max-age=(\d+)/i)?.[1] || 0);
  if (maxAge < 31536000 || !/\bincludesubdomains\b/i.test(hsts) || !/\bpreload\b/i.test(hsts)) {
    fail("Strict-Transport-Security must use at least one year, includeSubDomains, and preload.");
  }
  requireHeader(response, "x-content-type-options", "nosniff");
  requireHeader(response, "x-frame-options", "SAMEORIGIN");
  requireHeader(response, "referrer-policy", "no-referrer");
  requireHeader(response, "cross-origin-opener-policy", "same-origin");
  requireHeader(response, "cross-origin-resource-policy", "same-origin");
  requireHeader(response, "origin-agent-cluster", "?1");

  const csp = requireHeader(response, "content-security-policy", /\bscript-src\b/i);
  const directives = parseContentSecurityPolicy(csp);
  const expectedScriptSources = [
    "'self'",
    ...collectInlineScriptHashes(frontendDirectory),
    "https://js.stripe.com",
    "https://challenges.cloudflare.com",
  ];
  requireExactDirective(directives, "script-src", expectedScriptSources);
  for (const [directive, sources] of [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'self'"]],
    ["object-src", ["'none'"]],
    ["script-src-attr", ["'none'"]],
    ["upgrade-insecure-requests", []],
  ]) {
    requireExactDirective(directives, directive, sources);
  }

  return {
    contentSecurityPolicySha256: sha256(Buffer.from(csp, "utf8")),
    hsts,
    crossOriginOpenerPolicy: response.headers.get("cross-origin-opener-policy"),
    crossOriginResourcePolicy: response.headers.get("cross-origin-resource-policy"),
    originAgentCluster: response.headers.get("origin-agent-cluster"),
    referrerPolicy: response.headers.get("referrer-policy"),
    xContentTypeOptions: response.headers.get("x-content-type-options"),
    xFrameOptions: response.headers.get("x-frame-options"),
  };
}

async function request(origin, route, fetchFn, timeoutMs, expectedStatus = 200) {
  let response;
  try {
    response = await fetchFn(`${origin}${route}`, {
      method: "GET",
      headers: {
        Accept: route === "/api/health" ? "application/json" : "*/*",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail(`${route} request failed (${String(error?.name || error?.code || "REQUEST_FAILED")}).`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (response.status !== expectedStatus) {
    fail(`${route} returned HTTP ${response.status}; expected ${expectedStatus}.`);
  }
  return { response, body };
}

async function verifyProductionSurface({
  origin = PRODUCTION_ORIGIN,
  candidate,
  fetchFn = fetch,
  timeoutMs = 15_000,
  now = () => new Date(),
} = {}) {
  if (origin !== PRODUCTION_ORIGIN) fail(`Production origin must be exactly ${PRODUCTION_ORIGIN}.`);
  const commit = String(candidate?.commit || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) fail("A validated candidate manifest is required.");

  const healthResult = await request(origin, "/api/health", fetchFn, timeoutMs);
  assertReleaseHeader(healthResult.response, commit, "/api/health");
  const healthContentType = requireHeader(
    healthResult.response,
    "content-type",
    /^application\/json\b/i
  );
  requireHeader(healthResult.response, "cache-control", "no-store");
  let health;
  try {
    health = JSON.parse(healthResult.body.toString("utf8"));
  } catch {
    fail("/api/health did not return valid JSON.");
  }
  if (health?.ok !== true || health?.db !== "connected") {
    fail("/api/health must report ok=true and db=connected.");
  }

  const surfaces = {};
  let security;
  for (const surface of SURFACES) {
    const result = await request(origin, surface.route, fetchFn, timeoutMs);
    assertReleaseHeader(result.response, commit, surface.route);
    const contentType = requireHeader(result.response, "content-type", surface.contentType);
    const cacheControl = requireHeader(result.response, "cache-control", surface.cacheControl);
    if (/\bnoindex\b/i.test(String(result.response.headers.get("x-robots-tag") || ""))) {
      fail(`${surface.route} is an approved public surface but production marks it noindex.`);
    }
    if (surface.canonical) {
      requireHeader(result.response, "link", `<${surface.canonical}>; rel="canonical"`);
    }
    const observedHash = sha256(result.body);
    const expectedHash = candidate.files[surface.candidateFile];
    if (observedHash !== expectedHash) {
      fail(
        `${surface.route} SHA-256 ${observedHash} does not match candidate ${surface.candidateFile} ${expectedHash}.`
      );
    }
    if (surface.route === "/") security = validateSecurityHeaders(result.response);
    surfaces[surface.route] = {
      candidateFile: surface.candidateFile,
      sha256: observedHash,
      bytes: result.body.length,
      contentType,
      cacheControl,
      canonical: result.response.headers.get("link") || null,
      robots: result.response.headers.get("x-robots-tag") || null,
    };
  }

  const notFoundResult = await request(origin, NOT_FOUND_ROUTE, fetchFn, timeoutMs, 404);
  assertReleaseHeader(notFoundResult.response, commit, NOT_FOUND_ROUTE);
  const notFoundContentType = requireHeader(
    notFoundResult.response,
    "content-type",
    /^text\/html\b/i
  );
  const notFoundCacheControl = requireHeader(notFoundResult.response, "cache-control", "no-store");
  requireHeader(notFoundResult.response, "x-robots-tag", "noindex, nofollow");
  const notFoundHash = sha256(notFoundResult.body);
  const expectedNotFoundHash = candidate.files["frontend/404.html"];
  if (notFoundHash !== expectedNotFoundHash) {
    fail(`${NOT_FOUND_ROUTE} does not serve the candidate 404 document.`);
  }

  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || Number.isNaN(verifiedAt.getTime())) {
    fail("Production verification timestamp is invalid.");
  }
  return {
    schemaVersion: 1,
    verifiedAt: verifiedAt.toISOString(),
    origin,
    commit,
    candidateGeneratedAt: candidate.generatedAt || null,
    releaseHeader: RELEASE_COMMIT_HEADER,
    health: {
      status: 200,
      ok: true,
      db: "connected",
      contentType: healthContentType,
      cacheControl: healthResult.response.headers.get("cache-control"),
    },
    security,
    surfaces,
    notFound: {
      route: NOT_FOUND_ROUTE,
      status: 404,
      candidateFile: "frontend/404.html",
      sha256: notFoundHash,
      bytes: notFoundResult.body.length,
      contentType: notFoundContentType,
      cacheControl: notFoundCacheControl,
      robots: notFoundResult.response.headers.get("x-robots-tag"),
    },
  };
}

function assertSafeOutputPath(outputPath) {
  const resolved = path.resolve(outputPath);
  const allowedRoot = path.resolve(repositoryRoot, "backend/test-results/release");
  if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) {
    fail(`Production evidence must remain under ${allowedRoot}.`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(path.dirname(resolved));
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("Production evidence directory must be a real directory.");
  }
  if (fs.realpathSync(path.dirname(resolved)) !== path.resolve(path.dirname(resolved))) {
    fail("Production evidence directory cannot traverse a symbolic link.");
  }
  return resolved;
}

function writeEvidence(evidence, outputPath = DEFAULT_OUTPUT_PATH) {
  const resolved = assertSafeOutputPath(outputPath);
  const temporary = `${resolved}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, resolved);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return resolved;
}

async function main() {
  const candidate = validateCandidateManifest(readCandidateManifest());
  const evidence = await verifyProductionSurface({ candidate });
  const outputPath = writeEvidence(evidence);
  console.log(
    `[production-surface] ${evidence.origin} serves exact candidate ${evidence.commit}; retained ${Object.keys(evidence.surfaces).length} surface proofs at ${outputPath}.`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CANDIDATE_PATH,
  DEFAULT_OUTPUT_PATH,
  NOT_FOUND_ROUTE,
  PRODUCTION_ORIGIN,
  SURFACES,
  parseContentSecurityPolicy,
  requireExactDirective,
  readCandidateManifest,
  sha256,
  currentWorkingTreeStatus,
  validateCandidateManifest,
  validateSecurityHeaders,
  verifyProductionSurface,
  writeEvidence,
};
