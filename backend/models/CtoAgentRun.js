const mongoose = require("mongoose");

const { Schema } = mongoose;

const ctoAgentRunSchema = new Schema(
  {
    issueId: { type: Schema.Types.ObjectId, ref: "AgentIssue", default: null, index: true },
    category: { type: String, trim: true, default: "", maxlength: 120, index: true },
    urgency: { type: String, trim: true, default: "", maxlength: 40, index: true },
    technicalSeverity: { type: String, trim: true, default: "", maxlength: 40, index: true },
    diagnosisSummary: { type: String, trim: true, default: "", maxlength: 4000 },
    likelyRootCauses: { type: [String], default: [] },
    likelyAffectedAreas: { type: [String], default: [] },
    filesToInspect: { type: [String], default: [] },
    backendAreasToCheck: { type: [String], default: [] },
    frontendAreasToCheck: { type: [String], default: [] },
    recommendedFixStrategy: { type: String, trim: true, default: "", maxlength: 8000 },
    codexPatchPrompt: { type: String, trim: true, default: "", maxlength: 20000 },
    testPlan: { type: [String], default: [] },
    deploymentRisk: { type: String, trim: true, default: "", maxlength: 240 },
    approvalRequired: { type: Boolean, default: true },
    canAutoDeploy: { type: Boolean, default: false },
    notifyUserWhenResolved: { type: Boolean, default: false },
    notes: { type: [String], default: [] },
    sourceIssueSnapshot: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
    generatedAt: { type: Date, default: Date.now, index: true },
  },
  {
    collection: "cto_agent_runs",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

ctoAgentRunSchema.index({ createdAt: -1, category: 1 });

module.exports = mongoose.models.CtoAgentRun || mongoose.model("CtoAgentRun", ctoAgentRunSchema);
