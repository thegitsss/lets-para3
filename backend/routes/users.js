// backend/routes/users.js
const router = require("express").Router();
const paralegalRouter = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const User = require("../models/User");
const Case = require("../models/Case");
const Task = require("../models/Task");
const Notification = require("../models/Notification");
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
const cleanList = (value) => {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(arr.map((v) => normStr(v, { len: 200 }).trim()).filter(Boolean))];
};
const cleanCollection = (value, fields = []) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const out = {};
      fields.forEach(([key, maxLen]) => {
        if (entry && typeof entry[key] === "string") {
          out[key] = normStr(entry[key], { len: maxLen });
        }
      });
      return out;
    })
    .filter((entry) => Object.values(entry).some(Boolean));
};

const cleanLanguages = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === "string") {
        const name = normStr(entry, { len: 120 }).trim();
        return name ? { name, proficiency: "" } : null;
      }
      const name = normStr(entry.name || entry.language || "", { len: 120 }).trim();
      const proficiency = normStr(entry.proficiency || entry.level || "", { len: 120 }).trim();
      if (!name) return null;
      return { name, proficiency };
    })
    .filter(Boolean);
};
const resolveParalegalId = (rawId, userId) => (rawId === "me" ? userId : rawId);
const normalizeAvailability = (val) => {
  if (typeof val === "string" && val.trim()) return normStr(val, { len: 200 });
  if (typeof val === "boolean") return val ? "Available Now" : "Unavailable";
  return null;
};
const isStorageKey = (value) => typeof value === "string" && /^paralegal-(?:resumes|certificates)\//i.test(value.trim());
const parseParalegalFilters = (query = {}) => {
  const {
    search = "",
    available,
    availability,
    practice,
    skill,
    location,
    minYears,
    page = 1,
    limit = 20,
    sort = "recent",
  } = query;
  const p = clamp(parseInt(page, 10) || 1, 1, 1000000);
  const l = clamp(parseInt(limit, 10) || 20, 1, 100);
  const filter = { role: "paralegal", status: "approved" };
  if (availability) {
    filter.availability = new RegExp(String(availability).trim(), "i");
  } else if (available !== undefined) {
    filter.availability = String(available) === "true" ? /available/i : /unavailable|wait/i;
  }
  if (search) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ firstName: rx }, { lastName: rx }, { bio: rx }, { about: rx }];
  }
  if (practice) filter.practiceAreas = new RegExp(String(practice).trim(), "i");
  if (skill) filter.skills = new RegExp(String(skill).trim(), "i");
  if (location) filter.location = new RegExp(String(location).trim(), "i");
  if (minYears) {
    const years = Math.max(0, parseInt(minYears, 10) || 0);
    filter.yearsExperience = { $gte: years };
  }
  const sortOpt =
    sort === "alpha" ? { firstName: 1, lastName: 1 } : sort === "experience" ? { yearsExperience: -1 } : { createdAt: -1 };
  return { filter, sortOpt, page: p, limit: l };
};

const SAFE_PUBLIC_SELECT =
  "_id firstName lastName avatarURL profileImage location specialties practiceAreas skills experience yearsExperience linkedInURL certificateURL writingSampleURL education resumeURL notificationPrefs lawFirm bio about availability availabilityDetails approvedAt languages writingSamples";
const SAFE_SELF_SELECT = `${SAFE_PUBLIC_SELECT} email phoneNumber`;
const FILE_PUBLIC_BASE =
  (process.env.CDN_BASE_URL || process.env.S3_PUBLIC_BASE_URL || "").replace(/\/+$/, "") ||
  (process.env.S3_BUCKET && process.env.S3_REGION
    ? `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com`
    : "");

