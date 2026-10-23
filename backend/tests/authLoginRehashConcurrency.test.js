const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const fs = require("node:fs");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const authRouter = require("../routes/auth");
const accountRouter = require("../routes/account");
const sendEmail = require("../utils/email");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/auth", authRouter);
app.use("/api/account", accountRouter);
const PASSWORD = "An isolated legacy credential passphrase";
const NEW_PASSWORD = "A newer isolated current credential passphrase";
const stored = user => User.findById(user._id).select("+password +authVersion +resetPasswordTokenHash");
const login = user => request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });

async function fixture(role = "attorney") {
  const user = await User.create({ firstName: "Legacy", lastName: "Credential", email: `${role}.rehash@example.com`, password: PASSWORD,
    role, status: "approved", emailVerified: true, state: "NY", authVersion: 17 });
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
  const oldHash = await bcrypt.hash(PASSWORD, 10);
  await User.collection.updateOne({ _id: user._id }, { $set: { password: oldHash } });
  expect((await request(app).post("/api/auth/request-password-reset").send({ email: user.email })).status).toBe(200);
  const token = sendEmail.mock.calls.filter(call => call[1] === "Reset your LPC password").at(-1)[3].text.match(/token=([^\s]+)/)[1];
  return { user, agent, oldHash, token };
}
function interleave(f, action) {
  const compare = User.prototype.comparePassword;
  let used = false;
  jest.spyOn(User.prototype, "comparePassword").mockImplementation(async function (password) {
    const match = await compare.call(this, password);
    if (!used && String(this._id) === String(f.user._id) && password === PASSWORD && this._passwordNeedsRehash) {
      used = true;
      await action();
    }
    return match;
  });
}
async function evidence(f, response) {
  if (!process.env.LPC_REHASH_OBSERVATIONS_FILE) return;
  const user = await stored(f.user);
  fs.appendFileSync(process.env.LPC_REHASH_OBSERVATIONS_FILE, JSON.stringify({ test: expect.getState().currentTestName, http_status: response.status,
    token_cookie: (response.headers["set-cookie"] || []).some(value => value.startsWith("token=")), auth_version: user.authVersion,
    original_password_matches: await user.comparePassword(PASSWORD), current_password_matches: await user.comparePassword(NEW_PASSWORD),
    active_sessions: await AuthSession.countDocuments({ userId: user._id, revokedAt: null }), hash_kind: user.password.startsWith("$argon2") ? "argon2" : "bcrypt",
  }) + "\n");
}
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); sendEmail.mockClear(); });
afterEach(() => jest.restoreAllMocks());

for (const role of ['attorney', 'paralegal']) {
  test.each(['argon2', 'bcrypt'])(`${role} existing %s Unicode credential survives the normalization rollout`, async kind => {
    const raw = 'Cafe\u0301 existing account passphrase';
    const user = await User.create({ firstName: 'Existing', lastName: 'Member', email: role + '.unicode@example.test', password: raw, role, status: 'approved', emailVerified: true, authVersion: 9 });
    const oldHash = kind === 'argon2' ? await require('argon2').hash(raw) : await bcrypt.hash(raw, 10);
    await User.collection.updateOne({ _id: user._id }, { $set: { password: oldHash } });
    const response = await request(app).post('/api/auth/login').send({ email: user.email, password: raw });
    expect(response.status).toBe(200);
    const migrated = await stored(user);
    expect(migrated.password).not.toBe(oldHash);
    expect(migrated.authVersion).toBe(9);
    expect(await migrated.comparePassword(raw.normalize('NFC'))).toBe(true);
    expect((await request(app).post('/api/auth/login').send({ email: user.email, password: raw.normalize('NFC') })).status).toBe(200);
  });
}

