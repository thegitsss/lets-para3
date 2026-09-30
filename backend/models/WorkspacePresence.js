const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  // One expiring hint per authenticated account and browser-context lease.
  _id: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, ref: "Case", default: null },
  surface: { type: String, default: "workspace" },
  legacy: { type: Boolean, default: false },
  revision: { type: Number, required: true },
  active: { type: Boolean, required: true },
  expiresAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
}, { versionKey: false });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ userId: 1, caseId: 1, active: 1, surface: 1, expiresAt: 1 });

module.exports = mongoose.model("WorkspacePresence", schema);
