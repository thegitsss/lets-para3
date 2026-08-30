const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const paymentOperationSchema = new Schema(
  {
    operationKey: { type: String, required: true, unique: true, index: true, trim: true },
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true },
    kind: {
      type: String,
      enum: ["funding", "case_payout", "partial_payout", "dispute_settlement", "refund"],
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
    stripeRefundId: { type: String, default: "", trim: true, index: true },
    stripeTransferId: { type: String, default: "", trim: true, index: true },
    grossAmount: { type: Number, min: 0 },
    processingFeeAmount: { type: Number, min: 0 },
    netAmount: { type: Number, min: 0 },
    stripeMode: { type: String, enum: ["live", "test", "unknown"], default: "unknown" },
    livemode: { type: Boolean, default: null },
    evidenceVerifiedAt: { type: Date, default: null },
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
