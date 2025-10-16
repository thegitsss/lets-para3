// backend/models/Message.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

/** ----------------------------------------
 * Enums & Limits
 * -----------------------------------------*/
const MESSAGE_TYPES = ["text", "file", "audio", "system"]; // added "system" (optional)
const SENDER_ROLES = ["attorney", "paralegal", "admin"];

const MAX_TEXT_LEN = 20_000;
const MAX_TRANSCRIPT_LEN = 100_000;

/** ----------------------------------------
 * Subschemas
 * -----------------------------------------*/
const reactionSchema = new Schema(
  {
    emoji: { type: String, required: true, trim: true, maxlength: 16 }, // e.g. "👍", "❤️", ":gavel:"
    by: { type: Types.ObjectId, ref: "User", required: true, index: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const readReceiptSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User", required: true, index: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** ----------------------------------------
 * Main schema
 * -----------------------------------------*/
const messageSchema = new Schema(
  {
    // Conversation grouping
    case: { type: Types.ObjectId, ref: "Case", required: true, index: true },

    // Sender
    sender: { type: Types.ObjectId, ref: "User", required: true, index: true },
    senderRole: { type: String, enum: SENDER_ROLES, required: true },

    // Content
    type: { type: String, enum: MESSAGE_TYPES, default: "text", index: true },

    // For text messages
    content: { type: String, trim: true, maxlength: MAX_TEXT_LEN },

    // For attachments (file or audio) — keep your original fields for compatibility
    fileKey: { type: String, trim: true },    // storage key (S3, Supabase, etc.)
    fileName: { type: String, trim: true },
    fileSize: { type: Number, min: 0 },
    mimeType: { type: String, trim: true },
    transcript: { type: String, trim: true, maxlength: MAX_TRANSCRIPT_LEN }, // audio transcription

    // Threading
    replyTo: { type: Types.ObjectId, ref: "Message", default: null, index: true }, // direct reply to a message
    threadRoot: { type: Types.ObjectId, ref: "Message", default: null, index: true }, // first message of thread (for fast fetch)

    // UX features
    reactions: { type: [reactionSchema], default: [] },
    pinned: { type: Boolean, default: false },
    pinnedBy: { type: Types.ObjectId, ref: "User", default: null },

    // Delivery & edits
    deliveredAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
    editedBy: { type: Types.ObjectId, ref: "User", default: null },

    // Read receipts (richer than just IDs)
    readReceipts: { type: [readReceiptSchema], default: [] },

    // Soft delete
    deleted: { type: Boolean, default: false },
    deletedBy: { type: Types.ObjectId, ref: "User", default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    minimize: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

/** ----------------------------------------
 * Indexes
 * -----------------------------------------*/
messageSchema.index({ case: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ type: 1, createdAt: -1 });
messageSchema.index({ "reactions.by": 1, createdAt: -1 });
messageSchema.index({ "readReceipts.user": 1, createdAt: -1 });
// lightweight text search across text-bearing fields
messageSchema.index(
  { content: "text", transcript: "text", fileName: "text" },
  { name: "message_text_idx", weights: { content: 5, transcript: 3, fileName: 1 } }
);

/** ----------------------------------------
 * Virtuals
 * -----------------------------------------*/
messageSchema.virtual("hasAttachment").get(function () {
  return Boolean(this.fileKey);
});

messageSchema.virtual("isEdited").get(function () {
  return Boolean(this.editedAt);
});

/** ----------------------------------------
 * Validation
 * -----------------------------------------*/
messageSchema.pre("validate", function (next) {
  // Require appropriate payload by type
  if (this.type === "text") {
    if (!this.content || !this.content.trim()) {
      return next(new Error("Text messages must include non-empty 'content'."));
    }
  }

  if (this.type === "file") {
    if (!this.fileKey || !this.fileName) {
      return next(new Error("File messages must include 'fileKey' and 'fileName'."));
    }
  }

  if (this.type === "audio") {
    if (!this.fileKey || !this.mimeType?.startsWith("audio/")) {
      return next(new Error("Audio messages must include 'fileKey' and an 'audio/*' mimeType."));
    }
    // transcripts are optional; if present, they’re trimmed in the schema
  }

  // keep threadRoot pointing to root if replyTo exists but no explicit root set
  if (this.replyTo && !this.threadRoot) {
    this.threadRoot = this.replyTo;
  }

  next();
});

/** ----------------------------------------
 * Methods (ergonomics)
 * -----------------------------------------*/
messageSchema.methods.markDelivered = function (date = new Date()) {
  this.deliveredAt = date;
  return this;
};

messageSchema.methods.markEdited = function (editorUserId, date = new Date()) {
  this.editedAt = date;
  this.editedBy = editorUserId || this.sender;
  return this;
};

messageSchema.methods.addReaction = function (emoji, userId) {
  if (!emoji || !userId) return this;
  const exists = (this.reactions || []).some(r => r.emoji === emoji && String(r.by) === String(userId));
  if (!exists) this.reactions.push({ emoji, by: userId });
  return this;
};

messageSchema.methods.removeReaction = function (emoji, userId) {
  if (!emoji || !userId) return this;
  this.reactions = (this.reactions || []).filter(r => !(r.emoji === emoji && String(r.by) === String(userId)));
  return this;
};

messageSchema.methods.markReadBy = function (userId, when = new Date()) {
  if (!userId) return this;
  const idStr = String(userId);
  const already = (this.readReceipts || []).some(rr => String(rr.user) === idStr);
  if (!already) this.readReceipts.push({ user: userId, at: when });
  return this;
};

/** ----------------------------------------
 * Model
 * -----------------------------------------*/
module.exports = mongoose.model("Message", messageSchema);
