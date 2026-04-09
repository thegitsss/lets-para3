const { LpcAction } = require("../../models/LpcAction");

function uniqueObjectIds(values = []) {
  const seen = new Set();
  const result = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const key = String(value || "").trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });
  return result;
}

async function openLifecycleFollowUp({
  dedupeKey,
  title,
  summary = "",
  recommendedAction = "",
  priority = "normal",
  subject,
  related = {},
  sourceEventId = null,
  dueAt = null,
  metadata = {},
  ownerLabel = "Samantha",
  openedBy = { actorType: "system", label: "Lifecycle Service" },
} = {}) {
  if (!dedupeKey || !subject?.entityType || !subject?.entityId) {
    throw new Error("Lifecycle follow-up requires a dedupe key and subject.");
  }

  const now = new Date();
  const existing = await LpcAction.findOne({ dedupeKey, status: "open" });
  if (existing) {
    existing.lastSeenAt = now;
    existing.title = title || existing.title;
    existing.summary = summary || existing.summary;
    existing.recommendedAction = recommendedAction || existing.recommendedAction;
    existing.priority = priority || existing.priority;
    existing.related = { ...(existing.related || {}), ...(related || {}) };
    existing.metadata = { ...(existing.metadata || {}), ...(metadata || {}) };
    if (dueAt) existing.dueAt = dueAt;
    existing.sourceEventIds = uniqueObjectIds([...(existing.sourceEventIds || []), sourceEventId].filter(Boolean));
    existing.latestEventId = sourceEventId || existing.latestEventId;
    await existing.save();
    return { action: existing, created: false };
  }

  const action = await LpcAction.create({
    actionType: "lifecycle_follow_up",
    status: "open",
    dedupeKey,
    ownerLabel,
    title,
    summary,
    recommendedAction,
    priority,
    subject,
    related,
    sourceEventIds: sourceEventId ? [sourceEventId] : [],
    firstEventId: sourceEventId || null,
    latestEventId: sourceEventId || null,
    firstSeenAt: now,
    lastSeenAt: now,
    dueAt,
    openedBy,
    metadata,
  });

  return { action, created: true };
}

async function resolveLifecycleFollowUps({
  dedupeKeys = [],
  subject = null,
  resolutionReason = "",
  resolvedBy = { actorType: "system", label: "Lifecycle Service" },
} = {}) {
  const query = { actionType: "lifecycle_follow_up", status: "open" };
  const cleanKeys = (Array.isArray(dedupeKeys) ? dedupeKeys : []).map((value) => String(value || "").trim()).filter(Boolean);
  if (cleanKeys.length) {
    query.dedupeKey = { $in: cleanKeys };
  } else if (subject?.entityType && subject?.entityId) {
    query["subject.entityType"] = subject.entityType;
    query["subject.entityId"] = subject.entityId;
  } else {
    return { modifiedCount: 0 };
  }

  const update = await LpcAction.updateMany(query, {
    $set: {
      status: "resolved",
      resolvedAt: new Date(),
      resolvedBy,
      resolutionReason: resolutionReason || "Resolved.",
    },
  });

  return update;
}

async function listOpenLifecycleFollowUps({ limit = 50 } = {}) {
  return LpcAction.find({ actionType: "lifecycle_follow_up", status: "open" })
    .sort({ priority: -1, dueAt: 1, lastSeenAt: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();
}

module.exports = {
  listOpenLifecycleFollowUps,
  openLifecycleFollowUp,
  resolveLifecycleFollowUps,
};
