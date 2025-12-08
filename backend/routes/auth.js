// backend/routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const axios = require("axios");
const { URLSearchParams } = require("url");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const User = require("../models/User");
const AuditLog = require("../models/AuditLog"); // audit trail hooks
const sendEmail = require("../utils/email");

const IS_PROD = process.env.PROD === "true";
const COOKIE_BASE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
};
const AUTH_COOKIE_OPTIONS = {
  ...COOKIE_BASE_OPTIONS,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
const MAX_RESUME_FILE_BYTES = 10 * 1024 * 1024;
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_FILE_BYTES },
});

// S3 client for resume uploads during registration
const s3 = new S3Client({
  region: process.env.S3_REGION,
  credentials:
    process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY,
          secretAccessKey: process.env.S3_SECRET_KEY,
        }
      : undefined,
});
const BUCKET = process.env.S3_BUCKET || "";

function sseParams() {
  if (process.env.S3_SSE_KMS_KEY_ID) {
    return {
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: process.env.S3_SSE_KMS_KEY_ID,
    };
  }
  return { ServerSideEncryption: "AES256" };
}

function safeSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-");
}

// ----------------------------------------
// Helpers
// ----------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const TWO_HOURS = "2h";
const FIFTEEN_MIN = 15 * 60 * 1000;
const DISABLED_ACCOUNT_MSG = "This account has been disabled.";

function signAccess(user) {
  const payload = { id: user._id.toString(), role: user.role, email: user.email };
  const opts = { expiresIn: TWO_HOURS };
  if (process.env.JWT_ISSUER) opts.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) opts.audience = process.env.JWT_AUDIENCE;
  return jwt.sign(payload, process.env.JWT_SECRET, opts);
}

function signOneTime(payload, { minutes = 30, secretEnv = "JWT_SECRET" } = {}) {
  const expSeconds = Math.floor(Date.now() / 1000) + minutes * 60;
  return jwt.sign({ ...payload, exp: expSeconds }, process.env[secretEnv]);
}

function isEmail(v = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).toLowerCase());
}

function isObjId(id) {
  return mongoose.isValidObjectId(id);
}

async function verifyRecaptcha(token, expectedAction) {
  const secret = process.env.RECAPTCHA_SECRET || "";
  if (!secret) return true;
  const enforceRecaptcha = String(process.env.RECAPTCHA_ENFORCED || "false").toLowerCase() === "true";
  if (!token) {
    console.warn("[recaptcha] missing token");
    return !enforceRecaptcha;
  }
  try {
    const params = new URLSearchParams();
    params.append("secret", secret);
    params.append("response", token);
    const { data } = await axios.post("https://www.google.com/recaptcha/api/siteverify", params);
    if (!data?.success) {
      console.warn("[recaptcha] verification failed", data?.["error-codes"]);
      return !enforceRecaptcha;
    }
    if (expectedAction && data.action && data.action !== expectedAction) {
      console.warn("[recaptcha] action mismatch", data.action, "expected", expectedAction);
      return !enforceRecaptcha;
    }
    if (typeof data.score === "number" && data.score < 0.3) {
      console.warn("[recaptcha] low score", data.score);
      return !enforceRecaptcha;
    }
    return true;
  } catch (err) {
    console.error("[recaptcha] verify error", err?.message || err);
    return !enforceRecaptcha;
  }
}

