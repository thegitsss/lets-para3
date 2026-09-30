const mongoose = require('mongoose');
const { Schema } = mongoose;

// Receipts share their conversation's retention lifetime. They are removed by
// support history pruning, rather than expiring independently of retained turns.
const schema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  conversationId: { type: Schema.Types.ObjectId, ref: 'SupportConversation', required: true },
  role: { type: String, required: true },
  requestId: { type: String, required: true },
  action: { type: String, enum: ['send', 'restart', 'escalate'], required: true },
  fingerprint: { type: String, required: true, select: false },
  input: { type: Schema.Types.Mixed, default: null, select: false },
  state: { type: String, enum: ['pending', 'succeeded', 'retryable', 'failed'], default: 'pending' },
  active: { type: Boolean, default: false },
  claimToken: { type: String, default: '', select: false },
  leaseExpiresAt: { type: Date, default: null },
  phase: { type: String, default: 'accepted' },
  fence: { type: Number, default: 0 },
  userMessageId: { type: Schema.Types.ObjectId, default: null },
  assistantMessageId: { type: Schema.Types.ObjectId, default: null },
  prepared: { type: Schema.Types.Mixed, default: null, select: false },
  result: { type: Schema.Types.Mixed, default: null, select: false },
  error: { code: { type: String, default: '' }, message: { type: String, default: '' } },
}, { collection: 'support_mutations', timestamps: true, minimize: false });

schema.index({ ownerId: 1, requestId: 1 }, { unique: true });
schema.index({ ownerId: 1, active: 1 }, { unique: true, partialFilterExpression: { active: true } });
schema.index({ conversationId: 1 });

module.exports = mongoose.models.SupportMutation || mongoose.model('SupportMutation', schema);
