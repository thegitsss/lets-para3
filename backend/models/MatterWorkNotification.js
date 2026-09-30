const mongoose = require("mongoose");
const { Schema } = mongoose;

// Saved with the assignment/funding transition. Resolve current content and
// access at delivery time; never retain a recipient address or Matter title.
const schema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  attorneyId: { type: Schema.Types.ObjectId, required: true },
  caseId: { type: Schema.Types.ObjectId, required: true },
  hiredAt: { type: Date, required: true },
  status: { type: String, enum: ["pending", "sending", "accepted", "failed", "unknown", "disabled", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  claim: String,
  claimedAt: Date,
  acceptedAt: Date,
  failure: { type: String, default: "" },
}, { timestamps: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model("MatterWorkNotification", schema);
