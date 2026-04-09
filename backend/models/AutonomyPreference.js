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
