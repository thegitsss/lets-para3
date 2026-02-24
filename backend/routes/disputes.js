// backend/routes/disputes.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const Case = require("../models/Case");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { notifyUser } = require("../utils/notifyUser");

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
// All dispute routes require auth + approval
// ----------------------------------------
router.use(verifyToken);
router.use(requireApproved);
router.param("caseId", ensureCaseParticipant("caseId"));

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
    const finalized = ["1", "true", "yes"].includes(String(req.query.finalized || "").toLowerCase());

    // Unwind disputes for admin-wide view
    const basePipeline = [
      { $match: { "disputes.0": { $exists: true } } },
      { $unwind: "$disputes" },
      {
        $addFields: {
          attorneyRef: { $ifNull: ["$attorney", "$attorneyId"] },
          paralegalRef: {
            $ifNull: ["$paralegal", { $ifNull: ["$paralegalId", "$withdrawnParalegalId"] }],
          },
        },
      },
      { $lookup: { from: "users", localField: "attorneyRef", foreignField: "_id", as: "attorneyDoc" } },
      { $lookup: { from: "users", localField: "paralegalRef", foreignField: "_id", as: "paralegalDoc" } },
      { $unwind: { path: "$attorneyDoc", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$paralegalDoc", preserveNullAndEmptyArrays: true } },
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
    if (finalized) {
      match["disputeSettlement.action"] = { $in: ["refund", "release_full", "release_partial"] };
      match.$expr = { $eq: ["$disputeSettlement.disputeId", "$disputes.disputeId"] };
    }

    if (Object.keys(match).length) basePipeline.push({ $match: match });

    const dataPipeline = basePipeline.concat([
      { $sort: { "disputes.createdAt": -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          caseId: "$_id",
          caseTitle: "$title",
          caseStatus: "$status",
          attorney: {
            id: "$attorneyDoc._id",
            firstName: "$attorneyDoc.firstName",
            lastName: "$attorneyDoc.lastName",
            email: "$attorneyDoc.email",
          },
          paralegal: {
            id: "$paralegalDoc._id",
            firstName: "$paralegalDoc.firstName",
            lastName: "$paralegalDoc.lastName",
            email: "$paralegalDoc.email",
          },
          lockedTotalAmount: "$lockedTotalAmount",
          totalAmount: "$totalAmount",
          remainingAmount: "$remainingAmount",
          currency: "$currency",
          feeParalegalPct: "$feeParalegalPct",
          feeParalegalAmount: "$feeParalegalAmount",
          feeAttorneyPct: "$feeAttorneyPct",
          feeAttorneyAmount: "$feeAttorneyAmount",
          escrowStatus: "$escrowStatus",
          paymentReleased: "$paymentReleased",
          payoutTransferId: "$payoutTransferId",
          pausedReason: "$pausedReason",
          disputeDeadlineAt: "$disputeDeadlineAt",
          partialPayoutAmount: "$partialPayoutAmount",
          payoutFinalizedAt: "$payoutFinalizedAt",
          payoutFinalizedType: "$payoutFinalizedType",
          withdrawnParalegalId: "$withdrawnParalegalId",
          relistPending: "$relistPending",
          relistRequestedAt: "$relistRequestedAt",
          disputeSettlement: "$disputeSettlement",
          dispute: "$disputes",
        },
      }
    ]);

    const countPipeline = basePipeline.concat([{ $count: "n" }]);

    const [items, count] = await Promise.all([
      Case.aggregate(dataPipeline),
      Case.aggregate(countPipeline),
    ]);

    const total = count[0]?.n || 0;
    res.json({ page, limit, total, pages: Math.ceil(total / limit), items });
  })
);

/**
 * GET /api/disputes/all
 * Simple list of all disputes for the admin UI (no pagination/filtering).
 */
router.get(
  "/all",
  requireRole("admin"),
  asyncHandler(async (_req, res) => {
    const cases = await Case.find({ "disputes.0": { $exists: true } })
      .select("title disputes status attorney paralegal")
      .populate("disputes.raisedBy", "firstName lastName email role")
      .lean();

    const disputes = [];
    for (const c of cases) {
      for (const d of c.disputes || []) {
        disputes.push({
          id: d.disputeId || (d._id ? String(d._id) : undefined),
          caseId: c._id,
          caseTitle: c.title,
          reason: d.message,
          status: d.status,
          createdAt: d.createdAt,
          raisedBy: d.raisedBy
            ? {
                id: d.raisedBy._id ? String(d.raisedBy._id) : String(d.raisedBy),
                name: `${d.raisedBy.firstName || ""} ${d.raisedBy.lastName || ""}`.trim() ||
                  d.raisedBy.email ||
                  "User",
                role: d.raisedBy.role || null,
                email: d.raisedBy.email || null,
              }
            : null,
        });
      }
    }

    disputes.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    res.json(disputes);
  })
);

/**
 * GET /api/disputes/:caseId
 * List disputes for a single case (must have access to the case).
 */
