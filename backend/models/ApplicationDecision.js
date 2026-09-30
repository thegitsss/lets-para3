const mongoose = require("mongoose");
// Durable acknowledgement of one reviewed decision. No document contents or
// cover letters; retained with the application's decision history.
const schema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, required: true },
  applicantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  applicationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  requestId: { type: String, required: true },
  action: { type: String, enum: ["star", "unstar", "shortlist", "return", "reject"], required: true },
  revision: { type: String, required: true },
  status: { type: String, required: true },
  starred: { type: Boolean, required: true },
  recordedAt: { type: Date, required: true },
}, { versionKey: false });
schema.index({ ownerId: 1, requestId: 1 }, { unique: true });
schema.index({ caseId: 1, applicantId: 1, recordedAt: -1 });
module.exports = mongoose.model("ApplicationDecision", schema);
