const express = require("express");
const router = express.Router();
const Job = require("../models/Job");
const Application = require("../models/Application");
const Case = require("../models/Case");
const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const applicationsRouter = require("./applications");
const { cleanTitle, cleanText, cleanBudget } = require("../utils/sanitize");
const createApplicationForJob = applicationsRouter?.createApplicationForJob;
const PRACTICE_AREAS = [
  "administrative law",
  "bankruptcy",
  "business law",
  "civil litigation",
  "commercial litigation",
  "contract law",
  "corporate law",
  "criminal defense",
  "employment law",
  "estate planning",
  "family law",
  "immigration",
  "intellectual property",
  "labor law",
  "personal injury",
  "real estate",
  "tax law",
  "technology",
  "trusts & estates",
];
const PRACTICE_AREA_LOOKUP = PRACTICE_AREAS.reduce((acc, name) => {
  acc[name.toLowerCase()] = name;
  return acc;
}, {});

// POST /jobs — Attorney posts a job
router.post("/", auth, requireRole(["attorney"]), async (req, res) => {
  try {
    const title = cleanTitle(req.body.title, 150);
    if (!title || title.length < 5) {
      return res.status(400).json({ error: "Title must be at least 5 characters." });
    }

    const description = cleanText(req.body.description || "", { max: 5000 });
    if (!description || description.length < 50) {
      return res.status(400).json({ error: "Description must be at least 50 characters." });
    }

    const practiceAreaKey = cleanTitle(req.body.practiceArea || "", 120).toLowerCase();
    const practiceAreaValue = PRACTICE_AREA_LOOKUP[practiceAreaKey];
    if (!practiceAreaValue) {
      return res.status(400).json({ error: "Select a valid practice area." });
    }

    let budget;
    try {
      budget = cleanBudget(req.body.budget, { min: 50, max: 30000 });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const job = await Job.create({
      attorneyId: req.user._id,
      title,
      practiceArea: practiceAreaValue,
      description,
      budget: Math.round(budget),
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
    if (!createApplicationForJob) {
      return res.status(500).json({ error: "Applications service unavailable" });
    }
    const application = await createApplicationForJob(req.params.jobId, req.user, req.body?.coverLetter || "");
    res.status(201).json(application);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
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
