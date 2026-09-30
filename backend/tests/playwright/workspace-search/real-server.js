const path = require("node:path");
const sourceRoot = path.resolve(process.env.LPC_SEARCH_REAL_SOURCE_ROOT || path.join(__dirname, "../../../.."));
const backend = path.join(sourceRoot, "backend");
const local = name => require(path.join(backend, "node_modules", name));

module.exports = async function startRealSearchServer() {
  // Only synthetic accounts and a private loopback replica. Never import the
  // full application server, environment files or actual provider credentials.
  Object.assign(process.env, {
    NODE_ENV: "test", JWT_SECRET: "search-real-synthetic-jwt-secret-at-least-32-bytes",
    DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    EMAIL_DISABLE: "true", ENABLE_CSRF: "false", REQUIRE_AUTH_SESSION: "true",
    STRIPE_SECRET_KEY: "sk_test_synthetic_search_no_provider", S3_BUCKET: "synthetic-search-no-provider",
  });
  const mongoose = local("mongoose"), express = local("express"), jwt = local("jsonwebtoken");
  const { MongoMemoryReplSet } = local("mongodb-memory-server");
  const User = require(path.join(backend, "models/User"));
  const Case = require(path.join(backend, "models/Case"));
  const AuthSession = require(path.join(backend, "models/AuthSession"));
  const { createAuthSession } = require(path.join(backend, "services/authSessionService"));
  const verifyToken = require(path.join(backend, "utils/verifyToken"));
  const authRouter = require(path.join(backend, "routes/auth"));
  const casesRouter = require(path.join(backend, "routes/cases"));
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: "127.0.0.1" }, instanceOpts: [{ launchTimeout: 60000 }] });
  await mongoose.connect(replica.getUri(`search_browser_${process.pid}`), { autoCreate: false, autoIndex: false });
  for (const Model of Object.values(mongoose.models)) { await Model.init(); await Model.createCollection(); await Model.createIndexes(); }
  mongoose.connection.config.autoCreate = true; mongoose.connection.config.autoIndex = true;
  const state = { requests: [], unknownApi: [], gate: null, failSource: false };
  const aggregate = Case.aggregate;
  Case.aggregate = function (...args) {
    if (state.failSource) { state.failSource = false; throw new Error("Synthetic search source failure"); }
    return aggregate.apply(this, args);
  };
  const app = express(); app.use(local("cookie-parser")(), express.json());
  app.use(async (req, _res, next) => {
    if (req.path.startsWith("/api/")) state.requests.push({ path: req.path, method: req.method, query: { ...req.query } });
    if (state.gate && req.method === "GET" && req.path === state.gate.path) {
      const gate = state.gate; state.gate = null; gate.arrived = true; await gate.promise;
    }
    next();
  });
  app.use("/api/auth", authRouter);
  app.use("/api/cases", (req, res, next) => req.path === "/search" ? casesRouter(req, res, next) : next());
  // All remaining API responses are explicitly ancillary shell fixtures. This
  // harness proves Search/auth integration, not CSRF, payments, Help or SSE.
  app.get("/api/csrf", (_req, res) => res.json({ csrfToken: "synthetic-search-csrf" }));
  app.use("/api", verifyToken, async (req, res) => {
    const user = await User.findById(req.user.id).select("firstName lastName role status preferences onboarding state").lean();
    if (["/jobs/stream", "/notifications/stream"].includes(req.path)) {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders(); res.write(": synthetic empty discovery stream\n\n"); return;
    }
    const fixtures = {
      "/users/me": { ...user, id: String(user._id) }, "/users/me/onboarding": { onboarding: user.onboarding },
      "/account/preferences": user.preferences, "/paralegal/dashboard": { activeCases: [], completedCases: [] },
      "/payments/connect/status": { readiness: { ready: true, accountPresent: true, evidenceState: "verified" } },
      "/messages/unread-count": { count: 0 }, "/messages/threads": { items: [] },
      "/support/conversation": { conversation: { id: "synthetic-search-support", status: "open" }, messages: [] },
      "/notifications/unread-count": { count: 0 }, "/notifications/page": { items: [], hasMore: false, nextCursor: null }, "/notifications": [],
      "/jobs/recommended": [], "/jobs/open": [], "/applications/my": [], "/cases/invited-to": [],
      "/jobs/discovery-version": { version: "synthetic-empty-search-discovery" }, "/cases/my-completed": { items: [] }, "/events": { items: [] },
    };
    if (!Object.hasOwn(fixtures, req.path)) { state.unknownApi.push(req.path); return res.status(404).json({ error: "No ancillary fixture for this endpoint" }); }
    return res.json(fixtures[req.path]);
  });
  app.use(express.static(path.join(sourceRoot, "frontend")));
  app.use((_error, _req, res, _next) => res.status(500).json({ error: "Search is unavailable" }));
  const http = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  const origin = `http://127.0.0.1:${http.address().port}`;
  const id = () => new mongoose.Types.ObjectId();
  async function actor(name, role) {
    const user = await User.create({ firstName: "Synthetic", lastName: name, email: `${name}@search-real.test`, password: "Synthetic search managed password", role, status: "approved", state: "CA", onboarding: { attorneyTourCompleted: true, paralegalTourCompleted: true, paralegalProfileTourCompleted: true }, preferences: { theme: "light", fontSize: "md" } });
    const { sessionId } = await createAuthSession(user, {});
    const token = jwt.sign({ id: String(user._id), sid: sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    return { id: String(user._id), sessionId, user, cookie: { name: "token", value: token, url: origin, httpOnly: true, sameSite: "Lax" } };
  }
  return {
    origin, state,
    async reset(role) {
      const collections = Object.values(mongoose.connection.collections);
      for (let i = 0; i < collections.length; i += 6) await Promise.all(collections.slice(i, i + 6).map(collection => collection.deleteMany({})));
      state.requests = []; state.unknownApi = []; state.gate = null; state.failSource = false;
      const owner = await actor("Owner", role), other = await actor("Other", role), attorney = role === "attorney" ? owner : await actor("Employer", "attorney");
      const matter = (overrides = {}) => ({ _id: id(), attorney: attorney.user._id, attorneyId: attorney.user._id, status: "open", title: "Evergreen Research", practiceArea: "Civil Litigation", details: "PRIVATE_SEARCH_DETAILS", totalAmount: 123456, currency: "usd", createdAt: new Date("2020-01-01"), updatedAt: new Date("2020-01-01"), ...(role === "paralegal" ? { status: "in progress", paralegalId: owner.user._id } : {}), ...overrides });
      const exact = matter(), discovery = matter({ title: "Evergreen Research opportunity", status: "open", paralegalId: null, paralegal: null });
      const privateMatter = matter({ title: "Evergreen Research PRIVATE_OTHER_SEARCH", attorney: role === "attorney" ? other.user._id : attorney.user._id, attorneyId: role === "attorney" ? other.user._id : attorney.user._id, status: "in progress", paralegalId: null, paralegal: null, updatedAt: new Date("2040-01-01") });
      await Case.collection.insertMany([exact, discovery, privateMatter, ...Array.from({ length: 160 }, (_, index) => matter({ title: `Research Evergreen extension ${index}`, updatedAt: new Date(2030, 0, 1, 0, 0, index) }))]);
      const profile = { _id: id(), firstName: "Evergreen", lastName: "Research", email: "public-profile@search-real.test", role: "paralegal", status: "approved", bio: "Public search profile", resumeURL: "https://example.test/synthetic-resume", skills: ["Review"], practiceAreas: ["Civil Litigation"], specialties: ["Research"], profilePhotoStatus: "approved", profileImage: "https://example.test/synthetic-photo", pendingProfileImage: "", updatedAt: new Date("2020-01-01") };
      await User.collection.insertMany([profile, ...Array.from({ length: 80 }, (_, index) => ({ ...profile, _id: id(), email: `profile-${index}@search-real.test`, firstName: "Research", lastName: `Evergreen ${index}`, updatedAt: new Date("2030-01-01") }))]);
      return { owner, other, exactId: String(exact._id), discoveryId: String(discovery._id), privateId: String(privateMatter._id), profileId: String(profile._id) };
    },
    holdNext(pathname) {
      let release; const gate = { path: pathname, arrived: false, promise: new Promise(resolve => { release = resolve; }) };
      state.gate = gate; return { get arrived() { return gate.arrived; }, release };
    },
    async revoke(account) { await AuthSession.updateOne({ sessionId: account.sessionId }, { $set: { revokedAt: new Date() } }); },
    async evidence() { return { cases: await Case.countDocuments(), requests: state.requests, unknownAncillaryApi: state.unknownApi }; },
    async close() {
      Case.aggregate = aggregate; http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
      await mongoose.disconnect(); await replica.stop({ doCleanup: true, force: true });
    },
  };
};
