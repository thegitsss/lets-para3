const mongoose = require('mongoose');
const { Schema } = mongoose;

// Retain only the application event identity. Resolve current recipient details
// and authorized application context when the worker prepares an email.
const schema = new Schema({
  kind: { type: String, enum: ['submitted', 'withdrawn'], default: 'submitted' },
  source: { type: String, enum: ['canonical', 'earlier'], default: 'canonical' },
  applicationId: { type: Schema.Types.ObjectId, default: null, required() { return this.source !== 'earlier'; } },
  // Preserve the existing indexed field. Withdrawal keys include their kind
  // and source identity; earlier applications do not need a fabricated ID.
  submissionKey: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  jobId: { type: Schema.Types.ObjectId, default: null, required() { return this.source !== 'earlier'; } },
  caseId: { type: Schema.Types.ObjectId, default: null },
  userId: { type: Schema.Types.ObjectId, required: true },
  paralegalId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['pending', 'sending', 'accepted', 'failed', 'unknown', 'disabled', 'skipped'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  claim: String,
  claimedAt: Date,
  acceptedAt: Date,
  failure: { type: String, default: '' },
}, { timestamps: true });
schema.index({ applicationId: 1, submissionKey: 1, userId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model('MatterApplicationNotification', schema);
