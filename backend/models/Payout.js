const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const payoutSchema = new Schema(
  {
    paralegalId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true },
    operationKey: { type: String, trim: true },
    amountPaid: { type: Number, required: true, min: 0 },
    transferId: { type: String, required: true, trim: true },
    stripeMode: { type: String, enum: ["live", "test", "unknown"], default: "unknown", index: true },
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "reversed", "needs_reconciliation"],
      default: "paid",
      index: true,
    },
    failureReason: { type: String, default: "", trim: true, maxlength: 500 },
    reversedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

payoutSchema.index({ operationKey: 1 }, { unique: true, sparse: true });
payoutSchema.index({ caseId: 1, paralegalId: 1, createdAt: -1 });
payoutSchema.index({ transferId: 1 }, { unique: true });

module.exports = mongoose.model("Payout", payoutSchema);
