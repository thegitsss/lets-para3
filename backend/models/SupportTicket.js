const mongoose = require("mongoose");

const {
  SUPPORT_CONFIDENCE,
  SUPPORT_OWNER_KEYS,
  SUPPORT_REQUESTER_ROLES,
  SUPPORT_SURFACES,
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_STATUSES,
} = require("../services/support/constants");

const { Schema } = mongoose;

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

const linkedIncidentSchema = new Schema(
  {
    incidentId: { type: Schema.Types.ObjectId, ref: "Incident", default: null },
    publicId: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    summary: { type: String, trim: true, default: "", maxlength: 2000 },
    relationType: { type: String, enum: ["active_issue", "resolved_learning"], default: "active_issue" },
    userVisibleStatus: { type: String, trim: true, default: "" },
  },
  { _id: false, strict: true }
);

const responsePacketSchema = new Schema(
  {
    packetVersion: { type: Number, min: 1, default: 1 },
    generatedAt: { type: Date, default: Date.now },
    recommendedReply: { type: String, trim: true, default: "", maxlength: 12000 },
    citations: { type: [citationSchema], default: [] },
    confidence: { type: String, enum: SUPPORT_CONFIDENCE, default: "low" },
    riskFlags: { type: [String], default: [] },
    neededFacts: { type: [String], default: [] },
    escalationOwner: { type: String, enum: SUPPORT_OWNER_KEYS, default: "support_ops" },
    linkedIncidents: { type: [linkedIncidentSchema], default: [] },
    advisories: { type: [String], default: [] },
  },
  { _id: false, strict: true }
);

const internalNoteSchema = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    adminName: { type: String, trim: true, default: "", maxlength: 240 },
    text: { type: String, trim: true, default: "", maxlength: 8000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false, strict: true }
);

const supportTicketSchema = new Schema(
  {
    subject: { type: String, required: true, trim: true, maxlength: 300 },
    message: { type: String, required: true, trim: true, maxlength: 20000 },
    status: { type: String, enum: SUPPORT_TICKET_STATUSES, default: "open", index: true },
    urgency: { type: String, enum: SUPPORT_CONFIDENCE, default: "medium", index: true },
    requesterRole: { type: String, enum: SUPPORT_REQUESTER_ROLES, default: "unknown", index: true },
    sourceSurface: { type: String, enum: SUPPORT_SURFACES, default: "manual", index: true },
    sourceLabel: { type: String, trim: true, default: "", maxlength: 240 },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    requesterUserId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    requesterEmail: { type: String, trim: true, lowercase: true, default: "", maxlength: 320 },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "SupportConversation", default: null, index: true },
    routePath: { type: String, trim: true, default: "", maxlength: 500 },
    caseId: { type: Schema.Types.ObjectId, ref: "Case", default: null, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: "Job", default: null, index: true },
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", default: null, index: true },
    pageContext: {
      type: Schema.Types.Mixed,
      default: {},
    },
    contextSnapshot: {
      type: Schema.Types.Mixed,
      default: {},
    },
    latestUserMessage: { type: String, trim: true, default: "", maxlength: 12000 },
    assistantSummary: { type: String, trim: true, default: "", maxlength: 12000 },
    supportFactsSnapshot: {
      type: Schema.Types.Mixed,
      default: {},
    },
    escalationReason: { type: String, trim: true, default: "", maxlength: 2000 },
    classification: {
      category: { type: String, enum: SUPPORT_TICKET_CATEGORIES, default: "general_support", index: true },
      confidence: { type: String, enum: SUPPORT_CONFIDENCE, default: "medium" },
      patternKey: { type: String, trim: true, default: "", index: true },
      matchedKnowledgeKeys: { type: [String], default: [] },
    },
    routingSuggestion: {
      ownerKey: { type: String, enum: SUPPORT_OWNER_KEYS, default: "support_ops", index: true },
      priority: { type: String, enum: ["normal", "high"], default: "normal", index: true },
      queueLabel: { type: String, trim: true, default: "", maxlength: 240 },
      reason: { type: String, trim: true, default: "", maxlength: 2000 },
    },
    riskFlags: { type: [String], default: [] },
    linkedIncidentIds: { type: [Schema.Types.ObjectId], ref: "Incident", default: [] },
    latestResponsePacket: { type: responsePacketSchema, default: () => ({}) },
    internalNotes: { type: [internalNoteSchema], default: [] },
    lastAdminReplyAt: { type: Date, default: null, index: true },
    resolutionSummary: { type: String, trim: true, default: "", maxlength: 4000 },
    resolutionIsStable: { type: Boolean, default: false, index: true },
    resolvedAt: { type: Date, default: null, index: true },
  },
  {
    collection: "support_tickets",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

supportTicketSchema.index({ status: 1, updatedAt: -1 });
supportTicketSchema.index({ urgency: 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ "classification.patternKey": 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ "routingSuggestion.ownerKey": 1, status: 1, updatedAt: -1 });
supportTicketSchema.index({ conversationId: 1, status: 1, updatedAt: -1 });

module.exports = mongoose.models.SupportTicket || mongoose.model("SupportTicket", supportTicketSchema);
