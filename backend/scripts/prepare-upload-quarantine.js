"use strict";

// Offline preparation only: no SDK requests, writes, retags or rescan calls.
const fs = require("fs");
const { digest, isProtectedUploadKey, buildQuarantinePolicy } = require("../utils/uploadQuarantine");
function buildLegacyManifest(inventory, bucket) {
  if (inventory?.complete !== true || inventory.error || !Array.isArray(inventory.objects) || !bucket) throw new Error("A complete, reviewed metadata inventory and bucket are required.");
  const objects = inventory.objects.filter(entry => entry.status === "MISSING");
  if (objects.some(entry => isProtectedUploadKey(entry.key) || !entry.etag || !Number.isSafeInteger(entry.size) || !Number.isFinite(Date.parse(entry.lastModified)))) throw new Error("Invalid legacy identity or protected path in inventory.");
  return { version: 1, bucketSha256: digest(bucket), inventoryAt: inventory.checkedAt, objects: objects.map(entry => ({ keySha256: digest(entry.key), etag: entry.etag, size: entry.size, lastModified: new Date(entry.lastModified).toISOString() })) };
}
if (require.main === module) {
  try {
    const [inventoryPath, configPath, outputDirectory] = process.argv.slice(2);
    if (!inventoryPath || !configPath || !outputDirectory) throw new Error("Usage: node prepare-upload-quarantine.js INVENTORY CONFIG OUTPUT_DIRECTORY");
    process.umask(0o077);
    const config = JSON.parse(fs.readFileSync(configPath));
    const manifest = buildLegacyManifest(JSON.parse(fs.readFileSync(inventoryPath)), config.bucket);
    const policy = buildQuarantinePolicy(config);
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    fs.writeFileSync(`${outputDirectory}/legacy-upload-manifest.json`, manifestBytes, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(`${outputDirectory}/bucket-policy-PROPOSAL.json`, JSON.stringify(policy, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ applied: false, legacyCount: manifest.objects.length, manifestSha256: digest(manifestBytes), policyBytes: Buffer.byteLength(JSON.stringify(policy)) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildLegacyManifest };
