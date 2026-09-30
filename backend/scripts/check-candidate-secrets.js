const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repositoryRoot = path.resolve(__dirname, "../..");
// Audit screenshots can exceed 2 MB; keep them in scope for byte scanning.
const MAX_SCANNED_FILE_BYTES = 8_000_000;
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

function listCandidateFiles(root = repositoryRoot) {
  const listed = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "buffer" }
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
    let content;
    try {
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        violations.push(`${normalized}: symbolic-link candidate cannot be secret-scanned`);
        continue;
      }
      if (!stats.isFile()) continue;
      if (stats.size > MAX_SCANNED_FILE_BYTES) {
        violations.push(`${normalized}: exceeds the ${MAX_SCANNED_FILE_BYTES}-byte secret-scan limit`);
        continue;
      }
      content = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        violations.push(`${normalized}: matches ${pattern}`);
        break;
      }
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
  MAX_SCANNED_FILE_BYTES,
  findSecretViolations,
  listCandidateFiles,
};
