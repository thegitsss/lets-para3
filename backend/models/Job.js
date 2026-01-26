const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema({
  caseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Case",
    default: null,
    index: true,
  },
  attorneyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  title: { type: String, required: true },
  practiceArea: { type: String, required: true },
  description: { type: String, required: true },
  state: { type: String, trim: true, maxlength: 200, default: "" },
  locationState: { type: String, trim: true, maxlength: 200, default: "" },

  budget: {
    type: Number,
    required: true,
    min: 50,
  },

  status: {
    type: String,
    enum: ["open", "in_review", "assigned", "closed"],
    default: "open",
  },

  applicantsCount: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Job", JobSchema);
