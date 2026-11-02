const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: "Case", required: true, index: true },
  assignmentKey: { type: String, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  requestId: { type: String, required: true },
  requestHash: { type: String, required: true },
  activeKey: { type: String },
  kind: { type: String, enum: ["preparation", "submission"], required: true },
  status: { type: String, enum: ["queued", "running", "complete", "failed"], default: "queued", index: true },
  stage: { type: String, enum: ["queued", "reading", "ocr", "analyzing", "complete", "failed"], default: "queued" },
  processedFiles: { type: Number, default: 0 },
  totalFiles: { type: Number, required: true },
  preparationId: { type: mongoose.Schema.Types.ObjectId, ref: "MatterPreparation" },
  errorCode: String,
  errorMessage: String,
  retryable: { type: Boolean, default: false },
  attempts: { type: Number, default: 0 },
  leaseToken: String,
  leaseUntil: Date,
  encryptedContext: { type: String, required: true, select: false },
}, { timestamps: true });
schema.index({ caseId: 1, assignmentKey: 1, createdBy: 1, requestId: 1 }, { unique: true });
schema.index({ status: 1, leaseUntil: 1 });
schema.index({ activeKey: 1 }, { unique: true, sparse: true });
module.exports = mongoose.model("MatterPreparationJob", schema);
