const mongoose = require("mongoose");

const { Schema } = mongoose;

const founderDailyActionSchema = new Schema(
  {
    key: { type: String, trim: true, default: "", maxlength: 120 },
    label: { type: String, trim: true, default: "", maxlength: 160 },
    description: { type: String, trim: true, default: "", maxlength: 500 },
    actionType: { type: String, trim: true, default: "", maxlength: 80 },
    channelKey: { type: String, trim: true, default: "", maxlength: 80 },
    packetId: { type: Schema.Types.ObjectId, ref: "MarketingDraftPacket", default: null },
    cycleId: { type: Schema.Types.ObjectId, ref: "MarketingPublishingCycle", default: null },
    enabled: { type: Boolean, default: true },
    disabledReason: { type: String, trim: true, default: "", maxlength: 500 },
    priority: { type: Number, default: 50 },
  },
  { _id: false, strict: true }
);

const founderReadyPostSchema = new Schema(
  {
    channelKey: { type: String, trim: true, default: "", maxlength: 80 },
    channelLabel: { type: String, trim: true, default: "", maxlength: 120 },
    packetId: { type: Schema.Types.ObjectId, ref: "MarketingDraftPacket", default: null },
    cycleId: { type: Schema.Types.ObjectId, ref: "MarketingPublishingCycle", default: null },
    title: { type: String, trim: true, default: "", maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 1000 },
    status: { type: String, trim: true, default: "", maxlength: 80, index: true },
    approvalState: { type: String, trim: true, default: "", maxlength: 80 },
    publishReadiness: { type: String, trim: true, default: "", maxlength: 80 },
    canPostNow: { type: Boolean, default: false },
    blocker: { type: String, trim: true, default: "", maxlength: 500 },
    primaryAction: { type: founderDailyActionSchema, default: null },
    secondaryAction: { type: founderDailyActionSchema, default: null },
  },
  { _id: false, strict: true }
);

const founderDailyLogSchema = new Schema(
  {
    dateKey: { type: String, required: true, trim: true, maxlength: 20, index: true },
    timezone: { type: String, required: true, trim: true, maxlength: 120, default: "America/New_York", index: true },
    summary: { type: String, trim: true, default: "", maxlength: 2000 },
    whatChanged: { type: [String], default: [] },
    needsFounder: { type: [String], default: [] },
    blockers: { type: [String], default: [] },
    recommendedActions: { type: [String], default: [] },
    quickActions: { type: [founderDailyActionSchema], default: [] },
    readyPosts: { type: [founderReadyPostSchema], default: [] },
    compactStatus: { type: Schema.Types.Mixed, default: {} },
    generatedAt: { type: Date, default: Date.now, index: true },
    sourceMetadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "founder_daily_logs",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

founderDailyLogSchema.index({ dateKey: 1, timezone: 1 }, { unique: true });

module.exports =
  mongoose.models.FounderDailyLog || mongoose.model("FounderDailyLog", founderDailyLogSchema);
