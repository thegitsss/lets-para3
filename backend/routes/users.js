// backend/routes/users.js
const router = require("express").Router();
const paralegalRouter = require("express").Router();
const mongoose = require("mongoose");
const verifyToken = require("../utils/verifyToken");
const requireRole = require("../middleware/requireRole");
const requireApprovedUser = require("../middleware/requireApprovedUser");
const User = require("../models/User");
const Case = require("../models/Case");
const Application = require("../models/Application");
const Task = require("../models/Task");
const Notification = require("../models/Notification");
const Job = require("../models/Job");
const Block = require("../models/Block");
const WeeklyNote = require("../models/WeeklyNote");
const { maskProfanity } = require("../utils/badWords");
const { logAction } = require("../utils/audit");
const { notifyUser } = require("../utils/notifyUser");
const { cleanMessage } = require("../utils/sanitize");
const {
  applyPublicParalegalFilter,
  hasRequiredParalegalFieldsForPublic,
  hasRequiredParalegalFieldsForSave,
} = require("../utils/paralegalProfile");
const {
  BLOCKED_MESSAGE,
  getBlockedUserIds,
  isBlockedBetween,
  isBlockPairAllowed,
  isBlockableRole,
} = require("../utils/blocks");

// ----------------------------------------
// CSRF (enabled in production or when ENABLE_CSRF=true)
// ----------------------------------------
const noop = (_req, _res, next) => next();
let csrfProtection = noop;
const REQUIRE_CSRF = process.env.NODE_ENV === "production" || process.env.ENABLE_CSRF === "true";
if (REQUIRE_CSRF) {
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
const hasAttorneyParalegalAccess = async (attorneyId, paralegalId) => {
  if (!isObjId(attorneyId) || !isObjId(paralegalId)) return false;
  const caseMatch = await Case.exists({
    attorneyId,
    $or: [
      { paralegal: paralegalId },
      { paralegalId },
      { "applicants.paralegalId": paralegalId },
    ],
  });
  if (caseMatch) return true;
  const jobIds = await Job.find({ attorneyId }).select("_id").lean();
  if (!jobIds.length) return false;
  const jobIdList = jobIds.map((job) => job._id);
  const applicationMatch = await Application.exists({ paralegalId, jobId: { $in: jobIdList } });
  return Boolean(applicationMatch);
};
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
  "_id firstName lastName avatarURL profileImage profileImageOriginal pendingProfileImage pendingProfileImageOriginal profilePhotoStatus location specialties practiceAreas skills bestFor experience yearsExperience linkedInURL firmWebsite certificateURL writingSampleURL education resumeURL publications notificationPrefs preferences lawFirm bio about availability availabilityDetails approvedAt languages writingSamples status stateExperience";
const SAFE_SELF_SELECT = `${SAFE_PUBLIC_SELECT} email phoneNumber onboarding pendingHire`;
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

function serializePublicUser(user, { includeEmail = false, includeStatus = false, includePhotoMeta = false } = {}) {
  if (!user) return null;
  const src = user.toObject ? user.toObject() : user;
  const role = String(src.role || "").toLowerCase();
  const isParalegal = role === "paralegal";
  const profileImage = toPublicUrl(src.profileImage || "");
  const avatarURL = toPublicUrl(src.avatarURL || profileImage);
  const rawPhotoStatus = String(src.profilePhotoStatus || "").trim();
  const resolvedPhotoStatus = isParalegal
    ? rawPhotoStatus ||
      (src.pendingProfileImage ? "pending_review" : avatarURL || profileImage ? "approved" : "unsubmitted")
    : avatarURL || profileImage
    ? "approved"
    : "unsubmitted";
  const certificateURL = toPublicUrl(src.certificateURL || "");
  const writingSampleURL = toPublicUrl(src.writingSampleURL || "");
  const resumeURL = toPublicUrl(src.resumeURL || "");
  const profileImageOriginal = toPublicUrl(src.profileImageOriginal || "");
  const pendingProfileImageOriginal = isParalegal
    ? toPublicUrl(src.pendingProfileImageOriginal || "")
    : "";
  const payload = {
    _id: String(src._id),
    firstName: src.firstName || "",
    lastName: src.lastName || "",
    avatarURL,
    profileImage,
    location: src.location || "",
    state: src.state || src.location || "",
    lawFirm: src.lawFirm || "",
    firmWebsite: src.firmWebsite || "",
    publications: Array.isArray(src.publications) ? src.publications : [],
    specialties: Array.isArray(src.specialties) ? src.specialties : [],
    practiceAreas: Array.isArray(src.practiceAreas) ? src.practiceAreas : [],
    skills: Array.isArray(src.skills) ? src.skills : [],
    bestFor: Array.isArray(src.bestFor) ? src.bestFor : [],
    stateExperience: Array.isArray(src.stateExperience) ? src.stateExperience : [],
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
    preferences: {
      theme:
        (src.preferences && typeof src.preferences === "object" && src.preferences.theme) ||
        "mountain",
      fontSize:
        (src.preferences && typeof src.preferences === "object" && src.preferences.fontSize) ||
        "md",
      hideProfile:
        (src.preferences && typeof src.preferences === "object" && src.preferences.hideProfile) ||
        false,
    },
  };
  if (includeEmail) {
    payload.email = src.email || "";
    payload.phoneNumber = src.phoneNumber || "";
  }
  if (includeStatus) {
    payload.status = src.status || "";
  }
  if (includePhotoMeta) {
    payload.profilePhotoStatus = resolvedPhotoStatus;
    payload.pendingProfileImage = isParalegal ? toPublicUrl(src.pendingProfileImage || "") : "";
    payload.profileImageOriginal = profileImageOriginal;
    payload.pendingProfileImageOriginal = pendingProfileImageOriginal;
  }
  return payload;
}

function serializeOnboarding(onboarding = {}) {
  return {
    paralegalWelcomeDismissed: Boolean(onboarding?.paralegalWelcomeDismissed),
    paralegalTourCompleted: Boolean(onboarding?.paralegalTourCompleted),
    paralegalProfileTourCompleted: Boolean(onboarding?.paralegalProfileTourCompleted),
    attorneyTourCompleted: Boolean(onboarding?.attorneyTourCompleted),
  };
}

function serializePendingHire(pendingHire = {}) {
  if (!pendingHire || !pendingHire.caseId) return null;
  return {
    caseId: String(pendingHire.caseId),
    paralegalName: normStr(pendingHire.paralegalName || "", { len: 200 }).trim(),
    fundUrl: normStr(pendingHire.fundUrl || "", { len: 2000 }).trim(),
    message: normStr(pendingHire.message || "", { len: 2000 }).trim(),
    updatedAt: pendingHire.updatedAt || null,
  };
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
paralegalRouter.use(verifyToken);

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
    const payload = serializePublicUser(me, { includeEmail: true, includeStatus: true, includePhotoMeta: true });
    payload.role = me.role;
    payload.onboarding = serializeOnboarding(me.onboarding || {});
    payload.pendingHire = serializePendingHire(me.pendingHire || {});
    return res.json(payload);
  })
);