// ----------------------------------------
// REGISTER
// POST /api/auth/register
// ----------------------------------------
router.post(
  "/register",
  resumeUpload.single("resume"),
  asyncHandler(async (req, res) => {
    const {
      firstName,
      lastName,
      email,
      password,
      role,
      barNumber,
      resumeURL,
      certificateURL,
      recaptchaToken,
      termsAccepted,
      phoneNumber,
    } = req.body || {};

    const captchaOk = await verifyRecaptcha(recaptchaToken, "signup");
    if (!captchaOk) {
      return res.status(400).json({ msg: "reCAPTCHA failed. Please try again." });
    }

    const safeFirst = String(firstName || "").trim();
    const safeLast = String(lastName || "").trim();
    if (!safeFirst || !safeLast) {
      return res.status(400).json({ msg: "First and last name are required." });
    }

    if (!termsAccepted) {
      return res.status(400).json({ msg: "Terms of Use must be accepted." });
    }

    const roleLc = String(role || "").toLowerCase();
    if (!["attorney", "paralegal"].includes(roleLc)) {
      return res.status(400).json({ msg: "Invalid role" });
    }
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });
    if (!password || String(password).length < 8) {
      return res
        .status(400)
        .json({ msg: "Password must be at least 8 characters." });
    }

    // Paralegals must attach a PDF resume at signup
    if (roleLc === "paralegal" && !req.file) {
      return res.status(400).json({ msg: "Résumé file is required for paralegal registration." });
    }

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) return res.status(400).json({ msg: "User already exists" });

    if (roleLc === "paralegal" && req.file) {
      if (req.file.mimetype !== "application/pdf") {
        return res.status(400).json({ msg: "Résumé must be a PDF" });
      }
      if (req.file.size > MAX_RESUME_FILE_BYTES) {
        return res.status(400).json({ msg: "Résumé exceeds maximum allowed size (10 MB)." });
      }
      if (!BUCKET) {
        return res.status(500).json({ msg: "Resume upload unavailable. Please try again later." });
      }
    }

    // Let the model hash the password (pre-save hook)
    const user = new User({
      firstName: safeFirst,
      lastName: safeLast,
      email: String(email || "").toLowerCase(),
      password: String(password),
      role: roleLc,
      status: "pending",
      barNumber: roleLc === "attorney" ? String(barNumber || "") : "",
      resumeURL: roleLc === "paralegal" ? "" : "",
      certificateURL: roleLc === "paralegal" ? String(certificateURL || "") : "",
      termsAccepted: true,
      phoneNumber: phoneNumber ? String(phoneNumber).trim() || null : null,
    });

    // Upload resume (paralegal) before saving
    if (roleLc === "paralegal" && req.file) {
      const key = `paralegal-resumes/${safeSegment(user._id)}/resume.pdf`;
      const putParams = {
        Bucket: BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: "application/pdf",
        ContentLength: req.file.size,
        ACL: "private",
        ...sseParams(),
      };
      await s3.send(new PutObjectCommand(putParams));
      user.resumeURL = key;
    }

    await user.save();

    // Email: registration received + email verification link (optional but nice)
    try {
      const verifyToken = signOneTime(
        { purpose: "verify-email", uid: user._id.toString() },
        { minutes: 60, secretEnv: "JWT_SECRET" }
      );
      const verifyUrl = `${process.env.APP_BASE_URL || ""}/verify-email?token=${verifyToken}`;
      await sendEmail(
        user.email,
        "Registration received",
        `Thank you for submitting your application to be part of Let’s-ParaConnect and join our highly curated, elite paralegal professional collective. Your application is now under review. Our team is thoroughly evaluating your credentials, experience, and references. You will receive an update within 24-48 business hours.\n\nRespectfully,\nThe Let’s-ParaConnect Verification Division${
          process.env.APP_BASE_URL ? `\n\nYou can verify your email here (optional): ${verifyUrl}` : ""
        }`
      );
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.register", {
      targetType: "user",
      targetId: user._id,
      meta: { role: user.role },
    });

    res.json({ msg: "Registered successfully. Await admin approval." });
  })
);

// ----------------------------------------
// LOGIN
// POST /api/auth/login  -> returns { token, user }
// ----------------------------------------
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    const recaptchaSecret = process.env.RECAPTCHA_SECRET_KEY || process.env.RECAPTCHA_SECRET || "";

    if (IS_PROD && recaptchaSecret) {
      let recaptchaToken = req.body?.recaptcha;
      if (!recaptchaToken && req.body?.recaptchaToken) {
        recaptchaToken = req.body.recaptchaToken;
      }
      if (!recaptchaToken) {
        return res.status(400).json({ error: "Recaptcha verification failed" });
      }

      try {
        const params = new URLSearchParams();
        params.append("secret", recaptchaSecret);
        params.append("response", recaptchaToken);
        const verifyRes = await axios.post("https://www.google.com/recaptcha/api/siteverify", params);
        const verifyData = verifyRes?.data;
        if (!verifyData?.success) {
          return res.status(400).json({ error: "Recaptcha verification failed" });
        }
      } catch (err) {
        console.error("[recaptcha]", err?.message || err);
        return res.status(400).json({ error: "Recaptcha verification failed" });
      }
    }

    if (!isEmail(email) || !password) {
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    // IMPORTANT: password is select:false in schema, so we MUST include it
    const user = await User.findOne({ email: String(email).toLowerCase() }).select("+password");
    if (!user) {
      await AuditLog.logFromReq(req, "auth.login.fail", { targetType: "user", meta: { email } });
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    if (user.disabled) {
      return res.status(403).json({ error: DISABLED_ACCOUNT_MSG, msg: DISABLED_ACCOUNT_MSG });
    }

    const status = user.status || "pending";
    if (status !== "approved") {
      const msg =
        status === "pending"
          ? "Your application is still pending admin approval."
          : "Your application was not approved. Please contact support if you have questions.";
      return res.status(403).json({ msg });
    }

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) {
      await AuditLog.logFromReq(req, "auth.login.fail", { targetType: "user", targetId: user._id });
      return res.status(400).json({ msg: "Invalid credentials" });
    }

    const token = signAccess(user);
    res.cookie("token", token, AUTH_COOKIE_OPTIONS);
    await AuditLog.logFromReq(req, "auth.login.success", { targetType: "user", targetId: user._id });

    return res.json({
      success: true,
      user: {
        _id: user._id,
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        status: user.status,
        disabled: Boolean(user.disabled),
      },
    });
  })
);

