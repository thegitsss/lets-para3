const path = require('path');
const root = path.resolve(__dirname, '../../../../backend');
const local = name => require(path.join(root, 'node_modules', name));
module.exports = async function startHelpEvidenceServer({ reporterId = '', frontendRoot = '', role = 'paralegal' } = {}) {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'help-evidence-local-jwt-secret-at-least-32-bytes';
  process.env.DATA_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.EMAIL_DISABLE = 'true'; process.env.ENABLE_CSRF = 'false';
  process.env.REQUIRE_AUTH_SESSION = 'true';
  const mongoose = local('mongoose'), express = local('express'), jwt = local('jsonwebtoken');
  const { MongoMemoryReplSet } = local('mongodb-memory-server');
  const User = require(path.join(root, 'models/User'));
  const Incident = require(path.join(root, 'models/Incident'));
  const IncidentArtifact = require(path.join(root, 'models/IncidentArtifact'));
  const IncidentEvent = require(path.join(root, 'models/IncidentEvent'));
  const IncidentNotification = require(path.join(root, 'models/IncidentNotification'));
  const Notification = require(path.join(root, 'models/Notification'));
  const { LpcEvent } = require(path.join(root, 'models/LpcEvent'));
  const { createAuthSession } = require(path.join(root, 'services/authSessionService'));
  const router = require(path.join(root, 'routes/incidents'));
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' }, instanceOpts: [{ launchTimeout: 60000 }] });
  await mongoose.connect(replica.getUri('help_browser_isolated'), { autoCreate: false, autoIndex: false });
  for (const Model of Object.values(mongoose.models)) { await Model.init(); await Model.createCollection(); await Model.createIndexes(); }
  mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
  const reporter = await User.create({ ...(reporterId ? { _id: reporterId } : {}), firstName: 'Pat', lastName: 'Reporter', email: 'help-browser@example.test', password: 'Password123!', role, status: 'approved', state: 'CA' });
  const session = await createAuthSession(reporter, { headers: { 'user-agent': 'Synthetic Help browser' }, ip: '192.0.2.23' });
  const token = jwt.sign({ id: String(reporter._id), role, status: 'approved', email: reporter.email, sid: session.sessionId, av: reporter.authVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '2h' });
  const app = express(); app.use(local('cookie-parser')()); app.use(express.json());
  app.use('/api/incidents', router);
  if (frontendRoot) app.use(express.static(frontendRoot));
  app.use((_error, _req, res, _next) => res.status(500).send('Server error'));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, reporterId: String(reporter._id), cookie: { name: 'token', value: token, url: origin, httpOnly: true, sameSite: 'Lax' },
    async getEvidence() { return { incidents: await Incident.countDocuments(), artifacts: await IncidentArtifact.countDocuments(), timelineEvents: await IncidentEvent.countDocuments(), incidentReceipts: await IncidentNotification.countDocuments(), appNotifications: await Notification.countDocuments(), lpcCreatedEvents: await LpcEvent.countDocuments({ eventType: 'incident.created' }), references: (await Incident.find().select('publicId reporter.userId source context').lean()).map(value => ({ publicId: value.publicId, reporterId: String(value.reporter.userId), source: value.source, routePath: value.context.routePath })) }; },
    async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await mongoose.disconnect(); await replica.stop({ doCleanup: true, force: true }); },
  };
};
