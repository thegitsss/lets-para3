// backend/routes/caseTasks.js
const router = require("express").Router({ mergeParams: true });
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const ensureCaseParticipant = require("../middleware/ensureCaseParticipant");

// CSRF (enabled in production or when ENABLE_CSRF=true)
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

const Task = require("../models/Task");

function assertEscrowFunded(req, res) {
  const escrowId = req.case?.escrowIntentId;
  const escrowStatus = String(req.case?.escrowStatus || "").toLowerCase();
  if (escrowId && escrowStatus === "funded") return true;
  res.status(403).json({ error: "Work begins once payment is secured." });
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

// All task routes require auth + approval + being a participant on the case
router.use(verifyToken);
router.use(requireApproved);
router.use(requireRole("attorney", "paralegal"));
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
    if (!assertTasksUnlocked(req, res)) return;
    if (!assertEscrowFunded(req, res)) return;
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
    if (!assertTasksUnlocked(req, res)) return;
    if (!assertEscrowFunded(req, res)) return;
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