router.get(
  "/me/onboarding",
  requireApprovedUser,
  requireRole("paralegal", "attorney", "admin"),
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id).select("onboarding").lean();
    if (!me) return res.status(404).json({ error: "Not found" });
    return res.json({ onboarding: serializeOnboarding(me.onboarding || {}) });
  })
);

router.patch(
  "/me/onboarding",
  csrfProtection,
  requireApprovedUser,
  requireRole("paralegal", "attorney", "admin"),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const updates = {};
    const allowed = [
      "paralegalWelcomeDismissed",
      "paralegalTourCompleted",
      "paralegalProfileTourCompleted",
      "attorneyTourCompleted",
    ];
    allowed.forEach((key) => {
      if (typeof body[key] === "boolean") {
        updates[`onboarding.${key}`] = body[key];
      }
    });
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "No recognized onboarding fields" });
    }
    const me = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true }).select("onboarding");
    if (!me) return res.status(404).json({ error: "Not found" });
    return res.json({ onboarding: serializeOnboarding(me.onboarding || {}) });
  })
);

router.get(
  "/me/pending-hire",
  requireApprovedUser,
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id).select("pendingHire").lean();
    if (!me) return res.status(404).json({ error: "Not found" });
    return res.json({ pendingHire: serializePendingHire(me.pendingHire || {}) });
  })
);

