const mongoose = require("mongoose");

const { Schema } = mongoose;

const SALES_PACKET_TYPES = ["account_snapshot", "outreach_draft", "objection_review", "prospect_answer"];

const citationSchema = new Schema(
  {
    sourceKey: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, default: "", maxlength: 240 },
    filePath: { type: String, trim: true, default: "" },
    excerpt: { type: String, trim: true, default: "", maxlength: 4000 },
    locator: { type: String, trim: true, default: "", maxlength: 240 },
  },
  { _id: false, strict: true }
);

const actorSchema = new Schema(
  {
    actorType: { type: String, enum: ["system", "user", "agent"], default: "system" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    label: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false, strict: true }
);

const salesDraftPacketSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: "SalesAccount", required: true, index: true },
    packetType: { type: String, enum: SALES_PACKET_TYPES, required: true, index: true },
    packetVersion: { type: Number, required: true, min: 1 },
    approvalState: { type: String, enum: ["draft", "pending_review", "approved", "rejected"], default: "pending_review", index: true },
    accountSummary: { type: String, trim: true, default: "", maxlength: 4000 },
    audienceSummary: { type: String, trim: true, default: "", maxlength: 4000 },
    approvedPositioningBlocks: { type: [Schema.Types.Mixed], default: [] },
    citations: { type: [citationSchema], default: [] },
    riskFlags: { type: [String], default: [] },
    unknowns: { type: [String], default: [] },
    whatStillNeedsSamantha: { type: [String], default: [] },
    recommendedNextStep: { type: String, trim: true, default: "", maxlength: 1000 },
    channelDraft: { type: Schema.Types.Mixed, default: {} },
    packetSummary: { type: String, trim: true, default: "", maxlength: 1200 },
    generatedBy: { type: actorSchema, default: () => ({ actorType: "system", label: "Sales Draft Service" }) },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "sales_draft_packets",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

salesDraftPacketSchema.index({ accountId: 1, packetType: 1, packetVersion: 1 }, { unique: true });
salesDraftPacketSchema.index({ approvalState: 1, updatedAt: -1 });

module.exports = mongoose.models.SalesDraftPacket || mongoose.model("SalesDraftPacket", salesDraftPacketSchema);
