const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  provider: { type: String, enum: ['google', 'microsoft'], required: true },
  credentials: { type: String, select: false, default: '' },
  accountId: { type: String, default: '' },
  authVersion: { type: Number, required: true },
  revision: { type: String, required: true },
  expiresAt: Date,
  disconnectedAt: { type: Date, default: null },
  needsReconnect: { type: Boolean, default: false },
  lease: { type: String, default: '' },
  leaseUntil: { type: Date, default: null },
  lastSyncedAt: Date,
  lastError: { type: String, default: '' },
}, { timestamps: true });
schema.index({ ownerId: 1, provider: 1 }, { unique: true });
module.exports = mongoose.model('CalendarConnection', schema);
