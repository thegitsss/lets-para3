// backend/middleware/requireRole.js
const normalize = (value) => String(value || "").trim().toLowerCase();

function flattenRoles(input) {
  if (!Array.isArray(input)) return [input];
  return input.flatMap((item) => (Array.isArray(item) ? flattenRoles(item) : item));
}

module.exports = function requireRole(...roles) {
  const allowed = flattenRoles(roles).map(normalize).filter(Boolean);
  const roleSet = new Set(allowed);

  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });

    const currentRole = normalize(req.user.role);
    if (!roleSet.size) return next();
    if (!currentRole || !roleSet.has(currentRole)) {
      console.warn(
        `[requireRole] Forbidden`,
        JSON.stringify({
          userId: req.user?.id || req.user?._id || null,
          role: req.user?.role || null,
          expected: [...roleSet],
          path: req.originalUrl,
        })
      );
      return res.status(403).json({ error: "Forbidden" });
    }

    return next();
  };
};
