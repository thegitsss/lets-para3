const router = require("express").Router();

// This feature is intentionally dormant in production. Keep the mount in place
// so existing clients receive a safe response instead of a working verification
// shortcut.
router.use((_req, res) => {
  return res.status(404).json({ error: "Not found" });
});

module.exports = router;
