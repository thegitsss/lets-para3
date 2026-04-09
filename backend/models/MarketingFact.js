const mongoose = require("mongoose");

const {
  MARKETING_JR_CMO_FACT_SAFETY_STATUSES,
  MARKETING_JR_CMO_LIBRARY_STATUSES,
  MARKETING_LINKEDIN_COMPANY_CONTENT_LANES,
} = require("../services/marketing/constants");

const { Schema } = mongoose;

const marketingFactSchema = new Schema(
  {
    factKey: { type: String, required: true, trim: true, unique: true, index: true },
    sourceType: { type: String, trim: true, default: "knowledge_card", maxlength: 80, index: true },
    sourceRef: { type: String, trim: true, default: "", maxlength: 120, index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 2000 },
    statement: { type: String, trim: true, default: "", maxlength: 4000 },
    contentLaneHints: { type: [String], enum: MARKETING_LINKEDIN_COMPANY_CONTENT_LANES, default: [] },
    safetyStatus: {
      type: String,
      enum: MARKETING_JR_CMO_FACT_SAFETY_STATUSES,
      default: "approved",
      index: true,
    },
    freshnessScore: { type: Number, min: 0, max: 100, default: 50 },
    status: { type: String, enum: MARKETING_JR_CMO_LIBRARY_STATUSES, default: "active", index: true },
    lastReviewedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null, index: true },
  },
  {
    collection: "marketing_facts",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingFactSchema.index({ status: 1, safetyStatus: 1, updatedAt: -1 });

module.exports = mongoose.models.MarketingFact || mongoose.model("MarketingFact", marketingFactSchema);
