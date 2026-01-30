const mongoose = require("mongoose");

const profileSnapshotSchema = new mongoose.Schema(
  {
    location: { type: String, trim: true, maxlength: 300, default: "" },
    availability: { type: String, trim: true, maxlength: 200, default: "" },
    yearsExperience: { type: Number, min: 0, max: 80, default: null },
    languages: [{ type: String, trim: true }],
    specialties: [{ type: String, trim: true }],
    bio: { type: String, trim: true, maxlength: 1_000, default: "" },
    profileImage: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

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
  resumeURL: { type: String, trim: true, default: "" },
  linkedInURL: { type: String, trim: true, default: "" },
  profileSnapshot: { type: profileSnapshotSchema, default: () => ({}) },

  status: {
    type: String,
    enum: ["submitted", "viewed", "shortlisted", "accepted", "rejected"],
    default: "submitted",
  },
  starredBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Application", ApplicationSchema);
