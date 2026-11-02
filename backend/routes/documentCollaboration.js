"use strict";
const express = require("express"), rateLimit = require("express-rate-limit");
const verifyToken = require("../utils/verifyToken");
const { requireApproved, requireRole } = require("../utils/authz");
const { csrfProtection } = require("../utils/csrf");
const editor = require("../services/connectedWorkspace/editor");
const router = express.Router();
router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); res.set("Referrer-Policy", "no-referrer"); next(); });
const handle = fn => async (req, res, next) => {
  try { await fn(req, res); }
  catch (error) {
    if (error.publicCode || error.statusCode) return res.status(error.status || error.statusCode || 503).json({ code: error.publicCode || error.code, error: error.message });
    next(error);
  }
};
// Provider routes deliberately precede cookie authentication. Each has its own
// document-scoped signature and repeats current account and Matter checks.
router.get("/source/:sessionId", handle(async (req, res) => {
  const result = await editor.source(req.params.sessionId, req.query.token);
  res.set("Content-Type", result.mimeType); res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Disposition", "attachment; filename=Document.docx"); res.send(result.buffer);
}));
router.post("/callback/:sessionId", async (req, res) => {
  try { res.json(await editor.callback(req)); }
  catch (error) { res.status(error.status || error.statusCode || 503).json({ error: 1, code: error.publicCode || "DOCUMENT_EDITOR_SAVE_UNCONFIRMED" }); }
});
router.use(verifyToken, requireApproved, requireRole("attorney", "paralegal"));
router.get("/status", (_req, res) => res.json(editor.publicStatus()));
router.get("/sessions/:sessionId", handle(async (req, res) => res.json(await editor.status(req))));
router.post("/matters/:caseId/files/:fileId/session", csrfProtection, rateLimit({ windowMs: 60000, limit: 12, keyGenerator: req => String(req.user.id), standardHeaders: true, legacyHeaders: false }), handle(async (req, res) => res.json(await editor.open(req))));
module.exports = router;
