const crypto = require("crypto");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const StorageDeletionTask = require("../models/StorageDeletionTask");
const User = require("../models/User");
const { extractPersonalFileKey } = require("../utils/personalFileReference");
const { extractProfilePhotoKey } = require("./profilePhotoDelivery");
const { createLogger } = require("../utils/logger");
const { createS3Client } = require("../utils/s3Client");
const { hasRetainedResumeReference } = require("./personalDocumentReferences");

const logger = createLogger("personal-storage-deletion");
const HOLD_RECOVERY_MS = 10 * 60 * 1000;
const PROCESSING_LOCK_MS = 10 * 60 * 1000;
const COMPLETED_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const USER_STORAGE_FIELDS =
  "resumeURL certificateURL writingSampleURL profileImage avatarURL profileImageOriginal pendingProfileImage pendingProfileImageOriginal " +
  "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey";

function defaultS3Client() {
  return createS3Client();
}

function cleanOwnerId(value) {
  const ownerId = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{24}$/.test(ownerId) ? ownerId : "";
}

function normalizeOwnedPersonalKey(value, ownerId, env = process.env) {
  const owner = cleanOwnerId(ownerId);
  if (!owner) return "";
  const profileKey = extractProfilePhotoKey(value, {
    ownerId: owner,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
  });
  if (profileKey) return profileKey;
  for (const type of ["resume", "certificate", "writingSample"]) {
    const personalKey = extractPersonalFileKey(value, {
      ownerId: owner,
      type,
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      cdnBase: env.S3_CDN_BASE_URL,
    });
    if (personalKey) return personalKey;
  }
  return "";
}

function collectUserPersonalStorageKeys(user, env = process.env) {
  if (!user) return [];
  const ownerId = user._id || user.id;
  const values = [
    user.resumeURL,
    user.certificateURL,
    user.writingSampleURL,
    user.profileImageKey,
    user.profileImage,
    user.avatarURL,
    user.profileImageOriginalKey,
    user.profileImageOriginal,
    user.pendingProfileImageKey,
    user.pendingProfileImage,
    user.pendingProfileImageOriginalKey,
    user.pendingProfileImageOriginal,
  ];
  return [...new Set(values.map((value) => normalizeOwnedPersonalKey(value, ownerId, env)).filter(Boolean))];
}

function normalizedKeys(keys, ownerId, env) {
  const values = Array.isArray(keys) ? keys : [keys];
  const normalized = new Set();
  for (const key of values) {
    if (!String(key || "").trim()) continue;
    const safeKey = normalizeOwnedPersonalKey(key, ownerId, env);
    if (!safeKey) {
      const error = new Error("Storage deletion contains an invalid or unowned object key.");
      error.code = "INVALID_STORAGE_DELETION_KEY";
      throw error;
    }
    normalized.add(safeKey);
  }
  return [...normalized];
}

