const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['signup','contact','human','email','overdue'], required: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
  dueAt: Date,
  recipient: String,
  status: { type: String, enum: ['pending','sending','accepted','failed','unknown','disabled','skipped'], default: 'pending' },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  claim: String,
  claimedAt: Date,
  acceptedAt: Date,
  failure: String,
}, { timestamps: true, versionKey: false });
schema.index({ status: 1, nextAttemptAt: 1 });
module.exports = mongoose.model('AdminCommunicationAlert', schema);
