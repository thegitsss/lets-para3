"use strict";

const fs = require("fs");
const { HeadObjectCommand } = require("@aws-sdk/client-s3");
const { digest, isProtectedUploadKey } = require("./uploadQuarantine");
let cached;
function loadLegacyUploadManifest(env = process.env) {
  const path = env.S3_LEGACY_UPLOAD_MANIFEST, expected = env.S3_LEGACY_UPLOAD_MANIFEST_SHA256;
  if (!path && !expected) return null;
  if (!path || !/^[a-f0-9]{64}$/.test(expected || "")) throw new Error("Legacy upload manifest requires a pinned SHA-256.");
  const identity = `${path}:${expected}`;
  if (cached?.identity === identity) return cached.value;
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("Invalid legacy upload manifest file.");
  const bytes = fs.readFileSync(path);
  if (digest(bytes) !== expected) throw new Error("Legacy upload manifest digest mismatch.");
  const value = JSON.parse(bytes);
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.bucketSha256 || "") || !Array.isArray(value.objects) || value.objects.length > 10000) throw new Error("Invalid legacy upload manifest.");
  const objects = new Map();
  for (const entry of value.objects) {
    if (!/^[a-f0-9]{64}$/.test(entry.keySha256 || "") || objects.has(entry.keySha256) || !/^"[^"\r\n]+"$/.test(entry.etag || "") || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isFinite(Date.parse(entry.lastModified))) throw new Error("Invalid legacy object identity.");
    objects.set(entry.keySha256, entry);
  }
  cached = { identity, value: { ...value, objects } };
  return cached.value;
}

// Existing untagged files retain access only for their exact frozen identity.
// They remain explicitly unverified, never recorded as a clean scan. A changed
// object or a new upload path cannot use this compatibility allowance.
async function matchesLegacyUpload({ s3, bucket, key, versionId, signal, env = process.env }) {
  const manifest = loadLegacyUploadManifest(env);
  if (!manifest || isProtectedUploadKey(key) || manifest.bucketSha256 !== digest(bucket)) return false;
  const entry = manifest.objects.get(digest(key));
  if (!entry) return false;
  const command = new HeadObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) });
  const head = signal ? await s3.send(command, { abortSignal: signal }) : await s3.send(command);
  return head.ETag === entry.etag && head.ContentLength === entry.size && new Date(head.LastModified).toISOString() === entry.lastModified;
}

// Presentation is not authorization: every actual read still checks tags and
// the frozen HEAD identity. Do not display a clean-scan claim for these files.
function presentationSecurityStatus(key, status, env = process.env) {
  if (["clean", "blocked", "error"].includes(status)) return status;
  const manifest = loadLegacyUploadManifest(env);
  if (env.S3_BUCKET && manifest?.bucketSha256 === digest(env.S3_BUCKET) && !isProtectedUploadKey(key) && manifest.objects.has(digest(String(key)))) return "not_required";
  return ["pending", "not_required"].includes(status) ? status : "unknown";
}

module.exports = { loadLegacyUploadManifest, matchesLegacyUpload, presentationSecurityStatus };
