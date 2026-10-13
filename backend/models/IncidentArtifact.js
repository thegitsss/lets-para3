const mongoose = require("mongoose");

const {
  INCIDENT_ARTIFACT_TYPES,
  INCIDENT_ARTIFACT_STAGES,
  INCIDENT_ARTIFACT_CONTENT_TYPES,
  INCIDENT_ARTIFACT_STORAGE_MODES,
  INCIDENT_REDACTION_STATUSES,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;

// Artifacts are immutable evidence records linked to a specific stage.
const incidentArtifactSchema = new Schema(
  {
    incidentId: {
      type: Types.ObjectId,
      ref: "Incident",
      required: true,
      immutable: true,
      index: true,
    },
    artifactType: {
      type: String,
      enum: INCIDENT_ARTIFACT_TYPES,
      required: true,
      immutable: true,
      index: true,
    },
    stage: {
      type: String,
      enum: INCIDENT_ARTIFACT_STAGES,
      required: true,
      immutable: true,
      index: true,
    },
    label: { type: String, required: true, trim: true },
    contentType: {
      type: String,
      enum: INCIDENT_ARTIFACT_CONTENT_TYPES,
      required: true,
      immutable: true,
    },
    storageMode: {
      type: String,
      enum: INCIDENT_ARTIFACT_STORAGE_MODES,
      required: true,
      immutable: true,
    },
    investigationId: { type: Types.ObjectId, ref: "IncidentInvestigation", default: null },
    verificationId: { type: Types.ObjectId, ref: "IncidentVerification", default: null },
    releaseId: { type: Types.ObjectId, ref: "IncidentRelease", default: null },
    body: { type: Schema.Types.Mixed, default: null },
    url: { type: String, trim: true, default: "" },
    sha256: { type: String, trim: true, default: "" },
    redactionStatus: {
      type: String,
      enum: INCIDENT_REDACTION_STATUSES,
      default: "not_needed",
    },
    createdByEventId: { type: Types.ObjectId, ref: "IncidentEvent", default: null },
    createdByAgent: { type: String, trim: true, default: "" },
  },
  {
    collection: "incident_artifacts",
    strict: true,
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
  }
);

incidentArtifactSchema.index({ incidentId: 1, stage: 1, createdAt: -1 });
incidentArtifactSchema.index({ artifactType: 1, createdAt: -1 });
incidentArtifactSchema.index({ investigationId: 1 });
incidentArtifactSchema.index({ verificationId: 1 });
incidentArtifactSchema.index({ releaseId: 1 });

module.exports =
  mongoose.models.IncidentArtifact || mongoose.model("IncidentArtifact", incidentArtifactSchema);
