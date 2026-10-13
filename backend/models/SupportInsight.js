const mongoose = require("mongoose");

const { SUPPORT_INSIGHT_STATES, SUPPORT_INSIGHT_TYPES } = require("../services/support/constants");

const { Schema } = mongoose;

const supportInsightSchema = new Schema(
  {
    patternKey: { type: String, trim: true, default: "", index: true },
    category: { type: String, trim: true, default: "", maxlength: 120, index: true },
    insightType: { type: String, enum: SUPPORT_INSIGHT_TYPES, default: "friction_pattern", index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 4000 },
    state: { type: String, enum: SUPPORT_INSIGHT_STATES, default: "active", index: true },
    repeatCount: { type: Number, min: 1, default: 1 },
    affectedRoles: { type: [String], default: [] },
    sourceTicketIds: { type: [Schema.Types.ObjectId], ref: "SupportTicket", default: [] },
    sourceIncidentIds: { type: [Schema.Types.ObjectId], ref: "Incident", default: [] },
    surfacedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    priority: { type: String, enum: ["watch", "needs_review"], default: "watch" },
  },
  {
    collection: "support_insights",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

supportInsightSchema.index({ state: 1, priority: 1, updatedAt: -1 });

module.exports = mongoose.models.SupportInsight || mongoose.model("SupportInsight", supportInsightSchema);
