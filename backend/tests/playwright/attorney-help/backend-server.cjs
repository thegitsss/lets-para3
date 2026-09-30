const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(process.env.LPC_HELP_BACKEND_ROOT || path.join(__dirname, '../../..'));
const local = name => require(path.join(root, 'node_modules', name));

// Actual managed authentication, CSRF and incident routes; isolated synthetic
// replica and loopback listener. Ancillary workspace data is explicitly empty.
module.exports = async function startServer({ frontendRoot, onStartupCleanup } = {}) {
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'help-local-managed-session-secret-at-least-32-bytes', DATA_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4), EMAIL_DISABLE: 'true', ENABLE_CSRF: 'true' });
  const mongoose = local('mongoose'), express = local('express'), jwt = local('jsonwebtoken');
  const { MongoMemoryReplSet } = local('mongodb-memory-server');
  const User = require(path.join(root, 'models/User'));
  const models = Object.fromEntries(['Incident', 'IncidentArtifact', 'IncidentEvent', 'IncidentNotification', 'Notification'].map(name => [name, require(path.join(root, 'models', name))]));
  const { LpcEvent } = require(path.join(root, 'models/LpcEvent'));
  const incidents = require(path.join(root, 'routes/incidents')), auth = require(path.join(root, 'routes/auth'));
  const { createAuthSession } = require(path.join(root, 'services/authSessionService'));
  const { generateCsrfToken, respondToCsrfError } = require(path.join(root, 'utils/csrf'));
  let replica = null, listener = null, stopped = false;
  async function close() {
    stopped = true;
    const server = listener; listener = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await mongoose.disconnect();
    const currentReplica = replica; replica = null;
    if (currentReplica) await currentReplica.stop({ doCleanup: true, force: true });
  }
  // The test owns this callback even if its beforeEach budget expires while
  // setup is still pending. A late setup result observes stopped and closes.
  onStartupCleanup?.(close);
  const assertStarting = () => { if (stopped) throw new Error('Help fixture startup canceled'); };
  try {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' }, instanceOpts: [{ launchTimeout: 60000 }] });
  assertStarting();
  await mongoose.connect(replica.getUri('attorney_help_isolated'), { autoCreate: false, autoIndex: false });
  assertStarting();
  for (const Model of Object.values(mongoose.models)) { await Model.init(); assertStarting(); await Model.createCollection(); assertStarting(); await Model.createIndexes(); assertStarting(); }
  mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
  const app = express(); app.use(local('cookie-parser')()); app.use(express.json()); app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
  app.use('/api/auth', auth); app.use('/api/incidents', incidents);
  app.use('/api', (req, res) => {
    if (req.path.endsWith('/stream')) return res.status(204).end();
    if (req.method !== 'GET') return res.status(501).json({ error: 'Outside isolated Help scope' });
    return res.json(req.path.includes('unread-count') ? { count: 0 } : req.path === '/notifications/page' ? { items: [], hasMore: false, nextCursor: null } : req.path === '/notifications' ? [] : {});
  });
  app.use(express.static(frontendRoot, { etag: false }));
  app.use((error, _req, res, _next) => { if (respondToCsrfError(error, res)) return; res.status(500).json({ error: 'Server error' }); });
  listener = await new Promise((resolve, reject) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); value.once('error', reject); });
  assertStarting();
  const origin = `http://127.0.0.1:${listener.address().port}`, owners = new Set();
  async function createUser() {
    const user = await User.create({ firstName: 'Dana', lastName: 'Counsel', email: `help-${crypto.randomUUID()}@example.test`, password: 'Synthetic private help password!', role: 'attorney', status: 'approved', emailVerified: true, preferences: { theme: 'light', fontSize: 'md' } });
    owners.add(String(user._id)); const record = await createAuthSession(user, { headers: { 'user-agent': 'Synthetic Help browser' }, ip: '192.0.2.10' });
    return { id: String(user._id), cookie: { name: 'token', value: jwt.sign({ id: String(user._id), role: user.role, status: user.status, sid: record.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2h' }), url: origin, httpOnly: true, sameSite: 'Lax' } };
  }
  return { origin, createUser,
    async evidence(ownerId) {
      if (!owners.has(ownerId)) throw new Error('Unknown synthetic owner');
      const rows = await models.Incident.find({ 'reporter.userId': ownerId }).select('_id publicId reporter.userId context').lean(), ids = rows.map(row => row._id);
      // Each test starts a fresh server. Counts deliberately include all records
      // so an accidental duplicate under another owner cannot be hidden.
      return { incidents: await models.Incident.countDocuments(), artifacts: await models.IncidentArtifact.countDocuments(), timeline: await models.IncidentEvent.countDocuments(), receipts: await models.IncidentNotification.countDocuments(), notifications: await models.Notification.countDocuments(), events: await LpcEvent.countDocuments({ eventType: 'incident.created' }), ownerIncidents: ids.length, references: rows.map(row => ({ publicId: row.publicId, ownerId: String(row.reporter.userId), routePath: row.context.routePath })) };
    },
    close,
  };
  } catch (error) { await close(); throw error; }
};
