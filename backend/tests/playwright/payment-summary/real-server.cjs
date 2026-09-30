const path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..'), local = name => require(path.join(root, 'node_modules', name));

// Actual managed authentication and payment/dashboard readers with isolated retained
// records. No production database, provider requests, workers or financial writers.
module.exports = async function startServer({ frontendRoot, onStartupCleanup }) {
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'financial-local-managed-secret-at-least-32-bytes', DATA_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4), EMAIL_DISABLE: 'true', ENABLE_CSRF: 'true', APP_BASE_URL: 'http://127.0.0.1', OPENAI_API_KEY: '', STRIPE_SECRET_KEY: 'sk_test_financial_private_fixture' });
  const mongoose = local('mongoose'), express = local('express'), jwt = local('jsonwebtoken'), { MongoMemoryReplSet } = local('mongodb-memory-server');
  const User = require(path.join(root, 'models/User')), Case = require(path.join(root, 'models/Case')), Operation = require(path.join(root, 'models/PaymentOperation')), Payout = require(path.join(root, 'models/Payout'));
  const auth = require(path.join(root, 'routes/auth')), payments = require(path.join(root, 'routes/payments')), dashboard = require(path.join(root, 'routes/attorneyDashboard'));
  const verifyToken = require(path.join(root, 'utils/verifyToken')), { createAuthSession } = require(path.join(root, 'services/authSessionService'));
  const { generateCsrfToken, respondToCsrfError } = require(path.join(root, 'utils/csrf'));
  const stripe = require(path.join(root, 'utils/stripe')), providerCalls = [];
  const originals = [];
  for (const name of ['paymentIntents', 'charges', 'refunds', 'transfers', 'customers', 'paymentMethods']) {
    for (const method of ['retrieve', 'list', 'create', 'update']) if (typeof stripe[name]?.[method] === 'function') {
      const original = stripe[name][method]; originals.push(() => { stripe[name][method] = original; });
      stripe[name][method] = async () => { providerCalls.push(`${name}.${method}`); throw Error('Provider calls are outside private financial read acceptance'); };
    }
  }
  let replica, listener, stopped = false;
  const close = async () => {
    stopped = true;
    if (listener) { const current = listener; listener = null; current.closeAllConnections(); await new Promise(resolve => current.close(resolve)); }
    await mongoose.disconnect();
    if (replica) { const current = replica; replica = null; await current.stop({ doCleanup: true, force: true }); }
    originals.splice(0).forEach(restore => restore());
  };
  onStartupCleanup(close);
  try {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' }, instanceOpts: [{ launchTimeout: 60000 }] });
    if (stopped) throw Error('Financial fixture startup canceled');
    await mongoose.connect(replica.getUri('financial_browser_isolated'), { autoCreate: false, autoIndex: false });
    for (const Model of Object.values(mongoose.models)) { await Model.init(); await Model.createCollection(); await Model.createIndexes(); }
    mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
    const app = express(); app.use(local('cookie-parser')(), express.json()); app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
    app.use('/api/auth', auth); app.use('/api/payments', payments); app.use('/api/attorney/dashboard', dashboard);
    app.get('/api/users/me', verifyToken, (req, res) => res.json({ id: String(req.user._id), _id: String(req.user._id), role: req.user.role, status: req.user.status, firstName: req.user.firstName, lastName: req.user.lastName, preferences: req.user.preferences, onboarding: req.user.onboarding }));
    app.get('/api/users/me/pending-hire', verifyToken, (req, res) => res.json({ ownerId: String(req.user._id), revision: 'a'.repeat(64), pending: null }));
    app.use('/api', (req, res) => {
      if (req.path.endsWith('/stream')) return res.status(204).end();
      if (req.method !== 'GET') return res.status(501).json({ error: 'Outside isolated financial read scope' });
      const empty = { '/account/preferences': { theme: 'light', fontSize: 'md' }, '/cases/my': [], '/applications/my-postings': [], '/checklist': { items: [], total: 0 }, '/messages/threads': { threads: [], total: 0 }, '/messages/summary': { items: [], totalThreads: 0 } };
      res.json(empty[req.path] || (req.path.includes('unread-count') ? { count: 0 } : req.path === '/notifications/page' ? { items: [], hasMore: false, nextCursor: null } : req.path === '/notifications' ? [] : {}));
    });
    for (const [url, file] of [['simplewebauthn-13.3.0.js', '@simplewebauthn/browser/dist/bundle/index.umd.min.js'], ['web-vitals-6.1.1.js', 'web-vitals/dist/web-vitals.js'], ['chart-4.5.1.js', 'chart.js/dist/chart.umd.js']]) app.get(`/assets/vendor/${url}`, (_req, res) => res.type('application/javascript').sendFile(path.join(root, 'node_modules', file)));
    app.use(express.static(frontendRoot, { etag: false }));
    app.use((error, _req, res, _next) => { if (respondToCsrfError(error, res)) return; res.status(error.statusCode || error.status || 500).json({ error: error.message, code: error.publicCode || error.code }); });
    listener = await new Promise((resolve, reject) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); value.once('error', reject); });
    const origin = `http://127.0.0.1:${listener.address().port}`, owners = new Set();
    return { origin, close, providerCalls,
      async createUser(role = 'attorney') {
        const user = await User.create({ firstName: 'Dana', lastName: 'Reporter', email: `financial-${crypto.randomUUID()}@example.test`, password: 'Synthetic private financial password!', role, status: 'approved', emailVerified: true, preferences: { theme: 'light', fontSize: 'md' }, onboarding: { attorneyTourCompleted: true } });
        const record = await createAuthSession(user, { headers: { 'user-agent': 'Synthetic financial browser' }, ip: '192.0.2.10' }); owners.add(String(user._id));
        return { id: String(user._id), cookie: { name: 'token', value: jwt.sign({ id: String(user._id), role, status: user.status, sid: record.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2h' }), url: origin, httpOnly: true, sameSite: 'Lax' } };
      },
      async seed(ownerId) {
        if (!owners.has(ownerId)) throw Error('Unknown synthetic owner');
        const person = await this.createUser('paralegal');
        for (const [currency, partial] of [['usd', 10000], ['eur', 20000]]) {
          const _id = new mongoose.Types.ObjectId(), now = new Date('2026-01-05'), transferId = `tr_${_id}`;
          await Case.collection.insertOne({ _id, attorney: new mongoose.Types.ObjectId(ownerId), attorneyId: new mongoose.Types.ObjectId(ownerId), paralegal: new mongoose.Types.ObjectId(person.id), paralegalId: new mongoose.Types.ObjectId(person.id), title: `River Street ${currency.toUpperCase()}`, status: 'in progress', archived: false, paymentReleased: false, totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 40000 - partial, feeAttorneyPct: 22, feeAttorneyAmount: 8800, feeParalegalPct: 19, currency, stripeMode: 'test', paymentIntentId: `pi_${_id}`, escrowIntentId: `pi_${_id}`, escrowStatus: 'funded', fundingIntegrityStatus: 'verified', withdrawalHistory: [{ withdrawnParalegalId: new mongoose.Types.ObjectId(person.id), pausedAt: new Date('2026-01-04'), payoutFinalizedAt: now, payoutFinalizedType: 'partial_attorney', partialPayoutAmount: partial, payoutTransferId: transferId }], createdAt: new Date('2026-01-01'), updatedAt: now });
          await Operation.collection.insertOne({ _id: new mongoose.Types.ObjectId(), caseId: _id, kind: 'funding', operationKey: `funding:${_id}:pi_${_id}`, status: 'succeeded', amount: 48800, currency, stripeObjectId: `pi_${_id}`, stripePaymentIntentId: `pi_${_id}`, stripeChargeId: `ch_${_id}`, stripeBalanceTransactionId: `txn_${_id}`, grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, stripeMode: 'test', livemode: false, evidenceVerifiedAt: new Date('2026-01-03'), createdAt: new Date('2026-01-02') });
          await Payout.collection.insertOne({ _id: new mongoose.Types.ObjectId(), caseId: _id, paralegalId: new mongoose.Types.ObjectId(person.id), amountPaid: Math.round(partial * 0.81), transferId, stripeMode: 'test', status: 'paid', createdAt: now });
        }
      },
      async removeFunding(ownerId) {
        if (!owners.has(ownerId)) throw Error('Unknown synthetic owner');
        const rows = await Case.collection.find({ attorney: new mongoose.Types.ObjectId(ownerId) }).toArray();
        await Operation.collection.deleteMany({ caseId: { $in: rows.map(row => row._id) }, kind: 'funding' });
      },
      async evidence(ownerId) {
        if (!owners.has(ownerId)) throw Error('Unknown synthetic owner');
        const cases = await Case.collection.find({ attorney: new mongoose.Types.ObjectId(ownerId) }).sort({ _id: 1 }).toArray(), caseIds = cases.map(row => row._id);
        return JSON.parse(JSON.stringify({ cases, operations: await Operation.collection.find({ caseId: { $in: caseIds } }).sort({ _id: 1 }).toArray(), payouts: await Payout.collection.find({ caseId: { $in: caseIds } }).sort({ _id: 1 }).toArray() }));
      },
    };
  } catch (error) { await close(); throw error; }
};
