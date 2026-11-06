const router = require('express').Router();
const verifyToken = require('../utils/verifyToken');
const { requireApproved, requireRole } = require('../utils/authz');
const { csrfProtection } = require('../utils/csrf');
const { rateLimit } = require('express-rate-limit');
const clio = require('../services/connectedWorkspace/clio');
// Return the provider's loopback callback to the existing app hostname before
// cookie authentication. The normal owner/session/state checks still follow.
router.get('/callback', (req, res, next) => {
  const destination = clio.localCallbackRedirect(req);
  if (!destination) return next();
  res.set('Cache-Control', 'private, no-store');
  res.set('Referrer-Policy', 'no-referrer');
  return res.redirect(303, destination);
});
router.use(verifyToken, requireApproved, requireRole('attorney'));
router.use((req, res, next) => { const expected = req.get('X-LPC-Owner-Id'); if (expected && expected !== String(req.user.id)) return res.status(403).json({ code: 'CLIO_ACCOUNT_CHANGED', error: 'The signed-in account changed. Reload before continuing.' }); next(); });
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.use((req, res, next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.body?.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ code: 'CLIO_ACCOUNT_CHANGED', error: 'The signed-in account changed. Reload before continuing.' });
  return next();
});
const limited = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: req => String(req.user.id), message: { error: 'Please wait before making more Clio requests.' } });
router.use(limited);
const handle = operation => async (req, res, next) => {
  try { res.json(await operation(req)); }
  catch (error) { if (error.publicCode) return res.status(error.status || 503).json({ code: error.publicCode, error: error.message }); next(error); }
};
router.get('/status', handle(clio.status));
router.post('/connect', csrfProtection, handle(clio.connect));
router.get('/callback', async (req, res, next) => { try { const result = await clio.callback(req); res.redirect(303, result.href); } catch (error) { if (error.publicCode) return res.status(error.status || 503).json({ code: error.publicCode, error: error.message }); next(error); } });
router.delete('/connection', csrfProtection, handle(clio.disconnect));
router.get('/matters', handle(clio.listMatters));
router.get('/matters/:clioMatterId/context', handle(clio.matterContext));
router.get('/matters/:clioMatterId/documents', handle(clio.listDocuments));
router.get('/handoffs', handle(clio.listHandoffs));
router.get('/transfers', handle(clio.listTransfers));
router.post('/handoffs', csrfProtection, handle(clio.createHandoff));
router.post('/matters/:caseId/handoffs', csrfProtection, handle(clio.createMatterHandoff));
router.post('/matters/:caseId/import', csrfProtection, handle(clio.importDocuments));
router.post('/matters/:caseId/export', csrfProtection, handle(clio.exportDocument));
router.post('/custom-action', csrfProtection, handle(clio.registerAction));
router.post('/action-context', csrfProtection, handle(clio.actionContext));
module.exports = router;
