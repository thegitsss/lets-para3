const { reportOperationalFailure } = require("../utils/operationalFailure");
const router = require('express').Router();
const service = require('../services/linkedInPhotoImport');
const guard = require('../utils/accountWriteGuard');
const { csrfProtection, requestSessionIdentifier } = require('../utils/csrf');
const { requireRole } = require('../utils/authz');
router.use(requireRole('paralegal', 'attorney'));
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const handle = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { if (guard.respond(error, res)) return; if (error.statusCode) return res.status(error.statusCode).json({ error: error.message }); next(error); } };
function owned(req, input) {
  if (!guard.checkOwner(req, input)) throw Object.assign(new Error('Verify your signed-in account before continuing.'), { statusCode: 400 });
  return [String(req.user.id), requestSessionIdentifier(req)];
}
router.get('/config', (_req, res) => res.json({ enabled: Boolean(service.configuration()) }));
router.post('/start', csrfProtection, handle(async (req, res) => res.json(await service.begin(...owned(req, req.body)))));
router.get('/result', handle(async (req, res) => {
  const [ownerId, sessionHash] = owned(req, req.query);
  res.json(await service.result(ownerId, sessionHash, req.query.requestId));
}));
router.get('/callback', async (req, res) => {
  let ok = false;
  try { ok = await service.complete({ ownerId: String(req.user.id), sessionHash: requestSessionIdentifier(req), state: req.query.state, code: typeof req.query.code === 'string' ? req.query.code : '', denied: Boolean(req.query.error) }); } catch (error) { reportOperationalFailure("linkedin_photo_import.callback")(error); }
  res.redirect(`/linkedin-photo-import.html?status=${ok ? 'ready' : 'failed'}`);
});
module.exports = router;
