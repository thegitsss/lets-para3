const mongoose = require("mongoose");

const {
  INCIDENT_NOTIFICATION_AUDIENCES,
  INCIDENT_NOTIFICATION_CHANNELS,
  INCIDENT_NOTIFICATION_TEMPLATE_KEYS,
  INCIDENT_NOTIFICATION_STATUSES,
} = require("../utils/incidentConstants");

const { Schema, Types } = mongoose;

// Content becomes append-only once a notification reaches sent state. Later phases enforce that policy.
const incidentNotificationSchema = new Schema(
  {
    incidentId: {
      type: Types.ObjectId,
      ref: "Incident",
      required: true,
      immutable: true,
      index: true,
    },
    audience: {
      type: String,
      enum: INCIDENT_NOTIFICATION_AUDIENCES,
      required: true,
      immutable: true,
      index: true,
    },
    channel: {
      type: String,
      enum: INCIDENT_NOTIFICATION_CHANNELS,
      required: true,
      immutable: true,
    },
    templateKey: {
      type: String,
      enum: INCIDENT_NOTIFICATION_TEMPLATE_KEYS,
      required: true,
      immutable: true,
    },
    status: {
      type: String,
      enum: INCIDENT_NOTIFICATION_STATUSES,
      required: true,
      default: "queued",
      index: true,
    },
    bodyPreview: { type: String, required: true, trim: true },
    eventId: { type: Types.ObjectId, ref: "IncidentEvent", default: null },
    recipientUserId: { type: Types.ObjectId, ref: "User", default: null, index: true },
    recipientEmail: { type: String, trim: true, lowercase: true, default: "" },
    subject: { type: String, trim: true, default: "" },
    payload: { type: Schema.Types.Mixed, default: {} },
    externalMessageId: { type: String, trim: true, default: "" },
    sentAt: { type: Date, default: null },
  },
  {
    collection: "incident_notifications",
    strict: true,
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

incidentNotificationSchema.index({ incidentId: 1, createdAt: -1 });
incidentNotificationSchema.index({ recipientUserId: 1, createdAt: -1 });
incidentNotificationSchema.index({ audience: 1, status: 1, createdAt: -1 });

module.exports =
  mongoose.models.IncidentNotification ||
  mongoose.model("IncidentNotification", incidentNotificationSchema);
