const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const AuditLog = require("../models/AuditLog");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/authProviderClient", () => ({
  ...jest.requireActual("../services/authProviderClient"), createGoogleOAuthClient: jest.fn(),
}));
const { createGoogleOAuthClient } = require("../services/authProviderClient");
const sendEmail = require("../utils/email");
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/auth", require("../routes/auth"));
const PASSWORD = "An isolated pending identity factor passphrase";
const BACKUP = "A1B2-C3D4-E5F6";
const PROVIDER = "isolated-pending-provider-id";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const stored = user => User.findById(user._id).select("+authVersion +authProviders +twoFactorChallengeHash +twoFactorChallengeAuthVersion +twoFactorBackupCodes");
const linkCookie = userId => `lpc_google_link=${jwt.sign({ purpose: "google_link", userId: String(userId), providerAccountId: PROVIDER }, process.env.JWT_SECRET, { expiresIn: "10m" })}`;
async function fixture(values = {}) {
  const user = await User.create({ firstName: "Identity", lastName: "Factor", email: "identity.factor@example.com", password: PASSWORD,
    role: "attorney", status: "approved", emailVerified: true, state: "NY", authVersion: 7,
    twoFactorEnabled: true, twoFactorMethod: "email", twoFactorBackupCodes: [hash(BACKUP)], ...values });
  const response = await request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
  expect(response.status).toBe(200);
  expect(response.body.twoFactorRequired).toBe(true);
  return { user, challengeToken: response.body.challengeToken };
}
const verify = (f, cookie = linkCookie(f.user._id)) => request(app).post("/api/auth/2fa-backup").set("Cookie", cookie).send({ challengeToken: f.challengeToken, code: BACKUP });
const clearedLinkCookie = response => (response.headers["set-cookie"] || []).some(value => value.startsWith("lpc_google_link=;") || value.startsWith('lpc_google_link="";'));
const previous = Object.fromEntries(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"].map(key => [key, process.env[key]]));
beforeAll(async () => {
  Object.assign(process.env, { GOOGLE_CLIENT_ID: "isolated-client", GOOGLE_CLIENT_SECRET: "isolated-secret", GOOGLE_REDIRECT_URI: "https://lpc.invalid/api/auth/google/callback" });
  await connect();
});
afterAll(async () => {
  await closeDatabase();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
beforeEach(async () => { await clearDatabase(); jest.clearAllMocks(); sendEmail.mockResolvedValue({ ok: true }); });
afterEach(() => jest.restoreAllMocks());

test("pending identity link, recovery consumption, managed session and success audits commit together", async () => {
  const f = await fixture();
  const response = await verify(f);
  expect(response.status).toBe(200);
  const user = await stored(f.user);
  expect(user.authProviders.map(identity => identity.providerAccountId)).toEqual([PROVIDER]);
  expect(user.twoFactorBackupCodes).toEqual([]);
  expect(user.twoFactorChallengeHash).toBeNull();
  expect(user.twoFactorChallengeAuthVersion).toBeNull();
  expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(1);
  expect(await AuditLog.countDocuments({ action: "auth.google.link.success", targetId: user._id })).toBe(1);
  expect(await AuditLog.countDocuments({ action: "auth.login.success", targetId: user._id })).toBe(1);
  expect(clearedLinkCookie(response)).toBe(true);
});

test("session failure rolls back a pending identity link and retains its cookie and recovery proof", async () => {
  const f = await fixture();
  const before = await stored(f.user);
  const fail = jest.spyOn(AuthSession, "create").mockRejectedValueOnce(new Error("Synthetic pending-identity session failure"));
  const response = await verify(f);
  expect(response.status).toBe(503);
  expect(clearedLinkCookie(response)).toBe(false);
  expect((response.headers["set-cookie"] || []).some(value => value.startsWith("token="))).toBe(false);
  fail.mockRestore();
  const user = await stored(f.user);
  expect(user.authProviders).toHaveLength(0);
  expect(user.twoFactorChallengeHash).toBe(before.twoFactorChallengeHash);
  expect(user.twoFactorBackupCodes).toEqual(before.twoFactorBackupCodes);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(0);
  expect(await AuditLog.countDocuments({ action: "auth.google.link.success", targetId: user._id })).toBe(0);
  expect((await verify(f)).status).toBe(200);
  expect((await stored(f.user)).authProviders).toHaveLength(1);
});

test("a mismatched pending-link owner cannot link an identity while a rightful factor signs in", async () => {
  const f = await fixture();
  const other = new User.db.base.Types.ObjectId();
  const response = await verify(f, linkCookie(other));
  expect(response.status).toBe(200);
  expect((await stored(f.user)).authProviders).toHaveLength(0);
  expect(await AuthSession.countDocuments({ userId: f.user._id })).toBe(1);
  expect(await AuditLog.countDocuments({ action: "auth.google.link.fail", targetId: f.user._id, "meta.reason": "authenticated_user_mismatch" })).toBe(1);
  expect(await AuditLog.countDocuments({ action: "auth.google.link.success" })).toBe(0);
});

test("mocked Google challenge issuance binds a nonzero current version before any session exists", async () => {
  const f = await fixture({ authProviders: [{ provider: "google", providerAccountId: PROVIDER }] });
  sendEmail.mockClear();
  const start = await request(app).get("/api/auth/google").query({ intent: "login" });
  expect(start.status).toBe(302);
  const authorization = new URL(start.headers.location);
  const contextCookie = start.headers["set-cookie"].find(value => value.startsWith("lpc_google_oauth=")).split(";")[0];
  createGoogleOAuthClient.mockReturnValue({
    getToken: jest.fn(async () => ({ tokens: { id_token: "isolated-token" } })),
    verifyIdToken: jest.fn(async () => ({ getPayload: () => ({ sub: PROVIDER, email: f.user.email, email_verified: true, nonce: authorization.searchParams.get("nonce") }) })),
  });
  const callback = await request(app).get("/api/auth/google/callback").query({ state: authorization.searchParams.get("state"), code: "isolated-code" }).set("Cookie", contextCookie);
  expect(callback.headers.location).toContain("google_2fa=1");
  expect((await stored(f.user)).twoFactorChallengeAuthVersion).toBe(7);
  expect(await AuthSession.countDocuments({ userId: f.user._id })).toBe(0);
  const context = await request(app).get("/api/auth/google/2fa-context").set("Cookie", callback.headers["set-cookie"].map(value => value.split(";")[0]));
  const code = sendEmail.mock.calls.find(call => call[1] === "Your verification code")[3].text.match(/code is (\d{6})/)[1];
  const response = await request(app).post("/api/auth/2fa-verify").send({ challengeToken: context.body.challengeToken, code });
  expect(response.status).toBe(200);
  const cookie = response.headers["set-cookie"].find(value => value.startsWith("token=")).split(";")[0].slice(6);
  expect(jwt.verify(decodeURIComponent(cookie), process.env.JWT_SECRET).av).toBe(7);
  expect(await AuthSession.countDocuments({ userId: f.user._id })).toBe(1);
});
