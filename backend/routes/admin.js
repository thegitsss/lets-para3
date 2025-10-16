// backend/routes/admin.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireRole } = require("../utils/authz");
const User = require("../models/User");
const Case = require("../models/Case");
const AuditLog = require("../models/AuditLog"); // NOTE: file name fix
const sendEmail = require("../utils/email");

// -----------------------------------------
// Helpers
// -----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parsePagination(req, { maxLimit = 100, defaultLimit = 20 } = {}) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(req.query.limit, 10) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function isObjId(id) {
  return mongoose.isValidObjectId(id);
}

function pickUserSafe(u) {
  // fields safe to return to admin tools
  const {
    _id, name, email, role, status, bio, availability, emailVerified,
    lastLoginAt, lockedUntil, failedLogins, audit, createdAt, updatedAt,
    specialties, jurisdictions, skills, yearsExperience, languages,
    avatarURL, timezone, location, kycStatus, stripeCustomerId, stripeAccountId,
  } = u;
  return {
    id: _id, name, email, role, status, bio, availability, emailVerified,
    lastLoginAt, lockedUntil, failedLogins, audit, createdAt, updatedAt,
    specialties, jurisdictions, skills, yearsExperience, languages,
    avatarURL, timezone, location, kycStatus, stripeCustomerId, stripeAccountId,
  };
}

// All admin routes are protected & admin-only
router.use(verifyToken, requireRole("admin"));

/**
 * GET /api/admin/pending-users
 * Optional query: ?status=pending|approved|rejected&role=attorney|paralegal|admin&q=search&page=&limit=
 * Returns paginated users (password never selected).
 */
router.get("/pending-users", asyncHandler(async (req, res) => {
  const { status = "pending", role, q } = req.query;
  const { skip, limit, page } = parsePagination(req, { defaultLimit: 25 });

  const filter = {};
  if (["pending", "approved", "rejected"].includes(status)) filter.status = status;
  if (["attorney", "paralegal", "admin"].includes(role)) filter.role = role;
  if (q && q.trim()) {
    filter.$or = [
      { name: new RegExp(q.trim(), "i") },
      { email: new RegExp(q.trim(), "i") },
      { specialties: new RegExp(q.trim(), "i") },
      { jurisdictions: new RegExp(q.trim(), "i") },
    ];
  }

  const [items, total] = await Promise.all([
    User.find(filter).select("-password").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  res.json({
    page, limit, total, pages: Math.ceil(total / limit),
    users: items.map(pickUserSafe),
  });
}));

/**
 * PATCH /api/admin/user/:id
 * Body: { status: 'approved' | 'rejected', note? }
 * Approve or reject a user, email them, and audit.
 */
router.patch("/user/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body || {};
  if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ msg: "Invalid status" });

  const user = await User.findById(id);
  if (!user) return res.status(404).json({ msg: "User not found" });

  user.status = status;
  user.audit.push({ adminId: req.user.id, action: status, note });
  await user.save();

  // Notify (best-effort)
  try {
    await sendEmail(
      user.email,
      `Your ParaConnect account has been ${status}`,
      `Hello ${user.name || "there"}, your account has been ${status}. ${
        status === "approved" ? "You can now log in." : "Contact support if needed."
      }`
    );
  } catch (_) { /* ignore email errors */ }

  await AuditLog.logFromReq(req, "admin.user.status.update", {
    targetType: "user",
    targetId: user._id,
    meta: { status, note },
  });

  res.json({ ok: true, user: pickUserSafe(user.toObject()) });
}));

/**
 * (Alias) POST /api/admin/approve-user/:id
 * Approve via friendlier endpoint.
 */
router.post("/approve-user/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isObjId(id)) return res.status(400).json({ msg: "Invalid user id" });

  const user = await User.findByIdAndUpdate(
    id,
    { status: "approved", $push: { audit: { adminId: req.user.id, action: "approved" } } },
    { new: true }
  ).lean();

  if (!user) return res.status(404).json({ msg: "User not found" });

  try {
    await sendEmail(
      user.email,
      "Account approved",
      `Hi ${user.name || ""}, your account has been approved. You can now sign in.`
    );
  } catch (_) {}

  await AuditLog.logFromReq(req, "admin.user.status.update", {
    targetType: "user",
    targetId: user._id,
    meta: { status: "approved" },
  });

  res.json({ ok: true, user: pickUserSafe(user) });
}));

