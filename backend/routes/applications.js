const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Application = require("../models/Application");
const Job = require("../models/Job");
const User = require("../models/User");
const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const { shapeParalegalSnapshot } = require("../utils/profileSnapshots");

function sanitizeMessage(value, { min = 0, max = 2000 } = {}) {
  if (typeof value !== "string") return "";
  const stripped = value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!stripped) return "";
  return stripped.slice(0, Math.max(1, max));
}

async function createApplicationForJob(jobId, user, coverLetter) {
  if (!mongoose.isValidObjectId(jobId)) {
    const err = new Error("Invalid job id");
    err.status = 400;
    throw err;
  }
  if (!user || String(user.role).toLowerCase() !== "paralegal") {
    const err = new Error("Only paralegals may apply to jobs");
    err.status = 403;
    throw err;
  }

  const job = await Job.findById(jobId);
  if (!job) {
    const err = new Error("Job not found");
    err.status = 404;
    throw err;
  }
  if (job.status !== "open") {
    const err = new Error("Applications are closed for this job");
    err.status = 400;
    throw err;
  }

  const existing = await Application.findOne({ jobId, paralegalId: user._id });
  if (existing) {
    const err = new Error("You have already applied to this job");
    err.status = 400;
    throw err;
  }

  const note = sanitizeMessage(coverLetter, { min: 20, max: 2000 });
  if (note.length < 20) {
    const err = new Error("Cover letter must be at least 20 characters.");
    err.status = 400;
    throw err;
  }

  const applicant = await User.findById(user._id).select(
    "role resumeURL linkedInURL availability availabilityDetails location languages specialties yearsExperience bio profileImage avatarURL"
  );
  if (!applicant) {
    const err = new Error("Unable to load your profile details.");
    err.status = 404;
    throw err;
  }

  const application = await Application.create({
    jobId,
    paralegalId: user._id,
    coverLetter: note,
    resumeURL: applicant.resumeURL || "",
    linkedInURL: applicant.linkedInURL || "",
    profileSnapshot: shapeParalegalSnapshot(applicant),
  });
  await Job.findByIdAndUpdate(jobId, { $inc: { applicantsCount: 1 } });
  return application;
}

// GET /applications/my — paralegal views jobs they've applied to
router.get("/my", auth, requireRole(["paralegal"]), async (req, res) => {
  try {
    const apps = await Application.find({ paralegalId: req.user._id })
      .populate("jobId");

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /applications/for-job/:jobId — attorney views applicants
router.get("/for-job/:jobId", auth, requireRole(["admin", "attorney"]), async (req, res) => {
  try {
    const job = await Job.findById(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const isOwner = job.attorneyId && String(job.attorneyId) === String(req.user._id);
    if (req.user.role !== "admin" && !isOwner) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const apps = await Application.find({ jobId: req.params.jobId }).populate(
      "paralegalId",
      "firstName lastName email role"
    );

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.createApplicationForJob = createApplicationForJob;

module.exports = router;
