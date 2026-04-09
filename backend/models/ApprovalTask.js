const mongoose = require("mongoose");

const {
  APPROVAL_TARGET_TYPES,
  APPROVAL_TASK_STATES,
  APPROVAL_TASK_TYPES,
} = require("../services/knowledge/constants");

const { Schema } = mongoose;

const actorSchema = new Schema(
  {
    actorType: { type: String, enum: ["system", "user", "agent"], default: "system" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    label: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false, strict: true }
);

const approvalTaskSchema = new Schema(
  {
    taskType: { type: String, enum: APPROVAL_TASK_TYPES, required: true, index: true },
    targetType: { type: String, enum: APPROVAL_TARGET_TYPES, required: true, index: true },
    targetId: { type: String, required: true, trim: true, index: true },
    parentType: { type: String, trim: true, default: "", maxlength: 120 },
    parentId: { type: String, trim: true, default: "", index: true },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 4000 },
    approvalState: { type: String, enum: APPROVAL_TASK_STATES, default: "pending", index: true },
    requestedBy: { type: actorSchema, default: () => ({ actorType: "system", label: "System" }) },
    assignedOwnerLabel: { type: String, trim: true, default: "Samantha", maxlength: 120 },
    decidedBy: { type: actorSchema, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, default: "", maxlength: 4000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "approval_tasks",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

approvalTaskSchema.index({ approvalState: 1, taskType: 1, updatedAt: -1 });

module.exports = mongoose.models.ApprovalTask || mongoose.model("ApprovalTask", approvalTaskSchema);
