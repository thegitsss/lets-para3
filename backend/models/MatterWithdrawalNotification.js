const mongoose = require("mongoose");
const { Schema } = mongoose;

// Retained in the withdrawal transaction. The worker resolves the current
// recipient and Matter; private content and email addresses are not stored.
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  attorneyId: { type: Schema.Types.ObjectId, required: true },
  paralegalId: { type: Schema.Types.ObjectId, required: true },
  caseId: { type: Schema.Types.ObjectId, required: true },
  withdrawnAt: { type: Date, required: true },
  kind: { type: String, enum: ["request", "partial", "reject", "relist", "expired"], default: "request" },
  eventAt: Date,
  outcome: { type: String, enum: ["zero_auto", "awaiting_attorney_decision", "review_window", "partial_recorded", "zero_recorded", "relisted", "expired_zero"], required: true },
  status: { type: String, enum: ["pending", "sending", "accepted", "failed", "unknown", "disabled", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  claim: String,
  claimedAt: Date,
  acceptedAt: Date,
  failure: { type: String, default: "" },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model("MatterWithdrawalNotification", schema);
