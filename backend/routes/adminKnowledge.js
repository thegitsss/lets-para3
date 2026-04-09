const router = require("express").Router();

const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const KnowledgeCollection = require("../models/KnowledgeCollection");
const KnowledgeItem = require("../models/KnowledgeItem");
const KnowledgeRevision = require("../models/KnowledgeRevision");
const KnowledgeSource = require("../models/KnowledgeSource");
const {
  getKnowledgeOverview,
} = require("../services/knowledge/retrievalService");
const {
  listRegistrySources,
  syncSourceRegistry,
} = require("../services/knowledge/syncService");
const {
  approveKnowledgeRevision,
  listKnowledgeApprovalTasks,
  rejectKnowledgeRevision,
} = require("../services/knowledge/reviewService");

const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    },
  });
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function buildActor(req) {
  return {
    actorType: "user",
    userId: req.user?._id || req.user?.id || null,
    label: req.user?.email || "Admin",
  };
}

router.use(verifyToken, requireApproved, requireRole("admin"));

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const overview = await getKnowledgeOverview();
    res.json({ ok: true, ...overview });
  })
);

router.get(
  "/sources",
  asyncHandler(async (_req, res) => {
    const [persistedSources, registrySources] = await Promise.all([
      KnowledgeSource.find({}).sort({ updatedAt: -1 }).lean(),
      Promise.resolve(listRegistrySources()),
    ]);

    res.json({
      ok: true,
      sources: persistedSources,
      registrySources: registrySources.map((source) => ({
        sourceKey: source.sourceKey,
        title: source.title,
        filePath: source.filePath,
        itemCount: Array.isArray(source.items) ? source.items.length : 0,
      })),
    });
  })
);

router.post(
  "/sync",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const summary = await syncSourceRegistry({
      sourceKey: req.body?.sourceKey,
      actor: buildActor(req),
    });
    res.json({ ok: true, summary });
  })
);

router.get(
  "/collections",
  asyncHandler(async (_req, res) => {
    const collections = await KnowledgeCollection.find({}).sort({ domain: 1, title: 1 }).lean();
    res.json({ ok: true, collections });
  })
);

router.get(
  "/items",
  asyncHandler(async (req, res) => {
    const query = {};
    if (req.query.collectionId) query.collectionId = req.query.collectionId;
    if (req.query.approvalState) query.approvalState = String(req.query.approvalState);
    const items = await KnowledgeItem.find(query)
      .sort({ updatedAt: -1, title: 1 })
      .limit(Math.min(100, Math.max(1, Number(req.query.limit) || 50)))
      .lean();
    const revisionIds = items
      .map((item) => item.currentRevisionId)
      .filter(Boolean);
    const revisions = await KnowledgeRevision.find({ _id: { $in: revisionIds } }).lean();
    const revisionById = new Map(revisions.map((revision) => [String(revision._id), revision]));

    res.json({
      ok: true,
      items: items.map((item) => ({
        ...item,
        currentRevision: revisionById.get(String(item.currentRevisionId)) || null,
      })),
    });
  })
);

router.get(
  "/items/:id",
  asyncHandler(async (req, res) => {
    const item = await KnowledgeItem.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ error: "Knowledge item not found." });
    const revisions = await KnowledgeRevision.find({ knowledgeItemId: item._id })
      .sort({ revisionNumber: -1 })
      .lean();
    res.json({ ok: true, item, revisions });
  })
);

router.get(
  "/approvals",
  asyncHandler(async (_req, res) => {
    const approvals = await listKnowledgeApprovalTasks();
    res.json({ ok: true, approvals });
  })
);

router.post(
  "/revisions/:revisionId/approve",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await approveKnowledgeRevision({
      revisionId: req.params.revisionId,
      actor: buildActor(req),
      note: req.body?.note,
    });
    res.json({ ok: true, item: result.item, revision: result.revision });
  })
);

router.post(
  "/revisions/:revisionId/reject",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await rejectKnowledgeRevision({
      revisionId: req.params.revisionId,
      actor: buildActor(req),
      note: req.body?.note,
    });
    res.json({ ok: true, item: result.item, revision: result.revision });
  })
);

module.exports = router;
