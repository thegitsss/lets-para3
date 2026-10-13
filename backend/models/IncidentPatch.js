const mongoose = require("mongoose");

const {
  INCIDENT_PATCH_STATUSES,
  INCIDENT_PATCH_STRATEGIES,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;

const incidentPatchSchema = new Schema(
  {
    incidentId: {
      type: Types.ObjectId,
      ref: "Incident",
      required: true,
      immutable: true,
      index: true,
    },
    investigationId: {
      type: Types.ObjectId,
      ref: "IncidentInvestigation",
      required: true,
      immutable: true,
      index: true,
    },
    attemptNumber: { type: Number, required: true, immutable: true, min: 1 },
    status: {
      type: String,
      enum: INCIDENT_PATCH_STATUSES,
      required: true,
      default: "planned",
      index: true,
    },
    patchStrategy: {
      type: String,
      enum: INCIDENT_PATCH_STRATEGIES,
      required: true,
    },
    baseCommitSha: { type: String, required: true, trim: true, immutable: true },
    gitBranch: { type: String, trim: true, default: "" },
    worktreePath: { type: String, trim: true, default: "" },
    headCommitSha: { type: String, trim: true, default: "" },
    prRef: { type: String, trim: true, default: "" },
    patchSummary: { type: String, trim: true, default: "" },
    filesTouched: { type: [String], default: [] },
    testsAdded: { type: [String], default: [] },
    testsModified: { type: [String], default: [] },
    highRiskTouched: { type: Boolean, default: false },
    requiresApproval: { type: Boolean, default: false, index: true },
    blockedReason: { type: String, trim: true, default: "" },
    failureReason: { type: String, trim: true, default: "" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  {
    collection: "incident_patches",
    strict: true,
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

incidentPatchSchema.index({ incidentId: 1, attemptNumber: 1 }, { unique: true });
incidentPatchSchema.index({ status: 1, updatedAt: -1 });
incidentPatchSchema.index({ requiresApproval: 1, status: 1 });

module.exports = mongoose.models.IncidentPatch || mongoose.model("IncidentPatch", incidentPatchSchema);
