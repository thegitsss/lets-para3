const mongoose = require("mongoose");

const {
  MARKETING_JR_CMO_DAY_CONTEXT_STATUSES,
  MARKETING_JR_CMO_SOURCE_MODES,
  MARKETING_JR_CMO_TONE_RECOMMENDATIONS,
} = require("../services/marketing/constants");

const { Schema } = mongoose;

const sourceRefSchema = new Schema(
  {
    label: { type: String, trim: true, default: "", maxlength: 240 },
    url: { type: String, trim: true, default: "", maxlength: 1000 },
    source: { type: String, trim: true, default: "", maxlength: 160 },
    publishedAt: { type: String, trim: true, default: "", maxlength: 64 },
  },
  { _id: false, strict: true }
);

const marketingDayContextSchema = new Schema(
  {
    dayKey: { type: String, required: true, trim: true, unique: true, index: true },
    calendarDate: { type: Date, required: true, index: true },
    weekday: { type: String, trim: true, default: "", maxlength: 32 },
    sourceMode: { type: String, enum: MARKETING_JR_CMO_SOURCE_MODES, default: "internal_only", index: true },
    toneRecommendation: {
      type: String,
      enum: MARKETING_JR_CMO_TONE_RECOMMENDATIONS,
      default: "measured",
      index: true,
    },
    toneReasoning: { type: String, trim: true, default: "", maxlength: 1000 },
    industryClimateSummary: { type: String, trim: true, default: "", maxlength: 2000 },
    internalContextSummary: { type: String, trim: true, default: "", maxlength: 2000 },
    activeSignals: { type: [String], default: [] },
    sourceRefs: { type: [sourceRefSchema], default: [] },
    status: { type: String, enum: MARKETING_JR_CMO_DAY_CONTEXT_STATUSES, default: "active", index: true },
    refreshedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null, index: true },
  },
  {
    collection: "marketing_day_contexts",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingDayContextSchema.index({ status: 1, refreshedAt: -1 });

module.exports =
  mongoose.models.MarketingDayContext || mongoose.model("MarketingDayContext", marketingDayContextSchema);