function toPublicUrl(val) {
  if (!val) return "";
  if (/^https?:\/\//i.test(val)) return val;
  return FILE_PUBLIC_BASE ? `${FILE_PUBLIC_BASE}/${String(val).replace(/^\/+/, "")}` : val;
}

function serializePublicUser(user, { includeEmail = false } = {}) {
  if (!user) return null;
  const src = user.toObject ? user.toObject() : user;
  const profileImage = toPublicUrl(src.profileImage || "");
  const avatarURL = toPublicUrl(src.avatarURL || profileImage);
  const certificateURL = toPublicUrl(src.certificateURL || "");
  const writingSampleURL = toPublicUrl(src.writingSampleURL || "");
  const resumeURL = toPublicUrl(src.resumeURL || "");
  const payload = {
    _id: String(src._id),
    firstName: src.firstName || "",
    lastName: src.lastName || "",
    avatarURL,
    profileImage,
    location: src.location || "",
    state: src.state || src.location || "",
    lawFirm: src.lawFirm || "",
    specialties: Array.isArray(src.specialties) ? src.specialties : [],
    practiceAreas: Array.isArray(src.practiceAreas) ? src.practiceAreas : [],
    skills: Array.isArray(src.skills) ? src.skills : [],
    yearsExperience:
      typeof src.yearsExperience === "number" ? src.yearsExperience : 0,
    linkedInURL: src.linkedInURL || "",
    certificateURL,
    writingSampleURL,
    resumeURL,
    certificateKey: src.certificateURL || "",
    resumeKey: src.resumeURL || "",
    writingSampleKey: src.writingSampleURL || "",
    education: Array.isArray(src.education) ? src.education : [],
    experience: Array.isArray(src.experience) ? src.experience : [],
    availability: src.availability || "",
    availabilityDetails: src.availabilityDetails || null,
    approvedAt: src.approvedAt || null,
    bio: src.bio || "",
    about: src.about || "",
    writingSamples: Array.isArray(src.writingSamples) ? src.writingSamples : [],
    languages: cleanLanguages(src.languages || []),
    notificationPrefs: src.notificationPrefs || null,
  };
  if (includeEmail) {
    payload.email = src.email || "";
    payload.phoneNumber = src.phoneNumber || "";
  }
  return payload;
}

function formatDisplayName(user) {
  const first = user?.firstName || "";
  const last = user?.lastName || "";
  const full = `${first} ${last}`.trim();
  if (full) return full;
  return user?.email || "User";
}

async function buildNotifications(userDoc) {
  const ownerId = userDoc._id || userDoc.id;
  const lastSeen = userDoc.notificationsLastViewedAt || null;
  const taskFilter = { owner: ownerId, deleted: { $ne: true } };
  const caseFilter = {};
  if (String(userDoc.role).toLowerCase() === "attorney") {
    caseFilter.attorney = ownerId;
  } else if (String(userDoc.role).toLowerCase() === "paralegal") {
    caseFilter.paralegal = ownerId;
  }

  const [stored, tasks, cases] = await Promise.all([
    Notification.find({ userId: ownerId }).sort({ createdAt: -1 }).limit(12).lean(),
    Task.find(taskFilter)
      .sort({ updatedAt: -1 })
      .limit(8)
      .select("title notes due createdAt updatedAt caseId done"),
    Object.keys(caseFilter).length
      ? Case.find(caseFilter).sort({ updatedAt: -1 }).limit(5).select("title status updatedAt _id")
      : Promise.resolve([]),
  ]);

  const items = [];
  stored.forEach((n) => {
    const createdAt = n.createdAt || n.updatedAt || new Date();
    items.push({
      id: `notif-${n._id}`,
      type: n.type || "system",
      title: n.title || "Notification",
      body: n.body || "",
      createdAt,
      caseId: n.caseId ? String(n.caseId) : null,
      messageId: n.messageId ? String(n.messageId) : null,
      read: !!n.read,
      meta: n.meta || null,
    });
  });

  tasks.forEach((t) => {
    const createdAt = t.updatedAt || t.createdAt || new Date();
    const dueLabel = t.due ? new Date(t.due).toLocaleDateString() : null;
    const entry = {
      id: `task-${t._id}`,
      type: t.done ? "task-complete" : "task",
      title: t.title || "Task update",
      body: t.done
        ? "Marked complete."
        : t.notes
        ? t.notes.slice(0, 200)
        : dueLabel
        ? `Due ${dueLabel}`
        : "New task assigned.",
      createdAt,
      caseId: t.caseId ? String(t.caseId) : null,
      done: t.done,
      read: lastSeen ? !(createdAt > lastSeen) : false,
    };
    items.push(entry);
  });

  (cases || []).forEach((c) => {
    const createdAt = c.updatedAt || new Date();
    items.push({
      id: `case-${c._id}`,
      type: "case",
      title: c.title || "Case update",
      body: c.status ? `Status updated to ${c.status.replace(/_/g, " ")}` : "Case timeline updated.",
      createdAt,
      caseId: String(c._id),
      read: lastSeen ? !(createdAt > lastSeen) : false,
    });
  });

  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 15);
}

