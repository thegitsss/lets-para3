// backend/routes/public.js
const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const User = require("../models/User");
const sendEmail = require("../utils/email");
const { logAction } = require("../utils/audit");
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
// Rate limits
// - /contact: per-IP 10 min window, 20 requests
// - (add other public routes similarly if needed)
// ----------------------------------------
router.use(
  "/contact",
  rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many requests. Please try again later." },
  })
);

router.use(
  "/weather",
  rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many weather requests. Please slow down." },
  })
);

// ----------------------------------------
// GET /public/unsubscribe?token=...
// ----------------------------------------
router.get(
  "/unsubscribe",
  asyncHandler(async (req, res) => {
    const redirect = (status, reason) => {
      const params = new URLSearchParams({ status });
      if (reason) params.set("reason", reason);
      return res.redirect(303, `/unsubscribe.html?${params.toString()}`);
    };
    const token = String(req.query?.token || "").trim();
    if (!token) {
      return redirect("error", "missing");
    }
    let payload = null;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET || "");
    } catch {
      return redirect("error", "invalid");
    }
    if (!payload || payload.purpose !== "unsubscribe" || !payload.uid || !isObjId(payload.uid)) {
      return redirect("error", "invalid");
    }

    const user = await User.findById(payload.uid);
    if (!user) return redirect("error", "not_found");

    if (!user.notificationPrefs) user.notificationPrefs = {};
    user.notificationPrefs.email = false;
    if (!user.emailPref) user.emailPref = {};
    user.emailPref.product = false;
    user.emailPref.marketing = false;
    await user.save();

    return redirect("success");
  })
);

