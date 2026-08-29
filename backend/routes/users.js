const { createLogger: createRuntimeLogger, logPromiseFailure } = require("../utils/logger");
const runtimeLogger = createRuntimeLogger("routes:users");
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
const ChecklistTask = require("../models/ChecklistTask");
const Notification = require("../models/Notification");
const Job = require("../models/Job");
const Block = require("../models/Block");
const WeeklyNote = require("../models/WeeklyNote");
const { maskProfanity } = require("../utils/badWords");
const { logAction } = require("../utils/audit");
const { csrfProtection, respondToCsrfError } = require("../utils/csrf");
const { createS3Client } = require("../utils/s3Client");
const { cleanMessage } = require("../utils/sanitize");
const {
  applyPublicParalegalFilter,
  hasRequiredParalegalFieldsForPublic,
} = require("../utils/paralegalProfile");
const { buildObjectDeepLink } = require("../services/objectDeepLinks");
const { normalizeEmail, sendVerificationEmail } = require("../utils/emailVerification");
const {
  buildAuthenticatedProfilePhotoUrl,
  buildPublicProfilePhotoUrl,
  hasPhotoReference,
  resolveProfilePhotoKey,
  streamProfilePhoto,
} = require("../services/profilePhotoDelivery");
const {
  ACTIVE_BLOCK_FILTER,
  BLOCKED_MESSAGE,
  deactivateBlock,
  findActiveBlockBetween,
  getBlockedUserIds,
  isBlockedBetween,
} = require("../utils/blocks");
const { extractPersonalFileKey } = require("../utils/personalFileReference");
const {
  activatePersonalStorageDeletion,
  cancelPersonalStorageDeletion,
  collectUserPersonalStorageKeys,
  normalizeOwnedPersonalKey,
  stagePersonalStorageDeletion,
} = require("../services/personalStorageDeletion");

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isObjId = (id) => mongoose.isValidObjectId(id);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const { normalizeHttpUrl } = require("../utils/httpUrl");
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
const profilePhotoS3 = createS3Client();
const hasAttorneyParalegalAccess = async (attorneyId, paralegalId) => {
  if (!isObjId(attorneyId) || !isObjId(paralegalId)) return false;
  const caseMatch = await Case.exists({
    $and: [
      { $or: [{ attorney: attorneyId }, { attorneyId }] },
      { $or: [
        { paralegal: paralegalId },
        { paralegalId },
        { "applicants.paralegalId": paralegalId },
      ] },
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
  "_id role firstName lastName avatarURL profileImage profileImageOriginal pendingProfileImage pendingProfileImageOriginal profilePhotoStatus location specialties practiceAreas skills bestFor experience yearsExperience linkedInURL firmWebsite certificateURL writingSampleURL education resumeURL publications notificationPrefs preferences lawFirm bio about availability availabilityDetails approvedAt createdAt updatedAt languages writingSamples status stateExperience";
const SAFE_SELF_SELECT = `${SAFE_PUBLIC_SELECT} email pendingEmail pendingEmailRequestedAt phoneNumber onboarding pendingHire`;
function protectedDocumentKey(value, ownerId, type) {
  return extractPersonalFileKey(value, {
    ownerId,
    type,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    cdnBase: process.env.CDN_BASE_URL || process.env.S3_PUBLIC_BASE_URL,
  });
}

function serializePublicUser(user, { includeEmail = false, includeStatus = false, includePhotoMeta = false } = {}) {
  if (!user) return null;
  const src = user.toObject ? user.toObject() : user;
  const role = String(src.role || "").toLowerCase();
  const isParalegal = role === "paralegal";
  const hasApprovedPhoto = hasPhotoReference(src, "approved");
  const hasPendingPhoto = hasPhotoReference(src, "pending");
  const publicPhotoReady =
    isParalegal &&
    String(src.profilePhotoStatus || "").toLowerCase() === "approved" &&
    !hasPendingPhoto &&
    src.preferences?.hideProfile !== true &&
    hasRequiredParalegalFieldsForPublic(src);
  const profileImage = hasApprovedPhoto
    ? publicPhotoReady
      ? buildPublicProfilePhotoUrl(src)
      : buildAuthenticatedProfilePhotoUrl(src)
    : "";
  const avatarURL = profileImage;
  const rawPhotoStatus = String(src.profilePhotoStatus || "").trim();
  const resolvedPhotoStatus = isParalegal
    ? rawPhotoStatus ||
      (src.pendingProfileImage ? "pending_review" : avatarURL || profileImage ? "approved" : "unsubmitted")
    : avatarURL || profileImage
    ? "approved"
    : "unsubmitted";
  const certificateURL = protectedDocumentKey(src.certificateURL, src._id, "certificate");
  const writingSampleURL = protectedDocumentKey(src.writingSampleURL, src._id, "writingSample");
  const resumeURL = protectedDocumentKey(src.resumeURL, src._id, "resume");
  const profileImageOriginal = includePhotoMeta && hasPhotoReference(src, "approved-original")
    ? buildAuthenticatedProfilePhotoUrl(src, { variant: "approved-original" })
    : "";
  const pendingProfileImageOriginal = includePhotoMeta && hasPhotoReference(src, "pending-original")
    ? buildAuthenticatedProfilePhotoUrl(src, { variant: "pending-original" })
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
    certificateKey: certificateURL,
    resumeKey: resumeURL,
    writingSampleKey: writingSampleURL,
    education: Array.isArray(src.education) ? src.education : [],
    experience: Array.isArray(src.experience) ? src.experience : [],
    availability: src.availability || "",
    availabilityDetails: src.availabilityDetails || null,
    approvedAt: src.approvedAt || null,
    createdAt: src.createdAt || null,
    bio: src.bio || "",
    about: src.about || "",
    writingSamples: Array.isArray(src.writingSamples) ? src.writingSamples : [],
    languages: cleanLanguages(src.languages || []),
    notificationPrefs: src.notificationPrefs || null,
    preferences: {
      theme:
        String(src.preferences && typeof src.preferences === "object" ? src.preferences.theme || "" : "").toLowerCase() === "dark"
          ? "dark"
          : "light",
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
    payload.pendingEmail = src.pendingEmail || "";
    payload.pendingEmailRequestedAt = src.pendingEmailRequestedAt || null;
    payload.phoneNumber = src.phoneNumber || "";
  }
  if (includeStatus) {
    payload.status = src.status || "";
  }
  if (includePhotoMeta) {
    payload.profilePhotoStatus = resolvedPhotoStatus;
    payload.pendingProfileImage = hasPhotoReference(src, "pending")
      ? buildAuthenticatedProfilePhotoUrl(src, { variant: "pending" })
      : "";
    payload.profileImageOriginal = profileImageOriginal;
    payload.pendingProfileImageOriginal = pendingProfileImageOriginal;
  }
  return payload;
}

function serializeOnboarding(onboarding = {}) {
  return {
    paralegalTourCompleted: Boolean(onboarding?.paralegalTourCompleted),
    paralegalProfileTourCompleted: Boolean(onboarding?.paralegalProfileTourCompleted),
    attorneyTourCompleted: Boolean(onboarding?.attorneyTourCompleted),
    attorneyProfileCompleted: Boolean(onboarding?.attorneyProfileCompleted),
  };
}

function hasAttorneyProfileDetails(user = {}) {
  const practiceAreas = Array.isArray(user.practiceAreas)
    ? user.practiceAreas.filter((item) => String(item || "").trim())
    : [];
  const publications = Array.isArray(user.publications)
    ? user.publications.filter((item) => String(item || "").trim())
    : [];
  return Boolean(
    practiceAreas.length ||
      publications.length ||
      String(user.practiceDescription || user.bio || "").trim() ||
      String(user.lawFirm || "").trim() ||
      String(user.linkedInURL || "").trim() ||
      String(user.firmWebsite || "").trim()
  );
}

function resolveAttorneyProfileCompleted(user = {}) {
  if (user?.onboarding?.attorneyProfileCompleted) return true;
  return hasAttorneyProfileDetails(user);
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
  const isAttorney = String(userDoc.role).toLowerCase() === "attorney";
  const taskFilter = { owner: ownerId };
  const caseFilter = {};
  if (isAttorney) {
    caseFilter.attorney = ownerId;
  } else if (String(userDoc.role).toLowerCase() === "paralegal") {
    caseFilter.paralegal = ownerId;
  }

  const [stored, tasks, cases] = await Promise.all([
    Notification.find({ userId: ownerId }).sort({ createdAt: -1 }).limit(12).lean(),
    isAttorney
      ? ChecklistTask.find(taskFilter)
        .sort({ updatedAt: -1 })
        .limit(8)
        .select("title notes due createdAt updatedAt caseId done")
      : Promise.resolve([]),
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
      title: c.title || "Matter update",
      body: c.status ? `Status updated to ${c.status.replace(/_/g, " ")}` : "Matter timeline updated.",
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

router.get(
  "/profile-photo/:userId",
  requireApprovedUser,
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId || "");
    const variant = String(req.query?.variant || "approved").trim().toLowerCase();
    const allowedVariants = new Set(["approved", "approved-original", "pending", "pending-original"]);
    if (!isObjId(userId) || !allowedVariants.has(variant) || !process.env.S3_BUCKET) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Profile photo unavailable." });
    }

    const target = await User.findById(userId)
      .select(
        "_id role status disabled deleted preferences bio skills practiceAreas resumeURL " +
        "profilePhotoStatus profileImage avatarURL profileImageOriginal pendingProfileImage pendingProfileImageOriginal updatedAt " +
        "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
      )
      .lean();
    if (!target || target.disabled === true || target.deleted === true) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Profile photo unavailable." });
    }

    const viewerId = String(req.user?.id || req.user?._id || "");
    const viewerRole = String(req.user?.role || "").toLowerCase();
    const isOwner = viewerId === String(target._id);
    const isAdmin = viewerRole === "admin";
    const isPrivateVariant = variant !== "approved";
    if (isPrivateVariant && !isOwner && !isAdmin) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Profile photo unavailable." });
    }

    const targetRole = String(target.role || "").toLowerCase();
    if (!isOwner && !isAdmin) {
      if (target.status !== "approved" || variant !== "approved") {
        res.set("Cache-Control", "no-store");
        return res.status(404).json({ error: "Profile photo unavailable." });
      }
      if (await isBlockedBetween(viewerId, target._id)) {
        res.set("Cache-Control", "no-store");
        return res.status(404).json({ error: "Profile photo unavailable." });
      }
      if (targetRole === "paralegal") {
        const isPublicProfile =
          target.preferences?.hideProfile !== true &&
          hasRequiredParalegalFieldsForPublic(target);
        if (isPublicProfile) {
          return res.redirect(302, buildPublicProfilePhotoUrl(target));
        }
        const hasRelationship =
          viewerRole === "attorney" &&
          (await hasAttorneyParalegalAccess(viewerId, target._id));
        if (!hasRelationship) {
          res.set("Cache-Control", "no-store");
          return res.status(404).json({ error: "Profile photo unavailable." });
        }
      }
      if (targetRole !== "attorney") {
        res.set("Cache-Control", "no-store");
        return res.status(404).json({ error: "Profile photo unavailable." });
      }
    }

    const key = resolveProfilePhotoKey(target, {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      variant,
    });
    if (!key) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Profile photo unavailable." });
    }
    const served = await streamProfilePhoto({
      req,
      res,
      s3: profilePhotoS3,
      bucket: process.env.S3_BUCKET,
      key,
      cacheControl: "private, max-age=3600",
    });
    if (!served && !res.headersSent) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Profile photo unavailable." });
    }
    return undefined;
  })
);

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
    if (String(me.role || "").toLowerCase() === "attorney" && !payload.onboarding.attorneyProfileCompleted) {
      payload.onboarding.attorneyProfileCompleted = resolveAttorneyProfileCompleted(me);
    }
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
      "paralegalTourCompleted",
      "paralegalProfileTourCompleted",
      "attorneyTourCompleted",
      "attorneyProfileCompleted",
    ];
    allowed.forEach((key) => {
      if (typeof body[key] === "boolean") {
        updates[`onboarding.${key}`] = body[key];
      }
    });
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "No recognized onboarding fields" });
    }
    const me = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { returnDocument: "after" }
    ).select("onboarding");
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
    const me = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { returnDocument: "after" }
    ).select("pendingHire");
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
    const me = await User.findByIdAndUpdate(
      req.user.id,
      { $set: { pendingHire: null } },
      { returnDocument: "after" }
    ).select(
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
      { upsert: true, returnDocument: "after" }
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
    const blocks = await Block.find({ blockerId: req.user.id, ...ACTIVE_BLOCK_FILTER })
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
  asyncHandler(async (_req, res) => {
    return res.status(403).json({
      error: "Blocking can only be created from a finalized Matter outcome.",
    });
  })
);

