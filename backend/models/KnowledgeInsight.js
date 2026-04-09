const mongoose = require("mongoose");

const {
  KNOWLEDGE_AUDIENCE_SCOPES,
  KNOWLEDGE_INSIGHT_LANES,
  KNOWLEDGE_INSIGHT_STATUSES,
} = require("../services/knowledge/constants");

const { Schema } = mongoose;

const insightCitationSchema = new Schema(
  {
    sourceKey: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, default: "", maxlength: 240 },
    filePath: { type: String, trim: true, default: "" },
    excerpt: { type: String, trim: true, default: "", maxlength: 4000 },
    locator: { type: String, trim: true, default: "", maxlength: 240 },
  },
  { _id: false, strict: true }
);

const knowledgeInsightSchema = new Schema(
  {
    lane: { type: String, enum: KNOWLEDGE_INSIGHT_LANES, default: "quarantined", index: true },
    sourceType: { type: String, enum: ["incident", "ticket", "manual"], default: "incident", index: true },
    sourceId: { type: String, trim: true, default: "", index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 8000 },
    audienceScopes: {
      type: [String],
      enum: KNOWLEDGE_AUDIENCE_SCOPES,
      default: ["internal_ops"],
    },
    status: { type: String, enum: KNOWLEDGE_INSIGHT_STATUSES, default: "candidate", index: true },
    citations: { type: [insightCitationSchema], default: [] },
    tags: { type: [String], default: [] },
  },
  {
    collection: "knowledge_insights",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

knowledgeInsightSchema.index({ lane: 1, status: 1, updatedAt: -1 });

module.exports =
  mongoose.models.KnowledgeInsight || mongoose.model("KnowledgeInsight", knowledgeInsightSchema);