for (const role of ["attorney", "paralegal"]) {
  for (const change of ["reset", "password change"]) {
    test(`${role} legacy login cannot restore an old credential after an actual ${change}`, async () => {
      const f = await fixture(role);
      interleave(f, async () => {
        const response = change === "reset"
          ? await request(app).post("/api/auth/reset-password").send({ token: f.token, newPassword: NEW_PASSWORD })
          : await f.agent.post("/api/account/update-password").send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
        expect(response.status).toBe(200);
        expect((await stored(f.user)).authVersion).toBe(18);
      });
      const response = await login(f.user);
      await evidence(f, response);
      expect(response.status).not.toBe(200);
      expect((response.headers["set-cookie"] || []).some(value => value.startsWith("token="))).toBe(false);
      const user = await stored(f.user);
      expect(await user.comparePassword(NEW_PASSWORD)).toBe(true);
      expect(await user.comparePassword(PASSWORD)).toBe(false);
      expect(user.authVersion).toBe(18);
      expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
      expect((await request(app).post("/api/auth/login").send({ email: user.email, password: NEW_PASSWORD })).status).toBe(200);
    });
  }
  test(`${role} ordinary legacy login migrates the same password and preserves version and sessions`, async () => {
    const f = await fixture(role);
    expect((await login(f.user)).status).toBe(200);
    const user = await stored(f.user);
    expect(user.password.startsWith("$argon2")).toBe(true);
    expect(await user.comparePassword(PASSWORD)).toBe(true);
    expect(user.authVersion).toBe(17);
    expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(2);
  });
}

test.each(["disabled", "deleted"])("legacy rehash does not alter a %s account after password comparison", async field => {
  const f = await fixture();
  interleave(f, () => User.collection.updateOne({ _id: f.user._id }, { $set: { [field]: true } }));
  const response = await login(f.user);
  expect(response.status).not.toBe(200);
  expect((await stored(f.user)).password).toBe(f.oldHash);
  expect(await AuthSession.countDocuments({ userId: f.user._id, revokedAt: null })).toBe(1);
});

test("legacy migration honors a newly enabled current MFA requirement", async () => {
  const f = await fixture("paralegal");
  interleave(f, async () => {
    expect((await f.agent.post("/api/account/2fa-toggle").send({ currentPassword: PASSWORD, enabled: true, method: "email" })).status).toBe(200);
  });
  const response = await login(f.user);
  expect(response.status).toBe(200);
  expect(response.body.twoFactorRequired).toBe(true);
  expect((await stored(f.user)).twoFactorEnabled).toBe(true);
  expect(await AuthSession.countDocuments({ userId: f.user._id, revokedAt: null })).toBe(1);
});

test("failed legacy migration leaves the original hash and can retry without a partial session", async () => {
  const f = await fixture();
  const save = User.prototype.save;
  const fail = jest.spyOn(User.prototype, "save").mockImplementation(async function (...args) {
    if (String(this._id) === String(f.user._id) && this.isModified("password")) throw new Error("Synthetic isolated legacy migration failure");
    return save.apply(this, args);
  });
  expect((await login(f.user)).status).not.toBe(200);
  expect((await stored(f.user)).password).toBe(f.oldHash);
  expect((await stored(f.user)).authVersion).toBe(17);
  expect(await AuthSession.countDocuments({ userId: f.user._id, revokedAt: null })).toBe(1);
  fail.mockRestore();
  expect((await login(f.user)).status).toBe(200);
});

test("unknown migration commit cannot issue a session while preserving the current valid credential", async () => {
  const f = await fixture();
  const startSession = mongoose.startSession.bind(mongoose);
  const uncertain = jest.spyOn(mongoose, "startSession").mockImplementation(async (...args) => {
    const session = await startSession(...args);
    const commit = session.commitTransaction.bind(session);
    session.commitTransaction = async (...options) => {
      await commit(...options);
      const error = new Error("Synthetic lost migration commit acknowledgement");
      error.hasErrorLabel = name => name === "UnknownTransactionCommitResult";
      throw error;
    };
    return session;
  });
  const response = await login(f.user);
  expect(response.status).not.toBe(200);
  expect((response.headers["set-cookie"] || []).some(value => value.startsWith("token="))).toBe(false);
  expect(await AuthSession.countDocuments({ userId: f.user._id, revokedAt: null })).toBe(1);
  expect(await (await stored(f.user)).comparePassword(PASSWORD)).toBe(true);
  uncertain.mockRestore();
  expect((await login(f.user)).status).toBe(200);
});
