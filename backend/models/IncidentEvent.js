const mongoose = require("mongoose");

const {
  INCIDENT_EVENT_TYPES,
  INCIDENT_ACTOR_TYPES,
  INCIDENT_REPORTER_ROLES,
  INCIDENT_AGENT_ROLES,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;

const actorSchema = new Schema(
  {
    type: {
      type: String,
      enum: INCIDENT_ACTOR_TYPES,
      required: true,
      immutable: true,
    },
    userId: { type: Types.ObjectId, ref: "User", default: null },
    role: { type: String, enum: INCIDENT_REPORTER_ROLES, default: null },
    agentRole: { type: String, enum: INCIDENT_AGENT_ROLES, default: null },
  },
  { _id: false, strict: true }
);

// Incident events are append-only. Updates should not be performed after insertion.
const incidentEventSchema = new Schema(
  {
    incidentId: {
      type: Types.ObjectId,
      ref: "Incident",
      required: true,
      immutable: true,
      index: true,
    },
    seq: { type: Number, required: true, immutable: true, min: 1 },
    eventType: {
      type: String,
      enum: INCIDENT_EVENT_TYPES,
      required: true,
      immutable: true,
      index: true,
    },
    actor: { type: actorSchema, required: true },
    summary: { type: String, required: true, trim: true },
    fromState: { type: String, trim: true, default: "" },
    toState: { type: String, trim: true, default: "" },
    detail: { type: Schema.Types.Mixed, default: {} },
    artifactIds: [{ type: Types.ObjectId, ref: "IncidentArtifact", default: undefined }],
  },
  {
    collection: "incident_events",
    strict: true,
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
  }
);

incidentEventSchema.index({ incidentId: 1, seq: 1 }, { unique: true });
incidentEventSchema.index({ incidentId: 1, createdAt: -1 });
incidentEventSchema.index({ eventType: 1, createdAt: -1 });

module.exports =
  mongoose.models.IncidentEvent || mongoose.model("IncidentEvent", incidentEventSchema);
