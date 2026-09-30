const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const User = require("../models/User");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../utils/googleOAuth", () => ({
  ...jest.requireActual("../utils/googleOAuth"),
  verifiedProfile: jest.fn(),
}));
const { verifiedProfile } = require("../utils/googleOAuth");
const authRouter = require("../routes/auth");

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use("/api/auth", authRouter);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

beforeAll(async () => { await connect(); });
afterAll(async () => { await closeDatabase(); });
beforeEach(async () => {
  await clearDatabase();
  verifiedProfile.mockReset();
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://www.lets-paraconnect.com/api/auth/google/callback";
  process.env.JWT_SECRET = "test-only-jwt-secret-longer-than-thirty-two-bytes";
});

function challenge(response) {
  const url = new URL(response.headers.location);
  expect(url.hostname).toBe("accounts.google.com");
  return { state: url.searchParams.get("state"), nonce: url.searchParams.get("nonce") };
}

test("Google signup verifies state and binds the provider identity to the submitted email", async () => {
  const agent = request.agent(app);
  const start = await agent.get("/api/auth/google?intent=signup&role=attorney");
  expect(start.status).toBe(302);
  const { state, nonce } = challenge(start);
  verifiedProfile.mockResolvedValue({ sub: "google-sub-1", email: "alex@example.com", email_verified: true, nonce, given_name: "Alex", family_name: "Lee" });

  const callback = await agent.get(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=test-code`);
  expect(callback.status).toBe(302);
  expect(callback.headers.location).toBe("/signup.html?google=1&role=attorney");
  expect((await agent.get("/api/auth/google/signup-profile")).body.profile.email).toBe("alex@example.com");

  const wrongEmail = await agent.post("/api/auth/register").send({
    firstName: "Alex", lastName: "Lee", email: "different@example.com", password: "Password123!",
    role: "attorney", state: "CA", barNumber: "CA-12345", barState: "CA",
    attorneyPricingAccepted: true, termsAccepted: true, googleSignupIntent: true,
  });
  expect(wrongEmail.status).toBe(400);

  const signup = await agent.post("/api/auth/register").send({
    firstName: "Alex", lastName: "Lee", email: "alex@example.com", password: "Password123!",
    role: "attorney", state: "CA", barNumber: "CA-12345", barState: "CA",
    attorneyPricingAccepted: true, termsAccepted: true, googleSignupIntent: true,
  });
  expect(signup.status).toBe(200);
  const user = await User.findOne({ email: "alex@example.com" }).select("+authProviders");
  expect(user.emailVerified).toBe(true);
  expect(user.authProviders[0].providerAccountId).toBe("google-sub-1");
});

test("Google callback rejects a mismatched state before exchanging a code", async () => {
  const agent = request.agent(app);
  await agent.get("/api/auth/google?intent=login");
  const callback = await agent.get("/api/auth/google/callback?state=wrong&code=test-code");
  expect(callback.status).toBe(302);
  expect(callback.headers.location).toBe("/login.html?google_error=invalid_state");
  expect(verifiedProfile).not.toHaveBeenCalled();
});

test("Google login accepts an approved account with its linked provider identity", async () => {
  await User.create({
    firstName: "Pat", lastName: "Lee", email: "pat@example.com", password: "Password123!",
    role: "paralegal", status: "approved", state: "NY", emailVerified: true,
    authProviders: [{ provider: "google", providerAccountId: "google-sub-2" }],
  });
  const agent = request.agent(app);
  const { state, nonce } = challenge(await agent.get("/api/auth/google?intent=login"));
  verifiedProfile.mockResolvedValue({ sub: "google-sub-2", email: "pat@example.com", email_verified: true, nonce });
  const callback = await agent.get(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=test-code`);
  expect(callback.status).toBe(302);
  expect(callback.headers.location).toBe("/dashboard-paralegal.html");
  expect(callback.headers["set-cookie"].some(value => value.startsWith("token="))).toBe(true);
});

test("an existing email is linked only after a successful password sign-in", async () => {
  const user = await User.create({
    firstName: "Sam", lastName: "Lee", email: "sam@example.com", password: "Password123!",
    role: "attorney", status: "approved", state: "CA", emailVerified: true,
  });
  const agent = request.agent(app);
  const { state, nonce } = challenge(await agent.get("/api/auth/google?intent=login"));
  verifiedProfile.mockResolvedValue({ sub: "google-sub-3", email: "sam@example.com", email_verified: true, nonce });
  const callback = await agent.get(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=test-code`);
  expect(callback.headers.location).toBe("/login.html?google_error=matching_email_unlinked");
  expect((await User.findById(user._id).select("+authProviders")).authProviders).toHaveLength(0);
  const badLogin = await agent.post("/api/auth/login").send({ email: "sam@example.com", password: "wrong" });
  expect(badLogin.status).toBe(401);
  expect((await User.findById(user._id).select("+authProviders")).authProviders).toHaveLength(0);
  const login = await agent.post("/api/auth/login").send({ email: "sam@example.com", password: "Password123!" });
  expect(login.status).toBe(200);
  expect((await User.findById(user._id).select("+authProviders")).authProviders[0].providerAccountId).toBe("google-sub-3");
});

test("Google login requires password sign-in for accounts with two-step verification", async () => {
  await User.create({
    firstName: "Taylor", lastName: "Lee", email: "taylor@example.com", password: "Password123!",
    role: "paralegal", status: "approved", state: "NY", emailVerified: true,
    twoFactorEnabled: true,
    authProviders: [{ provider: "google", providerAccountId: "google-sub-4" }],
  });
  const agent = request.agent(app);
  const { state, nonce } = challenge(await agent.get("/api/auth/google?intent=login"));
  verifiedProfile.mockResolvedValue({ sub: "google-sub-4", email: "taylor@example.com", email_verified: true, nonce });
  const callback = await agent.get(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=test-code`);
  expect(callback.headers.location).toBe("/login.html?google_error=two_factor_password");
  expect((callback.headers["set-cookie"] || []).some(value => value.startsWith("token="))).toBe(false);
});
