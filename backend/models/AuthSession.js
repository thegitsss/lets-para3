const mongoose = require("mongoose");

const authSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: { type: String, required: true, unique: true },
    userAgent: { type: String, default: "", maxlength: 1000 },
    ip: { type: String, default: "", maxlength: 128 },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    revokedAt: { type: Date, default: null, index: true },
    revokedReason: { type: String, default: "", maxlength: 100 },
  },
  { timestamps: true }
);

authSessionSchema.index({ userId: 1, revokedAt: 1, expiresAt: -1 });

module.exports = mongoose.model("AuthSession", authSessionSchema);
