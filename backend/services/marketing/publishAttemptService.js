const crypto = require("crypto");

const MarketingPublishAttempt = require("../../models/MarketingPublishAttempt");
const MarketingPublishIntent = require("../../models/MarketingPublishIntent");

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "system",
    userId: actor.userId || actor._id || actor.id || null,
    label: actor.label || actor.email || "System",
  };
}

function hashPayload(value = "") {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function classifyPublishFailure(error = {}) {
  const statusCode = Number(error?.statusCode || error?.response?.status || 0);
  const message =
    String(
      error?.message ||
        error?.response?.data?.message ||
        error?.response?.data?.error_description ||
        error?.response?.statusText ||
        "Publishing failed."
    )
      .trim()
      .slice(0, 4000) || "Publishing failed.";

  if (!statusCode && (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" || error?.isNetworkError)) {
    return { failureClass: "transient", retryEligible: true, statusCode: 0, message };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { failureClass: "auth", retryEligible: false, statusCode, message };
  }
  if (statusCode === 400 || statusCode === 409 || statusCode === 413 || statusCode === 422) {
    return { failureClass: "validation", retryEligible: false, statusCode, message };
  }
  if (statusCode === 429 || statusCode >= 500) {
    return { failureClass: "transient", retryEligible: true, statusCode, message };
  }
  return { failureClass: "provider", retryEligible: false, statusCode, message };
}

async function createPublishAttempt({ intent, packet, actor = {}, requestSnapshot = {} } = {}) {
  const latestAttempt = await MarketingPublishAttempt.findOne({ intentId: intent._id })
    .sort({ attemptNumber: -1 })
    .select("attemptNumber")
    .lean();
  const attemptNumber = Number(latestAttempt?.attemptNumber || 0) + 1;

  return MarketingPublishAttempt.create({
    intentId: intent._id,
    packetId: packet._id,
    channelKey: intent.channelKey,
    provider: intent.provider,
    attemptNumber,
    status: "started",
    requestedBy: toActor(actor),
    startedAt: new Date(),
    requestSnapshot: {
      ...requestSnapshot,
      payloadHash: hashPayload(JSON.stringify(requestSnapshot || {})),
    },
  });
}

async function markPublishAttemptSuccess({
  attempt,
  intent,
  responseSnapshot = {},
  providerResourceId = "",
  providerResourceUrn = "",
  permalink = "",
} = {}) {
  attempt.status = "succeeded";
  attempt.completedAt = new Date();
  attempt.responseSnapshot = responseSnapshot;
  attempt.providerResourceId = String(providerResourceId || "").trim().slice(0, 240);
  attempt.providerResourceUrn = String(providerResourceUrn || "").trim().slice(0, 240);
  attempt.permalink = String(permalink || "").trim().slice(0, 1000);
  await attempt.save();

  intent.latestAttemptId = attempt._id;
  intent.status = "published";
  intent.publishedAt = attempt.completedAt;
  intent.providerResourceId = attempt.providerResourceId;
  intent.providerResourceUrn = attempt.providerResourceUrn;
  intent.permalink = attempt.permalink;
  intent.failureClass = "";
  intent.failureReason = "";
  intent.retryEligible = false;
  await intent.save();

  return attempt;
}

async function markPublishAttemptFailure({
  attempt,
  intent,
  error = {},
  responseSnapshot = {},
} = {}) {
  const classified = classifyPublishFailure(error);
  attempt.status = "failed";
  attempt.completedAt = new Date();
  attempt.responseSnapshot = responseSnapshot;
  attempt.failureClass = classified.failureClass;
  attempt.failureReason = classified.message;
  attempt.retryEligible = classified.retryEligible;
  await attempt.save();

  intent.latestAttemptId = attempt._id;
  intent.status = classified.retryEligible ? "retryable_failed" : "failed";
  intent.failureClass = classified.failureClass;
  intent.failureReason = classified.message;
  intent.retryEligible = classified.retryEligible;
  await intent.save();

  return {
    attempt,
    classified,
  };
}

async function listPublishHistoryForPacket(packetId = "", { limit = 6 } = {}) {
  const intents = await MarketingPublishIntent.find({ packetId })
    .sort({ createdAt: -1 })
    .limit(Math.min(20, Math.max(1, Number(limit) || 6)))
    .lean();
  const attemptIds = intents.map((intent) => intent.latestAttemptId).filter(Boolean);
  const attempts = attemptIds.length
    ? await MarketingPublishAttempt.find({ _id: { $in: attemptIds } }).lean()
    : [];
  const attemptById = new Map(attempts.map((attempt) => [String(attempt._id), attempt]));

  return intents.map((intent) => ({
    id: String(intent._id),
    status: intent.status,
    channelKey: intent.channelKey,
    provider: intent.provider,
    publishedAt: intent.publishedAt || null,
    providerResourceId: intent.providerResourceId || "",
    providerResourceUrn: intent.providerResourceUrn || "",
    permalink: intent.permalink || "",
    failureClass: intent.failureClass || "",
    failureReason: intent.failureReason || "",
    retryEligible: intent.retryEligible === true,
    createdAt: intent.createdAt || null,
    latestAttempt: intent.latestAttemptId ? attemptById.get(String(intent.latestAttemptId)) || null : null,
  }));
}

module.exports = {
  classifyPublishFailure,
  createPublishAttempt,
  hashPayload,
  listPublishHistoryForPacket,
  markPublishAttemptFailure,
  markPublishAttemptSuccess,
};
