const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  sessionHash: { type: String, required: true },
  authVersion: { type: Number, required: true },
  connectionRevision: { type: String, default: '' },
  returnCaseId: { type: mongoose.Schema.Types.ObjectId, default: null },
  returnDraftId: { type: mongoose.Schema.Types.ObjectId, default: null },
  returnToNewMatter: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
  canceledAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('ClioOAuthState', schema);
