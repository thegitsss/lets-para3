const mongoose = require("mongoose");

const { Schema } = mongoose;

const {
  MARKETING_LINKEDIN_COMPANY_CONTENT_LANES,
  MARKETING_PUBLISHING_CHANNELS,
  MARKETING_WORKFLOW_TYPES,
} = require("../services/marketing/constants");

const actorSchema = new Schema(
  {
    actorType: { type: String, enum: ["system", "user", "agent"], default: "user" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    label: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false, strict: true }
);

const marketingBriefSchema = new Schema(
  {
    workflowType: { type: String, enum: MARKETING_WORKFLOW_TYPES, required: true, index: true },
    cycleId: { type: Schema.Types.ObjectId, ref: "MarketingPublishingCycle", default: null, index: true },
    channelKey: { type: String, enum: MARKETING_PUBLISHING_CHANNELS, default: null, index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    briefSummary: { type: String, trim: true, default: "", maxlength: 8000 },
    targetAudience: { type: String, trim: true, default: "", maxlength: 240 },
    objective: { type: String, trim: true, default: "", maxlength: 1000 },
    contentLane: { type: String, enum: ["", ...MARKETING_LINKEDIN_COMPANY_CONTENT_LANES], default: "", index: true },
    updateFacts: { type: [String], default: [] },
    ctaPreference: { type: String, trim: true, default: "", maxlength: 500 },
    requestedBy: { type: actorSchema, default: () => ({ actorType: "user", label: "Admin" }) },
    approvalState: { type: String, enum: ["draft", "in_queue"], default: "draft", index: true },
  },
  {
    collection: "marketing_briefs",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingBriefSchema.index({ workflowType: 1, updatedAt: -1 });

module.exports = mongoose.models.MarketingBrief || mongoose.model("MarketingBrief", marketingBriefSchema);