// all routes require auth
router.use(verifyToken);
paralegalRouter.use(verifyToken, requireRole(["paralegal"]));

/**
 * GET /api/users?status=&role=
 * Admin only list of users filtered by status/role (defaults to all).
 */
router.get(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { status, role } = req.query;
    const filter = {};
    if (status) {
      const normalized = String(status).toLowerCase();
      if (["pending", "approved", "denied", "rejected"].includes(normalized)) {
        filter.status = normalized === "rejected" ? "denied" : normalized;
      }
    }
    if (role && ["attorney", "paralegal", "admin"].includes(String(role))) {
      filter.role = role;
    }

    const users = await User.find(filter)
      .select("firstName lastName email role status createdAt updatedAt")
      .sort({ createdAt: -1 })
      .lean();

    users.forEach((u) => {
      const fn = u.firstName || "";
      const ln = u.lastName || "";
      const name = `${fn} ${ln}`.trim();
      u.name = name || fn || ln || "";
    });

    res.json({ users });
  })
);

/**
 * GET /api/users/me
 */
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id).select(SAFE_SELF_SELECT).lean();
    if (!me) return res.status(404).json({ error: "Not found" });
    return res.json(serializePublicUser(me, { includeEmail: true }));
  })
);

router.get(
  "/me/notifications",
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id).select("role notificationsLastViewedAt");
    if (!me) return res.status(404).json({ error: "Not found" });
    const items = await buildNotifications(me);
    const lastSeen = me.notificationsLastViewedAt || null;
    const unread = items.filter((item) => item.read === false).length;
    return res.json({ items, unread, lastSeen });
  })
);

router.post(
  "/me/notifications/read",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { caseId, type } = req.body || {};
    const me = await User.findById(req.user.id).select("notificationsLastViewedAt");
    if (!me) return res.status(404).json({ error: "Not found" });
    const filter = { userId: me._id, read: false };
    if (caseId && mongoose.isValidObjectId(caseId)) {
      filter.caseId = new mongoose.Types.ObjectId(caseId);
    }
    if (type && typeof type === "string") {
      filter.type = type;
    }
    await Notification.updateMany(filter, { $set: { read: true } });
    me.notificationsLastViewedAt = new Date();
    await me.save();
    return res.json({ ok: true, seenAt: me.notificationsLastViewedAt });
  })
);

router.get(
  "/me/blocked",
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id).select("blockedUsers");
    if (!me) return res.status(404).json({ error: "Not found" });
    const ids = (me.blockedUsers || []).map((id) => String(id));
    if (!ids.length) return res.json([]);

    const blockedUsers = await User.find({ _id: { $in: ids } }).select("firstName lastName email").lean();
    const lookup = blockedUsers.reduce((acc, user) => {
      acc[String(user._id)] = user;
      return acc;
    }, {});

    const ordered = ids
      .map((id) => lookup[id])
      .filter(Boolean)
      .map((user) => ({
        _id: String(user._id),
        name: formatDisplayName(user),
      }));

    res.json(ordered);
  })
);

router.post(
  "/block",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { userId } = req.body || {};
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid userId" });
    if (String(userId) === String(req.user.id)) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    const [me, target] = await Promise.all([
      User.findById(req.user.id).select("blockedUsers"),
      User.findById(userId).select("_id firstName lastName email"),
    ]);
    if (!me) return res.status(404).json({ error: "User not found" });
    if (!target) return res.status(404).json({ error: "Target not found" });

    if (!Array.isArray(me.blockedUsers)) {
      me.blockedUsers = [];
    }
    const already = me.blockedUsers.some((id) => String(id) === String(target._id));
    if (!already) {
      me.blockedUsers.push(target._id);
      await me.save();
    }

    res.json({ ok: true, blocked: true });
  })
);

