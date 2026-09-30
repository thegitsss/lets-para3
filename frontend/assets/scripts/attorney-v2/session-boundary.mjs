function text(value, limit = 100) { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }

export function projectIdentity(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const id = text(user.id || user._id);
  if (!id) return null;
  return {
    id, role: text(user.role).toLowerCase(), status: text(user.status).toLowerCase(),
    disabled: Boolean(user.disabled), deleted: Boolean(user.deleted),
    isFirstLogin: user.isFirstLogin === true,
    firstName: text(user.firstName), lastName: text(user.lastName), name: text(user.name, 160),
    profileImage: text(user.profileImage, 2000), avatarURL: text(user.avatarURL, 2000),
    preferences: {
      theme: /dark$/i.test(text(user.preferences?.theme)) ? "dark" : "light",
      fontSize: ["xs", "sm", "md", "lg", "xl"].includes(user.preferences?.fontSize) ? user.preferences.fontSize : "md",
    },
  };
}

export function classifySession(payload) {
  const identity = projectIdentity(payload?.user);
  if (!identity) return { state: "unauthenticated", identity: null };
  if (identity.disabled || identity.deleted) return { state: "unavailable", identity };
  if (identity.role !== "attorney") return { state: "wrong_role", identity };
  if (identity.status !== "approved") return { state: "unapproved", identity };
  return { state: "ready", identity };
}

export function sessionDestination(result) {
  if (result?.state === "wrong_role") {
    return ({ paralegal: "/dashboard-paralegal.html", admin: "/admin-dashboard.html", director: "/director-portal.html" })[result.identity?.role] || "/login.html";
  }
  // V1 retains the existing attorney onboarding/approval decision.
  if (result?.state === "unapproved") return "/dashboard-attorney.html";
  return "/login.html";
}
