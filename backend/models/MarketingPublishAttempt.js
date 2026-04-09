const mongoose = require("mongoose");

const {
  MARKETING_PUBLISH_ATTEMPT_STATUSES,
  MARKETING_PUBLISH_FAILURE_CLASSES,
  MARKETING_PUBLISHING_CHANNELS,
} = require("../services/marketing/constants");

const { Schema } = mongoose;

const actorSchema = new Schema(
  {
    actorType: { type: String, enum: ["system", "user", "agent"], default: "system" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    label: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false, strict: true }
);

const marketingPublishAttemptSchema = new Schema(
  {
    intentId: { type: Schema.Types.ObjectId, ref: "MarketingPublishIntent", required: true, index: true },
    packetId: { type: Schema.Types.ObjectId, ref: "MarketingDraftPacket", required: true, index: true },
    channelKey: { type: String, enum: MARKETING_PUBLISHING_CHANNELS, required: true, index: true },
    provider: { type: String, trim: true, required: true, maxlength: 60, default: "linkedin" },
    attemptNumber: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: MARKETING_PUBLISH_ATTEMPT_STATUSES,
      default: "started",
      index: true,
    },
    requestedBy: { type: actorSchema, default: () => ({ actorType: "system", label: "System" }) },
    startedAt: { type: Date, default: () => new Date() },
    completedAt: { type: Date, default: null },
    requestSnapshot: { type: Schema.Types.Mixed, default: {} },
    responseSnapshot: { type: Schema.Types.Mixed, default: {} },
    failureClass: { type: String, enum: ["", ...MARKETING_PUBLISH_FAILURE_CLASSES], default: "" },
    failureReason: { type: String, trim: true, default: "", maxlength: 4000 },
    retryEligible: { type: Boolean, default: false },
    providerResourceId: { type: String, trim: true, default: "", maxlength: 240 },
    providerResourceUrn: { type: String, trim: true, default: "", maxlength: 240 },
    permalink: { type: String, trim: true, default: "", maxlength: 1000 },
  },
  {
    collection: "marketing_publish_attempts",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingPublishAttemptSchema.index({ intentId: 1, attemptNumber: 1 }, { unique: true });
marketingPublishAttemptSchema.index({ packetId: 1, createdAt: -1 });

module.exports =
  mongoose.models.MarketingPublishAttempt ||
  mongoose.model("MarketingPublishAttempt", marketingPublishAttemptSchema);
