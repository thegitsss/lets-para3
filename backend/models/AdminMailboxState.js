const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String,
  cursor: { type: Number, default: 1 },
  since: Date,
  lastAttemptAt: Date,
  lastCompletedAt: Date,
  lastWorkerAt: Date,
  lease: String,
  leaseUntil: Date,
  error: String,
}, { timestamps: true, versionKey: false });
module.exports = mongoose.model('AdminMailboxState', schema);
