const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const crypto = require("crypto");
const fs = require("node:fs");
const User = require("../models/User");
const Notification = require("../models/Notification");
const AuthSession = require("../models/AuthSession");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/auth", require("../routes/auth"));
const PASSWORD = "An isolated admitted paralegal passphrase";
const notifications = user => Notification.find({ userId: user._id, type: "paralegal_welcome" }).lean();
async function fixture(values = {}) {
  return User.create({ firstName: "Admitted", lastName: "Paralegal", email: "admitted.welcome@example.com", password: PASSWORD,
    role: "paralegal", status: "approved", emailVerified: true, state: "NY", ...values });
}
const login = user => request(app).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(clearDatabase);

test("approved first sign-in persists an admitted welcome without pending-admission instructions", async () => {
  const user = await fixture();
  const response = await login(user);
  const rows = await notifications(user);
  expect(rows).toHaveLength(1);
  if (process.env.LPC_WELCOME_OBSERVATIONS_FILE) fs.appendFileSync(process.env.LPC_WELCOME_OBSERVATIONS_FILE, JSON.stringify({
    test: expect.getState().currentTestName, http_status: response.status, persisted_account_status: (await User.findById(user._id)).status,
    active_sessions: await AuthSession.countDocuments({ userId: user._id, revokedAt: null }), notification_type: rows[0].type,
    persisted_body: rows[0].payload.body, persisted_message: rows[0].message,
  }) + "\n");
  expect(response.status).toBe(200);
  expect(rows[0].payload.body).toMatch(/approved/i);
  expect(rows[0].payload.body).not.toMatch(/under review|after approval|decision is recorded/i);
  expect(rows[0].message).toContain(rows[0].payload.body);
  expect(rows[0].payload.body).toMatch(/profile.*Stripe.*browse.*apply/i);
});

test("existing truthful admission history is retained and repeated sign-in does not duplicate welcome", async () => {
  const user = await fixture({ status: "pending" });
  const body = "Your application is under review. We’ll notify you when a decision is recorded.";
  const original = await Notification.create({ userId: user._id, userRole: "paralegal", type: "paralegal_welcome", message: body,
    payload: { title: "Welcome to Let’s-ParaConnect", body }, read: true, isRead: true });
  await User.updateOne({ _id: user._id }, { $set: { status: "approved", approvedAt: new Date() } });
  expect((await login(user)).status).toBe(200);
  expect((await login(user)).status).toBe(200);
  const rows = await notifications(user);
  expect(rows).toHaveLength(1);
  expect(String(rows[0]._id)).toBe(String(original._id));
  expect(rows[0].payload.body).toBe(body);
  expect(rows[0].read).toBe(true);
});

test("an established earlier account is not given a new first-login notification", async () => {
  const user = await fixture({ approvedAt: new Date(Date.now() - 20000), lastLoginAt: new Date(Date.now() - 10000) });
  expect((await login(user)).status).toBe(200);
  expect(await notifications(user)).toHaveLength(0);
});

test.each([{ status: "pending" }, { disabled: true }])("an unavailable account gains no admitted notification or session: %j", async values => {
  const user = await fixture(values);
  expect((await login(user)).status).toBe(403);
  expect(await notifications(user)).toHaveLength(0);
  expect(await AuthSession.countDocuments({ userId: user._id })).toBe(0);
});

test("Attorney first-login behavior does not create a Paralegal welcome", async () => {
  const user = await fixture({ role: "attorney" });
  expect((await login(user)).status).toBe(200);
  expect(await notifications(user)).toHaveLength(0);
});

test("factor completion creates the admitted welcome only after a real managed sign-in", async () => {
  const code = "A1B2-C3D4-E5F6";
  const user = await fixture({ twoFactorEnabled: true, twoFactorMethod: "email", twoFactorBackupCodes: [crypto.createHash("sha256").update(code).digest("hex")] });
  const challenge = await login(user);
  expect(challenge.body.twoFactorRequired).toBe(true);
  expect(await notifications(user)).toHaveLength(0);
  const response = await request(app).post("/api/auth/2fa-backup").send({ challengeToken: challenge.body.challengeToken, code });
  expect(response.status).toBe(200);
  const rows = await notifications(user);
  expect(rows).toHaveLength(1);
  expect(rows[0].payload.body).toMatch(/approved/i);
  expect(rows[0].payload.body).not.toMatch(/under review|after approval/i);
  expect(await AuthSession.countDocuments({ userId: user._id, revokedAt: null })).toBe(1);
});
