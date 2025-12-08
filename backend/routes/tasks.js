const router = require("express").Router({ mergeParams: true });
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const Task = require("../models/Task");

const VALID_STATUSES = ["todo", "in_progress", "review"];

router.use(verifyToken);
router.param("caseId", ensureCaseParticipant("caseId"));

router.post(
  "/:caseId/tasks",
  async (req, res, next) => {
    try {
      const { caseId } = req.params;
      const { title, description = "", dueDate, status = "todo" } = req.body || {};
      if (!title || typeof title !== "string") {
        return res.status(400).json({ error: "Title is required" });
      }
      const normalizedStatus = VALID_STATUSES.includes(status) ? status : "todo";
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
      const { taskId } = req.params;
      const updates = {};
      if (typeof req.body?.status === "string" && VALID_STATUSES.includes(req.body.status)) {
        updates.status = req.body.status;
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
