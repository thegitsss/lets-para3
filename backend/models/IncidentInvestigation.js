const mongoose = require("mongoose");

const {
  INCIDENT_INVESTIGATION_STATUSES,
  INCIDENT_INVESTIGATION_TRIGGER_TYPES,
  INCIDENT_INVESTIGATION_ASSIGNEES,
  INCIDENT_REPRODUCTION_STATUSES,
  INCIDENT_CONFIDENCE_LEVELS,
  INCIDENT_HYPOTHESIS_STATUSES,
  INCIDENT_RECOMMENDED_ACTIONS,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;

const hypothesisSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    statement: { type: String, required: true, trim: true },
    confidence: { type: String, enum: INCIDENT_CONFIDENCE_LEVELS, required: true },
    selected: { type: Boolean, default: false },
    status: { type: String, enum: INCIDENT_HYPOTHESIS_STATUSES, required: true, default: "pending" },
  },
  { _id: false, strict: true }
);

const incidentInvestigationSchema = new Schema(
  {
    incidentId: {
      type: Types.ObjectId,
      ref: "Incident",
      required: true,
      immutable: true,
      index: true,
    },
    attemptNumber: { type: Number, required: true, immutable: true, min: 1 },
    status: {
      type: String,
      enum: INCIDENT_INVESTIGATION_STATUSES,
      required: true,
      default: "queued",
      index: true,
    },
    triggerType: {
      type: String,
      enum: INCIDENT_INVESTIGATION_TRIGGER_TYPES,
      required: true,
      immutable: true,
    },
    assignedAgent: {
      type: String,
      enum: INCIDENT_INVESTIGATION_ASSIGNEES,
      default: null,
    },
    rootCauseSummary: { type: String, trim: true, default: "" },
    rootCauseConfidence: { type: String, enum: INCIDENT_CONFIDENCE_LEVELS, default: null },
    reproductionStatus: {
      type: String,
      enum: INCIDENT_REPRODUCTION_STATUSES,
      default: "not_attempted",
    },
    hypotheses: { type: [hypothesisSchema], default: [] },
    impactedDomains: { type: [String], default: [] },
    suspectedRoutes: { type: [String], default: [] },
    suspectedFiles: { type: [String], default: [] },
    suspectedDeploySha: { type: String, trim: true, default: "" },
    recommendedAction: {
      type: String,
      enum: INCIDENT_RECOMMENDED_ACTIONS,
      default: null,
    },
    summaryArtifactId: { type: Types.ObjectId, ref: "IncidentArtifact", default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  {
    collection: "incident_investigations",
    strict: true,
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

incidentInvestigationSchema.index({ incidentId: 1, attemptNumber: 1 }, { unique: true });
incidentInvestigationSchema.index({ status: 1, updatedAt: -1 });
incidentInvestigationSchema.index({ reproductionStatus: 1, createdAt: -1 });

module.exports =
  mongoose.models.IncidentInvestigation ||
  mongoose.model("IncidentInvestigation", incidentInvestigationSchema);
