const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  mailboxKey: { type: String, required: true },
  providerId: { type: String, required: true },
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupportTicket', index: true },
  sender: String,
  subject: String,
  content: String,
  receivedAt: Date,
  messageId: String,
  hasAttachments: Boolean,
  truncated: Boolean,
  ignored: Boolean,
  applied: { type: Boolean, default: false },
}, { timestamps: true, versionKey: false });
schema.index({ mailboxKey: 1, providerId: 1 }, { unique: true });
module.exports = mongoose.model('AdminInboundMail', schema);
