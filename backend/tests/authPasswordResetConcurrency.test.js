const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const AuditLog = require("../models/AuditLog");
const authRouter = require("../routes/auth");
const accountRouter = require("../routes/account");
const sendEmail = require("../utils/email");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.use("/api/account", accountRouter);

const ORIGINAL = "The original isolated recovery passphrase";
const REPLACEMENT = "A replacement isolated recovery passphrase";
const INTERLEAVED = "An intervening isolated security passphrase";

async function fixture(role = "attorney", values = {}) {
  const user = await User.create({ firstName: "Recovery", lastName: "Concurrency", email: `${role}.reset@example.com`, password: ORIGINAL, role, status: "approved", emailVerified: true, state: "NY", ...values });
  const agent = request.agent(app);
  if (user.status === "approved" && !user.disabled && !user.deleted) {
    expect((await agent.post("/api/auth/login").send({ email: user.email, password: ORIGINAL })).status).toBe(200);
  }
  const response = await request(app).post("/api/auth/request-password-reset").send({ email: user.email });
  expect(response.status).toBe(200);
  const token = sendEmail.mock.calls.filter(call => call[1] === "Reset your LPC password").at(-1)[3].text.match(/token=([^\s]+)/)[1];
  return { user, agent, token };
}
const reset = (token, password = REPLACEMENT) => request(app).post("/api/auth/reset-password").send({ token, newPassword: password });
const stored = user => User.findById(user._id).select("+password +authVersion +resetPasswordTokenHash +resetPasswordExpiresAt");

function interleave(user, action) {
  let invoked = false;
  const compare = User.prototype.comparePassword;
  const spy = jest.spyOn(User.prototype, "comparePassword").mockImplementation(async function (password) {
    const result = await compare.call(this, password);
    if (!invoked && String(this._id) === String(user._id) && password === REPLACEMENT) {
      invoked = true;
      await action();
    }
    return result;
  });
  return { spy, invoked: () => invoked };
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); sendEmail.mockClear(); });
afterEach(() => jest.restoreAllMocks());

for (const role of ["attorney", "paralegal"]) {
  test(`${role} reset advances from an interleaved actual account password change`, async () => {
    const { user, agent, token } = await fixture(role);
    const change = interleave(user, async () => {
      const reply = await agent.post("/api/account/update-password").send({ currentPassword: ORIGINAL, newPassword: INTERLEAVED });
      expect(reply.status).toBe(200);
      expect((await stored(user)).authVersion).toBe(1);
    });
    const response = await reset(token);
    expect(response.status).toBe(200);
    expect(change.invoked()).toBe(true);
    const result = await stored(user);
    expect(result.authVersion).toBe(2);
    expect(await result.comparePassword(REPLACEMENT)).toBe(true);
    expect(await result.comparePassword(INTERLEAVED)).toBe(false);
    expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
  });

  test(`${role} reset preserves an interleaved actual MFA change and revokes its remaining session`, async () => {
    const { user, agent, token } = await fixture(role);
    const change = interleave(user, async () => {
      const reply = await agent.post("/api/account/2fa-toggle").send({ currentPassword: ORIGINAL, enabled: true, method: "email" });
      expect(reply.status).toBe(200);
      expect((await stored(user)).twoFactorEnabled).toBe(true);
    });
    expect((await reset(token)).status).toBe(200);
    expect(change.invoked()).toBe(true);
    const result = await stored(user);
    expect(result.twoFactorEnabled).toBe(true);
    expect(result.twoFactorMethod).toBe("email");
    expect(result.authVersion).toBe(1);
    expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
  });

  test(`${role} reset keeps an interleaved actual device revocation and revokes the current device`, async () => {
    const { user, agent, token } = await fixture(role);
    const other = request.agent(app);
    expect((await other.post("/api/auth/login").send({ email: user.email, password: ORIGINAL })).status).toBe(200);
    const change = interleave(user, async () => {
      const reply = await agent.post("/api/account/sessions/revoke-others");
      expect(reply.status).toBe(200);
      expect(reply.body.revokedCount).toBe(1);
    });
    expect((await reset(token)).status).toBe(200);
    expect(change.invoked()).toBe(true);
    expect((await stored(user)).authVersion).toBe(1);
    expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
  });
}

test("concurrent uses of one reset token commit one password, one version and one audit", async () => {
  const { user, token } = await fixture();
  const alternatives = [REPLACEMENT, "Another isolated replacement passphrase"];
  const replies = await Promise.all(alternatives.map(password => reset(token, password)));
  expect(replies.map(reply => reply.status).sort()).toEqual([200, 400]);
  const result = await stored(user);
  expect(result.authVersion).toBe(1);
  expect(await result.comparePassword(alternatives[replies.findIndex(reply => reply.status === 200)])).toBe(true);
  expect(result.resetPasswordTokenHash).toBeNull();
  expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
  expect(await AuditLog.countDocuments({ action: "auth.password.reset.success", targetId: user._id })).toBe(1);
});

