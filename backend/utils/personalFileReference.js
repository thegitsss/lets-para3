const PERSONAL_FILE_PREFIXES = Object.freeze({
  resume: "paralegal-resumes",
  certificate: "paralegal-certificates",
  writingSample: "paralegal-writing-samples",
});

function cleanOwnerId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{24}$/.test(normalized) ? normalized : "";
}

function validatePersonalFileKey(value, { ownerId, type } = {}) {
  const key = String(value || "").trim();
  const owner = cleanOwnerId(ownerId);
  const prefix = PERSONAL_FILE_PREFIXES[type];
  if (!key || !owner || !prefix || key.length > 500) return "";
  if (key.startsWith("/") || key.includes("\\") || key.includes("..") || key.includes("//")) return "";
  if (key.includes("%") || key.includes("?") || key.includes("#")) return "";
  const ownerPrefix = `${prefix}/${owner}/`;
  if (!key.toLowerCase().startsWith(ownerPrefix)) return "";
  const filename = key.slice(ownerPrefix.length);
  if (!/^[a-z0-9][a-z0-9._-]{0,199}\.pdf$/i.test(filename)) return "";
  return key;
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

function extractPersonalFileKey(reference, options = {}) {
  const raw = String(reference || "").trim();
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) return validatePersonalFileKey(raw, options);
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

  const bucket = String(options.bucket || "").trim();
  const region = String(options.region || "").trim().toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  let key = parsed.pathname.replace(/^\/+/, "");
  if (expectedS3Hosts(bucket, region).has(hostname)) {
    return validatePersonalFileKey(key, options);
  }
  const pathStyleHosts = new Set([
    "s3.amazonaws.com",
    region ? `s3.${region}.amazonaws.com` : "",
    region ? `s3-${region}.amazonaws.com` : "",
  ].filter(Boolean));
  if (pathStyleHosts.has(hostname)) {
    const bucketPrefix = `${bucket}/`;
    if (!bucket || !key.startsWith(bucketPrefix)) return "";
    key = key.slice(bucketPrefix.length);
    return validatePersonalFileKey(key, options);
  }

  const cdnBase = String(options.cdnBase || "").trim();
  if (cdnBase) {
    try {
      const cdn = new URL(cdnBase);
      if (parsed.origin === cdn.origin) {
        const basePath = cdn.pathname.replace(/^\/+|\/+$/g, "");
        if (basePath) {
          if (!key.startsWith(`${basePath}/`)) return "";
          key = key.slice(basePath.length + 1);
        }
        return validatePersonalFileKey(key, options);
      }
    } catch {
      return "";
    }
  }
  return "";
}

module.exports = {
  PERSONAL_FILE_PREFIXES,
  extractPersonalFileKey,
  validatePersonalFileKey,
};
