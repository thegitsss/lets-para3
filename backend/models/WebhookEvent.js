const mongoose = require("mongoose");
const { Schema } = mongoose;

const WebhookEventSchema = new Schema(
  {
    provider: { type: String, default: "stripe", index: true },
    eventId: { type: String, required: true, unique: true, index: true },
    type: { type: String, default: "" },
    stripeMode: { type: String, enum: ["live", "test", "unknown"], default: "unknown", index: true },
    status: { type: String, default: "received", enum: ["received", "processing", "processed", "failed"] },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    lastAttemptAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    versionKey: false,
  }
);

WebhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model("WebhookEvent", WebhookEventSchema);
