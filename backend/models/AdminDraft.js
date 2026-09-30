const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  kind: { type: String, enum: ['inquiry', 'account'], required: true },
  recordId: { type: mongoose.Schema.Types.ObjectId, required: true },
  content: { type: String, required: true },
  revision: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
schema.index({ owner: 1, kind: 1, recordId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.AdminDraft || mongoose.model('AdminDraft', schema);
