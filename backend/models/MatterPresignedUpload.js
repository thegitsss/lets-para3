const mongoose = require("mongoose"), { Schema } = mongoose;
// Issuance evidence, never proof of uploaded bytes. Keep the original owner and
// retired-key identity after the short-lived provider URL expires.
const schema = new Schema({
  caseId: { type: Schema.Types.ObjectId, required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  keyFingerprint: { type: String, required: true, select: false },
  encryptedKey: { type: String, required: true, select: false },
  bucket: { type: String, required: true, select: false },
  status: { type: String, enum: ["issued", "attached", "retired", "needs_review"], default: "issued", required: true },
  expiresAt: { type: Date, required: true },
  nextCheckAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  lastErrorCode: { type: String, default: "" },
  attachedFileId: { type: Schema.Types.ObjectId, default: null },
  attachedAt: { type: Date, default: null },
  retiredAt: { type: Date, default: null },
  retirementId: { type: Schema.Types.ObjectId, default: null },
}, { timestamps: true });
schema.index({ caseId: 1, keyFingerprint: 1 }, { unique: true });
schema.index({ status: 1, nextCheckAt: 1, expiresAt: 1, _id: 1 });
module.exports = mongoose.model("MatterPresignedUpload", schema);
