// backend/models/CaseDraft.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const taskSchema = new Schema(
  {
    title: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false }
);

const caseDraftSchema = new Schema(
  {
    owner: { type: Types.ObjectId, ref: "User", required: true, index: true },
    clientRequestId: { type: String, immutable: true },
    publishedCaseId: { type: Types.ObjectId, ref: "Case", default: null },
    creationFingerprint: { type: String, immutable: true },
    title: { type: String, trim: true, maxlength: 300, default: "" },
    practiceArea: { type: String, trim: true, maxlength: 200, default: "" },
    state: { type: String, trim: true, maxlength: 200, default: "" },
    compAmount: { type: String, trim: true, maxlength: 100, default: "" },
    experience: { type: String, trim: true, maxlength: 200, default: "" },
    deadline: { type: String, trim: true, maxlength: 50, default: "" },
    description: { type: String, trim: true, maxlength: 4000, default: "" },
    appliedSourceDescription: { type: String, maxlength: 4000, default: null },
    sourceDescription: { type: String, maxlength: 4000, default: "" },
    tasks: { type: [taskSchema], default: [] },
    pendingRequirement: { type: String, maxlength: 200, default: "" },
    requirements: { type: [{ type: String, trim: true, maxlength: 200 }], default: [], validate: value => value.length <= 12 },
    status: { type: String, trim: true, default: "draft" },
  },
  { timestamps: true }
);

caseDraftSchema.index({ owner: 1, updatedAt: -1 });
caseDraftSchema.index({ owner: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: "string" } } });

module.exports = mongoose.model("CaseDraft", caseDraftSchema);
