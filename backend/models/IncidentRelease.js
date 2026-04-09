const mongoose = require("mongoose");

const {
  INCIDENT_RELEASE_STATUSES,
  INCIDENT_POLICY_DECISIONS,
  INCIDENT_DEPLOY_PROVIDERS,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;
const DEPLOY_EVIDENCE_QUALITIES = [
  "none",
  "stub_only",
  "webhook_ack_only",
  "deploy_id_only",
  "deploy_id_and_url",
  "deploy_id_and_commit",
  "deploy_id_url_commit",
  "workspace_sync",
];

const previewVerificationCheckSchema = new Schema(
  {
    key: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "passed", "failed", "blocked", "skipped"],
      required: true,
      default: "pending",
    },
    details: { type: String, trim: true, default: "" },
    artifactId: { type: Types.ObjectId, ref: "IncidentArtifact", default: null },
  },
  { _id: false, strict: true, minimize: false }
);

const incidentReleaseSchema = new Schema(
  {
    incidentId: {
      type: Types.ObjectId,
      ref: "Incident",
      required: true,
      immutable: true,
      index: true,
    },
    verificationId: {
      type: Types.ObjectId,
      ref: "IncidentVerification",
      required: true,
      immutable: true,
      index: true,
    },
    attemptNumber: { type: Number, required: true, immutable: true, min: 1 },
    status: {
      type: String,
      enum: INCIDENT_RELEASE_STATUSES,
      required: true,
      default: "queued",
      index: true,
    },
    policyDecision: {
      type: String,
      enum: INCIDENT_POLICY_DECISIONS,
      required: true,
    },
    deployProvider: {
      type: String,
      enum: INCIDENT_DEPLOY_PROVIDERS,
      required: true,
      immutable: true,
      default: "render",
    },
    previewDeployId: { type: String, trim: true, default: "" },
    previewUrl: { type: String, trim: true, default: "" },
    previewCommitSha: { type: String, trim: true, default: "" },
    previewDeployRequestedAt: { type: Date, default: null },
    previewDeployAcknowledgedAt: { type: Date, default: null },
    previewEvidenceReceivedAt: { type: Date, default: null },
    previewEvidenceQuality: {
      type: String,
      enum: DEPLOY_EVIDENCE_QUALITIES,
      default: "none",
    },
    previewPreparedAt: { type: Date, default: null },
    previewVerifiedAt: { type: Date, default: null },
    previewVerificationStatus: {
      type: String,
      enum: ["not_started", "blocked", "failed", "passed"],
      default: "not_started",
    },
    previewVerificationSummary: { type: String, trim: true, default: "" },
    previewVerificationChecks: {
      type: [previewVerificationCheckSchema],
      default: [],
    },
    productionDeployId: { type: String, trim: true, default: "" },
    productionCommitSha: { type: String, trim: true, default: "" },
    productionDeployRequestedAt: { type: Date, default: null },
    productionDeployAcknowledgedAt: { type: Date, default: null },
    productionEvidenceReceivedAt: { type: Date, default: null },
    productionEvidenceQuality: {
      type: String,
      enum: DEPLOY_EVIDENCE_QUALITIES,
      default: "none",
    },
    productionVerifiedAt: { type: Date, default: null },
    productionAttestationStatus: {
      type: String,
      enum: ["not_started", "blocked", "failed", "passed"],
      default: "not_started",
    },
    productionAttestationSummary: { type: String, trim: true, default: "" },
    productionAttestationChecks: {
      type: [previewVerificationCheckSchema],
      default: [],
    },
    rollbackTargetDeployId: { type: String, trim: true, default: "" },
    rollbackTargetSource: {
      type: String,
      enum: ["unknown", "provider_response", "provider_header", "env_baseline", "manual"],
      default: "unknown",
    },
    rollbackTargetValidationStatus: {
      type: String,
      enum: ["not_started", "blocked", "failed", "passed"],
      default: "not_started",
    },
    rollbackTargetValidationSummary: { type: String, trim: true, default: "" },
    rollbackTargetValidationChecks: {
      type: [previewVerificationCheckSchema],
      default: [],
    },
    rollbackReason: { type: String, trim: true, default: "" },
    smokeStatus: {
      type: String,
      enum: ["pending", "passed", "failed"],
      default: "pending",
    },
    deployedAt: { type: Date, default: null },
    rollbackAt: { type: Date, default: null },
  },
  {
    collection: "incident_releases",
    strict: true,
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

incidentReleaseSchema.index({ incidentId: 1, attemptNumber: 1 }, { unique: true });
incidentReleaseSchema.index({ status: 1, updatedAt: -1 });
incidentReleaseSchema.index({ productionDeployId: 1 }, { sparse: true });

incidentReleaseSchema.pre("validate", function normalizeDeprecatedPreviewStatus(next) {
  if (this.status !== "preview_passed") {
    return next();
  }

  this.status = "preview_blocked";
  this.previewVerifiedAt = null;

  if (!this.previewVerificationStatus || this.previewVerificationStatus === "not_started" || this.previewVerificationStatus === "passed") {
    this.previewVerificationStatus = "blocked";
  }

  if (!this.previewVerificationSummary) {
    this.previewVerificationSummary =
      "Legacy preview_passed status is deprecated and is not treated as verified preview evidence.";
  }

  if (!Array.isArray(this.previewVerificationChecks) || !this.previewVerificationChecks.length) {
    this.previewVerificationChecks = [
      {
        key: "legacy_preview_status",
        status: "blocked",
        details:
          "Legacy preview_passed records are deprecated and must be re-verified before production continuation.",
        artifactId: null,
      },
    ];
  }

  return next();
});

module.exports =
  mongoose.models.IncidentRelease || mongoose.model("IncidentRelease", incidentReleaseSchema);
