const express = require("express");
const LegalDocumentVersion = require("../models/LegalDocumentVersion");
const { preserveCurrentPolicyDocuments } = require("../services/legalPolicyService");
const { currentPolicyMetadata } = require("../utils/legalDocuments");

const router = express.Router();
const handle = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
router.use((_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });

router.get("/current", handle(async (_req, res) => {
  await preserveCurrentPolicyDocuments();
  res.json({ documents: currentPolicyMetadata() });
}));

router.get("/documents/:kind/:hash", handle(async (req, res) => {
  const { kind, hash } = req.params;
  if (!["terms", "privacy"].includes(kind) || !/^[a-f0-9]{64}$/.test(hash)) return res.sendStatus(404);
  const copy = await LegalDocumentVersion.findById(`${kind}:${hash}`).lean();
  if (!copy) return res.sendStatus(404);
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-popups");
  res.set("X-Content-Type-Options", "nosniff");
  if (req.query.download === "1") {
    res.set("Content-Disposition", `attachment; filename="lpc-${kind}-${copy.version}-${hash.slice(0, 12)}.html"`);
    return res.type("html").send(copy.html);
  }
  res.type("html").send(copy.html.replace(/<head>/i, '<head><base href="/">'));
}));

module.exports = router;
