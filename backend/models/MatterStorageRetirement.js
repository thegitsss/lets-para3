const mongoose = require("mongoose");
const { Schema } = mongoose;
// A permanent retired-key boundary. Do not apply the personal-file cleanup TTL:
// dropping this record could let an earlier Matter upload reattach deleted data.
const schema = new Schema({
  caseId: { type: Schema.Types.ObjectId, required: true, index: true },
  keyFingerprint: { type: String, required: true, select: false },
  encryptedKey: { type: String, required: true, select: false },
  bucket: { type: String, required: true, select: false },
  reason: { type: String, enum: ["document_removed", "preview_replaced", "upload_attempt", "unattached_upload"], required: true },
  uploadId: { type: Schema.Types.ObjectId, default: null },
  attemptToken: { type: String, default: "", select: false },
  putOutcome: { type: String, enum: ["uploaded", "unconfirmed"], required: true },
  status: { type: String, enum: ["pending", "processing", "retained", "unconfirmed", "deleted", "needs_review"], required: true, default: "pending" },
  nextCheckAt: { type: Date, required: true },
  leaseUntil: { type: Date, default: null },
  claimToken: { type: String, default: "", select: false },
  attempts: { type: Number, default: 0 },
  lastErrorCode: { type: String, default: "" },
  deletedAt: { type: Date, default: null },
  retainedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ caseId: 1, keyFingerprint: 1 }, { unique: true });
schema.index({ status: 1, nextCheckAt: 1, leaseUntil: 1 });
module.exports = mongoose.model("MatterStorageRetirement", schema);
