const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");

const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const authRouter = require("../routes/auth");
const accountRouter = require("../routes/account");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const sendEmail = require("../utils/email");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use("/api/auth", authRouter);
app.use("/api/account", accountRouter);

const credentials = {
  email: "security.member@example.com",
  password: "A secure current passphrase",
};

async function createApprovedUser() {
  return User.create({
    firstName: "Security",
    lastName: "Member",
    email: credentials.email,
    password: credentials.password,
    role: "attorney",
    status: "approved",
    emailVerified: true,
    state: "NY",
  });
}

async function login(agent = request.agent(app)) {
  const response = await agent.post("/api/auth/login").send(credentials);
  return { agent, response };
}

beforeAll(connect);
afterAll(closeDatabase);

beforeEach(async () => {
  await clearDatabase();
  sendEmail.mockClear();
  await createApprovedUser();
});

describe("managed authentication security", () => {
  test("password changes revoke every existing session and require reauthentication", async () => {
    const { agent, response } = await login();
    expect(response.status).toBe(200);
    expect(await AuthSession.countDocuments({ revokedAt: null })).toBe(1);

    const changed = await agent.post("/api/account/update-password").send({
      currentPassword: credentials.password,
      newPassword: "A newer secure account passphrase",
    });
    expect(changed.status).toBe(200);
    expect(changed.body.reauthenticationRequired).toBe(true);
    expect(await AuthSession.countDocuments({ revokedAt: null })).toBe(0);

    const staleSession = await agent.get("/api/account/preferences");
    expect(staleSession.status).toBe(403);
  });

  test("a user can inspect sessions and revoke every other device", async () => {
    const first = await login();
    const second = await login();
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);

    const listed = await first.agent.get("/api/account/sessions");
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(2);
    expect(listed.body.sessions.filter((session) => session.current)).toHaveLength(1);

    const revoked = await first.agent.post("/api/account/sessions/revoke-others");
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedCount).toBe(1);
    expect((await first.agent.get("/api/account/preferences")).status).toBe(200);
    expect((await second.agent.get("/api/account/preferences")).status).toBe(403);
  });

  test("two-step changes require the current password and backup codes work once", async () => {
    const { agent } = await login();
    const rejected = await agent.post("/api/account/2fa-toggle").send({
      enabled: true,
      method: "email",
      currentPassword: "wrong password value",
    });
    expect(rejected.status).toBe(400);

    const enabled = await agent.post("/api/account/2fa-toggle").send({
      enabled: true,
      method: "email",
      currentPassword: credentials.password,
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);

    const codesResponse = await agent.post("/api/account/2fa-backup-codes").send({
      currentPassword: credentials.password,
    });
    expect(codesResponse.status).toBe(200);
    expect(codesResponse.body.codes).toHaveLength(8);
    const backupCode = codesResponse.body.codes[0];

    await agent.post("/api/auth/logout");
    const challenged = await request(app).post("/api/auth/login").send(credentials);
    expect(challenged.status).toBe(200);
    expect(challenged.body.twoFactorRequired).toBe(true);
    expect(challenged.body.challengeToken).toBeTruthy();
    expect(challenged.body.email).toBeUndefined();

    const backupLogin = await request(app).post("/api/auth/2fa-backup").send({
      challengeToken: challenged.body.challengeToken,
      code: backupCode,
    });
    expect(backupLogin.status).toBe(200);
    expect(backupLogin.body.success).toBe(true);

    const nextChallenge = await request(app).post("/api/auth/login").send(credentials);
    const reused = await request(app).post("/api/auth/2fa-backup").send({
      challengeToken: nextChallenge.body.challengeToken,
      code: backupCode,
    });
    expect(reused.status).toBe(400);
    expect(reused.body.error).toMatch(/invalid backup code/i);
  });

  test("five incorrect verification codes invalidate the challenge", async () => {
    const { agent } = await login();
    await agent.post("/api/account/2fa-toggle").send({
      enabled: true,
      method: "email",
      currentPassword: credentials.password,
    });
    await agent.post("/api/auth/logout");

    const challenged = await request(app).post("/api/auth/login").send(credentials);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await request(app).post("/api/auth/2fa-verify").send({
        challengeToken: challenged.body.challengeToken,
        code: "000000",
      });
      expect(response.status).toBe(attempt === 5 ? 429 : 400);
    }

    const afterInvalidation = await request(app).post("/api/auth/2fa-verify").send({
      challengeToken: challenged.body.challengeToken,
      code: "000000",
    });
    expect(afterInvalidation.status).toBe(400);
    expect(afterInvalidation.body.error).toMatch(/invalid 2fa attempt/i);
  });

  test("authenticator-app setup requires password confirmation and signs in without sending email codes", async () => {
    const { agent } = await login();
    const rejected = await agent.post("/api/account/2fa/authenticator/setup").send({
      currentPassword: "wrong password value",
    });
    expect(rejected.status).toBe(400);

    const setup = await agent.post("/api/account/2fa/authenticator/setup").send({
      currentPassword: credentials.password,
    });
    expect(setup.status).toBe(200);
    expect(setup.body.challengeId).toBeTruthy();
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.body.manualSecret).toBeTruthy();

    const { generateTotpToken } = require("../services/mfaService");
    const code = generateTotpToken(setup.body.manualSecret).token;
    const confirmed = await agent.post("/api/account/2fa/authenticator/confirm").send({
      challengeId: setup.body.challengeId,
      code,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.method).toBe("authenticator");
    expect(confirmed.body.backupCodes).toHaveLength(8);

    sendEmail.mockClear();
    await agent.post("/api/auth/logout");
    const challenged = await request(app).post("/api/auth/login").send(credentials);
    expect(challenged.status).toBe(200);
    expect(challenged.body.method).toBe("authenticator");
    expect(challenged.body.destination).toBe("your authenticator app");
    expect(sendEmail).not.toHaveBeenCalled();

    const loginCode = generateTotpToken(setup.body.manualSecret).token;
    const verified = await request(app).post("/api/auth/2fa-verify").send({
      challengeToken: challenged.body.challengeToken,
      code: loginCode,
    });
    expect(verified.status).toBe(200);
    expect(verified.body.success).toBe(true);
  });
});
