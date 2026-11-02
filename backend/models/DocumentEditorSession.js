const mongoose = require("mongoose");
const { Schema } = mongoose;

// Coordination metadata only. Document bytes and recoverable originals remain
// in the existing CaseFile / MatterFileUpload / S3 authorities.
const participant = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true },
  role: { type: String, enum: ["attorney", "paralegal"], required: true },
  authVersion: { type: Number, required: true },
  encryptedAuthSessionId: { type: String, default: "" },
}, { _id: false });
const schema = new Schema({
  caseId: { type: Schema.Types.ObjectId, required: true, index: true },
  fileId: { type: Schema.Types.ObjectId, required: true, index: true },
  activeKey: { type: String },
  documentKey: { type: String, required: true, unique: true },
  encryptedSourceKey: { type: String, required: true, select: false },
  sourceETag: { type: String, required: true, select: false },
  sourceObjectVersion: { type: String, default: "", select: false },
  sourceVersion: { type: Number, required: true },
  sourceFingerprint: { type: String, required: true },
  currentFileFingerprint: { type: String, required: true },
  savedVersion: { type: Number, required: true },
  participants: { type: [participant], default: [], select: false },
  state: { type: String, enum: ["open", "saving", "closed", "needs_review"], default: "open" },
  expiresAt: { type: Date, required: true },
  leaseToken: { type: String, default: "", select: false },
  leaseUntil: { type: Date, default: null },
  lastCallbackDigest: { type: String, default: "", select: false },
  lastSavedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: "" },
}, { timestamps: true });
schema.index({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: "string" } } });
module.exports = mongoose.model("DocumentEditorSession", schema);
