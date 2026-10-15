const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { StringDecoder } = require("string_decoder");

const repositoryRoot = path.resolve(__dirname, "../..");
const MAX_SCAN_WINDOW_BYTES = 2_000_000;
const READ_CHUNK_BYTES = 64 * 1024;
const forbiddenNames = /(^|\/)(?:\.env(?:\..+)?|id_(?:rsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\brk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bwhsec_[A-Za-z0-9]{16,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}\b/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/,
  /mongodb(?:\+srv)?:\/\/[^:\s/@]+:[^\s/@]+@/i,
];

function scanCandidateFile(absolute, expected) {
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) {
      return "candidate changed before it could be scanned";
    }
    const decoder = new StringDecoder("utf8"), buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let carry = "", scanned = 0, violation = null;
    const inspect = text => {
      const window = carry + text;
      for (const pattern of secretPatterns) {
        if (pattern.test(window)) return `matches ${pattern}`;
      }
      // Only credentialed Mongo URIs can need arbitrarily long lookbehind.
      // Keep their unfinished non-whitespace segment across reads. Reject a
      // segment beyond our memory bound rather than truncating its prefix.
      const unfinished = window.match(/mongodb(?:\+srv)?:\/\/[^:\s/@]+(?::[^\s/@]*)?$/i);
      carry = unfinished && unfinished.index < window.length - 256
        ? window.slice(unfinished.index) : window.slice(-256);
      return Buffer.byteLength(carry, "utf8") > MAX_SCAN_WINDOW_BYTES
        ? `exceeds the ${MAX_SCAN_WINDOW_BYTES}-byte secret-scan window` : null;
    };
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      scanned += bytes;
      violation = inspect(decoder.write(buffer.subarray(0, bytes)));
      if (violation) break;
    }
    violation ||= inspect(decoder.end());
    const after = fs.fstatSync(descriptor), current = fs.lstatSync(absolute);
    if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || current.size !== after.size
        || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
      return "candidate changed while it was being scanned";
    }
    if (!violation && scanned !== before.size) return "candidate could not be scanned completely";
    return violation;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function listCandidateFiles(root = repositoryRoot) {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }
  );
  if (listed.status !== 0) {
    const err = new Error("Unable to inspect candidate files.");
    err.code = "CANDIDATE_FILE_LIST_FAILED";
    throw err;
  }
  return listed.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((relative) => {
      try {
        fs.lstatSync(path.join(root, relative));
        return true;
      } catch {
        return false;
      }
    });
}

function findSecretViolations(files, root = repositoryRoot) {
  const violations = [];
  for (const relative of files) {
    const normalized = String(relative || "").replaceAll("\\", "/");
    if (!normalized) continue;
    if (forbiddenNames.test(normalized)) {
      violations.push(`${normalized}: secret-bearing filename`);
      continue;
    }
    const absolute = path.join(root, normalized);
    try {
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        violations.push(`${normalized}: symbolic-link candidate cannot be secret-scanned`);
        continue;
      }
      if (!stats.isFile()) {
        violations.push(`${normalized}: candidate is not a regular file`);
        continue;
      }
      const violation = scanCandidateFile(absolute, stats);
      if (violation) violations.push(`${normalized}: ${violation}`);
    } catch {
      violations.push(`${normalized}: candidate could not be read completely`);
    }
  }
  return violations;
}

function main() {
  let files;
  try {
    files = listCandidateFiles();
  } catch (err) {
    console.error(`[secrets] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const violations = findSecretViolations(files);
  if (violations.length) {
    console.error(`[secrets] Potential credentials exist in candidate files:\n${violations.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[secrets] Scanned ${files.length} tracked and untracked candidate files without finding supported secret patterns.`
  );
}

if (require.main === module) main();

module.exports = {
  MAX_SCAN_WINDOW_BYTES,
  findSecretViolations,
  listCandidateFiles,
};