router.put(
  "/me/pending-hire",
  csrfProtection,
  requireApprovedUser,
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const caseId = String(body.caseId || "").trim();
    if (!isObjId(caseId)) {
      return res.status(400).json({ error: "Invalid caseId" });
    }
    const updates = {
      "pendingHire.caseId": caseId,
      "pendingHire.paralegalName": normStr(body.paralegalName || "", { len: 200 }).trim(),
      "pendingHire.fundUrl": normStr(body.fundUrl || "", { len: 2000 }).trim(),
      "pendingHire.message": normStr(body.message || "", { len: 2000 }).trim(),
      "pendingHire.updatedAt": new Date(),
    };
    const me = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true }).select("pendingHire");
    if (!me) return res.status(404).json({ error: "Not found" });
    return res.json({ pendingHire: serializePendingHire(me.pendingHire || {}) });
  })
);

router.delete(
  "/me/pending-hire",
  csrfProtection,
  requireApprovedUser,
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    const me = await User.findByIdAndUpdate(req.user.id, { $set: { pendingHire: null } }, { new: true }).select(
      "pendingHire"
    );
    if (!me) return res.status(404).json({ error: "Not found" });
    return res.json({ pendingHire: null });
  })
);

function normalizeWeekStart(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getDay();
  const diff = (day + 6) % 7;
  date.setDate(date.getDate() - diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function normalizeWeeklyNotes(notes = []) {
  const output = Array(7).fill("");
  notes.forEach((note, idx) => {
    if (idx >= output.length) return;
    output[idx] = cleanMessage(String(note || ""), 2000);
  });
  return output;
}

router.get(
  "/me/weekly-notes",
  requireApprovedUser,
  asyncHandler(async (req, res) => {
    const weekStart = normalizeWeekStart(req.query.weekStart);
    if (!weekStart) return res.status(400).json({ error: "Invalid weekStart" });
    const doc = await WeeklyNote.findOne({ userId: req.user.id, weekStart }).lean();
    const notes = normalizeWeeklyNotes(doc?.notes || []);
    return res.json({
      weekStart: weekStart.toISOString().slice(0, 10),
      notes,
      updatedAt: doc?.updatedAt || null,
    });
  })
);

router.put(
  "/me/weekly-notes",
  csrfProtection,
  requireApprovedUser,
  asyncHandler(async (req, res) => {
    const weekStart = normalizeWeekStart(req.body?.weekStart || req.query?.weekStart);
    if (!weekStart) return res.status(400).json({ error: "Invalid weekStart" });
    const notes = normalizeWeeklyNotes(req.body?.notes || []);
    const doc = await WeeklyNote.findOneAndUpdate(
      { userId: req.user.id, weekStart },
      { $set: { notes } },
      { upsert: true, new: true }
    );
    return res.json({
      weekStart: weekStart.toISOString().slice(0, 10),
      notes: normalizeWeeklyNotes(doc?.notes || []),
      updatedAt: doc?.updatedAt || null,
    });
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
  requireApprovedUser,
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
    await Notification.updateMany(filter, { $set: { read: true, isRead: true } });
    me.notificationsLastViewedAt = new Date();
    await me.save();
    return res.json({ ok: true, seenAt: me.notificationsLastViewedAt });
  })
);

router.get(
  "/me/blocked",
  asyncHandler(async (req, res) => {
    const blocks = await Block.find({ blockerId: req.user.id })
      .sort({ createdAt: -1 })
      .select("blockedId")
      .lean();
    const ids = blocks.map((block) => String(block.blockedId)).filter(Boolean);
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
  requireApprovedUser,
  asyncHandler(async (req, res) => {
    const { userId } = req.body || {};
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid userId" });
    if (String(userId) === String(req.user.id)) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    const requesterRole = String(req.user.role || "").toLowerCase();
    if (!isBlockableRole(requesterRole)) {
      return res.status(403).json({ error: "Blocking is only available to attorneys and paralegals." });
    }

    const target = await User.findById(userId).select("_id firstName lastName email role");
    if (!target) return res.status(404).json({ error: "Target not found" });
    if (!isBlockPairAllowed(requesterRole, target.role)) {
      return res.status(400).json({ error: "Blocking is only available between attorneys and paralegals." });
    }

    const already = await Block.findOne({
      blockerId: req.user.id,
      blockedId: target._id,
    }).select("_id");
    if (!already) {
      await Block.create({ blockerId: req.user.id, blockedId: target._id });
    }

    res.json({ ok: true, blocked: true });
  })
);

router.post(
  "/unblock",
  csrfProtection,
  requireApprovedUser,
  asyncHandler(async (req, res) => {
    const { userId } = req.body || {};
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid userId" });

    await Block.deleteOne({ blockerId: req.user.id, blockedId: userId });

    res.json({ ok: true, blocked: false });
  })
);

/**
 * PATCH /api/users/me
 * Body: { bio?, availability?, resumeURL?, certificateURL?, barNumber?, timezone? }
 * Note: profile photos must be uploaded via /api/uploads/profile-photo.
 */
router.patch(
  "/me",
  csrfProtection,
  requireApprovedUser,
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
    if (typeof body.state === "string") {
      me.state = normStr(body.state, { len: 120 }).trim();
    }
    if (typeof body.primaryPracticeArea === "string") {
      me.primaryPracticeArea = normStr(body.primaryPracticeArea, { len: 200 }).trim();
    }
    if (body.preferredPracticeAreas !== undefined) {
      me.preferredPracticeAreas = cleanList(body.preferredPracticeAreas);
    }
    if (body.practiceAreas !== undefined) {
      me.practiceAreas = cleanList(body.practiceAreas);
    }
    if (body.publications !== undefined) {
      me.publications = cleanList(body.publications);
    }
    if (typeof body.collaborationStyle === "string") {
      me.collaborationStyle = normStr(body.collaborationStyle, { len: 500 }).trim();
    }

    if (typeof bio === "string") {
      const sanitized = normStr(maskProfanity(bio), { len: 4000 });
      me.bio = sanitized;
    }
    const availabilityStr = normalizeAvailability(availability);
    if (availabilityStr) me.availability = availabilityStr;

    let allowMissingPhoto = false;
    if (avatarURL !== undefined || profileImage !== undefined) {
      const trimmedAvatar = typeof avatarURL === "string" ? avatarURL.trim() : "";
      const trimmedImage = typeof profileImage === "string" ? profileImage.trim() : "";
      const hasNewAvatar = avatarURL !== undefined && trimmedAvatar;
      const hasNewImage = profileImage !== undefined && trimmedImage;
      if (hasNewAvatar || hasNewImage) {
        return res.status(400).json({ error: "Profile photos must be uploaded through the photo uploader." });
      }
      const wantsClear =
        (avatarURL !== undefined && !trimmedAvatar) || (profileImage !== undefined && !trimmedImage);
      if (wantsClear) {
        allowMissingPhoto = true;
        me.avatarURL = "";
        me.profileImage = null;
        me.profileImageOriginal = "";
        me.pendingProfileImage = "";
        me.pendingProfileImageOriginal = "";
        me.profilePhotoStatus = "unsubmitted";
      }
    }
    if (typeof timezone === "string" && timezone.length <= 64) {
      me.timezone = timezone;
    }

    if (typeof body.linkedInURL === "string") {
      const trimmed = body.linkedInURL.trim();
      me.linkedInURL = trimmed ? normStr(trimmed, { len: 500 }) : null;
    }

    if (typeof body.firmWebsite === "string") {
      const trimmed = body.firmWebsite.trim();
      me.firmWebsite = trimmed ? normStr(trimmed, { len: 500 }) : "";
    }

    if (me.role === "paralegal") {
      if (resumeURL !== undefined) {
        if (resumeURL === null || String(resumeURL).trim() === "") {
          me.resumeURL = "";
        } else if (typeof resumeURL === "string" && (isURL(resumeURL) || isStorageKey(resumeURL))) {
          me.resumeURL = resumeURL.trim();
        }
      }
      if (certificateURL !== undefined) {
        if (certificateURL === null || String(certificateURL).trim() === "") {
          me.certificateURL = "";
        } else if (typeof certificateURL === "string" && (isURL(certificateURL) || isStorageKey(certificateURL))) {
          me.certificateURL = certificateURL.trim();
        }
      }
      if (body.writingSampleURL !== undefined) {
        const writingSampleURL = body.writingSampleURL;
        if (writingSampleURL === null || String(writingSampleURL).trim() === "") {
          me.writingSampleURL = "";
        } else if (typeof writingSampleURL === "string" && (isURL(writingSampleURL) || isStorageKey(writingSampleURL))) {
          me.writingSampleURL = writingSampleURL.trim();
        }
      }
      if (body.practiceAreas !== undefined) {
        me.practiceAreas = cleanList(body.practiceAreas);
      }
      const rawSkills = body.highlightedSkills !== undefined ? body.highlightedSkills : body.skills;
      if (rawSkills !== undefined) {
        me.skills = cleanList(rawSkills);
      }
      if (body.bestFor !== undefined) {
        me.bestFor = cleanList(body.bestFor);
      }
      if (body.stateExperience !== undefined) {
        me.stateExperience = cleanList(body.stateExperience);
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
          ["school", 200],
          ["fieldOfStudy", 200],
          ["grade", 120],
          ["activities", 1000],
          ["startMonth", 20],
          ["startYear", 10],
          ["endMonth", 20],
          ["endYear", 10]
        ]);
      }
      if (body.yearsExperience !== undefined) {
        const years = Math.max(0, Math.min(80, parseInt(body.yearsExperience, 10) || 0));
        me.yearsExperience = years;
      }
    }
    if (body.languages !== undefined) {
      me.languages = cleanLanguages(body.languages);
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

    if (typeof body.digestFrequency === "string") {
      const normalized = body.digestFrequency.toLowerCase();
      if (["off", "daily", "weekly"].includes(normalized)) {
        me.digestFrequency = normalized;
      }
    }

    if (body.notificationPrefs && typeof body.notificationPrefs === "object") {
      const currentPrefs =
        me.notificationPrefs && typeof me.notificationPrefs.toObject === "function"
          ? me.notificationPrefs.toObject()
          : { ...(me.notificationPrefs || {}) };
      const updates = body.notificationPrefs;
      const allowed = ["email", "emailMessages", "emailCase", "inApp", "inAppMessages", "inAppCase"];
      allowed.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
          currentPrefs[key] = !!updates[key];
        }
      });
      me.notificationPrefs = currentPrefs;
    }

    if (me.role === "paralegal" && !hasRequiredParalegalFieldsForSave(me, { allowMissingPhoto })) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await me.save();
    try {
      await logAction(req, "user.me.update", { targetType: "user", targetId: me._id });
    } catch {}

    return res.json(serializePublicUser(me, { includeEmail: true, includeStatus: true, includePhotoMeta: true }));
  })
);

