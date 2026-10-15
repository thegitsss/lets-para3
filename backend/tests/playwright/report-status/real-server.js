const path = require("node:path");
const crypto = require("node:crypto");
const sourceRoot = path.resolve(process.env.LPC_REPORT_REAL_SOURCE_ROOT || path.join(__dirname, "../../../.."));
const backend = path.join(sourceRoot, "backend");
const local = name => require(path.join(backend, "node_modules", name));

module.exports = async function startRealReportServer() {
  // A unique temporary replica and synthetic accounts. Never load application
  // environment files, the full server or provider credentials.
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "report-status-local-jwt-secret-at-least-32-bytes";
  process.env.DATA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.EMAIL_DISABLE = "true";
  process.env.ENABLE_CSRF = "false";
  const mongoose = local("mongoose"), express = local("express"), jwt = local("jsonwebtoken");
  const { MongoMemoryReplSet } = local("mongodb-memory-server");
  const User = require(path.join(backend, "models/User"));
  const Incident = require(path.join(backend, "models/Incident"));
  const IncidentEvent = require(path.join(backend, "models/IncidentEvent"));
  const Notification = require(path.join(backend, "models/Notification"));
  const { createAuthSession } = require(path.join(backend, "services/authSessionService"));
  const verifyToken = require(path.join(backend, "utils/verifyToken"));
  const authRouter = require(path.join(backend, "routes/auth"));
  const incidentsRouter = require(path.join(backend, "routes/incidents"));
  const notificationsRouter = require(path.join(backend, "routes/notifications"));
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" }, instanceOpts: [{ launchTimeout: 60000 }] });
  await mongoose.connect(replica.getUri(`report_browser_${process.pid}`), { autoCreate: false, autoIndex: false });
  for (const Model of Object.values(mongoose.models)) { await Model.init(); await Model.createCollection(); await Model.createIndexes(); }
  mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
  const state = { requests: [], unknownApi: [], gate: null };
  const app = express();
  app.use(local("cookie-parser")(), express.json());
  app.use(async (req, _res, next) => {
    if (req.path.startsWith("/api/")) state.requests.push({ path: req.path, method: req.method, query: { ...req.query } });
    if (state.gate && req.method === "GET" && req.path === state.gate.path) {
      const gate = state.gate; state.gate = null; gate.arrived = true;
      await gate.promise;
    }
    next();
  });
  app.use("/api/auth", authRouter);
  app.use("/api/incidents", incidentsRouter);
  app.use("/api/notifications", notificationsRouter);
  // Explicit ancillary shell fixtures; these are not payment/support/provider
  // integrations. The auth, notification and incident paths above are real.
  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "synthetic-report-status-csrf" }));
  app.use("/api", verifyToken, async (req, res) => {
    const user = await User.findById(req.user.id).select("firstName lastName role status preferences onboarding state").lean();
    if (req.path === "/jobs/stream") {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders();
      res.write(": synthetic empty Matter discovery stream\n\n");
      return;
    }
    const fixtures = {
      "/users/me": { ...user, id: String(user._id) },
      "/users/me/onboarding": { onboarding: user.onboarding },
      "/account/preferences": user.preferences,
      "/paralegal/dashboard": { activeCases: [], completedCases: [] },
      "/payments/connect/status": { readiness: { ready: true, accountPresent: true, evidenceState: "verified" } },
      "/messages/unread-count": { count: 0 },
      "/messages/threads": { items: [] },
      "/support/conversation": { conversation: { id: "synthetic-report-support", status: "open" }, messages: [] },
      "/jobs/recommended": [], "/jobs/open": [], "/applications/my": [], "/cases/invited-to": [],
      "/jobs/discovery-version": { version: "synthetic-empty-matter-discovery" },
      "/cases/my-completed": { items: [] }, "/events": { items: [] },
    };
    if (!Object.hasOwn(fixtures, req.path)) { state.unknownApi.push(req.path); return res.status(404).json({ error: "No ancillary fixture for this endpoint" }); }
    return res.json(fixtures[req.path]);
  });
  app.use(express.static(path.join(sourceRoot, "frontend")));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message || "Synthetic server error" }));
  const http = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const origin = `http://127.0.0.1:${http.address().port}`;

  async function actor(name, role) {
    const user = await User.create({ firstName: "Synthetic", lastName: name, email: `${name}@report-status.test`, password: "SyntheticReport123!", role, status: "approved", state: "CA", onboarding: { paralegalTourCompleted: true, paralegalProfileTourCompleted: true }, preferences: { theme: "light", fontSize: "md" } });
    const { sessionId } = await createAuthSession(user, {});
    const token = jwt.sign({ id: String(user._id), role, av: Number(user.authVersion || 0), sid: sessionId }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return { id: String(user._id), user, cookie: { name: "token", value: token, url: origin, httpOnly: true, sameSite: "Lax" } };
  }
  async function createReport(owner, summary) {
    const response = await fetch(`${origin}/api/incidents`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `token=${owner.cookie.value}` }, body: JSON.stringify({ requestId: crypto.randomUUID(), reporterId: owner.id, summary, description: "Synthetic report details for isolated acceptance.", routePath: `/${owner.user.role}-v2.html`, featureKey: "help" }) });
    if (response.status !== 201) throw new Error(`Synthetic intake failed: ${response.status} ${await response.text()}`);
    const payload = await response.json(); return payload.incident;
  }
  return {
    origin, state,
    async reset(role, { seed = true } = {}) {
      const collections = Object.values(mongoose.connection.collections);
      for (let i = 0; i < collections.length; i += 6) await Promise.all(collections.slice(i, i + 6).map(collection => collection.deleteMany({})));
      state.requests = []; state.unknownApi = [];
      const owner = await actor("Owner", role), other = await actor("Other", role);
      if (!seed) return { owner, other };
      const report = await createReport(owner, "The practice area filter does not update available Matters");
      const unrelated = await createReport(other, "PRIVATE_OTHER_REPORT");
      const doc = await Incident.findOne({ publicId: report.publicId });
      await IncidentEvent.insertMany(Array.from({ length: 104 }, (_, i) => ({ incidentId: doc._id, seq: i + 2, eventType: "state_changed", actor: { type: "system", role: "system" }, summary: "PRIVATE_INTERNAL_EVENT", toState: ["investigating", "awaiting_verification", "reported"][i % 3], detail: { internal: "PRIVATE_INTERNAL_DETAIL" }, createdAt: new Date(Date.now() + (i + 1) * 60000) })));
      await Incident.updateOne({ _id: doc._id }, { $set: { state: "investigating", userVisibleStatus: "investigating", lastEventSeq: 105 } });
      await Notification.create({ userId: owner.id, type: "incident_update", message: "PRIVATE_MISADDRESSED_UPDATE", payload: { incidentPublicId: unrelated.publicId, status: "received" } });
      const notification = await Notification.findOne({ userId: owner.id, type: "incident_update", "payload.incidentPublicId": report.publicId });
      return { owner, other, report, unrelated, notificationId: String(notification._id) };
    },
    holdNext(pathname) {
      let release;
      const gate = { path: pathname, arrived: false, promise: new Promise(resolve => { release = resolve; }) };
      state.gate = gate;
      return { get arrived() { return gate.arrived; }, release };
    },
    async notification(id) { return Notification.findById(id).lean(); },
    async evidence() {
      return { incidents: await Incident.countDocuments(), notifications: await Notification.countDocuments(), events: await IncidentEvent.countDocuments(), requests: state.requests, unknownAncillaryApi: state.unknownApi };
    },
    async close() {
      http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
      await mongoose.disconnect(); await replica.stop({ doCleanup: true, force: true });
    },
  };
};