async function stagePersonalStorageDeletion(
  { ownerId, keys, reason, now = new Date() },
  { env = process.env } = {}
) {
  const owner = cleanOwnerId(ownerId);
  if (!owner) throw new Error("A valid ownerId is required to stage personal storage deletion.");
  const safeKeys = normalizedKeys(keys, owner, env);
  if (!safeKeys.length) return [];
  const bucket = String(env.S3_BUCKET || "").trim();
  if (!bucket) throw new Error("S3_BUCKET is required to stage personal storage deletion.");
  const eligibleAt = new Date(now.getTime() + HOLD_RECOVERY_MS);
  const taskIds = [];
  for (const key of safeKeys) {
    const task = await StorageDeletionTask.findOneAndUpdate(
      { bucket, key },
      {
        $set: {
          ownerId: owner,
          reason: String(reason || "personal_object_replaced").slice(0, 120),
          status: "held",
          attempts: 0,
          eligibleAt,
          lockedAt: null,
          lockToken: "",
          lastErrorCode: "",
          deletedAt: null,
          expiresAt: null,
        },
        $setOnInsert: { bucket, key },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
    taskIds.push(task._id);
  }
  return taskIds;
}

async function activatePersonalStorageDeletion(taskIds, { now = new Date() } = {}) {
  const ids = (taskIds || []).filter(Boolean);
  if (!ids.length) return { activated: 0 };
  const result = await StorageDeletionTask.updateMany(
    { _id: { $in: ids }, status: "held" },
    { $set: { status: "pending", eligibleAt: now } }
  );
  return { activated: Number(result.modifiedCount || 0) };
}

async function cancelPersonalStorageDeletion(taskIds, { now = new Date() } = {}) {
  const ids = (taskIds || []).filter(Boolean);
  if (!ids.length) return { cancelled: 0 };
  const result = await StorageDeletionTask.updateMany(
    { _id: { $in: ids }, status: "held" },
    {
      $set: {
        status: "cancelled",
        eligibleAt: now,
        expiresAt: new Date(now.getTime() + COMPLETED_TASK_RETENTION_MS),
      },
    }
  );
  return { cancelled: Number(result.modifiedCount || 0) };
}

async function queuePersonalStorageDeletion(input, options = {}) {
  const taskIds = await stagePersonalStorageDeletion(input, options);
  await activatePersonalStorageDeletion(taskIds, { now: input.now || new Date() });
  return taskIds;
}

async function reconcileHeldTasks({ now = new Date(), limit = 50, env = process.env } = {}) {
  const held = await StorageDeletionTask.find({ status: "held", eligibleAt: { $lte: now } })
    .sort({ eligibleAt: 1 })
    .limit(limit)
    .lean();
  let activated = 0;
  let cancelled = 0;
  for (const task of held) {
    const user = await User.findById(task.ownerId).select(USER_STORAGE_FIELDS);
    const stillReferenced = (user && collectUserPersonalStorageKeys(user, env).includes(task.key))
      || await hasRetainedResumeReference(task.ownerId, task.key, env);
    if (stillReferenced) {
      const result = await cancelPersonalStorageDeletion([task._id], { now });
      cancelled += result.cancelled;
    } else {
      const result = await activatePersonalStorageDeletion([task._id], { now });
      activated += result.activated;
    }
  }
  return { scanned: held.length, activated, cancelled };
}

function retryDelayMs(attempts) {
  return Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(10, Math.max(0, attempts - 1)));
}

async function claimDeletionTask(now = new Date()) {
  const staleLock = new Date(now.getTime() - PROCESSING_LOCK_MS);
  const lockToken = crypto.randomUUID();
  return StorageDeletionTask.findOneAndUpdate(
    {
      $or: [
        { status: { $in: ["pending", "retrying"] }, eligibleAt: { $lte: now } },
        { status: "processing", lockedAt: { $lte: staleLock } },
      ],
    },
    { $set: { status: "processing", lockedAt: now, lockToken } },
    { returnDocument: "after", sort: { eligibleAt: 1, createdAt: 1 } }
  );
}

async function processPersonalStorageDeletionTasks(
  { now = new Date(), limit = 50 } = {},
  { env = process.env, s3 = defaultS3Client() } = {}
) {
  const bucket = String(env.S3_BUCKET || "").trim();
  if (!bucket) throw new Error("S3_BUCKET is required to process personal storage deletion.");
  const reconciliation = await reconcileHeldTasks({ now, limit, env });
  let deleted = 0;
  let retried = 0;
  let blocked = 0;
  let cancelled = Number(reconciliation.cancelled || 0);
  for (let index = 0; index < limit; index += 1) {
    const task = await claimDeletionTask(now);
    if (!task) break;
    try {
      const safeKey = normalizeOwnedPersonalKey(task.key, task.ownerId, env);
      if (task.bucket !== bucket || !safeKey || safeKey !== task.key) {
        const unsafe = new Error("Claimed storage deletion failed its ownership boundary check.");
        unsafe.code = task.bucket !== bucket ? "STORAGE_BUCKET_MISMATCH" : "INVALID_STORAGE_DELETION_KEY";
        throw unsafe;
      }
      const owner = await User.findById(task.ownerId).select(USER_STORAGE_FIELDS);
      if ((owner && collectUserPersonalStorageKeys(owner, env).includes(task.key))
        || await hasRetainedResumeReference(task.ownerId, task.key, env)) {
        await StorageDeletionTask.updateOne(
          { _id: task._id, status: "processing", lockToken: task.lockToken },
          {
            $set: {
              status: "cancelled",
              eligibleAt: now,
              lockedAt: null,
              lockToken: "",
              lastErrorCode: "",
              expiresAt: new Date(now.getTime() + COMPLETED_TASK_RETENTION_MS),
            },
          }
        );
        cancelled += 1;
        continue;
      }
      await s3.send(new DeleteObjectCommand({ Bucket: task.bucket, Key: task.key }));
      await StorageDeletionTask.updateOne(
        { _id: task._id, status: "processing", lockToken: task.lockToken },
        {
          $set: {
            status: "deleted",
            deletedAt: now,
            lockedAt: null,
            lockToken: "",
            lastErrorCode: "",
            expiresAt: new Date(now.getTime() + COMPLETED_TASK_RETENTION_MS),
          },
        }
      );
      deleted += 1;
    } catch (error) {
      const attempts = Number(task.attempts || 0) + 1;
      const failureCode = String(error?.code || error?.name || "STORAGE_DELETE_FAILED").slice(0, 160);
      const unsafeBoundary = ["STORAGE_BUCKET_MISMATCH", "INVALID_STORAGE_DELETION_KEY"].includes(failureCode);
      await StorageDeletionTask.updateOne(
        { _id: task._id, status: "processing", lockToken: task.lockToken },
        {
          $set: {
            status: unsafeBoundary ? "blocked" : "retrying",
            attempts,
            eligibleAt: unsafeBoundary ? now : new Date(now.getTime() + retryDelayMs(attempts)),
            lockedAt: null,
            lockToken: "",
            lastErrorCode: failureCode,
          },
        }
      );
      logger.error({
        taskId: String(task._id),
        attempt: attempts,
        errorCode: failureCode,
        message: unsafeBoundary
          ? "Personal object deletion was blocked by its ownership boundary check."
          : "Personal object deletion will be retried.",
      });
      if (unsafeBoundary) blocked += 1;
      else retried += 1;
    }
  }
  return { ...reconciliation, cancelled, deleted, retried, blocked };
}

module.exports = {
  USER_STORAGE_FIELDS,
  activatePersonalStorageDeletion,
  cancelPersonalStorageDeletion,
  collectUserPersonalStorageKeys,
  normalizeOwnedPersonalKey,
  processPersonalStorageDeletionTasks,
  queuePersonalStorageDeletion,
  reconcileHeldTasks,
  stagePersonalStorageDeletion,
};
