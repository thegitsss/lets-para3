"use strict";

const crypto = require("crypto");
const MARKER = "scan-required-";
const USER_UPLOAD_RESOURCES = Object.freeze([
  "cases/*/documents/*", "cases/*/pre-engagement/*",
  "profile-photos/*/*", "paralegal-resumes/*/*",
  "paralegal-certificates/*/*", "paralegal-writing-samples/*/*",
]);
const PROTECTED_RESOURCES = Object.freeze([
  "cases/*/documents/scan-required-*", "cases/*/pre-engagement/scan-required-*",
  "cases/*/pre-engagement/responses/scan-required-*",
  "profile-photos/*/scan-required-*", "paralegal-resumes/*/scan-required-*",
  "paralegal-certificates/*/scan-required-*", "paralegal-writing-samples/*/scan-required-*",
]);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function protectedUploadKey(key) {
  if (typeof key !== "string" || /[\\\s?#%]/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid upload storage key.");
  const at = key.lastIndexOf("/");
  if (at < 0) throw new Error("Upload storage key needs an owner path.");
  return key.slice(0, at + 1) + MARKER + key.slice(at + 1);
}
function isProtectedUploadKey(key) {
  return String(key).split("/").at(-1).startsWith(MARKER);
}
function matterUploadKey(operation, token, extension) {
  const key = `cases/${operation.caseId}/documents/${operation.fileId}-${token}${extension}`;
  return operation.attempts?.find(attempt => attempt.token === token)?.keyVersion === 2 ? protectedUploadKey(key) : key;
}

// Returns a proposal only. Never writes a bucket policy or changes existing objects.
function buildQuarantinePolicy({ bucket, scannerRoleArn, applicationPrincipalArn, existingPolicy }) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || "") || !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(scannerRoleArn || "")) throw new Error("Exact bucket and scanner role required.");
  if (!existingPolicy || existingPolicy.Version !== "2012-10-17" || !Array.isArray(existingPolicy.Statement)) throw new Error("Current bucket policy required.");
  if (!/^arn:aws:iam::\d{12}:(?:role|user)\/[\w+=,.@/-]+$/.test(applicationPrincipalArn || "") || applicationPrincipalArn === scannerRoleArn) throw new Error("Separate application principal required.");
  const arn = path => `arn:aws:s3:::${bucket}/${path}`;
  const protectedPaths = PROTECTED_RESOURCES.map(arn);
  const exceptScanner = { ArnNotEquals: { "aws:PrincipalArn": scannerRoleArn } };
  const deny = (Sid, Action, Resource, Condition) => ({ Sid, Effect: "Deny", Principal: "*", Action, Resource, ...(Condition ? { Condition } : {}) });
  const statements = [
    deny("LPCNewUploadsRequireCleanScan", ["s3:GetObject", "s3:GetObjectVersion"], protectedPaths, { ...exceptScanner, StringNotEquals: { "s3:ExistingObjectTag/GuardDutyMalwareScanStatus": "NO_THREATS_FOUND" } }),
    deny("LPCScannerOwnsUploadTags", ["s3:PutObjectTagging", "s3:PutObjectVersionTagging", "s3:DeleteObjectTagging", "s3:DeleteObjectVersionTagging"], USER_UPLOAD_RESOURCES.map(arn), exceptScanner),
    deny("LPCNoCopiedUploads", "s3:PutObject", protectedPaths, { Null: { "s3:x-amz-copy-source": "false" } }),
    deny("LPCNoScanTagsOnPut", "s3:PutObject", protectedPaths, { Null: { "s3:RequestObjectTag/GuardDutyMalwareScanStatus": "false" } }),
    deny("LPCNewPhotosRequireApplication", ["s3:GetObject", "s3:GetObjectVersion"], [arn("profile-photos/*/scan-required-*")], { ArnNotEquals: { "aws:PrincipalArn": [scannerRoleArn, applicationPrincipalArn] } }),
  ];
  // Bucket policies only apply to their bucket. New writes outside these
  // upload paths and narrowly named generated outputs are denied, including
  // overwrites of legacy objects. The scanner retains its validation write.
  const generated = ["cases/*/archive.zip", "cases/*/archive-*.zip", ...["attorney", "payout", "paralegal", "withdrawal"].map(kind => `cases/*/receipt-${kind}*.pdf`)];
  statements.push({ Sid: "LPCNoLegacyUploadWrites", Effect: "Deny", Principal: "*", Action: "s3:PutObject", NotResource: [...protectedPaths, ...generated.map(arn)], Condition: exceptScanner });
  const reserved = new Set(statements.map(s => s.Sid));
  if (existingPolicy.Statement.some(s => reserved.has(s.Sid))) throw new Error("Quarantine statements already present; review instead of overwriting.");
  const policy = { ...existingPolicy, Statement: [...existingPolicy.Statement, ...statements] };
  if (Buffer.byteLength(JSON.stringify(policy)) > 20480) throw new Error("Bucket policy exceeds the S3 size limit.");
  return policy;
}

module.exports = { digest, protectedUploadKey, isProtectedUploadKey, matterUploadKey, buildQuarantinePolicy, USER_UPLOAD_RESOURCES, PROTECTED_RESOURCES };
