const crypto = require("crypto");
const fs = require("fs");

const ApprovalTask = require("../../models/ApprovalTask");
const KnowledgeCollection = require("../../models/KnowledgeCollection");
const KnowledgeItem = require("../../models/KnowledgeItem");
const KnowledgeRevision = require("../../models/KnowledgeRevision");
const KnowledgeSource = require("../../models/KnowledgeSource");
const { COLLECTION_REGISTRY, findRegistrySource, listRegistrySources } = require("./sourceRegistry");
const { publishEventSafe } = require("../lpcEvents/publishEventService");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function buildFingerprint(itemDef = {}) {
  return sha256(
    JSON.stringify({
      title: itemDef.title,
      domain: itemDef.domain,
      recordType: itemDef.recordType,
      audienceScopes: itemDef.audienceScopes,
      content: itemDef.content,
      citations: itemDef.citations,
      tags: itemDef.tags,
    })
  );
}

function toDateDaysFromNow(days = 90) {
  const next = new Date();
  next.setDate(next.getDate() + Math.max(1, Number(days) || 90));
  return next;
}

function toActor(actor = {}) {
  return {
    actorType: actor.actorType || "system",
    userId: actor.userId || null,
    label: actor.label || "System",
  };
}

async function ensureCollections() {
  const collectionsByKey = new Map();

  await Promise.all(
    COLLECTION_REGISTRY.map(async (definition) => {
      const collection = await KnowledgeCollection.findOneAndUpdate(
        { key: definition.key },
        {
          $set: {
            title: definition.title,
            description: definition.description,
            domain: definition.domain,
            audienceScopes: definition.audienceScopes,
            ownerLabel: definition.ownerLabel || "Samantha",
            isActive: true,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      collectionsByKey.set(definition.key, collection);
    })
  );

  return collectionsByKey;
}

async function ensureKnowledgeSource(sourceDef = {}) {
  const absolutePath = sourceDef.absolutePath || "";
  let sourceHash = "";
  let syncState = "synced";
  let lastSyncNote = "Seed registry synced successfully.";

  try {
    if (absolutePath && fs.existsSync(absolutePath)) {
      sourceHash = sha256(fs.readFileSync(absolutePath, "utf8"));
    } else {
      syncState = "error";
      lastSyncNote = "Source file was not found in the repository.";
    }
  } catch (err) {
    syncState = "error";
    lastSyncNote = err?.message || "Unable to read source file.";
  }

  return KnowledgeSource.findOneAndUpdate(
    { sourceKey: sourceDef.sourceKey },
    {
      $set: {
        title: sourceDef.title,
        sourceType: "file",
        filePath: sourceDef.filePath,
        syncState,
        sourceHash,
        lastSyncedAt: new Date(),
        lastSyncNote,
        metadata: {
          itemCount: Array.isArray(sourceDef.items) ? sourceDef.items.length : 0,
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function createRevisionForItem({
  item,
  itemDef,
  fingerprint,
  approvalState,
  actor,
  createdFrom,
  changeSummary,
}) {
  const latestRevision = await KnowledgeRevision.findOne({ knowledgeItemId: item._id })
    .sort({ revisionNumber: -1 })
    .select("revisionNumber")
    .lean();

  const revisionNumber = Number(latestRevision?.revisionNumber || 0) + 1;
  const revision = await KnowledgeRevision.create({
    knowledgeItemId: item._id,
    revisionNumber,
    fingerprint,
    content: itemDef.content || {},
    citations: itemDef.citations || [],
    approvalState,
    changeSummary: changeSummary || "",
    createdBy: toActor(actor),
    approvedBy: approvalState === "approved" ? toActor(actor) : null,
    approvedAt: approvalState === "approved" ? new Date() : null,
    createdFrom: createdFrom || "seed_sync",
  });

  return revision;
}

async function createApprovalTask({
  revision,
  item,
  summary,
  actor,
}) {
  const existing = await ApprovalTask.findOne({
    taskType: "knowledge_review",
    targetType: "knowledge_revision",
    targetId: String(revision._id),
    approvalState: "pending",
  }).lean();
  if (existing) return existing;

  const task = await ApprovalTask.create({
    taskType: "knowledge_review",
    targetType: "knowledge_revision",
    targetId: String(revision._id),
    parentType: "KnowledgeItem",
    parentId: String(item._id),
    title: `Review knowledge revision: ${item.title}`,
    summary: summary || "A new knowledge revision is awaiting founder review.",
    approvalState: "pending",
    requestedBy: toActor(actor),
    assignedOwnerLabel: item.ownerLabel || "Samantha",
    metadata: {
      itemKey: item.key,
      revisionNumber: revision.revisionNumber,
    },
  });

  await publishEventSafe({
    eventType: "approval.requested",
    eventFamily: "approval",
    idempotencyKey: `approval-task:${task._id}:requested`,
    correlationId: `knowledge:${item._id}`,
    actor: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Knowledge Sync Service",
    },
    subject: {
      entityType: "approval_task",
      entityId: String(task._id),
    },
    related: {
      approvalTaskId: task._id,
      knowledgeItemId: item._id,
      knowledgeRevisionId: revision._id,
    },
    source: {
      surface: "system",
      route: "",
      service: "knowledge",
      producer: "service",
    },
    facts: {
      title: task.title,
      summary: task.summary,
      approvalTargetType: task.targetType,
      approvalTargetId: task.targetId,
      ownerLabel: task.assignedOwnerLabel || "Samantha",
    },
    signals: {
      confidence: "high",
      priority: "high",
      founderVisible: String(task.assignedOwnerLabel || "").toLowerCase() === "samantha",
      approvalRequired: true,
      publicFacing: (item.audienceScopes || []).includes("public_approved"),
    },
  });

  return task;
}

async function ensurePendingRevisionFromDrift({
  itemId,
  itemDef,
  sourceKey = "",
  fingerprint = "",
  actor = {},
  changeSummary = "Source-backed draft revision created after registry drift.",
} = {}) {
  const item = await KnowledgeItem.findById(itemId);
  if (!item) throw new Error("Knowledge item not found.");

  const nextFingerprint = String(fingerprint || buildFingerprint(itemDef));
  let revision = await KnowledgeRevision.findOne({
    knowledgeItemId: item._id,
    fingerprint: nextFingerprint,
    approvalState: "pending_review",
  })
    .sort({ revisionNumber: -1 })
    .lean();

  if (!revision) {
    const createdRevision = await createRevisionForItem({
      item,
      itemDef,
      fingerprint: nextFingerprint,
      approvalState: "pending_review",
      actor,
      createdFrom: "seed_sync_drift",
      changeSummary,
    });
    revision = createdRevision.toObject ? createdRevision.toObject() : createdRevision;
  }

  await KnowledgeItem.updateOne(
    { _id: item._id },
    {
      $set: {
        title: itemDef.title,
        collectionId: item.collectionId,
        domain: itemDef.domain,
        recordType: itemDef.recordType,
        audienceScopes: itemDef.audienceScopes || item.audienceScopes,
        approvalState: "pending_review",
        ownerLabel: itemDef.ownerLabel || item.ownerLabel,
        freshnessDays: itemDef.freshnessDays || item.freshnessDays,
        nextReviewAt: toDateDaysFromNow(itemDef.freshnessDays || item.freshnessDays || 90),
        currentRevisionId: revision._id,
        sourceKeys: Array.from(new Set([...(item.sourceKeys || []), sourceKey].filter(Boolean))),
        tags: itemDef.tags || item.tags,
        isActive: true,
      },
    }
  );

  const freshItem = await KnowledgeItem.findById(item._id).lean();
  const task = await createApprovalTask({
    revision,
    item: freshItem || item.toObject(),
    actor,
    summary: `A source-backed draft revision for ${item.title} is awaiting review before it can replace the approved version.`,
  });

  return {
    item: freshItem || item.toObject(),
    revision,
    approvalTask: task,
  };
}

async function syncRegistryItem({ sourceDef, collection, itemDef, actor }) {
  const fingerprint = buildFingerprint(itemDef);
  let item = await KnowledgeItem.findOne({ key: itemDef.key });

  if (!item) {
    item = await KnowledgeItem.create({
      key: itemDef.key,
      title: itemDef.title,
      slug: itemDef.key,
      collectionId: collection._id,
      domain: itemDef.domain,
      recordType: itemDef.recordType,
      audienceScopes: itemDef.audienceScopes || ["internal_ops"],
      approvalState: "approved",
      ownerLabel: itemDef.ownerLabel || "Samantha",
      freshnessDays: itemDef.freshnessDays || 90,
      lastReviewedAt: new Date(),
      nextReviewAt: toDateDaysFromNow(itemDef.freshnessDays || 90),
      sourceKeys: [sourceDef.sourceKey],
      tags: itemDef.tags || [],
      isActive: true,
    });

    const revision = await createRevisionForItem({
      item,
      itemDef,
      fingerprint,
      approvalState: "approved",
      actor,
      createdFrom: "seed_sync",
      changeSummary: "Initial approved seed from current LPC source registry.",
    });

    item.currentRevisionId = revision._id;
    item.currentApprovedRevisionId = revision._id;
    await item.save();

    return { created: 1, updated: 0, pending: 0 };
  }

  const currentRevision = item.currentRevisionId
    ? await KnowledgeRevision.findById(item.currentRevisionId).select("fingerprint approvalState").lean()
    : null;
  const approvedRevision = item.currentApprovedRevisionId
    ? await KnowledgeRevision.findById(item.currentApprovedRevisionId).select("fingerprint approvalState").lean()
    : null;

  const knownFingerprint = currentRevision?.fingerprint || approvedRevision?.fingerprint || "";
  if (knownFingerprint === fingerprint) {
    await KnowledgeItem.updateOne(
      { _id: item._id },
      {
        $set: {
          collectionId: collection._id,
          domain: itemDef.domain,
          recordType: itemDef.recordType,
          audienceScopes: itemDef.audienceScopes || item.audienceScopes,
          ownerLabel: itemDef.ownerLabel || item.ownerLabel,
          freshnessDays: itemDef.freshnessDays || item.freshnessDays,
          nextReviewAt: toDateDaysFromNow(itemDef.freshnessDays || item.freshnessDays || 90),
          sourceKeys: Array.from(new Set([...(item.sourceKeys || []), sourceDef.sourceKey])),
          tags: itemDef.tags || item.tags,
          isActive: true,
        },
      }
    );
    return { created: 0, updated: 0, pending: 0 };
  }

  await publishEventSafe({
    eventType: "knowledge.item.drift_detected",
    eventFamily: "knowledge",
    idempotencyKey: `knowledge-item:${item._id}:drift:${fingerprint}`,
    correlationId: `knowledge:${item._id}`,
    actor: {
      actorType: actor.actorType || "system",
      userId: actor.userId || null,
      label: actor.label || "Knowledge Sync Service",
    },
    subject: {
      entityType: "knowledge_item",
      entityId: String(item._id),
    },
    related: {
      knowledgeItemId: item._id,
    },
    source: {
      surface: "system",
      route: sourceDef.filePath || "",
      service: "knowledge",
      producer: "service",
    },
    facts: {
      title: item.title,
      summary: `Registry drift detected for ${item.title}.`,
      sourceKey: sourceDef.sourceKey,
      fingerprint,
      itemDef,
    },
    signals: {
      confidence: "high",
      priority: (item.audienceScopes || []).includes("public_approved") ? "high" : "normal",
      founderVisible: (item.audienceScopes || []).includes("public_approved"),
      publicFacing: (item.audienceScopes || []).includes("public_approved"),
    },
  });

  return { created: 0, updated: 1, pending: 1 };
}

async function syncSourceRegistry(options = {}) {
  const actor = options.actor || { actorType: "system", label: "Knowledge Sync Service" };
  const onlySourceKey = String(options.sourceKey || "").trim();
  const registrySources = onlySourceKey
    ? [findRegistrySource(onlySourceKey)].filter(Boolean)
    : listRegistrySources();

  const collectionsByKey = await ensureCollections();
  const summary = {
    syncedSources: 0,
    createdItems: 0,
    updatedItems: 0,
    pendingRevisions: 0,
    missingSources: [],
  };

  for (const sourceDef of registrySources) {
    const source = await ensureKnowledgeSource(sourceDef);
    summary.syncedSources += 1;
    if (source.syncState === "error") {
      summary.missingSources.push(sourceDef.sourceKey);
    }

    for (const itemDef of sourceDef.items || []) {
      const collection = collectionsByKey.get(itemDef.collectionKey);
      if (!collection) continue;
      const result = await syncRegistryItem({
        sourceDef,
        collection,
        itemDef,
        actor,
      });
      summary.createdItems += result.created;
      summary.updatedItems += result.updated;
      summary.pendingRevisions += result.pending;
    }
  }

  return summary;
}

module.exports = {
  buildFingerprint,
  createApprovalTask,
  ensureCollections,
  ensurePendingRevisionFromDrift,
  listRegistrySources,
  toDateDaysFromNow,
  syncSourceRegistry,
};
