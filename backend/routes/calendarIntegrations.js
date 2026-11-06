const router = require('express').Router();
const verifyToken = require('../utils/verifyToken');
const { requireApproved, requireRole } = require('../utils/authz');
const { csrfProtection } = require('../utils/csrf');
const { rateLimit } = require('express-rate-limit');
const connections = require('../services/calendar/connections');
const Connection = require('../models/CalendarConnection');
const Link = require('../models/CalendarSyncLink');
const Event = require('../models/Event');
const Case = require('../models/Case');
const sync = require('../services/calendar/sync');
router.use(verifyToken, requireApproved, requireRole('attorney', 'paralegal'));
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store'); res.set('Referrer-Policy', 'no-referrer');
  const expected = req.get('X-LPC-Owner-Id');
  if (expected && expected !== String(req.user.id) || ['POST','PATCH','DELETE'].includes(req.method) && req.body?.expectedOwnerId !== String(req.user.id)) return res.status(403).json({ code: 'CALENDAR_ACCOUNT_CHANGED', error: 'The signed-in account changed. Refresh LPC.' });
  next();
});
router.use(rateLimit({ windowMs: 60000, limit: 45, standardHeaders: true, legacyHeaders: false, keyGenerator: req => String(req.user.id) }));
const handle = work => async (req, res, next) => {
  try { res.json(await work(req)); }
  catch (error) { if (error.publicCode) return res.status(error.status || 503).json({ code: error.publicCode, error: error.message }); next(error); }
};
router.param('provider', (req, res, next, provider) => ['google','microsoft'].includes(provider) ? next() : res.status(404).json({ error: 'Calendar provider not found.' }));
router.get('/status', handle(connections.status));
router.post('/:provider/connect', csrfProtection, handle(connections.connect));
router.get('/:provider/callback', async (req, res, next) => {
  try { res.redirect(303, (await connections.callback(req)).href); }
  catch (error) { if (error.publicCode) return res.status(error.status || 503).send('Calendar access could not be confirmed. Return to LPC Settings and reconnect.'); next(error); }
});
router.delete('/:provider/connection', csrfProtection, handle(connections.disconnect));
router.post('/:provider/sync', csrfProtection, handle(async req => {
  await connections.actor(req);
  const row = await Connection.findOne({ ownerId: req.user.id, provider: req.params.provider, disconnectedAt: null }).lean();
  if (!row || row.authVersion !== connections.version(req) || req.body.revision !== row.revision) connections.fail(409, 'CONNECTION_CHANGED', 'Refresh this calendar connection before syncing.');
  if (req.body.linkId !== undefined && (!/^[a-f0-9]{24}$/i.test(req.body.linkId) || !['local','remote'].includes(req.body.prefer))) connections.fail(400, 'INVALID', 'Choose a valid conflict resolution.');
  return sync.sync(row._id, { revision: req.body.revision, linkId: req.body.linkId, prefer: req.body.prefer });
}));
router.get('/events', handle(async req => {
  await connections.actor(req);
  const from = new Date(req.query.from), to = new Date(req.query.to);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to || to - from > 100 * 86400000) connections.fail(400, 'RANGE', 'Choose a calendar range of at most 100 days.');
  const events = await Event.find({ owner: req.user.id, caseId: null, start: { $lte: to }, end: { $gte: from } }).sort({ start: 1, _id: 1 }).limit(1001).lean();
  if (events.length > 1000) connections.fail(503, 'LIMIT', 'Too many calendar events to show completely.');
  const activeConnections = await Connection.find({ ownerId: req.user.id, disconnectedAt: null, needsReconnect: false, authVersion: connections.version(req) }).select('_id provider revision').lean();
  const current = new Map(activeConnections.map(connection => [String(connection._id), connection]));
  const links = events.length && activeConnections.length ? await Link.find({ connectionId: { $in: activeConnections.map(connection => connection._id) }, kind: 'event', localId: { $in: events.map(event => event._id) }, deleted: false }).select('connectionId connectionRevision localId').lean() : [];
  const providersByEvent = new Map();
  for (const link of links) {
    const connection = current.get(String(link.connectionId));
    if (!connection || link.connectionRevision !== connection.revision) continue;
    const key = String(link.localId), providers = providersByEvent.get(key) || new Set();
    providers.add(connection.provider); providersByEvent.set(key, providers);
  }
  return { ownerId: String(req.user.id), items: events.map(event => ({ id: String(event._id), ...sync.eventShape(event), syncProviders: [...(providersByEvent.get(String(event._id)) || [])].sort(), revision: sync.hash(sync.eventShape(event)) })) };
}));
router.patch('/events/:id', csrfProtection, handle(async req => {
  await connections.actor(req);
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) connections.fail(400, 'INVALID', 'Choose a valid calendar event.');
  const event = await Event.findOne({ _id: req.params.id, owner: req.user.id, caseId: null }).lean();
  if (!event || req.body.revision !== sync.hash(sync.eventShape(event))) connections.fail(409, 'CONFLICT', 'This event changed. Reopen it before editing.');
  const values = req.body.values;
  if (!values || typeof values.title !== 'string' || !values.title.trim() || values.title.length > 500 || typeof values.isAllDay !== 'boolean' || !Number.isFinite(new Date(values.start).getTime()) || !Number.isFinite(new Date(values.end).getTime()) || new Date(values.end) < new Date(values.start)) connections.fail(400, 'INVALID', 'Enter a title and valid event dates.');
  await require('../services/genericEventWrite').write(req, { initialEvent: event, action: 'calendar.event.update', modify: current => { current.title = values.title; current.start = new Date(values.start); current.end = new Date(values.end); current.isAllDay = values.isAllDay; } });
  return { saved: true };
}));
router.get('/:provider/conflicts', handle(async req => {
  await connections.actor(req);
  const row = await Connection.findOne({ ownerId: req.user.id, provider: req.params.provider, disconnectedAt: null }).lean();
  if (!row) return { items: [] };
  const links = await Link.find({ connectionId: row._id, connectionRevision: row.revision, conflict: true }).limit(101).lean();
  return { items: (await Promise.all(links.map(async link => {
    const local = await (link.kind === 'matter' ? Case.findById(link.localId) : Event.findOne({ _id: link.localId, owner: req.user.id })).lean();
    if (local && link.kind === 'matter' && !sync.permission(local, req.user.id).readable) return null;
    return { id: String(link._id), title: local?.title || 'Deleted LPC event', href: link.kind === 'matter' ? `/${req.user.role === 'attorney' ? 'matters' : 'matter'}/${link.localId}${req.user.role === 'attorney' ? '/deadlines' : '?tab=deadlines'}` : null };
  }))).filter(Boolean) };
}));
module.exports = router;