router.patch(
  "/me/notification-prefs",
  csrfProtection,
  requireApprovedUser,
  asyncHandler(async (req, res) => {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ error: "Not found" });
    const current = me.notificationPrefs
      ? typeof me.notificationPrefs.toObject === "function"
        ? me.notificationPrefs.toObject()
        : { ...me.notificationPrefs }
      : {};
    const updates = req.body || {};
    const allowed = ["inApp", "inAppMessages", "inAppCase", "emailMessages", "emailCase", "email"];
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
  requireApprovedUser,
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
    return res.json(serializePublicUser(me, { includeEmail: true, includeStatus: true, includePhotoMeta: true }));
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
  requireApprovedUser,
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
    return res.json(serializePublicUser(me, { includeEmail: true, includeStatus: true, includePhotoMeta: true }));
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
    if (String(req.user.role || "").toLowerCase() === "attorney") {
      const blockedIds = await getBlockedUserIds(req.user.id);
      if (blockedIds.length) {
        filter._id = { $nin: blockedIds };
      }
    }

    const [docs, total] = await Promise.all([
      User.find(filter).sort(sortOpt).skip((p - 1) * l).limit(l).select(SAFE_PUBLIC_SELECT).lean(),
      User.countDocuments(filter),
    ]);

    const items = docs.map((doc) => serializePublicUser(doc));

    return res.json({ items, page: p, limit: l, total, pages: Math.ceil(total / l), hasMore: p * l < total });
  })
);