router.get(
  "/:caseId",
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });

    const c = await Case.findById(caseId)
      .populate("attorney paralegal", "firstName lastName email role")
      .lean();
    if (!c) return res.status(404).json({ error: "Case not found" });

    const isAdmin = String(req.user?.role || "").toLowerCase() === "admin";
    const disputes = (c.disputes || []).map((d) => {
      const shaped = {
        ...d,
        id: d.disputeId || String(d._id),
      };
      if (!isAdmin) {
        delete shaped.adminNotes;
        delete shaped.adminNotesUpdatedAt;
        delete shaped.adminNotesUpdatedBy;
      }
      return shaped;
    });

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
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const { message } = req.body || {};
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });
    if (!message || !String(message).trim()) return res.status(400).json({ error: "message required" });

    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });

    const now = new Date();
    const isWithdrawnParalegal =
      c.withdrawnParalegalId && String(c.withdrawnParalegalId) === String(req.user.id);
    const hasWithdrawalWindow =
      c.pausedReason === "paralegal_withdrew" &&
      c.disputeDeadlineAt &&
      !c.payoutFinalizedAt &&
      now.getTime() <= new Date(c.disputeDeadlineAt).getTime();
    if (hasWithdrawalWindow && !isWithdrawnParalegal && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the withdrawn paralegal can dispute within this window." });
    }

    // Only attorney, assigned paralegal, withdrawn paralegal (within window), or admin can open a dispute
    let isParty =
      String(c.attorney) === String(req.user.id) ||
      (c.paralegal && String(c.paralegal) === String(req.user.id)) ||
      req.user.role === "admin";
    if (isWithdrawnParalegal && hasWithdrawalWindow) {
      isParty = true;
    }
    if (c.pausedReason === "paralegal_withdrew" && c.disputeDeadlineAt && !hasWithdrawalWindow) {
      return res.status(400).json({ error: "The request window has expired." });
    }
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
    if (hasWithdrawalWindow || isWithdrawnParalegal) {
      c.status = "disputed";
      c.pausedReason = "dispute";
    }

    await c.save();

    const last = c.disputes[c.disputes.length - 1];

    await AuditLog.logFromReq(req, "dispute.create", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { disputeId: last?.disputeId || String(last?._id) },
    });

    try {
      const disputeId = last?.disputeId || (last?._id ? String(last._id) : "");
      const caseTitle = c.title || "Case";
      const payload = {
        title: "Dispute opened",
        message: `A dispute has been opened for the case: ${caseTitle}.`,
        caseId: String(c._id),
        disputeId,
        caseTitle,
      };
      const recipients = new Set();
      const attorneyId = c.attorney || c.attorneyId;
      const paralegalId = c.paralegal || c.paralegalId;
      if (attorneyId) recipients.add(String(attorneyId));
      if (paralegalId) recipients.add(String(paralegalId));
      if (c.withdrawnParalegalId) recipients.add(String(c.withdrawnParalegalId));

      const admins = await User.find({ role: "admin", status: "approved" }).select("_id").lean();
      admins.forEach((admin) => {
        if (admin?._id) recipients.add(String(admin._id));
      });

      await Promise.all(
        Array.from(recipients).map((userId) =>
          notifyUser(userId, "dispute_opened", payload, { actorUserId: req.user.id })
        )
      );
    } catch (err) {
      console.warn("[disputes] notify dispute opened failed", err?.message || err);
    }

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

/**
 * PATCH /api/disputes/:caseId/:disputeId/admin-notes
 * Admin-only internal notes for resolved disputes.
 * Body: { notes }
 */
router.patch(
  "/:caseId/:disputeId/admin-notes",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { caseId, disputeId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });
    if (!disputeId) return res.status(400).json({ error: "disputeId required" });

    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });

    const d = (c.disputes || []).find(
      (x) => String(x.disputeId || x._id) === String(disputeId)
    );
    if (!d) return res.status(404).json({ error: "Dispute not found" });

    const settlement = c.disputeSettlement || {};
    const action = String(settlement.action || "");
    const isFinalized =
      ["refund", "release_full", "release_partial"].includes(action) &&
      String(settlement.disputeId || "") === String(d.disputeId || d._id);
    if (!isFinalized || String(d.status || "").toLowerCase() !== "resolved") {
      return res.status(400).json({ error: "Dispute is not finalized." });
    }

    const notes = String(req.body?.notes || "").trim().slice(0, 4000);
    d.adminNotes = notes;
    d.adminNotesUpdatedAt = new Date();
    d.adminNotesUpdatedBy = req.user.id;
    await c.save();

    await AuditLog.logFromReq(req, "dispute.admin_notes.update", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { disputeId: String(disputeId) },
    });

    res.json({ ok: true, notes, updatedAt: d.adminNotesUpdatedAt });
  })
);

/**
 * POST /api/disputes/resolve/:disputeId
 * Resolve a dispute by ID without needing the caseId (admin only).
 */
router.post(
  "/resolve/:disputeId",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { disputeId } = req.params;
    if (!disputeId) return res.status(400).json({ error: "disputeId required" });

    const match = [{ "disputes.disputeId": disputeId }];
    if (isObjId(disputeId)) {
      match.push({ "disputes._id": new mongoose.Types.ObjectId(disputeId) });
    }

    const c = await Case.findOne({ $or: match });
    if (!c) return res.status(404).json({ error: "Dispute not found" });

    const d = (c.disputes || []).find(
      (x) => String(x.disputeId || x._id) === String(disputeId)
    );
    if (!d) return res.status(404).json({ error: "Dispute not found" });

    d.status = "resolved";
    if (typeof c.canTransitionTo === "function" && c.canTransitionTo("closed")) {
      c.transitionTo("closed");
    } else if (["completed", "disputed"].includes(c.status)) {
      c.status = "closed";
    }
    await c.save();

    await AuditLog.logFromReq(req, "dispute.status.update", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { disputeId: String(disputeId), status: "resolved" },
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
