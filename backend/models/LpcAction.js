const mongoose = require("mongoose");

const { Schema } = mongoose;

const LPC_ACTION_TYPES = Object.freeze(["founder_alert", "lifecycle_follow_up"]);
const LPC_ACTION_STATUSES = Object.freeze(["open", "resolved", "dismissed"]);
const LPC_ACTION_PRIORITIES = Object.freeze(["watch", "normal", "high", "urgent"]);

const actorSchema = new Schema(
  {
    actorType: { type: String, enum: ["system", "user", "agent"], default: "system" },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    label: { type: String, trim: true, default: "", maxlength: 240 },
  },
  { _id: false, strict: true }
);

const subjectSchema = new Schema(
  {
    entityType: { type: String, required: true, trim: true, maxlength: 120 },
    entityId: { type: String, required: true, trim: true, maxlength: 120 },
    publicId: { type: String, trim: true, default: "", maxlength: 120 },
  },
  { _id: false, strict: true }
);

const relatedSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    caseId: { type: Schema.Types.ObjectId, ref: "Case", default: null },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", default: null },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", default: null },
    incidentId: { type: Schema.Types.ObjectId, ref: "Incident", default: null },
    supportTicketId: { type: Schema.Types.ObjectId, ref: "SupportTicket", default: null },
    knowledgeItemId: { type: Schema.Types.ObjectId, ref: "KnowledgeItem", default: null },
    knowledgeRevisionId: { type: Schema.Types.ObjectId, ref: "KnowledgeRevision", default: null },
    marketingBriefId: { type: Schema.Types.ObjectId, ref: "MarketingBrief", default: null },
    marketingDraftPacketId: { type: Schema.Types.ObjectId, ref: "MarketingDraftPacket", default: null },
    salesAccountId: { type: Schema.Types.ObjectId, ref: "SalesAccount", default: null },
    salesInteractionId: { type: Schema.Types.ObjectId, ref: "SalesInteraction", default: null },
    salesDraftPacketId: { type: Schema.Types.ObjectId, ref: "SalesDraftPacket", default: null },
    approvalTaskId: { type: Schema.Types.ObjectId, ref: "ApprovalTask", default: null },
  },
  { _id: false, strict: true }
);

const lpcActionSchema = new Schema(
  {
    actionType: { type: String, enum: LPC_ACTION_TYPES, required: true, index: true },
    status: { type: String, enum: LPC_ACTION_STATUSES, default: "open", index: true },
    dedupeKey: { type: String, required: true, trim: true, maxlength: 240 },
    ownerLabel: { type: String, trim: true, default: "Samantha", maxlength: 120 },
    title: { type: String, required: true, trim: true, maxlength: 240 },
    summary: { type: String, trim: true, default: "", maxlength: 4000 },
    recommendedAction: { type: String, trim: true, default: "", maxlength: 1000 },
    priority: { type: String, enum: LPC_ACTION_PRIORITIES, default: "normal", index: true },
    subject: { type: subjectSchema, required: true },
    related: { type: relatedSchema, default: () => ({}) },
    sourceEventIds: { type: [Schema.Types.ObjectId], ref: "LpcEvent", default: [] },
    firstEventId: { type: Schema.Types.ObjectId, ref: "LpcEvent", default: null },
    latestEventId: { type: Schema.Types.ObjectId, ref: "LpcEvent", default: null },
    firstSeenAt: { type: Date, required: true, default: Date.now, index: true },
    lastSeenAt: { type: Date, required: true, default: Date.now, index: true },
    dueAt: { type: Date, default: null, index: true },
    openedBy: { type: actorSchema, default: () => ({ actorType: "system", label: "System" }) },
    resolvedAt: { type: Date, default: null, index: true },
    resolvedBy: { type: actorSchema, default: null },
    resolutionReason: { type: String, trim: true, default: "", maxlength: 500 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "lpc_actions",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

lpcActionSchema.index(
  { dedupeKey: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "open" },
  }
);
lpcActionSchema.index({ actionType: 1, status: 1, priority: 1, lastSeenAt: -1 });
lpcActionSchema.index({ "related.userId": 1, status: 1, lastSeenAt: -1 });
lpcActionSchema.index({ dueAt: 1, status: 1 });

module.exports = {
  LPC_ACTION_PRIORITIES,
  LPC_ACTION_STATUSES,
  LPC_ACTION_TYPES,
  LpcAction: mongoose.models.LpcAction || mongoose.model("LpcAction", lpcActionSchema),
};
