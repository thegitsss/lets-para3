const mongoose = require("mongoose");

const { Schema } = mongoose;

const {
  MARKETING_LINKEDIN_COMPANY_CONTENT_LANES,
  MARKETING_PUBLISHING_CHANNELS,
  MARKETING_WORKFLOW_TYPES,
} = require("../services/marketing/constants");

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

const marketingDraftPacketSchema = new Schema(
  {
    briefId: { type: Schema.Types.ObjectId, ref: "MarketingBrief", required: true, index: true },
    workflowType: { type: String, enum: MARKETING_WORKFLOW_TYPES, required: true, index: true },
    channelKey: { type: String, enum: MARKETING_PUBLISHING_CHANNELS, default: null, index: true },
    packetVersion: { type: Number, required: true, min: 1 },
    approvalState: { type: String, enum: ["draft", "pending_review", "approved", "rejected"], default: "pending_review", index: true },
    briefSummary: { type: String, trim: true, default: "", maxlength: 8000 },
    targetAudience: { type: String, trim: true, default: "", maxlength: 240 },
    contentLane: { type: String, enum: ["", ...MARKETING_LINKEDIN_COMPANY_CONTENT_LANES], default: "", index: true },
    growthObjective: { type: String, trim: true, default: "", maxlength: 280 },
    whyThisHelpsPageGrowth: { type: String, trim: true, default: "", maxlength: 1000 },
    approvedPositioningBlocksUsed: { type: [Schema.Types.Mixed], default: [] },
    messageHierarchy: { type: [String], default: [] },
    approvedFactCards: { type: [Schema.Types.Mixed], default: [] },
    claimsToAvoid: { type: [String], default: [] },
    channelDraft: { type: Schema.Types.Mixed, default: {} },
    alternateAngles: { type: [String], default: [] },
    hookOptions: { type: [String], default: [] },
    ctaOptions: { type: [String], default: [] },
    founderVoiceNotes: { type: [String], default: [] },
    openQuestions: { type: [String], default: [] },
    citations: { type: [citationSchema], default: [] },
    whatStillNeedsSamantha: { type: [String], default: [] },
    generatedBy: { type: actorSchema, default: () => ({ actorType: "system", label: "Marketing Draft Service" }) },
    packetSummary: { type: String, trim: true, default: "", maxlength: 1000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "marketing_draft_packets",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingDraftPacketSchema.index({ briefId: 1, packetVersion: 1 }, { unique: true });
marketingDraftPacketSchema.index({ approvalState: 1, updatedAt: -1 });

module.exports =
  mongoose.models.MarketingDraftPacket || mongoose.model("MarketingDraftPacket", marketingDraftPacketSchema);
