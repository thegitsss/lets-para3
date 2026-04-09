const mongoose = require("mongoose");

const { Schema } = mongoose;

// Tracks user-reported AI/control-room issues surfaced from public and account support flows.
const aiIssueReportSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    role: {
      type: String,
      enum: ["visitor", "attorney", "paralegal"],
      required: true,
      index: true,
    },
    surface: {
      type: String,
      enum: ["public", "attorney", "paralegal"],
      required: true,
      index: true,
    },
    page: { type: String, default: "" },
    featureLabel: { type: String, default: "" },
    issueType: {
      type: String,
      enum: ["bug", "confusion", "payment_question", "onboarding", "other"],
      default: "other",
    },
    description: { type: String, default: "" },
    observedBehavior: { type: String, default: "" },
    expectedBehavior: { type: String, default: "" },
    browser: { type: String, default: "" },
    device: { type: String, default: "" },
    blockedSeverity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "low",
    },
    affectsMoney: { type: Boolean, default: false },
    affectsAuth: { type: Boolean, default: false },
    affectsCaseProgress: { type: Boolean, default: false },
    status: { type: String, enum: ["new", "reviewed", "resolved"], default: "new", index: true },
  },
  { timestamps: true }
);

aiIssueReportSchema.index({ createdAt: -1 });
aiIssueReportSchema.index({ status: 1, createdAt: -1 });
aiIssueReportSchema.index({ surface: 1, status: 1, createdAt: -1 });

module.exports =
  mongoose.models.AiIssueReport || mongoose.model("AiIssueReport", aiIssueReportSchema);
