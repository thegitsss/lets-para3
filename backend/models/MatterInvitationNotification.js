const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  kind: { type: String, enum: ['sent', 'accepted', 'declined', 'revoked'], required: true },
  caseId: { type: Schema.Types.ObjectId, required: true },
  invitationKey: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  userId: { type: Schema.Types.ObjectId, required: true },
  ownerId: { type: Schema.Types.ObjectId, required: true },
  actorUserId: { type: Schema.Types.ObjectId, required: true },
  paralegalId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['pending', 'sending', 'accepted', 'failed', 'unknown', 'disabled', 'skipped'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  claim: String,
  claimedAt: Date,
  acceptedAt: Date,
  failure: { type: String, default: '' },
}, { timestamps: true });
schema.index({ caseId: 1, invitationKey: 1, kind: 1, userId: 1 }, { unique: true });
schema.index({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 });
module.exports = mongoose.model('MatterInvitationNotification', schema);
