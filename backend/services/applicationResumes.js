const { HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Writable } = require("stream");
const { pipeline } = require("stream/promises");
const { createS3Client } = require("../utils/s3Client");
const { extractPersonalFileKey } = require("../utils/personalFileReference");
const { assertObjectMalwareSafe } = require("../utils/fileSecurity");
const { selectedSnapshot } = require("./matterApplications");
const { fingerprint } = require("./matterDraftRevision");
const { id } = require('./applicationIdentity');

const MAX_BYTES = 10 * 1024 * 1024;
const NAME = "Application resume.pdf";
let client;
const fail = (status, suffix) => { throw Object.assign(new Error("Application résumé unavailable."), { status, publicCode: `APPLICATION_REVIEW_RESUME_${suffix}` }); };
function metadata(head) {
  if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength < 5 || typeof head.ETag !== "string" || !head.ETag || head.ETag.length > 256) fail(409, "CHANGED");
  if (head.ContentLength > MAX_BYTES) fail(413, "TOO_LARGE");
  if (typeof head.ContentType !== "string" || head.ContentType.split(";")[0].trim().toLowerCase() !== "application/pdf") fail(422, "INVALID_FILE");
  return { size: head.ContentLength, etag: head.ETag, version: typeof head.VersionId === "string" && head.VersionId !== "null" ? head.VersionId : null, type: head.ContentType, modified: head.LastModified || null };
}

async function read(req, download = false) {
  const allowed = download ? ["expectedOwnerId", "revision"] : ["expectedOwnerId"];
  if (Object.keys(req.query).some(key => !allowed.includes(key)) || download && (typeof req.query.revision !== "string" || !/^[a-f0-9]{64}$/.test(req.query.revision))) fail(400, "INVALID");
  const signal = AbortSignal.any([...(req.resumeSignal ? [req.resumeSignal] : []), AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const application = await selectedSnapshot(req);
  if (!application.resumeReference) fail(404, "NOT_RECORDED");
  const bucket = String(process.env.S3_BUCKET || "").trim();
  if (!bucket) fail(503, "UNAVAILABLE");
  const key = extractPersonalFileKey(application.resumeReference, { ownerId: id(req.params.applicantId), type: "resume", bucket, region: process.env.S3_REGION || process.env.AWS_REGION, cdnBase: process.env.S3_CDN_BASE_URL });
  if (!key) fail(422, "REFERENCE_INVALID");
  const s3 = client || (client = createS3Client());
  const head = async () => metadata(await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal }));
  const initial = await head();
  const revision = fingerprint([application.revision, initial]);
  if (download && revision !== req.query.revision) fail(409, "CHANGED");
  const scan = () => assertObjectMalwareSafe({ s3, bucket, key, ...(initial.version ? { versionId: initial.version } : {}), signal });
  await scan(); signal.throwIfAborted();
  let buffer;
  if (download) {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: initial.etag, ...(initial.version ? { VersionId: initial.version } : {}) }), { abortSignal: signal });
    try {
      if (!object.Body || typeof object.Body.pipe !== "function" || object.ETag !== initial.etag || object.ContentLength !== initial.size || initial.version && object.VersionId !== initial.version || object.ContentType !== initial.type) fail(409, "CHANGED");
      const chunks = []; let size = 0;
      await pipeline(object.Body, new Writable({ write(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > initial.size || size > MAX_BYTES) return callback(Object.assign(new Error("Résumé length changed."), { status: 409, publicCode: "APPLICATION_REVIEW_RESUME_CHANGED" }));
        chunks.push(chunk); callback();
      } }), { signal });
      if (size !== initial.size) fail(409, "CHANGED");
      buffer = Buffer.concat(chunks, size);
      if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") fail(422, "INVALID_FILE");
    } finally { object.Body?.destroy?.(); }
  }
  // Do not hand off partial bytes or a stale review after object replacement,
  // malware reclassification, application deletion, ownership or session loss.
  if (fingerprint(await head()) !== fingerprint(initial)) fail(409, "CHANGED");
  await scan();
  if ((await selectedSnapshot(req)).revision !== application.revision) fail(409, "CHANGED");
  signal.throwIfAborted();
  const value = { caseId: id(req.params.caseId), ownerId: id(req.user.id), applicantId: id(req.params.applicantId), applicationId: application.applicationId, name: NAME, size: initial.size, revision };
  return download ? { value, buffer } : value;
}

function errorResponse(error) {
  const missing = ["NoSuchKey", "NotFound", "NoSuchVersion"].includes(error.name) || error.$metadata?.httpStatusCode === 404;
  const changed = error.name === "PreconditionFailed" || error.$metadata?.httpStatusCode === 412;
  const security = { FILE_SCAN_PENDING: [423, "SCAN_PENDING"], FILE_SECURITY_BLOCKED: [422, "BLOCKED"], FILE_SCAN_ERROR: [503, "SCAN_ERROR"] }[error.code];
  const status = error.publicCode ? error.status : security ? security[0] : missing ? 404 : changed ? 409 : 503;
  const code = error.publicCode || `APPLICATION_REVIEW_RESUME_${security ? security[1] : missing ? "MISSING" : changed ? "CHANGED" : "UNAVAILABLE"}`;
  return { status: status || 503, body: { code, error: "The résumé recorded with this application could not be opened. Check the application again before downloading." } };
}
module.exports = { read, errorResponse, MAX_BYTES };
