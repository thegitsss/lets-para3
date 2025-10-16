// backend/routes/payments.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireRole, requireCaseAccess } = require("../utils/authz");
const stripe = require("../utils/stripe");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog"); // ensure file name matches your model

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);

// All routes require auth
router.use(verifyToken);

/**
 * PATCH /api/payments/:caseId/budget
 * Update case budget before funding escrow.
 * Body: { amountUsd, currency }
 * Attorney-owner or admin only.
 */
router.patch(
  "/:caseId/budget",
  requireRole("attorney", "admin"),
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const { amountUsd, currency } = req.body || {};
    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ msg: "Case not found" });

    // Only owner-attorney or admin
    if (String(c.attorney) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ msg: "Only the case attorney or admin can update budget" });
    }

    const cents = Math.round(Number(amountUsd || 0) * 100);
    if (!Number.isFinite(cents) || cents < 50) {
      return res.status(400).json({ msg: "Amount must be at least $0.50" });
    }

    c.totalAmount = cents;
    if (currency) c.currency = String(currency).toLowerCase();
    c.snapshotFees?.(); // compute fee snapshots if method exists
    await c.save();

    await AuditLog.logFromReq(req, "payment.budget.update", {
      targetType: "case",
      targetId: c._id,
      caseId: c._id,
      meta: { totalAmount: c.totalAmount, currency: c.currency },
    });

    res.json({ ok: true, msg: "Budget saved", totalAmount: c.totalAmount, currency: c.currency });
  })
);

/**
 * POST /api/payments/intent/:caseId
 * Creates (or reuses) a PaymentIntent to fund escrow for this case.
 * Attorney (owner) or admin only.
 * Optional header: x-idempotency-key
 */
router.post(
  "/intent/:caseId",
  requireRole("attorney", "admin"),
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const { caseId } = req.params;
    const idem = req.headers["x-idempotency-key"];
    const c = await Case.findById(caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });

    // Only the attorney who owns the case (or admin) can fund escrow
    if (String(c.attorney) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can fund escrow" });
    }

    if (!c.totalAmount || c.totalAmount < 50) {
      return res.status(400).json({ error: "totalAmount (>= $0.50) required on case" });
    }

    const transferGroup = `case_${c._id.toString()}`;

    // Reuse existing PI if active
    if (c.escrowIntentId) {
      const existing = await stripe.paymentIntents.retrieve(c.escrowIntentId);
      if (existing && !["succeeded", "canceled"].includes(existing.status)) {
        let pi = existing;

        // Allowed updates only before confirmation
        const canUpdate = ["requires_payment_method", "requires_confirmation"].includes(pi.status);
        const needsTG = !pi.transfer_group || pi.transfer_group !== transferGroup;
        const needsAmt = canUpdate && pi.amount !== c.totalAmount;

        if (canUpdate && (needsTG || needsAmt)) {
          pi = await stripe.paymentIntents.update(pi.id, {
            ...(needsTG ? { transfer_group: transferGroup } : {}),
            ...(needsAmt ? { amount: c.totalAmount } : {}),
            metadata: {
              caseId: c._id.toString(),
              attorneyId: c.attorney?.toString() || "",
              paralegalId: c.paralegal?.toString() || "",
            },
          });
        }

        await AuditLog.logFromReq(req, "payment.intent.reuse", {
          targetType: "payment",
          targetId: pi.id,
          caseId: c._id,
          meta: { amount: c.totalAmount, currency: c.currency || "usd", status: pi.status },
        });

        return res.json({ clientSecret: pi.client_secret, intentId: pi.id });
      }
    }

    // Create a new PaymentIntent
    const params = {
      amount: c.totalAmount,
      currency: c.currency || "usd",
      automatic_payment_methods: { enabled: true },
      transfer_group: transferGroup,
      metadata: {
        caseId: c._id.toString(),
        attorneyId: c.attorney?.toString() || "",
        paralegalId: c.paralegal?.toString() || "",
      },
    };

    const intent = await stripe.paymentIntents.create(
      params,
      idem ? { idempotencyKey: idem } : undefined
    );

    c.escrowIntentId = intent.id;
    await c.save();

    await AuditLog.logFromReq(req, "payment.intent.create", {
      targetType: "payment",
      targetId: intent.id,
      caseId: c._id,
      meta: { amount: c.totalAmount, currency: c.currency || "usd" },
    });

    res.json({ clientSecret: intent.client_secret, intentId: intent.id });
  })
);

/**
 * POST /api/payments/release/:caseId
 * Marks funds as released (accounting snapshot). To actually move money to a paralegal,
 * use /api/payments/payout/:caseId (Stripe Connect transfer).
 */
