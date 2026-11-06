const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  provider: { type: String, enum: ['google', 'microsoft'], required: true },
  sessionHash: { type: String, required: true },
  authVersion: { type: Number, required: true },
  revision: { type: String, default: '' },
  proofKey: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('CalendarOAuthState', schema);
