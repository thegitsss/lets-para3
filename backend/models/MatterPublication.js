const mongoose = require("mongoose");
// Retain this receipt after source-draft cleanup and posting deletion. Neither a
// lost response nor a retained source draft may create a second public Matter.
const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
  requestId: { type: String, required: true, immutable: true },
  draftId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  source: { type: String, enum: ["draft", "case"], default: "draft", immutable: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  fingerprint: { type: String, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });
schema.index({ owner: 1, requestId: 1 }, { unique: true });
schema.index({ owner: 1, draftId: 1 }, { unique: true });
module.exports = mongoose.model("MatterPublication", schema);
