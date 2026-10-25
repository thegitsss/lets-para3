const mongoose = require('mongoose');
const { Schema } = mongoose;
const schema = new Schema({
  kind: { type: String, enum: ['created', 'updated', 'deleted', 'edits_requested', 'review_requested'], required: true },
  caseId: { type: Schema.Types.ObjectId, required: true },
  eventKey: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  stateKey: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  userId: { type: Schema.Types.ObjectId, required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  actorUserId: { type: Schema.Types.ObjectId, required: true },
  // Removal has no live Matter. Retain only the original recipient's removal
  // explanation; never copy the deleted Matter or its applications into email state.
  removedTitle: String, removalReason: String, removalMessage: String,
  status: { type: String, enum: ['pending', 'sending', 'accepted', 'failed', 'unknown', 'disabled', 'skipped'], default: 'pending' },
  attempts: { type: Number, default: 0 }, nextAttemptAt: { type: Date, default: Date.now },
  claim: String, claimedAt: Date, acceptedAt: Date, failure: { type: String, default: '' },
}, { timestamps: true });
schema.index({ caseId: 1, eventKey: 1, kind: 1, userId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model('MatterPostingNotification', schema);