router.get(
  "/attorneys/:attorneyId",
  verifyToken,
  asyncHandler(async (req, res) => {
    const { attorneyId } = req.params;
    const jobId = (req.query?.job || "").trim();
    const caseId = (req.query?.caseId || "").trim();
    const requester = req.user;

    if (!requester) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!isObjId(attorneyId)) {
      return res.status(400).json({ error: "Invalid attorney id" });
    }

    if (requester.role === "paralegal") {
      const blocked = await isBlockedBetween(requester._id || requester.id, attorneyId);
      if (blocked) {
        return res.status(403).json({ error: BLOCKED_MESSAGE });
      }
    }

    if (requester.role === "admin") {
      return sendAttorney(attorneyId, res);
    }

    if (requester.role === "attorney") {
      if (String(requester._id || requester.id) !== String(attorneyId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return sendAttorney(attorneyId, res);
    }

    if (requester.role === "paralegal") {
      return sendAttorney(attorneyId, res);
    }

    return res.status(403).json({ error: "Access denied" });
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
    if (String(req.user?.role || "").toLowerCase() === "paralegal") {
      const selfId = String(req.user?.id || req.user?._id || "");
      if (!selfId || selfId !== String(userId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const u = await User.findById(userId).select(SAFE_PUBLIC_SELECT).lean();
    if (!u) return res.status(404).json({ error: "User not found" });
    const requesterRole = String(req.user?.role || "").toLowerCase();
    const isOwner = String(req.user?.id || req.user?._id || "") === String(u._id);
    const isAdmin = requesterRole === "admin";
    if (u.role === "paralegal" && u.preferences?.hideProfile && !isOwner && !isAdmin) {
      return res.status(404).json({ error: "Profile not available" });
    }
    if (u.role === "paralegal" && !isOwner && !isAdmin && !hasRequiredParalegalFieldsForPublic(u)) {
      return res.status(404).json({ error: "Profile not available" });
    }
    if (requesterRole === "attorney") {
      const blocked = await isBlockedBetween(req.user.id, u._id);
      if (blocked) return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    if (u.role !== "paralegal" || u.status !== "approved") {
      return res.status(403).json({ error: "Profile not available" });
    }

    try {
      await logAction(req, "user.profile.view", { targetType: "user", targetId: u._id });
    } catch {}

    return res.json(serializePublicUser(u, { includePhotoMeta: isOwner }));
  })
);


// ----------------------------------------
// Paralegal Directory Routes (/api/paralegals)
// ----------------------------------------
const PARALEGAL_SELECT = `${SAFE_PUBLIC_SELECT} role status email`;

paralegalRouter.get(
  "/",
  requireRole("attorney", "admin"),
  asyncHandler(async (req, res) => {
    const { filter, sortOpt, page, limit } = parseParalegalFilters(req.query);
    const isAdmin = String(req.user.role || "").toLowerCase() === "admin";
    if (!isAdmin) {
      filter["preferences.hideProfile"] = { $ne: true };
      applyPublicParalegalFilter(filter);
    }
    if (String(req.user.role || "").toLowerCase() === "attorney") {
      const blockedIds = await getBlockedUserIds(req.user.id);
      if (blockedIds.length) {
        filter._id = { $nin: blockedIds };
      }
    }
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
  requireRole("paralegal", "attorney", "admin"),
  asyncHandler(async (req, res) => {
    const targetId = resolveParalegalId(req.params.paralegalId, req.user.id);
    if (!isObjId(targetId)) return res.status(400).json({ error: "Invalid paralegal id" });
    if (String(req.user?.role || "").toLowerCase() === "paralegal") {
      const selfId = String(req.user?.id || req.user?._id || "");
      if (!selfId || selfId !== String(targetId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const profile = await User.findById(targetId).select(PARALEGAL_SELECT);
    if (!profile) return res.status(404).json({ error: "Paralegal not found" });
    const requesterRole = String(req.user.role || "").toLowerCase();
    const isOwner = String(profile._id) === String(req.user.id);
    const isAdmin = requesterRole === "admin";
    const hasAttorneyContext =
      requesterRole === "attorney" ? await hasAttorneyParalegalAccess(req.user.id, profile._id) : false;
    if (profile.role === "paralegal" && profile.preferences?.hideProfile && !isOwner && !isAdmin && !hasAttorneyContext) {
      return res.status(404).json({ error: "Paralegal not found" });
    }
    if (
      profile.role === "paralegal" &&
      !isOwner &&
      !isAdmin &&
      !hasAttorneyContext &&
      !hasRequiredParalegalFieldsForPublic(profile)
    ) {
      return res.status(404).json({ error: "Paralegal not found" });
    }
    if (String(req.user.role || "").toLowerCase() === "attorney") {
      const blocked = await isBlockedBetween(req.user.id, profile._id);
      if (blocked) return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    if (profile.role !== "paralegal" && String(profile._id) !== String(req.user.id) && req.user.role !== "admin") {
      return res.status(404).json({ error: "Paralegal not found" });
    }
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

    return res.json(serializePublicUser(profile, { includeEmail: isOwner, includeStatus: isOwner, includePhotoMeta: isOwner }));
  })
);

paralegalRouter.post(
  "/:paralegalId/update",
  requireApprovedUser,
  csrfProtection,
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
    if (body.bestFor !== undefined) paralegal.bestFor = cleanList(body.bestFor);
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

    return res.json(serializePublicUser(paralegal, { includeEmail: isSelf, includeStatus: isSelf, includePhotoMeta: isSelf }));
  })
);

paralegalRouter.post(
  "/:paralegalId/invite",
  requireRole("attorney", "admin"),
  csrfProtection,
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
    const caseAttorneyId = caseDoc.attorney || caseDoc.attorneyId || null;
    if (caseAttorneyId && (await isBlockedBetween(caseAttorneyId, paralegal._id))) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
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

    const wasApproved = user.status === "approved";
    user.status = "approved";
    if (!wasApproved && String(user.role || "").toLowerCase() === "paralegal") {
      user.preferences = {
        ...(typeof user.preferences?.toObject === "function"
          ? user.preferences.toObject()
          : user.preferences || {}),
        hideProfile: true,
      };
    }
    await user.save();
    try {
      await logAction(req, "admin.user.approve", { targetType: "user", targetId: user._id });
    } catch {}

    if (String(user.role).toLowerCase() === "paralegal") {
      try {
        await notifyUser(user._id, "profile_approved", {}, { actorUserId: req.user.id });
      } catch (err) {
        console.warn("[users] notifyUser profile_approved failed", err);
      }
    }

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

async function sendAttorney(attorneyId, res) {
  const attorney = await User.findById(attorneyId).select(
    [
      "firstName",
      "lastName",
      "lawFirm",
      "firmName",
      "company",
      "organization",
      "email",
      "linkedInURL",
      "firmWebsite",
      "practiceDescription",
      "practiceOverview",
      "bio",
      "about",
      "languages",
      "availability",
      "profileImage",
      "avatarURL",
      "experience",
      "practiceAreas",
      "specialties",
      "publications",
      "yearsExperience",
      "location",
      "locationState",
      "state",
      "title",
    ].join(" ")
  );
  if (!attorney) {
    return res.status(404).json({ error: "Attorney not found" });
  }

  return res.json({
    id: attorney._id,
    firstName: attorney.firstName || "",
    lastName: attorney.lastName || "",
    lawFirm: attorney.lawFirm || attorney.firmName || attorney.company || attorney.organization || "",
    name:
      `${attorney.firstName || ""} ${attorney.lastName || ""}`.trim() ||
      attorney.email ||
      "Attorney",
    email: attorney.email || "",
    linkedInURL: attorney.linkedInURL || "",
    firmWebsite: attorney.firmWebsite || "",
    practiceDescription:
      attorney.practiceDescription ||
      attorney.practiceOverview ||
      attorney.bio ||
      attorney.about ||
      "",
    languages: attorney.languages || [],
    availability: attorney.availability || "Available now",
    profileImage: attorney.profileImage || attorney.avatarURL || "",
    experience: attorney.experience || [],
    practiceAreas: attorney.practiceAreas || [],
    specialties: attorney.specialties || [],
    yearsExperience: attorney.yearsExperience || 0,
    location:
      attorney.location ||
      attorney.locationState ||
      attorney.state ||
      "",
    title: attorney.title || "Attorney",
  });
}

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Server error", detail: err?.message || "Unknown error" });
});

router.paralegalRouter = paralegalRouter;

module.exports = router;
