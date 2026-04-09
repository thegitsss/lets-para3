function isApprovedUser(user) {
  return String(user?.status || "").toLowerCase() === "approved";
}

function ensureApprovedUserAuthReady(user, { touchApprovedAt = true } = {}) {
  if (!user || !isApprovedUser(user)) return false;

  let changed = false;

  if (user.emailVerified !== true) {
    if (typeof user.markEmailVerified === "function") {
      user.markEmailVerified();
    } else {
      user.emailVerified = true;
    }
    changed = true;
  }

  if (touchApprovedAt && !user.approvedAt) {
    user.approvedAt = new Date();
    changed = true;
  }

  return changed;
}

module.exports = {
  isApprovedUser,
  ensureApprovedUserAuthReady,
};
