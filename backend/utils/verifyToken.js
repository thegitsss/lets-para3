// backend/utils/verifyToken.js
const jwt = require("jsonwebtoken");

// -------------------------------
// Helpers
// -------------------------------
function parseCookie(name, req) {
  const hdr = req.headers?.cookie;
  if (!hdr) return null;
  const wanted = `${name}=`;
  for (const part of hdr.split(";")) {
    const kv = part.trim();
    if (kv.startsWith(wanted)) {
      const v = kv.slice(wanted.length);
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

function normalizePem(val) {
  if (!val) return null;
  let s = String(val).trim();
  // support base64-encoded or \n-escaped keys from env files
  if (!/^-----BEGIN /.test(s)) {
    try {
      s = Buffer.from(s, "base64").toString("utf8");
    } catch {
      /* noop */
    }
  }
  return s.replace(/\\n/g, "\n");
}

function listFromEnv(val) {
  if (!val) return [];
  return String(val)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const COOKIE_NAME = process.env.JWT_COOKIE_NAME || "access";
const ISSUER = process.env.JWT_ISSUER || undefined;
const AUDIENCE = process.env.JWT_AUDIENCE || undefined;
const CLOCK_TOLERANCE = Number(process.env.JWT_CLOCK_TOLERANCE || 5);

// Key rotation support:
// - HS256: JWT_SECRET or JWT_SECRETS="old1,old2,..."
// - RS256: JWT_PUBLIC_KEY or JWT_PUBLIC_KEYS="k1,k2,..."
const HS_SECRETS = [
  ...(process.env.JWT_SECRET ? [process.env.JWT_SECRET] : []),
  ...listFromEnv(process.env.JWT_SECRETS),
];

const RS_PUBLIC_KEYS = [
  ...(process.env.JWT_PUBLIC_KEY ? [process.env.JWT_PUBLIC_KEY] : []),
  ...listFromEnv(process.env.JWT_PUBLIC_KEYS),
].map(normalizePem);

// Allowed algorithms (sane defaults, override with JWT_ALGS if you must)
const ALGS = listFromEnv(process.env.JWT_ALGS);
const ALGORITHMS = ALGS.length ? ALGS : ["RS256", "HS256"];

// -------------------------------
// Token extraction
// -------------------------------
function getToken(req) {
  const hdr = req.headers?.authorization || "";
  if (hdr.startsWith("Bearer ")) return hdr.slice(7).trim();
  if (hdr.startsWith("Token ")) return hdr.slice(6).trim();
  if (hdr.includes(" ")) {
    // e.g. "Bearer <token>" or "JWT <token>"
    const parts = hdr.split(" ");
    if (parts.length === 2) return parts[1].trim();
  }
  // Support HttpOnly cookie (default: "access")
  return parseCookie(COOKIE_NAME, req);
}

// -------------------------------
// Verification
// -------------------------------
function verifyWith(token, key, algs) {
  try {
    return jwt.verify(token, key, {
      algorithms: algs,
      ...(ISSUER ? { issuer: ISSUER } : {}),
      ...(AUDIENCE ? { audience: AUDIENCE } : {}),
      clockTolerance: CLOCK_TOLERANCE,
    });
  } catch {
    return null;
  }
}

/**
 * Try RS keys first (if provided), then HS secrets.
 * Supports key rotation: first match wins.
 */
function verifyTokenString(token) {
  // Prefer RS256-style (public keys)
  for (const pk of RS_PUBLIC_KEYS) {
    const payload = verifyWith(token, pk, ["RS256"]);
    if (payload) return payload;
  }
  // Fall back to HS256-style (shared secrets)
  for (const sec of HS_SECRETS) {
    const payload = verifyWith(token, sec, ["HS256"]);
    if (payload) return payload;
  }
  // As a last resort, if env explicitly allows other algs (e.g., ES256)
  if (ALGORITHMS.some((a) => a !== "RS256" && a !== "HS256")) {
    for (const pk of RS_PUBLIC_KEYS) {
      const payload = verifyWith(token, pk, ALGORITHMS);
      if (payload) return payload;
    }
    for (const sec of HS_SECRETS) {
      const payload = verifyWith(token, sec, ALGORITHMS);
      if (payload) return payload;
    }
  }
  return null;
}

function shapeUser(payload) {
  // Normalize common claim names
  const id =
    String(payload.sub ?? payload.id ?? payload.userId ?? payload.uid ?? "") || "";
  const role = payload.role || payload["https://paraconnect.app/role"] || undefined;
  const email = payload.email || payload["https://paraconnect.app/email"] || undefined;

  // Optional extras (non-breaking)
  const scopes =
    Array.isArray(payload.scopes)
      ? payload.scopes
      : typeof payload.scope === "string"
      ? payload.scope.split(/\s+/).filter(Boolean)
      : undefined;

  const orgId = payload.orgId || payload["https://paraconnect.app/orgId"] || undefined;

  return { id, role, email, scopes, orgId };
}

// -------------------------------
// Middleware factory
// -------------------------------
function makeVerifier(required = true) {
  return (req, res, next) => {
    const token = getToken(req);

    if (!token) {
      if (!required) return next();
      return res.status(401).json({ msg: "No token" });
    }

    const payload = verifyTokenString(token);
    if (!payload) {
      return res.status(403).json({ msg: "Invalid token" });
    }

    const user = shapeUser(payload);
    if (!user.id) {
      // Must have a stable subject identifier
      return res.status(403).json({ msg: "Invalid token" });
    }

    req.user = user;
    req.auth = { token, payload };
    return next();
  };
}

// Default export (required)
function verifyToken(req, res, next) {
  return makeVerifier(true)(req, res, next);
}
verifyToken.optional = makeVerifier(false);

module.exports = verifyToken;
