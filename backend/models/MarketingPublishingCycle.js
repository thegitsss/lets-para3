const mongoose = require("mongoose");

const {
  MARKETING_PUBLISHING_CADENCE_MODES,
  MARKETING_PUBLISHING_CHANNELS,
  MARKETING_PUBLISHING_CYCLE_STATUSES,
  MARKETING_PUBLISHING_TRIGGER_SOURCES,
} = require("../services/marketing/constants");

const { Schema } = mongoose;

const actorSchema = new Schema(
  {
    actorType: { type: String, enum: ["system", "user", "agent"], default: "system" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    label: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false, strict: true }
);

const settingsSnapshotSchema = new Schema(
  {
    cadenceMode: { type: String, enum: MARKETING_PUBLISHING_CADENCE_MODES, default: "manual_only" },
    timezone: { type: String, trim: true, default: "America/New_York", maxlength: 120 },
    preferredHourLocal: { type: Number, min: 0, max: 23, default: 9 },
    enabledChannels: { type: [String], enum: MARKETING_PUBLISHING_CHANNELS, default: [] },
    maxOpenCycles: { type: Number, min: 1, max: 5, default: 1 },
  },
  { _id: false, strict: true }
);

const marketingPublishingCycleSchema = new Schema(
  {
    triggerSource: {
      type: String,
      enum: MARKETING_PUBLISHING_TRIGGER_SOURCES,
      required: true,
      index: true,
    },
    dueSlotAt: { type: Date, default: null, index: true },
    cycleLabel: { type: String, trim: true, default: "", maxlength: 240 },
    status: {
      type: String,
      enum: MARKETING_PUBLISHING_CYCLE_STATUSES,
      default: "drafted",
      index: true,
    },
    statusReason: { type: String, trim: true, default: "", maxlength: 500 },
    settingsSnapshot: { type: settingsSnapshotSchema, default: () => ({}) },
    targetAudience: { type: String, trim: true, default: "", maxlength: 240 },
    objective: { type: String, trim: true, default: "", maxlength: 1000 },
    briefSummary: { type: String, trim: true, default: "", maxlength: 8000 },
    updateFacts: { type: [String], default: [] },
    ctaPreference: { type: String, trim: true, default: "", maxlength: 500 },
    linkedinBriefId: { type: Schema.Types.ObjectId, ref: "MarketingBrief", default: null },
    linkedinPacketId: { type: Schema.Types.ObjectId, ref: "MarketingDraftPacket", default: null },
    facebookBriefId: { type: Schema.Types.ObjectId, ref: "MarketingBrief", default: null },
    facebookPacketId: { type: Schema.Types.ObjectId, ref: "MarketingDraftPacket", default: null },
    skippedAt: { type: Date, default: null },
    skippedBy: { type: actorSchema, default: null },
    skipReason: { type: String, trim: true, default: "", maxlength: 500 },
    createdBy: { type: actorSchema, default: () => ({ actorType: "system", label: "System" }) },
    lastEvaluatedAt: { type: Date, default: null },
  },
  {
    collection: "marketing_publishing_cycles",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingPublishingCycleSchema.index({ status: 1, createdAt: -1 });
marketingPublishingCycleSchema.index({ dueSlotAt: 1, status: 1 });

module.exports =
  mongoose.models.MarketingPublishingCycle ||
  mongoose.model("MarketingPublishingCycle", marketingPublishingCycleSchema);
