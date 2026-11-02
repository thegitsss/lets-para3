const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: "Case", required: true, index: true },
  assignmentKey: { type: String, required: true, index: true },
  requestId: { type: String, required: true },
  requestHash: { type: String, required: true },
  kind: { type: String, enum: ["preparation", "submission"], required: true },
  status: { type: String, enum: ["proposed", "accepted"], default: "proposed" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  acceptedAt: Date,
  encryptedPayload: { type: String, required: true, select: false },
}, { timestamps: true, optimisticConcurrency: true });
schema.index({ caseId: 1, assignmentKey: 1, requestId: 1 }, { unique: true });
module.exports = mongoose.model("MatterPreparation", schema);
