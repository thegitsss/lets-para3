const mongoose = require("mongoose");

const {
  MARKETING_PUBLISH_INTENT_STATUSES,
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

const marketingPublishIntentSchema = new Schema(
  {
    packetId: { type: Schema.Types.ObjectId, ref: "MarketingDraftPacket", required: true, index: true },
    briefId: { type: Schema.Types.ObjectId, ref: "MarketingBrief", default: null, index: true },
    cycleId: { type: Schema.Types.ObjectId, ref: "MarketingPublishingCycle", default: null, index: true },
    channelKey: { type: String, enum: MARKETING_PUBLISHING_CHANNELS, required: true, index: true },
    provider: { type: String, trim: true, required: true, maxlength: 60, default: "linkedin" },
    status: {
      type: String,
      enum: MARKETING_PUBLISH_INTENT_STATUSES,
      default: "queued",
      index: true,
    },
    requestedBy: { type: actorSchema, default: () => ({ actorType: "system", label: "System" }) },
    publishSnapshot: { type: Schema.Types.Mixed, default: {} },
    connectionSnapshot: { type: Schema.Types.Mixed, default: {} },
    latestAttemptId: { type: Schema.Types.ObjectId, ref: "MarketingPublishAttempt", default: null },
    providerResourceId: { type: String, trim: true, default: "", maxlength: 240 },
    providerResourceUrn: { type: String, trim: true, default: "", maxlength: 240 },
    publishedAt: { type: Date, default: null },
    permalink: { type: String, trim: true, default: "", maxlength: 1000 },
    failureClass: { type: String, trim: true, default: "", maxlength: 60 },
    failureReason: { type: String, trim: true, default: "", maxlength: 4000 },
    retryEligible: { type: Boolean, default: false },
  },
  {
    collection: "marketing_publish_intents",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingPublishIntentSchema.index({ packetId: 1, channelKey: 1, createdAt: -1 });
marketingPublishIntentSchema.index({ status: 1, channelKey: 1, createdAt: -1 });

module.exports =
  mongoose.models.MarketingPublishIntent ||
  mongoose.model("MarketingPublishIntent", marketingPublishIntentSchema);
