const mongoose = require("mongoose");

const { Schema } = mongoose;

const agentIssueSchema = new Schema(
  {
    userEmail: { type: String, trim: true, lowercase: true, default: "" },
    category: { type: String, required: true, trim: true },
    urgency: { type: String, required: true, trim: true },
    originalMessage: { type: String, required: true },
    replyDraft: { type: String, default: "" },
    internalSummary: { type: String, default: "" },
    status: { type: String, default: "new", trim: true },
    source: { type: String, default: "manual", trim: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

agentIssueSchema.index({ category: 1 });
agentIssueSchema.index({ urgency: 1 });
agentIssueSchema.index({ createdAt: -1 });
agentIssueSchema.index({ status: 1 });
agentIssueSchema.index({ category: 1, createdAt: -1 });

module.exports = mongoose.models.AgentIssue || mongoose.model("AgentIssue", agentIssueSchema);
