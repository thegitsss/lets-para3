const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  credentials: { type: String, required: true, select: false },
  clioUserId: { type: String, required: true },
  authVersion: { type: Number, required: true },
  revision: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  connectedAt: { type: Date, default: Date.now },
  disconnectedAt: { type: Date, default: null },
  needsReconnect: { type: Boolean, default: false },
  refreshLease: { type: String, default: '' },
  refreshLeaseUntil: { type: Date, default: null },
}, { timestamps: true });
module.exports = mongoose.model('ClioConnection', schema);
