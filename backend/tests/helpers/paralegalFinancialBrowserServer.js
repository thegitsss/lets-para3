const path = require('node:path'), crypto = require('node:crypto');

// Actual financial readers, managed sessions and PDF renderer, isolated from
// application startup, environment files, real mail and payment providers.
module.exports = async function start({ port = 5874, calendar = false, workspace = false } = {}) {
  const origin = `http://127.0.0.1:${port}`, backend = path.resolve(__dirname, '../..');
  Object.assign(process.env, { NODE_ENV: 'test', APP_ENV: 'test', JWT_SECRET: 'synthetic-paralegal-financial-browser-secret', STRIPE_SECRET_KEY: 'sk_test_synthetic_paralegal_financial', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_paralegal_financial', DATA_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123', EMAIL_DISABLE: 'true', ENABLE_CSRF: 'false', APP_BASE_URL: origin, FRONTEND_BASE_URL: origin, OPENAI_API_KEY: '', S3_BUCKET: '', AWS_EC2_METADATA_DISABLED: 'true' });
  const mail = [], provider = [], requests = [], owners = new Set(), matters = new Set();
  const emailPath = require.resolve('../../utils/email');
  require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: async () => { mail.push('unexpected email'); throw new Error('Financial reader must not send email'); } };
  const stripe = require('../../utils/stripe');
  for (const resource of ['accounts', 'customers', 'paymentIntents', 'charges', 'transfers', 'refunds', 'balanceTransactions']) {
    for (const method of ['retrieve', 'create', 'list', 'update', 'cancel', 'createReversal']) if (typeof stripe[resource]?.[method] === 'function') stripe[resource][method] = async () => { provider.push(`${resource}.${method}`); throw new Error('Financial reader must not call a provider'); };
  }
  const express = require('express'), mongoose = require('mongoose'), jwt = require('jsonwebtoken');
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const User = require('../../models/User'), Case = require('../../models/Case'), Payout = require('../../models/Payout'), Operation = require('../../models/PaymentOperation'), AuthSession = require('../../models/AuthSession');
  const { createAuthSession } = require('../../services/authSessionService');
  const routes = { auth: require('../../routes/auth'), users: require('../../routes/users'), cases: require('../../routes/cases'), dashboard: require('../../routes/paralegalDashboard'), payments: require('../../routes/payments') };
  if (calendar) routes.events = require('../../routes/events');
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' }, instanceOpts: [{ launchTimeout: 60000 }] });
  let listener;
  try {
  await mongoose.connect(replica.getUri('paralegal_financial_browser'), { autoCreate: false, autoIndex: false });
  for (const Model of Object.values(mongoose.models)) { await Model.init(); await Model.createCollection(); await Model.createIndexes(); }
  const app = express(); app.use(require('cookie-parser')(), express.json());
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store'); requests.push({ method: req.method, path: req.path });
    if ((calendar || workspace) && req.method === 'GET' && req.path === '/csrf') return res.json({ csrfToken: 'synthetic-private-calendar' });
    if (calendar && (req.method === 'GET' && /^\/events\/paralegal\/matters\/[a-f0-9]{24}\/review$/.test(req.path) || req.method === 'POST' && /^\/events\/paralegal\/matters\/[a-f0-9]{24}\/reviewed-action$/.test(req.path))) return next();
    if (workspace && req.method === 'GET' && (/^\/cases\/[a-f0-9]{24}\/notes$/.test(req.path) || req.path === '/cases/assigned-choices')) return next();
    if (workspace && req.method === 'PUT' && /^\/cases\/[a-f0-9]{24}\/notes$/.test(req.path)) return next();
    if (req.method !== 'GET') return res.status(501).json({ error: 'Financial browser evidence permits reads only' });
    if (['/auth/me', '/users/me', '/cases/my', '/cases/my-completed', '/cases/workspace-choices', '/paralegal/dashboard'].includes(req.path) || /^\/cases\/[a-f0-9]{24}$/.test(req.path) || /^\/payments\/receipt\/(?:paralegal\/[a-f0-9]{24}|attorney\/[a-f0-9]{24}(?:\/(?:history|review))?)$/.test(req.path)) return next();
    if (req.path.endsWith('/stream')) return res.type('text/event-stream').send(': synthetic financial stream\n\n');
    if (req.path === '/payments/connect/status') return res.json({ readiness: { ready: true, evidenceState: 'verified' } });
    if (req.path === '/messages/unread-count') return res.json({ count: 0 });
    if (req.path === '/messages/threads') return res.json({ threads: [], total: 0, pages: 0 });
    if (req.path === '/applications/my' || req.path === '/notifications') return res.json([]);
    return res.json({ items: [], views: [], total: 0, pages: 0, hasMore: false, nextCursor: null });
  });
  app.use('/api/auth', routes.auth); app.use('/api/users', routes.users); app.use('/api/cases', routes.cases); app.use('/api/paralegal/dashboard', routes.dashboard); app.use('/api/payments', routes.payments);
  if (calendar) app.use('/api/events', routes.events);
  for (const [url, file] of [['simplewebauthn-13.3.0.js', '@simplewebauthn/browser/dist/bundle/index.umd.min.js'], ['web-vitals-6.1.1.js', 'web-vitals/dist/web-vitals.js'], ['chart-4.5.1.js', 'chart.js/dist/chart.umd.js']]) app.get(`/assets/vendor/${url}`, (_req, res) => res.type('application/javascript').sendFile(path.join(backend, 'node_modules', file)));
  app.use(express.static(require('../../utils/frontendAssets').frontendDirectory(), { etag: false }));
  app.use((error, _req, res, _next) => res.status(error.status || error.statusCode || 500).json({ error: 'Synthetic financial request failed', code: error.publicCode || error.code }));
  listener = await new Promise((resolve, reject) => { const server = app.listen(port, '127.0.0.1', () => resolve(server)); server.on('error', reject); });
  const owned = id => { if (!owners.has(String(id))) throw new Error('Unknown synthetic account'); };
  async function createUser(role = 'paralegal') {
    const user = await User.create({ firstName: 'Synthetic', lastName: role, email: `${crypto.randomUUID()}@financial-browser.test`, password: 'Private synthetic financial passphrase', role, status: 'approved', emailVerified: true, stateExperience: ['New York'], practiceAreas: ['Civil Litigation'], yearsExperience: 6, preferences: { theme: 'light', fontSize: 'md' }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } });
    owners.add(String(user._id)); const session = await createAuthSession(user, { headers: { 'user-agent': 'Synthetic financial browser' }, ip: '192.0.2.22' });
    return { id: String(user._id), cookie: { name: 'token', value: jwt.sign({ id: String(user._id), role, status: 'approved', sid: session.sessionId, av: 0 }, process.env.JWT_SECRET, { expiresIn: '2h' }), url: origin, httpOnly: true, sameSite: 'Lax' } };
  }
  return {
    origin, createUser,
    async seed({ samePayee = false, workspaceDetails = false } = {}) {
      const para = await createUser(), attorney = await createUser('attorney'), former = await createUser();
      const at = new Date('2026-09-01T12:00:00Z'), later = new Date('2026-09-04T12:00:00Z'), key = crypto.randomUUID().replaceAll('-', '');
      const previous = { withdrawnParalegalId: para.id, partialPayoutAmount: 10000, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', payoutTransferId: `tr_${key}`, pausedAt: new Date(at.getTime() - 1000) };
      const history = await Case.create({ title: 'River Street retained assignment', details: 'Private synthetic financial history.', attorney: attorney.id, attorneyId: attorney.id, status: 'paused', pausedReason: 'paralegal_withdrew', withdrawnParalegalId: para.id, partialPayoutAmount: 0, payoutFinalizedAt: later, payoutFinalizedType: 'zero_auto', pausedAt: later, payoutTransferId: '', withdrawalHistory: [previous], totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 30000, feeParalegalPct: 18, currency: 'usd', stripeMode: 'test' });
      const retainedPayout = await Payout.create({ caseId: history._id, paralegalId: para.id, operationKey: `partial_payout:${history._id}:first`, amountPaid: 8100, transferId: previous.payoutTransferId, status: 'paid', stripeMode: 'test', createdAt: at });
      await Operation.create({ caseId: history._id, operationKey: retainedPayout.operationKey, fingerprint: key, kind: 'partial_payout', amount: 8100, transferAmount: 8100, currency: 'usd', status: 'succeeded', stripeTransferId: previous.payoutTransferId, stripeObjectId: previous.payoutTransferId, stripeMode: 'test' });
      const activeKey = crypto.randomUUID().replaceAll('-', ''), active = await Case.create({ title: 'Remaining assignment', details: 'Private funded replacement.', attorney: attorney.id, attorneyId: attorney.id, paralegal: para.id, paralegalId: para.id, status: 'in progress', archived: false, paymentReleased: false, payoutStatus: 'not_started', totalAmount: 40000, lockedTotalAmount: 40000, remainingAmount: 30000, feeParalegalPct: 18, feeAttorneyPct: 22, feeAttorneyAmount: 8800, currency: 'usd', stripeMode: 'test', escrowStatus: 'funded', fundingIntegrityStatus: 'verified', escrowIntentId: `pi_${activeKey}`, paymentIntentId: `pi_${activeKey}`, hiredAt: later, withdrawalHistory: [{ withdrawnParalegalId: samePayee ? para.id : former.id, partialPayoutAmount: 10000, payoutFinalizedAt: at, payoutFinalizedType: 'partial_attorney', payoutTransferId: `tr_${activeKey}`, pausedAt: at }] });
      await Payout.create({ caseId: active._id, paralegalId: samePayee ? para.id : former.id, operationKey: `partial_payout:${active._id}:first`, amountPaid: samePayee ? 8100 : 8200, transferId: `tr_${activeKey}`, status: 'paid', stripeMode: 'test', createdAt: at });
      await Operation.create({ caseId: active._id, operationKey: `partial_payout:${active._id}:first`, fingerprint: activeKey, kind: 'partial_payout', amount: samePayee ? 8100 : 8200, transferAmount: samePayee ? 8100 : 8200, currency: 'usd', status: 'succeeded', stripeTransferId: `tr_${activeKey}`, stripeObjectId: `tr_${activeKey}`, stripeMode: 'test' });
      await Operation.create({ caseId: active._id, operationKey: `funding:${active._id}:pi_${activeKey}`, fingerprint: activeKey, kind: 'funding', amount: 48800, currency: 'usd', status: 'succeeded', stripePaymentIntentId: `pi_${activeKey}`, stripeObjectId: `pi_${activeKey}`, stripeChargeId: `ch_${activeKey}`, stripeBalanceTransactionId: `txn_${activeKey}`, grossAmount: 48800, processingFeeAmount: 1400, netAmount: 47400, stripeMode: 'test', livemode: false, evidenceVerifiedAt: at });
      matters.add(String(history._id)); matters.add(String(active._id));
      if (workspaceDetails) await Case.collection.updateOne({ _id: active._id }, { $set: {
        title: 'Discovery responses for the River Street commercial lease and retained exhibits',
        details: 'Review the discovery responses and organize the supporting exhibits.\n\nKeep the original exhibit names and identify any missing references for attorney review.',
        practiceArea: 'Civil Litigation', state: 'New York', deadlineDate: '2026-09-30',
        tasks: [{ title: 'Review the discovery responses', completed: false }, { title: 'Organize supporting exhibits', completed: true }],
      } });
      return { para, attorney, historyId: String(history._id), activeId: String(active._id), payoutId: String(retainedPayout._id) };
    },
    async updateWork(caseId) { if (!matters.has(caseId)) throw new Error('Unknown synthetic Matter'); await Case.collection.updateOne({ _id: new mongoose.Types.ObjectId(caseId) }, { $set: { tasks: [{ title: 'Reviewed synthetic work', completed: true }], updatedAt: new Date(Date.now() + 2000) } }); },
    async restrictMatter(caseId) { if (!matters.has(caseId)) throw new Error('Unknown synthetic Matter'); await Case.collection.updateOne({ _id: new mongoose.Types.ObjectId(caseId) }, { $set: { paralegalAccessRevokedAt: new Date() } }); },
    async reverse(caseId) { if (!matters.has(caseId)) throw new Error('Unknown synthetic Matter'); await Payout.updateMany({ caseId }, { $set: { status: 'reversed' } }); },
    async revoke(cookie) { const value = jwt.verify(cookie.value, process.env.JWT_SECRET); owned(value.id); await AuthSession.updateOne({ sessionId: value.sid }, { $set: { revokedAt: new Date() } }); },
    async inspect(caseId) { if (!matters.has(caseId)) throw new Error('Unknown synthetic Matter'); return { case: await Case.collection.findOne({ _id: new mongoose.Types.ObjectId(caseId) }), payouts: await Payout.collection.find({ caseId: new mongoose.Types.ObjectId(caseId) }).toArray(), operations: await Operation.collection.find({ caseId: new mongoose.Types.ObjectId(caseId) }).toArray() }; },
    async seedReminders(caseId, ownerId, count = 225) {
      if (!calendar || !matters.has(caseId)) throw new Error('Unknown synthetic calendar'); owned(ownerId);
      const Event = require('../../models/Event');
      await Case.updateOne({ _id: caseId }, { $set: { deadlineDate: '2026-09-30', deadline: new Date('2026-09-30T12:00:00.000Z') } });
      const records = await Event.insertMany(Array.from({ length: count }, (_, index) => ({ owner: ownerId, caseId, title: `Private reminder ${index + 1}`, start: new Date('2026-09-23T12:00:00.000Z'), end: new Date('2026-09-23T12:00:00.000Z'), type: 'deadline', isAllDay: true, visibility: 'private', timezone: 'America/New_York' })));
      return records.map(value => String(value._id));
    },
    async inspectReminders(caseId, ownerId) {
      if (!calendar || !matters.has(caseId)) throw new Error('Unknown synthetic calendar'); owned(ownerId);
      const Event = require('../../models/Event'), AuditLog = require('../../models/AuditLog');
      return { events: await Event.collection.find({ caseId: new mongoose.Types.ObjectId(caseId), owner: new mongoose.Types.ObjectId(ownerId) }).sort({ start: 1, _id: 1 }).toArray(), actions: await AuditLog.collection.find({ case: new mongoose.Types.ObjectId(caseId), actor: new mongoose.Types.ObjectId(ownerId), 'meta.kind': 'paralegal_calendar_action' }).toArray() };
    },
    evidence: () => ({ mail: [...mail], provider: [...provider], financialRequests: requests.filter(value => /my-completed|paralegal\/dashboard|payments\/receipt|^\/cases\/[a-f0-9]{24}$/.test(value.path)), ...(calendar ? { calendarRequests: requests.filter(value => value.path.startsWith('/events/')) } : {}), ...(workspace ? { noteRequests: requests.filter(value => /^\/cases\/[a-f0-9]{24}\/notes$/.test(value.path)) } : {}) }),
    async close() { listener.closeAllConnections?.(); await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); await mongoose.disconnect(); await replica.stop({ doCleanup: true, force: true }); },
  };
  } catch (error) {
    if (listener?.listening) { listener.closeAllConnections?.(); await new Promise(resolve => listener.close(resolve)); }
    await mongoose.disconnect(); await replica.stop({ doCleanup: true, force: true }); throw error;
  }
};
