const mongoose = require("mongoose");

const { KNOWLEDGE_AUDIENCE_SCOPES } = require("../services/knowledge/constants");

const { Schema } = mongoose;

const knowledgeCollectionSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    description: { type: String, trim: true, default: "", maxlength: 4000 },
    domain: { type: String, trim: true, default: "", maxlength: 120, index: true },
    audienceScopes: {
      type: [String],
      enum: KNOWLEDGE_AUDIENCE_SCOPES,
      default: ["internal_ops"],
    },
    ownerLabel: { type: String, trim: true, default: "Samantha", maxlength: 120 },
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    collection: "knowledge_collections",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

knowledgeCollectionSchema.index({ domain: 1, isActive: 1, updatedAt: -1 });

module.exports =
  mongoose.models.KnowledgeCollection || mongoose.model("KnowledgeCollection", knowledgeCollectionSchema);
