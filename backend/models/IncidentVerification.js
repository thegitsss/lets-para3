const mongoose = require("mongoose");

const {
  INCIDENT_VERIFICATION_STATUSES,
  INCIDENT_VERIFICATION_LEVELS,
  INCIDENT_VERIFICATION_CHECK_KEYS,
  INCIDENT_VERIFICATION_CHECK_STATUSES,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;

const requiredCheckSchema = new Schema(
  {
    key: {
      type: String,
      enum: INCIDENT_VERIFICATION_CHECK_KEYS,
      required: true,
      immutable: true,
    },
    required: { type: Boolean, required: true, default: true },
    status: {
      type: String,
      enum: INCIDENT_VERIFICATION_CHECK_STATUSES,
      required: true,
      default: "pending",
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    artifactId: { type: Types.ObjectId, ref: "IncidentArtifact", default: null },
    details: { type: String, trim: true, default: "" },
  },
  { _id: false, strict: true }
);

const incidentVerificationSchema = new Schema(
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
      enum: INCIDENT_VERIFICATION_STATUSES,
      required: true,
      default: "queued",
      index: true,
    },
    verificationLevel: {
      type: String,
      enum: INCIDENT_VERIFICATION_LEVELS,
      required: true,
    },
    requiredChecks: { type: [requiredCheckSchema], required: true, default: [] },
    patchId: { type: Types.ObjectId, ref: "IncidentPatch", default: null, index: true },
    failedCheckKeys: { type: [String], default: [] },
    summary: { type: String, trim: true, default: "" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    verifierAgent: { type: String, trim: true, default: "" },
  },
  {
    collection: "incident_verifications",
    strict: true,
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

incidentVerificationSchema.index({ incidentId: 1, attemptNumber: 1 }, { unique: true });
incidentVerificationSchema.index({ status: 1, updatedAt: -1 });

module.exports =
  mongoose.models.IncidentVerification ||
  mongoose.model("IncidentVerification", incidentVerificationSchema);