router.post(
  "/unblock",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const { userId } = req.body || {};
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid userId" });

    const me = await User.findById(req.user.id).select("blockedUsers");
    if (!me) return res.status(404).json({ error: "User not found" });

    const current = Array.isArray(me.blockedUsers) ? me.blockedUsers : [];
    me.blockedUsers = current.filter((id) => String(id) !== String(userId));
    await me.save();

    res.json({ ok: true, blocked: false });
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

    const body = req.body || {};
    const {
      firstName,
      lastName,
      email: nextEmail,
      phoneNumber,
      phone,
      lawFirm,
      bio,
      availability,
      resumeURL,
      certificateURL,
      barNumber,
      avatarURL,
      profileImage,
      timezone,
    } = body;

    if (typeof firstName === "string" && firstName.trim()) {
      me.firstName = normStr(firstName, { len: 150 }).trim();
    }
    if (typeof lastName === "string" && lastName.trim()) {
      me.lastName = normStr(lastName, { len: 150 }).trim();
    }
    if (typeof nextEmail === "string" && nextEmail.trim()) {
      const normalizedEmail = normStr(nextEmail, { len: 320 }).trim().toLowerCase();
      if (normalizedEmail && normalizedEmail !== me.email) {
        const exists = await User.countDocuments({ email: normalizedEmail, _id: { $ne: me._id } });
        if (exists) return res.status(409).json({ error: "Email already in use" });
        me.email = normalizedEmail;
        me.emailVerified = false;
      }
    }
    const phoneVal = typeof phoneNumber === "string" ? phoneNumber : typeof phone === "string" ? phone : null;
    if (phoneVal !== null) {
      me.phoneNumber = normStr(phoneVal, { len: 40 }).trim();
    }
    if (typeof lawFirm === "string") {
      me.lawFirm = normStr(lawFirm, { len: 300 }).trim();
    }

    if (typeof bio === "string") {
      const sanitized = normStr(maskProfanity(bio), { len: 4000 });
      me.bio = sanitized;
    }
    const availabilityStr = normalizeAvailability(availability);
    if (availabilityStr) me.availability = availabilityStr;

    if (typeof avatarURL === "string" && isURL(avatarURL)) {
      me.avatarURL = avatarURL;
    }
    if (typeof profileImage === "string" && profileImage.trim()) {
      me.profileImage = profileImage.trim();
    }
    if (typeof timezone === "string" && timezone.length <= 64) {
      me.timezone = timezone;
    }

    if (me.role === "paralegal") {
      if (typeof resumeURL === "string" && (isURL(resumeURL) || isStorageKey(resumeURL))) {
        me.resumeURL = resumeURL.trim();
      }
      if (typeof certificateURL === "string" && (isURL(certificateURL) || isStorageKey(certificateURL))) {
        me.certificateURL = certificateURL.trim();
      }
      if (typeof body.writingSampleURL === "string" && (isURL(body.writingSampleURL) || isStorageKey(body.writingSampleURL))) {
        me.writingSampleURL = body.writingSampleURL.trim();
      }
      if (body.practiceAreas !== undefined) {
        me.practiceAreas = cleanList(body.practiceAreas);
      }
      const rawSkills = body.highlightedSkills !== undefined ? body.highlightedSkills : body.skills;
      if (rawSkills !== undefined) {
        me.skills = cleanList(rawSkills);
      }
      if (body.experience !== undefined) {
        me.experience = cleanCollection(body.experience, [
          ["title", 300],
          ["years", 120],
          ["description", 5000]
        ]);
      }
      if (body.education !== undefined) {
        me.education = cleanCollection(body.education, [
          ["degree", 200],
          ["school", 200]
        ]);
      }
      if (body.languages !== undefined) {
        me.languages = cleanLanguages(body.languages);
      }
      if (body.yearsExperience !== undefined) {
        const years = Math.max(0, Math.min(80, parseInt(body.yearsExperience, 10) || 0));
        me.yearsExperience = years;
      }
      if (typeof body.linkedInURL === "string") {
        const trimmed = body.linkedInURL.trim();
        me.linkedInURL = trimmed ? normStr(trimmed, { len: 500 }) : null;
      }
    }
    if (me.role === "attorney" && typeof barNumber === "string") {
      me.barNumber = normStr(barNumber, { len: 100 }).trim();
    }
    if (typeof body.firstName === "string") {
      me.firstName = body.firstName.trim();
    }

    if (typeof body.lastName === "string") {
      me.lastName = body.lastName.trim();
    }

    await me.save();
    try {
      await logAction(req, "user.me.update", { targetType: "user", targetId: me._id });
    } catch {}

    return res.json(serializePublicUser(me, { includeEmail: true }));
  })
);

