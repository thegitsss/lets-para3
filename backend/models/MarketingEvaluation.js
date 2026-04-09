const mongoose = require("mongoose");

const {
  MARKETING_JR_CMO_EVALUATION_TYPES,
  MARKETING_JR_CMO_LIBRARY_STATUSES,
} = require("../services/marketing/constants");

const { Schema } = mongoose;

const marketingEvaluationSchema = new Schema(
  {
    evaluationKey: { type: String, required: true, trim: true, unique: true, index: true },
    evaluationType: {
      type: String,
      enum: MARKETING_JR_CMO_EVALUATION_TYPES,
      default: "weekly",
      index: true,
    },
    windowStartAt: { type: Date, default: null, index: true },
    windowEndAt: { type: Date, default: null, index: true },
    packetId: { type: Schema.Types.ObjectId, ref: "MarketingDraftPacket", default: null, index: true },
    briefId: { type: Schema.Types.ObjectId, ref: "MarketingBrief", default: null, index: true },
    workflowType: { type: String, trim: true, default: "", maxlength: 80, index: true },
    channelKey: { type: String, trim: true, default: "", maxlength: 80, index: true },
    contentLane: { type: String, trim: true, default: "", maxlength: 80, index: true },
    outcome: { type: String, trim: true, default: "", maxlength: 40, index: true },
    score: { type: Number, min: -100, max: 100, default: 0 },
    decisionNote: { type: String, trim: true, default: "", maxlength: 2000 },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 2000 },
    findings: { type: [String], default: [] },
    recommendations: { type: [String], default: [] },
    metadata: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: MARKETING_JR_CMO_LIBRARY_STATUSES, default: "active", index: true },
    expiresAt: { type: Date, default: null, index: true },
  },
  {
    collection: "marketing_evaluations",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingEvaluationSchema.index({ status: 1, evaluationType: 1, updatedAt: -1 });

module.exports =
  mongoose.models.MarketingEvaluation || mongoose.model("MarketingEvaluation", marketingEvaluationSchema);
