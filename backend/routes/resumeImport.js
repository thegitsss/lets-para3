'use strict';
const express = require('express');
const multer = require('multer');
const { MAX_BYTES, DISCLOSURE, extractFile, failure } = require('../services/resumeImport');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 5 } }).single('file');
// One active extraction per account, with a bounded queue; no document cache.
const active = new Set();
function createResumeImportRouter({ loadExisting, enabled = () => process.env.NODE_ENV !== 'production' && process.env.LPC_RESUME_IMPORT_ENABLED === 'true', extract = extractFile, rateLimitMax = 10, authorize = [require("../middleware/requireApprovedUser"), require("../middleware/requireRole")("paralegal")] } = {}) {
  const router = express.Router();
  if (authorize.length) router.use(...authorize);
  router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
  router.get('/', (_req, res) => res.json({ enabled: enabled(), disclosure: DISCLOSURE, processor: 'local-rules', maxBytes: MAX_BYTES, formats: ['pdf', 'doc', 'docx'] }));
  router.post('/', require('../utils/csrf').csrfProtection, require('express-rate-limit').rateLimit({ windowMs: 15 * 60 * 1000, limit: rateLimitMax, keyGenerator: req => String(req.user.id), standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Please wait a few minutes before importing another résumé.' } }), (req, res) => {
    if (!enabled()) return res.status(503).json({ error: 'Résumé Autofill is awaiting local review. You can enter your details manually.', code: 'IMPORT_DISABLED' });
    const owner = String(req.user?.id || '');
    if (!owner || active.has(owner) || active.size >= 4) return res.status(429).json({ code: 'IMPORT_BUSY', error: 'Another résumé is being read. Try again shortly.' });
    // Reserve capacity before buffering multipart data, not after the upload.
    active.add(owner);
    const controller = new AbortController();
    let released = false;
    const release = () => {
      if (released) return;
      released = true; clearTimeout(timeout); active.delete(owner);
      res.off('close', abort); req.off('aborted', abort);
    };
    const abort = () => controller.abort();
    res.on('close', abort); req.on('aborted', abort);
    // The unchanged 25-second budget includes receiving, storage and parsing.
    const timeout = setTimeout(() => {
      controller.abort();
      if (!req.complete) {
        // Do not drain an attacker-controlled unfinished body indefinitely.
        // Close the incomplete connection; a JSON response is not promised.
        req.destroy(); if (!res.destroyed) res.destroy();
      } else if (!res.destroyed && !res.headersSent) {
        res.status(504).json({ error: 'Reading took too long. Your profile is unchanged. Try again or enter details manually.' });
      }
    }, 25000);
    const completed = async error => {
      try {
        if (controller.signal.aborted) return;
        if (error) throw failure('INVALID_UPLOAD', 400, 'Choose one PDF or DOC résumé, up to 10 MB.');
        if (!require('../utils/accountWriteGuard').checkOwner(req)) throw failure('ACCOUNT_REQUIRED', 400, 'Verify your account before importing.');
        if (req.body.consent !== 'local-v1') throw failure('CONSENT_REQUIRED', 400, 'Review how LPC processes your résumé before continuing.');
        if (Object.keys(req.body).some(key => !['expectedOwnerId', 'consent', 'source', 'expectedResumeKey'].includes(key))) throw failure('INVALID_REQUEST', 400, 'Choose a résumé source.');
        if (!['existing', 'different'].includes(req.body.source) || (req.body.source === 'existing' && req.file) || (req.body.source === 'different' && !req.file)) throw failure('INVALID_SOURCE', 400, 'Choose a résumé source.');
        const file = req.body.source === 'existing' ? await loadExisting(req, controller.signal) : req.file;
        if (controller.signal.aborted) return;
        const result = await extract(file, { signal: controller.signal });
        if (!controller.signal.aborted) res.json(result);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (require('../utils/accountWriteGuard').respond(err, res)) return;
        // Never log parser/provider errors or echo document contents.
        res.status(err.status || 503).json({ code: err.code || 'IMPORT_UNAVAILABLE', error: err.status ? err.message : 'Your résumé could not be read right now. Your saved profile is unchanged. Try again or enter details manually.' });
      } finally { release(); }
    };
    try { upload(req, res, completed); } catch (error) { void completed(error); }
  });
  return router;
}
async function loadExisting(req, signal) {
  const User = require('../models/User');
  const { extractPersonalFileKey } = require('../utils/personalFileReference');
  const { createS3Client } = require('../utils/s3Client');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const user = await User.findById(req.user.id).select('_id role status disabled deleted resumeURL');
  if (!user || user.role !== 'paralegal' || user.status !== 'approved' || user.disabled || user.deleted) throw failure('FORBIDDEN', 403, 'Verify your approved paralegal account before importing.');
  const key = extractPersonalFileKey(user.resumeURL, { ownerId: String(user._id), type: 'resume', bucket: process.env.S3_BUCKET, region: process.env.S3_REGION, cdnBase: process.env.S3_CDN_BASE_URL });
  if (!key) throw failure('NO_RESUME', 404, 'No saved résumé was found. Use a different résumé or enter details manually.');
  if (req.body.expectedResumeKey !== key) throw failure('RESUME_CHANGED', 409, 'Your résumé changed. Refresh Profile before importing.');
  const s3 = createS3Client();
  const scan = await require('../utils/fileSecurity').getObjectMalwareScan({ s3, bucket: process.env.S3_BUCKET, key });
  if (!scan.safe) throw failure('SCAN_PENDING', 409, 'Your résumé is not cleared for reading yet. Try again after security scanning finishes.');
  const object = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }), { abortSignal: signal });
  if (object.ContentLength > MAX_BYTES) { object.Body?.destroy?.(); throw failure('FILE_SIZE', 400, 'Choose a résumé up to 10 MB.'); }
  const chunks = []; let size = 0;
  try { for await (const chunk of object.Body) { size += chunk.length; if (size > MAX_BYTES) throw failure('FILE_SIZE', 400, 'Choose a résumé up to 10 MB.'); chunks.push(chunk); } }
  finally { object.Body?.destroy?.(); }
  return { buffer: Buffer.concat(chunks), mimetype: 'application/pdf', originalname: 'resume.pdf' };
}
module.exports = { createResumeImportRouter, loadExisting };
