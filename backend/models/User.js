const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['attorney', 'paralegal', 'admin'],
    required: true
  },
  barNumber: {
    type: String // for attorneys
  },
  resumeURL: {
    type: String // for paralegals
  },
  certURL: {
    type: String // for paralegals
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  bio: { type: String, default: '' },
availability: { type: Boolean, default: true },
resumeURL: { type: String, default: '' },
certificateURL: { type: String, default: '' }
});

module.exports = mongoose.model('User', userSchema);

audit = [{
  adminId: { type: Schema.Types.ObjectId, ref: 'User' },
  action: String,
  date: { type: Date, default: Date.now }
}];