router.patch(
  "/me/notification-prefs",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ error: "Not found" });
    const current = me.notificationPrefs
      ? typeof me.notificationPrefs.toObject === "function"
        ? me.notificationPrefs.toObject()
        : { ...me.notificationPrefs }
      : {};
    const updates = req.body || {};
    const allowed = ["inAppMessages", "inAppCase", "emailMessages", "emailCase", "smsMessages", "smsCase"];
    allowed.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        current[key] = !!updates[key];
      }
    });
    me.notificationPrefs = current;
    await me.save();
    return res.json({ notificationPrefs: me.notificationPrefs });
  })
);

/**
 * POST /api/users/me/availability
 * Body: { availability: boolean }
 * Handy quick-toggle endpoint for UI. Retained for future dashboard toggles.
 */
router.post(
  "/me/availability",
  csrfProtection,
  asyncHandler(async (req, res) => {
    const availabilityStr = normalizeAvailability(req.body?.availability);
    if (!availabilityStr) {
      return res.status(400).json({ error: "availability value required" });
    }
    const me = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { availability: availabilityStr } },
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
    return res.json(serializePublicUser(me, { includeEmail: true }));
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
    return res.json(serializePublicUser(me, { includeEmail: true }));
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
    const { filter, sortOpt, page: p, limit: l } = parseParalegalFilters(req.query);

    const [docs, total] = await Promise.all([
      User.find(filter).sort(sortOpt).skip((p - 1) * l).limit(l).select(SAFE_PUBLIC_SELECT).lean(),
      User.countDocuments(filter),
    ]);

    const items = docs.map((doc) => serializePublicUser(doc));

    return res.json({ items, page: p, limit: l, total, pages: Math.ceil(total / l), hasMore: p * l < total });
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

    const u = await User.findById(userId).select(SAFE_PUBLIC_SELECT).lean();
    if (!u) return res.status(404).json({ error: "User not found" });
    if (u.role !== "paralegal" || u.status !== "approved") {
      return res.status(403).json({ error: "Profile not available" });
    }

    try {
      await logAction(req, "user.profile.view", { targetType: "user", targetId: u._id });
    } catch {}

    return res.json(serializePublicUser(u));
  })
);

// ----------------------------------------
// Paralegal Directory Routes (/api/paralegals)
// ----------------------------------------
const PARALEGAL_SELECT = `${SAFE_PUBLIC_SELECT} role status email`;

paralegalRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { filter, sortOpt, page, limit } = parseParalegalFilters(req.query);
    const [docs, total] = await Promise.all([
      User.find(filter).sort(sortOpt).skip((page - 1) * limit).limit(limit).select(PARALEGAL_SELECT).lean(),
      User.countDocuments(filter),
    ]);
    const items = docs.map((doc) => serializePublicUser(doc));
    return res.json({
      items,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    });
  })
);

paralegalRouter.get(
  "/:paralegalId",
  asyncHandler(async (req, res) => {
    const targetId = resolveParalegalId(req.params.paralegalId, req.user.id);
    if (!isObjId(targetId)) return res.status(400).json({ error: "Invalid paralegal id" });

    const profile = await User.findById(targetId).select(PARALEGAL_SELECT);
    if (!profile) return res.status(404).json({ error: "Paralegal not found" });
    if (profile.role !== "paralegal" && String(profile._id) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(404).json({ error: "Paralegal not found" });
    }
    const isOwner = String(profile._id) === String(req.user.id);
    if (
      profile.role === "paralegal" &&
      profile.status !== "approved" &&
      !isOwner &&
      req.user.role !== "admin"
    ) {
      return res.status(403).json({ error: "Profile not available" });
    }

    try {
      await logAction(req, "paralegal.profile.view", { targetType: "user", targetId: profile._id });
    } catch {}

    return res.json(serializePublicUser(profile, { includeEmail: isOwner }));
  })
);

