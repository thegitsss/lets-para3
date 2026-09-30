const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { assertObjectMalwareSafe } = require("../utils/fileSecurity");

const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const PUBLIC_PHOTO_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
const SUPPORTED_IMAGE_TYPES = new Map([
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/png", "image/png"],
]);

function cleanId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{24}$/.test(id) ? id : "";
}

function versionToken(value) {
  if (!value) return "";
  const parsed = new Date(value);
  const milliseconds = parsed.getTime();
  return Number.isFinite(milliseconds) ? String(milliseconds) : "";
}

function buildPublicProfilePhotoUrl(profileOrId, updatedAt) {
  const id = cleanId(profileOrId?._id || profileOrId?.id || profileOrId);
  if (!id) return "";
  const version = versionToken(updatedAt || profileOrId?.updatedAt);
  return `/api/public/paralegals/${id}/photo${version ? `?v=${version}` : ""}`;
}

function buildAuthenticatedProfilePhotoUrl(profileOrId, { variant = "approved", updatedAt } = {}) {
  const id = cleanId(profileOrId?._id || profileOrId?.id || profileOrId);
  const safeVariant = ["approved", "approved-original", "pending", "pending-original"].includes(variant)
    ? variant
    : "approved";
  if (!id) return "";
  const params = new URLSearchParams();
  if (safeVariant !== "approved") params.set("variant", safeVariant);
  const version = versionToken(updatedAt || profileOrId?.updatedAt);
  if (version) params.set("v", version);
  const query = params.toString();
  return `/api/users/profile-photo/${id}${query ? `?${query}` : ""}`;
}

function expectedS3Hosts(bucket, region) {
  const safeBucket = String(bucket || "").trim().toLowerCase();
  const safeRegion = String(region || "").trim().toLowerCase();
  if (!safeBucket) return new Set();
  return new Set([
    `${safeBucket}.s3.amazonaws.com`,
    safeRegion ? `${safeBucket}.s3.${safeRegion}.amazonaws.com` : "",
    safeRegion ? `${safeBucket}.s3-${safeRegion}.amazonaws.com` : "",
  ].filter(Boolean));
}

function pathStyleS3Hosts(region) {
  const safeRegion = String(region || "").trim().toLowerCase();
  return new Set([
    "s3.amazonaws.com",
    safeRegion ? `s3.${safeRegion}.amazonaws.com` : "",
    safeRegion ? `s3-${safeRegion}.amazonaws.com` : "",
  ].filter(Boolean));
}

function validateProfilePhotoKey(value, ownerId) {
  const key = String(value || "").trim();
  const id = cleanId(ownerId);
  if (!id || !key || key.includes("%") || key.includes("\\") || key.includes("?") || key.includes("#")) {
    return "";
  }
  if (key.includes("..") || key.startsWith("/") || key.includes("//")) return "";
  const match = key.match(
    /^profile-photos\/([a-f0-9]{24})\/(profile|original)-([0-9]{10,17})(?:-[a-f0-9]{12})?\.(jpe?g|png)$/i
  );
  if (!match || match[1].toLowerCase() !== id) return "";
  return key;
}

function extractProfilePhotoKey(reference, { bucket, region, ownerId } = {}) {
  const raw = String(reference || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return validateProfilePhotoKey(raw, ownerId);
  if (raw.includes("%")) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    return "";
  }

  const hostname = parsed.hostname.toLowerCase();
  let key = parsed.pathname.replace(/^\/+/, "");
  if (expectedS3Hosts(bucket, region).has(hostname)) {
    return validateProfilePhotoKey(key, ownerId);
  }
  if (pathStyleS3Hosts(region).has(hostname)) {
    const bucketPrefix = `${String(bucket || "").trim()}/`;
    if (!bucketPrefix || !key.startsWith(bucketPrefix)) return "";
    key = key.slice(bucketPrefix.length);
    return validateProfilePhotoKey(key, ownerId);
  }
  return "";
}

