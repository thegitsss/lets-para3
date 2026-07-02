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

const US_STATE_ABBR = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
};
const US_STATE_NAME_BY_ABBR = Object.fromEntries(
  Object.entries(US_STATE_ABBR).map(([name, abbr]) => [abbr, name])
);

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

function buildStateTokens(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const normalizedRaw = raw.replace(/\s+/g, " ");
  const upper = normalizedRaw.toUpperCase();
  const title = normalizedRaw
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
  const stateName = US_STATE_NAME_BY_ABBR[upper] || title;
  const abbr = US_STATE_ABBR[stateName] || upper;
  return [...new Set([normalizedRaw, stateName, abbr].filter(Boolean))];
}

function buildStateFilter(value = "") {
  const values = String(value || "")
    .split(/[|,]/)
    .map((token) => token.trim())
    .filter(Boolean);
  const tokens = values.flatMap(buildStateTokens);
  const uniqueTokens = [...new Set(tokens)];
  const regexes = uniqueTokens.map((token) => new RegExp(`^${escapeRegex(token)}$`, "i"));
  const looseRegexes = uniqueTokens.map((token) => new RegExp(escapeRegex(token), "i"));
  return {
    $or: [
      { state: { $in: regexes } },
      { location: { $in: looseRegexes } },
      { jurisdictions: { $in: regexes } },
      { stateExperience: { $in: regexes } },
    ],
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
        { jurisdictions: rx },
        { stateExperience: rx },
      ];
    }

    if (availability) {
      filter.availability = new RegExp(escapeRegex(availability), "i");
    }

    if (location) {
      filter.$and = [...(filter.$and || []), buildStateFilter(location)];
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
