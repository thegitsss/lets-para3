const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true },
  caseId: { type: mongoose.Schema.Types.ObjectId, required: true },
  requestId: { type: String, required: true },
  // A refreshed page can issue a different UUID for the same durable transfer.
  // Retain each accepted alias so it cannot later identify different inputs.
  requestIds: { type: [String], default: undefined },
  fingerprint: { type: String, required: true },
  direction: { type: String, enum: ['import', 'export'], required: true },
  status: { type: String, enum: ['preparing', 'created', 'uploaded', 'recorded', 'uncertain'], default: 'preparing' },
  fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
  payload: { type: String, default: '', select: false },
  result: { type: String, default: '', select: false },
  leaseToken: { type: String, default: '' },
  leaseUntil: { type: Date, default: null },
}, { timestamps: true });
schema.index({ ownerId: 1, requestId: 1 }, { unique: true });
schema.index({ ownerId: 1, direction: 1, fingerprint: 1 }, { unique: true });
schema.index({ ownerId: 1, requestIds: 1 }, { unique: true, partialFilterExpression: { requestIds: { $exists: true } } });
module.exports = mongoose.model('ClioTransfer', schema);
