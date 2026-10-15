import { readSession } from "../utils/session-read.mjs";

const VALID_FONT_SIZES = new Set(["xs", "sm", "md", "lg", "xl"]);

function text(value, maximum = 160) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeTheme(value) {
  return /dark$/i.test(String(value || "")) ? "dark" : "light";
}

export function projectSessionIdentity(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const id = text(user.id || user._id, 80);
  if (!id) return null;
  const fontSize = text(user.preferences?.fontSize, 8).toLowerCase();
  return {
    id,
    role: text(user.role, 30).toLowerCase(),
    status: text(user.status, 40).toLowerCase(),
    firstName: text(user.firstName, 80),
    lastName: text(user.lastName, 80),
    name: text(user.name, 160),
    avatarURL: text(user.avatarURL || user.profileImage, 500),
    profileImage: text(user.profileImage || user.avatarURL, 500),
    profilePhotoStatus: text(user.profilePhotoStatus, 40),
    disabled: Boolean(user.disabled),
    deleted: Boolean(user.deleted),
    preferences: {
      theme: normalizeTheme(user.preferences?.theme),
      fontSize: VALID_FONT_SIZES.has(fontSize) ? fontSize : "md",
    },
    onboarding: {
      paralegalTourCompleted: user.onboarding?.paralegalTourCompleted === true,
      paralegalProfileTourCompleted: user.onboarding?.paralegalProfileTourCompleted === true,
    },
  };
}

export async function verifyParalegalSession(api, { signal, persistIdentity } = {}) {
  const payload = await readSession(api, { signal });
  const identity = projectSessionIdentity(payload?.user);
  if (!identity) return { state: "unauthenticated", identity: null };
  if (identity.disabled || identity.deleted) return { state: "unavailable", identity };
  if (identity.role !== "paralegal") return { state: "wrong_role", identity };
  if (identity.status !== "approved") return { state: "unapproved", identity };
  if (typeof persistIdentity === "function") persistIdentity({ user: identity });
  return { state: "ready", identity };
}

// Profile writes return display fields, not a new session. An omitted role or
// onboarding value must not replace the separately verified account identity.
export function projectProfileIdentity(profile, verifiedIdentity) {
  const identity = projectSessionIdentity(verifiedIdentity);
  if (!identity || text(profile?.id || profile?._id, 80) !== identity.id) return null;
  const next = { ...identity };
  for (const field of ["firstName", "lastName", "name", "avatarURL", "profileImage", "profilePhotoStatus"]) {
    if (Object.hasOwn(profile, field)) next[field] = profile[field];
  }
  for (const field of ["preferences", "onboarding"]) {
    if (profile[field] && typeof profile[field] === "object" && !Array.isArray(profile[field])) next[field] = { ...identity[field], ...profile[field] };
  }
  return projectSessionIdentity(next);
}

export function paralegalV2LoginDestination(hash = "#/home") {
  const normalizedHash = /^#\/(?:home|payouts|conversations|browse|work|settings|help|profile(?:\/[^/?#]+)?|attorney\/[^/?#]+|matter\/[^/?#]+)(?:\?.*)?$/.test(String(hash || ""))
    ? String(hash)
    : "#/home";
  return `login.html?next=${encodeURIComponent(`/paralegal-v2.html${normalizedHash}`)}`;
}

export function destinationForSessionState(result, { returnHash = "" } = {}) {
  const state = result?.state;
  const role = result?.identity?.role;
  if (state === "wrong_role") {
    if (role === "attorney") return "dashboard-attorney.html";
    if (role === "admin") return "admin-dashboard.html";
    if (role === "director") return "director-portal.html";
  }
  if (state === "unapproved" && role === "paralegal") return "paralegal-admission.html";
  if (state === "unauthenticated" && returnHash) return paralegalV2LoginDestination(returnHash);
  return "login.html";
}