// ----------------------------------------
// ME
// GET /api/auth/me  (reads Bearer token)
// ----------------------------------------
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const hdr = req.headers.authorization || "";
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    const cookieToken =
      req.cookies?.token ||
      req.cookies?.[process.env.JWT_COOKIE_NAME || "access"];
    const token = cookieToken || bearer;
    if (!token) return res.json({ user: null });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      // freshen user info (role/status might have changed)
      const u = await User.findById(payload.id).lean();
      if (!u) return res.json({ user: null });
      if (u.disabled) {
        return res.status(403).json({ error: DISABLED_ACCOUNT_MSG });
      }
      res.json({
        user: {
          id: u._id,
          role: u.role,
          email: u.email,
          firstName: u.firstName,
          lastName: u.lastName,
          avatarURL: u.avatarURL || null,
          profileImage: u.profileImage || null,
          status: u.status,
          disabled: Boolean(u.disabled),
        },
      });
    } catch {
      res.json({ user: null });
    }
  })
);

// ----------------------------------------
// LOGOUT (stateless JWT – client deletes token)
// POST /api/auth/logout
// ----------------------------------------
router.post("/logout", (_req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
  });
  res.json({ success: true });
});

// ----------------------------------------
// EMAIL VERIFICATION (optional but handy)
// POST /api/auth/resend-verification
// POST /api/auth/verify-email  { token }
// ----------------------------------------
router.post(
  "/resend-verification",
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.json({ ok: true }); // don't reveal existence
    if (user.emailVerified) return res.json({ ok: true });

    try {
      const verifyToken = signOneTime(
        { purpose: "verify-email", uid: user._id.toString() },
        { minutes: 60, secretEnv: "JWT_SECRET" }
      );
      const verifyUrl = `${process.env.APP_BASE_URL || ""}/verify-email?token=${verifyToken}`;
      await sendEmail(user.email, "Verify your email", `Click to verify: ${verifyUrl}`);
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.verify.resend", {
      targetType: "user",
      targetId: user._id,
    });

    res.json({ ok: true });
  })
);

router.post(
  "/verify-email",
  asyncHandler(async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ msg: "Missing token" });
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.purpose !== "verify-email" || !isObjId(payload.uid)) {
        return res.status(400).json({ msg: "Invalid token" });
      }
      const user = await User.findById(payload.uid);
      if (!user) return res.status(404).json({ msg: "User not found" });
      user.markEmailVerified?.();
      await user.save();

      await AuditLog.logFromReq(req, "auth.verify.success", {
        targetType: "user",
        targetId: user._id,
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ msg: "Invalid or expired token" });
    }
  })
);

// ----------------------------------------
// PASSWORD RESET (stateless token via email)
// POST /api/auth/request-password-reset { email }
// POST /api/auth/reset-password { token, newPassword }
// ----------------------------------------
router.post(
  "/request-password-reset",
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ msg: "Invalid email" });

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.json({ ok: true }); // do not reveal

    const resetToken = signOneTime(
      { purpose: "reset-password", uid: user._id.toString() },
      { minutes: 30, secretEnv: "JWT_SECRET" }
    );
    const resetUrl = `${process.env.APP_BASE_URL || ""}/reset-password?token=${resetToken}`;
    try {
      await sendEmail(user.email, "Reset your password", `Use this link to reset your password: ${resetUrl}\nThis link expires in 30 minutes.`);
    } catch (_) {}

    await AuditLog.logFromReq(req, "auth.password.reset.request", {
      targetType: "user",
      targetId: user._id,
    });

    res.json({ ok: true });
  })
);

router.post(
  "/reset-password",
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ msg: "Missing token or newPassword" });
    if (String(newPassword).length < 8) return res.status(400).json({ msg: "Password must be at least 8 characters." });

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.purpose !== "reset-password" || !isObjId(payload.uid)) {
        return res.status(400).json({ msg: "Invalid token" });
      }
      const user = await User.findById(payload.uid).select("+password");
      if (!user) return res.status(404).json({ msg: "User not found" });

      // Assign; hashing handled by model pre-save
      user.password = String(newPassword);
      await user.save();

      await AuditLog.logFromReq(req, "auth.password.reset.success", {
        targetType: "user",
        targetId: user._id,
      });

      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ msg: "Invalid or expired token" });
    }
  })
);

// ----------------------------------------
// Route-level error fallback
// ----------------------------------------
router.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ msg: "Server error", error: err?.message || "Unknown error" });
});

module.exports = router;
