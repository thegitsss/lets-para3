const mongoose = require("mongoose");

const { KNOWLEDGE_APPROVAL_STATES } = require("../services/knowledge/constants");

const { Schema } = mongoose;

const citationSchema = new Schema(
  {
    sourceKey: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, default: "", maxlength: 240 },
    filePath: { type: String, trim: true, default: "" },
    excerpt: { type: String, trim: true, default: "", maxlength: 4000 },
    locator: { type: String, trim: true, default: "", maxlength: 240 },
  },
  { _id: false, strict: true }
);

const actorSchema = new Schema(
  {
    actorType: { type: String, enum: ["system", "user", "agent"], default: "system" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    label: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false, strict: true }
);

const knowledgeRevisionSchema = new Schema(
  {
    knowledgeItemId: {
      type: Schema.Types.ObjectId,
      ref: "KnowledgeItem",
      required: true,
      immutable: true,
      index: true,
    },
    revisionNumber: { type: Number, required: true, immutable: true, min: 1 },
    fingerprint: { type: String, required: true, trim: true, immutable: true },
    content: { type: Schema.Types.Mixed, default: {}, immutable: true },
    citations: { type: [citationSchema], default: [] },
    approvalState: {
      type: String,
      enum: KNOWLEDGE_APPROVAL_STATES,
      default: "draft",
      index: true,
    },
    changeSummary: { type: String, trim: true, default: "", maxlength: 2000 },
    createdBy: { type: actorSchema, default: () => ({ actorType: "system", label: "System" }) },
    approvedBy: { type: actorSchema, default: null },
    approvedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
    rejectionNote: { type: String, trim: true, default: "", maxlength: 4000 },
    createdFrom: { type: String, trim: true, default: "seed_sync", maxlength: 120 },
  },
  {
    collection: "knowledge_revisions",
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
  }
);

knowledgeRevisionSchema.index({ knowledgeItemId: 1, revisionNumber: 1 }, { unique: true });
knowledgeRevisionSchema.index({ knowledgeItemId: 1, createdAt: -1 });

module.exports =
  mongoose.models.KnowledgeRevision || mongoose.model("KnowledgeRevision", knowledgeRevisionSchema);
