const mongoose = require('mongoose');

// A private queue preference, never a replacement for the source record's status.
// The deterministic _id also prevents duplicate entries before secondary indexes exist.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  key: { type: String, required: true },
  sourceRevision: { type: Date, required: true },
  followUpAt: { type: Date, default: null },
  revision: { type: Number, required: true, default: 0 },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.models.AdminFollowUp || mongoose.model('AdminFollowUp', schema);
