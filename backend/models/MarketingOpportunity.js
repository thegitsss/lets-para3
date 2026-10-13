const mongoose = require("mongoose");

const {
  MARKETING_JR_CMO_LIBRARY_STATUSES,
  MARKETING_JR_CMO_OPPORTUNITY_PRIORITIES,
  MARKETING_JR_CMO_OPPORTUNITY_TYPES,
  MARKETING_LINKEDIN_COMPANY_CONTENT_LANES,
} = require("../services/marketing/constants");

const { Schema } = mongoose;

const sourceRefSchema = new Schema(
  {
    type: { type: String, trim: true, default: "", maxlength: 80 },
    refId: { type: String, trim: true, default: "", maxlength: 120 },
    label: { type: String, trim: true, default: "", maxlength: 240 },
  },
  { _id: false, strict: true }
);

const marketingOpportunitySchema = new Schema(
  {
    opportunityKey: { type: String, required: true, trim: true, unique: true, index: true },
    opportunityType: {
      type: String,
      enum: MARKETING_JR_CMO_OPPORTUNITY_TYPES,
      default: "lane_gap",
      index: true,
    },
    contentLane: { type: String, enum: ["", ...MARKETING_LINKEDIN_COMPANY_CONTENT_LANES], default: "", index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 2000 },
    rationale: { type: String, trim: true, default: "", maxlength: 2000 },
    priority: {
      type: String,
      enum: MARKETING_JR_CMO_OPPORTUNITY_PRIORITIES,
      default: "candidate",
      index: true,
    },
    sourceMode: { type: String, trim: true, default: "internal_only", maxlength: 40 },
    sourceRefs: { type: [sourceRefSchema], default: [] },
    status: { type: String, enum: MARKETING_JR_CMO_LIBRARY_STATUSES, default: "active", index: true },
    surfacedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null, index: true },
  },
  {
    collection: "marketing_opportunities",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingOpportunitySchema.index({ status: 1, priority: 1, updatedAt: -1 });

module.exports =
  mongoose.models.MarketingOpportunity || mongoose.model("MarketingOpportunity", marketingOpportunitySchema);
