const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../../../backend');
const local = name => require(path.join(root, 'node_modules', name));

// Real guarded routes and managed sessions; private synthetic database only.
// The factory never loads the application bootstrap or environment files.
module.exports = async function startBlockedEvidenceServer({
  frontendRoot = path.resolve(root, '../frontend'), port = 5293,
} = {}) {
  const origin = `http://localhost:${port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test', JWT_SECRET: 'blocked-browser-local-jwt-secret-at-least-32-bytes',
    DATA_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    EMAIL_DISABLE: 'true', ENABLE_CSRF: 'false', APP_BASE_URL: origin,
  });
  const owners = new Set(), mail = [];
  const emailPath = require.resolve(path.join(root, 'utils/email'));
  require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true,
    exports: async (...args) => { mail.push({ subject: args[1] }); return { ok: true }; } };
  const mongoose = local('mongoose'), express = local('express'), jwt = local('jsonwebtoken');
  const { MongoMemoryReplSet } = local('mongodb-memory-server');
  const User = require(path.join(root, 'models/User'));
  const Block = require(path.join(root, 'models/Block'));
  const AuthSession = require(path.join(root, 'models/AuthSession'));
  const auth = require(path.join(root, 'routes/auth'));
  const blocks = require(path.join(root, 'routes/blocks'));
  const { createAuthSession } = require(path.join(root, 'services/authSessionService'));
  const { createOrActivateBlock, deactivateBlock } = require(path.join(root, 'utils/blocks'));
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' }, instanceOpts: [{ launchTimeout: 60000 }] });
  await mongoose.connect(replica.getUri('blocked_browser_isolated'), { autoCreate: false, autoIndex: false });
  for (const Model of Object.values(mongoose.models)) {
    await Model.init(); await Model.createCollection(); await Model.createIndexes();
  }
  mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
  const app = express(); app.use(local('cookie-parser')()); app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/csrf', (_req, res) => res.json({ csrfToken: 'synthetic-blocks-csrf' }));
  app.get('/assets/vendor/simplewebauthn-13.3.0.js', (_req, res) => res.type('application/javascript').sendFile(path.join(root, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' && req.path === '/auth/me') return next();
    if (['GET', 'DELETE'].includes(req.method) && /^\/blocks(?:\/[a-f0-9]{24})?$/.test(req.path)) return next();
    if (req.method === 'GET' && req.path === '/notifications/stream') return res.type('text/event-stream').send(': ready\n\n');
    if (req.method === 'GET') return res.json(req.path.includes('unread-count') ? { count: 0 } : req.path === '/notifications/page' ? { items: [], hasMore: false, nextCursor: null } : req.path === '/notifications' ? [] : {});
    return res.status(501).json({ error: 'Outside isolated blocked-user evidence scope' });
  });
  app.use('/api/auth', auth); app.use('/api/blocks', blocks); app.use(express.static(frontendRoot, { etag: false }));
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Server error' }));
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server)); server.on('error', reject);
  });
  function owned(id) { if (!owners.has(String(id))) throw new Error('Unknown synthetic blocked-user account'); }
  async function cookieFor(id) {
    owned(id); const user = await User.findById(id).select('+authVersion');
    const session = await createAuthSession(user, { headers: { 'user-agent': 'Synthetic blocked-user browser' }, ip: '192.0.2.20' });
    return { name: 'token', value: jwt.sign({ id: String(user._id), role: user.role, status: user.status, sid: session.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2h' }), url: origin, httpOnly: true, sameSite: 'Lax' };
  }
  return {
    origin, cookieFor,
    async createUser(overrides = {}) {
      const user = await User.create({ firstName: 'Morgan', lastName: 'Counsel', email: `blocked-${crypto.randomUUID()}@example.test`, password: 'A bounded synthetic passphrase', role: 'attorney', status: 'approved', emailVerified: true, preferences: { theme: 'light', fontSize: 'md' }, ...overrides });
      owners.add(String(user._id)); return { id: String(user._id), cookie: await cookieFor(user._id) };
    },
    async block(ownerId, targetId, values = {}) {
      owned(ownerId); owned(targetId);
      return Block.create({ blockerId: ownerId, blockedId: targetId, blockerRole: 'attorney', blockedRole: 'paralegal', ...values });
    },
    async manyMissingBlocks(ownerId, count) {
      owned(ownerId); return Block.collection.insertMany(Array.from({ length: count }, () => ({ blockerId: new mongoose.Types.ObjectId(ownerId), blockedId: new mongoose.Types.ObjectId(), active: true, blockedRole: 'paralegal', createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01') })));
    },
    async reactivate(ownerId, targetId) {
      owned(ownerId); owned(targetId);
      await deactivateBlock({ blockerId: ownerId, blockedId: targetId });
      await createOrActivateBlock({ blockerId: ownerId, blockedId: targetId, blockerRole: 'attorney', blockedRole: 'paralegal' });
    },
    async inspectBlock(ownerId, targetId) { owned(ownerId); return Block.findOne({ blockerId: ownerId, blockedId: targetId }).select('active deactivatedAt __v').lean(); },
    async activeBlocks(ownerId) { owned(ownerId); return Block.countDocuments({ blockerId: ownerId, active: { $ne: false } }); },
    async updateUser(id, values) { owned(id); await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: values }); },
    async inspectUser(id) { owned(id); return User.findById(id).select('lawFirm preferences').lean(); },
    async removeUser(id) { owned(id); await User.deleteOne({ _id: id }); },
    async revoke(cookie) { const payload = jwt.verify(cookie.value, process.env.JWT_SECRET); owned(payload.id); await AuthSession.updateOne({ sessionId: payload.sid }, { $set: { revokedAt: new Date() } }); },
    mailSubjects: () => mail.map(item => item.subject),
    async close() {
      listener.closeAllConnections?.(); await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      await mongoose.disconnect(); await replica.stop({ doCleanup: true, force: true });
    },
  };
};
