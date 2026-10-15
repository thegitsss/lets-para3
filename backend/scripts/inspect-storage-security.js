#!/usr/bin/env node
"use strict";

// Configuration reads only: never lists, downloads, uploads, or changes objects.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sdk = require("@aws-sdk/client-s3");
const { createS3Client } = require("../utils/s3Client");

const READS = Object.freeze({
  publicAccessBlock: "GetPublicAccessBlockCommand",
  policyStatus: "GetBucketPolicyStatusCommand",
  encryption: "GetBucketEncryptionCommand",
  ownership: "GetBucketOwnershipControlsCommand",
  versioning: "GetBucketVersioningCommand",
  policy: "GetBucketPolicyCommand",
});

function summarize(name, value) {
  if (name === "publicAccessBlock") {
    const settings = value.PublicAccessBlockConfiguration || {};
    const enabled = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"];
    return { status: enabled.every(key => settings[key] === true) ? "verified" : "review_required", settings };
  }
  if (name === "policyStatus") return {
    status: value.PolicyStatus?.IsPublic === false ? "verified" : "review_required",
    isPublic: value.PolicyStatus?.IsPublic ?? null,
  };
  if (name === "encryption") {
    const algorithms = (value.ServerSideEncryptionConfiguration?.Rules || [])
      .map(rule => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).filter(Boolean);
    return { status: algorithms.length && algorithms.every(algorithm => ["AES256", "aws:kms", "aws:kms:dsse"].includes(algorithm)) ? "verified" : "review_required", algorithms };
  }
  if (name === "ownership") {
    const modes = (value.OwnershipControls?.Rules || []).map(rule => rule.ObjectOwnership);
    return { status: modes.includes("BucketOwnerEnforced") ? "verified" : "review_required", modes };
  }
  if (name === "versioning") return {
    status: "observed", versioning: value.Status || "not_enabled", mfaDelete: value.MFADelete || "not_enabled",
  };
  // A string match cannot establish correct IAM semantics. Preserve a digest and
  // non-identifying indicators for a separate policy review; never claim a pass.
  const policy = String(value.Policy || "");
  JSON.parse(policy);
  return {
    status: "review_required",
    sha256: crypto.createHash("sha256").update(policy).digest("hex"),
    mentionsSecureTransport: policy.includes("aws:SecureTransport"),
    mentionsCleanScanTag: policy.includes("s3:ExistingObjectTag/GuardDutyMalwareScanStatus") && policy.includes("NO_THREATS_FOUND"),
    note: "Indicators only. Review principals, actions, resources, conditions, bypass paths, and all upload prefixes in AWS.",
  };
}

async function inspect({ client, bucket, expectedOwner, timeoutMs = 15000 }) {
  if (!bucket) throw new Error("S3_BUCKET is required.");
  const observations = {};
  for (const [name, command] of Object.entries(READS)) {
    try {
      const response = await client.send(new sdk[command]({ Bucket: bucket, ...(expectedOwner ? { ExpectedBucketOwner: expectedOwner } : {}) }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      observations[name] = summarize(name, response);
    } catch (error) {
      observations[name] = {
        status: "unconfirmed",
        errorCode: String(error.name || "READ_FAILED").replace(/[^A-Za-z0-9_]/g, "").slice(0, 80),
        httpStatus: error.$metadata?.httpStatusCode || null,
      };
    }
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    targetFingerprint: crypto.createHash("sha256").update(bucket).digest("hex"),
    scope: "Configured S3 bucket only; target production identity must be reconciled separately.",
    status: "incomplete",
    observations,
    remaining: [
      "Reconcile bucket fingerprint and deployed release with the approved production target.",
      "Verify account/organization public-access controls and effective IAM/tag/TLS policies.",
      "Verify GuardDuty plan coverage, role permissions, tagging, and legacy-object disposition.",
      "Demonstrate clean and quarantined canary reads using the application identity.",
      "Verify deletion of all intended object versions, backup retention, and restore/alert drills.",
    ],
  };
}

async function main() {
  process.umask(0o077);
  require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });
  const client = createS3Client();
  try {
    const result = await inspect({ client, bucket: process.env.S3_BUCKET, expectedOwner: process.env.S3_EXPECTED_BUCKET_OWNER });
    const dir = path.join(__dirname, "../test-results/security");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const output = path.join(dir, `storage-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ output, status: result.status, observations: result.observations }, null, 2));
    // An inspection never constitutes production certification.
    process.exitCode = 2;
  } finally {
    client.destroy();
  }
}

if (require.main === module) main().catch(error => {
  console.error(`[storage-security] ${error.name || "InspectionFailed"}`);
  process.exitCode = 1;
});
module.exports = { READS, summarize, inspect };
