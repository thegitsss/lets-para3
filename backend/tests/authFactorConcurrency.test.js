const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const fs = require("node:fs");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const AuditLog = require("../models/AuditLog");
const authRouter = require("../routes/auth");
const accountRouter = require("../routes/account");
const sendEmail = require("../utils/email");
const { createTotpEnrollment, generateTotpToken } = require("../services/mfaService");
const { createAuthSession } = require("../services/authSessionService");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.use("/api/account", accountRouter);
app.use((error, _req, res, _next) => res.status(error.statusCode || error.status || 500).json({ error: "Isolated handler failure", code: error.publicCode || error.code }));

const PASSWORD = "An isolated factor concurrency passphrase";
const BACKUP = "A1B2-C3D4-E5F6";
const OTHER_BACKUP = "1234-5678-ABCD";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const stored = user => User.findById(user._id).select("+authVersion +twoFactorChallengeHash +twoFactorChallengeAuthVersion +twoFactorTempCode +twoFactorExpiresAt +twoFactorBackupCodes +twoFactorFailedAttempts +totpLastUsedTimeStep");
const sessions = user => AuthSession.countDocuments({ userId: user._id, revokedAt: null });

async function fixture(role = "attorney", method = "email") {
  const user = await User.create({ firstName: "Factor", lastName: "Concurrency", email: `${role}.factor@example.com`, password: PASSWORD, role, status: "approved", emailVerified: true, state: "NY" });
  const agent = request.agent(app);
  expect((await agent.post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
  const enrollment = await createTotpEnrollment(user.email);
  await User.updateOne({ _id: user._id }, { $set: { twoFactorEnabled: true, twoFactorMethod: method === "totp" ? "authenticator" : "email", twoFactorBackupCodes: [hash(BACKUP), hash(OTHER_BACKUP)], ...(method === "totp" ? { totpSecretEncrypted: enrollment.encryptedSecret } : {}) } });
  const begin = await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
  expect(begin.status).toBe(200);
  expect(begin.body.twoFactorRequired).toBe(true);
  if(method!=="totp") {
    const message=sendEmail.mock.calls.filter(call=>call[1]==="Your verification code").at(-1);
    expect(message[2]).toContain('data-lpc-account-footer="true"');
    expect(message[2]).toContain('/'+role+'-faq.html');
    expect(message[2]).toContain('background:#eef3fb');
  }
  const code = method === "totp" ? generateTotpToken(enrollment.secret).token : sendEmail.mock.calls.filter(call => call[1] === "Your verification code").at(-1)[3].text.match(/code is (\d{6})/)[1];
  return { user, agent, challengeToken: begin.body.challengeToken, code, method, secret: enrollment.secret };
}
const verify = (f, code = f.method === "backup" ? BACKUP : f.code) => request(app).post(`/api/auth/${f.method === "backup" ? "2fa-backup" : "2fa-verify"}`).send({ challengeToken: f.challengeToken, code });
const tokenCookie = response => (response.headers["set-cookie"] || []).find(value => value.startsWith("token="));
async function evidence(f, responses) {
  if (!process.env.LPC_FACTOR_OBSERVATIONS_FILE) return;
  const user = await stored(f.user);
  fs.appendFileSync(process.env.LPC_FACTOR_OBSERVATIONS_FILE, JSON.stringify({ test: expect.getState().currentTestName,
    statuses: responses.map(response => response.status), token_cookies: responses.filter(tokenCookie).length,
    persisted_active_sessions: await sessions(f.user), persisted_login_audits: await AuditLog.countDocuments({ action: "auth.login.success", targetId: f.user._id }),
    auth_version: user.authVersion, challenge_still_present: Boolean(user.twoFactorChallengeHash), backup_hash_count: user.twoFactorBackupCodes.length,
    original_backup_still_present: user.twoFactorBackupCodes.includes(hash(BACKUP)), totp_step_recorded: Number.isInteger(user.totpLastUsedTimeStep),
  }) + "\n");
}

// Both real handlers reach the same persisted challenge before either writes.
// Transaction retries after the first two reads proceed without the barrier.
function simultaneousReads(challengeToken, count = 2) {
  const find = User.findOne;
  let seen = 0;
  let release;
  const all = new Promise(resolve => { release = resolve; });
  jest.spyOn(User, "findOne").mockImplementation(function (filter, ...args) {
    const query = find.call(this, filter, ...args);
    if (filter?.twoFactorChallengeHash === hash(challengeToken)) {
      const exec = query.exec.bind(query);
      query.exec = async (...options) => {
        const user = await exec(...options);
        if (seen < count) { seen += 1; if (seen === count) release(); await all; }
        return user;
      };
    }
    return query;
  });
}
function interleave(challengeToken, action) {
  const find = User.findOne;
  let used = false;
  jest.spyOn(User, "findOne").mockImplementation(function (filter, ...args) {
    const query = find.call(this, filter, ...args);
    if (filter?.twoFactorChallengeHash === hash(challengeToken)) {
      const exec = query.exec.bind(query);
      query.exec = async (...options) => {
        const user = await exec(...options);
        if (!used) { used = true; await action(); }
        return user;
      };
    }
    return query;
  });
}

beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); sendEmail.mockClear(); });
afterEach(() => jest.restoreAllMocks());

