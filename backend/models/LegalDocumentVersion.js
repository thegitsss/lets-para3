const mongoose = require("mongoose");

// Public policy copies, never user or client content. No TTL: an acceptance
// receipt must continue to identify the actual text after later deployments.
const schema = new mongoose.Schema({
  _id: { type: String, default: function () { return `${this.kind}:${this.hash}`; }, immutable: true },
  kind: { type: String, enum: ["terms", "privacy"], required: true, immutable: true },
  version: { type: String, required: true, immutable: true },
  hash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  html: { type: String, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ kind: 1, hash: 1 }, { unique: true });
module.exports = mongoose.models.LegalDocumentVersion || mongoose.model("LegalDocumentVersion", schema);
