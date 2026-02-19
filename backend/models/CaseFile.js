const mongoose = require("mongoose");
const { encryptCaseFileFields } = require("../utils/dataEncryption");
const { Schema, Types } = mongoose;

const caseFileSchema = new Schema(
  {
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    originalName: { type: String, required: true, trim: true, maxlength: 2048 },
    originalNameHash: { type: String, trim: true, index: true, default: "" },
    storageKey: { type: String, required: true, trim: true },
    storageKeyHash: { type: String, trim: true, index: true, default: "" },
    previewKey: { type: String, trim: true, default: "" },
    mimeType: { type: String, trim: true, default: "" },
    previewMimeType: { type: String, trim: true, default: "" },
    size: { type: Number, default: 0 },
    previewSize: { type: Number, default: 0 },
    uploadedByRole: { type: String, enum: ["attorney", "paralegal", "admin"], default: "attorney" },
    status: { type: String, enum: ["pending_review", "approved", "attorney_revision"], default: "pending_review" },
    version: { type: Number, default: 1 },
    revisionNotes: { type: String, trim: true, maxlength: 6000, default: "" },
    revisionRequestedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    replacedAt: { type: Date, default: null },
    history: [
      {
        storageKey: { type: String, trim: true },
        replacedAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
  }
);

caseFileSchema.index({ caseId: 1, createdAt: -1 });

caseFileSchema.pre("save", function (next) {
  try {
    encryptCaseFileFields(this);
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model("CaseFile", caseFileSchema);