for (const role of ["attorney", "paralegal"]) {
  for (const method of ["email", "totp", "backup"]) {
    test(`${role} concurrent ${method} claims persist exactly one new session`, async () => {
      const f = await fixture(role, method);
      simultaneousReads(f.challengeToken);
      const responses = await Promise.all([verify(f), verify(f)]);
      await evidence(f, responses);
      expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
      expect(await sessions(f.user)).toBe(2); // One preexisting device plus one accepted factor.
      expect(responses.filter(tokenCookie)).toHaveLength(1);
      const user = await stored(f.user);
      expect(user.twoFactorChallengeHash).toBeNull();
      expect(user.authVersion).toBe(0);
      if (method === "backup") expect(user.twoFactorBackupCodes).toEqual([hash(OTHER_BACKUP)]);
      if (method === "totp") expect(user.totpLastUsedTimeStep).toEqual(expect.any(Number));
      expect(await AuditLog.countDocuments({ action: "auth.login.success", targetId: f.user._id })).toBe(2);
    });
  }
  test(`${role} a real intervening password change invalidates the old factor challenge`, async () => {
    const f = await fixture(role, "backup");
    interleave(f.challengeToken, async () => {
      const response = await f.agent.post("/api/account/update-password").send({ currentPassword: PASSWORD, newPassword: "An intervening isolated factor passphrase" });
      expect(response.status).toBe(200);
    });
    const response = await verify(f);
    await evidence(f, [response]);
    expect(response.status).toBe(400);
    expect(tokenCookie(response)).toBeUndefined();
    expect(await sessions(f.user)).toBe(0);
    expect((await stored(f.user)).twoFactorBackupCodes).toEqual([hash(BACKUP), hash(OTHER_BACKUP)]);
    expect((await stored(f.user)).authVersion).toBe(1);
  });
  test(`${role} an already changed password cannot redeem an earlier password-verified factor challenge`, async () => {
    const f = await fixture(role, "backup");
    expect((await f.agent.post("/api/account/update-password").send({ currentPassword: PASSWORD, newPassword: "Another intervening isolated factor passphrase" })).status).toBe(200);
    const response = await verify(f);
    await evidence(f, [response]);
    expect(response.status).toBe(400);
    expect(await sessions(f.user)).toBe(0);
    expect((await stored(f.user)).twoFactorBackupCodes).toContain(hash(BACKUP));
  });
}

test("concurrent distinct recovery codes consume only the winning code and one challenge", async () => {
  const f = await fixture("attorney", "backup");
  simultaneousReads(f.challengeToken);
  const codes = [BACKUP, OTHER_BACKUP];
  const responses = await Promise.all(codes.map(code => verify(f, code)));
  expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  expect((await stored(f.user)).twoFactorBackupCodes).toEqual([hash(codes[responses.findIndex(response => response.status !== 200)])]);
  expect(await sessions(f.user)).toBe(2);
});

test.each(["email", "backup"])("concurrent incorrect %s attempts cannot lose the five-attempt limit", async method => {
  const f = await fixture("attorney", method);
  simultaneousReads(f.challengeToken, 5);
  const responses = await Promise.all(Array.from({ length: 5 }, () => verify(f, method === "backup" ? "NOT-A-CODE" : "000000")));
  expect(responses.filter(response => response.status === 429)).toHaveLength(1);
  expect(responses.filter(response => response.status === 400)).toHaveLength(4);
  expect((await stored(f.user)).twoFactorChallengeHash).toBeNull();
  expect(await sessions(f.user)).toBe(1);
  expect((await verify(f)).status).toBe(400);
});

