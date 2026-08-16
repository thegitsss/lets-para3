const mongoose = require("mongoose");

const authChallengeSchema = new mongoose.Schema(
  {
    challengeId: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    purpose: {
      type: String,
      required: true,
      enum: ["passkey_registration", "passkey_authentication", "totp_enrollment"],
      index: true,
    },
    challenge: { type: String, required: true, select: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}), select: false },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    consumedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

authChallengeSchema.index({ userId: 1, purpose: 1, consumedAt: 1, expiresAt: -1 });

module.exports = mongoose.model("AuthChallenge", authChallengeSchema);
