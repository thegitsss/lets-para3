// backend/services/caseLifecycle.js
// Utilities for case archives (ZIP generation + scheduled S3 purges).

const { PassThrough } = require("stream");
const archiver = require("archiver");
const {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const Case = require("../models/Case");
const Message = require("../models/Message");
const Task = require("../models/Task");

const BUCKET = process.env.S3_BUCKET || "";
const REGION = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";
const CREDENTIALS =
  process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
    ? {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      }
    : undefined;

const s3 = new S3Client({ region: REGION, credentials: CREDENTIALS });
const PURGE_INTERVAL_MS = Math.max(30_000, Number(process.env.CASE_PURGE_INTERVAL_MS || 60_000));
const PURGE_BATCH_LIMIT = Math.max(1, Math.min(10, Number(process.env.CASE_PURGE_BATCH_LIMIT || 3)));
let purgeWorkerStarted = false;

function normalizeKey(key) {
  return String(key || "").replace(/^\/+/, "");
}

function safeFilename(input, { fallback = "file" } = {}) {
  const value = String(input || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/-+/g, "-")
    .trim();
  if (!value) return fallback;
  return value.length > 120 ? value.slice(0, 120) : value;
}

function archiveMetadataFromCase(doc) {
  const attorney =
    typeof doc.attorney === "object" && doc.attorney
      ? {
          id: String(doc.attorney._id || doc.attorney.id || doc.attorneyId || ""),
          firstName: doc.attorney.firstName || "",
          lastName: doc.attorney.lastName || "",
          email: doc.attorney.email || "",
          role: doc.attorney.role || "",
        }
      : null;
  const paralegal =
    typeof doc.paralegal === "object" && doc.paralegal
      ? {
          id: String(doc.paralegal._id || doc.paralegal.id || doc.paralegalId || ""),
          firstName: doc.paralegal.firstName || "",
          lastName: doc.paralegal.lastName || "",
          email: doc.paralegal.email || "",
          role: doc.paralegal.role || "",
        }
      : null;
  return {
    id: String(doc._id),
    title: doc.title,
    practiceArea: doc.practiceArea,
    status: doc.status,
    deadline: doc.deadline,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    completedAt: doc.completedAt,
    attorney: attorney || {
      id: String(doc.attorneyId || ""),
      name: doc.attorneyNameSnapshot || "",
    },
    paralegal: paralegal || {
      id: String(doc.paralegalId || ""),
      name: doc.paralegalNameSnapshot || "",
    },
    totalAmount: doc.lockedTotalAmount || doc.totalAmount || 0,
    currency: doc.currency || "usd",
    paymentReleased: !!doc.paymentReleased,
    payoutTransferId: doc.payoutTransferId || null,
    briefSummary: doc.briefSummary || "",
    zoomLink: doc.zoomLink || "",
    archived: !!doc.archived,
    readOnly: !!doc.readOnly,
  };
}

async function appendS3Object(archive, key, name) {
  if (!key || !name || !BUCKET) return;
  const normalized = normalizeKey(key);
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: normalized }));
    if (res?.Body) {
      archive.append(res.Body, { name });
    }
  } catch (err) {
    console.warn("[caseLifecycle] Missing S3 object", normalized, err?.message || err);
  }
}

async function generateArchiveZip(caseDoc) {
  if (!BUCKET) {
    throw new Error("S3 bucket is not configured");
  }
  if (!caseDoc || !caseDoc._id) {
    throw new Error("Case document required");
  }

  const caseId = String(caseDoc._id);
  const archiveKey = `cases/${caseId}/archive.zip`;
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stream = new PassThrough();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: archiveKey,
      Body: stream,
      ContentType: "application/zip",
      ACL: "private",
    },
  });

  archive.pipe(stream);

  const pipelinePromise = new Promise((resolve, reject) => {
    stream.on("close", resolve);
    stream.on("error", reject);
    archive.on("error", reject);
  });

  const [tasks, messages] = await Promise.all([
    Task.find({ caseId, deleted: { $ne: true } }).lean(),
    Message.find({ caseId }).select("senderId senderRole text content type createdAt fileKey fileName fileSize mimeType transcript").populate("senderId", "firstName lastName email role").lean(),
  ]);

  archive.append(JSON.stringify(archiveMetadataFromCase(caseDoc), null, 2), {
    name: "metadata/case.json",
  });
  archive.append(JSON.stringify(tasks || [], null, 2), { name: "metadata/checklist.json" });
  archive.append(JSON.stringify(messages || [], null, 2), { name: "metadata/messages.json" });

  // Documents
  if (Array.isArray(caseDoc.files)) {
    for (const file of caseDoc.files) {
      if (!file?.key) continue;
      const base = safeFilename(file.original || file.filename || `document-${Date.now()}`);
      const path = `documents/${base}`;
      // eslint-disable-next-line no-await-in-loop
      await appendS3Object(archive, file.key, path);
    }
  }

  // Message attachments
  const attachments = (messages || []).filter((msg) => !!msg.fileKey);
  for (const msg of attachments) {
    const timestamp = msg.createdAt ? new Date(msg.createdAt).toISOString().replace(/[:.]/g, "-") : Date.now();
    const baseName = safeFilename(msg.fileName || `attachment-${msg._id}`);
    const name = `messages/${timestamp}-${baseName}`;
    // eslint-disable-next-line no-await-in-loop
    await appendS3Object(archive, msg.fileKey, name);
  }

  archive.finalize();
  await Promise.all([upload.done(), pipelinePromise]);

  return {
    key: archiveKey,
    readyAt: new Date(),
    size: archive.pointer(),
  };
}

async function deleteCaseFolder(caseId) {
  if (!BUCKET) return;
  const prefix = `cases/${caseId}/`;
  let token;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    const objects = (res.Contents || []).map((obj) => ({ Key: obj.Key }));
    if (objects.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: objects, Quiet: true },
        })
      );
    }
    token = res.NextContinuationToken;
  } while (token);
}

async function purgeExpiredCases(limit = PURGE_BATCH_LIMIT) {
  if (!BUCKET) return;
  const now = new Date();
  const targets = await Case.find({
    purgeScheduledFor: { $lte: now },
    purgedAt: null,
  })
    .limit(limit)
    .select("_id");

  for (const doc of targets) {
    const caseId = String(doc._id);
    try {
      // eslint-disable-next-line no-await-in-loop
      await deleteCaseFolder(caseId);
    } catch (err) {
      console.error("[caseLifecycle] purge delete error", caseId, err?.message || err);
      continue;
    }

    const purgeFields = {
      files: [],
      downloadUrl: [],
      archiveZipKey: "",
      archiveReadyAt: null,
      archiveDownloadedAt: null,
      purgeScheduledFor: null,
      purgedAt: new Date(),
    };
    await Case.updateOne({ _id: caseId }, { $set: purgeFields });
  }
}

function startPurgeWorker() {
  if (purgeWorkerStarted) return;
  if (process.env.DISABLE_CASE_PURGER === "true") return;
  purgeWorkerStarted = true;
  if (!BUCKET) {
    console.warn("[caseLifecycle] S3 bucket not configured; purge worker disabled.");
    return;
  }
  setInterval(() => {
    purgeExpiredCases().catch((err) => {
      console.error("[caseLifecycle] purge worker error", err);
    });
  }, PURGE_INTERVAL_MS);
}

module.exports = {
  generateArchiveZip,
  deleteCaseFolder,
  purgeExpiredCases,
  startPurgeWorker,
};
