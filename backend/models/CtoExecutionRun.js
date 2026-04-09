const mongoose = require("mongoose");

const { Schema } = mongoose;

const CTO_EXECUTION_STATUSES = [
  "planned",
  "awaiting_approval",
  "in_progress",
  "ready_for_test",
  "ready_for_review",
  "ready_for_deploy",
  "resolved",
  "blocked",
];

const ctoExecutionRunSchema = new Schema(
  {
    ctoRunId: { type: Schema.Types.ObjectId, ref: "CtoAgentRun", default: null, index: true },
    issueId: { type: Schema.Types.ObjectId, ref: "AgentIssue", default: null, index: true },
    category: { type: String, trim: true, default: "", maxlength: 120, index: true },
    urgency: { type: String, trim: true, default: "", maxlength: 40, index: true },
    technicalSeverity: { type: String, trim: true, default: "", maxlength: 40, index: true },
    executionStatus: {
      type: String,
      enum: CTO_EXECUTION_STATUSES,
      default: "awaiting_approval",
      index: true,
    },
    implementationSummary: { type: String, trim: true, default: "", maxlength: 4000 },
    executionPlan: { type: [String], default: [] },
    patchArtifact: { type: Schema.Types.Mixed, default: {} },
    codexExecutionPrompt: { type: String, trim: true, default: "", maxlength: 24000 },
    requiredTests: { type: [String], default: [] },
    deploymentChecklist: { type: [String], default: [] },
    deploymentReadiness: { type: Schema.Types.Mixed, default: {} },
    approvalRequired: { type: Boolean, default: true },
    canAutoDeploy: { type: Boolean, default: false },
    notifyUserWhenResolved: { type: Boolean, default: false },
    resolutionMessageDraft: { type: String, trim: true, default: "", maxlength: 4000 },
    sourceDiagnosisSnapshot: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
    generatedAt: { type: Date, default: Date.now, index: true },
  },
  {
    collection: "cto_execution_runs",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

ctoExecutionRunSchema.index({ createdAt: -1, category: 1, executionStatus: 1 });

module.exports = mongoose.models.CtoExecutionRun || mongoose.model("CtoExecutionRun", ctoExecutionRunSchema);
