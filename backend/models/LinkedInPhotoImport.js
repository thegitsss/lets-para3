const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  sessionHash: { type: String, required: true },
  requestId: { type: String, required: true, unique: true },
  stateHash: { type: String, required: true, unique: true, select: false },
  status: { type: String, enum: ['pending', 'processing', 'ready', 'failed'], default: 'pending' },
  photo: { type: Buffer, select: false },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { timestamps: true });
module.exports = mongoose.models.LinkedInPhotoImport || mongoose.model('LinkedInPhotoImport', schema);