test("session-revocation failure rolls back token, password and version so the same link can recover", async () => {
  const { user, token } = await fixture();
  const before = await stored(user);
  const fail = jest.spyOn(AuthSession, "updateMany").mockRejectedValueOnce(new Error("Synthetic isolated revocation failure"));
  const response = await reset(token);
  expect(response.status).toBe(503);
  fail.mockRestore();
  const after = await stored(user);
  expect(after.authVersion).toBe(before.authVersion);
  expect(after.password).toBe(before.password);
  expect(after.resetPasswordTokenHash).toBe(before.resetPasswordTokenHash);
  expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(1);
  expect(await AuditLog.countDocuments({ action: "auth.password.reset.success", targetId: user._id })).toBe(0);
  expect((await reset(token)).status).toBe(200);
});

test("an unknown commit is reported honestly and a committed reset cannot replay", async () => {
  const { user, token } = await fixture();
  const startSession = User.db.startSession.bind(User.db);
  const uncertain = jest.spyOn(User.db, "startSession").mockImplementation(async (...args) => {
    const session = await startSession(...args);
    const transaction = session.withTransaction.bind(session);
    session.withTransaction = async (...options) => {
      await transaction(...options);
      const error = new Error("Synthetic lost commit acknowledgement");
      error.hasErrorLabel = name => name === "UnknownTransactionCommitResult";
      throw error;
    };
    return session;
  });
  const response = await reset(token);
  expect(response.status).toBe(503);
  expect(response.body.code).toBe("PASSWORD_RESET_UNCONFIRMED");
  uncertain.mockRestore();
  expect((await stored(user)).authVersion).toBe(1);
  expect(await (await stored(user)).comparePassword(REPLACEMENT)).toBe(true);
  expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
  expect((await reset(token)).status).toBe(400);
  expect((await stored(user)).authVersion).toBe(1);
});

test.each(["disabled", "deleted"])("a %s account cannot consume a reset link or change security state", async field => {
  const { user, token } = await fixture();
  await User.updateOne({ _id: user._id }, { $set: { [field]: true } });
  const before = await stored(user);
  expect((await reset(token)).status).toBe(400);
  const after = await stored(user);
  expect(after.password).toBe(before.password);
  expect(after.authVersion).toBe(before.authVersion);
  expect(after.resetPasswordTokenHash).toBe(before.resetPasswordTokenHash);
});

test("deactivation between the initial token read and write fails closed without replacing the password", async () => {
  const { user, token } = await fixture();
  const before = await stored(user);
  const change = interleave(user, () => User.updateOne({ _id: user._id }, { $set: { disabled: true } }));
  expect((await reset(token)).status).toBe(400);
  expect(change.invoked()).toBe(true);
  const after = await stored(user);
  expect(after.disabled).toBe(true);
  expect(after.password).toBe(before.password);
  expect(after.authVersion).toBe(before.authVersion);
});

test("a newer reset link created during a reset remains authoritative", async () => {
  const { user, token } = await fixture();
  const change = interleave(user, async () => expect((await request(app).post("/api/auth/request-password-reset").send({ email: user.email })).status).toBe(200));
  expect((await reset(token)).status).toBe(400);
  expect(change.invoked()).toBe(true);
  const newest = sendEmail.mock.calls.filter(call => call[1] === "Reset your LPC password").at(-1)[3].text.match(/token=([^\s]+)/)[1];
  expect(newest).not.toBe(token);
  expect((await reset(newest)).status).toBe(200);
});

test("expired and unavailable account links do not update a password", async () => {
  const { user, token } = await fixture();
  await User.updateOne({ _id: user._id }, { $set: { resetPasswordExpiresAt: new Date(Date.now() - 1000) } });
  expect((await reset(token)).status).toBe(400);
  expect(await (await stored(user)).comparePassword(ORIGINAL)).toBe(true);
  await User.deleteOne({ _id: user._id });
  expect((await reset(token)).status).toBe(400);
});

test("successful recovery preserves legacy password migration and increments an existing version", async () => {
  const { user, token } = await fixture();
  await User.updateOne({ _id: user._id }, { $set: { password: await bcrypt.hash(ORIGINAL, 10), authVersion: 17 } });
  expect((await reset(token)).status).toBe(200);
  const result = await stored(user);
  expect(result.password).toMatch(/^\$argon2/);
  expect(result.authVersion).toBe(18);
  expect(await result.comparePassword(REPLACEMENT)).toBe(true);
  expect(result.resetPasswordTokenHash).toBeNull();
});

test("password recovery does not approve a pending account or create a session", async () => {
  const { user, token } = await fixture("paralegal", { status: "pending" });
  expect((await reset(token)).status).toBe(200);
  expect((await stored(user)).status).toBe("pending");
  expect((await request(app).post("/api/auth/login").send({ email: user.email, password: REPLACEMENT })).status).toBe(403);
  expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
});
