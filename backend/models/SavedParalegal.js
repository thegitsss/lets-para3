const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  attorneyId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  paralegalId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  saved: { type: Boolean, required: true },
}, { timestamps: true });
schema.index({ attorneyId: 1, paralegalId: 1 }, { unique: true });
schema.index({ attorneyId: 1, saved: 1, updatedAt: -1, _id: -1 });
module.exports = mongoose.model('SavedParalegal', schema);
