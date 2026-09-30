const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, default: 'scheduled' },
  runId: { type: String, required: true },
  status: { type: String, enum: ['running', 'completed', 'paused', 'failed'], required: true },
  startedAt: { type: Date, required: true },
  finishedAt: { type: Date, default: null },
  failedTasks: { type: [String], default: [] },
}, { timestamps: true, versionKey: false });
module.exports = mongoose.models.AutomationCycleState || mongoose.model('AutomationCycleState', schema);
