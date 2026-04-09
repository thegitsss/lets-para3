const mongoose = require("mongoose");

const { Schema } = mongoose;

const aiMessageSchema = new Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const aiConversationSchema = new Schema(
  {
    surface: {
      type: String,
      enum: ["public", "attorney", "paralegal"],
      required: true,
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    sessionId: { type: String, required: true, trim: true, index: true },
    messages: { type: [aiMessageSchema], default: [] },
    lastIntent: { type: String, default: null },
    status: { type: String, enum: ["open", "escalated", "closed"], default: "open" },
  },
  { timestamps: true }
);

aiConversationSchema.index({ surface: 1, sessionId: 1, userId: 1 });
aiConversationSchema.index({ status: 1, updatedAt: -1 });

module.exports =
  mongoose.models.AiConversation || mongoose.model("AiConversation", aiConversationSchema);
