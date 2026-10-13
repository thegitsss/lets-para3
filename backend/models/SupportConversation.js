const mongoose = require("mongoose");

const {
  SUPPORT_CONVERSATION_STATUSES,
  SUPPORT_REQUESTER_ROLES,
  SUPPORT_SURFACES,
} = require("../services/support/constants");

const { Schema } = mongoose;

const supportConversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: SUPPORT_REQUESTER_ROLES, default: "unknown", index: true },
    status: { type: String, enum: SUPPORT_CONVERSATION_STATUSES, default: "open", index: true },
    sourceSurface: { type: String, enum: SUPPORT_SURFACES, default: "manual", index: true },
    sourcePage: { type: String, trim: true, default: "", maxlength: 500 },
    pageContext: { type: Schema.Types.Mixed, default: {} },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastCategory: { type: String, trim: true, default: "", maxlength: 120 },
    welcomeSentAt: { type: Date, default: null },
    escalation: {
      requested: { type: Boolean, default: false },
      requestedAt: { type: Date, default: null },
      ticketId: { type: Schema.Types.ObjectId, ref: "SupportTicket", default: null },
      note: { type: String, trim: true, default: "", maxlength: 2000 },
    },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "support_conversations",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

supportConversationSchema.index(
  { userId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "open" } }
);
supportConversationSchema.index({ userId: 1, updatedAt: -1 });
supportConversationSchema.index({ lastMessageAt: -1 });

module.exports =
  mongoose.models.SupportConversation ||
  mongoose.model("SupportConversation", supportConversationSchema);