test.each(["disabled", "deleted"])("%s between factor read and claim fails closed without consuming recovery", async field => {
  const f = await fixture("attorney", "backup");
  interleave(f.challengeToken, () => User.updateOne({ _id: f.user._id }, { $set: { [field]: true } }));
  const response = await verify(f);
  await evidence(f, [response]);
  expect(response.status).toBe(403);
  expect(tokenCookie(response)).toBeUndefined();
  expect(await sessions(f.user)).toBe(1);
  expect((await stored(f.user)).twoFactorBackupCodes).toEqual([hash(BACKUP), hash(OTHER_BACKUP)]);
});

test("newer sign-in challenge wins an interleaved old-factor claim", async () => {
  const f = await fixture("attorney", "backup");
  let replacement;
  interleave(f.challengeToken, async () => {
    const response = await request(app).post("/api/auth/login").send({ email: f.user.email, password: PASSWORD });
    expect(response.status).toBe(200);
    replacement = response.body.challengeToken;
  });
  expect((await verify(f)).status).toBe(400);
  expect((await stored(f.user)).twoFactorChallengeHash).toBe(hash(replacement));
  expect((await stored(f.user)).twoFactorBackupCodes).toContain(hash(BACKUP));
  expect(await sessions(f.user)).toBe(1);
});

test("a recovery rotation cannot restore or redeem a superseded recovery code", async () => {
  const f = await fixture("attorney", "backup");
  let newCodes;
  interleave(f.challengeToken, async () => {
    const response = await f.agent.post("/api/account/2fa-backup-codes").send({ currentPassword: PASSWORD });
    expect(response.status).toBe(200);
    newCodes = response.body.codes.map(hash);
  });
  expect((await verify(f)).status).toBe(400);
  expect((await stored(f.user)).twoFactorBackupCodes).toEqual(newCodes);
  expect(await sessions(f.user)).toBe(1);
});

test("session insertion failure rolls back factor claim, recovery consumption and login audit", async () => {
  const f = await fixture("attorney", "backup");
  const before = await stored(f.user);
  const fail = jest.spyOn(AuthSession, "create").mockRejectedValueOnce(new Error("Synthetic isolated session failure"));
  const response = await verify(f);
  expect(response.status).toBe(503);
  expect(tokenCookie(response)).toBeUndefined();
  fail.mockRestore();
  const after = await stored(f.user);
  expect(after.twoFactorChallengeHash).toBe(before.twoFactorChallengeHash);
  expect(after.twoFactorBackupCodes).toEqual(before.twoFactorBackupCodes);
  expect(after.lastLoginAt).toEqual(before.lastLoginAt);
  expect(await sessions(f.user)).toBe(1);
  expect(await AuditLog.countDocuments({ action: "auth.login.success", targetId: f.user._id })).toBe(1);
  expect((await verify(f)).status).toBe(200);
  expect(await sessions(f.user)).toBe(2);
});

test("lost commit acknowledgement sets no cookie and cannot replay a committed factor", async () => {
  const f = await fixture("attorney", "backup");
  const startSession = User.db.startSession.bind(User.db);
  const uncertain = jest.spyOn(User.db, "startSession").mockImplementation(async (...args) => {
    const session = await startSession(...args);
    const transaction = session.withTransaction.bind(session);
    session.withTransaction = async (...options) => {
      await transaction(...options);
      const error = new Error("Synthetic lost factor commit acknowledgement");
      error.hasErrorLabel = label => label === "UnknownTransactionCommitResult";
      throw error;
    };
    return session;
  });
  const response = await verify(f);
  expect(response.status).toBe(503);
  expect(response.body.code).toBe("FACTOR_SIGN_IN_UNCONFIRMED");
  expect(tokenCookie(response)).toBeUndefined();
  uncertain.mockRestore();
  expect(await sessions(f.user)).toBe(2);
  expect((await stored(f.user)).twoFactorBackupCodes).toEqual([hash(OTHER_BACKUP)]);
  expect((await verify(f)).status).toBe(400);
  expect(await sessions(f.user)).toBe(2);
});

test.each(["email", "totp", "backup"])("expired %s challenge creates no session and preserves recovery material", async method => {
  const f = await fixture("paralegal", method);
  await User.updateOne({ _id: f.user._id }, { $set: { twoFactorExpiresAt: new Date(Date.now() - 1000) } });
  expect((await verify(f)).status).toBe(400);
  expect(await sessions(f.user)).toBe(1);
  expect((await stored(f.user)).twoFactorBackupCodes).toContain(hash(BACKUP));
});

