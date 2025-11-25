const express = require("express");
const router = express.Router();
const Application = require("../models/Application");
const Job = require("../models/Job");
const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");

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

module.exports = router;
