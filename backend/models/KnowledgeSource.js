const mongoose = require("mongoose");

const {
  KNOWLEDGE_SOURCE_TYPES,
  KNOWLEDGE_SYNC_STATES,
} = require("../services/knowledge/constants");

const { Schema } = mongoose;

const knowledgeSourceSchema = new Schema(
  {
    sourceKey: { type: String, required: true, trim: true, unique: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    sourceType: { type: String, enum: KNOWLEDGE_SOURCE_TYPES, default: "file", required: true },
    filePath: { type: String, trim: true, default: "" },
    syncState: { type: String, enum: KNOWLEDGE_SYNC_STATES, default: "never_synced", index: true },
    sourceHash: { type: String, trim: true, default: "" },
    lastSyncedAt: { type: Date, default: null },
    lastSyncNote: { type: String, trim: true, default: "", maxlength: 1000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "knowledge_sources",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

knowledgeSourceSchema.index({ syncState: 1, updatedAt: -1 });

module.exports =
  mongoose.models.KnowledgeSource || mongoose.model("KnowledgeSource", knowledgeSourceSchema);