test("successful factor cookie and persisted managed session share current authVersion and owner", async () => {
  const f = await fixture("paralegal", "backup");
  const response = await verify(f);
  expect(response.status).toBe(200);
  const payload = jwt.verify(decodeURIComponent(tokenCookie(response).split(";")[0].slice(6)), process.env.JWT_SECRET);
  expect(payload.id).toBe(String(f.user._id));
  expect(payload.av).toBe((await stored(f.user)).authVersion);
  expect(await AuthSession.findOne({ userId: f.user._id, sessionId: payload.sid, revokedAt: null })).toBeTruthy();
});

test.each(["email", "backup"])("an unbound legacy %s challenge fails closed and requests another sign-in", async method => {
  const f = await fixture("attorney", method);
  await User.collection.updateOne({ _id: f.user._id }, { $unset: { twoFactorChallengeAuthVersion: "" } });
  const response = await verify(f);
  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/sign in again/i);
  expect(tokenCookie(response)).toBeUndefined();
  expect(await sessions(f.user)).toBe(1);
  expect((await stored(f.user)).twoFactorChallengeHash).toBeNull();
  expect((await stored(f.user)).twoFactorBackupCodes).toContain(hash(BACKUP));
});

test("challenge issuing version is current, selected only privately, and excluded from JSON", async () => {
  const f = await fixture("paralegal", "email");
  const privateUser = await stored(f.user);
  expect(privateUser.twoFactorChallengeAuthVersion).toBe(privateUser.authVersion);
  expect((await User.findById(f.user._id)).twoFactorChallengeAuthVersion).toBeUndefined();
  expect(privateUser.toJSON()).not.toHaveProperty("twoFactorChallengeAuthVersion");
  const response = await verify(f);
  expect(response.body.user).not.toHaveProperty("twoFactorChallengeAuthVersion");
  expect((await stored(f.user)).twoFactorChallengeAuthVersion).toBeNull();
});

test("a reused TOTP time step cannot redeem a freshly issued challenge", async () => {
  const f = await fixture("attorney", "totp");
  expect((await verify(f)).status).toBe(200);
  const login = await request(app).post("/api/auth/login").send({ email: f.user.email, password: PASSWORD });
  f.challengeToken = login.body.challengeToken;
  expect((await verify(f)).status).toBe(400);
  expect(await sessions(f.user)).toBe(2);
});

test("an actual MFA disable between read and claim cannot consume recovery or create a session", async () => {
  const f = await fixture("paralegal", "backup");
  interleave(f.challengeToken, async () => {
    expect((await f.agent.post("/api/account/2fa-toggle").send({ currentPassword: PASSWORD, enabled: false })).status).toBe(200);
  });
  expect((await verify(f)).status).toBe(400);
  expect(await sessions(f.user)).toBe(1);
  expect((await stored(f.user)).twoFactorEnabled).toBe(false);
  expect((await stored(f.user)).twoFactorBackupCodes).toEqual([]);
});

test("login audit failure rolls back a factor-created session and recovery code", async () => {
  const f = await fixture("attorney", "backup");
  const before = await stored(f.user);
  const audit = AuditLog.logFromReq;
  const fail = jest.spyOn(AuditLog, "logFromReq").mockImplementation(async function (req, action, ...options) {
    if (action === "auth.login.success") throw new Error("Synthetic isolated factor audit failure");
    return audit.call(this, req, action, ...options);
  });
  const response = await verify(f);
  expect(response.status).toBe(503);
  expect(tokenCookie(response)).toBeUndefined();
  fail.mockRestore();
  expect(await sessions(f.user)).toBe(1);
  expect((await stored(f.user)).twoFactorChallengeHash).toBe(before.twoFactorChallengeHash);
  expect((await stored(f.user)).twoFactorBackupCodes).toEqual(before.twoFactorBackupCodes);
});

test("reused transaction session creation rejects stale version and abort removes its insertion", async () => {
  const f = await fixture("attorney", "email");
  const user = await stored(f.user);
  const session = await User.db.startSession();
  try {
    session.startTransaction();
    await expect(createAuthSession({ _id: user._id, authVersion: user.authVersion + 1 }, {}, { session })).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await session.abortTransaction();
    session.startTransaction();
    const result = await createAuthSession(user, {}, { session });
    expect(result.sessionId).toEqual(expect.any(String));
    await session.abortTransaction();
    expect(await sessions(f.user)).toBe(1);
  } finally { await session.endSession(); }
});

test("a supplied session without an active transaction cannot bypass the account guard", async () => {
  const f = await fixture("attorney", "email");
  const session = await User.db.startSession();
  try {
    await expect(createAuthSession(await stored(f.user), {}, { session })).rejects.toThrow("requires a transaction");
    expect(await sessions(f.user)).toBe(1);
  } finally { await session.endSession(); }
});
