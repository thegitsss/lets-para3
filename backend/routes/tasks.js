const router = require("express").Router({ mergeParams: true });
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const Task = require("../models/Task");

const IN_PROGRESS_STATUS = "in progress";
const VALID_STATUSES = ["todo", IN_PROGRESS_STATUS, "review"];
const LEGACY_STATUSES = {
  in_progress: IN_PROGRESS_STATUS,
};

function normalizeStatus(status = "") {
  const key = String(status).trim().toLowerCase();
  return LEGACY_STATUSES[key] || (VALID_STATUSES.includes(key) ? key : "");
}

function assertEscrowFunded(req, res) {
  const escrowId = req.case?.escrowIntentId;
  const escrowStatus = String(req.case?.escrowStatus || "").toLowerCase();
  if (escrowId && escrowStatus === "funded") return true;
  res.status(403).json({ error: "Fund case to create or update tasks for this case." });
  return false;
}

function assertTasksUnlocked(req, res) {
  if (req.case?.tasksLocked || req.case?.hiredAt || req.case?.paralegal || req.case?.paralegalId) {
    res.status(403).json({
      error: "Tasks are locked once a paralegal is hired. Create a new case for additional work.",
    });
    return false;
  }
  return true;
}

router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("admin", "attorney", "paralegal"));
router.param("caseId", ensureCaseParticipant("caseId"));

router.post(
  "/:caseId/tasks",
  async (req, res, next) => {
    try {
      if (!assertTasksUnlocked(req, res)) return;
      if (!assertEscrowFunded(req, res)) return;
      const { caseId } = req.params;
      const { title, description = "", dueDate, status = "todo" } = req.body || {};
      if (!title || typeof title !== "string") {
        return res.status(400).json({ error: "Title is required" });
      }
      const normalizedStatus = normalizeStatus(status) || "todo";
      const doc = await Task.create({
        caseId,
        paralegalId: req.user.id,
        title: title.trim(),
        description: typeof description === "string" ? description.trim() : "",
        dueDate: dueDate ? new Date(dueDate) : null,
        status: normalizedStatus,
      });
      return res.status(201).json(doc);
    } catch (err) {
      return next(err);
    }
  }
);

router.get(
  "/:caseId/tasks",
  async (req, res, next) => {
    try {
      const { caseId } = req.params;
      const tasks = await Task.find({ caseId: new mongoose.Types.ObjectId(caseId) })
        .sort({ createdAt: -1 })
        .lean();
      return res.json({ tasks });
    } catch (err) {
      return next(err);
    }
  }
);

router.patch(
  "/:caseId/tasks/:taskId",
  async (req, res, next) => {
    try {
      if (!assertTasksUnlocked(req, res)) return;
      if (!assertEscrowFunded(req, res)) return;
      const { taskId } = req.params;
      const updates = {};
      if (typeof req.body?.status === "string") {
        const normalized = normalizeStatus(req.body.status);
        if (normalized) updates.status = normalized;
      }
      if (!Object.keys(updates).length) {
        return res.status(400).json({ error: "No valid fields to update" });
      }
      const task = await Task.findOneAndUpdate(
        { _id: taskId },
        { $set: updates },
        { new: true }
      );
      if (!task) return res.status(404).json({ error: "Task not found" });
      return res.json(task);
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;
