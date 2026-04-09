const mongoose = require("mongoose");

const { Schema } = mongoose;

const LPC_EVENT_TYPES = Object.freeze([
  "user.signup.created",
  "user.approval.decided",
  "dispute.opened",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "public.contact.submitted",
  "user.profile.incomplete_window_elapsed",
  "support.submission.created",
  "support.ticket.escalated",
  "incident.created",
  "incident.resolved",
  "support.ticket.resolved",
  "marketing.brief.created",
  "sales.account.created",
  "knowledge.item.drift_detected",
  "knowledge.item.stale_due",
]);

const LPC_EVENT_FAMILIES = Object.freeze([
  "platform_user",
  "platform_case",
  "approval",
  "public_signal",
  "timed_trigger",
  "support",
  "incident",
  "marketing",
  "sales",
  "knowledge",
]);

const LPC_ACTOR_TYPES = Object.freeze(["user", "admin", "system", "agent", "webhook"]);
const LPC_SURFACES = Object.freeze(["public", "attorney", "paralegal", "admin", "system", "webhook", "email", "manual"]);
const LPC_SERVICES = Object.freeze([
  "auth",
  "admin",
  "cases",
  "disputes",
  "incidents",
  "public",
  "knowledge",
  "marketing",
  "sales",
  "support",
  "approvals",
  "lifecycle",
]);
const LPC_PRODUCERS = Object.freeze(["route", "job", "scheduler", "service"]);
const LPC_ROUTING_STATUSES = Object.freeze(["pending", "routed", "skipped", "failed"]);
const LPC_CONFIDENCE = Object.freeze(["low", "medium", "high"]);
const LPC_PRIORITY = Object.freeze(["watch", "normal", "high", "urgent"]);

const actorSchema = new Schema(
  {
    actorType: { type: String, enum: LPC_ACTOR_TYPES, default: "system", immutable: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    role: { type: String, trim: true, default: "", maxlength: 120, immutable: true },
    email: { type: String, trim: true, lowercase: true, default: "", maxlength: 320, immutable: true },
    label: { type: String, trim: true, default: "", maxlength: 240, immutable: true },
  },
  { _id: false, strict: true }
);

const subjectSchema = new Schema(
  {
    entityType: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    entityId: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    publicId: { type: String, trim: true, default: "", maxlength: 120, immutable: true },
  },
  { _id: false, strict: true }
);

const relatedSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    caseId: { type: Schema.Types.ObjectId, ref: "Case", default: null, immutable: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", default: null, immutable: true },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", default: null, immutable: true },
    incidentId: { type: Schema.Types.ObjectId, ref: "Incident", default: null, immutable: true },
    supportTicketId: { type: Schema.Types.ObjectId, ref: "SupportTicket", default: null, immutable: true },
    knowledgeItemId: { type: Schema.Types.ObjectId, ref: "KnowledgeItem", default: null, immutable: true },
    knowledgeRevisionId: { type: Schema.Types.ObjectId, ref: "KnowledgeRevision", default: null, immutable: true },
    marketingBriefId: { type: Schema.Types.ObjectId, ref: "MarketingBrief", default: null, immutable: true },
    marketingDraftPacketId: {
      type: Schema.Types.ObjectId,
      ref: "MarketingDraftPacket",
      default: null,
      immutable: true,
    },
    salesAccountId: { type: Schema.Types.ObjectId, ref: "SalesAccount", default: null, immutable: true },
    salesInteractionId: { type: Schema.Types.ObjectId, ref: "SalesInteraction", default: null, immutable: true },
    salesDraftPacketId: { type: Schema.Types.ObjectId, ref: "SalesDraftPacket", default: null, immutable: true },
    approvalTaskId: { type: Schema.Types.ObjectId, ref: "ApprovalTask", default: null, immutable: true },
  },
  { _id: false, strict: true }
);

const sourceSchema = new Schema(
  {
    surface: { type: String, enum: LPC_SURFACES, default: "system", immutable: true },
    route: { type: String, trim: true, default: "", maxlength: 500, immutable: true },
    service: { type: String, enum: LPC_SERVICES, default: "lifecycle", immutable: true },
    producer: { type: String, enum: LPC_PRODUCERS, default: "service", immutable: true },
  },
  { _id: false, strict: true }
);

const signalsSchema = new Schema(
  {
    confidence: { type: String, enum: LPC_CONFIDENCE, default: "medium", immutable: true },
    priority: { type: String, enum: LPC_PRIORITY, default: "normal", immutable: true },
    moneyRisk: { type: Boolean, default: false, immutable: true },
    authRisk: { type: Boolean, default: false, immutable: true },
    caseProgressRisk: { type: Boolean, default: false, immutable: true },
    publicFacing: { type: Boolean, default: false, immutable: true },
    founderVisible: { type: Boolean, default: false, immutable: true },
    repeatKey: { type: String, trim: true, default: "", maxlength: 240, immutable: true },
    approvalRequired: { type: Boolean, default: false, immutable: true },
  },
  { _id: false, strict: true }
);

const routingSchema = new Schema(
  {
    status: { type: String, enum: LPC_ROUTING_STATUSES, default: "pending", index: true },
    actionKeys: { type: [String], default: [] },
    lastRoutedAt: { type: Date, default: null },
    error: { type: String, trim: true, default: "", maxlength: 4000 },
  },
  { _id: false, strict: true }
);

const lpcEventSchema = new Schema(
  {
    version: { type: Number, required: true, default: 1, immutable: true },
    eventType: { type: String, enum: LPC_EVENT_TYPES, required: true, immutable: true, index: true },
    eventFamily: { type: String, enum: LPC_EVENT_FAMILIES, required: true, immutable: true, index: true },
    idempotencyKey: { type: String, trim: true, default: "", maxlength: 240, immutable: true },
    correlationId: { type: String, trim: true, default: "", maxlength: 240, immutable: true, index: true },
    causationId: { type: String, trim: true, default: "", maxlength: 240, immutable: true },
    occurredAt: { type: Date, required: true, immutable: true, index: true },
    recordedAt: { type: Date, required: true, default: Date.now, immutable: true },
    actor: { type: actorSchema, default: () => ({}) },
    subject: { type: subjectSchema, required: true },
    related: { type: relatedSchema, default: () => ({}) },
    source: { type: sourceSchema, default: () => ({}) },
    facts: { type: Schema.Types.Mixed, default: {}, immutable: true },
    signals: { type: signalsSchema, default: () => ({}) },
    routing: { type: routingSchema, default: () => ({}) },
  },
  {
    collection: "lpc_events",
    timestamps: { createdAt: true, updatedAt: true },
    versionKey: false,
    minimize: false,
  }
);

lpcEventSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $ne: "" } },
  }
);
lpcEventSchema.index({ "subject.entityType": 1, "subject.entityId": 1, occurredAt: -1 });
lpcEventSchema.index({ "related.userId": 1, occurredAt: -1 });
lpcEventSchema.index({ "related.caseId": 1, occurredAt: -1 });
lpcEventSchema.index({ "source.service": 1, eventType: 1, occurredAt: -1 });

module.exports = {
  LPC_CONFIDENCE,
  LPC_EVENT_FAMILIES,
  LPC_EVENT_TYPES,
  LPC_PRIORITY,
  LPC_ROUTING_STATUSES,
  LpcEvent: mongoose.models.LpcEvent || mongoose.model("LpcEvent", lpcEventSchema),
};
