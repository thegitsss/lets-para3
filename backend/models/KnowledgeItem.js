const mongoose = require("mongoose");

const {
  KNOWLEDGE_APPROVAL_STATES,
  KNOWLEDGE_AUDIENCE_SCOPES,
  KNOWLEDGE_RECORD_TYPES,
} = require("../services/knowledge/constants");

const { Schema } = mongoose;

const knowledgeItemSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    slug: { type: String, trim: true, default: "", maxlength: 240, index: true },
    collectionId: { type: Schema.Types.ObjectId, ref: "KnowledgeCollection", required: true, index: true },
    domain: { type: String, trim: true, default: "", maxlength: 120, index: true },
    recordType: { type: String, enum: KNOWLEDGE_RECORD_TYPES, required: true, index: true },
    audienceScopes: {
      type: [String],
      enum: KNOWLEDGE_AUDIENCE_SCOPES,
      default: ["internal_ops"],
      index: true,
    },
    approvalState: {
      type: String,
      enum: KNOWLEDGE_APPROVAL_STATES,
      default: "draft",
      index: true,
    },
    ownerLabel: { type: String, trim: true, default: "Samantha", maxlength: 120 },
    freshnessDays: { type: Number, min: 1, max: 3650, default: 90 },
    lastReviewedAt: { type: Date, default: null },
    nextReviewAt: { type: Date, default: null, index: true },
    currentRevisionId: { type: Schema.Types.ObjectId, ref: "KnowledgeRevision", default: null },
    currentApprovedRevisionId: { type: Schema.Types.ObjectId, ref: "KnowledgeRevision", default: null },
    sourceKeys: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    collection: "knowledge_items",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

knowledgeItemSchema.index({ collectionId: 1, approvalState: 1, updatedAt: -1 });
knowledgeItemSchema.index({ domain: 1, recordType: 1, approvalState: 1 });

module.exports = mongoose.models.KnowledgeItem || mongoose.model("KnowledgeItem", knowledgeItemSchema);
