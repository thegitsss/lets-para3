const { createLogger: createRuntimeLogger } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:disputes");
// backend/routes/disputes.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog");
const reviewNotices = require("../services/matterReviewNotifications");
const { publishCaseProjectionRefresh } = require("../utils/caseProjectionEvents");
const { publishEventSafe } = require("../services/lpcEvents/publishEventService");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const { normalizeCaseStatus } = require("../utils/caseState");

const ADMIN_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

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

const DOLLARS_RX = /[^0-9.\-]/g;
function dollarsToCents(input) {
  if (input === null || typeof input === "undefined" || input === "") return null;
  const value =
    typeof input === "number"
      ? input
      : parseFloat(String(input).replace(DOLLARS_RX, ""));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.max(0, Math.round(value * 100));
}

function parseCents(input) {
  if (input === null || typeof input === "undefined" || input === "") return null;
  const value = typeof input === "number" ? input : Number(String(input).trim());
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function buildDisputeStatusMatch(status) {
  if (!status) return null;
  if (status === "open") {
    return {
      "disputes.status": { $nin: ["resolved", "rejected"] },
    };
  }
  if (["resolved", "rejected"].includes(status)) {
    return { "disputes.status": status };
  }
  return null;
}

function normalizeDisputeShape(dispute) {
  const shaped = dispute && typeof dispute === "object" ? { ...dispute } : {};
  const normalizedStatus = String(shaped.status || "").trim().toLowerCase();
  if (!normalizedStatus) {
    shaped.status = "open";
  }
  return shaped;
}

async function publishDisputeOpened(req, updatedCase, last) {
    await publishEventSafe({
      eventType: "dispute.opened",
      eventFamily: "platform_case",
      idempotencyKey: `case:${updatedCase._id}:dispute:${last?.disputeId || String(last?._id || "")}:opened`,
      correlationId: `case:${updatedCase._id}`,
      actor: {
        actorType: req.user?.role === "admin" ? "admin" : "user",
        userId: req.user?.id || req.user?._id || null,
        role: req.user?.role || "",
        email: req.user?.email || "",
        label: req.user?.email || "User",
      },
      subject: {
        entityType: "case",
        entityId: String(updatedCase._id),
      },
      related: {
        caseId: updatedCase._id,
        userId: req.user?.id || req.user?._id || null,
      },
      source: {
        surface: req.user?.role === "admin" ? "admin" : req.user?.role || "system",
        route: `/api/disputes/${updatedCase._id}`,
        service: "disputes",
        producer: "route",
      },
      facts: {
        summary: `A dispute was opened for ${updatedCase.title || "this Matter"}.`,
        disputeId: last?.disputeId || String(last?._id || ""),
        caseTitle: updatedCase.title || "",
        after: {
          disputeId: last?.disputeId || String(last?._id || ""),
          caseTitle: updatedCase.title || "",
          message: last?.message || "",
        },
      },
      signals: {
        confidence: "high",
        priority: "urgent",
        moneyRisk: true,
        founderVisible: true,
      },
    });

    publishCaseProjectionRefresh(updatedCase, "matter_dispute_refresh", { discovery: true });

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
    const status=String(req.query.status||""), q=String(req.query.q||"").trim().slice(0,200);
    const escapedQuery=q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
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

    const andClauses = [];
    if (req.query.disputeId !== undefined) {
      if (typeof req.query.disputeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(req.query.disputeId)) return res.status(400).json({ error: "Invalid review reference." });
      andClauses.push({ $or: [{ "disputes.disputeId": req.query.disputeId }, ...(isObjId(req.query.disputeId) ? [{ "disputes._id": new mongoose.Types.ObjectId(req.query.disputeId) }] : [])] });
    }
    if (req.query.caseId !== undefined && !isObjId(req.query.caseId)) return res.status(400).json({ error: "Invalid Matter reference." });
    if(req.query.caseId && isObjId(req.query.caseId))andClauses.push({_id:new mongoose.Types.ObjectId(req.query.caseId)});
    const statusMatch = buildDisputeStatusMatch(status);
    if (statusMatch) {
      andClauses.push(statusMatch);
    }
    if (q.trim()) {
      andClauses.push({
        $or: [
        { "disputes.message": { $regex: escapedQuery, $options: "i" } },
        { title: { $regex: escapedQuery, $options: "i" } },
        ],
      });
    }
    if (finalized) {
      const settlementMatch = {
        "disputeSettlement.action": { $in: ["refund", "release_full", "release_partial"] },
        $expr: { $eq: ["$disputeSettlement.disputeId", "$disputes.disputeId"] },
      };
      const withdrawalMatch = {
        payoutFinalizedAt: { $ne: null },
        payoutFinalizedType: { $ne: null },
        "disputes.status": "resolved",
      };
      andClauses.push({ $or: [settlementMatch, withdrawalMatch] });
    }

    if (andClauses.length === 1) {
      basePipeline.push({ $match: andClauses[0] });
    } else if (andClauses.length > 1) {
      basePipeline.push({ $match: { $and: andClauses } });
    }

    const dataPipeline = basePipeline.concat([
      { $sort: { "disputes.createdAt": 1, _id:1, "disputes.disputeId":1 } },
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
          activeParalegalId: "$paralegal",
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
          tasksTotal: { $size: { $ifNull: ["$tasks", []] } },
          tasksCompleted: {
            $size: {
              $filter: {
                input: { $ifNull: ["$tasks", []] },
                as: "task",
                cond: { $eq: ["$$task.completed", true] },
              },
            },
          },
        },
      }
    ]);

    const countPipeline = basePipeline.concat([{ $count: "n" }]);

    const [items, count] = await Promise.all([
      Case.aggregate(dataPipeline),
      Case.aggregate(countPipeline),
    ]);

    const total = count[0]?.n || 0;
    const normalizedItems = items.map((item) => ({
      ...item,
      dispute: normalizeDisputeShape(item?.dispute),
    }));
    res.json({ page, limit, total, pages: Math.ceil(total / limit), items: normalizedItems });
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

