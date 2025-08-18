const mongoose = require('mongoose');

// === Sub-Schemas ===

const commentSchema = new mongoose.Schema({
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  text: String,
  createdAt: { type: Date, default: Date.now }
});

const disputeSchema = new mongoose.Schema({
  message: { type: String, required: true },
  raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: {
    type: String,
    enum: ['open', 'resolved', 'rejected'],
    default: 'open'
  },
  comments: [commentSchema],
  createdAt: { type: Date, default: Date.now }
});

const fileSchema = new mongoose.Schema({
  filename: String,
  original: String,
  uploadedAt: { type: Date, default: Date.now }
});

const applicantSchema = new mongoose.Schema({
  paralegalId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected'],
    default: 'pending'
  },
  appliedAt: { type: Date, default: Date.now }
});

// === Main Case Schema ===

const caseSchema = new mongoose.Schema({
  stripeSessionId: {
  type: String,
  default: null,
  zoomLink: { type: String },
},
paymentReleased: {
  type: Boolean,
  default: false
},
zoomLink: {
  type: String,
  default: ''
},
  title: {
    type: String,
    required: true
  },
  details: {
    type: String,
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  status: {
    type: String,
    enum: ['open', 'in progress', 'closed'],
    default: 'open'
  },
  disputes: [disputeSchema],
  files: [fileSchema],
  applicants: [applicantSchema],
  acceptedParalegal: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Case', caseSchema);
zoomLink: { type: String }


