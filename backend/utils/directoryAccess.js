// Public visitors may discover members; signed-in paralegals use their workspace.
// Apply after optional authentication, only to directory listing endpoints.
module.exports = function directoryAccess(req, res, next) {
  res.set("Cache-Control", "private, no-store");
  if (String(req.user?.role || "").toLowerCase() === "paralegal") {
    return res.status(403).json({
      code: "PARALEGAL_DIRECTORY_UNAVAILABLE",
      error: "Paralegal browsing is available to public visitors and attorneys.",
    });
  }
  return next();
};
