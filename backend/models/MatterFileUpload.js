const mongoose = require("mongoose");
const { Schema } = mongoose;
// Retained upload evidence binds an explicit retry to the exact original bytes.
// Filenames, file contents and storage credentials do not belong in this record.
const schema = new Schema({
  caseId: { type: Schema.Types.ObjectId, required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  fingerprint: { type: String, required: true, select: false },
  fileId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ["upload", "replacement"], default: "upload" },
  retiredPreviewKey: { type: String, select: false, default: "" },
  status: { type: String, enum: ["uploading", "failed", "unconfirmed", "recorded"], required: true },
  claimToken: { type: String, required: true, select: false },
  leaseUntil: { type: Date, required: true },
  // Each attempt has its own object. A late provider response cannot overwrite
  // a newer attempt. Retain these identifiers for storage reconciliation.
  attempts: [{ _id: false, token: String, extension: String, startedAt: Date, putOutcome: { type: String, enum: ["uploaded", "unconfirmed"] }, settledAt: Date }],
  retirementComplete: { type: Boolean, default: false },
  retirementCheckedAt: Date,
  recordedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ caseId: 1, ownerId: 1, requestId: 1 }, { unique: true });
module.exports = mongoose.model("MatterFileUpload", schema);
