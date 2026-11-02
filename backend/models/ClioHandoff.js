const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  draftId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'CaseDraft' },
  clioMatterId: { type: String, required: true },
  clioUserId: { type: String, required: true },
  connectionRevision: { type: String, required: true },
  requestId: { type: String, required: true },
  fingerprint: { type: String, required: true },
  payload: { type: String, required: true, select: false },
}, { timestamps: true });
schema.index({ ownerId: 1, requestId: 1 }, { unique: true });
schema.index({ ownerId: 1, draftId: 1 });
module.exports = mongoose.model('ClioHandoff', schema);
