const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const paymentOperationSchema = new Schema(
  {
    operationKey: { type: String, required: true, unique: true, index: true, trim: true },
    caseId: {
      type: Types.ObjectId,
      ref: "Case",
      required() { return this.kind !== "chargeback"; },
      index: true,
    },
    kind: {
      type: String,
      enum: ["funding", "chargeback", "case_payout", "partial_payout", "dispute_settlement", "refund"],
      required: true,
      index: true,
    },
    fingerprint: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "succeeded", "failed", "needs_reconciliation"],
      default: "pending",
      index: true,
    },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "usd", lowercase: true, trim: true },
    stripeObjectId: { type: String, default: "", trim: true, index: true },
    stripePaymentIntentId: { type: String, trim: true },
    stripeChargeId: { type: String, trim: true },
    stripeBalanceTransactionId: { type: String, trim: true },
    stripeDisputeId: { type: String, trim: true },
    stripeEventId: { type: String, trim: true },
    stripeRefundId: { type: String, default: "", trim: true, index: true },
    stripeTransferId: { type: String, default: "", trim: true, index: true },
    grossAmount: { type: Number, min: 0 },
    processingFeeAmount: { type: Number, min: 0 },
    netAmount: { type: Number, min: 0 },
    stripeMode: { type: String, enum: ["live", "test", "unknown"], default: "unknown" },
    livemode: { type: Boolean, default: null },
    evidenceVerifiedAt: { type: Date, default: null },
    processorStatus: {
      type: String,
      enum: [
        "warning_needs_response",
        "warning_under_review",
        "warning_closed",
        "needs_response",
        "under_review",
        "won",
        "lost",
        "unknown",
        null,
      ],
      default: null,
    },
    processorEventCreatedAt: { type: Date, default: null },
    administrativeStatus: {
      type: String,
      enum: ["pending_review", "acknowledged", "hold_cleared", null],
      default: null,
    },
    payoutPosition: {
      type: String,
      enum: ["pre_payout", "post_payout", "unknown", null],
      default: null,
    },
    evidenceStatus: {
      type: String,
      enum: ["verified", "needs_reconciliation", "quarantined", null],
      default: null,
    },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: Types.ObjectId, ref: "User", default: null },
    payoutHoldClearedAt: { type: Date, default: null },
    payoutHoldClearedBy: { type: Types.ObjectId, ref: "User", default: null },
    refundAmount: { type: Number, default: 0, min: 0 },
    transferAmount: { type: Number, default: 0, min: 0 },
    attempts: { type: Number, default: 1, min: 1 },
    lastAttemptAt: { type: Date, default: Date.now },
    lastError: { type: String, default: "", trim: true, maxlength: 2000 },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

paymentOperationSchema.index({ caseId: 1, kind: 1, status: 1 });

module.exports = mongoose.model("PaymentOperation", paymentOperationSchema);
