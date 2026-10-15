const path = require('node:path');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../../../backend');
const local = name => require(path.join(root, 'node_modules', name));

// Isolated browser evidence only. Objects and email stay in this Node process;
// no provider client, shared Mongo URI, or production bootstrap is used.
module.exports = async function startAccountEvidenceServer({ frontendRoot = process.env.LPC_SECURITY_FRONTEND_ROOT || path.resolve(root, '../frontend'), port = 5281, reporterId } = {}) {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'account-evidence-local-jwt-secret-at-least-32-bytes';
  process.env.DATA_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.EMAIL_DISABLE = 'true'; process.env.ENABLE_CSRF = 'false';
  process.env.S3_BUCKET = 'account-browser-fixture'; process.env.S3_REGION = 'us-east-1';
  const objects = new Map(), mail = [], owners = new Set(), loseResponses = new Set(), lostResponses = [], mutationReceipts = [];
  const s3 = { async send(command) {
    const input = command.input || {}, name = command.constructor.name;
    if (name === 'PutObjectCommand') {
      const body = Buffer.from(input.Body); objects.set(input.Key, { body, type: input.ContentType, etag: `"${crypto.createHash('sha256').update(body).digest('hex')}"` }); return {};
    }
    if (name === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
    const object = objects.get(input.Key);
    if (!object) throw Object.assign(new Error('Synthetic object missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    if (name === 'GetObjectTaggingCommand') return { TagSet: [] };
    if (name === 'GetObjectCommand' || name === 'HeadObjectCommand') return { Body: name === 'GetObjectCommand' ? Readable.from(object.body) : undefined, ContentType: object.type, ContentLength: object.body.length, ETag: object.etag };
    throw new Error(`Unsupported synthetic object operation: ${name}`);
  } };
  require(path.join(root, 'utils/s3Client')).createS3Client = () => s3;
  const emailPath = require.resolve(path.join(root, 'utils/email'));
  require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: async (...args) => { mail.push({ subject: args[1] }); return { ok: true }; } };
  const mongoose = local('mongoose'), express = local('express'), jwt = local('jsonwebtoken');
  const { MongoMemoryReplSet } = local('mongodb-memory-server');
  const User = require(path.join(root, 'models/User'));
  const users = require(path.join(root, 'routes/users'));
  const account = require(path.join(root, 'routes/account'));
  const uploads = require(path.join(root, 'routes/uploads'));
  const verifyToken = require(path.join(root, 'utils/verifyToken'));
  const { createAuthSession } = require(path.join(root, 'services/authSessionService')); 
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' }, instanceOpts: [{ launchTimeout: 60000, args: ['--setParameter', 'shutdownTimeoutMillisForSignaledShutdown=1000'] }] });
  await mongoose.connect(replica.getUri('account_browser_isolated'), { autoCreate: false, autoIndex: false });
  for (const Model of Object.values(mongoose.models)) { await Model.init(); await Model.createCollection(); await Model.createIndexes(); }
  mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
  async function createUser(overrides = {}) {
    const user = await User.create({ firstName: 'Avery', lastName: 'Counsel', email: `account-${crypto.randomUUID()}@example.test`, password: 'Password123!', role: 'attorney', status: 'approved', state: 'NY', location: 'NY', lawFirm: 'Counsel Law', bio: 'An established civil litigation practice.', barNumber: 'NY-4321', timezone: 'America/Chicago', yearsExperience: 7, experience: [{ title: 'Attorney', years: '2019–2026', description: 'Civil litigation' }], preferences: { theme: 'light', fontSize: 'md' }, onboarding: { attorneyTourCompleted: true, attorneyProfileCompleted: true }, ...overrides });
    owners.add(String(user._id)); return user;
  }
  const reporter = await createUser(reporterId ? { _id: reporterId } : {});
  const app = express(); app.use(local('cookie-parser')()); app.use(express.json());
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const pathname = req.originalUrl.split('?')[0], end = res.end;
    res.end = function(...args) {
      const key = `${req.user?.id || ''}:${req.method}:${pathname}`;
      if (res.statusCode >= 200 && res.statusCode < 300 && req.user?.id &&
          (req.method === 'PATCH' && pathname === '/api/users/me' ||
           req.method === 'POST' && ['/api/account/preferences', '/api/uploads/profile-photo'].includes(pathname))) {
        mutationReceipts.push({ownerId:String(req.user.id),method:req.method,path:pathname,status:res.statusCode});
      }
      if (res.statusCode >= 200 && res.statusCode < 300 && loseResponses.delete(key)) {
        lostResponses.push({ ownerId: String(req.user.id), method: req.method, path: pathname, status: res.statusCode });
        req.socket.destroy(); return res;
      }
      return end.apply(this, args);
    };
    next();
  });
  app.get('/api/auth/me', verifyToken, async (req, res, next) => {
    try { const user = await User.findById(req.user.id).select('_id firstName lastName email role status onboarding preferences').lean(); res.json({ user: { ...user, id: String(user._id) } }); } catch (error) { next(error); }
  });
  app.get('/api/csrf', (_req, res) => res.json({ csrfToken: 'synthetic-account-csrf' }));
  app.get('/assets/vendor/simplewebauthn-13.3.0.js', (_req, res) => res.type('application/javascript').sendFile(path.join(root, 'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));
  app.get('/assets/vendor/web-vitals-6.1.1.js', (_req, res) => res.type('application/javascript').sendFile(path.join(root, 'node_modules/web-vitals/dist/web-vitals.js')));
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/event-stream')) {
      res.set('Content-Type', 'text/event-stream'); return res.end('retry: 60000\n: synthetic account evidence stream\n\n');
    }
    if (req.path.startsWith('/notifications')) {
      const expected = req.method === 'GET' ? req.query.expectedOwnerId : req.body?.expectedOwnerId;
      if (expected) {
        let identity; try { identity = jwt.verify(req.cookies.token || '', process.env.JWT_SECRET); } catch { return res.status(401).json({error:'Session expired'}); }
        if (String(expected) !== String(identity.id)) return res.status(403).json({error:'Verify your account.',code:'ACCOUNT_CHANGED'});
      }
      if (req.method !== 'GET') return res.json({success:true});
      if (req.path === '/notifications/page') return res.json({items:[],nextCursor:null,hasMore:false});
      if (req.path === '/notifications/unread-count') return res.json({count:0});
      if (req.path === '/notifications') return res.json([]);
    }
    const permitted = req.method === 'GET' && /^\/(users\/(me|attorneys\/[a-f0-9]{24}|profile-photo\/[a-f0-9]{24})|account\/preferences|uploads\/profile-photo\/original)$/.test(req.path)
      || req.method === 'PATCH' && /^\/users\/me(?:\/notification-prefs)?$/.test(req.path)
      || req.method === 'POST' && /^\/(account\/preferences|uploads\/profile-photo)$/.test(req.path);
    if (permitted) return next();
    if (req.method === 'GET') return res.json(req.path.includes('unread-count') ? { count: 0, unreadCount: 0 } : req.path === '/notifications' ? [] : { items: [] });
    return res.status(501).json({ error: 'Outside isolated account evidence scope' });
  });
  app.use('/api/users', users); app.use('/api/account', account); app.use('/api/uploads', uploads);
  app.use(express.static(frontendRoot, { etag: false }));
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Server error' }));
  const listener = await new Promise((resolve, reject) => { const server = app.listen(port, '127.0.0.1', () => resolve(server)); server.on('error', reject); });
  const origin = `http://127.0.0.1:${listener.address().port}`;
  async function cookieFor(id) {
    if (!owners.has(String(id))) throw new Error('Unknown synthetic account');
    const user = await User.findById(id);
    const session = await createAuthSession(user, { headers: { 'user-agent': 'Private account evidence browser' }, ip: '192.0.2.22' });
    return { name: 'token', value: jwt.sign({ id: String(user._id), role: user.role, status: user.status, email: user.email, sid: session.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2h' }), url: origin, httpOnly: true, sameSite: 'Lax' };
  }
  return {
    origin, reporterId: String(reporter._id), cookie: await cookieFor(reporter._id), cookieFor,
    async createUser(overrides) { const user = await createUser(overrides); return { id: String(user._id), cookie: await cookieFor(user._id) }; },
    async updateUser(id, values) { if (!owners.has(String(id))) throw new Error('Unknown synthetic account'); await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: values }); },
    async inspectPhotoStorage(id = reporter._id) { if (!owners.has(String(id))) throw new Error('Unknown synthetic account'); return User.findById(id).select('+profileImageKey +profileImageOriginalKey +pendingProfileImageKey +pendingProfileImageOriginalKey profilePhotoStatus').lean(); },
    async inspectUser(id = reporter._id) { if (!owners.has(String(id))) throw new Error('Unknown synthetic account'); return User.findById(id).select('_id firstName lastName email pendingEmail phoneNumber lawFirm bio barNumber timezone state location experience yearsExperience languages publications practiceAreas preferences notificationPrefs profileImage avatarURL profilePhotoStatus').lean(); },
    objectKeys: () => [...objects.keys()], mailSubjects: () => mail.map(item => item.subject),
    dropNextResponse(id, pathname, method = 'POST') {
      if (!owners.has(String(id)) || !['/api/users/me','/api/account/preferences','/api/uploads/profile-photo'].includes(pathname)) throw new Error('Outside isolated response-loss scope');
      loseResponses.add(`${id}:${method}:${pathname}`);
    },
    lostResponses: () => lostResponses.map(value => ({...value})),
    mutationReceipts: () => mutationReceipts.map(value => ({...value})),
    async close() { await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); await mongoose.disconnect(); await replica.stop({ doCleanup: true, force: true }); },
  };
};
