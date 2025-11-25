const mongoose = require("mongoose");

const { Schema, Types } = mongoose;

const receiptSchema = new Schema(
  {
    user: { type: Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const MessageSchema = new Schema(
  {
    caseId: { type: Types.ObjectId, ref: "Case", required: true, index: true },
    senderId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    senderRole: { type: String, enum: ["attorney", "paralegal", "admin", "system"], default: "attorney" },

    // Message content
    type: { type: String, enum: ["text", "file", "audio", "system"], default: "text" },
    text: { type: String, trim: true },
    content: { type: Schema.Types.Mixed, default: null },
    transcript: { type: String, default: null },

    // Threads / replies
    replyTo: { type: Types.ObjectId, ref: "Message", default: null },
    threadRoot: { type: Types.ObjectId, ref: "Message", default: null },

    // Attachments
    fileKey: { type: String, default: null },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: null },
    mimeType: { type: String, default: null },

    // Reactions map: emoji -> [userIds]
    reactions: {
      type: Map,
      of: [{ type: Types.ObjectId, ref: "User" }],
      default: () => ({}),
    },

    // Read state
    readBy: [{ type: Types.ObjectId, ref: "User" }],
    readReceipts: { type: [receiptSchema], default: [] },

    // Pins / soft delete
    pinned: { type: Boolean, default: false },
    pinnedBy: { type: Types.ObjectId, ref: "User", default: null },
    deleted: { type: Boolean, default: false },
    deletedBy: { type: Types.ObjectId, ref: "User", default: null },

    // Legacy chat compatibility
    seen: { type: Boolean, default: false },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    minimize: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

MessageSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

MessageSchema.methods.markEdited = function () {
  this.updatedAt = new Date();
  return this;
};

MessageSchema.methods.addReaction = function (emoji, userId) {
  if (!emoji || !userId) return this;
  const key = String(emoji).trim();
  if (!key) return this;
  if (!this.reactions) this.reactions = new Map();
  const normalizedUserId = userId instanceof Types.ObjectId ? userId : new Types.ObjectId(userId);
  const current = Array.from(this.reactions.get(key) || []);
  const exists = current.some((id) => String(id) === String(normalizedUserId));
  if (!exists) {
    current.push(normalizedUserId);
    this.reactions.set(key, current);
  }
  return this;
};

MessageSchema.methods.removeReaction = function (emoji, userId) {
  if (!emoji || !userId || !this.reactions) return this;
  const key = String(emoji).trim();
  if (!key) return this;
  const normalizedUserId = userId instanceof Types.ObjectId ? userId : new Types.ObjectId(userId);
  const current = Array.from(this.reactions.get(key) || []);
  const filtered = current.filter((id) => String(id) !== String(normalizedUserId));
  if (filtered.length) this.reactions.set(key, filtered);
  else this.reactions.delete(key);
  return this;
};

MessageSchema.virtual("sender")
  .get(function () {
    return this.senderId;
  })
  .set(function (val) {
    this.senderId = val;
  });

MessageSchema.virtual("case")
  .get(function () {
    return this.caseId;
  })
  .set(function (val) {
    this.caseId = val;
  });

module.exports = mongoose.model("Message", MessageSchema);
