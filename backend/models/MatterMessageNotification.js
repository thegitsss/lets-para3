const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  messageId: { type: mongoose.Schema.Types.ObjectId, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, required: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ["pending", "sending", "accepted", "failed", "unknown", "disabled", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
  claim: String, claimedAt: Date, acceptedAt: Date, failure: { type: String, default: "" },
}, { timestamps: true });
schema.index({ messageId: 1, userId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model("MatterMessageNotification", schema);
