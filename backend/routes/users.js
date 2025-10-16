// backend/routes/users.js
const router = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const { requireRole } = require("../utils/authz");
const User = require("../models/User");
const { maskProfanity } = require("../utils/badWords");
const { logAction } = require("../utils/audit");

// ----------------------------------------
// Optional CSRF (enable via ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
if (process.env.ENABLE_CSRF === "true") {
  const csrf = require("csurf");
  csrfProtection = csrf({ cookie: { httpOnly: true, sameSite: "strict", secure: true } });
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isURL = (v) => {
  if (!v || typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
};
const normStr = (s, { len = 4000 } = {}) => String(s || "").replace(/[\u0000-\u001F\u007F]/g, "").slice(0, len);

// all routes require auth
router.use(verifyToken);

/**
 * GET /api/users/me
 */
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ error: "Not found" });
    res.json(me.toJSON());
  })
);

/**
 * PATCH /api/users/me
 * Body: { bio?, availability?, resumeURL?, certificateURL?, barNumber?, avatarURL?, timezone? }
 */
router.patch(
  "/me",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ error: "Not found" });

    const {
      bio,
      availability,
      resumeURL,
      certificateURL,
      barNumber,
      avatarURL,
      timezone,
    } = req.body || {};

    if (typeof bio === "string") {
      const sanitized = normStr(maskProfanity(bio), { len: 4000 });
      me.bio = sanitized;
    }
    if (availability !== undefined) me.availability = !!availability;

    if (typeof avatarURL === "string" && isURL(avatarURL)) {
      me.avatarURL = avatarURL;
    }
    if (typeof timezone === "string" && timezone.length <= 64) {
      me.timezone = timezone;
    }

    if (me.role === "paralegal") {
      if (typeof resumeURL === "string" && isURL(resumeURL)) me.resumeURL = resumeURL;
      if (typeof certificateURL === "string" && isURL(certificateURL)) me.certificateURL = certificateURL;
    }
    if (me.role === "attorney" && typeof barNumber === "string") {
      me.barNumber = normStr(barNumber, { len: 100 }).trim();
    }

    await me.save();
    try {
      await logAction(req, "user.me.update", { targetType: "user", targetId: me._id });
    } catch {}

    res.json(me.toJSON());
  })
);

/**
 * POST /api/users/me/availability
 * Body: { availability: boolean }
 * Handy quick-toggle endpoint for UI.
 */
router.post(
  "/me/availability",
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (typeof req.body?.availability !== "boolean") {
      return res.status(400).json({ error: "availability boolean required" });
    }
    const me = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { availability: !!req.body.availability } },
      { new: true }
    );
    if (!me) return res.status(404).json({ error: "Not found" });
    try {
      await logAction(req, "user.me.availability", {
        targetType: "user",
        targetId: me._id,
        meta: { availability: me.availability },
      });
    } catch {}
    res.json(me.toJSON());
  })
);

/**
 * POST /api/users/me/email-pref
 * Body: { marketing?: boolean, product?: boolean }
 * (Stores lightweight email preferences if your model has fields; ignored otherwise.)
 */
router.post(
  "/me/email-pref",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const updates = {};
    if (typeof req.body?.marketing === "boolean") updates["emailPref.marketing"] = req.body.marketing;
    if (typeof req.body?.product === "boolean") updates["emailPref.product"] = req.body.product;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No recognized fields" });

    const me = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true });
    if (!me) return res.status(404).json({ error: "Not found" });

    try {
      await logAction(req, "user.me.emailPref", { targetType: "user", targetId: me._id, meta: updates });
    } catch {}
    res.json(me.toJSON());
  })
);

/**
 * GET /api/users/paralegals?search=&available=true&page=1&limit=20&sort=recent|alpha
 * (attorney/admin only)
 */
router.get(
  "/paralegals",
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    const { search = "", available, page = 1, limit = 20, sort = "recent" } = req.query;
    const p = clamp(parseInt(page, 10) || 1, 1, 1000000);
    const l = clamp(parseInt(limit, 10) || 20, 1, 100);

    const q = { role: "paralegal", status: "approved" };
    if (available !== undefined) q.availability = String(available) === "true";
    if (search) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ name: rx }, { bio: rx }];
    }

    const sortOpt = sort === "alpha" ? { name: 1 } : { createdAt: -1 };

    const [items, total] = await Promise.all([
      User.find(q)
        .sort(sortOpt)
        .skip((p - 1) * l)
        .limit(l)
        .select("name email bio resumeURL certificateURL availability role status createdAt"),
      User.countDocuments(q),
    ]);

    res.json({ items, page: p, limit: l, total, pages: Math.ceil(total / l), hasMore: p * l < total });
  })
);

/**
 * GET /api/users/:userId
 * Public paralegal profile (only if approved); must be logged in.
 */
router.get(
  "/:userId",
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid userId" });

    const u = await User.findById(userId).select(
      "name email bio resumeURL certificateURL availability role status createdAt barNumber"
    );
    if (!u) return res.status(404).json({ error: "User not found" });
    if (u.role !== "paralegal" || u.status !== "approved") {
      return res.status(403).json({ error: "Profile not available" });
    }

    try {
      await logAction(req, "user.profile.view", { targetType: "user", targetId: u._id });
    } catch {}

    res.json(u);
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

module.exports = router;
