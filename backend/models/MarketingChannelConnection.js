const mongoose = require("mongoose");

const {
  MARKETING_CHANNEL_CONNECTION_STATUSES,
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

const marketingChannelConnectionSchema = new Schema(
  {
    channelKey: { type: String, enum: MARKETING_PUBLISHING_CHANNELS, required: true, unique: true, index: true },
    provider: { type: String, trim: true, required: true, maxlength: 60, default: "linkedin" },
    status: {
      type: String,
      enum: MARKETING_CHANNEL_CONNECTION_STATUSES,
      default: "not_connected",
      index: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    memberId: { type: String, trim: true, default: "", maxlength: 120 },
    memberUrn: { type: String, trim: true, default: "", maxlength: 240 },
    memberName: { type: String, trim: true, default: "", maxlength: 240 },
    organizationId: { type: String, trim: true, default: "", maxlength: 120 },
    organizationUrn: { type: String, trim: true, default: "", maxlength: 240 },
    organizationName: { type: String, trim: true, default: "", maxlength: 240 },
    encryptedAccessToken: { type: String, trim: true, default: "" },
    accessTokenLast4: { type: String, trim: true, default: "", maxlength: 16 },
    tokenExpiresAt: { type: Date, default: null },
    scopeSnapshot: { type: [String], default: [] },
    apiVersion: { type: String, trim: true, default: "", maxlength: 40 },
    authorizationAction: { type: String, trim: true, default: "", maxlength: 120 },
    authorizationGranted: { type: Boolean, default: false },
    discoveredOrganizations: { type: [Schema.Types.Mixed], default: [] },
    lastValidatedAt: { type: Date, default: null },
    lastValidationStatus: { type: String, trim: true, default: "", maxlength: 60 },
    lastValidationNote: { type: String, trim: true, default: "", maxlength: 1000 },
    oauthStateHash: { type: String, trim: true, default: "", maxlength: 128, index: true },
    oauthStateExpiresAt: { type: Date, default: null },
    oauthRequestedBy: { type: actorSchema, default: null },
    oauthRequestedAt: { type: Date, default: null },
    oauthLastCompletedAt: { type: Date, default: null },
    oauthLastError: { type: String, trim: true, default: "", maxlength: 1000 },
    lastPublishSucceededAt: { type: Date, default: null },
    lastPublishFailedAt: { type: Date, default: null },
    lastPublishError: { type: String, trim: true, default: "", maxlength: 2000 },
    updatedBy: { type: actorSchema, default: () => ({ actorType: "system", label: "System" }) },
  },
  {
    collection: "marketing_channel_connections",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

marketingChannelConnectionSchema.index({ channelKey: 1, isActive: 1 });

module.exports =
  mongoose.models.MarketingChannelConnection ||
  mongoose.model("MarketingChannelConnection", marketingChannelConnectionSchema);
