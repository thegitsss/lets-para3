const fs = require("fs"), os = require("os"), path = require("path");
const { digest, protectedUploadKey, matterUploadKey, buildQuarantinePolicy, PROTECTED_RESOURCES } = require("../utils/uploadQuarantine");
const { buildLegacyManifest } = require("../scripts/prepare-upload-quarantine");
const { getObjectMalwareScan, assertObjectMalwareSafe } = require("../utils/fileSecurity");
const { loadLegacyUploadManifest } = require("../utils/legacyUploadManifest");
const { presentationSecurityStatus } = require("../utils/legacyUploadManifest");
const bucket = "lpc-test-private", oldKey = "cases/abc/documents/old.pdf", etag = '"frozen-etag"';
const lastModified = "2026-10-05T12:00:00.000Z";
let dir, oldEnv;
beforeEach(() => {
  oldEnv = { path: process.env.S3_LEGACY_UPLOAD_MANIFEST, hash: process.env.S3_LEGACY_UPLOAD_MANIFEST_SHA256 };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-quarantine-"));
  const manifest = buildLegacyManifest({ complete: true, checkedAt: lastModified, objects: [{ key: oldKey, etag, size: 10, lastModified, status: "MISSING" }] }, bucket);
  const bytes = JSON.stringify(manifest);
  process.env.S3_LEGACY_UPLOAD_MANIFEST = path.join(dir, "manifest.json");
  process.env.S3_LEGACY_UPLOAD_MANIFEST_SHA256 = digest(bytes);
  fs.writeFileSync(process.env.S3_LEGACY_UPLOAD_MANIFEST, bytes);
});
afterEach(() => {
  for (const [name, value] of [["S3_LEGACY_UPLOAD_MANIFEST", oldEnv.path], ["S3_LEGACY_UPLOAD_MANIFEST_SHA256", oldEnv.hash]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
function storage(tag, head = {}) {
  return { send: jest.fn(async command => {
    if (command.constructor.name === "GetObjectTaggingCommand") return { TagSet: tag ? [{ Key: "GuardDutyMalwareScanStatus", Value: tag }] : [] };
    if (command.constructor.name === "HeadObjectCommand") return { ETag: etag, ContentLength: 10, LastModified: new Date(lastModified), ...head };
    throw Error("Unexpected content read or mutation");
  }) };
}
test("unchanged inventoried file keeps access without being marked clean or mutated", async () => {
  const s3 = storage();
  await expect(getObjectMalwareScan({ s3, bucket, key: oldKey, required: true })).resolves.toEqual({ status: "not_required", result: "LEGACY_UNVERIFIED", safe: true });
  expect(s3.send.mock.calls.map(([c]) => c.constructor.name)).toEqual(["GetObjectTaggingCommand", "HeadObjectCommand"]);
});
test.each([{ ETag: '"changed"' }, { ContentLength: 11 }, { LastModified: new Date("2026-10-05T13:00:00Z") }])("changed legacy identity cannot inherit the allowance: %p", async head => {
  await expect(assertObjectMalwareSafe({ s3: storage(undefined, head), bucket, key: oldKey, required: true })).rejects.toMatchObject({ code: "FILE_SCAN_PENDING" });
});
test.each(["THREATS_FOUND", "FAILED", "ACCESS_DENIED", "UNSUPPORTED", "UNKNOWN_RESULT"])("a managed result overrides the legacy allowance: %s", async tag => {
  await expect(assertObjectMalwareSafe({ s3: storage(tag), bucket, key: oldKey, required: true })).rejects.toBeDefined();
});
test.each(["", "THREATS_FOUND", "FAILED", "UNSUPPORTED", "ACCESS_DENIED"])("new files remain unavailable for result %s", async tag => {
  await expect(assertObjectMalwareSafe({ s3: storage(tag), bucket, key: protectedUploadKey(oldKey), required: true })).rejects.toBeDefined();
});
test("clean new file is available only after the actual scanner result", async () => {
  await expect(assertObjectMalwareSafe({ s3: storage("NO_THREATS_FOUND"), bucket, key: protectedUploadKey(oldKey), required: true })).resolves.toMatchObject({ status: "clean", safe: true });
});
test("unlisted legacy keys and the wrong bucket fail closed", async () => {
  for (const input of [{ key: "cases/abc/documents/unlisted.pdf", bucket }, { key: oldKey, bucket: "another-bucket" }]) {
    await expect(assertObjectMalwareSafe({ s3: storage(), ...input, required: true })).rejects.toMatchObject({ code: "FILE_SCAN_PENDING" });
  }
});
test("legacy presentation preserves known failures and never labels a new path exempt", () => {
  const env = { ...process.env, S3_BUCKET: bucket };
  expect(presentationSecurityStatus(oldKey, "pending", env)).toBe("not_required");
  expect(presentationSecurityStatus(oldKey, "blocked", env)).toBe("blocked");
  expect(presentationSecurityStatus(protectedUploadKey(oldKey), "pending", env)).toBe("pending");
});
test("missing or mismatched manifest pin fails configuration instead of trusting it", () => {
  expect(() => loadLegacyUploadManifest({ S3_LEGACY_UPLOAD_MANIFEST: process.env.S3_LEGACY_UPLOAD_MANIFEST })).toThrow(/pinned/);
  expect(() => loadLegacyUploadManifest({ S3_LEGACY_UPLOAD_MANIFEST: process.env.S3_LEGACY_UPLOAD_MANIFEST, S3_LEGACY_UPLOAD_MANIFEST_SHA256: "0".repeat(64) })).toThrow(/digest mismatch/);
});
test("legacy upload receipts and new attempts keep separate deterministic keys", () => {
  const operation = { caseId: "abc", fileId: "def", attempts: [{ token: "old" }, { token: "new", keyVersion: 2 }] };
  expect(matterUploadKey(operation, "old", ".pdf")).toBe("cases/abc/documents/def-old.pdf");
  expect(matterUploadKey(operation, "new", ".pdf")).toBe("cases/abc/documents/scan-required-def-new.pdf");
});
test("manifest preparation refuses a partial inventory or protected upload", () => {
  expect(() => buildLegacyManifest({ complete: false, objects: [] }, bucket)).toThrow();
  expect(() => buildLegacyManifest({ complete: true, objects: [{ key: protectedUploadKey(oldKey), status: "MISSING" }] }, bucket)).toThrow();
});
test("policy scopes clean reads to new files and seals legacy writes and scan tags", () => {
  const original = { Version: "2012-10-17", Statement: [{ Sid: "ExistingTLS", Effect: "Deny", Principal: "*", Action: "s3:*", Resource: `arn:aws:s3:::${bucket}/*`, Condition: { Bool: { "aws:SecureTransport": "false" } } }] };
  const scannerRoleArn = "arn:aws:iam::123456789012:role/service-role/scanner", applicationPrincipalArn = "arn:aws:iam::123456789012:user/uploader";
  const result = buildQuarantinePolicy({ bucket, scannerRoleArn, applicationPrincipalArn, existingPolicy: original });
  expect(original.Statement).toHaveLength(1);
  expect(result.Statement[0]).toEqual(original.Statement[0]);
  const reads = result.Statement.find(s => s.Sid === "LPCNewUploadsRequireCleanScan");
  expect(reads.Resource).toEqual(PROTECTED_RESOURCES.map(p => `arn:aws:s3:::${bucket}/${p}`));
  expect(reads.Condition.StringNotEquals).toEqual({ "s3:ExistingObjectTag/GuardDutyMalwareScanStatus": "NO_THREATS_FOUND" });
  expect(reads.Condition.ArnNotEquals["aws:PrincipalArn"]).toBe(scannerRoleArn);
  expect(result.Statement.find(s => s.Sid === "LPCNoCopiedUploads")).toMatchObject({ Action: "s3:PutObject", Resource: reads.Resource, Condition: { Null: { "s3:x-amz-copy-source": "false" } } });
  const writes = result.Statement.find(s => s.Sid === "LPCNoLegacyUploadWrites");
  expect(writes.Action).toBe("s3:PutObject"); expect(writes.Resource).toBeUndefined();
  expect(writes.NotResource).not.toContain(`arn:aws:s3:::${bucket}/cases/*`);
  expect(result.Statement.find(s => s.Sid === "LPCScannerOwnsUploadTags").Action).toContain("s3:DeleteObjectVersionTagging");
  expect(result.Statement.find(s => s.Sid === "LPCNewPhotosRequireApplication").Condition.ArnNotEquals["aws:PrincipalArn"]).toEqual([scannerRoleArn, applicationPrincipalArn]);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(20480);
});

test("S3 client initialization rejects a manifest for another bucket, including cache hits", () => {
  const { createS3Client } = require("../utils/s3Client");
  const env = { ...process.env, S3_BUCKET: bucket };
  const client = createS3Client(env); client.destroy();
  expect(() => createS3Client({ ...env, S3_BUCKET: "different-bucket" })).toThrow(/match S3_BUCKET/);
  expect(() => createS3Client({ ...env, S3_BUCKET: "" })).toThrow(/match S3_BUCKET/);
});


function mountedManifest(run, target = process.env.S3_LEGACY_UPLOAD_MANIFEST) {
  const mounted = "/etc/secrets/lpc-legacy-upload-manifest.json";
  const originalOpen = fs.openSync.bind(fs);
  const spy = jest.spyOn(fs, "openSync").mockImplementation((file, ...args) => originalOpen(file === mounted ? target : file, ...args));
  try { return run({ NODE_ENV: "production", RENDER: "true", S3_LEGACY_UPLOAD_MANIFEST: mounted, S3_LEGACY_UPLOAD_MANIFEST_SHA256: process.env.S3_LEGACY_UPLOAD_MANIFEST_SHA256 }); }
  finally { spy.mockRestore(); }
}
test("Render managed mount can resolve a link only with the exact pinned manifest bytes", () => {
  const link = path.join(dir, "render-link.json"); fs.symlinkSync(process.env.S3_LEGACY_UPLOAD_MANIFEST, link);
  mountedManifest(env => expect(loadLegacyUploadManifest(env).objects.has(digest(oldKey))).toBe(true), link);
});
test("Render managed link still rejects a mismatched digest", () => {
  const link = path.join(dir, "render-link.json"); fs.symlinkSync(process.env.S3_LEGACY_UPLOAD_MANIFEST, link);
  mountedManifest(env => expect(() => loadLegacyUploadManifest({ ...env, S3_LEGACY_UPLOAD_MANIFEST_SHA256: "1".repeat(64) })).toThrow(/digest mismatch/), link);
});
test("non-managed manifest links remain rejected even with a correct digest", () => {
  const link = path.join(dir, "local-link.json"); fs.symlinkSync(process.env.S3_LEGACY_UPLOAD_MANIFEST, link);
  expect(() => loadLegacyUploadManifest({ NODE_ENV: "production", RENDER: "true", S3_LEGACY_UPLOAD_MANIFEST: link, S3_LEGACY_UPLOAD_MANIFEST_SHA256: process.env.S3_LEGACY_UPLOAD_MANIFEST_SHA256 })).toThrow(/Invalid legacy upload manifest file/);
});
test("managed mount must still resolve to a bounded regular file", () => {
  mountedManifest(env => expect(() => loadLegacyUploadManifest({ ...env, S3_LEGACY_UPLOAD_MANIFEST_SHA256: "2".repeat(64) })).toThrow(/Invalid legacy upload manifest file/), dir);
});
