const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  releaseKey: {type:String, default:"signup-signin-20261023", index:true},
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  emailHash: { type: String, required: true },
  status: { type: String, enum: ["pending", "sending", "accepted", "failed", "unknown", "disabled", "skipped"], default: "pending" },
  attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
  claim: String, claimedAt: Date, acceptedAt: Date, failure: { type: String, default: "" },
}, { timestamps: true });
schema.index({ userId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model("SignupReviewNotification", schema);