// ----------------------------------------
// Helpers
// ----------------------------------------
function isEmail(v = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).toLowerCase());
}
function escapeHTML(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function sanitizeSubject(s = "") {
  // prevent header injection (\r or \n). Keep short.
  return String(s).replace(/[\r\n]/g, " ").trim().slice(0, 140);
}

const isObjId = (id) => mongoose.Types.ObjectId.isValid(id);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const escapeRegex = (str = "") => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PUBLIC_PAR_FIELDS =
  "_id firstName lastName avatarURL profileImage location state specialties practiceAreas yearsExperience linkedInURL education bio about availability approvedAt";

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
    specialties: Array.isArray(src.specialties) ? src.specialties : [],
    practiceAreas: Array.isArray(src.practiceAreas) ? src.practiceAreas : [],
    yearsExperience: typeof src.yearsExperience === "number" ? src.yearsExperience : null,
    linkedInURL: src.linkedInURL || "",
    education: Array.isArray(src.education) ? src.education : [],
    bio: src.bio || "",
    about: src.about || "",
    availability: src.availability || "",
    approvedAt: src.approvedAt || null,
  };
}
// ----------------------------------------
// POST /api/public/contact
// Body:
//   { name, email, role?, subject, message, hp? }
//   - hp is a honeypot field (should be empty)
// ----------------------------------------
router.post(
  "/contact",
  csrfProtection,
  async (req, res) => {
    try {
      const {
        name = "",
        email = "",
        role = "",
        subject = "",
        message = "",
        hp = "", // honeypot (bots often fill every field)
      } = req.body || {};

      // Honeypot & basic requireds
      if (hp) return res.status(400).json({ msg: "Bad request" });
      if (!name || !email || !subject || !message) {
        return res.status(400).json({ msg: "Missing required fields" });
      }
      if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

      const msgStr = String(message);
      if (msgStr.length > 2000) {
        return res.status(400).json({ msg: "Message too long (max 2000 chars)" });
      }

      // reCAPTCHA disabled in localhost/dev mode

      const safeSubject = `[Contact] ${sanitizeSubject(subject)}`;
      const html = `
        <div style="font-family:Georgia,serif;font-size:16px;color:#5c4e3a">
          <h2 style="color:#27394d;margin:0 0 6px">New Contact Submission</h2>
          <p><strong>Name:</strong> ${escapeHTML(name)}</p>
          <p><strong>Email:</strong> ${escapeHTML(email)}</p>
          ${role ? `<p><strong>Role:</strong> ${escapeHTML(role)}</p>` : ""}
          <p><strong>Subject:</strong> ${escapeHTML(subject)}</p>
          <p style="white-space:pre-wrap;border-top:1px solid #eee;margin-top:8px;padding-top:8px">${escapeHTML(
            message
          )}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:12px 0" />
          <p style="color:#888;font-size:12px">
            IP: ${escapeHTML(req.ip || "")}<br/>
            UA: ${escapeHTML(req.headers["user-agent"] || "")}
          </p>
        </div>
      `;
      const text =
        `New Contact Submission\n\n` +
        `Name: ${name}\n` +
        `Email: ${email}\n` +
        (role ? `Role: ${role}\n` : ``) +
        `Subject: ${subject}\n\n` +
        `${message}\n\n` +
        `----\nIP: ${req.ip || ""}\nUA: ${req.headers["user-agent"] || ""}\n`;

      const to = process.env.CONTACT_INBOX || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
      if (!to) {
        // Don't fail user submissions if email isn't configured—just acknowledge.
        console.warn("[contact] No CONTACT_INBOX/SMTP configured; skipping email send.");
      } else {
        // sendEmail(to, subject, html, { text, replyTo })
        try {
          await sendEmail(to, safeSubject, html, { text, replyTo: email });
        } catch (e) {
          // non-fatal for UX; we still proceed
          console.error("[contact] sendEmail failed:", e?.message || e);
        }
      }

      // Best-effort audit log with metadata
      try {
        await logAction(req, "public.contact.submit", {
          targetType: "other",
          meta: {
            role: role || null,
            email,
            ua: req.headers["user-agent"] || null,
            ip: req.ip || null,
          },
        });
      } catch (e) {
        // swallow
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error("contact error", e);
      return res.status(500).json({ msg: "Server error" });
    }
  }
);

router.get(
  "/weather",
  asyncHandler(async (req, res) => {
    const apiKey = process.env.WEATHER_API_KEY || process.env.OPENWEATHER_API_KEY || "";
    const fallbackWeather = () =>
      res.json({
        temperature: 72,
        condition: "Fair",
        source: "fallback",
      });
    if (!apiKey) {
      return fallbackWeather();
    }

    const fallbackLat = parseFloat(process.env.WEATHER_LAT || "");
    const fallbackLon = parseFloat(process.env.WEATHER_LON || "");
    const fallbackLocation = process.env.WEATHER_LOCATION || "Tysons,VA";
    const lat = Number.isFinite(parseFloat(req.query.lat)) ? parseFloat(req.query.lat) : (Number.isFinite(fallbackLat) ? fallbackLat : null);
    const lon = Number.isFinite(parseFloat(req.query.lon)) ? parseFloat(req.query.lon) : (Number.isFinite(fallbackLon) ? fallbackLon : null);
    const queryLocation = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : fallbackLocation;

    const params = new URLSearchParams({ appid: apiKey, units: "imperial" });
    if (lat !== null && lon !== null) {
      params.set("lat", String(lat));
      params.set("lon", String(lon));
    } else {
      params.set("q", queryLocation);
    }

    try {
      const { data } = await axios.get("https://api.openweathermap.org/data/2.5/weather", {
        params,
        timeout: 5000,
      });
      const temperature = typeof data?.main?.temp === "number" ? Math.round(data.main.temp) : null;
      const condition = data?.weather?.[0]?.description || data?.weather?.[0]?.main || "Unknown";
      if (temperature === null) {
        return res.status(502).json({ error: "Incomplete weather response" });
      }
      res.json({ temperature, condition });
    } catch (err) {
      console.error("[public.weather] fetch failed", err?.message || err);
      return fallbackWeather();
    }
  })
);

// ----------------------------------------
// Public paralegal directory
// ----------------------------------------
router.get(
  "/paralegals",
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
      filter.location = new RegExp(escapeRegex(location), "i");
    }
    if (practiceRaw) {
      const tokens = practiceRaw
        .split(/[|,]/)
        .map((token) => token.trim())
        .filter(Boolean)
        .map((token) => new RegExp(escapeRegex(token), "i"));
      if (tokens.length) {
        filter.practiceAreas = { $in: tokens };
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

router.get(
  "/paralegals/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid paralegal id" });
    const doc = await User.findById(id).select(PUBLIC_PAR_FIELDS).lean();
    if (!doc || doc.role !== "paralegal" || doc.status !== "approved") {
      return res.status(404).json({ error: "Paralegal not found" });
    }
    res.json(serializeParalegal(doc));
  })
);

module.exports = router;
