const request = require("supertest");
const User = require("../models/User");
const AuthSession = require("../models/AuthSession");
const { connect, clearDatabase, closeDatabase } = require("./helpers/db");
const { buildTestApp } = require("./helpers/testApp");
const { verifyAuthentication } = require("../services/passkeyService");

jest.mock("../utils/email", () => jest.fn(async () => ({ ok: true })));
jest.mock("../services/passkeyService", () => ({
  ...jest.requireActual("../services/passkeyService"),
  verifyAuthentication: jest.fn(),
}));

const app = buildTestApp();
beforeAll(connect);
afterAll(closeDatabase);
beforeEach(async () => { await clearDatabase(); verifyAuthentication.mockReset(); });

async function account(role, status, emailVerified) {
  return User.create({ firstName: "Passkey", lastName: "Review", email: `${role}@example.test`,
    password: "A unique test passphrase", role, status, emailVerified, state: "CA" });
}
const signIn = () => request(app).post("/api/auth/passkeys/authenticate")
  .send({ challengeId: "controlled-challenge", response: { id: "controlled-credential" } });

for (const role of ["attorney", "paralegal"]) {
  for (const emailVerified of [false, true]) {
    test(`${role} pending account reports approval status only after passkey proof; verified=${emailVerified}`, async () => {
      const user = await account(role, "pending", emailVerified);
      verifyAuthentication.mockResolvedValue({ userId: user._id });
      const response = await signIn();
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ accountStatus: "pending", email: user.email });
      expect(response.body.emailVerificationRequired).toBe(emailVerified ? undefined : true);
      expect(await AuthSession.countDocuments()).toBe(0);
      expect((await User.findById(user._id)).status).toBe("pending");
    });
  }
}

test("failed passkey proof reveals no account or approval state", async () => {
  await account("attorney", "pending", false);
  verifyAuthentication.mockRejectedValue(new Error("Invalid proof"));
  const response = await signIn();
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ error: "Passkey verification failed or expired." });
  expect(await AuthSession.countDocuments()).toBe(0);
});

test("denied account stays blocked without pending or verification recovery", async () => {
  const user = await account("attorney", "denied", false);
  verifyAuthentication.mockResolvedValue({ userId: user._id });
  const response = await signIn();
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ error: "This account cannot sign in." });
  expect(await AuthSession.countDocuments()).toBe(0);
});

test("approved account with unverified email receives verification recovery", async () => {
  const user = await account("attorney", "approved", false);
  verifyAuthentication.mockResolvedValue({ userId: user._id, _id: user._id });
  const response = await signIn();
  expect(response.status).toBe(403);
  expect(response.body).toMatchObject({ emailVerificationRequired: true, email: user.email });
  expect(response.body.accountStatus).toBeUndefined();
  expect(await AuthSession.countDocuments()).toBe(0);
});

test("approved verified account still signs in with a verified passkey", async () => {
  const user = await account("attorney", "approved", true);
  verifyAuthentication.mockResolvedValue({ userId: user._id, _id: user._id });
  const response = await signIn();
  expect(response.status).toBe(200);
  expect(response.body.user.status).toBe("approved");
  expect(await AuthSession.countDocuments()).toBe(1);
});
