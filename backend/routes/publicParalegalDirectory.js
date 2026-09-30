const express = require("express");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");

const User = require("../models/User");
const verifyToken = require("../utils/verifyToken");
const { createS3Client } = require("../utils/s3Client");
const { getBlockedUserIds } = require("../utils/blocks");
const { applyPublicParalegalFilter } = require("../utils/paralegalProfile");
const {
  PROFILE_SOURCE_SELECT,
  PROFILE_SOURCE_FIELDS,
  projectCanonicalProfile,
} = require("../services/objectSystem/profileAuthorityContract");
const { projectPresentation } = require("../services/objectSystem/presentationContract");
const {
  buildPublicProfilePhotoUrl,
  resolveProfilePhotoKey,
  streamProfilePhoto,
} = require("../services/profilePhotoDelivery");

const router = express.Router();
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const escapeRegex = (str = "") => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const s3 = createS3Client();

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
  `${PROFILE_SOURCE_SELECT} availabilityDetails bestFor linkedInURL education approvedAt createdAt`;

function serializeParalegal(userDoc) {
  if (!userDoc) return null;
  const raw = userDoc.toObject ? userDoc.toObject() : userDoc;
  const src = { ...raw, ...require("../utils/availability").effectiveAvailability(raw) };
  let presentation;
  try {
    const profileSource = Object.fromEntries(PROFILE_SOURCE_FIELDS
      .filter((field) => !field.includes(".") && Object.prototype.hasOwnProperty.call(src, field))
      .map((field) => [field, src[field]]));
    if (src.preferences) profileSource.preferences = { hideProfile: src.preferences.hideProfile };
    presentation = projectPresentation(projectCanonicalProfile({
      source: profileSource,
      tier: "public",
      authorizationEvidence: { authorized: true, boundary: "public", publicVisibilityVerified: true },
      expectedSourceUpdatedAt: new Date(src.updatedAt).toISOString(),
    }), { kind: "card" });
  } catch {
    return null;
  }
  const photoUrl = buildPublicProfilePhotoUrl(src);
  return {
    _id: String(src._id),
    id: String(src._id),
    firstName: src.firstName || "",
    lastName: src.lastName || "",
    name: `${src.firstName || ""} ${src.lastName || ""}`.trim(),
    avatarURL: photoUrl,
    profileImage: photoUrl,
    photoUrl,
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
    presentation,
  };
}

// Anonymous network totals include approved accounts regardless of directory readiness.
// Never return member identities, profile visibility, or precise locations.
router.get("/state-counts", rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }), asyncHandler(async (_req, res) => {
  const filter = { role: "paralegal", status: "approved", disabled: { $ne: true }, deleted: { $ne: true } };
  const groups = await User.aggregate([
    { $match: filter },
    { $group: { _id: { state: "$state", location: "$location", stateExperience: "$stateExperience" }, count: { $sum: 1 } } },
  ]);
  const states = Object.fromEntries([...Object.values(US_STATE_ABBR), "DC"].map(code => [code, 0]));
  const approvedTotal = groups.reduce((sum, group) => sum + group.count, 0);
  const normalize = value => {
    const token = String(value || "").trim().toUpperCase();
    if (Object.hasOwn(states, token)) return token;
    if (token === "DISTRICT OF COLUMBIA" || token === "WASHINGTON DC" || token === "WASHINGTON, DC") return "DC";
    return Object.entries(US_STATE_ABBR).find(([name]) => name.toUpperCase() === token)?.[1];
  };
  for (const group of groups) {
    const explicit = String(group._id.state || "").trim();
    const experience = Array.isArray(group._id.stateExperience)
      ? group._id.stateExperience.map(normalize).find(Boolean)
      : undefined;
    const code = normalize(explicit) || experience || normalize(String(group._id.location || "").split(",").pop());
    if (code) states[code] += group.count;
  }
  res.set("Cache-Control", "public, max-age=300");
  res.json({ states, total: Object.values(states).reduce((sum, count) => sum + count, 0), approvedTotal });
}));

router.get(
  "/:profileId/photo",
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Profile photo unavailable." },
  }),
  asyncHandler(async (req, res) => {
    const profileId = String(req.params.profileId || "");
    if (!mongoose.isValidObjectId(profileId) || !process.env.S3_BUCKET) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Profile photo unavailable." });
    }

    const filter = {
      _id: profileId,
      role: "paralegal",
      status: "approved",
      disabled: { $ne: true },
      deleted: { $ne: true },
      "preferences.hideProfile": { $ne: true },
    };
    applyPublicParalegalFilter(filter);
    const profile = await User.findOne(filter)
      .select(
        "_id profileImage avatarURL profilePhotoStatus pendingProfileImage " +
        "+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey"
      )
      .lean();
    const key = resolveProfilePhotoKey(profile, {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      variant: "approved",
    });
    if (!profile || !key) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Profile photo unavailable." });
    }

    const served = await streamProfilePhoto({
      req,
      res,
      s3,
      bucket: process.env.S3_BUCKET,
      key,
    });
    if (!served && !res.headersSent) {
      res.set("Cache-Control", "no-store");
      return res.status(404).json({ error: "Profile photo unavailable." });
    }
    return undefined;
  })
);

router.get(
  "/:profileId",
  rateLimit({
    windowMs: 60 * 1000,
    max: 90,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many profile requests. Please slow down." },
  }),
  verifyToken.optional,
  asyncHandler(async (req, res) => {
    const profileId = String(req.params.profileId || "");
    if (!mongoose.isValidObjectId(profileId)) {
      return res.status(404).json({ error: "Paralegal not found" });
    }
    const filter = {
      _id: profileId,
      role: "paralegal",
      status: "approved",
      disabled: { $ne: true },
      deleted: { $ne: true },
      "preferences.hideProfile": { $ne: true },
    };
    applyPublicParalegalFilter(filter);
    if (String(req.user?.role || "").toLowerCase() === "attorney") {
      const blockedIds = await getBlockedUserIds(req.user.id);
      if (blockedIds.some((id) => String(id) === profileId)) {
        return res.status(403).json({ error: "This profile is unavailable." });
      }
    }
    const profile = await User.findOne(filter).select(PUBLIC_PAR_FIELDS).lean();
    const serialized = serializeParalegal(profile);
    if (!serialized) return res.status(404).json({ error: "Paralegal not found" });
    return res.json(serialized);
  })
);

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

    const filter = {
      role: "paralegal",
      status: "approved",
      disabled: { $ne: true },
      deleted: { $ne: true },
    };
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
      items: docs.map(serializeParalegal).filter(Boolean),
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    });
  })
);

module.exports = router;
