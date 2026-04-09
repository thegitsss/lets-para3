const mongoose = require("mongoose");

const {
  MARKETING_PUBLISHING_CADENCE_MODES,
  MARKETING_PUBLISHING_CHANNELS,
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

const marketingPublishingSettingsSchema = new Schema(
  {
    singletonKey: { type: String, required: true, trim: true, unique: true, default: "marketing_publishing" },
    isEnabled: { type: Boolean, default: false },
    cadenceMode: {
      type: String,
      enum: MARKETING_PUBLISHING_CADENCE_MODES,
      default: "manual_only",
      index: true,
    },
    timezone: { type: String, trim: true, default: "America/New_York", maxlength: 120 },
    preferredHourLocal: { type: Number, min: 0, max: 23, default: 9 },
    enabledChannels: {
      type: [String],
      enum: MARKETING_PUBLISHING_CHANNELS,
      default: ["linkedin_company", "facebook_page"],
    },
    pauseReason: { type: String, trim: true, default: "", maxlength: 500 },
    maxOpenCycles: { type: Number, min: 1, max: 5, default: 1 },
    nextDueAt: { type: Date, default: null, index: true },
    lastDueAt: { type: Date, default: null },
    lastCycleCreatedAt: { type: Date, default: null },
    lastMissedDueAt: { type: Date, default: null },
    updatedBy: { type: actorSchema, default: () => ({ actorType: "system", label: "System" }) },
  },
  {
    collection: "marketing_publishing_settings",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingPublishingSettingsSchema.index({ cadenceMode: 1, isEnabled: 1, nextDueAt: 1 });

module.exports =
  mongoose.models.MarketingPublishingSettings ||
  mongoose.model("MarketingPublishingSettings", marketingPublishingSettingsSchema);