const attorneyDisputes = require("../services/attorneyDisputes");
router.get("/:caseId/attorney-review", requireRole("attorney"), asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try { res.json(await attorneyDisputes.read(req)); } catch (error) { attorneyDisputes.sendError(res, error); }
}));
router.post("/:caseId/attorney-action", requireRole("attorney"), csrfProtection, asyncHandler(async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const result = await attorneyDisputes.save(req);
    for (const dispatch of result.dispatches || []) await dispatch();
    if (result.changed) {
      if (result.action === "open") await publishDisputeOpened(req, result.doc, (result.doc.disputes || []).find(value => String(value.disputeId || value._id) === result.disputeId));
      else publishCaseProjectionRefresh(result.doc, "matter_dispute_comment_refresh");
    }
    await attorneyDisputes.actor(req);
    res.json({ caseId: req.params.caseId, ownerId: req.body.expectedOwnerId, operation: result.operation });
  } catch (error) { attorneyDisputes.sendError(res, error); }
}));

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
    if (!c) return res.status(404).json({ error: "Matter not found" });

    const isAdmin = String(req.user?.role || "").toLowerCase() === "admin";
    const currentId = value => String(value?._id || value || ""), viewer = String(req.user.id);
    const isOwner = [c.attorney, c.attorneyId].some(value => currentId(value) === viewer);
    const isAssigned = !c.paralegalAccessRevokedAt && [c.paralegal, c.paralegalId].some(value => currentId(value) === viewer);
    const isWithdrawn = currentId(c.withdrawnParalegalId) === viewer;
    if (!isAdmin && !isOwner && !isAssigned && !isWithdrawn) return res.status(403).json({ error: "This dispute record is not available to your account." });
    res.set("Cache-Control", "private, no-store");
    const disputes = (c.disputes || []).map((d) => {
      const shaped = {
        ...normalizeDisputeShape(d),
        id: d.disputeId || String(d._id),
      };
      if (isAdmin) return shaped;
      const publicRecord = Object.fromEntries(["_id", "id", "disputeId", "message", "amountRequestedCents", "raisedBy", "status", "createdAt", "updatedAt"].filter(key => shaped[key] !== undefined).map(key => [key, shaped[key]]));
      publicRecord.comments = (Array.isArray(shaped.comments) ? shaped.comments : []).map(comment => Object.fromEntries(["_id", "by", "text", "createdAt", "updatedAt"].filter(key => comment?.[key] !== undefined).map(key => [key, comment[key]])));
      return publicRecord;
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
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const { message, amount, amountCents } = req.body || {};
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });
    if (!message || !String(message).trim()) return res.status(400).json({ error: "message required" });

    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Matter not found" });

    const caseStatus = normalizeCaseStatus(c.status);
    if (!["in progress", "paused", "completed"].includes(caseStatus)) {
      return res.status(409).json({ error: "A dispute can only be opened for funded work." });
    }
    if (!c.escrowIntentId || String(c.escrowStatus || "").toLowerCase() !== "funded") {
      return res.status(409).json({ error: "A dispute can only be opened for funded work." });
    }
    if ((c.disputes || []).some((dispute) => String(dispute?.status || "open").toLowerCase() === "open")) {
      return res.status(409).json({ error: "An open dispute already exists for this matter." });
    }

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
      String(c.attorneyId) === String(req.user.id) ||
      (c.paralegal && String(c.paralegal) === String(req.user.id)) ||
      (c.paralegalId && String(c.paralegalId) === String(req.user.id)) ||
      req.user.role === "admin";
    if (isWithdrawnParalegal && hasWithdrawalWindow) {
      isParty = true;
    }
    if (c.pausedReason === "paralegal_withdrew" && c.disputeDeadlineAt && !hasWithdrawalWindow) {
      return res.status(400).json({ error: "The request window has expired." });
    }
    if (!isParty) return res.status(403).json({ error: "Not authorized to dispute this Matter" });

    const requestedCents =
      typeof amountCents !== "undefined" ? parseCents(amountCents) : dollarsToCents(amount);
    if (typeof amountCents !== "undefined" && requestedCents === null) {
      return res.status(400).json({ error: "amountCents must be a non-negative integer." });
    }
    const availableCents = Number(c.remainingAmount ?? c.lockedTotalAmount ?? c.totalAmount ?? 0);
    if (requestedCents != null && requestedCents > availableCents) {
      return res.status(400).json({ error: "Requested amount exceeds the funded matter balance." });
    }

    const disputeId = new mongoose.Types.ObjectId().toString();
    const dispute = {
      disputeId,
      message: String(message).trim(),
      raisedBy: req.user.id,
      status: "open",
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    if (requestedCents != null) dispute.amountRequestedCents = requestedCents;
    const participantClause = req.user.role === "admin"
      ? {}
      : hasWithdrawalWindow && isWithdrawnParalegal
        ? {
            withdrawnParalegalId: req.user.id,
            pausedReason: "paralegal_withdrew",
            payoutFinalizedAt: null,
            disputeDeadlineAt: { $gte: now },
          }
        : {
            $or: [
              { attorney: req.user.id },
              { attorneyId: req.user.id },
              { paralegal: req.user.id },
              { paralegalId: req.user.id },
            ],
          };
    const session = await mongoose.startSession();
    let updatedCase, last, dispatches = [];
    try {
      await session.withTransaction(async () => {
        updatedCase = await Case.findOneAndUpdate(
            {
              _id: caseId,
              status: { $in: ["in progress", "in_progress", "paused", "completed"] },
              escrowIntentId: { $nin: [null, ""] },
              escrowStatus: "funded",
              completionClaimStatus: { $nin: ["claimed", "needs_reconciliation"] },
              withdrawalClaimStatus: { $nin: ["claimed", "needs_reconciliation"] },
              withdrawalClaimToken: { $in: [null, ""] },
              disputes: { $not: { $elemMatch: { status: "open" } } },
              ...participantClause,
            },
            {
              $push: { disputes: dispute },
              $set: {
                status: "disputed",
                pausedReason: "dispute",
                disputeDeadlineAt: null,
                adminDisputeDeadlineAt: new Date(now.getTime() + ADMIN_REVIEW_WINDOW_MS),
                adminDisputeOverdueNotifiedAt: null,
              },
            },
            { returnDocument: "after", runValidators: true, session }
          );
          if (!updatedCase) throw Object.assign(new Error("The Matter changed before the review could be opened. Refresh and check its review record."), { status: 409, code: "DISPUTE_CONFLICT" });
          last = updatedCase.disputes.find((entry) => String(entry.disputeId) === disputeId);

          await AuditLog.logFromReq(req, "dispute.create", {
            session,
            targetType: "case",
            targetId: updatedCase._id,
            caseId: updatedCase._id,
            meta: { disputeId: last?.disputeId || String(last?._id) },
          });

          dispatches = await reviewNotices.stageOpening(updatedCase, last, session, req.user.id);
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 10000 });
    } catch (error) {
      if (error.code === "DISPUTE_CONFLICT") return res.status(409).json({ error: error.message, code: error.code });
      throw error;
    } finally { await session.endSession(); }
    for (const dispatch of dispatches) await dispatch();

    await publishDisputeOpened(req, updatedCase, last);

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
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId, disputeId } = req.params;
    const { text } = req.body || {};
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text required" });

    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Matter not found" });

    const d = (c.disputes || []).find(
      (x) => String(x.disputeId || x._id) === String(disputeId)
    );
    if (!d) return res.status(404).json({ error: "Dispute not found" });

    // Only parties or admin may comment
    const isParty =
      String(c.attorney) === String(req.user.id) ||
      String(c.attorneyId) === String(req.user.id) ||
      (c.paralegal && String(c.paralegal) === String(req.user.id)) ||
      (c.paralegalId && String(c.paralegalId) === String(req.user.id)) ||
      (c.withdrawnParalegalId && String(c.withdrawnParalegalId) === String(req.user.id)) ||
      req.user.role === "admin";
    if (!isParty) return res.status(403).json({ error: "Not authorized" });

    const comment = { by: req.user.id, text: String(text).trim(), createdAt: new Date() };
    const result = await Case.updateOne(
      {
        _id: caseId,
        disputes: { $elemMatch: { disputeId: String(d.disputeId || disputeId) } },
      },
      { $push: { "disputes.$.comments": comment } }
    );
    if (!result.modifiedCount) {
      return res.status(409).json({
        error: "The dispute changed before the comment was saved. Refresh and try again.",
        code: "DISPUTE_CONFLICT",
      });
    }

    await AuditLog.logFromReq(req, "dispute.comment.add", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { disputeId },
    });

    publishCaseProjectionRefresh(c, "matter_dispute_comment_refresh");

    res.status(201).json({ ok: true });
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
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId, disputeId } = req.params;
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });
    if (!disputeId) return res.status(400).json({ error: "disputeId required" });

    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Matter not found" });

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
    const updatedAt = new Date();
    const result = await Case.updateOne(
      {
        _id: caseId,
        "disputeSettlement.action": { $in: ["refund", "release_full", "release_partial"] },
        "disputeSettlement.disputeId": String(d.disputeId || d._id),
        disputes: {
          $elemMatch: {
            disputeId: String(d.disputeId || disputeId),
            status: "resolved",
          },
        },
      },
      {
        $set: {
          "disputes.$.adminNotes": notes,
          "disputes.$.adminNotesUpdatedAt": updatedAt,
          "disputes.$.adminNotesUpdatedBy": req.user.id,
        },
      }
    );
    if (!result.matchedCount) {
      return res.status(409).json({
        error: "The finalized dispute changed before notes were saved. Refresh and try again.",
        code: "DISPUTE_CONFLICT",
      });
    }

    await AuditLog.logFromReq(req, "dispute.admin_notes.update", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { disputeId: String(disputeId) },
    });

    res.json({ ok: true, notes, updatedAt });
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, req, res, _next) => {
  if (respondToCsrfError(err, res)) return;
  runtimeLogger.error(err);
  res.status(500).json({ error: ["GET", "HEAD"].includes(req.method)
    ? "Dispute details could not be loaded. Refresh to check again."
    : "The dispute change could not be confirmed. Refresh and check its saved status before trying again." });
});

module.exports = router;