/**
 * GET /api/admin/cases
 * Optional query: ?status=&attorney=&paralegal=&q=&page=&limit=
 * Returns paginated cases with parties populated (name/email/role/status).
 */
router.get("/cases", asyncHandler(async (req, res) => {
  const { status, attorney, paralegal, q } = req.query;
  const { skip, limit, page } = parsePagination(req, { defaultLimit: 25 });

  const filter = {};
  if (status) filter.status = status;
  if (attorney && isObjId(attorney)) filter.attorney = attorney;
  if (paralegal && isObjId(paralegal)) filter.paralegal = paralegal;
  if (q && q.trim()) filter.title = new RegExp(q.trim(), "i");

  const [items, total] = await Promise.all([
    Case.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip).limit(limit)
      .populate("attorney paralegal", "name email role status")
      .lean(),
    Case.countDocuments(filter),
  ]);

  res.json({
    page, limit, total, pages: Math.ceil(total / limit),
    cases: items,
  });
}));

/**
 * PATCH /api/admin/assign/:caseId
 * Body: { paralegalId }
 * Manually assign a paralegal to a case (sets status to 'assigned' if applicable).
 */
router.patch("/assign/:caseId", asyncHandler(async (req, res) => {
  const { caseId } = req.params;
  const { paralegalId } = req.body || {};
  if (!isObjId(caseId)) return res.status(400).json({ msg: "Invalid case id" });
  if (!isObjId(paralegalId)) return res.status(400).json({ msg: "Invalid paralegalId" });

  const para = await User.findById(paralegalId).lean();
  if (!para || para.role !== "paralegal") {
    return res.status(400).json({ msg: "Invalid paralegalId" });
  }

  const c = await Case.findById(caseId);
  if (!c) return res.status(404).json({ msg: "Case not found" });

  // Prefer model helpers if present (from upgraded Case model)
  if (typeof c.acceptApplicant === "function") {
    try { c.acceptApplicant(paralegalId); } catch (_) { /* ignore if not applied yet */ }
  }
  c.paralegal = paralegalId;
  if (c.status === "open" && typeof c.transitionTo === "function") {
    if (c.canTransitionTo("assigned")) c.transitionTo("assigned");
    else c.status = "assigned";
  } else if (c.status === "open") {
    c.status = "assigned";
  }
  await c.save();

  await AuditLog.logFromReq(req, "admin.case.assign", {
    targetType: "case",
    targetId: c._id,
    caseId: c._id,
    meta: { paralegalId },
  });

  const populated = await Case.findById(c._id).populate("attorney paralegal", "name email role status").lean();
  res.json({ ok: true, msg: "Paralegal assigned", case: populated });
}));

/**
 * PATCH /api/admin/cases/:id/status
 * Body: { status }
 * Update a case status as admin (uses Case transition guardrails if available).
 */
router.patch("/cases/:id/status", asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!isObjId(id)) return res.status(400).json({ msg: "Invalid case id" });

  const ALLOWED = ["open", "assigned", "in_progress", "completed", "disputed", "closed"];
  if (!ALLOWED.includes(status)) return res.status(400).json({ msg: "Invalid status" });

  const c = await Case.findById(id);
  if (!c) return res.status(404).json({ msg: "Case not found" });

  if (typeof c.transitionTo === "function") {
    // prefer safe transitions
    if (!c.canTransitionTo(status)) {
      return res.status(400).json({ msg: `Invalid transition from '${c.status}' to '${status}'.` });
    }
    c.transitionTo(status);
  } else {
    c.status = status;
  }

  await c.save();

  await AuditLog.logFromReq(req, "admin.case.status.update", {
    targetType: "case",
    targetId: c._id,
    caseId: c._id,
    meta: { status },
  });

  const populated = await Case.findById(id).populate("attorney paralegal", "name email").lean();
  res.json({ ok: true, msg: "Case updated", case: populated });
}));

/**
 * GET /api/admin/metrics
 * Quick admin overview counts.
 */
router.get("/metrics", asyncHandler(async (_req, res) => {
  const [users, cases] = await Promise.all([
    User.aggregate([
      { $group: { _id: { role: "$role", status: "$status" }, count: { $sum: 1 } } },
    ]),
    Case.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  res.json({ users, cases });
}));

// -----------------------------------------
// Fallback error handler (keeps admin routes tidy)
// -----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
});

module.exports = router;
