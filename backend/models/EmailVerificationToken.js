const mongoose = require("mongoose");

// Retain consumed proofs so retries cannot repeat a verification.
// New verification links have no time limit; legacy expiring proofs still use TTL cleanup.
// Store only a digest; the bearer link and email address are never stored here.
const schema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  expiresAt: { type: Date, default: null, index: { expires: 0 } },
  consumedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model("EmailVerificationToken", schema);
