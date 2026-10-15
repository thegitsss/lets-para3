"use strict";

function confidentialStorageEncryption(env = process.env) {
  const key = String(env.S3_SSE_KMS_KEY_ID || "").trim();
  const required = env.NODE_ENV === "production" || env.REQUIRE_STORAGE_KMS === "true";
  if (required && !/^arn:aws(?:-us-gov|-cn)?:kms:[a-z0-9-]+:\d{12}:key\/[a-f0-9-]{36}$/i.test(key)) {
    throw new Error("Confidential storage requires S3_SSE_KMS_KEY_ID with an explicit KMS key ARN.");
  }
  return key ? { ServerSideEncryption: "aws:kms", SSEKMSKeyId: key } : { ServerSideEncryption: "AES256" };
}
module.exports = { confidentialStorageEncryption };
