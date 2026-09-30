const mongoose = require("mongoose");
const { Schema } = mongoose;

// Retained with review opening, settlement or the overdue-reminder claim. The worker resolves the current
// recipient and Matter; private content and email addresses are not stored.
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  userRole: { type: String, enum: ["attorney", "paralegal", "admin"], required: true },
  caseId: { type: Schema.Types.ObjectId, required: true },
  disputeId: { type: String, required: true },
  kind: { type: String, enum: ["opened", "resolved", "overdue"], default: "opened" },
  openedAt: { type: Date, required: function () { return this.kind !== "resolved"; } },
  reviewContext: { type: String, enum: ["termination"] },
  terminationRequestedAt: { type: Date, required: function () { return this.reviewContext === "termination"; } },
  accessRevokedAt: { type: Date, required: function () { return this.reviewContext === "termination"; } },
  deadlineAt: { type: Date, required: function () { return this.kind === "overdue"; } },
  remindedAt: { type: Date, required: function () { return this.kind === "overdue"; } },
  resolvedAt: { type: Date, required: function () { return this.kind === "resolved"; } },
  action: { type: String, enum: ["refund", "release_full", "release_partial"], required: function () { return this.kind === "resolved"; } },
  operationId: { type: Schema.Types.ObjectId, required: function () { return this.kind === "resolved"; } },
  status: { type: String, enum: ["pending", "sending", "accepted", "failed", "unknown", "disabled", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  claim: String,
  claimedAt: Date,
  acceptedAt: Date,
  failure: { type: String, default: "" },
}, { timestamps: true });
schema.index({ caseId: 1, disputeId: 1, userId: 1, kind: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model("MatterReviewNotification", schema);
