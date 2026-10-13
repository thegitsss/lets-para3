const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const blockSchema = new Schema({
  blockerId: {
    type: Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  blockedId: {
    type: Types.ObjectId,
    ref: "User",
    required: true,
    index: true,
  },
  blockerRole: {
    type: String,
    enum: ["attorney", "paralegal", "admin", ""],
    default: "",
  },
  blockedRole: {
    type: String,
    enum: ["attorney", "paralegal", "admin", ""],
    default: "",
  },
  sourceCaseId: {
    type: Types.ObjectId,
    ref: "Case",
    default: null,
    index: true,
  },
  sourceDisputeId: { type: String, trim: true, default: "" },
  sourceType: {
    type: String,
    enum: ["resolved_dispute", "withdrawal_zero_payout", "withdrawal_partial_payout", "closed_case", "application_screening", "legacy", ""],
    default: "legacy",
    index: true,
  },
  reason: { type: String, trim: true, maxlength: 2000, default: "" },
  active: { type: Boolean, default: true, index: true },
  createdAt: { type: Date, default: Date.now },
  deactivatedAt: { type: Date, default: null },
}, {
  timestamps: { createdAt: false, updatedAt: true },
});

blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });

module.exports = mongoose.model("Block", blockSchema);
