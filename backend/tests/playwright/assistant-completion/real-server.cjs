const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const local = name => require(path.join(root, 'node_modules', name));

// Actual support routes, managed authentication, CSRF, transactions and streams.
// Only the model reply and unrelated workspace data are synthetic. No worker or
// external delivery starts in this isolated, private loopback fixture.
module.exports = async function startServer({ frontendRoot, onStartupCleanup } = {}) {
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'assistant-local-managed-secret-at-least-32-bytes', DATA_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4), EMAIL_DISABLE: 'true', ENABLE_CSRF: 'true', OPENAI_API_KEY: '', STRIPE_SECRET_KEY: 'sk_test_assistant_private_fixture' });
  const mongoose = local('mongoose'), express = local('express'), jwt = local('jsonwebtoken');
  const { MongoMemoryReplSet } = local('mongodb-memory-server');
  const User = require(path.join(root, 'models/User'));
  const Conversation = require(path.join(root, 'models/SupportConversation'));
  const Message = require(path.join(root, 'models/SupportMessage'));
  const Mutation = require(path.join(root, 'models/SupportMutation'));
  const Ticket = require(path.join(root, 'models/SupportTicket'));
  const service = require(path.join(root, 'services/support/conversationService'));
  const originalSend = service.createConversationMessage;
  service.createConversationMessage = args => originalSend({ ...args, assistantReplyOverride: { reply: 'Open Settings, then Preferences to update your notification choices.', category: 'general_support', primaryAsk: 'general_support', grounded: true, needsEscalation: false } });
  const supportPath = require.resolve(path.join(root, 'routes/support'));
  delete require.cache[supportPath];
  const support = require(supportPath);
  service.createConversationMessage = originalSend;
  const auth = require(path.join(root, 'routes/auth'));
  const verifyToken = require(path.join(root, 'utils/verifyToken'));
  const { createAuthSession } = require(path.join(root, 'services/authSessionService'));
  const { generateCsrfToken, respondToCsrfError } = require(path.join(root, 'utils/csrf'));
  let replica, listener, stopped = false;
  async function close() {
    stopped = true;
    if (listener) { const current = listener; listener = null; current.closeAllConnections(); await new Promise(resolve => current.close(resolve)); }
    await mongoose.disconnect();
    if (replica) { const current = replica; replica = null; await current.stop({ doCleanup: true, force: true }); }
  }
  onStartupCleanup?.(close);
  const assertStarting = () => { if (stopped) throw Error('Assistant fixture startup canceled'); };
  try {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' }, instanceOpts: [{ launchTimeout: 60000 }] });
    assertStarting();
    await mongoose.connect(replica.getUri('assistant_browser_isolated'), { autoCreate: false, autoIndex: false });
    for (const Model of Object.values(mongoose.models)) { assertStarting(); await Model.init(); await Model.createCollection(); await Model.createIndexes(); }
    mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
    const app = express(); app.use(local('cookie-parser')(), express.json());
    app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    app.get('/api/csrf', (req, res) => res.json({ csrfToken: generateCsrfToken(req, res) }));
    app.use('/api/auth', auth); app.use('/api/support', support);
    app.get('/api/users/me', verifyToken, (req, res) => res.json({ id: String(req.user._id), _id: String(req.user._id), role: req.user.role, status: req.user.status, firstName: req.user.firstName, lastName: req.user.lastName, preferences: req.user.preferences, onboarding: req.user.onboarding }));
    app.use('/api', (req, res) => {
      if (req.path.endsWith('/stream')) return res.status(204).end();
      if (req.method !== 'GET') return res.status(501).json({ error: 'Outside isolated Assistant scope' });
      const empty = { '/paralegal/dashboard': { activeCases: [], completedCases: [] }, '/account/preferences': { theme: 'light', fontSize: 'md' }, '/users/me/onboarding': { onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } } };
      res.json(empty[req.path] || (req.path.includes('unread-count') ? { count: 0 } : req.path === '/notifications/page' ? { items: [], hasMore: false, nextCursor: null } : req.path === '/notifications' ? [] : {}));
    });
    app.use(express.static(frontendRoot, { etag: false }));
    app.use((error, _req, res, _next) => { if (respondToCsrfError(error, res)) return; res.status(error.statusCode || error.status || 500).json({ error: error.message, code: error.code }); });
    listener = await new Promise((resolve, reject) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); value.once('error', reject); });
    assertStarting();
    const origin = `http://127.0.0.1:${listener.address().port}`;
    const owners = new Set();
    return { origin, close,
      async createUser(role) {
        const user = await User.create({ firstName: 'Dana', lastName: 'Reporter', email: `assistant-${crypto.randomUUID()}@example.test`, password: 'Synthetic private assistant password!', role, status: 'approved', emailVerified: true, preferences: { theme: 'light', fontSize: 'md' }, onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true } });
        const record = await createAuthSession(user, { headers: { 'user-agent': 'Synthetic Assistant browser' }, ip: '192.0.2.10' }); owners.add(String(user._id));
        return { id: String(user._id), cookie: { name: 'token', value: jwt.sign({ id: String(user._id), role, status: user.status, sid: record.sessionId, av: user.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2h' }), url: origin, httpOnly: true, sameSite: 'Lax' } };
      },
      async evidence(ownerId) {
        if (!owners.has(ownerId)) throw Error('Unknown synthetic owner');
        const conversations = await Conversation.find({ userId: ownerId }).lean();
        const messages = await Message.find({ conversationId: { $in: conversations.map(row => row._id) } }).lean();
        const receipts = await Mutation.find({ ownerId }).lean();
        return { conversations: conversations.map(row => ({ id: String(row._id), status: row.status })), messages: messages.map(row => ({ id: String(row._id), conversationId: String(row.conversationId), sender: row.sender, text: row.text, metadata: row.metadata })), receipts: receipts.map(row => ({ requestId: row.requestId, action: row.action, state: row.state, active: row.active })), tickets: await Ticket.countDocuments({ userId: ownerId }) };
      },
    };
  } catch (error) { await close(); throw error; }
};
