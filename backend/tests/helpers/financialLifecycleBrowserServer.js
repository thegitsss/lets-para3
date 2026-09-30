const path = require('node:path');
const crypto = require('node:crypto');

// Private single-replica application harness. All mounted API responses and
// financial writes are real. Only external providers and delivery are synthetic.
module.exports = async function start({ includeAdminSupport = false, includeAdminAutomation = false, includeAdminWorkspaces = false, includeDirectors = false, includeDesignPreviews = false, port = 5897 } = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test', APP_ENV: 'test', ENABLE_CSRF: 'true', EMAIL_DISABLE: 'true',
    JWT_SECRET: 'financial-lifecycle-private-managed-secret',
    DATA_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    STRIPE_SECRET_KEY: 'sk_test_browser_lifecycle_synthetic',
    STRIPE_WEBHOOK_SECRET: 'whsec_browser_lifecycle_synthetic',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_browser_lifecycle_synthetic',
    OPENAI_API_KEY: '', AWS_EC2_METADATA_DISABLED: 'true',
    S3_BUCKET: 'synthetic-browser-lifecycle', S3_MALWARE_SCAN_REQUIRED: 'false',
    APP_BASE_URL: 'http://127.0.0.1:5897', FRONTEND_BASE_URL: 'http://127.0.0.1:5897',
  });
  const external = { mail: [], storage: [] };
  const replace = (name, exports) => {
    const id = require.resolve(name);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  replace('../../utils/email', async (...args) => { external.mail.push(args); return { ok: true }; });
  replace('../../utils/opsAlerting', { sendOwnerAlert: async () => ({ ok: true }) });
  replace('../../utils/s3Client', { createS3Client: () => ({ send: async command => {
    const kind = command.constructor.name; external.storage.push(kind);
    if (kind === 'PutObjectCommand') return { ETag: 'synthetic' };
    throw Error(`Unconfigured synthetic storage operation: ${kind}`);
  } }) });
  replace('@aws-sdk/s3-request-presigner', { getSignedUrl: async () => { throw Error('External signed URLs are outside this lifecycle'); } });
  replace('@aws-sdk/lib-storage', { Upload: class SyntheticUpload {
    constructor({ params }) { this.params = params; }
    async done() {
      let bytes = 0;
      if (Buffer.isBuffer(this.params.Body)) bytes = this.params.Body.length;
      else for await (const chunk of this.params.Body) bytes += chunk.length;
      external.storage.push({ kind: 'Upload', key: this.params.Key, bytes });
      return { ETag: 'synthetic' };
    }
    async abort() {}
  } });
  const provider = require('./financialLifecycleProviders')();
  const express = require('express'), mongoose = require('mongoose'), jwt = require('jsonwebtoken');
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const { generateCsrfToken, respondToCsrfError } = require('../../utils/csrf');
  const { createAuthSession } = require('../../services/authSessionService');
  const User = require('../../models/User'), Case = require('../../models/Case');
  const app = express(), requests = [], assets = [], requestProgress = [];
  app.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store'); res.set('X-LPC-Test-Server', 'financial-lifecycle-browser');
    if (req.path.startsWith('/assets/')) {
      const assetPath = req.path;
      res.on('finish', () => assets.push({ path: assetPath, status: res.statusCode }));
    }
    if (req.path.startsWith('/api/')) {
      const requestPath = req.path;
      const startedAt = Date.now(), ownerId = String(req.query.expectedOwnerId || '');
      let errorCode = null, errorMessage = null;
      const progress = { method: req.method, path: requestPath, startedAt, status: null };
      requestProgress.push(progress);
      const sendJson = res.json.bind(res);
      res.json = value => { if (res.statusCode >= 400) { errorCode = value?.code || null; errorMessage = String(value?.error || value?.message || '').slice(0, 300); } return sendJson(value); };
      res.on('finish', () => {
        const finishedAt = Date.now(); Object.assign(progress, { status: res.statusCode, finishedAt });
        requests.push({ method: req.method, path: requestPath, status: res.statusCode, ...(ownerId ? { ownerId } : {}), startedAt, finishedAt, ...(errorCode ? { errorCode } : {}), ...(errorMessage ? { errorMessage } : {}) });
      });
      res.on('close', () => Object.assign(progress, { closedAt: Date.now(), completed: res.writableFinished }));
    }
    next();
  });
  app.use('/api/webhooks/stripe', require('../../routes/paymentsWebhook'));
  app.use(require('cookie-parser')(), express.json({ limit: '1mb' }));
  app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
  for (const [prefix, file] of [
    ['auth', 'auth'], ['users', 'users'], ['account', 'account'],
    ['cases', 'cases'], ['case-drafts', 'caseDrafts'], ['jobs', 'jobs'],
    ['applications', 'applications'], ['payments', 'payments'], ['disputes', 'disputes'],
    ['messages', 'messages'], ['notifications', 'notifications'], ['events', 'events'], ['uploads', 'uploads'],
    ['blocks', 'blocks'], ['paralegals', 'paralegals'], ['public/paralegals', 'publicParalegalDirectory'], ['checklist', 'checklist'],
    ['attorney/dashboard', 'attorneyDashboard'], ['paralegal/dashboard', 'paralegalDashboard'],
    ...(includeAdminSupport ? [['admin/support', 'adminSupport']] : []),
    ...(includeAdminAutomation ? [['admin/ai', 'aiAdmin'], ['admin/approvals', 'adminApprovals']] : []),
    ...(includeAdminWorkspaces ? [['admin/marketing', 'adminMarketing'], ['admin/sales', 'adminSales'], ['admin/engineering', 'adminEngineering'], ['admin/knowledge', 'adminKnowledge']] : []),
    ...(includeDirectors ? [['director', 'directorPortal'], ['admin/directors', 'adminDirectors']] : []),
    ['admin/workspace', 'adminWorkspace'], ['admin', 'admin'],
  ]) app.use(`/api/${prefix}`, require(`../../routes/${file}`));
  // Production also exposes the authenticated member profile through users.
  app.use('/api/paralegals', require('../../routes/users').paralegalRouter);
  app.get('/api/health', (_req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.status(connected ? 200 : 503).json({ ok: connected, db: connected ? 'connected' : 'disconnected' });
  });
  // Production serves these shared bundles for every role, independently of
  // whether this fixture has mounted the optional director routes.
  app.get('/assets/vendor/simplewebauthn-13.3.0.js', (_req, res) => res.type('application/javascript').sendFile(path.resolve(__dirname, '../../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));
  app.get('/assets/vendor/web-vitals-6.1.1.js', (_req, res) => res.type('application/javascript').sendFile(path.resolve(__dirname, '../../node_modules/web-vitals/dist/web-vitals.js')));
  app.get('/assets/vendor/chart-4.5.1.js', (_req, res) => res.type('application/javascript').sendFile(path.resolve(__dirname, '../../node_modules/chart.js/dist/chart.umd.js')));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Route not mounted in financial lifecycle fixture' }));
  app.use(express.static(require('../../utils/frontendAssets').frontendDirectory(), { etag: false }));
  if (includeDesignPreviews) app.use((req, res, next) => {
    const file = require('../../scripts/design-preview-assets').resolvePreviewAsset(req.originalUrl);
    return file ? res.sendFile(file) : next();
  });
  app.use((error, _req, res, _next) => {
    if (respondToCsrfError(error, res)) return;
    res.status(error.statusCode || error.status || 500).json({ error: error.message, code: error.publicCode || error.code });
  });
  let replica, listener;
  async function close() {
    if (listener) { listener.closeAllConnections?.(); await new Promise(resolve => listener.close(resolve)); listener = null; }
    await mongoose.disconnect();
    if (replica) { await replica.stop({ doCleanup: true, force: true }); replica = null; }
  }
  try {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' }, instanceOpts: [{ launchTimeout: 60000 }] });
    await mongoose.connect(replica.getUri('financial_lifecycle_browser'), { autoCreate: false, autoIndex: false });
    // Transactional writers can load a model lazily. Prepare the complete
    // schema before accepting requests, including durable email obligations.
    const modelsDirectory = path.resolve(__dirname, '../../models');
    for (const file of require('node:fs').readdirSync(modelsDirectory).filter(name => name.endsWith('.js')).sort()) {
      require(path.join(modelsDirectory, file));
    }
    for (const Model of Object.values(mongoose.models)) { await Model.init(); await Model.createCollection(); await Model.createIndexes(); }
    mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
    listener = await new Promise((resolve, reject) => {
      const value = app.listen(port, '127.0.0.1');
      value.once('error', reject);
      value.once('listening', () => resolve(value));
    });
    const origin = `http://127.0.0.1:${listener.address().port}`;
    process.env.APP_BASE_URL = origin; process.env.FRONTEND_BASE_URL = origin;
    const owners = new Set();
    async function createUser(role, preferences = {}, publicProfile = false) {
      const theme = preferences.theme === "dark" ? "dark" : "light";
      const fontSize = ["sm", "md", "lg"].includes(preferences.fontSize) ? preferences.fontSize : "md";
      const user = await User.create({ firstName: 'River', lastName: role, email: `lifecycle-${crypto.randomUUID()}@example.test`, password: 'Private synthetic lifecycle password!', role, status: 'approved', emailVerified: true, state: 'CA', stateExperience: ['CA'], practiceAreas: ['Immigration'], yearsExperience: 8, profileImage: 'https://assets.test/synthetic-avatar.jpg', ...(role === 'paralegal' ? { stripeAccountId: `acct_${crypto.randomUUID().replaceAll('-', '')}`, stripeOnboarded: true, stripeChargesEnabled: true, stripePayoutsEnabled: true } : {}), ...(publicProfile && role === 'paralegal' ? { bio: 'I organize filing materials and review supporting evidence with attorneys.', skills: ['Legal research'], resumeURL: 'https://assets.test/synthetic-resume.pdf', profilePhotoStatus: 'approved', approvedAt: new Date() } : {}), preferences: { theme, fontSize }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } });
      const session = await createAuthSession(user, { headers: { 'user-agent': 'Private financial lifecycle browser' }, ip: '192.0.2.22' });
      owners.add(String(user._id));
      return { id: String(user._id), cookie: { name: 'token', value: jwt.sign({ id: String(user._id), role, status: user.status, sid: session.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2h' }), url: origin, httpOnly: true, sameSite: 'Lax' } };
    }
    return { origin, createUser, close, provider,
      async reset() {
        if (mongoose.connection.name !== 'financial_lifecycle_browser') throw Error('Refusing to clear an unowned database');
        for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
        owners.clear(); requests.length = 0; assets.length = 0; requestProgress.length = 0; external.mail.length = 0; external.storage.length = 0; provider.reset();
      },
      evidence: () => ({ requests: [...requests], assets: [...assets], requestProgress: [...requestProgress], provider: provider.calls, external }),
      async withdrawalNotices(caseId) {
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney))) throw Error('Unknown synthetic Matter');
        return require('../../models/MatterWithdrawalNotification').find({ caseId: doc._id }).sort({ userId: 1 }).lean();
      },
      async issueOverdueReviewReminder(caseId) {
        if (mongoose.connection.name !== 'financial_lifecycle_browser') throw Error('Refusing to change an unowned database');
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney)) || doc.status !== 'disputed') throw Error('Unknown synthetic LPC review');
        // Simulate the existing review deadline passing; execute the real job.
        await Case.updateOne({ _id: doc._id }, { $set: { adminDisputeDeadlineAt: new Date(Date.now() - 60000) } });
        return require('../../services/withdrawalLifecycle').processAdminOverdueDisputes();
      },
      async applicationNotices(caseId) {
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney))) throw Error('Unknown synthetic Matter');
        return require('../../models/MatterApplicationNotification').find({ caseId: doc._id }).sort({ createdAt: 1, _id: 1 }).lean();
      },
      async postingNotices(caseId, ownerId) {
        if (mongoose.connection.name !== 'financial_lifecycle_browser' || !owners.has(String(ownerId))) throw Error('Unknown synthetic posting owner');
        return require('../../models/MatterPostingNotification').find({ caseId, ownerId }).sort({ createdAt: 1, _id: 1 }).lean();
      },
      async preEngagementNotices(caseId) {
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney))) throw Error('Unknown synthetic Matter');
        return require('../../models/MatterPreEngagementNotification').find({ caseId: doc._id }).sort({ createdAt: 1, _id: 1 }).lean();
      },
      async invitationNotices(caseId) {
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney))) throw Error('Unknown synthetic Matter');
        return require('../../models/MatterInvitationNotification').find({ caseId: doc._id }).sort({ createdAt: 1, _id: 1 }).lean();
      },
      async seedEarlierApplication(caseId, paralegalId, note) {
        if (mongoose.connection.name !== 'financial_lifecycle_browser') throw Error('Refusing to change an unowned database');
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney)) || !owners.has(String(paralegalId)) || doc.status !== 'open' || doc.applicants?.length) throw Error('Unknown synthetic open Matter');
        const Job = require('../../models/Job'), Application = require('../../models/Application');
        const job = await Job.findOne({ caseId: doc._id }).lean();
        if (!job || await Application.exists({ jobId: job._id })) throw Error('Synthetic earlier fixture already has applications');
        await Case.collection.updateOne({ _id: doc._id }, { $set: { applicants: [{ paralegalId: new mongoose.Types.ObjectId(paralegalId), status: 'pending', appliedAt: new Date(), note }], lockedTotalAmount: doc.totalAmount, amountLockedAt: new Date() } });
        await Job.updateOne({ _id: job._id }, { $set: { applicantsCount: 1 } });
      },
      async reviewNotices(caseId) {
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney))) throw Error('Unknown synthetic Matter');
        return require('../../models/MatterReviewNotification').find({ caseId: doc._id }).sort({ userId: 1 }).lean();
      },
      async completionNotices(caseId) {
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney))) throw Error('Unknown synthetic Matter');
        return require('../../models/MatterPaymentNotification').find({ caseId: doc._id, kind: 'completion' }).sort({ userId: 1 }).lean();
      },
      async makeWithdrawalReviewDue(caseId) {
        if (mongoose.connection.name !== 'financial_lifecycle_browser') throw Error('Refusing to change an unowned database');
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney)) || !doc.disputeDeadlineAt || doc.payoutFinalizedAt) throw Error('Unknown synthetic review window');
        // Simulate elapsed time for the real request-time expiry route.
        await Case.collection.updateOne({ _id: doc._id, disputeDeadlineAt: doc.disputeDeadlineAt }, { $set: { disputeDeadlineAt: new Date(Date.now() - 1000) } });
      },
      async inspect(caseId) {
        const doc = await Case.findById(caseId).lean();
        if (!doc || !owners.has(String(doc.attorneyId || doc.attorney))) throw Error('Unknown synthetic Matter');
        const query = { caseId: doc._id };
        return { case: doc, payouts: await require('../../models/Payout').find(query).lean(), operations: await require('../../models/PaymentOperation').find(query).lean(), income: await require('../../models/PlatformIncome').find(query).lean() };
      },
    };
  } catch (error) { await close(); throw error; }
};
