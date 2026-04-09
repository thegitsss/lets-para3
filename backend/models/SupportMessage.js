const mongoose = require("mongoose");

const { SUPPORT_MESSAGE_SENDERS } = require("../services/support/constants");

const { Schema } = mongoose;

const supportMessageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "SupportConversation",
      required: true,
      index: true,
    },
    sender: {
      type: String,
      enum: SUPPORT_MESSAGE_SENDERS,
      required: true,
      index: true,
    },
    text: { type: String, required: true, trim: true, maxlength: 12000 },
    sourcePage: { type: String, trim: true, default: "", maxlength: 500 },
    pageContext: { type: Schema.Types.Mixed, default: {} },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  {
    collection: "support_messages",
    timestamps: true,
    versionKey: false,
    minimize: false,
  }
);

supportMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports =
  mongoose.models.SupportMessage ||
  mongoose.model("SupportMessage", supportMessageSchema);
