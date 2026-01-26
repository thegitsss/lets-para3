const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const caseFileSchema = new Schema(
  {
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true },
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    originalName: { type: String, required: true, trim: true, maxlength: 500 },
    storageKey: { type: String, required: true, trim: true },
    mimeType: { type: String, trim: true, default: "" },
    size: { type: Number, default: 0 },
    uploadedByRole: { type: String, enum: ["attorney", "paralegal", "admin"], default: "attorney" },
    status: { type: String, enum: ["pending_review", "approved", "attorney_revision"], default: "pending_review" },
    version: { type: Number, default: 1 },
    revisionNotes: { type: String, trim: true, maxlength: 2000, default: "" },
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

module.exports = mongoose.model("CaseFile", caseFileSchema);