function referenceCandidates(user, variant = "approved") {
  if (variant === "pending") {
    return [user?.pendingProfileImageKey, user?.pendingProfileImage];
  }
  if (variant === "pending-original") {
    return [
      user?.pendingProfileImageOriginalKey,
      user?.pendingProfileImageOriginal,
      user?.pendingProfileImageKey,
      user?.pendingProfileImage,
    ];
  }
  if (variant === "approved-original") {
    return [
      user?.profileImageOriginalKey,
      user?.profileImageOriginal,
      user?.profileImageKey,
      user?.profileImage,
      user?.avatarURL,
    ];
  }
  return [user?.profileImageKey, user?.profileImage, user?.avatarURL];
}

function resolveProfilePhotoKey(user, { bucket, region, variant = "approved" } = {}) {
  const ownerId = cleanId(user?._id || user?.id);
  if (!ownerId) return "";
  for (const reference of referenceCandidates(user, variant)) {
    const key = extractProfilePhotoKey(reference, { bucket, region, ownerId });
    if (key) return key;
  }
  return "";
}

function hasPhotoReference(user, variant = "approved") {
  return referenceCandidates(user, variant).some((value) => typeof value === "string" && value.trim());
}

function normalizedContentType(value) {
  return SUPPORTED_IMAGE_TYPES.get(String(value || "").split(";")[0].trim().toLowerCase()) || "";
}

function etagMatches(header, etag) {
  const expected = String(etag || "").trim();
  if (!expected) return false;
  return String(header || "")
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === expected || value.replace(/^W\//, "") === expected.replace(/^W\//, ""));
}

function isMissingS3Object(error) {
  const status = Number(error?.$metadata?.httpStatusCode || 0);
  return status === 404 || ["NoSuchKey", "NotFound", "NoSuchObject"].includes(String(error?.name || error?.Code || ""));
}

async function streamProfilePhoto({ req, res, s3, bucket, key, cacheControl = PUBLIC_PHOTO_CACHE_CONTROL }) {
  try {
    await assertObjectMalwareSafe({ s3, bucket, key });
  } catch (error) {
    if (["FILE_SCAN_PENDING", "FILE_SECURITY_BLOCKED", "FILE_SCAN_ERROR"].includes(error?.code)) {
      return false;
    }
    throw error;
  }
  let object;
  try {
    object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isMissingS3Object(error)) return false;
    throw error;
  }

  const contentType = normalizedContentType(object?.ContentType);
  const contentLength = Number(object?.ContentLength);
  const body = object?.Body;
  if (
    !contentType ||
    !body ||
    typeof body.pipe !== "function" ||
    (Number.isFinite(contentLength) && (contentLength < 1 || contentLength > MAX_PROFILE_PHOTO_BYTES))
  ) {
    body?.destroy?.();
    return false;
  }

  const etag = String(object?.ETag || "").trim();
  res.set("Cache-Control", cacheControl);
  res.set("X-Content-Type-Options", "nosniff");
  if (etag) res.set("ETag", etag);
  if (etagMatches(req.headers?.["if-none-match"], etag)) {
    body.destroy?.();
    res.status(304).end();
    return true;
  }

  res.set("Content-Type", contentType);
  res.set("Content-Disposition", "inline");
  if (Number.isFinite(contentLength)) res.set("Content-Length", String(contentLength));

  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_PROFILE_PHOTO_BYTES) {
        callback(new Error("profile_photo_size_limit"));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(body, limiter, res);
  return true;
}

module.exports = {
  MAX_PROFILE_PHOTO_BYTES,
  PUBLIC_PHOTO_CACHE_CONTROL,
  buildAuthenticatedProfilePhotoUrl,
  buildPublicProfilePhotoUrl,
  extractProfilePhotoKey,
  hasPhotoReference,
  normalizedContentType,
  resolveProfilePhotoKey,
  streamProfilePhoto,
  validateProfilePhotoKey,
};
