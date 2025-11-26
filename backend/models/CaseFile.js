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
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
  }
);

caseFileSchema.index({ caseId: 1, createdAt: -1 });

module.exports = mongoose.model("CaseFile", caseFileSchema);
