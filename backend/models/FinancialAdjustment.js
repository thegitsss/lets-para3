const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

function rejectMutation() {
  throw new Error("Financial adjustments are immutable.");
}

const financialAdjustmentSchema = new Schema(
  {
    idempotencyKey: { type: String, required: true, unique: true, trim: true },
    paymentOperationId: { type: Types.ObjectId, ref: "PaymentOperation", required: true, index: true },
    caseId: { type: Types.ObjectId, ref: "Case", default: null, index: true },
    platformIncomeId: { type: Types.ObjectId, ref: "PlatformIncome", default: null, index: true },
    adjustmentType: {
      type: String,
      enum: [
        "chargeback_principal",
        "processor_dispute_fee",
        "chargeback_recovery",
        "processor_fee_recovery",
        "related_processor_adjustment",
      ],
      required: true,
    },
    direction: { type: String, enum: ["debit", "credit"], required: true },
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: "Adjustment amount must be integer cents." },
    },
    currency: { type: String, required: true, lowercase: true, trim: true },
    stripeDisputeId: { type: String, required: true, trim: true },
    stripeChargeId: { type: String, default: "", trim: true },
    stripeBalanceTransactionId: { type: String, required: true, trim: true },
    stripeEventId: { type: String, required: true, trim: true },
    stripeMode: { type: String, enum: ["live", "test", "unknown"], default: "unknown" },
    stripeEvidenceCreatedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  }
);

financialAdjustmentSchema.pre("save", function preserveAppendOnly() {
  if (!this.isNew) rejectMutation();
});
for (const hook of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  financialAdjustmentSchema.pre(hook, rejectMutation);
}

module.exports = mongoose.model("FinancialAdjustment", financialAdjustmentSchema);
