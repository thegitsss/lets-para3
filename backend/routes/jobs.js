const express = require("express");
const router = express.Router();
const Job = require("../models/Job");
const Application = require("../models/Application");
const Case = require("../models/Case");
const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");

// POST /jobs — Attorney posts a job
router.post("/", auth, requireRole(["attorney"]), async (req, res) => {
  try {
    const job = await Job.create({
      attorneyId: req.user._id,
      title: req.body.title,
      practiceArea: req.body.practiceArea,
      description: req.body.description,
      budget: req.body.budget,
    });

    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /jobs/open — paralegals view available jobs
router.get("/open", auth, requireRole(["paralegal"]), async (req, res) => {
  try {
    const jobs = await Job.find({ status: "open" }).populate(
      "attorneyId",
      "firstName lastName email role"
    );
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /jobs/my — attorney views their posted jobs
router.get("/my", auth, requireRole(["attorney"]), async (req, res) => {
  try {
    const jobs = await Job.find({ attorneyId: req.user._id });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /jobs/:jobId/apply — paralegal applies
router.post("/:jobId/apply", auth, requireRole(["paralegal"]), async (req, res) => {
  try {
    const application = await Application.create({
      jobId: req.params.jobId,
      paralegalId: req.user._id,
      coverLetter: req.body.coverLetter,
    });

    await Job.findByIdAndUpdate(req.params.jobId, { $inc: { applicantsCount: 1 } });

    res.json(application);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /jobs/:jobId/hire/:paralegalId — attorney hires → case created
router.post("/:jobId/hire/:paralegalId", auth, requireRole(["attorney"]), async (req, res) => {
  try {
    const { jobId, paralegalId } = req.params;
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // create case
    const newCase = await Case.create({
      jobId,
      attorneyId: job.attorneyId,
      paralegalId,
      title: job.title,
      details: job.description,
      practiceArea: job.practiceArea,
      status: "open",
    });

    // close job
    await Job.findByIdAndUpdate(jobId, { status: "assigned" });

    res.json(newCase);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
