const { S3Client } = require("@aws-sdk/client-s3");

const S3_CONNECTION_TIMEOUT_MS = 10_000;
const S3_REQUEST_TIMEOUT_MS = 120_000;
const S3_SOCKET_TIMEOUT_MS = 30_000;
const S3_MAX_ATTEMPTS = 3;

function resolveCredentials(env = process.env) {
  const accessKeyId = String(env.S3_ACCESS_KEY || "").trim();
  const secretAccessKey = String(env.S3_SECRET_KEY || "").trim();
  const sessionToken = String(env.S3_SESSION_TOKEN || "").trim();

  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error("S3_ACCESS_KEY and S3_SECRET_KEY must be configured together.");
  }
  if (!accessKeyId) return undefined;
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  };
}

function buildS3ClientConfig(env = process.env) {
  return {
    region: String(env.S3_REGION || env.AWS_REGION || "us-east-1").trim(),
    credentials: resolveCredentials(env),
    maxAttempts: S3_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
      requestTimeout: S3_REQUEST_TIMEOUT_MS,
      socketTimeout: S3_SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  };
}

function createS3Client(env = process.env) {
  return new S3Client(buildS3ClientConfig(env));
}

module.exports = {
  S3_CONNECTION_TIMEOUT_MS,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_TIMEOUT_MS,
  S3_SOCKET_TIMEOUT_MS,
  buildS3ClientConfig,
  createS3Client,
  resolveCredentials,
};
