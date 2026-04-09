const mongoose = require("mongoose");

const { Schema } = mongoose;

const AGENT_ROLES = ["CCO", "CMO", "CSO", "CTO"];
const ACTION_TYPES = [
  "ticket_reopened",
  "ticket_escalated",
  "incident_routed_from_support",
  "faq_candidate_created",
  "support_insight_created",
  "ticket_resolved",
  "support_governed_content_auto_approved",
  "marketing_publish_auto_approved",
  "sales_outreach_auto_approved",
  "incident_approval_auto_approved",
];
const ACTION_STATUSES = ["completed", "undone"];
const APPEND_ONLY_ERROR = "AutonomousAction records are append-only and cannot be deleted.";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function hasOwnKeys(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function blockDeletion(next) {
  const error = new Error(APPEND_ONLY_ERROR);
  error.statusCode = 405;
  next(error);
}

const autonomousActionSchema = new Schema(
  {
    agentRole: {
      type: String,
      enum: AGENT_ROLES,
      required: true,
      immutable: true,
      index: true,
    },
    actionType: {
      type: String,
      enum: ACTION_TYPES,
      required: true,
      immutable: true,
      index: true,
    },
    confidenceScore: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
      immutable: true,
    },
    confidenceReason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
      immutable: true,
    },
    targetModel: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      immutable: true,
      index: true,
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true,
      immutable: true,
      index: true,
    },
    changedFields: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
      immutable: true,
      validate: {
        validator: hasOwnKeys,
        message: "changedFields must be a non-empty object.",
      },
    },
    previousValues: {
      type: Schema.Types.Mixed,
      required: true,
      default: {},
      immutable: true,
      validate: {
        validator: isPlainObject,
        message: "previousValues must be an object.",
      },
    },
    actionTaken: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
      immutable: true,
    },
    status: {
      type: String,
      enum: ACTION_STATUSES,
      default: "completed",
      index: true,
    },
    undoneAt: {
      type: Date,
      default: null,
    },
    undoneReason: {
      type: String,
      trim: true,
      default: null,
      maxlength: 2000,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      immutable: true,
      index: true,
    },
  },
  {
    collection: "autonomous_actions",
    versionKey: false,
    minimize: false,
  }
);

autonomousActionSchema.index({ agentRole: 1, createdAt: -1 });
autonomousActionSchema.index({ actionType: 1, status: 1, createdAt: -1 });

autonomousActionSchema.pre("deleteMany", blockDeletion);
autonomousActionSchema.pre("deleteOne", { document: false, query: true }, blockDeletion);
autonomousActionSchema.pre("deleteOne", { document: true, query: false }, blockDeletion);
autonomousActionSchema.pre("findOneAndDelete", blockDeletion);
autonomousActionSchema.pre("findOneAndRemove", blockDeletion);
autonomousActionSchema.pre("remove", blockDeletion);

module.exports =
  mongoose.models.AutonomousAction || mongoose.model("AutonomousAction", autonomousActionSchema);
