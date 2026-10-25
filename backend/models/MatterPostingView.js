const mongoose = require('mongoose');
// A deterministic primary key makes repeat/concurrent opens idempotent even
// before secondary indexes are built. Viewer identities are never serialized.
const schema = new mongoose.Schema({
  _id: String,
  caseId: { type: mongoose.Schema.Types.ObjectId, index: true, default: null },
  jobId: { type: mongoose.Schema.Types.ObjectId, index: true, default: null },
  viewerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  firstViewedAt: { type: Date, default: Date.now },
}, { versionKey: false });
module.exports = mongoose.model('MatterPostingView', schema);
