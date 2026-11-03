const mongoose = require('mongoose');
// A revision-bound preparation cache and execution lease, never a replacement
// for the application's, inquiry's or matter's authoritative domain state.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  kind: { type: String, enum: ['application', 'inquiry', 'matter'], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceRevision: { type: String, required: true },
  status: { type: String, enum: ['pending', 'running', 'prepared', 'failed', 'obsolete'], required: true, default: 'pending' },
  attempts: { type: Number, default: 0, min: 0 },
  claimId: { type: String, default: '' },
  leaseUntil: { type: Date, default: null },
  nextAttemptAt: { type: Date, default: Date.now },
  preparedAt: { type: Date, default: null },
  requiresOwner: { type: Boolean, default: true },
  encryptedResult: { type: String, default: '', select: false },
  failure: { type: String, default: '', maxlength: 400 },
}, { timestamps: true, versionKey: false });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
schema.index({ kind: 1, sourceId: 1 });
module.exports = mongoose.models.AdminWorkPreparation || mongoose.model('AdminWorkPreparation', schema);
