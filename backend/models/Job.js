const mongoose = require("mongoose");

const JobSchema = new mongoose.Schema({
  caseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Case",
    default: null,
  },
  attorneyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  title: { type: String, required: true },
  practiceArea: { type: String, required: true },
  description: { type: String, required: true },
    requirements: { type: [{ type: String, trim: true, maxlength: 200 }], default: [], validate: value => value.length <= 12 },
  state: { type: String, trim: true, maxlength: 200, default: "" },
  locationState: { type: String, trim: true, maxlength: 200, default: "" },
  experiencePreference: { type: String, trim: true, maxlength: 200, default: "" },
  minimumYearsExperience: { type: Number, min: 0, max: 80, default: 0 },

  budget: {
    type: Number,
    required: true,
    min: 1,
  },

  status: {
    type: String,
    enum: ["open", "in_review", "assigned", "closed"],
    default: "open",
  },

  applicantsCount: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
});

JobSchema.index({ status: 1, createdAt: -1 });

// Discovery joins include both BSON and retained string Case references. Its
// simple-collation lookup cannot rely on the ObjectId-only unique index below.
JobSchema.index({ caseId: 1, status: 1, createdAt: -1, _id: -1 }, { name: 'discovery_case_reference', collation: { locale: 'simple' } });

// Inventory joins preserve BSON and legacy string references under the same
// comparison rules used for the complete Matter and Home inventories.
JobSchema.index({ _id: 1, caseId: 1 }, { name: 'inventory_job_identity_en', collation: { locale: 'en', strength: 3 } });
JobSchema.index({ caseId: 1, _id: 1 }, { name: 'inventory_case_reference_en', collation: { locale: 'en', strength: 3 } });

JobSchema.index(
  { caseId: 1 },
  {
    unique: true,
    partialFilterExpression: { caseId: { $type: "objectId" } },
  }
);

module.exports = mongoose.model("Job", JobSchema);
