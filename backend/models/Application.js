// backend/models/Application.js
const mongoose = require("mongoose");

const ApplicationSchema = new mongoose.Schema(
  {
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: "Case", index: true, default: null },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", index: true, default: null },
    paralegalId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    coverLetter: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["submitted", "reviewed", "rejected", "accepted"],
      default: "submitted",
      index: true,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

module.exports = mongoose.model("Application", ApplicationSchema);
