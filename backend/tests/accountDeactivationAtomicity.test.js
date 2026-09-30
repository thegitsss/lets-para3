const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mockReadiness = jest.fn();
jest.mock("../utils/email", () => Object.assign(jest.fn(async () => ({})), { sendAccountDeactivatedEmail: jest.fn(async () => ({})) }));
jest.mock("../services/paralegalReadinessService", () => ({ ...jest.requireActual("../services/paralegalReadinessService"), resolveLivePayoutReadiness: (...args) => mockReadiness(...args) }));
const User = require("../models/User");
const Case = require("../models/Case");
const Job = require("../models/Job");
const Application = require("../models/Application");
const AuthSession = require("../models/AuthSession");
const AuthChallenge = require("../models/AuthChallenge");
const { addSubscriber } = require("../utils/caseEvents");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const app = express();
app.use(cookieParser(), express.json());
app.use("/api/account", require("../routes/account"));
app.use("/api/jobs", require("../routes/jobs"));
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: error.message }));

beforeAll(connect, 240000);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); mockReadiness.mockReset(); });
afterEach(() => jest.restoreAllMocks());

async function fixture(role) {
  const attorney = await User.create({ firstName: "Synthetic", lastName: "Attorney", email: "closure-attorney@example.test", password: "Password123!", role: "attorney", status: "approved", state: "CA" });
  const paralegal = await User.create({ firstName: "Synthetic", lastName: "Paralegal", email: "closure-paralegal@example.test", password: "Password123!", role: "paralegal", status: "approved", state: "CA" });
  const owner = role === "attorney" ? attorney : paralegal;
  const matter = await Case.create({ title: "Unfunded synthetic posting", details: "Prepare the exhibits for review.", practiceArea: "probate", attorney: attorney._id, attorneyId: attorney._id, paralegal: paralegal._id, paralegalId: paralegal._id, status: "open", escrowStatus: "awaiting_funding", paymentStatus: "pending", totalAmount: 30000, currency: "usd", applicants: [{ paralegalId: paralegal._id, status: "accepted" }], invites: [{ paralegalId: paralegal._id, status: "accepted", invitedAt: new Date() }] });
  const job = await Job.create({ attorneyId: attorney._id, caseId: matter._id, title: matter.title, description: matter.details, practiceArea: "probate", budget: 300, status: "open", applicantsCount: 1 });
  const application = await Application.create({ jobId: job._id, paralegalId: paralegal._id, status: "submitted", coverLetter: "I can prepare the exhibits for review." });
  const session = await AuthSession.create({ userId: owner._id, sessionId: `closure-${role}`, expiresAt: new Date(Date.now() + 600000) });
  const challenge = await AuthChallenge.create({ userId: owner._id, challengeId: `closure-${role}`, purpose: "totp_enrollment", challenge: "synthetic-challenge", expiresAt: new Date(Date.now() + 600000) });
  const token = jwt.sign({ id: String(owner._id), role, status: "approved", sid: session.sessionId, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { owner, matter, job, application, session, challenge, close: () => request(app).delete("/api/account/deactivate").set("Cookie", `token=${token}`) };
}

async function state(f) {
  const [owner, matter, job, application, session, challenge] = await Promise.all([
    User.findById(f.owner._id).select("+authVersion").lean(), Case.findById(f.matter._id).lean(), Job.findById(f.job._id).lean(), Application.findById(f.application._id).lean(), AuthSession.findById(f.session._id).lean(), AuthChallenge.findById(f.challenge._id).lean(),
  ]);
  return { deleted: owner.deleted, disabled: owner.disabled, authVersion: owner.authVersion || 0, matterStatus: matter.status, archived: matter.archived, paralegalId: String(matter.paralegalId || ""), applicantStatus: matter.applicants[0].status, inviteStatus: matter.invites[0].status, jobStatus: job.status, applicationStatus: application.status, sessionRevoked: !!session.revokedAt, challengePresent: !!challenge };
}

test.each(["attorney", "paralegal"].flatMap(role => ["user-save", "challenge-cleanup"].map(failure => [role, failure])))("%s closure rolls back every persisted change and event on %s failure", async (role, failure) => {
  const f = await fixture(role), before = await state(f), events = [];
  const stop = addSubscriber(f.matter._id, { write: value => events.push(String(value)) });
  if (failure === "user-save") {
    const original = User.prototype.save;
    jest.spyOn(User.prototype, "save").mockImplementation(function (...args) {
      if (String(this._id) === String(f.owner._id) && this.deleted) return Promise.reject(new Error("Synthetic final User write failure"));
      return original.apply(this, args);
    });
  } else {
    jest.spyOn(AuthChallenge.collection, "deleteMany").mockRejectedValueOnce(new Error("Synthetic challenge cleanup failure"));
  }
  let response;
  try { response = await f.close(); } finally { stop(); }
  expect(response.status).toBe(500);
  const after = await state(f);
  console.log(JSON.stringify({ role, failure, responseStatus: response.status, before, after, publishedBeforeFailure: events.some(event => event.includes("account_participation_refresh")) }));
  expect(after).toEqual(before);
  expect(events.join("\n")).not.toContain("account_participation_refresh");
});

test.each(["claimed", "needs_reconciliation"])("an in-flight %s hire cannot be cleared as an ordinary unfunded posting", async hiringClaimStatus => {
  const f = await fixture("attorney");
  await Case.updateOne({ _id: f.matter._id }, { $set: { hiringClaimToken: "synthetic-held-hire", hiringClaimStatus, hiringClaimParalegalId: f.matter.paralegalId, hiringClaimedAt: new Date(), hiringClaimPaymentIntentId: hiringClaimStatus === "needs_reconciliation" ? "pi_synthetic_pending" : "" } });
  const before = await state(f), response = await f.close();
  console.log(JSON.stringify({ hiringClaimStatus, responseStatus: response.status, before, after: await state(f) }));
  expect(response.status).toBe(409);
  expect(await state(f)).toEqual(before);
});

function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("a posting paused after authentication cannot create an open Job after attorney closure", async () => {
  const f = await fixture("attorney"), entered = latch(), release = latch(), original = Job.create.bind(Job);
  const closureAttempt = latch(), updateUser = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, "updateOne").mockImplementation((filter, update, options) => {
    if (options?.session && update.$inc?.__v && !filter.status) closureAttempt.resolve();
    return updateUser(filter, update, options);
  });
  jest.spyOn(Job, "create").mockImplementation(async (...args) => {
    const payload = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (payload.title === "Late synthetic posting") { entered.resolve(); await release.promise; }
    return original(...args);
  });
  const token = jwt.sign({ id: String(f.owner._id), role: "attorney", status: "approved", sid: f.session.sessionId, av: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const posting = request(app).post("/api/jobs").set("Cookie", `token=${token}`).send({ title: "Late synthetic posting", description: "Prepare and organize the exhibits for attorney review and check each page reference carefully.", practiceArea: "immigration", budget: 400, state: "CA" }).then(response => response);
  let closing;
  try {
    await Promise.race([entered.promise, posting.then(response => { throw new Error(`Posting returned before the write barrier: ${response.status} ${JSON.stringify(response.body)}`); })]);
    closing = f.close().then(response => response);
    await Promise.race([closureAttempt.promise, closing]);
  } finally { release.resolve(); }
  const closed = await closing;
  const response = await posting, lateJobs = await Job.countDocuments({ attorneyId: f.owner._id, status: "open" });
  console.log(JSON.stringify({ branch: "late-posting", closureStatus: closed.status, postingStatus: response.status, lateJobs, deleted: (await User.findById(f.owner._id)).deleted }));
  // The baseline pauses at the actual insert. A corrected writer may already
  // hold its User lock there: either closure wins and rejects the posting, or
  // the reviewed closure conflicts and the still-active owner can publish.
  if (closed.status === 200) {
    expect([403, 409]).toContain(response.status);
    expect(lateJobs).toBe(0);
  } else {
    expect(closed.status).toBe(409);
    expect(response.status).toBe(200);
    expect((await User.findById(f.owner._id)).deleted).toBe(false);
    expect(lateJobs).toBe(2);
  }
});

test("an application paused at payout readiness cannot create participation after paralegal closure", async () => {
  const f = await fixture("paralegal"), entered = latch(), release = latch();
  await User.updateOne({ _id: f.owner._id }, { $set: { profileImage: "synthetic-approved-photo", stripeAccountId: "acct_synthetic", stripeOnboarded: true, stripeChargesEnabled: true, stripePayoutsEnabled: true } });
  const owner = await User.findById(f.owner._id), job = await Job.create({ attorneyId: f.matter.attorneyId, title: "Separate synthetic posting", description: "Prepare exhibits for attorney review.", practiceArea: "probate", budget: 300, status: "open" });
  mockReadiness.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { ready: true, evidenceState: "verified", devBypass: true, chargesEnabled: true, payoutsEnabled: true }; });
  const { createApplicationForJob } = require("../routes/applications");
  const applying = createApplicationForJob(String(job._id), owner.toObject(), "I can prepare and organize these exhibits for attorney review.").then(application => ({ application }), error => ({ error }));
  let closed;
  try { await entered.promise; closed = await f.close(); } finally { release.resolve(); }
  const result = await applying, activeApplications = await Application.countDocuments({ paralegalId: owner._id, status: { $in: ["submitted", "viewed", "shortlisted", "accepted"] } });
  console.log(JSON.stringify({ branch: "late-application", closureStatus: closed.status, applicationErrorStatus: result.error?.status || null, activeApplications, deleted: (await User.findById(owner._id)).deleted }));
  expect(closed.status).toBe(200);
  expect(result.error).toBeDefined();
  expect([403, 409]).toContain(result.error?.status);
  expect(activeApplications).toBe(0);
});

test("a delayed application mirror cannot revive the submitted snapshot after closure", async () => {
  const f = await fixture("paralegal");
  const { syncApplicationMirror } = require("../services/applicationService");
  expect((await f.close()).status).toBe(200);
  const result = await syncApplicationMirror({ application: f.application, caseId: f.matter._id });
  const after = await state(f);
  console.log(JSON.stringify({ branch: "late-application-mirror", result, after }));
  expect(after.applicationStatus).toBe("rejected");
  expect(after.applicantStatus).toBe("rejected");
});

test("a delayed accepted-invitation reconciliation cannot recreate participation after closure", async () => {
  const f = await fixture("paralegal"), entered = latch(), release = latch();
  const closureAttempt = latch(), updateUser = User.collection.updateOne.bind(User.collection);
  jest.spyOn(User.collection, "updateOne").mockImplementation((filter, update, options) => {
    if (options?.session && update.$inc?.__v && !filter.status) closureAttempt.resolve();
    return updateUser(filter, update, options);
  });
  await Application.deleteOne({ _id: f.application._id });
  await Case.updateOne({ _id: f.matter._id }, { $set: { paralegal: null, paralegalId: null, applicants: [], "invites.0.status": "pending", "invites.0.syncStatus": "pending" } });
  const { captureResumeReference } = require("../utils/resumeReferenceWrite");
  const { respondToInvitation } = require("../services/invitationService");
  const original = Job.findOne.bind(Job);
  jest.spyOn(Job, "findOne").mockImplementation((...args) => {
    const query = original(...args), exec = query.exec.bind(query);
    if (String(args[0]?.caseId) === String(f.matter._id)) query.exec = async (...execArgs) => { entered.resolve(); await release.promise; return exec(...execArgs); };
    return query;
  });
  const owner = await User.findById(f.owner._id).select("resumeURL");
  const accepting = respondToInvitation({ caseId: f.matter._id, paralegalId: f.owner._id, decision: "accept", paralegalProfile: { resumeURL: owner.resumeURL || "" }, resumeReference: captureResumeReference(owner), respondedAt: new Date() });
  let closing;
  try { await entered.promise; closing = f.close().then(response => response); await Promise.race([closureAttempt.promise, closing]); } finally { release.resolve(); }
  const closed = await closing;
  const result = await accepting, matter = await Case.findById(f.matter._id).lean(), activeApplications = await Application.countDocuments({ paralegalId: f.owner._id, status: { $in: ["submitted", "viewed", "shortlisted", "accepted"] } });
  console.log(JSON.stringify({ branch: "late-invitation-reconciliation", closureStatus: closed.status, result, inviteStatus: matter.invites[0].status, applicantStatus: matter.applicants[0]?.status, activeApplications }));
  if (closed.status === 200) {
    expect(matter.invites[0].status).toBe("expired");
    expect(matter.applicants[0].status).toBe("rejected");
    expect(activeApplications).toBe(0);
  } else {
    expect(closed.status).toBe(409);
    expect((await User.findById(f.owner._id)).deleted).toBe(false);
    expect(matter.invites[0].status).toBe("accepted");
    expect(activeApplications).toBe(1);
  }
});

test("a stale sign-in cannot insert an active managed session after account closure", async () => {
  const f = await fixture("paralegal");
  const { createAuthSession } = require("../services/authSessionService");
  expect((await f.close()).status).toBe(200);
  const result = await createAuthSession(f.owner, {}).then(value => ({ value }), error => ({ error }));
  const activeSessions = await AuthSession.countDocuments({ userId: f.owner._id, revokedAt: null });
  console.log(JSON.stringify({ branch: "late-auth-session", errorStatus: result.error?.status || null, activeSessions }));
  expect(result.error?.status).toBe(403);
  expect(activeSessions).toBe(0);
});

test("a stale target review cannot create a pending invitation after paralegal closure", async () => {
  const f = await fixture("paralegal");
  await Case.updateOne({ _id: f.matter._id }, { $set: { paralegal: null, paralegalId: null, applicants: [], invites: [] } });
  const stale = await Case.findById(f.matter._id);
  expect((await f.close()).status).toBe(200);
  const attorneyBefore = await User.collection.findOne({ _id: f.matter.attorneyId });
  await AuthSession.create({ userId: f.matter.attorneyId, sessionId: "closure-actor-session", expiresAt: new Date(Date.now() + 600000) });
  const result = await require("../services/invitationService").sendInvitation({ caseDoc: stale, paralegalId: f.owner._id }).then(value => ({ value }), error => ({ error }));
  const matter = await Case.findById(f.matter._id).lean();
  console.log(JSON.stringify({ branch: "late-invitation-send", errorStatus: result.error?.status || null, result: result.value, invites: matter.invites.map(invite => invite.status) }));
  expect(result.error).toMatchObject({ status: 409, code: "ACCOUNT_PARTICIPANT_CHANGED" });
  expect(matter.invites).toHaveLength(0);
  expect(await User.collection.findOne({ _id: f.matter.attorneyId })).toEqual(attorneyBefore);
  const attorney = await User.findById(f.matter.attorneyId);
  const token = jwt.sign({ id: String(attorney._id), role: "attorney", av: 0, sid: "closure-actor-session" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  expect((await request(app).get("/api/account/preferences").set("Cookie", `token=${token}`)).status).toBe(200);
});

test("an account-bound sign-in challenge cannot be recreated after closure cleanup", async () => {
  const f = await fixture("paralegal");
  expect((await f.close()).status).toBe(200);
  const result = await require("../services/passkeyService").authenticationOptions({ headers: { host: "localhost:5050" }, protocol: "http" }, { userId: f.owner._id }).then(value => ({ value }), error => ({ error }));
  const challenges = await AuthChallenge.countDocuments({ userId: f.owner._id });
  console.log(JSON.stringify({ branch: "late-account-challenge", errorStatus: result.error?.status || null, challenges }));
  expect(result.error?.status).toBe(403);
  expect(challenges).toBe(0);
});

test("a delayed legacy pending-invite mirror cannot restore the target cleared by closure", async () => {
  const f = await fixture("paralegal"), entered = latch(), release = latch();
  await Case.updateOne({ _id: f.matter._id }, { $set: { paralegal: null, paralegalId: null, "invites.0.status": "pending", pendingParalegalId: f.owner._id, pendingParalegalInvitedAt: new Date() } });
  const original = Case.findById.bind(Case);
  jest.spyOn(Case, "findById").mockImplementation((...args) => {
    const query = original(...args), exec = query.exec.bind(query);
    query.exec = async (...execArgs) => {
      const result = await exec(...execArgs);
      if (String(args[0]) === String(f.matter._id) && query._fields?.pendingParalegalInvitedAt) { entered.resolve(); await release.promise; }
      return result;
    };
    return query;
  });
  const syncing = require("../services/invitationService").syncLegacyPendingInviteFields(f.matter._id).then(result => ({ result }), error => ({ error }));
  let closed;
  try { await entered.promise; closed = await f.close(); } finally { release.resolve(); }
  const result = await syncing, matter = await Case.findById(f.matter._id).lean();
  console.log(JSON.stringify({ branch: "late-legacy-invite-mirror", closureStatus: closed.status, error: result.error?.message || null, pendingParalegalId: String(matter.pendingParalegalId || ""), invitation: matter.invites[0].status }));
  expect(closed.status).toBe(200);
  expect(matter.invites[0].status).toBe("expired");
  expect(matter.pendingParalegalId).toBeNull();
});

test("closure review excludes unrelated profile text but binds authoritative participation", async () => {
  const f = await fixture("paralegal"), service = require("../services/userDeletion");
  const first = await service.getAccountDeactivationReview(f.owner);
  expect(first.canDeactivate).toBe(true);
  expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
  await User.updateOne({ _id: f.owner._id }, { $set: { firstName: "Changed profile name" } });
  expect((await User.findById(f.owner._id)).firstName).toBe("Changed profile name");
  expect((await service.getAccountDeactivationReview(f.owner)).revision).toBe(first.revision);
  await Application.updateOne({ _id: f.application._id }, { $set: { status: "viewed" } });
  const before = await state(f);
  expect((await service.getAccountDeactivationReview(f.owner)).revision).not.toBe(first.revision);
  await expect(service.deactivateUserAccount(f.owner, { expectedOwnerId: String(f.owner._id), expectedClosureRevision: first.revision, authVersion: 0, authSessionId: f.session.sessionId })).rejects.toMatchObject({ status: 409, code: "ACCOUNT_CLOSURE_CHANGED" });
  expect(await state(f)).toEqual(before);
});

test.each(["wrong-owner", "malformed-revision", "revoked-session", "changed-auth"])("guarded closure rejects %s without changing participation", async kind => {
  const f = await fixture("paralegal"), service = require("../services/userDeletion"), review = await service.getAccountDeactivationReview(f.owner);
  const options = { expectedOwnerId: String(f.owner._id), expectedClosureRevision: review.revision, authVersion: 0, authSessionId: f.session.sessionId };
  if (kind === "wrong-owner") options.expectedOwnerId = String(f.matter.attorneyId);
  if (kind === "malformed-revision") options.expectedClosureRevision = "invalid";
  if (kind === "revoked-session") await AuthSession.updateOne({ _id: f.session._id }, { $set: { revokedAt: new Date() } });
  if (kind === "changed-auth") await User.updateOne({ _id: f.owner._id }, { $inc: { authVersion: 1 } });
  const before = await state(f);
  await expect(service.deactivateUserAccount(f.owner, options)).rejects.toMatchObject({ status: kind === "malformed-revision" ? 400 : 403 });
  expect(await state(f)).toEqual(before);
});

test("an audit persistence failure rolls back closure, participation and security cleanup", async () => {
  const f = await fixture("attorney"), before = await state(f);
  const AuditLog = require("../models/AuditLog"), service = require("../services/userDeletion");
  jest.spyOn(AuditLog.collection, "insertOne").mockRejectedValueOnce(new Error("Synthetic closure audit failure"));
  await expect(service.deactivateUserAccount(f.owner, { req: { user: { id: String(f.owner._id), role: "attorney" }, method: "DELETE", originalUrl: "/api/account/deactivate", headers: {} } })).rejects.toThrow("Synthetic closure audit failure");
  expect(await state(f)).toEqual(before);
  expect(await AuditLog.countDocuments({ action: "account.deactivate" })).toBe(0);
});

test("a lost commit acknowledgment is unconfirmed while the committed closure remains readable", async () => {
  const f = await fixture("paralegal"), service = require("../services/userDeletion"), mongoose = require("mongoose");
  const original = mongoose.mongo.ClientSession.prototype.commitTransaction;
  jest.spyOn(mongoose.mongo.ClientSession.prototype, "commitTransaction").mockImplementationOnce(async function (...args) {
    await original.apply(this, args);
    const error = new Error("Synthetic lost commit acknowledgment");
    error.hasErrorLabel = label => label === "UnknownTransactionCommitResult";
    throw error;
  });
  await expect(service.deactivateUserAccount(f.owner)).rejects.toMatchObject({ status: 503, code: "ACCOUNT_CLOSURE_UNCONFIRMED" });
  expect(await state(f)).toMatchObject({ deleted: true, disabled: true, applicationStatus: "rejected", applicantStatus: "rejected", sessionRevoked: true, challengePresent: false });
});

test("managed onboarding sessions and anonymous passkey challenges retain their existing eligibility", async () => {
  const owner = await User.create({ firstName: "Pending", lastName: "Account", email: "closure-onboarding@example.test", password: "Password123!", role: "paralegal", status: "pending" });
  const result = await require("../services/authSessionService").createAuthSession(owner, {});
  expect(await AuthSession.countDocuments({ userId: owner._id, sessionId: result.sessionId, revokedAt: null })).toBe(1);
  await require("../services/passkeyService").authenticationOptions({ headers: { host: "localhost:5050" }, protocol: "http" });
  expect(await AuthChallenge.countDocuments({ userId: null, purpose: "passkey_authentication" })).toBe(1);
});

test("a financial Case write committed after the closure read makes that closure roll back", async () => {
  const f = await fixture("attorney"), before = await state(f), original = Case.collection.updateMany.bind(Case.collection);
  let competed = false;
  jest.spyOn(Case.collection, "updateMany").mockImplementation(async (filter, update, options) => {
    if (!competed && options?.session && update.$inc?.__v === 1) {
      competed = true;
      const result = await Case.collection.updateOne({ _id: f.matter._id, __v: f.matter.__v }, { $set: { status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_concurrent_funding" }, $inc: { __v: 1 } });
      expect(result.modifiedCount).toBe(1);
    }
    return original(filter, update, options);
  });
  const response = await f.close(), after = await state(f), matter = await Case.findById(f.matter._id).lean();
  expect(competed).toBe(true);
  expect(response.status).toBe(409);
  expect(after).toEqual({ ...before, matterStatus: "in progress" });
  expect(matter).toMatchObject({ escrowStatus: "funded", escrowIntentId: "pi_synthetic_concurrent_funding" });
});

test("a stale financial Case predicate cannot fund the posting after closure commits", async () => {
  const f = await fixture("attorney"), source = await Case.collection.findOne({ _id: f.matter._id });
  expect((await f.close()).status).toBe(200);
  const result = await Case.collection.updateOne({ _id: source._id, __v: source.__v, status: source.status, archived: { $ne: true } }, { $set: { status: "in progress", escrowStatus: "funded", escrowIntentId: "pi_synthetic_stale_funding" }, $inc: { __v: 1 } });
  expect(result.modifiedCount).toBe(0);
  const matter = await Case.findById(f.matter._id).lean();
  expect(matter).toMatchObject({ status: "closed", archived: true, paymentStatus: "cancelled" });
  expect(matter.escrowIntentId).not.toBe("pi_synthetic_stale_funding");
});

test.each(["submitted", "accepted"])("retained %s applications with a missing Job do not prevent closure", async status => {
  const f = await fixture("paralegal");
  await Application.updateOne({ _id: f.application._id }, { $set: { status } });
  await Job.deleteOne({ _id: f.job._id });
  const eligibility = await require("../services/userDeletion").getAccountDeactivationEligibility(f.owner);
  const response = await f.close();
  const application = await Application.findById(f.application._id).lean();
  console.log(JSON.stringify({ branch: "retained-missing-job", status, eligible: eligibility.canDeactivate, closureStatus: response.status, applicationStatus: application.status }));
  expect(eligibility.canDeactivate).toBe(true);
  expect(response.status).toBe(200);
  expect(application).toMatchObject({ status: "rejected", coverLetter: f.application.coverLetter });
  expect(application.statusHistory.at(-1)).toMatchObject({ to: "rejected", reason: "account_deactivated" });
  expect(await Job.findById(f.job._id)).toBeNull();
  expect((await User.findById(f.owner._id)).deleted).toBe(true);
  expect((await AuthSession.findById(f.session._id)).revokedAt).toBeTruthy();
  expect(await AuthChallenge.findById(f.challenge._id)).toBeNull();
});

test.each(["attorney", "paralegal"])("%s settled Matter funding references remain historical evidence after closure", async role => {
  const f = await fixture(role);
  await Case.updateOne({ _id: f.matter._id }, { $set: { status: "completed", paymentReleased: true, paidOutAt: new Date("2026-09-01T12:00:00Z"), completedAt: new Date("2026-09-01T12:00:00Z"), escrowStatus: "funded", fundingRequestKey: "synthetic-retained-funding", paymentIntentId: "pi_synthetic_settled", escrowIntentId: "pi_synthetic_settled", applicants: [], invites: [] } });
  await Job.updateOne({ _id: f.job._id }, { $set: { status: "closed" } });
  await Application.updateOne({ _id: f.application._id }, { $set: { status: "rejected" } });
  const before = await Case.findById(f.matter._id).lean();
  const eligibility = await require("../services/userDeletion").getAccountDeactivationEligibility(f.owner), response = await f.close();
  const after = await Case.findById(f.matter._id).lean();
  console.log(JSON.stringify({ branch: "retained-settled-key", role, eligibility, closureStatus: response.status }));
  expect(eligibility).toEqual({ canDeactivate: true, blockers: [] });
  expect(response.status).toBe(200);
  for (const field of ["status", "paymentReleased", "paidOutAt", "completedAt", "escrowStatus", "fundingRequestKey", "paymentIntentId", "escrowIntentId", "totalAmount", "currency", "files"]) expect(after[field]).toEqual(before[field]);
  expect((await User.findById(f.owner._id)).deleted).toBe(true);
});

test.each(["attorney", "paralegal"])("%s unresolved funding preparation and pending payout still block closure", async role => {
  const f = await fixture(role);
  await Case.updateOne({ _id: f.matter._id }, { $set: { fundingRequestKey: "synthetic-unresolved-preparation" } });
  const before = await state(f);
  expect((await f.close()).status).toBe(409);
  expect(await state(f)).toEqual(before);
  await Case.updateOne({ _id: f.matter._id }, { $set: { status: "completed", paymentReleased: true, escrowStatus: "funded", paidOutAt: null } });
  const pending = await state(f), eligibility = await require("../services/userDeletion").getAccountDeactivationEligibility(f.owner);
  expect(eligibility.blockers.some(blocker => blocker.code === "pending_payouts")).toBe(true);
  expect((await f.close()).status).toBe(409);
  expect(await state(f)).toEqual(pending);
});

test("an existing Job count write failure still rolls back the entire closure", async () => {
  const f = await fixture("paralegal"), before = await state(f);
  jest.spyOn(Job, "updateOne").mockImplementationOnce(() => { throw new Error("Synthetic count write unavailable"); });
  expect((await f.close()).status).toBe(500);
  expect(await state(f)).toEqual(before);
});

test("closed initiating owner takes precedence over an earlier closed participant without writes", async () => {
  const f = await fixture("paralegal"), attorneyId = f.matter.attorneyId;
  expect(String(attorneyId) < String(f.owner._id)).toBe(true);
  await User.updateMany({ _id: { $in: [attorneyId, f.owner._id] } }, { $set: { disabled: true, deleted: true } });
  const before = await User.collection.find({ _id: { $in: [attorneyId, f.owner._id] } }).sort({ _id: 1 }).toArray();
  const work = jest.fn();
  const result = await require("../utils/activeAccountWrite").withActiveAccountWrite([attorneyId, f.owner._id], work, { ownerId: f.owner._id, authVersion: 0 }).then(value => ({ value }), error => ({ error }));
  expect(result.error).toMatchObject({ status: 403, code: "ACCOUNT_CHANGED" });
  expect(work).not.toHaveBeenCalled();
  expect(await User.collection.find({ _id: { $in: [attorneyId, f.owner._id] } }).sort({ _id: 1 }).toArray()).toEqual(before);
});
