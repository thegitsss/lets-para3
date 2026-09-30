const mongoose = require("mongoose");
const { Schema } = mongoose;

// The event transaction retains the recipient and exact payment reference.
// Delivery resolves current account/Matter data and never stores email content.
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  caseId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ["action", "completion"], default: "action" },
  paymentIntentId: { type: String, required() { return this.kind !== "completion"; }, match: /^pi_[A-Za-z0-9_]{1,200}$/ },
  paymentStatus: { type: String, required() { return this.kind !== "completion"; }, enum: ["requires_action", "requires_payment_method", "canceled"] },
  payoutId: { type: Schema.Types.ObjectId, required() { return this.kind === "completion"; } },
  transferId: { type: String, required() { return this.kind === "completion"; }, match: /^(?:tr_|bypass_)[A-Za-z0-9_]{1,200}$/ },
  completedAt: { type: Date, required() { return this.kind === "completion"; } },
  status: { type: String, enum: ["pending", "sending", "accepted", "failed", "unknown", "disabled", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  claim: String,
  claimedAt: Date,
  acceptedAt: Date,
  failure: { type: String, default: "" },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model("MatterPaymentNotification", schema);
