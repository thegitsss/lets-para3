const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const bcrypt = require("bcryptjs");
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
const PASSWORD = "An isolated account lock policy passphrase";
const NEW_PASSWORD = "A newer isolated account lock policy passphrase";
const WRONG = "An incorrect isolated credential passphrase";
const stored = user => User.findById(user._id).select("+password +authVersion");
const login = (user, password = WRONG) => request(app).post("/api/auth/login").send({ email: user.email, password });
async function fixture(role = "attorney", status = "approved") {
  return User.create({ firstName: "Lock", lastName: "Policy", email: `${role}.lock@example.com`, password: PASSWORD,
    role, status, emailVerified: true, state: "NY", authVersion: 6 });
}
function afterWrongComparison(user, work) {
  const original = User.prototype.comparePassword;
  let used = false;
  jest.spyOn(User.prototype, "comparePassword").mockImplementation(async function (password) {
    const match = await original.call(this, password);
    if (!used && String(this._id) === String(user._id) && password === WRONG) {
      used = true;
      await work();
    }
    return match;
  });
}
async function observe(user, responses) {
  if (!process.env.LPC_PASSWORD_LOCK_OBSERVATIONS_FILE) return;
  const current = await stored(user);
  fs.appendFileSync(process.env.LPC_PASSWORD_LOCK_OBSERVATIONS_FILE, JSON.stringify({
    test: expect.getState().currentTestName, http_statuses: responses.map(response => response.status),
    failed_logins: current.failedLogins, locked: current.isLocked,
    lock_remaining_ms: current.lockedUntil ? current.lockedUntil.getTime() - Date.now() : null,
    auth_version: current.authVersion, active_sessions: await AuthSession.countDocuments({ userId: user._id, revokedAt: null }),
  }) + "\n");
}
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); sendEmail.mockClear(); });
afterEach(() => jest.restoreAllMocks());

for (const role of ["attorney", "paralegal"]) {
  test(`${role} password-login counts five simultaneous failures and applies the existing account lock`, async () => {
    const user = await fixture(role);
    const original = User.prototype.comparePassword;
    let arrived = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    jest.spyOn(User.prototype, "comparePassword").mockImplementation(async function (password) {
      const match = await original.call(this, password);
      if (String(this._id) === String(user._id) && password === WRONG) {
        arrived += 1;
        if (arrived === 5) release();
        await gate;
      }
      return match;
    });
    const responses = await Promise.all(Array.from({ length: 5 }, () => login(user)));
    await observe(user, responses);
    expect(responses.map(response => response.status)).toEqual([401, 401, 401, 401, 401]);
    const current = await stored(user);
    expect(current.isLocked).toBe(true);
    expect(current.failedLogins).toBe(0);
    expect(current.lockedUntil.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(current.lockedUntil.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    expect((await login(user, PASSWORD)).status).toBe(401);
    expect(await AuthSession.countDocuments({ userId: user._id })).toBe(0);
  });
  test(`${role} password-login retains sequential threshold and permits sign-in after existing lock expiry`, async () => {
    const user = await fixture(role);
    for (let n = 0; n < 5; n += 1) expect((await login(user)).status).toBe(401);
    expect((await stored(user)).isLocked).toBe(true);
    await User.collection.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await login(user, PASSWORD)).status).toBe(200);
    const current = await stored(user);
    expect(current.failedLogins).toBe(0);
    expect(current.lockedUntil).toBeNull();
    expect(current.authVersion).toBe(6);
  });
  for (const change of ["reset", "password change"]) {
    test(`${role} stale password-login failure cannot change lock state after an actual ${change}`, async () => {
      const user = await fixture(role);
      const agent = request.agent(app);
      expect((await agent.post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
      expect((await request(app).post("/api/auth/request-password-reset").send({ email: user.email })).status).toBe(200);
      const token = sendEmail.mock.calls.filter(call => call[1] === "Reset your LPC password").at(-1)[3].text.match(/token=([^\s]+)/)[1];
      afterWrongComparison(user, async () => {
        const response = change === "reset"
          ? await request(app).post("/api/auth/reset-password").send({ token, newPassword: NEW_PASSWORD })
          : await agent.post("/api/account/update-password").send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
        expect(response.status).toBe(200);
      });
      expect((await login(user)).status).toBe(401);
      const current = await stored(user);
      expect(current.failedLogins).toBe(0);
      expect(current.isLocked).toBe(false);
      expect(current.authVersion).toBe(7);
      expect(await current.comparePassword(NEW_PASSWORD)).toBe(true);
      expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(0);
    });
  }
}

test.each(["pending", "denied"])("wrong password-login retains counting and cannot admit a %s account", async status => {
  const user = await fixture("paralegal", status);
  expect((await login(user)).status).toBe(401);
  expect((await stored(user)).failedLogins).toBe(1);
  expect((await login(user, PASSWORD)).status).toBe(403);
  expect((await stored(user)).status).toBe(status);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(0);
});
test.each(["disabled", "deleted"])("stale password-login failure does not mutate a newly %s account", async field => {
  const user = await fixture();
  afterWrongComparison(user, () => User.collection.updateOne({ _id: user._id }, { $set: { [field]: true } }));
  expect((await login(user)).status).toBe(401);
  expect((await stored(user)).failedLogins).toBe(0);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(0);
});
test("stale password-login failure cannot overwrite the success state of an actual legacy migration", async () => {
  const user = await fixture();
  await User.collection.updateOne({ _id: user._id }, { $set: { password: await bcrypt.hash(PASSWORD, 10) } });
  afterWrongComparison(user, async () => { expect((await login(user, PASSWORD)).status).toBe(200); });
  expect((await login(user)).status).toBe(401);
  const current = await stored(user);
  expect(current.password.startsWith("$argon2")).toBe(true);
  expect(current.failedLogins).toBe(0);
  expect(current.authVersion).toBe(6);
  expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(1);
});
test("password-login counter persistence failure leaves no partial count or session and can retry", async () => {
  const user = await fixture();
  const update = User.collection.updateOne.bind(User.collection);
  const fail = jest.spyOn(User.collection, "updateOne").mockImplementation(async (filter, change, options) => {
    if (Array.isArray(change)) throw new Error("Synthetic isolated login counter write failure");
    return update(filter, change, options);
  });
  expect((await login(user)).status).not.toBe(200);
  expect((await stored(user)).failedLogins).toBe(0);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(0);
  fail.mockRestore();
  expect((await login(user)).status).toBe(401);
  expect((await stored(user)).failedLogins).toBe(1);
});

test.each([["attorney", "zero"], ["paralegal", "missing"]])("%s password-login retains lock counting for an existing %s authVersion", async (role, kind) => {
  const user = await fixture(role);
  await User.collection.updateOne({ _id: user._id }, kind === "zero" ? { $set: { authVersion: 0 } } : { $unset: { authVersion: 1 } });
  for (let n = 0; n < 5; n += 1) expect((await login(user)).status).toBe(401);
  const current = await stored(user);
  expect(current.isLocked).toBe(true);
  expect(current.failedLogins).toBe(0);
  expect(current.authVersion).toBe(0);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(0);
});