router.post(
  "/unblock",
  csrfProtection,
  requireApprovedUser,
  asyncHandler(async (req, res) => {
    const { userId } = req.body || {};
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid userId" });

    // Legacy unblock endpoint. Keep this silent: never notify the other user.
    await deactivateBlock({ blockerId: req.user.id, blockedId: userId });

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
    const me = await User.findById(req.user.id).select(
      "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
    );
    if (!me) return res.status(404).json({ error: "Not found" });

    const body = req.body || {};
    const storageKeysToDelete = [];
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
    let pendingEmailChanged = false;
    if (typeof nextEmail === "string" && nextEmail.trim()) {
      const normalizedEmail = normalizeEmail(normStr(nextEmail, { len: 320 }));
      if (
        normalizedEmail &&
        normalizedEmail !== normalizeEmail(me.email) &&
        normalizedEmail !== normalizeEmail(me.pendingEmail)
      ) {
        const exists = await User.countDocuments({
          _id: { $ne: me._id },
          $or: [{ email: normalizedEmail }, { pendingEmail: normalizedEmail }],
        });
        if (exists) return res.status(409).json({ error: "Email already in use" });
        me.pendingEmail = normalizedEmail;
        me.pendingEmailRequestedAt = new Date();
        pendingEmailChanged = true;
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
        storageKeysToDelete.push(
          ...collectUserPersonalStorageKeys(me).filter((key) =>
            key.startsWith(`profile-photos/${me._id}/`)
          )
        );
        me.avatarURL = "";
        me.profileImage = null;
        me.profileImageKey = "";
        me.profileImageOriginal = "";
        me.profileImageOriginalKey = "";
        me.pendingProfileImage = "";
        me.pendingProfileImageKey = "";
        me.pendingProfileImageOriginal = "";
        me.pendingProfileImageOriginalKey = "";
        me.profilePhotoStatus = "unsubmitted";
      }
    }
    if (typeof timezone === "string" && timezone.length <= 64) {
      me.timezone = timezone;
    }

    if (["attorney", "paralegal"].includes(me.role) && (typeof body.linkedInURL === "string" || body.linkedInURL === null)) {
      const linkedIn = normalizeHttpUrl(body.linkedInURL, {
        fieldLabel: "LinkedIn URL",
        requiredHost: "linkedin.com",
      });
      if (!linkedIn.ok) return res.status(400).json({ error: linkedIn.error });
      me.linkedInURL = linkedIn.value || null;
    }

    if (me.role === "attorney" && typeof body.firmWebsite === "string") {
      const firmWebsite = normalizeHttpUrl(body.firmWebsite, { fieldLabel: "Firm website" });
      if (!firmWebsite.ok) return res.status(400).json({ error: firmWebsite.error });
      me.firmWebsite = firmWebsite.value;
    }

    if (me.role === "paralegal") {
      if (resumeURL !== undefined) {
        if (resumeURL === null || String(resumeURL).trim() === "") {
          const oldKey = normalizeOwnedPersonalKey(me.resumeURL, me._id);
          if (oldKey) storageKeysToDelete.push(oldKey);
          me.resumeURL = "";
        } else {
          const requested = protectedDocumentKey(resumeURL, me._id, "resume");
          const current = protectedDocumentKey(me.resumeURL, me._id, "resume");
          if (!requested || requested !== current) {
            return res.status(400).json({ error: "Résumés must be saved through the protected document uploader." });
          }
          me.resumeURL = current;
        }
      }
      if (certificateURL !== undefined) {
        if (certificateURL === null || String(certificateURL).trim() === "") {
          const oldKey = normalizeOwnedPersonalKey(me.certificateURL, me._id);
          if (oldKey) storageKeysToDelete.push(oldKey);
          me.certificateURL = "";
        } else {
          const requested = protectedDocumentKey(certificateURL, me._id, "certificate");
          const current = protectedDocumentKey(me.certificateURL, me._id, "certificate");
          if (!requested || requested !== current) {
            return res.status(400).json({ error: "Certificates must be saved through the protected document uploader." });
          }
          me.certificateURL = current;
        }
      }
      if (body.writingSampleURL !== undefined) {
        const writingSampleURL = body.writingSampleURL;
        if (writingSampleURL === null || String(writingSampleURL).trim() === "") {
          const oldKey = normalizeOwnedPersonalKey(me.writingSampleURL, me._id);
          if (oldKey) storageKeysToDelete.push(oldKey);
          me.writingSampleURL = "";
        } else {
          const requested = protectedDocumentKey(writingSampleURL, me._id, "writingSample");
          const current = protectedDocumentKey(me.writingSampleURL, me._id, "writingSample");
          if (!requested || requested !== current) {
            return res.status(400).json({ error: "Writing samples must be saved through the protected document uploader." });
          }
          me.writingSampleURL = current;
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

    if (me.role === "attorney") {
      me.onboarding = {
        ...(me.onboarding?.toObject ? me.onboarding.toObject() : me.onboarding || {}),
        attorneyProfileCompleted: true,
      };
    }

    const storageTaskIds = await stagePersonalStorageDeletion({
      ownerId: me._id,
      keys: storageKeysToDelete,
      reason: "profile_personal_file_cleared",
    });
    try {
      await me.save();
    } catch (error) {
      await cancelPersonalStorageDeletion(storageTaskIds).catch(
        logPromiseFailure(runtimeLogger, "[users] personal storage deletion rollback failed")
      );
      throw error;
    }
    await activatePersonalStorageDeletion(storageTaskIds).catch((error) => {
      runtimeLogger.error("[users] personal storage deletion activation deferred", {
        errorCode: String(error?.name || error?.code || "STORAGE_TASK_TRANSITION_FAILED"),
      });
    });

    if (pendingEmailChanged && me.pendingEmail) {
      try {
        await sendVerificationEmail({ user: me, email: me.pendingEmail });
      } catch (err) {
        runtimeLogger.warn("[users] pending email verification send failed", err?.message || err);
      }
    }
    try {
      await logAction(req, "user.me.update", { targetType: "user", targetId: me._id });
    } catch (auditError) {
      runtimeLogger.error("[users] profile update audit persistence failed", auditError);
    }

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
      { returnDocument: "after" }
    );
    if (!me) return res.status(404).json({ error: "Not found" });
    try {
      await logAction(req, "user.me.availability", {
        targetType: "user",
        targetId: me._id,
        meta: { availability: me.availability },
      });
    } catch (auditError) {
      runtimeLogger.error("[users] availability audit persistence failed", auditError);
    }
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

    const me = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { returnDocument: "after" }
    );
    if (!me) return res.status(404).json({ error: "Not found" });

    try {
      await logAction(req, "user.me.emailPref", { targetType: "user", targetId: me._id, meta: updates });
    } catch (auditError) {
      runtimeLogger.error("[users] email preference audit persistence failed", auditError);
    }
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
  requireApprovedUser,
  asyncHandler(async (req, res) => {
    const { attorneyId } = req.params;
    const requester = req.user;
    const requesterRole = String(requester?.role || "").toLowerCase();

    if (!requester) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!isObjId(attorneyId)) {
      return res.status(400).json({ error: "Invalid attorney id" });
    }
    if (Object.keys(req.query || {}).length) {
      return res.status(400).json({ error: "Unsupported attorney profile query parameter." });
    }

    if (requesterRole === "paralegal") {
      const blocked = await isBlockedBetween(requester._id || requester.id, attorneyId);
      if (blocked) {
        return res.status(403).json({ error: BLOCKED_MESSAGE });
      }
    }

    if (requesterRole === "admin") {
      return sendAttorney(attorneyId, res, { allowUnapproved: true });
    }

    if (requesterRole === "attorney") {
      if (String(requester._id || requester.id) !== String(attorneyId)) {
        return res.status(403).json({ error: "Forbidden" });
      }
      return sendAttorney(attorneyId, res);
    }

    if (requesterRole === "paralegal") {
      return sendAttorney(attorneyId, res);
    }

    return res.status(403).json({ error: "Access denied" });
  })
);

/**
 * GET /api/users/profile-preview/:userId
 * Strict contextual Profile projection; the full Profile route remains authoritative.
 */
router.get(
  "/profile-preview/:userId",
  requireApprovedUser,
  requireRole("attorney", "paralegal"),
  asyncHandler(async (req, res) => {
    const userId = String(req.params.userId || "");
    if (!isObjId(userId)) return res.status(400).json({ error: "Invalid Profile reference" });
    const requesterRole = String(req.user?.role || "").toLowerCase();
    const requesterId = String(req.user?.id || req.user?._id || "");
    const isOwner = requesterId === userId;
    if (requesterRole === "paralegal" && !isOwner) {
      return res.status(404).json({ error: "Profile not available" });
    }
    const profile = await User.findOne({
      _id: userId,
      role: "paralegal",
      disabled: { $ne: true },
      deleted: { $ne: true },
    })
      .select(
        "_id firstName lastName bio about practiceAreas specialties skills experience yearsExperience location state availability approvedAt createdAt status preferences profilePhotoStatus resumeURL profileImage avatarURL pendingProfileImage"
      )
      .lean();
    if (!profile) return res.status(404).json({ error: "Profile not available" });
    if (!isOwner && profile.status !== "approved") {
      return res.status(404).json({ error: "Profile not available" });
    }
    const hasRelationship =
      requesterRole === "attorney" ? await hasAttorneyParalegalAccess(requesterId, userId) : false;
    if (!isOwner && profile.preferences?.hideProfile && !hasRelationship) {
      return res.status(404).json({ error: "Profile not available" });
    }
    if (!isOwner && !hasRelationship && !hasRequiredParalegalFieldsForPublic(profile)) {
      return res.status(404).json({ error: "Profile not available" });
    }
    if (requesterRole === "attorney" && (await isBlockedBetween(requesterId, userId))) {
      return res.status(404).json({ error: "Profile not available" });
    }
    const name = `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || "Paralegal";
    res.set("Cache-Control", "no-store");
    return res.json({
      profile: {
        id: String(profile._id),
        name,
        bio: String(profile.bio || profile.about || "").slice(0, 1000),
        location: String(profile.location || profile.state || "").slice(0, 300),
        practiceAreas: Array.isArray(profile.practiceAreas) ? profile.practiceAreas.slice(0, 12) : [],
        specialties: Array.isArray(profile.specialties) ? profile.specialties.slice(0, 12) : [],
        skills: Array.isArray(profile.skills) ? profile.skills.slice(0, 16) : [],
        experience: String(profile.experience || "").slice(0, 1000),
        yearsExperience: Number.isFinite(Number(profile.yearsExperience)) ? Number(profile.yearsExperience) : null,
        availability: String(profile.availability || "").slice(0, 200),
        fullHref: buildObjectDeepLink({ type: "profile", profileId: profile._id }),
      },
    });
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
    } catch (auditError) {
      runtimeLogger.warn("[users] profile view audit persistence failed", auditError);
    }

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
      const block = await findActiveBlockBetween(req.user.id, profile._id);
      if (block) {
        return res.status(403).json({
          error: BLOCKED_MESSAGE,
          blockedByProfileOwner: String(block.blockerId) === String(profile._id),
        });
      }
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
    } catch (auditError) {
      runtimeLogger.warn("[users] paralegal profile view audit persistence failed", auditError);
    }

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
    } catch (auditError) {
      runtimeLogger.error("[users] paralegal profile update audit persistence failed", auditError);
    }

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
    if (!caseDoc) return res.status(404).json({ error: "Matter not found" });
    const caseAttorneyId = caseDoc.attorney || caseDoc.attorneyId || null;
    if (caseAttorneyId && (await isBlockedBetween(caseAttorneyId, paralegal._id))) {
      return res.status(403).json({ error: BLOCKED_MESSAGE });
    }
    if (req.user.role !== "admin" && String(caseDoc.attorney) !== String(req.user.id)) {
      return res.status(403).json({ error: "Only the Matter owner can send invitations" });
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
    } catch (auditError) {
      runtimeLogger.error("[users] paralegal invitation audit persistence failed", auditError);
    }

    res.json({ ok: true, message: "Invite sent" });
  })
);

async function sendAttorney(attorneyId, res, { allowUnapproved = false } = {}) {
  const attorney = await User.findById(attorneyId).select(
    [
      "role",
      "status",
      "disabled",
      "deleted",
      "firstName",
      "lastName",
      "lawFirm",
      "linkedInURL",
      "firmWebsite",
      "bio",
      "about",
      "languages",
      "profileImage",
      "avatarURL",
      "experience",
      "practiceAreas",
      "specialties",
      "publications",
      "yearsExperience",
      "location",
      "state",
    ].join(" ")
  );
  if (!attorney) {
    return res.status(404).json({ error: "Attorney not found" });
  }
  if (
    String(attorney.role || "").toLowerCase() !== "attorney"
    || attorney.disabled === true
    || attorney.deleted === true
    || (!allowUnapproved && String(attorney.status || "").toLowerCase() !== "approved")
  ) {
    return res.status(404).json({ error: "Attorney profile not available" });
  }

  return res.json({
    id: attorney._id,
    firstName: attorney.firstName || "",
    lastName: attorney.lastName || "",
    lawFirm: attorney.lawFirm || "",
    name:
      `${attorney.firstName || ""} ${attorney.lastName || ""}`.trim() ||
      "Attorney",
    linkedInURL: attorney.linkedInURL || "",
    firmWebsite: attorney.firmWebsite || "",
    practiceDescription:
      attorney.bio ||
      attorney.about ||
      "",
    languages: attorney.languages || [],
    profileImage:
      attorney.profileImage || attorney.avatarURL
        ? buildAuthenticatedProfilePhotoUrl(attorney)
        : "",
    experience: attorney.experience || [],
    practiceAreas: attorney.practiceAreas || [],
    specialties: attorney.specialties || [],
    publications: attorney.publications || [],
    yearsExperience: attorney.yearsExperience || 0,
    location:
      attorney.location ||
      attorney.state ||
      "",
  });
}

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  if (respondToCsrfError(err, res)) return;
  runtimeLogger.error(err);
  res.status(500).json({ error: "Server error" });
});

router.paralegalRouter = paralegalRouter;

module.exports = router;
