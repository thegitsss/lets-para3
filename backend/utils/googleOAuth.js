const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const CONTEXT_COOKIE = "lpc_google_oauth";
const SIGNUP_COOKIE = "lpc_google_signup";
const LINK_COOKIE = "lpc_google_link";

function configuration() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const appBase = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || (appBase ? `${appBase}/api/auth/google/callback` : "")).trim();
  if (!clientId || !clientSecret || !redirectUri || !process.env.JWT_SECRET) return null;
  if (process.env.NODE_ENV === "production" && !redirectUri.startsWith("https://")) return null;
  return { clientId, clientSecret, redirectUri };
}

function cookieOptions(req, maxAge, path = "/api/auth") {
  const production = process.env.NODE_ENV === "production" || process.env.PROD === "true";
  const domain = String(process.env.COOKIE_DOMAIN || "").replace(/^\./, "");
  return {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path,
    ...(domain && req.hostname.endsWith(domain) ? { domain: process.env.COOKIE_DOMAIN } : {}),
    ...(maxAge ? { maxAge } : {}),
  };
}

function signContext(payload, minutes) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: `${minutes}m` });
}

function verifyContext(token, purpose) {
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload?.purpose === purpose ? payload : null;
  } catch {
    return null;
  }
}

function equal(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function verifiedProfile(config, code) {
  const client = new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    transporterOptions: { timeout: 10000 },
  });
  const { tokens } = await client.getToken({ code, redirect_uri: config.redirectUri });
  if (!tokens?.id_token) throw new Error("Google identity missing");
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
  return ticket.getPayload();
}

module.exports = {
  CONTEXT_COOKIE, SIGNUP_COOKIE, LINK_COOKIE,
  configuration, cookieOptions, signContext, verifyContext, equal, verifiedProfile,
};
