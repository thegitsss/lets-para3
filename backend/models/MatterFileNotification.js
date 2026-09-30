const mongoose = require("mongoose");
const { Schema } = mongoose;

// One email obligation per committed upload, keyed by its retained operation ID.
// Keep only references here; names and document content remain in their existing
// protected records and are re-authorized when the worker prepares the email.
const schema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true },
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  actorUserId: { type: Schema.Types.ObjectId, required: true },
  caseId: { type: Schema.Types.ObjectId, required: true },
  fileId: { type: Schema.Types.ObjectId, required: true },
  fileVersion: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ["pending", "sending", "accepted", "failed", "unknown", "disabled", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  claim: String,
  claimedAt: Date,
  acceptedAt: Date,
  failure: { type: String, default: "" },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model("MatterFileNotification", schema);
