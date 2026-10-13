const mongoose = require("mongoose");

const {
  INCIDENT_APPROVAL_TYPES,
  INCIDENT_APPROVAL_STATUSES,
  INCIDENT_APPROVAL_DECISION_ROLES,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;

const decisionScopeSchema = new Schema(
  {
    allowProductionDeploy: { type: Boolean, default: false },
    allowUserResolution: { type: Boolean, default: false },
    allowManualRepair: { type: Boolean, default: false },
  },
  { _id: false, strict: true }
);

const incidentApprovalSchema = new Schema(
  {
    incidentId: {
      type: Types.ObjectId,
      ref: "Incident",
      required: true,
      immutable: true,
      index: true,
    },
    attemptNumber: { type: Number, required: true, immutable: true, min: 1 },
    approvalType: {
      type: String,
      enum: INCIDENT_APPROVAL_TYPES,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: INCIDENT_APPROVAL_STATUSES,
      required: true,
      default: "pending",
    },
    requiredByPolicy: { type: Boolean, required: true, immutable: true },
    requestedAt: { type: Date, required: true, immutable: true },
    releaseId: { type: Types.ObjectId, ref: "IncidentRelease", default: null },
    packetArtifactId: { type: Types.ObjectId, ref: "IncidentArtifact", default: null },
    decisionByUserId: { type: Types.ObjectId, ref: "User", default: null },
    decisionByEmail: { type: String, trim: true, lowercase: true, default: "" },
    decisionRole: { type: String, enum: INCIDENT_APPROVAL_DECISION_ROLES, default: null },
    decisionNote: { type: String, trim: true, default: "" },
    decisionScope: { type: decisionScopeSchema, default: () => ({}) },
    decidedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  {
    collection: "incident_approvals",
    strict: true,
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

incidentApprovalSchema.index({ incidentId: 1, status: 1, requestedAt: -1 });
incidentApprovalSchema.index({ releaseId: 1 });
incidentApprovalSchema.index({ decisionByUserId: 1, createdAt: -1 });

module.exports =
  mongoose.models.IncidentApproval || mongoose.model("IncidentApproval", incidentApprovalSchema);
