const mongoose = require("mongoose");

const ApplicationSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Job",
    required: true,
  },

  paralegalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  coverLetter: { type: String, required: true },

  status: {
    type: String,
    enum: ["submitted", "viewed", "shortlisted", "accepted", "rejected"],
    default: "submitted",
  },

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Application", ApplicationSchema);
