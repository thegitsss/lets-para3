// backend/routes/disputes.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireRole, requireCaseAccess } = require("../utils/authz");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLogs");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);

function parsePagination(req, { maxLimit = 100, defaultLimit = 25 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ----------------------------------------
// All dispute routes require auth
// ----------------------------------------
router.use(verifyToken);

/**
 * GET /api/disputes/admin
 * Admin overview of disputes across cases.
 * Query: ?status=open|resolved|rejected&q=&page=&limit=
 */
router.get(
  "/admin",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { status, q = "" } = req.query;
    const { page, limit, skip } = parsePagination(req);

    // Unwind disputes for admin-wide view
    const pipeline = [
      { $match: { "disputes.0": { $exists: true } } },
      { $unwind: "$disputes" },
    ];

    const match = {};
    if (status && ["open", "resolved", "rejected"].includes(status)) {
      match["disputes.status"] = status;
    }
    if (q.trim()) {
      match.$or = [
        { "disputes.message": { $regex: q.trim(), $options: "i" } },
        { title: { $regex: q.trim(), $options: "i" } },
      ];
    }
    if (Object.keys(match).length) pipeline.push({ $match: match });

    pipeline.push(
      { $sort: { "disputes.createdAt": -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          caseId: "$_id",
          caseTitle: "$title",
          attorney: "$attorney",
          paralegal: "$paralegal",
          dispute: "$disputes",
        },
      }
    );

    const [items, count] = await Promise.all([
      Case.aggregate(pipeline),
      Case.aggregate([
        { $match: { "disputes.0": { $exists: true } } },
        ...(Object.keys(match).length ? [{ $match: match }] : []),
        { $count: "n" },
      ]),
    ]);

    const total = count[0]?.n || 0;
    res.json({ page, limit, total, pages: Math.ceil(total / limit), items });
  })
);

/**
 * GET /api/disputes/:caseId
 * List disputes for a single case (must have access to the case).
 */
router.get(
  "/:caseId",
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });

    const c = await Case.findById(caseId)
      .populate("attorney paralegal", "name email role")
      .lean();
    if (!c) return res.status(404).json({ error: "Case not found" });

    const disputes = (c.disputes || []).map((d) => ({
      ...d,
      id: d.disputeId || String(d._id),
    }));

    res.json({
      case: { id: c._id, title: c.title, status: c.status },
      disputes,
    });
  })
);

/**
 * POST /api/disputes/:caseId
 * Create a dispute on a case (attorney, paralegal on the case, or admin).
 * Body: { message }
 */
router.post(
  "/:caseId",
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const { message } = req.body || {};
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });
    if (!message || !String(message).trim()) return res.status(400).json({ error: "message required" });

    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });

    // Only attorney, paralegal (if assigned), or admin can open a dispute
    const isParty =
      String(c.attorney) === String(req.user.id) ||
      (c.paralegal && String(c.paralegal) === String(req.user.id)) ||
      req.user.role === "admin";
    if (!isParty) return res.status(403).json({ error: "Not authorized to dispute this case" });

    // Use model helper if available
    if (typeof c.createDispute === "function") {
      c.createDispute({ message: String(message).trim(), raisedBy: req.user.id });
    } else {
      c.disputes.push({
        message: String(message).trim(),
        raisedBy: req.user.id,
        status: "open",
      });
      if (c.status !== "closed") c.status = "disputed";
    }

    await c.save();

    const last = c.disputes[c.disputes.length - 1];

    await AuditLog.logFromReq(req, "dispute.create", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { disputeId: last?.disputeId || String(last?._id) },
    });

    res.status(201).json({
      ok: true,
      disputeId: last?.disputeId || String(last?._id),
    });
  })
);

/**
 * POST /api/disputes/:caseId/:disputeId/comment
 * Add a comment to a dispute (parties on the case or admin).
 * Body: { text }
 */
router.post(
  "/:caseId/:disputeId/comment",
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const { caseId, disputeId } = req.params;
    const { text } = req.body || {};
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text required" });

    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });

    const d = (c.disputes || []).find(
      (x) => String(x.disputeId || x._id) === String(disputeId)
    );
    if (!d) return res.status(404).json({ error: "Dispute not found" });

    // Only parties or admin may comment
    const isParty =
      String(c.attorney) === String(req.user.id) ||
      (c.paralegal && String(c.paralegal) === String(req.user.id)) ||
      req.user.role === "admin";
    if (!isParty) return res.status(403).json({ error: "Not authorized" });

    d.comments = d.comments || [];
    d.comments.push({ by: req.user.id, text: String(text).trim() });
    await c.save();

    await AuditLog.logFromReq(req, "dispute.comment.add", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { disputeId },
    });

    res.status(201).json({ ok: true });
  })
);

/**
 * PATCH /api/disputes/:caseId/:disputeId
 * Admin can update dispute status: { status: 'open'|'resolved'|'rejected' }
 * Optionally when status === 'resolved', auto-close the case if it was 'completed'/'disputed'
 */
router.patch(
  "/:caseId/:disputeId",
  requireRole("admin"),
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const { caseId, disputeId } = req.params;
    const { status } = req.body || {};

    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });
    if (!["open", "resolved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });

    const d = (c.disputes || []).find(
      (x) => String(x.disputeId || x._id) === String(disputeId)
    );
    if (!d) return res.status(404).json({ error: "Dispute not found" });

    d.status = status;
    // If resolved and case is in a resolvable state, move to closed
    if (status === "resolved") {
      if (typeof c.canTransitionTo === "function" && c.canTransitionTo("closed")) {
        c.transitionTo("closed");
      } else if (["completed", "disputed"].includes(c.status)) {
        c.status = "closed";
      }
    }
    await c.save();

    await AuditLog.logFromReq(req, "dispute.status.update", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { disputeId, status },
    });

    res.json({ ok: true });
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

module.exports = router;
