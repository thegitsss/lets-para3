const express = require("express");
const rateLimit = require("express-rate-limit");

const User = require("../models/User");
const verifyToken = require("../utils/verifyToken");
const { getBlockedUserIds } = require("../utils/blocks");
const { applyPublicParalegalFilter } = require("../utils/paralegalProfile");

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const escapeRegex = (str = "") => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PUBLIC_PAR_FIELDS =
  "_id firstName lastName avatarURL profileImage location state specialties practiceAreas bestFor yearsExperience linkedInURL education bio about availability approvedAt createdAt";

function serializeParalegal(userDoc) {
  if (!userDoc) return null;
  const src = userDoc.toObject ? userDoc.toObject() : userDoc;
  return {
    _id: String(src._id),
    id: String(src._id),
    firstName: src.firstName || "",
    lastName: src.lastName || "",
    name: `${src.firstName || ""} ${src.lastName || ""}`.trim(),
    avatarURL: src.avatarURL || "",
    profileImage: src.profileImage || "",
    location: src.location || src.state || "",
    state: src.state || "",
    specialties: Array.isArray(src.specialties) ? src.specialties : [],
    practiceAreas: Array.isArray(src.practiceAreas) ? src.practiceAreas : [],
    bestFor: Array.isArray(src.bestFor) ? src.bestFor : [],
    yearsExperience: typeof src.yearsExperience === "number" ? src.yearsExperience : null,
    linkedInURL: src.linkedInURL || "",
    education: Array.isArray(src.education) ? src.education : [],
    bio: src.bio || "",
    about: src.about || "",
    availability: src.availability || "",
    approvedAt: src.approvedAt || null,
    createdAt: src.createdAt || null,
  };
}

router.get(
  "/",
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many directory requests. Please slow down." },
  }),
  verifyToken.optional,
  asyncHandler(async (req, res) => {
    const page = clamp(parseInt(req.query.page, 10) || 1, 1, 10_000);
    const limit = clamp(parseInt(req.query.limit, 10) || 12, 1, 50);
    const search =
      typeof req.query.q === "string" && req.query.q.trim()
        ? req.query.q.trim()
        : typeof req.query.search === "string"
        ? req.query.search.trim()
        : "";
    const availability = typeof req.query.availability === "string" ? req.query.availability.trim() : "";
    const location = typeof req.query.location === "string" ? req.query.location.trim() : "";
    const practiceRaw = typeof req.query.practice === "string" ? req.query.practice.trim() : "";
    const minYears = parseInt(req.query.minYears, 10);
    const sortKey = typeof req.query.sort === "string" ? req.query.sort.trim().toLowerCase() : "recent";

    const filter = { role: "paralegal", status: "approved" };
    filter["preferences.hideProfile"] = { $ne: true };
    applyPublicParalegalFilter(filter);

    if (String(req.user?.role || "").toLowerCase() === "attorney") {
      const blockedIds = await getBlockedUserIds(req.user.id);
      if (blockedIds.length) {
        filter._id = { $nin: blockedIds };
      }
    }

    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { firstName: rx },
        { lastName: rx },
        { bio: rx },
        { about: rx },
        { specialties: rx },
        { practiceAreas: rx },
        { location: rx },
        { state: rx },
      ];
    }

    if (availability) {
      filter.availability = new RegExp(escapeRegex(availability), "i");
    }

    if (location) {
      const rx = new RegExp(escapeRegex(location), "i");
      filter.$and = [...(filter.$and || []), { $or: [{ location: rx }, { state: rx }] }];
    }

    if (practiceRaw) {
      const tokens = practiceRaw
        .split(/[|,]/)
        .map((token) => token.trim())
        .filter(Boolean)
        .map((token) => new RegExp(escapeRegex(token), "i"));
      if (tokens.length) {
        filter.$and = [
          ...(filter.$and || []),
          { $or: [{ practiceAreas: { $in: tokens } }, { specialties: { $in: tokens } }] },
        ];
      }
    }

    if (Number.isFinite(minYears) && minYears > 0) {
      filter.yearsExperience = { $gte: minYears };
    }

    const sort =
      sortKey === "alpha"
        ? { firstName: 1, lastName: 1 }
        : sortKey === "experience"
        ? { yearsExperience: -1 }
        : { createdAt: -1 };

    const [docs, total] = await Promise.all([
      User.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .select(PUBLIC_PAR_FIELDS)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      items: docs.map(serializeParalegal),
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    });
  })
);

module.exports = router;
