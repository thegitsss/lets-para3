const mongoose = require("mongoose");

const { Schema } = mongoose;

const AGENT_ROLES = ["CCO", "CMO", "CSO", "CTO"];
const MODES = ["manual", "auto"];

const autonomyPreferenceSchema = new Schema(
  {
    agentRole: {
      type: String,
      enum: AGENT_ROLES,
      required: true,
      trim: true,
      index: true,
    },
    actionType: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      index: true,
    },
    mode: {
      type: String,
      enum: MODES,
      default: "manual",
      index: true,
    },
    learnedFromCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Serialize automatic decisions with owner policy changes. Older records
    // acquire the counter on their first decision; no backfill is required.
    executionRevision: { type: Number, default: 0, min: 0 },
    dailyAttemptLimit: { type: Number, default: 25, min: 1, max: 100, validate: Number.isInteger },
    executionDay: { type: String, default: "" },
    dailyAttempts: { type: Number, default: 0, min: 0 },
    outboundConfigurationRevision: { type: Number, default: 0, min: 0 },
    outboundScanCursor: { type: Schema.Types.ObjectId, default: null },
    outboundRules: {
      startHour: { type: Number, default: 9, min: 0, max: 23, validate: Number.isInteger },
      endHour: { type: Number, default: 17, min: 1, max: 24, validate: Number.isInteger },
      timeZone: { type: String, default: "America/New_York", maxlength: 80 },
      reminderLimit: { type: Number, default: 2, min: 0, max: 2, validate: Number.isInteger },
      reminderIntervalHours: { type: Number, default: 72, min: 24, max: 168, validate: Number.isInteger },
      spendingLimitCents: { type: Number, default: 0, min: 0, max: 0 },
    },
    lastPromptedAt: {
      type: Date,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
    },
  },
  {
    collection: "autonomy_preferences",
    versionKey: false,
    minimize: false,
  }
);

autonomyPreferenceSchema.index({ agentRole: 1, actionType: 1 }, { unique: true });

module.exports =
  mongoose.models.AutonomyPreference || mongoose.model("AutonomyPreference", autonomyPreferenceSchema);
