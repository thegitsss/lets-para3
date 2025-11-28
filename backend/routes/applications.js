const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Application = require("../models/Application");
const Job = require("../models/Job");
const Case = require("../models/Case");
const Notification = require("../models/Notification");
const auth = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");

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

  const application = await Application.create({
    jobId,
    paralegalId: user._id,
    coverLetter: note,
  });
  await Job.findByIdAndUpdate(jobId, { $inc: { applicantsCount: 1 } });
  return application;
}

// GET /applications/my — paralegal views jobs they've applied to
router.get("/my", auth, requireRole(["paralegal"]), async (req, res) => {
  try {
    const apps = await Application.find({ paralegalId: req.user._id })
      .sort({ createdAt: -1 })
      .populate("caseId", "title status attorney attorneyId")
      .populate("jobId", "title status attorneyId");

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

router.get("/case/:caseId", auth, requireRole(["attorney"]), async (req, res) => {
  try {
    const { caseId } = req.params;
    if (!mongoose.isValidObjectId(caseId)) {
      return res.status(400).json({ error: "Invalid case id" });
    }
    const caseDoc = await Case.findById(caseId).select("attorney attorneyId");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const ownsCase =
      (caseDoc.attorney && String(caseDoc.attorney) === String(req.user._id)) ||
      (caseDoc.attorneyId && String(caseDoc.attorneyId) === String(req.user._id));
    if (!ownsCase) return res.status(403).json({ error: "Unauthorized" });

    const apps = await Application.find({ caseId })
      .sort({ createdAt: -1 })
      .populate("paralegalId", "firstName lastName email role");
    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:caseId", auth, requireRole(["paralegal"]), async (req, res) => {
  try {
    const { caseId } = req.params;
    if (!mongoose.isValidObjectId(caseId)) {
      return res.status(400).json({ error: "Invalid case id" });
    }
    const caseDoc = await Case.findById(caseId).select("status attorney attorneyId");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (caseDoc.status !== "open") {
      return res.status(400).json({ error: "Applications are closed for this case" });
    }
    const activeExisting = await Application.findOne({
      caseId,
      paralegalId: req.user._id,
      status: { $in: ["submitted", "reviewed", "accepted"] },
    });
    if (activeExisting) {
      return res.status(400).json({ error: "You already have an application for this case." });
    }
    const coverLetter = sanitizeMessage(req.body?.coverLetter || "", { min: 20, max: 2000 });
    if (!coverLetter || coverLetter.length < 20) {
      return res.status(400).json({ error: "Cover letter must be at least 20 characters." });
    }
    const application = await Application.create({
      caseId,
      paralegalId: req.user._id,
      coverLetter,
      status: "submitted",
      createdAt: new Date(),
    });
    const ownerId = caseDoc.attorneyId || caseDoc.attorney;
    if (ownerId) {
      try {
        await Notification.create({
          userId: ownerId,
          caseId,
          title: "New Application",
          body: "A paralegal applied to your case.",
          type: "application",
        });
      } catch (notifyErr) {
        console.warn("[applications] notify attorney failed", notifyErr?.message || notifyErr);
      }
    }
    res.status(201).json(application);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/accept", auth, requireRole(["attorney"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid application id" });
    const application = await Application.findById(id);
    if (!application || !application.caseId) return res.status(404).json({ error: "Application not found" });
    const caseDoc = await Case.findById(application.caseId).select("attorney attorneyId status paralegal paralegalId");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const ownsCase =
      (caseDoc.attorney && String(caseDoc.attorney) === String(req.user._id)) ||
      (caseDoc.attorneyId && String(caseDoc.attorneyId) === String(req.user._id));
    if (!ownsCase) return res.status(403).json({ error: "Unauthorized" });

    application.status = "accepted";
    await application.save();

    caseDoc.paralegal = application.paralegalId;
    caseDoc.paralegalId = application.paralegalId;
    caseDoc.status = "in_progress";
    caseDoc.hiredAt = new Date();
    await caseDoc.save();
    try {
      await Notification.create({
        userId: application.paralegalId,
        caseId: application.caseId,
        title: "Application Accepted",
        body: "You have been selected for a case.",
        type: "application",
      });
    } catch (notifyErr) {
      console.warn("[applications] notify paralegal acceptance failed", notifyErr?.message || notifyErr);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/:id/reject", auth, requireRole(["attorney"]), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid application id" });
    const application = await Application.findById(id);
    if (!application || !application.caseId) return res.status(404).json({ error: "Application not found" });
    const caseDoc = await Case.findById(application.caseId).select("attorney attorneyId");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    const ownsCase =
      (caseDoc.attorney && String(caseDoc.attorney) === String(req.user._id)) ||
      (caseDoc.attorneyId && String(caseDoc.attorneyId) === String(req.user._id));
    if (!ownsCase) return res.status(403).json({ error: "Unauthorized" });

    application.status = "rejected";
    await application.save();
    try {
      await Notification.create({
        userId: application.paralegalId,
        caseId: application.caseId,
        title: "Application Rejected",
        body: "Your application was not selected.",
        type: "application",
      });
    } catch (notifyErr) {
      console.warn("[applications] notify paralegal rejection failed", notifyErr?.message || notifyErr);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.createApplicationForJob = createApplicationForJob;

module.exports = router;
