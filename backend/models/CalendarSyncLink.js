const mongoose = require('mongoose');
// Links contain no provider event descriptions or credentials.
const schema = new mongoose.Schema({
  connectionId: { type: mongoose.Schema.Types.ObjectId, required: true },
  connectionRevision: { type: String, required: true },
  localId: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['event', 'matter'], required: true },
  remoteId: { type: String, required: true },
  localHash: { type: String, default: '' },
  remoteHash: { type: String, default: '' },
  etag: { type: String, default: '' },
  conflict: { type: Boolean, default: false },
  deleted: { type: Boolean, default: false },
}, { timestamps: true });
schema.index({ connectionId: 1, connectionRevision: 1, kind: 1, localId: 1 }, { unique: true });
schema.index({ connectionId: 1, connectionRevision: 1, remoteId: 1 }, { unique: true });
module.exports = mongoose.model('CalendarSyncLink', schema);
