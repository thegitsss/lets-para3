// backend/routes/caseTasks.js
const router = require("express").Router({ mergeParams: true });
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");
const csrfProtection = (_req, _res, next) => next();

const Task = require("../models/Task");

// All task routes require auth + being a participant on the case
router.use(verifyToken);
router.use(requireRole(["attorney", "paralegal"]));
router.use(ensureCaseParticipant());

// GET /api/cases/:caseId/tasks
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const caseId = req.params.caseId;
    const tasks = await Task.find({ caseId }).sort({ createdAt: -1 }).lean();
    res.json({ tasks });
  })
);

// POST /api/cases/:caseId/tasks
router.post(
  "/",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { title, description, dueDate, status } = req.body;
    const caseId = req.params.caseId;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: "Title is required." });
    }

    const created = await Task.create({
      caseId,
      paralegalId: req.user.id,
      title: title.trim(),
      description: description || "",
      dueDate: dueDate || null,
      status: status || "todo",
    });

    res.status(201).json({ task: created });
  })
);

// PATCH /api/cases/:caseId/tasks/:taskId
router.patch(
  "/:taskId",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { taskId } = req.params;
    const updates = req.body;

    const task = await Task.findById(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });

    Object.assign(task, updates);
    await task.save();

    res.json({ task });
  })
);

module.exports = router;