paralegalRouter.post(
  "/:paralegalId/update",
  asyncHandler(async (req, res) => {
    const targetId = resolveParalegalId(req.params.paralegalId, req.user.id);
    if (!isObjId(targetId)) return res.status(400).json({ error: "Invalid paralegal id" });
    const isSelf = String(targetId) === String(req.user.id);
    if (!isSelf && req.user.role !== "admin") {
      return res.status(403).json({ error: "Only the profile owner or an admin can update" });
    }

    const paralegal = await User.findById(targetId);
    if (!paralegal) return res.status(404).json({ error: "Paralegal not found" });
    if (paralegal.role !== "paralegal" && req.user.role !== "admin") {
      return res.status(400).json({ error: "Only paralegal profiles can be updated here" });
    }

    const body = req.body || {};
    if (typeof body.about === "string") paralegal.about = normStr(maskProfanity(body.about), { len: 4000 });
    if (typeof body.location === "string") paralegal.location = normStr(body.location, { len: 400 });
    const availabilityStr = normalizeAvailability(body.availability);
    if (availabilityStr) paralegal.availability = availabilityStr;
    if (body.yearsExperience !== undefined) {
      const years = Math.max(0, Math.min(80, parseInt(body.yearsExperience, 10) || 0));
      paralegal.yearsExperience = years;
    }
    if (body.practiceAreas !== undefined) paralegal.practiceAreas = cleanList(body.practiceAreas);
    if (body.skills !== undefined) paralegal.skills = cleanList(body.skills);
    paralegal.experience = cleanCollection(body.experience, [
      ["title", 300],
      ["years", 120],
      ["description", 5000],
    ]);
    paralegal.education = cleanCollection(body.education, [
      ["degree", 200],
      ["school", 200],
    ]);
    paralegal.writingSamples = cleanCollection(body.writingSamples, [
      ["title", 400],
      ["content", 10_000],
    ]);
    if (typeof req.body.firstName === "string") {
      paralegal.firstName = req.body.firstName.trim();
    }
    if (typeof req.body.lastName === "string") {
      paralegal.lastName = req.body.lastName.trim();
    }

    await paralegal.save();
    try {
      await logAction(req, "paralegal.profile.update", { targetType: "user", targetId: paralegal._id });
    } catch {}

    return res.json(serializePublicUser(paralegal, { includeEmail: isSelf }));
  })
);

paralegalRouter.post(
  "/:paralegalId/invite",
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    const targetId = resolveParalegalId(req.params.paralegalId, req.user.id);
    if (!isObjId(targetId)) return res.status(400).json({ error: "Invalid paralegal id" });

    const paralegal = await User.findById(targetId).select("firstName lastName role status");
    if (!paralegal || paralegal.role !== "paralegal" || paralegal.status !== "approved") {
      return res.status(404).json({ error: "Paralegal not available" });
    }

    const { caseId, message } = req.body || {};
    if (!caseId) return res.status(400).json({ error: "caseId is required" });
    if (!isObjId(caseId)) return res.status(400).json({ error: "Invalid caseId" });

    const caseDoc = await Case.findById(caseId).select("title attorney updates");
    if (!caseDoc) return res.status(404).json({ error: "Case not found" });
    if (req.user.role !== "admin" && String(caseDoc.attorney) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the case owner can send invites" });
    }

    caseDoc.updates = caseDoc.updates || [];
    const friendlyName = `${paralegal.firstName || ""} ${paralegal.lastName || ""}`.trim() || "paralegal";

    caseDoc.updates.push({
      date: new Date(),
      text: `Invite sent to ${friendlyName}: ${normStr(message || "(no message provided)", {
        len: 500,
      })}`,
      by: req.user.id,
    });
    await caseDoc.save();

    try {
      await logAction(req, "paralegal.invite", {
        targetType: "user",
        targetId: paralegal._id,
        meta: { caseId: caseDoc._id },
      });
    } catch {}

    res.json({ ok: true, message: "Invite sent" });
  })
);

/**
 * PATCH /api/users/:userId/approve
 */
router.patch(
  "/:userId/approve",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid user id" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.status = "approved";
    await user.save();
    try {
      await logAction(req, "admin.user.approve", { targetType: "user", targetId: user._id });
    } catch {}

    res.json({ ok: true, user: user.toJSON() });
  })
);

/**
 * PATCH /api/users/:userId/reject
 */
router.patch(
  "/:userId/reject",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid user id" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    user.status = "denied";
    await user.save();
    try {
      await logAction(req, "admin.user.reject", { targetType: "user", targetId: user._id });
    } catch {}

    res.json({ ok: true, user: user.toJSON() });
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

router.paralegalRouter = paralegalRouter;

module.exports = router;
