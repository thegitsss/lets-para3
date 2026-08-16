const mongoose = require("mongoose");

const passkeyCredentialSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    credentialId: { type: String, required: true, unique: true },
    publicKey: { type: Buffer, required: true, select: false },
    counter: { type: Number, required: true, default: 0 },
    transports: { type: [String], default: [] },
    deviceType: { type: String, default: "", maxlength: 80 },
    backedUp: { type: Boolean, default: false },
    name: { type: String, default: "Passkey", trim: true, maxlength: 80 },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

passkeyCredentialSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("PasskeyCredential", passkeyCredentialSchema);