router.post(
  "/release/:caseId",
  requireRole("attorney", "admin"),
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const c = await Case.findById(req.params.caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });

    if (String(c.attorney) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the attorney can release funds" });
    }
    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });

    const pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
    if (pi.status !== "succeeded") return res.status(400).json({ error: "Escrow not captured yet" });

    // Snapshot fee math using helper if present
    c.snapshotFees?.();
    if (!c.feeAttorneyAmount || !c.feeParalegalAmount) {
      // Fallback if model hasn't computed yet
      const feeA = Math.round((c.totalAmount * (c.feeAttorneyPct || 15)) / 100);
      const feeP = Math.round((c.totalAmount * (c.feeParalegalPct || 15)) / 100);
      c.feeAttorneyAmount = feeA;
      c.feeParalegalAmount = feeP;
    }
    const payout = Math.max(0, c.totalAmount - c.feeAttorneyAmount - c.feeParalegalAmount);

    c.paymentReleased = true;
    if (typeof c.canTransitionTo === "function" && c.canTransitionTo("closed") && c.status === "completed") {
      c.transitionTo?.("closed");
    } else if (c.status === "completed") {
      c.status = "closed";
    }
    await c.save();

    await AuditLog.logFromReq(req, "payment.release", {
      targetType: "payment",
      targetId: c.escrowIntentId,
      caseId: c._id,
      meta: { payout, feeA: c.feeAttorneyAmount, feeP: c.feeParalegalAmount },
    });

    res.json({ ok: true, msg: "Funds marked released", payout, feeA: c.feeAttorneyAmount, feeP: c.feeParalegalAmount });
  })
);

/**
 * POST /api/payments/payout/:caseId
 * (Optional) Create a Stripe Connect transfer to the paralegal's connected account.
 * Requires: case has paralegal with `stripeAccountId`, PI succeeded, and funds marked released.
 */
router.post(
  "/payout/:caseId",
  requireRole("admin"), // keep admin-only initially; relax to attorney when you're confident
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const c = await Case.findById(req.params.caseId).populate("paralegal", "stripeAccountId name email");
    if (!c) return res.status(404).json({ error: "Case not found" });
    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });

    const pi = await stripe.paymentIntents.retrieve(c.escrowIntentId);
    if (pi.status !== "succeeded") return res.status(400).json({ error: "Escrow not captured yet" });

    if (!c.paralegal || !c.paralegal.stripeAccountId) {
      return res.status(400).json({ error: "Paralegal not onboarded for payouts" });
    }

    // Ensure fees are computed
    c.snapshotFees?.();
    const feeA = c.feeAttorneyAmount ?? Math.round((c.totalAmount * (c.feeAttorneyPct || 15)) / 100);
    const feeP = c.feeParalegalAmount ?? Math.round((c.totalAmount * (c.feeParalegalPct || 15)) / 100);
    const payout = Math.max(0, c.totalAmount - feeA - feeP);

    const transferGroup = `case_${c._id.toString()}`;
    const transfer = await stripe.transfers.create({
      amount: payout,
      currency: c.currency || "usd",
      destination: c.paralegal.stripeAccountId,
      transfer_group: transferGroup,
      metadata: { caseId: c._id.toString(), paralegalId: c.paralegal._id.toString() },
    });

    c.payoutTransferId = transfer.id;
    c.paidOutAt = new Date();
    await c.save();

    await AuditLog.logFromReq(req, "payment.payout.transfer", {
      targetType: "payment",
      targetId: transfer.id,
      caseId: c._id,
      meta: { payout, feeA, feeP, destination: c.paralegal.stripeAccountId },
    });

    res.json({ ok: true, msg: "Payout transfer created", transferId: transfer.id, payout });
  })
);

/**
 * POST /api/payments/refund/:caseId
 * Issues a full refund (admin only).
 */
router.post(
  "/refund/:caseId",
  requireRole("admin"),
  requireCaseAccess("caseId"),
  asyncHandler(async (req, res) => {
    const c = await Case.findById(req.params.caseId);
    if (!c) return res.status(404).json({ error: "Case not found" });
    if (!c.escrowIntentId) return res.status(400).json({ error: "No funded escrow" });

    const refund = await stripe.refunds.create({ payment_intent: c.escrowIntentId });

    c.paymentReleased = false;
    if (typeof c.canTransitionTo === "function" && c.canTransitionTo("closed")) {
      c.transitionTo?.("closed");
    } else {
      c.status = "closed";
    }
    await c.save();

    await AuditLog.logFromReq(req, "payment.refund", {
      targetType: "payment",
      targetId: c.escrowIntentId,
      caseId: c._id,
      meta: { refundId: refund.id },
    });

    res.json({ ok: true, msg: "Refund issued", refundId: refund.id });
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
